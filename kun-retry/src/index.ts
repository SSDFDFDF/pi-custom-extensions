/**
 * kun-retry — Pi extension
 *
 * Replaces @narumitw/pi-retry with:
 * - Configurable maxRetries / baseDelayMs (synced into settings.json for Pi built-in auto-retry)
 * - Extra retryable HTTP status codes and error-message patterns
 * - Stall stream watchdog (from pi-retry)
 * - /retry-nl unlimited "any error" mode
 * - /retry status|on|off|config|codes|patterns|max|delay|stall
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type KunRetryConfig,
	DEFAULT_CONFIG,
	NL_MAX_RETRIES,
	effectiveMaxRetries,
	formatConfigSummary,
	loadConfig,
	saveConfig,
} from "./config.ts";
import {
	appendRetryHint,
	EMPTY_RESPONSE_TAG,
	isEmptyAssistantContent,
	matchRetryableError,
	neutralizeNonRetryable,
	RETRYABLE_HINT,
} from "./match.ts";
import { syncBuiltinRetrySettings } from "./settings-bridge.ts";

const STALL_WATCHDOG_TAG = "[stall-watchdog-retry]";
const STATUS_KEY = "kun-retry";
const STATUS_VISIBLE_MS = 8_000;
const INCOMING_STATUS_VISIBLE_MS = 1_500;
const STALL_TIMEOUT_FLAG = "retry-stall-timeout-ms";
const STALL_TIMEOUT_ENV = "PI_RETRY_STALL_TIMEOUT_MS";

type StatusContext = Pick<ExtensionContext, "hasUI" | "ui">;
type WatchdogContext = StatusContext & Pick<ExtensionContext, "abort" | "isIdle">;

type MessageShape = {
	role?: string;
	stopReason?: string;
	errorMessage?: unknown;
	content?: unknown;
	[key: string]: unknown;
};

type StatusMode = "incoming" | "retry";

export function parseStallTimeoutMs(value: unknown): number | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
		return Math.trunc(value);
	}
	if (typeof value !== "string") return undefined;

	const normalized = value.trim().toLowerCase();
	if (normalized === "0" || normalized === "off" || normalized === "false") return 0;

	const timeoutMs = Number(normalized);
	if (!Number.isFinite(timeoutMs) || timeoutMs < 0) return undefined;
	return Math.trunc(timeoutMs);
}

function parseIntList(args: string): number[] {
	return args
		.split(/[\s,]+/)
		.map((s) => s.trim())
		.filter(Boolean)
		.map((s) => Number(s))
		.filter((n) => Number.isInteger(n) && n >= 100 && n <= 599);
}

function parsePatternArgs(args: string): string[] {
	const trimmed = args.trim();
	if (!trimmed) return [];
	// Prefer JSON array: ["foo","bar"]
	if (trimmed.startsWith("[")) {
		try {
			const arr = JSON.parse(trimmed) as unknown;
			if (Array.isArray(arr)) {
				return arr.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean);
			}
		} catch {
			/* fall through */
		}
	}
	// Comma-separated patterns (commas only; spaces allowed inside)
	return trimmed
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

