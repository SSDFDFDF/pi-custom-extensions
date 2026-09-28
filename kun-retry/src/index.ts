/**
 * kun-retry — Pi extension
 *
 * Replaces @narumitw/pi-retry with:
 * - Configurable maxRetries / baseDelayMs (synced into settings.json for Pi built-in auto-retry)
 * - Optional constant retry interval instead of Pi's uncapped exponential backoff
 * - Extra retryable HTTP status codes and error-message patterns
 * - Stall stream watchdog (from pi-retry)
 * - /retry-nl unlimited "any error" mode
 * - /retry status|on|off|config|codes|patterns|max|delay|constant|stall
 */

import { AgentSession, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type KunRetryConfig,
	type RotationThinkingLevel,
	DEFAULT_CONFIG,
	NL_MAX_RETRIES,
	effectiveMaxRetries,
	formatConfigSummary,
	loadConfig,
	ROTATION_THINKING_LEVELS,
	saveConfig,
} from "./config.ts";
import { formatDelay, installConstantDelayPatch, parseConstantDelayMs } from "./retry-patch.ts";
import { beginSoftAbort, installSoftAbortPatch } from "./soft-abort.ts";

export { parseConstantDelayMs } from "./retry-patch.ts";
import {
	appendRetryHint,
	EMPTY_RESPONSE_TAG,
	isEmptyAssistantContent,
	matchRetryableError,
	neutralizeNonRetryable,
	RETRYABLE_HINT,
} from "./match.ts";
import { syncBuiltinRetrySettings } from "./settings-bridge.ts";
import {
	accountRetryableError,
	buildRotationPool,
	modelKey,
	parseModelKey,
	parseModelList,
	pickNextModelKey,
} from "./model-rotation.ts";

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
	let statusText: string | undefined;
	/** Last context seen by an event handler, so the retry hook can update the footer. */
	let lastCtx: StatusContext | undefined;
	let patchWarning: string | undefined;
	let stallTimer: NodeJS.Timeout | undefined;
	let providerWatchdogActive = false;
	let waitingForStallAbortMessage = false;
	/** Throttle stream-driven UI + timer re-arms so high-token streams stay cheap. */
	let lastIncomingUiAt = 0;
	let lastStallRearmAt = 0;
	const INCOMING_UI_MIN_MS = 250;
	const STALL_REARM_MIN_MS = 1_000;
	/** Consecutive retryable errors since the last success or model switch. */
	let errorStreak = 0;
	/**
	 * Stable "used" model folded into the rotation cycle. Captured once at
	 * session start (and when candidates are configured) so the rotation pool
	 * order stays fixed across switches — otherwise re-folding the live active
	 * model each call reorders the pool and the cycle just oscillates between two
	 * models instead of visiting every candidate.
	 */
	let baseModelKey: string | undefined;
	/**
	 * Session-scoped candidate models. Not persisted to config file — cleared on
	 * session shutdown so each session starts fresh.
	 */
	let sessionCandidates: string[] = [];
	/** Session-scoped rotation toggle, independent from the persisted config. */
	let sessionRotationOn = false;

	const refreshConfig = () => {
		cfg = loadConfig();
		return cfg;
	};

	const modelKeyOf = (m: { provider?: unknown; id?: unknown } | undefined | null): string | undefined => {
		if (!m || typeof m.provider !== "string" || typeof m.id !== "string") return undefined;
		return modelKey({ provider: m.provider, id: m.id });
	};

	type RotationContext = StatusContext & Pick<ExtensionContext, "model" | "modelRegistry">;

	/**
	 * Account for one confirmed retryable error and, once the streak reaches
	 * `switchAfterErrors`, switch the session model to the next usable candidate.
	 * Awaited from `message_end` so the switch lands before Pi's auto-retry
	 * continuation reads the session model.
	 */
	const rotateModelIfNeeded = async (ctx: RotationContext) => {
		if (!sessionRotationOn || cfg.switchAfterErrors <= 0 || sessionCandidates.length === 0) return;

		const decision = accountRetryableError(errorStreak, cfg.switchAfterErrors);
		errorStreak = decision.nextStreak;
		if (!decision.shouldSwitch) return;

		// NOTE: the streak was reset to 0 the moment the threshold was hit, before the
		// switch is attempted. If no usable candidate exists, or setModel fails/throws
		// below, the next switch needs another full `switchAfterErrors` errors. This is
		// intentional: it keeps a permanently-unusable pool from warning on every error
		// while still retrying the current model in the meantime.

		// Live model drives the cycle position; the stable base model keeps the pool
		// order fixed so the cycle advances through every candidate rather than
		// bouncing between two.
		const currentKey = modelKeyOf(ctx.model);
		if (!baseModelKey) baseModelKey = currentKey;
		const pool = buildRotationPool(sessionCandidates, baseModelKey, cfg.includeActiveInRotation);

		const isUsable = (key: string): boolean => {
			const ref = parseModelKey(key);
			if (!ref) return false;
			const found = ctx.modelRegistry.find(ref.provider, ref.id);
			if (!found) return false;
			try {
				return ctx.modelRegistry.hasConfiguredAuth(found);
			} catch {
				return true;
			}
		};

		const nextKey = pickNextModelKey(pool, currentKey, isUsable);
		if (!nextKey) {
			if (ctx.hasUI) {
				ctx.ui.notify?.(
					`kun-retry: no other usable candidate model to switch to (pool: ${pool.join(", ") || "empty"}). Staying on ${currentKey ?? "current"}.`,
					"warning",
				);
			}
			return;
		}

		const ref = parseModelKey(nextKey);
		const model = ref ? ctx.modelRegistry.find(ref.provider, ref.id) : undefined;
		if (!model) return;

		// Capture the session thinking level before switching. Pi's own setModel
		// prefers settings.defaultThinkingLevel over the current session level, which
		// can silently downgrade a manually raised level when rotating.
		const previousThinking = pi.getThinkingLevel();

		// `pi.setModel` returns false on missing auth, but Pi's core setModel can also
		// throw (e.g. a stale/invalid credential that passes the sync auth check but
		// fails the async re-check). Swallow that so a failed switch never breaks the
		// in-flight auto-retry — we just keep the current model.
		let ok = false;
		try {
			ok = await pi.setModel(model);
		} catch (e) {
			if (ctx.hasUI) {
				ctx.ui.notify?.(
					`kun-retry: switch to ${nextKey} failed (${e instanceof Error ? e.message : String(e)}). Keeping ${currentKey ?? "current"}.`,
					"warning",
				);
			}
			return;
		}

		// Re-assert the thinking level after a successful switch. "inherit" restores
		// the pre-switch level; a concrete level (default "max") is applied and Pi
		// clamps it to the strongest level the target model supports — so models
		// without `max` fall back to their own highest available level.
		if (ok) {
			const target = cfg.rotationThinkingLevel;
			const level: RotationThinkingLevel = target === "inherit" ? previousThinking : target;
			try {
				pi.setThinkingLevel(level);
			} catch {
				/* thinking level is best-effort; a failure must not break the retry */
			}
		}
		if (ctx.hasUI) {
			if (ok) {
				ctx.ui.notify?.(
					`kun-retry: switched model ${currentKey ?? "?"} → ${nextKey} after ${cfg.switchAfterErrors} retryable error(s)`,
					"warning",
				);
			} else {
				ctx.ui.notify?.(
					`kun-retry: could not switch to ${nextKey} (no configured auth). Keeping ${currentKey ?? "current"}.`,
					"warning",
				);
			}
		}
	};

	// Constant-interval backoff. Only engages when enabled + constantDelayMs > 0;
	// otherwise Pi's built-in exponential backoff runs completely unmodified.
	const patch = installConstantDelayPatch(AgentSession, {
		getConstantDelayMs: () => (cfg.enabled ? cfg.constantDelayMs : 0),
		getMaxRetries: () => effectiveMaxRetries(cfg),
		onRetry: ({ attempt, delayMs }) => {
			if (lastCtx?.hasUI) showRetryStatus(lastCtx, { attempt, delayMs });
		},
	});
	if (!patch.installed) patchWarning = patch.reason;

	// Keep the stall watchdog off Pi's user-cancel path. `ctx.abort()` sets
	// `_agentRunAbortRequested`, which makes `_handlePostAgentRun` skip
	// `_prepareRetry` entirely — a watchdog built on it can never auto-retry.
	const softAbortPatch = installSoftAbortPatch(AgentSession);
	let softAbortWarning = softAbortPatch.installed ? undefined : softAbortPatch.reason;
	let softAbortWarned = false;

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
		statusText = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	};

	const setTransientStatus = (ctx: StatusContext, mode: StatusMode, text: string, visibleMs: number) => {
		if (clearStatusTimer) clearTimeout(clearStatusTimer);
		if (statusMode !== mode || statusText !== text) ctx.ui.setStatus(STATUS_KEY, text);
		statusMode = mode;
		statusText = text;
		clearStatusTimer = setTimeout(() => {
			clearStatusTimer = undefined;
			if (statusMode !== mode) return;
			statusMode = undefined;
			statusText = undefined;
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}, visibleMs);
	};

	const showRetryStatus = (ctx: StatusContext, constant?: { attempt: number; delayMs: number }) => {
		const base = cfg.nl ? "retrying∞" : "retrying";
		if (!constant) {
			setTransientStatus(ctx, "retry", base, STATUS_VISIBLE_MS);
			return;
		}
		const budget = cfg.nl ? "" : `/${effectiveMaxRetries(cfg)}`;
		const label = `${base} ${constant.attempt}${budget} @${formatDelay(constant.delayMs)}`;
		// Keep the label up for the whole wait so a long constant interval is visible.
		setTransientStatus(ctx, "retry", label, Math.max(constant.delayMs + STATUS_VISIBLE_MS, STATUS_VISIBLE_MS));
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

			const mode = beginSoftAbort();
			if (mode === "unavailable" && ctx.hasUI && !softAbortWarned) {
				// No soft route exists, so `ctx.abort()` marks the run user-cancelled and
				// Pi will not auto-retry the stalled stream. Warn once, don't fail mute.
				softAbortWarned = true;
				ctx.ui.notify?.(
					`kun-retry: ${softAbortWarning ?? "soft abort unavailable"} — this stalled stream will not auto-retry. Run /reload after updating the extension, or restart Pi.`,
					"warning",
				);
			}
			// "direct" already aborted the stream. "deferred" and "unavailable" continue
			// through ctx.abort(); the deferred route converts it via the armed flag.
			if (mode !== "direct") ctx.abort();
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
		const now = Date.now();
		// Status text is cosmetic; avoid setStatus on every token.
		if (ctx.hasUI && now - lastIncomingUiAt >= INCOMING_UI_MIN_MS) {
			lastIncomingUiAt = now;
			showIncomingStatus(ctx);
		}
		// Stall timer only needs second-level precision; re-arming every token is pure overhead.
		if (now - lastStallRearmAt >= STALL_REARM_MIN_MS || !stallTimer) {
			lastStallRearmAt = now;
			armStallWatchdog(ctx);
		}
	};

	const updateFooterStatus = (ctx: StatusContext) => {
		if (!ctx.hasUI) return;
		if (!cfg.enabled) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const rot = sessionRotationOn && cfg.switchAfterErrors > 0 ? ` rot/${cfg.switchAfterErrors}` : "";
		if (cfg.nl) {
			const suffix = cfg.constantDelayMs > 0 ? ` @${formatDelay(cfg.constantDelayMs)}` : "";
			ctx.ui.setStatus(STATUS_KEY, `nl∞${suffix}${rot}`);
		} else if (rot) {
			// Rotation is a persistent mode worth surfacing even in bounded mode.
			if (statusMode !== "retry" && statusMode !== "incoming") {
				ctx.ui.setStatus(STATUS_KEY, `retry${rot}`);
			}
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
		lastCtx = ctx;
		applySettingsSync(ctx);
		if (patchWarning && cfg.constantDelayMs > 0 && ctx.hasUI) {
			ctx.ui.notify?.(`kun-retry: ${patchWarning}`, "warning");
			patchWarning = undefined;
		}
		disarmStallWatchdog();
		providerWatchdogActive = false;
		waitingForStallAbortMessage = false;
		errorStreak = 0;
		baseModelKey = modelKeyOf(ctx.model);
		// Session-scoped rotation state: starts empty each session.
		sessionCandidates = [];
		sessionRotationOn = false;
		clearStatus(ctx);
		updateFooterStatus(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		disarmStallWatchdog();
		providerWatchdogActive = false;
		waitingForStallAbortMessage = false;
		lastIncomingUiAt = 0;
		lastStallRearmAt = 0;
		errorStreak = 0;
		baseModelKey = undefined;
		sessionCandidates = [];
		sessionRotationOn = false;
		// Deliberately keep the captured session: `/reload` reuses the same
		// AgentSession and does not re-run `bindExtensions`, so dropping it here would
		// leave the next instance with only the deferred soft-abort route.
		clearStatus(ctx);
	});

	pi.on("before_provider_request", (_event, ctx) => {
		lastCtx = ctx;
		if (!cfg.enabled) return;
		if (ctx.hasUI) clearIncomingStatus(ctx);
		lastIncomingUiAt = 0;
		lastStallRearmAt = 0;
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

	pi.on("message_end", async (event, ctx) => {
		const message = event.message as unknown as MessageShape;
		if (message.role !== "assistant") return;

		disarmStallWatchdog();
		providerWatchdogActive = false;
		if (ctx.hasUI) clearIncomingStatus(ctx);

		lastCtx = ctx;

		// A successful turn ends the retry sequence; drop the stale "retrying" label
		// instead of letting it linger for the rest of its visible window.
		if (message.stopReason !== "error" && statusMode === "retry" && ctx.hasUI) {
			clearStatus(ctx);
			updateFooterStatus(ctx);
		}

		// A genuinely successful assistant turn (non-error, not user-aborted, has
		// usable content, not a pending stall conversion) resets the rotation streak
		// so the current model is kept until it starts failing again.
		if (
			message.stopReason !== "error" &&
			message.stopReason !== "aborted" &&
			!waitingForStallAbortMessage &&
			!isEmptyAssistantContent(message.content)
		) {
			errorStreak = 0;
		}

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
				await rotateModelIfNeeded(ctx);
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
			await rotateModelIfNeeded(ctx);
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
		await rotateModelIfNeeded(ctx);

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
		getArgumentCompletions: (prefix: string) => {
			return ["on", "off"]
				.filter((s) => s.startsWith(prefix))
				.map((s) => ({ value: s, label: s }));
		},
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
			"kun-retry: status | on | off | max <n> | delay <ms> | constant <ms|off> | codes <list> | patterns <list> | stall <ms|off> | empty <on|off> | sync | help",
		getArgumentCompletions: (prefix: string) => {
			const subs = [
				"status", "on", "off", "max", "delay", "constant", "codes", "patterns",
				"stall", "empty", "sync", "help",
			];
			if (prefix.startsWith("empty ")) {
				const rest = prefix.slice(6);
				return ["on", "off"]
					.filter((s) => s.startsWith(rest))
					.map((s) => ({ value: `empty ${s}`, label: s }));
			}
			if (prefix.startsWith("constant ")) {
				const rest = prefix.slice(9);
				return ["off", "5s", "10s", "30s"]
					.filter((s) => s.startsWith(rest))
					.map((s) => ({ value: `constant ${s}`, label: s }));
			}
			if (prefix.startsWith("stall ")) {
				const rest = prefix.slice(6);
				return ["off", "60000", "90000"]
					.filter((s) => s.startsWith(rest))
					.map((s) => ({ value: `stall ${s}`, label: s }));
			}
			return subs
				.filter((s) => s.startsWith(prefix))
				.map((s) => ({ value: s, label: s }));
		},
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

			if (sub === "constant" || sub === "const" || sub === "fixed") {
				if (!restJoined) {
					ctx.ui.notify(
						cfg.constantDelayMs > 0
							? `constantDelayMs=${cfg.constantDelayMs} (${formatDelay(cfg.constantDelayMs)} fixed interval)`
							: "constantDelayMs=0 (off — Pi built-in exponential backoff)",
						"info",
					);
					return;
				}
				const parsed = parseConstantDelayMs(restJoined);
				if (parsed === undefined) {
					ctx.ui.notify("Usage: /retry constant <ms|5s|2m|off>", "error");
					return;
				}
				cfg = saveConfig({ constantDelayMs: parsed });
				if (cfg.constantDelayMs === 0) {
					ctx.ui.notify(
						`kun-retry constant interval off — back to Pi built-in exponential backoff (${cfg.baseDelayMs}ms × 2^(attempt-1)).`,
						"info",
					);
				} else {
					ctx.ui.notify(
						`kun-retry constant interval ON — every retry waits ${formatDelay(cfg.constantDelayMs)}, no exponential growth. Takes effect immediately (no /reload needed).`,
						"info",
					);
				}
				updateFooterStatus(ctx);
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
					`settings.json ${sync.changed ? "updated" : "already in sync"}: maxRetries=${sync.maxRetries}, baseDelayMs=${sync.baseDelayMs}, maxAgentDelayMs=${sync.maxAgentDelayMs}, enabled=${sync.enabled}. Path: ${sync.path}. /reload applies to in-memory agent.`,
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
						"/retry delay <ms>       override retry.baseDelayMs (exponential base)",
						"/retry constant <ms|off> fixed retry interval instead of exponential",
						"/retry codes 401,403    extra HTTP codes in error text",
						"/retry patterns a,b     extra regexes (i)",
						"/retry stall <ms|off>   stream stall watchdog",
						"/retry empty <on|off>   retry empty (no-content) responses",
						"/retry config {json}    patch config file",
						"/retry sync             write maxRetries into settings.json",
						"/retry-nl [on|off]      unlimited any-error mode",
						"/retry-models           manage model rotation (see /retry-models help)",
						`nl cap constant: ${NL_MAX_RETRIES}`,
					].join("\n"),
					"info",
				);
				return;
			}

			ctx.ui.notify(`Unknown /retry subcommand: ${sub}. Try /retry help`, "error");
		},
	});

	pi.registerCommand("retry-models", {
		description:
			"kun-retry model rotation: <list> | add | remove | clear | available | switch <n> | rotate <on|off> | active <on|off> | help",
		getArgumentCompletions: (prefix: string) => {
			const subs = ["add", "remove", "clear", "available", "switch", "rotate", "active", "thinking", "help"];
			if (prefix.startsWith("rotate ") || prefix.startsWith("active ")) {
				const [cmd, rest] = prefix.split(/\s+/);
				return ["on", "off"]
					.filter((s) => s.startsWith(rest ?? ""))
					.map((s) => ({ value: `${cmd} ${s}`, label: s }));
			}
			if (prefix.startsWith("thinking ")) {
				const rest = prefix.slice(9);
				return ROTATION_THINKING_LEVELS.filter((s) => s.startsWith(rest)).map((s) => ({
					value: `thinking ${s}`,
					label: s,
				}));
			}
			if (prefix.startsWith("switch ")) {
				return [];
			}
			return subs
				.filter((s) => s.startsWith(prefix))
				.map((s) => ({ value: s, label: s }));
		},
		handler: async (args, ctx) => {
			refreshConfig();
			const raw = (args ?? "").trim();
			const [cmd, ...rest] = raw.split(/\s+/);
			const restJoined = rest.join(" ").trim();
			const sub = (cmd ?? "").toLowerCase();

			/** True when the model exists in the registry and has configured auth. */
			const isAvailable = (key: string): boolean => {
				const ref = parseModelKey(key);
				if (!ref) return false;
				const found = ctx.modelRegistry.find(ref.provider, ref.id);
				if (!found) return false;
				try {
					return ctx.modelRegistry.hasConfiguredAuth(found);
				} catch {
					return false;
				}
			};
			const filterAvailable = (keys: string[]): string[] => keys.filter(isAvailable);
			const showPool = () => {
				const currentKey = modelKeyOf(ctx.model) ?? "(unknown)";
				const list = sessionCandidates.length ? sessionCandidates.join("\n  ") : "(none)";
				ctx.ui.notify(
					[
						`rotation: ${sessionRotationOn ? "on" : "off"}  switchAfterErrors: ${cfg.switchAfterErrors}  includeActive: ${cfg.includeActiveInRotation}  thinking: ${cfg.rotationThinkingLevel}`,
						`active model: ${currentKey}`,
						`candidates:\n  ${list}`,
					].join("\n"),
					"info",
				);
			};
			const showAvailable = () => {
				let all: readonly { provider: string; id: string }[] = [];
				try {
					all = ctx.modelRegistry.getAvailable();
				} catch (e) {
					ctx.ui.notify(`kun-retry: could not read available models: ${e instanceof Error ? e.message : String(e)}`, "error");
					return;
				}
				if (!all.length) {
					ctx.ui.notify("kun-retry: no configured/available models (check provider auth / API keys)", "info");
					return;
				}
				const currentKey = modelKeyOf(ctx.model);
				const inPool = new Set(sessionCandidates);
				const rows = all
					.map((m) => `${m.provider}/${m.id}`)
					.sort()
					.map((k) => {
						const mark = k === currentKey ? "→ " : inPool.has(k) ? "✓ " : "  ";
						return `${mark}${k}`;
					});
				ctx.ui.notify(
					[
						`kun-retry: ${all.length} available model(s)  (→ active, ✓ in pool):`,
						...rows,
						"",
						"Add with: /retry-models add <provider/id> ...",
					].join("\n"),
					"info",
				);
			};

			if (!sub || sub === "list" || sub === "show" || sub === "status") {
				showPool();
				return;
			}

			if (sub === "help") {
				ctx.ui.notify(
					[
						"/retry-models                    show pool + rotation state",
						"/retry-models <p/id> [more...]    set candidates (enables rotation)",
						"/retry-models add <p/id> ...      add candidates (available only)",
						"/retry-models remove <p/id> ...   remove candidates",
						"/retry-models clear               drop candidates + disable rotation",
						"/retry-models available           list usable models for this session",
						"/retry-models switch <n>          errors before switching (0=off)",
						"/retry-models rotate <on|off>     pause/resume without clearing",
						"/retry-models active <on|off>     fold current model into the cycle",
						"/retry-models thinking <level>    thinking level after switch (inherit|off|minimal|low|medium|high|xhigh|max)",
						"",
						"Candidates are session-scoped: they reset when the session ends.",
					].join("\n"),
					"info",
				);
				return;
			}

			if (sub === "available" || sub === "avail") {
				showAvailable();
				return;
			}

			if (sub === "clear" || sub === "none" || sub === "off") {
				sessionCandidates = [];
				sessionRotationOn = false;
				errorStreak = 0;
				baseModelKey = modelKeyOf(ctx.model);
				updateFooterStatus(ctx);
				ctx.ui.notify("kun-retry model rotation cleared (candidates removed, rotation off)", "info");
				return;
			}

			if (sub === "add") {
				const added = parseModelList(restJoined);
				if (!added.length) {
					ctx.ui.notify("Usage: /retry-models add <provider/id> [more...]", "error");
					return;
				}
				const validAdded = filterAvailable(added);
				const skipped = added.filter((k) => !validAdded.includes(k));
				if (!validAdded.length) {
					ctx.ui.notify(
						`kun-retry: none of the specified models are currently available/configured. Skipped: ${skipped.join(", ")}`,
						"error",
					);
					return;
				}
				const merged = filterAvailable(parseModelList([...sessionCandidates, ...validAdded].join(" ")));
				const rotateAfterAdd = merged.length > 0 && (sessionRotationOn || sessionCandidates.length === 0);
				sessionCandidates = merged;
				sessionRotationOn = rotateAfterAdd;
				updateFooterStatus(ctx);
				ctx.ui.notify(
					[
						`kun-retry candidates (${merged.length}):\n  ${merged.join("\n  ")}`,
						skipped.length ? `skipped unavailable: ${skipped.join(", ")}` : "",
					]
						.filter(Boolean)
						.join("\n"),
					"info",
				);
				return;
			}

			if (sub === "remove" || sub === "rm" || sub === "del" || sub === "delete") {
				const drop = new Set(parseModelList(restJoined));
				if (!drop.size) {
					ctx.ui.notify("Usage: /retry-models remove <provider/id> [more...]", "error");
					return;
				}
				const kept = sessionCandidates.filter((m) => !drop.has(m));
				sessionCandidates = kept;
				sessionRotationOn = kept.length > 0 && sessionRotationOn;
				updateFooterStatus(ctx);
				ctx.ui.notify(
					kept.length
						? `kun-retry candidates (${kept.length}):\n  ${kept.join("\n  ")}`
						: "kun-retry candidates now empty (rotation off)",
					"info",
				);
				return;
			}

			if (sub === "switch" || sub === "switchafter" || sub === "every") {
				if (!restJoined) {
					ctx.ui.notify(
						`switchAfterErrors=${cfg.switchAfterErrors}${cfg.switchAfterErrors === 0 ? " (0 = switching disabled)" : ""}`,
						"info",
					);
					return;
				}
				const n = Number(restJoined);
				if (!Number.isFinite(n) || n < 0) {
					ctx.ui.notify("Usage: /retry-models switch <non-negative integer>  (0 disables switching)", "error");
					return;
				}
				cfg = saveConfig({ switchAfterErrors: Math.floor(n) });
				errorStreak = 0;
				ctx.ui.notify(
					cfg.switchAfterErrors === 0
						? "kun-retry switchAfterErrors=0 — model switching disabled (rotation idle)"
						: `kun-retry switchAfterErrors=${cfg.switchAfterErrors} — switch model after every ${cfg.switchAfterErrors} retryable error(s)`,
					"info",
				);
				return;
			}

			if (sub === "rotate" || sub === "rotation") {
				if (!restJoined) {
					ctx.ui.notify(`modelRotation=${sessionRotationOn ? "on" : "off"} (${sessionCandidates.length} candidate(s))`, "info");
					return;
				}
				const a = restJoined.toLowerCase();
				let next: boolean;
				if (a === "on" || a === "1" || a === "true" || a === "enable") next = true;
				else if (a === "off" || a === "0" || a === "false" || a === "disable") next = false;
				else {
					ctx.ui.notify("Usage: /retry-models rotate <on|off>", "error");
					return;
				}
				if (next && sessionCandidates.length === 0) {
					ctx.ui.notify("kun-retry: set candidates first with /retry-models <provider/id> ...", "error");
					return;
				}
				sessionRotationOn = next;
				errorStreak = 0;
				updateFooterStatus(ctx);
				ctx.ui.notify(`kun-retry modelRotation=${sessionRotationOn ? "on" : "off"}`, "info");
				return;
			}

			if (sub === "active" || sub === "includeactive") {
				if (!restJoined) {
					ctx.ui.notify(`includeActiveInRotation=${cfg.includeActiveInRotation}`, "info");
					return;
				}
				const a = restJoined.toLowerCase();
				let next: boolean;
				if (a === "on" || a === "1" || a === "true" || a === "enable") next = true;
				else if (a === "off" || a === "0" || a === "false" || a === "disable") next = false;
				else {
					ctx.ui.notify("Usage: /retry-models active <on|off>", "error");
					return;
				}
				cfg = saveConfig({ includeActiveInRotation: next });
				// Changing pool composition mid-sequence: reset the streak so the next
				// switch is computed against the new pool from a clean count.
				errorStreak = 0;
				ctx.ui.notify(`kun-retry includeActiveInRotation=${cfg.includeActiveInRotation}`, "info");
				return;
			}

			if (sub === "thinking" || sub === "think" || sub === "level") {
				if (!restJoined) {
					ctx.ui.notify(
						`rotationThinkingLevel=${cfg.rotationThinkingLevel}${
							cfg.rotationThinkingLevel === "max" ? " (falls back to each model's own highest supported level)" : ""
						}`,
						"info",
					);
					return;
				}
				const a = restJoined.toLowerCase() as RotationThinkingLevel;
				if (!ROTATION_THINKING_LEVELS.includes(a)) {
					ctx.ui.notify(
						`Usage: /retry-models thinking <${ROTATION_THINKING_LEVELS.join("|")}>`,
						"error",
					);
					return;
				}
				cfg = saveConfig({ rotationThinkingLevel: a });
				ctx.ui.notify(
					a === "inherit"
						? "kun-retry rotationThinkingLevel=inherit — keep the session's current thinking level across switches"
						: `kun-retry rotationThinkingLevel=${a} — applied after each switch (clamped to the target model's strongest supported level)`,
					"info",
				);
				return;
			}

			// Bare argument list: replace the whole pool and enable rotation.
			const rawTokens = raw.split(/[\s,]+/).filter(Boolean);
			const parsed = parseModelList(raw);
			const models = filterAvailable(parsed);
			const skipped = parsed.filter((k) => !models.includes(k));
			const invalidTokens = rawTokens.filter((t) => !parseModelKey(t));
			if (!models.length) {
				ctx.ui.notify(
					[
						'Usage: /retry-models <provider/id> [more...]  (e.g. "openai/gpt-4o anthropic/claude-3-5-sonnet")',
						parsed.length ? `All specified models are unavailable/not configured. Skipped: ${skipped.join(", ")}` : "",
						"See /retry-models help or /retry-models available.",
					]
						.filter(Boolean)
						.join("\n"),
					"error",
				);
				return;
			}
			sessionCandidates = models;
			sessionRotationOn = true;
			errorStreak = 0;
			baseModelKey = modelKeyOf(ctx.model);
			updateFooterStatus(ctx);
			ctx.ui.notify(
				[
					`kun-retry model rotation ON: switches after ${cfg.switchAfterErrors} retryable error(s), cycling ${
						cfg.includeActiveInRotation ? "active + candidates" : "candidates only"
					}.`,
					`candidates (${models.length}):\n  ${models.join("\n  ")}`,
					skipped.length ? `skipped unavailable: ${skipped.join(", ")}` : "",
					invalidTokens.length ? `ignored invalid tokens: ${invalidTokens.join(", ")}` : "",
				]
					.filter(Boolean)
					.join("\n"),
				"info",
			);
		},
	});
}