export default function kunRetry(pi: ExtensionAPI) {
	pi.registerFlag(STALL_TIMEOUT_FLAG, {
		description: `Abort and auto-retry stalled provider streams after this many ms; use 0/off/false to disable. Defaults to config or ${DEFAULT_CONFIG.stallTimeoutMs}.`,
		type: "string",
	});

	let cfg: KunRetryConfig = loadConfig();
	let clearStatusTimer: NodeJS.Timeout | undefined;
	let statusMode: StatusMode | undefined;
	let stallTimer: NodeJS.Timeout | undefined;
	let providerWatchdogActive = false;
	let waitingForStallAbortMessage = false;

	const refreshConfig = () => {
		cfg = loadConfig();
		return cfg;
	};

	const applySettingsSync = (notify: StatusContext | undefined) => {
		const result = syncBuiltinRetrySettings(cfg);
		if (result.changed && notify?.hasUI) {
			notify.ui.notify?.(
				`kun-retry synced settings.json: retry.maxRetries=${result.maxRetries}, baseDelayMs=${result.baseDelayMs}, enabled=${result.enabled}. Run /reload if this session still uses old in-memory retry limits.`,
				"info",
			);
		}
		return result;
	};

	// Initial sync so a cold start after config edit picks up file values next launch.
	applySettingsSync(undefined);

	const getStallTimeoutMs = () =>
		parseStallTimeoutMs(pi.getFlag(STALL_TIMEOUT_FLAG)) ??
		parseStallTimeoutMs(process.env[STALL_TIMEOUT_ENV]) ??
		refreshConfig().stallTimeoutMs;

	const clearStatus = (ctx: StatusContext) => {
		if (clearStatusTimer) clearTimeout(clearStatusTimer);
		clearStatusTimer = undefined;
		statusMode = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	};

	const setTransientStatus = (ctx: StatusContext, mode: StatusMode, text: string, visibleMs: number) => {
		if (clearStatusTimer) clearTimeout(clearStatusTimer);
		if (statusMode !== mode) ctx.ui.setStatus(STATUS_KEY, text);
		statusMode = mode;
		clearStatusTimer = setTimeout(() => {
			clearStatusTimer = undefined;
			if (statusMode !== mode) return;
			statusMode = undefined;
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}, visibleMs);
	};

	const showRetryStatus = (ctx: StatusContext) => {
		const label = cfg.nl ? "retrying∞" : "retrying";
		setTransientStatus(ctx, "retry", label, STATUS_VISIBLE_MS);
	};

	const showIncomingStatus = (ctx: StatusContext) => {
		setTransientStatus(ctx, "incoming", "receiving", INCOMING_STATUS_VISIBLE_MS);
	};

	const clearIncomingStatus = (ctx: StatusContext) => {
		if (statusMode === "incoming") clearStatus(ctx);
	};

	const disarmStallWatchdog = () => {
		if (stallTimer) clearTimeout(stallTimer);
		stallTimer = undefined;
	};

	const armStallWatchdog = (ctx: WatchdogContext) => {
		disarmStallWatchdog();
		if (!cfg.enabled) {
			providerWatchdogActive = false;
			return;
		}

		const timeoutMs = getStallTimeoutMs();
		if (timeoutMs === 0) {
			providerWatchdogActive = false;
			return;
		}

		providerWatchdogActive = true;
		stallTimer = setTimeout(() => {
			stallTimer = undefined;
			providerWatchdogActive = false;
			if (ctx.isIdle()) return;

			waitingForStallAbortMessage = true;
			if (ctx.hasUI) showRetryStatus(ctx);
			ctx.abort();
		}, timeoutMs);
	};

	const observeProviderOrStreamEvent = (ctx: WatchdogContext) => {
		if (!providerWatchdogActive || waitingForStallAbortMessage) return;
		if (ctx.isIdle()) {
			disarmStallWatchdog();
			providerWatchdogActive = false;
			clearIncomingStatus(ctx);
			return;
		}
		if (ctx.hasUI) showIncomingStatus(ctx);
		armStallWatchdog(ctx);
	};

	const updateFooterStatus = (ctx: StatusContext) => {
		if (!ctx.hasUI) return;
		if (!cfg.enabled) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		if (cfg.nl) {
			ctx.ui.setStatus(STATUS_KEY, "nl∞");
		} else {
			// Keep footer quiet in normal mode; transient "retrying"/"receiving" only.
			if (statusMode !== "retry" && statusMode !== "incoming") {
				ctx.ui.setStatus(STATUS_KEY, undefined);
			}
		}
	};

	// ── Lifecycle ──────────────────────────────────────────────────────────

	pi.on("session_start", (_event, ctx) => {
		refreshConfig();
		applySettingsSync(ctx);
		disarmStallWatchdog();
		providerWatchdogActive = false;
		waitingForStallAbortMessage = false;
		clearStatus(ctx);
		updateFooterStatus(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		disarmStallWatchdog();
		providerWatchdogActive = false;
		waitingForStallAbortMessage = false;
		clearStatus(ctx);
	});

	pi.on("before_provider_request", (_event, ctx) => {
		if (!cfg.enabled) return;
		if (ctx.hasUI) clearIncomingStatus(ctx);
		armStallWatchdog(ctx);
	});

	pi.on("after_provider_response", (_event, ctx) => {
		observeProviderOrStreamEvent(ctx);
	});

	pi.on("message_start", (_event, ctx) => {
		observeProviderOrStreamEvent(ctx);
	});

	pi.on("message_update", (_event, ctx) => {
		observeProviderOrStreamEvent(ctx);
	});

	pi.on("agent_end", (_event, ctx) => {
		disarmStallWatchdog();
		providerWatchdogActive = false;
		waitingForStallAbortMessage = false;
		if (ctx.hasUI) clearIncomingStatus(ctx);
	});

	pi.on("message_end", (event, ctx) => {
		const message = event.message as unknown as MessageShape;
		if (message.role !== "assistant") return;

		disarmStallWatchdog();
		providerWatchdogActive = false;
		if (ctx.hasUI) clearIncomingStatus(ctx);

		if (!cfg.enabled && !waitingForStallAbortMessage) return;

		// Stall abort → force retryable error
		if (waitingForStallAbortMessage) {
			waitingForStallAbortMessage = false;
			const originalErrorMessage =
				typeof message.errorMessage === "string"
					? message.errorMessage
					: "Provider stream stalled while Pi was waiting for a response.";

			if (!originalErrorMessage.includes(STALL_WATCHDOG_TAG)) {
				// A stalled stream is transport-level, not a quota/billing refusal, so
				// neutralize any non-retryable tokens that happen to be in the partial
				// error text so Pi's built-in classifier does not veto the retry.
				const { text } = neutralizeNonRetryable(originalErrorMessage);
				const errorMessage = `${text}\n\n${STALL_WATCHDOG_TAG} ${RETRYABLE_HINT}; treating stalled provider stream as retryable.`;
				if (ctx.hasUI) showRetryStatus(ctx);
				return {
					message: {
						...message,
						stopReason: "error",
						errorMessage,
					} as typeof event.message,
				};
			}
		}

		if (!cfg.enabled) return;

		// Empty provider response → force retryable error.
		// A completed-but-empty assistant turn (no answer text and no tool calls;
		// thinking-only counts as empty) with a non-error stopReason is HTTP 200 with
		// nothing usable. Pi's built-in classifier only inspects stopReason ===
		// "error", so it never retries this. Rewrite it into a retryable error so the
		// built-in retry path engages. "aborted" is a user cancel and "length" may
		// carry partial output, so both are left untouched.
		if (
			cfg.retryEmptyResponse &&
			message.stopReason !== "error" &&
			message.stopReason !== "aborted" &&
			message.stopReason !== "length" &&
			isEmptyAssistantContent(message.content)
		) {
			const existing = typeof message.errorMessage === "string" ? message.errorMessage : "";
			if (existing.includes(EMPTY_RESPONSE_TAG)) return;
			const errorMessage = `Provider returned an empty response (stopReason: ${
				typeof message.stopReason === "string" ? message.stopReason : "unknown"
			}, no answer text or tool calls).\n\n${EMPTY_RESPONSE_TAG} ${RETRYABLE_HINT}; treating empty provider response as retryable.`;
			if (ctx.hasUI) showRetryStatus(ctx);
			return {
				message: {
					...message,
					stopReason: "error",
					errorMessage,
				} as typeof event.message,
			};
		}

		if (message.stopReason !== "error") return;
		if (typeof message.errorMessage !== "string") return;

		const matched = matchRetryableError(message.errorMessage, {
			nl: cfg.nl,
			statusCodes: cfg.statusCodes,
			errorPatterns: cfg.errorPatterns,
		});
		if (!matched) return;

		// Avoid appending the hint repeatedly on replayed messages.
		if (message.errorMessage.includes(matched.tag) && message.errorMessage.includes(RETRYABLE_HINT)) {
			return;
		}

		// In nl mode the user asked to retry ANY error, including quota/billing
		// refusals that Pi's built-in classifier normally vetoes. Neutralize those
		// tokens so the built-in retry path actually engages. Bounded modes leave
		// them intact so genuine quota exhaustion is not silently retried.
		const base = cfg.nl ? neutralizeNonRetryable(message.errorMessage).text : message.errorMessage;
		const errorMessage = appendRetryHint(base, matched);

		if (ctx.hasUI) showRetryStatus(ctx);

		return {
			message: {
				...message,
				errorMessage,
			} as typeof event.message,
		};
	});

	// ── Commands ───────────────────────────────────────────────────────────

	pi.registerCommand("retry-nl", {
		description: "Toggle unlimited retry mode (any error, effectively unlimited attempts)",
		handler: async (args, ctx) => {
			refreshConfig();
			const a = (args ?? "").trim().toLowerCase();
			let next: boolean;
			if (a === "on" || a === "1" || a === "true" || a === "enable") next = true;
			else if (a === "off" || a === "0" || a === "false" || a === "disable") next = false;
			else if (!a) next = !cfg.nl;
			else {
				ctx.ui.notify(`Usage: /retry-nl [on|off]  (current: ${cfg.nl ? "on" : "off"})`, "error");
				return;
			}
			cfg = saveConfig({ nl: next, enabled: next ? true : cfg.enabled });
			const sync = applySettingsSync(ctx);
			updateFooterStatus(ctx);
			ctx.ui.notify(
				next
					? `kun-retry nl ON — any provider error is retryable, maxRetries=${sync.maxRetries} (settings). Prefer /reload so this session uses the new limit. Escape cancels a backoff.`
					: `kun-retry nl OFF — back to maxRetries=${cfg.maxRetries}, status codes + patterns only. /reload recommended if limit was raised.`,
				next ? "warning" : "info",
			);
		},
	});

	pi.registerCommand("retry", {
		description:
			"kun-retry: status | on | off | config | max <n> | delay <ms> | codes <list> | patterns <list> | stall <ms|off> | empty <on|off> | sync",
		handler: async (args, ctx) => {
			refreshConfig();
			const raw = (args ?? "").trim();
			const [cmd, ...rest] = raw.split(/\s+/);
			const restJoined = rest.join(" ").trim();
			const sub = (cmd ?? "").toLowerCase();

			if (!sub || sub === "status" || sub === "show") {
				ctx.ui.notify(formatConfigSummary(cfg), "info");
				return;
			}

			if (sub === "on" || sub === "enable") {
				cfg = saveConfig({ enabled: true });
				applySettingsSync(ctx);
				updateFooterStatus(ctx);
				ctx.ui.notify("kun-retry enabled", "info");
				return;
			}

			if (sub === "off" || sub === "disable") {
				cfg = saveConfig({ enabled: false, nl: false });
				applySettingsSync(ctx);
				updateFooterStatus(ctx);
				ctx.ui.notify("kun-retry disabled (and nl off)", "info");
				return;
			}

			if (sub === "config") {
				if (!restJoined) {
					ctx.ui.notify(formatConfigSummary(cfg), "info");
					return;
				}
				// JSON patch: /retry config {"maxRetries":20}
				try {
					const patch = JSON.parse(restJoined) as Partial<KunRetryConfig>;
					cfg = saveConfig(patch);
					applySettingsSync(ctx);
					updateFooterStatus(ctx);
					ctx.ui.notify(`kun-retry config updated:\n${formatConfigSummary(cfg)}`, "info");
				} catch (e) {
					ctx.ui.notify(`Invalid JSON patch: ${e instanceof Error ? e.message : String(e)}`, "error");
				}
				return;
			}

			if (sub === "max" || sub === "maxretries") {
				const n = Number(restJoined);
				if (!Number.isFinite(n) || n < 0) {
					ctx.ui.notify("Usage: /retry max <non-negative integer>", "error");
					return;
				}
				cfg = saveConfig({ maxRetries: Math.floor(n) });
				const sync = applySettingsSync(ctx);
				ctx.ui.notify(
					`kun-retry maxRetries=${cfg.maxRetries} (effective ${effectiveMaxRetries(cfg)}; settings maxRetries=${sync.maxRetries}). /reload to refresh in-memory Pi retry budget.`,
					"info",
				);
				return;
			}

			if (sub === "delay" || sub === "basedelay") {
				const n = Number(restJoined);
				if (!Number.isFinite(n) || n < 0) {
					ctx.ui.notify("Usage: /retry delay <ms>", "error");
					return;
				}
				cfg = saveConfig({ baseDelayMs: Math.floor(n) });
				applySettingsSync(ctx);
				ctx.ui.notify(`kun-retry baseDelayMs=${cfg.baseDelayMs}. /reload if in-memory delay looks stale.`, "info");
				return;
			}

			if (sub === "codes" || sub === "statuscodes") {
				if (!restJoined || restJoined === "clear" || restJoined === "none") {
					cfg = saveConfig({ statusCodes: [] });
					ctx.ui.notify("kun-retry statusCodes cleared", "info");
					return;
				}
				if (restJoined === "default" || restJoined === "reset") {
					cfg = saveConfig({ statusCodes: [...DEFAULT_CONFIG.statusCodes] });
					ctx.ui.notify(`kun-retry statusCodes reset: [${cfg.statusCodes.join(", ")}]`, "info");
					return;
				}
				const codes = parseIntList(restJoined);
				if (!codes.length) {
					ctx.ui.notify("Usage: /retry codes 401,403,429  | clear | default", "error");
					return;
				}
				cfg = saveConfig({ statusCodes: codes });
				ctx.ui.notify(`kun-retry statusCodes: [${cfg.statusCodes.join(", ")}]`, "info");
				return;
			}

			if (sub === "patterns" || sub === "pattern") {
				if (!restJoined || restJoined === "clear" || restJoined === "none") {
					cfg = saveConfig({ errorPatterns: [] });
					ctx.ui.notify("kun-retry errorPatterns cleared", "info");
					return;
				}
				const patterns = parsePatternArgs(restJoined);
				if (!patterns.length) {
					ctx.ui.notify('Usage: /retry patterns "foo|bar",timeout  or JSON array', "error");
					return;
				}
				// Validate compile
				for (const p of patterns) {
					try {
						new RegExp(p, "i");
					} catch (e) {
						ctx.ui.notify(`Invalid regex ${JSON.stringify(p)}: ${e instanceof Error ? e.message : String(e)}`, "error");
						return;
					}
				}
				cfg = saveConfig({ errorPatterns: patterns });
				ctx.ui.notify(`kun-retry errorPatterns (${cfg.errorPatterns.length}): ${cfg.errorPatterns.join(" | ")}`, "info");
				return;
			}

			if (sub === "stall") {
				if (!restJoined) {
					ctx.ui.notify(`stallTimeoutMs=${cfg.stallTimeoutMs} (0=off)`, "info");
					return;
				}
				const parsed = parseStallTimeoutMs(restJoined);
				if (parsed === undefined) {
					ctx.ui.notify("Usage: /retry stall <ms|off|0>", "error");
					return;
				}
				cfg = saveConfig({ stallTimeoutMs: parsed });
				ctx.ui.notify(`kun-retry stallTimeoutMs=${cfg.stallTimeoutMs === 0 ? "off" : cfg.stallTimeoutMs}`, "info");
				return;
			}

			if (sub === "empty" || sub === "emptyresponse") {
				if (!restJoined) {
					ctx.ui.notify(`retryEmptyResponse=${cfg.retryEmptyResponse}`, "info");
					return;
				}
				const a = restJoined.toLowerCase();
				let next: boolean;
				if (a === "on" || a === "1" || a === "true" || a === "enable") next = true;
				else if (a === "off" || a === "0" || a === "false" || a === "disable") next = false;
				else {
					ctx.ui.notify("Usage: /retry empty <on|off>", "error");
					return;
				}
				cfg = saveConfig({ retryEmptyResponse: next });
				ctx.ui.notify(`kun-retry retryEmptyResponse=${cfg.retryEmptyResponse}`, "info");
				return;
			}

			if (sub === "sync") {
				const sync = applySettingsSync(ctx);
				ctx.ui.notify(
					`settings.json ${sync.changed ? "updated" : "already in sync"}: maxRetries=${sync.maxRetries}, baseDelayMs=${sync.baseDelayMs}, enabled=${sync.enabled}. Path: ${sync.path}. /reload applies to in-memory agent.`,
					"info",
				);
				return;
			}

			if (sub === "help") {
				ctx.ui.notify(
					[
						"/retry status",
						"/retry on|off",
						"/retry max <n>          override retry.maxRetries",
						"/retry delay <ms>       override retry.baseDelayMs",
						"/retry codes 401,403    extra HTTP codes in error text",
						"/retry patterns a,b     extra regexes (i)",
						"/retry stall <ms|off>   stream stall watchdog",
						"/retry empty <on|off>   retry empty (no-content) responses",
						"/retry config {json}    patch config file",
						"/retry sync             write maxRetries into settings.json",
						"/retry-nl [on|off]      unlimited any-error mode",
						`nl cap constant: ${NL_MAX_RETRIES}`,
					].join("\n"),
					"info",
				);
				return;
			}

			ctx.ui.notify(`Unknown /retry subcommand: ${sub}. Try /retry help`, "error");
		},
	});
}
