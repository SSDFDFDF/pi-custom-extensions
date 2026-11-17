/**
 * kun-retry — Pi extension
 *
 * Replaces @narumitw/pi-retry with:
 * - Configurable maxRetries / baseDelayMs (synced into settings.json for Pi built-in auto-retry)
 * - Optional constant retry interval instead of Pi's capped exponential backoff
 * - Extra retryable HTTP status codes and error-message patterns
 * - Stall stream watchdog (from pi-retry)
 * - /retry-nl unlimited "any error" mode
 * - /retry status|on|off|config|codes|patterns|max|delay|constant|stall|trace
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
import { bindRetryHooks, formatDelay, installConstantDelayPatch, parseConstantDelayMs } from "./retry-patch.ts";
import { beginSoftAbort, installSoftAbortPatch } from "./soft-abort.ts";
import { resolveSession } from "./session-registry.ts";
import { createRetryStatus } from "./status.ts";
import { createRetryDiagnostics } from "./diagnostics.ts";
import { createStallWatchdog } from "./watchdog.ts";

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
const STALL_TIMEOUT_FLAG = "retry-stall-timeout-ms";
const STALL_TIMEOUT_ENV = "PI_RETRY_STALL_TIMEOUT_MS";

type StatusContext = Pick<ExtensionContext, "hasUI" | "ui">;

type MessageShape = {
	role?: string;
	stopReason?: string;
	errorMessage?: unknown;
	content?: unknown;
	[key: string]: unknown;
};

type ObservableSession = { subscribe?: AgentSession["subscribe"] };

/** UI getters and methods can throw after reload; notifications never own control flow. */
function safeNotify(ctx: StatusContext | undefined, text: string, level: "info" | "warning" | "error") {
	try {
		if (ctx?.hasUI) ctx.ui.notify?.(text, level);
	} catch {
		/* best-effort UI */
	}
}

function snapshotUI(ctx: StatusContext): StatusContext | undefined {
	try {
		return ctx.hasUI ? { hasUI: true, ui: ctx.ui } : undefined;
	} catch {
		return undefined;
	}
}

function errorName(error: unknown): string {
	try {
		return error instanceof Error ? error.name : "unknown";
	} catch {
		return "unknown";
	}
}

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
	// A factory owns at most one session at a time. Repeated session_start replaces
	// all resources; callbacks retain their owner, not a live ExtensionContext.
	type Runtime = {
		manager: object | undefined;
		sessionOwner: ReturnType<typeof resolveSession>;
		sessionId: string | undefined;
		notifyUI: StatusContext | undefined;
		status: ReturnType<typeof createRetryStatus>;
		diagnostics: ReturnType<typeof createRetryDiagnostics>;
		watchdog: ReturnType<typeof createStallWatchdog>;
		unbindRetryHooks?: () => void;
		unsubscribe?: () => void;
		disposed: boolean;
		softAbortWarned: boolean;
		requestSignal: AbortSignal | undefined;
		lastIncomingUiAt: number;
	};
	let runtime: Runtime | undefined;
	let disposed = false;
	const INCOMING_UI_MIN_MS = 250;

	const isCurrent = (owner: Runtime) => !disposed && !owner.disposed && runtime === owner &&
		resolveSession(owner.manager) === owner.sessionOwner;
	const activeRuntime = (ctx: ExtensionContext): Runtime | undefined => {
		const owner = runtime;
		if (!owner || !isCurrent(owner)) return undefined;
		return ctx.sessionManager === owner.manager ? owner : undefined;
	};

	// Explicitly accept only flat diagnostic metadata. In particular a match's
	// label may contain a configured regex, and provider errors/payloads stay out.
	const diagnosticKeys = new Set([
		"stopReason", "attempt", "reason", "errorName", "coreAttempt", "enabled",
		"maxRetries", "maxAttempts", "constantDelayMs", "continue", "delayMs",
		"exponent", "timeoutMs", "idleMs", "success", "aborted", "bound", "rewritten",
	]);
	const record = (owner: Runtime | undefined, phase: string, data?: Record<string, unknown>) => {
		if (!owner || !isCurrent(owner)) return;
		try {
			const metadata: Record<string, unknown> = { sessionId: owner.sessionId };
			for (const key of diagnosticKeys) {
				const descriptor = data && Object.getOwnPropertyDescriptor(data, key);
				if (descriptor && "value" in descriptor) metadata[key] = descriptor.value;
			}
			const error = data && Object.getOwnPropertyDescriptor(data, "error");
			if (error && "value" in error) metadata.errorName = errorName(error.value);
			owner.diagnostics.record(phase, metadata);
		} catch {
			/* diagnostics must not interfere with core retry or message transforms */
		}
	};
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
	const rotateModelIfNeeded = async (ctx: RotationContext, owner: Runtime) => {
		if (!isCurrent(owner)) return;
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
			safeNotify(ctx,
				`kun-retry: no other usable candidate model to switch to (pool: ${pool.join(", ") || "empty"}). Staying on ${currentKey ?? "current"}.`,
				"warning",
			);
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
			record(owner, "rotation_failed", { errorName: errorName(e) });
			if (isCurrent(owner)) safeNotify(ctx,
				`kun-retry: switch to ${nextKey} failed. Keeping ${currentKey ?? "current"}.`,
				"warning",
			);
			return;
		}
		if (!isCurrent(owner)) return;

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
		safeNotify(ctx,
			ok
				? `kun-retry: switched model ${currentKey ?? "?"} → ${nextKey} after ${cfg.switchAfterErrors} retryable error(s)`
				: `kun-retry: could not switch to ${nextKey} (no configured auth). Keeping ${currentKey ?? "current"}.`,
			"warning",
		);
	};

	const safeRotate = async (ctx: RotationContext, owner: Runtime) => {
		try {
			await rotateModelIfNeeded(ctx, owner);
		} catch (error) {
			record(owner, "rotation_failed", { errorName: errorName(error) });
			if (isCurrent(owner)) safeNotify(ctx, "kun-retry: model rotation failed; keeping the retryable response.", "warning");
		}
	};

	// Prototype wrappers only resolve manager-scoped hooks. No factory's policy
	// or UI replaces another factory's callbacks when an SDK/session is shared.
	const patch = installConstantDelayPatch(AgentSession);
	let patchWarning = patch.installed ? undefined : patch.reason;
	// Registry capture happens at _bindExtensionCore, including /reload. Never
	// patch user abort, fall back to ctx.abort(), or guess a session by its ID.
	const softAbortPatch = installSoftAbortPatch(AgentSession);
	const softAbortWarning = softAbortPatch.installed ? undefined : softAbortPatch.reason;

	const applySettingsSync = (notify: StatusContext | undefined) => {
		try {
			const result = syncBuiltinRetrySettings(cfg);
			if (result.changed) safeNotify(notify,
				`kun-retry synced settings.json: retry.maxRetries=${result.maxRetries}, baseDelayMs=${result.baseDelayMs}, enabled=${result.enabled}. Live session policy is updated immediately.`,
				"info",
			);
			return result;
		} catch (error) {
			record(runtime, "settings_sync_failed", { errorName: errorName(error) });
			safeNotify(notify, "kun-retry: could not sync settings.json; live retry policy remains available.", "warning");
			return undefined;
		}
	};

	// File sync is a compatibility backup; live getSettings needs no /reload.
	applySettingsSync(undefined);

	const getStallTimeoutMs = () =>
		parseStallTimeoutMs(pi.getFlag(STALL_TIMEOUT_FLAG)) ??
		parseStallTimeoutMs(process.env[STALL_TIMEOUT_ENV]) ??
		refreshConfig().stallTimeoutMs;

	const disposeRuntime = () => {
		const owner = runtime;
		if (!owner || owner.disposed) return;
		owner.disposed = true;
		owner.watchdog.dispose();
		// The status config callback disables an obsolete owner's stable footer.
		owner.status.clear();
		owner.status.dispose();
		for (const cleanup of [owner.unbindRetryHooks, owner.unsubscribe]) {
			try { cleanup?.(); } catch { /* shutdown remains idempotent */ }
		}
		owner.diagnostics.dispose();
		owner.unbindRetryHooks = undefined;
		owner.unsubscribe = undefined;
		owner.notifyUI = undefined;
		owner.manager = undefined;
		owner.sessionOwner = undefined;
		owner.requestSignal = undefined;
		owner.sessionId = undefined;
		runtime = undefined;
		// Registry's weak mapping belongs to AgentSession, not this factory. Keep
		// it through reload; shutdown only removes this runtime's hooks/resources.
	};

	const createRuntime = (ctx: ExtensionContext): Runtime => {
		const manager = ctx.sessionManager;
		const sessionOwner = resolveSession(manager);
		let sessionId: string | undefined;
		try { sessionId = manager.getSessionId(); } catch { /* metadata only */ }
		const status = createRetryStatus(() => ({ ...cfg, enabled: cfg.enabled && isCurrent(owner) }),
			() => sessionRotationOn && cfg.switchAfterErrors > 0 ? ` rot/${cfg.switchAfterErrors}` : "",
		);
		const diagnostics = createRetryDiagnostics((entry) => {
			if (isCurrent(owner)) pi.appendEntry("kun-retry-diagnostic", entry);
		});
		const watchdog = createStallWatchdog({
			getTimeoutMs: getStallTimeoutMs,
			isEnabled: () => isCurrent(owner) && cfg.enabled && !owner.requestSignal?.aborted &&
				!owner.sessionOwner?._agentRunAbortRequested && !owner.sessionOwner?.isCompacting && owner.sessionOwner?.isStreaming !== false,
			// A manager can be reused by a fork/replacement AgentSession. An old
			// timer must never abort the new owner even if manager identity is equal.
			abort: () => isCurrent(owner) && !owner.requestSignal?.aborted && owner.sessionOwner &&
				resolveSession(owner.manager) === owner.sessionOwner
				? beginSoftAbort(owner.manager) : "unavailable",
			onStall: () => { if (isCurrent(owner)) owner.status.retry(); },
			onUnavailable: () => {
				if (!isCurrent(owner) || owner.softAbortWarned) return;
				owner.softAbortWarned = true;
				record(owner, "watchdog_unavailable", { reason: "soft_abort_unavailable" });
				safeNotify(owner.notifyUI,
					`kun-retry: ${softAbortWarning ?? "soft abort unavailable for this session"} — stalled stream left untouched (no user-cancel fallback).`,
					"warning",
				);
			},
			record: (phase, data) => record(owner, `watchdog_${phase}`, data),
		});
		const owner: Runtime = {
			manager, sessionOwner, sessionId, notifyUI: snapshotUI(ctx), status, diagnostics, watchdog,
			disposed: false, softAbortWarned: false, requestSignal: undefined, lastIncomingUiAt: 0,
		};
		runtime = owner;
		status.capture(ctx);
		owner.unbindRetryHooks = bindRetryHooks(manager, {
			getConstantDelayMs: () => isCurrent(owner) && cfg.enabled ? cfg.constantDelayMs : 0,
			getMaxRetries: () => isCurrent(owner) ? effectiveMaxRetries(cfg) : 0,
			// Local agent-turn retry adapter only; never applyOverrides to the
			// shared SettingsManager (summarization has an independent core policy).
			// /retry off only disables extension matching/watchdog/constant mode.
			// Core transient-error retry remains enabled, as in settings-bridge.
			getSettings: () => isCurrent(owner) && cfg.syncSettings
				? { enabled: true, maxRetries: effectiveMaxRetries(cfg), baseDelayMs: cfg.baseDelayMs }
				: undefined,
			onRetry: (info) => {
				if (!isCurrent(owner)) return;
				record(owner, "onRetry", info);
				status.retry(info);
			},
			onExhausted: (info) => {
				if (!isCurrent(owner)) return;
				record(owner, "exhausted", info);
				status.clear();
			},
			record: (phase, data) => record(owner, phase, data),
		});
		// Structural adapter works with independently loaded SDK copies without
		// instanceof checks. Observers only select metadata, never raw errors.
		try {
			const session = sessionOwner as ObservableSession | undefined;
			if (typeof session?.subscribe === "function") {
				owner.unsubscribe = session.subscribe((event) => {
					if (!isCurrent(owner)) return;
					try {
						if (event.type === "auto_retry_start") {
							record(owner, event.type, { attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs });
						} else if (event.type === "auto_retry_end") {
							record(owner, event.type, { attempt: event.attempt, success: event.success });
							owner.status.clear();
						}
					} catch (error) {
						record(owner, "observer_failed", { errorName: errorName(error) });
					}
				});
			}
		} catch (error) {
			record(owner, "subscribe_failed", { errorName: errorName(error) });
		}
		return owner;
	};

	const observeProviderOrStreamEvent = (ctx: ExtensionContext) => {
		const owner = activeRuntime(ctx);
		if (!owner || !cfg.enabled || owner.sessionOwner?.isStreaming === false || owner.sessionOwner?.isCompacting) return;
		owner.watchdog.touch();
		const now = Date.now();
		if (now - owner.lastIncomingUiAt >= INCOMING_UI_MIN_MS) {
			owner.lastIncomingUiAt = now;
			owner.status.receiving();
		}
	};

	const updateFooterStatus = (ctx: ExtensionContext) => {
		const owner = activeRuntime(ctx);
		if (!owner) return;
		owner.status.capture(ctx);
		owner.status.refresh();
	};

	// ── Lifecycle ──────────────────────────────────────────────────────────

	pi.on("session_start", (event, ctx) => {
		if (disposed) return;
		disposeRuntime();
		refreshConfig();
		errorStreak = 0;
		baseModelKey = modelKeyOf(ctx.model);
		sessionCandidates = [];
		sessionRotationOn = false;
		const owner = createRuntime(ctx);
		record(owner, "session_start", { reason: event.reason, bound: !!owner.sessionOwner });
		// A failed file write must not prevent hook/session binding.
		applySettingsSync(ctx);
		if (patchWarning && (cfg.constantDelayMs > 0 || cfg.syncSettings)) {
			safeNotify(ctx, `kun-retry: ${patchWarning}`, "warning");
			patchWarning = undefined;
		}
		owner.status.clear();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (disposed) return;
		// A stale shutdown from an earlier manager must not dispose its replacement.
		try {
			if (runtime && ctx.sessionManager !== runtime.manager) return;
		} catch {
			/* A shutdown context may already be invalidated; still release resources. */
		}
		record(runtime, "session_shutdown");
		disposed = true;
		disposeRuntime();
		errorStreak = 0;
		baseModelKey = undefined;
		sessionCandidates = [];
		sessionRotationOn = false;
	});

	pi.on("before_provider_request", (_event, ctx) => {
		const owner = activeRuntime(ctx);
		if (!owner) return;
		const session = owner.sessionOwner;
		// Provider hooks also run for summary/cache-warming requests. Real SDK
		// sessions expose isStreaming=false there; undefined only accommodates
		// structural test/older SDK fixtures, never a known non-agent request.
		if (session?.isStreaming === false || session?.isCompacting || session?._agentRunAbortRequested) return;
		const signal = ctx.signal;
		if (signal?.aborted) return;
		owner.requestSignal = signal;
		owner.status.capture(ctx);
		owner.status.clear();
		owner.lastIncomingUiAt = 0;
		owner.watchdog.start();
	});

	pi.on("after_provider_response", (_event, ctx) => {
		observeProviderOrStreamEvent(ctx);
	});

	pi.on("provider_stream_event", (_event, ctx) => {
		// Parsed provider activity can precede normalized text/thinking deltas.
		// Never inspect/store its payload; keepalive/progress still resets idle time.
		observeProviderOrStreamEvent(ctx);
	});

	pi.on("message_start", (_event, ctx) => {
		observeProviderOrStreamEvent(ctx);
	});

	pi.on("message_update", (_event, ctx) => {
		observeProviderOrStreamEvent(ctx);
	});

	pi.on("agent_end", (_event, ctx) => {
		// This precedes _prepareRetry: never mark the session settled here.
		record(activeRuntime(ctx), "agent_end");
	});

	pi.on("agent_settled", (event, ctx) => {
		const owner = activeRuntime(ctx);
		if (!owner) return;
		record(owner, "agent_settled", { aborted: event.aborted });
		owner.watchdog.stop();
		owner.watchdog.consumeAbort();
		owner.requestSignal = undefined;
		owner.status.clear();
	});

	pi.on("message_end", async (event, ctx) => {
		const message = event.message as unknown as MessageShape;
		if (message.role !== "assistant") return;
		const owner = activeRuntime(ctx);
		if (!owner) return;
		// Consume before stop(): only a confirmed direct watchdog abort may rewrite
		// an aborted response. A simultaneous real user cancel always takes priority.
		const stalled = owner.watchdog.consumeAbort();
		owner.watchdog.stop();
		owner.status.clear();
		const userCancelled = resolveSession(owner.manager)?._agentRunAbortRequested === true;
		if (userCancelled || (!stalled && message.stopReason === "aborted")) {
			record(owner, "message_end_classified", { stopReason: message.stopReason, reason: "user_cancel", rewritten: false });
			return;
		}

		if (message.stopReason !== "error" && message.stopReason !== "aborted" && !stalled && !isEmptyAssistantContent(message.content)) {
			errorStreak = 0;
		}

		let replacement: MessageShape | undefined;
		let reason = cfg.enabled ? "unmatched" : "disabled";
		if (stalled) {
			reason = "stall";
			const original = typeof message.errorMessage === "string"
				? message.errorMessage
				: "Provider stream stalled while Pi was waiting for a response.";
			const { text } = neutralizeNonRetryable(original);
			replacement = {
				...message,
				stopReason: "error",
				errorMessage: original.includes(STALL_WATCHDOG_TAG) && original.includes(RETRYABLE_HINT)
					? text
					: `${text}\n\n${STALL_WATCHDOG_TAG} ${RETRYABLE_HINT}; treating stalled provider stream as retryable.`,
			};
		} else if (cfg.enabled && cfg.retryEmptyResponse && message.stopReason !== "error" && message.stopReason !== "length" && isEmptyAssistantContent(message.content)) {
			reason = "empty_response";
			const existing = typeof message.errorMessage === "string" ? message.errorMessage : "";
			if (!existing.includes(EMPTY_RESPONSE_TAG)) replacement = {
				...message,
				stopReason: "error",
				errorMessage: `Provider returned an empty response (stopReason: ${
					typeof message.stopReason === "string" ? message.stopReason : "unknown"
				}, no answer text or tool calls).\n\n${EMPTY_RESPONSE_TAG} ${RETRYABLE_HINT}; treating empty provider response as retryable.`,
			};
		} else if (cfg.enabled && message.stopReason === "error" && typeof message.errorMessage === "string") {
			const matched = matchRetryableError(message.errorMessage, {
				nl: cfg.nl, statusCodes: cfg.statusCodes, errorPatterns: cfg.errorPatterns,
			});
			if (matched) {
				// Tags are fixed metadata; labels can contain user/provider text.
				reason = matched.tag;
				if (!message.errorMessage.includes(matched.tag) || !message.errorMessage.includes(RETRYABLE_HINT)) {
					const base = cfg.nl ? neutralizeNonRetryable(message.errorMessage).text : message.errorMessage;
					replacement = { ...message, errorMessage: appendRetryHint(base, matched) };
				}
			}
		}
		if (!replacement && message.stopReason !== "error" && reason === "unmatched") reason = "success";
		record(owner, "message_end_classified", { stopReason: message.stopReason, reason, rewritten: !!replacement });
		if (!replacement) return;

		// Compute the transform before any awaited UI/model work. Registry/pi/UI
		// exceptions during rotation must never discard a retryable final message.
		const result = { message: replacement as typeof event.message };
		record(owner, "message_end_rewritten", { stopReason: replacement.stopReason, reason });
		owner.status.retry();
		await safeRotate(ctx, owner);
		return result;
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
			if (!activeRuntime(ctx)) return;
			refreshConfig();
			const a = (args ?? "").trim().toLowerCase();
			let next: boolean;
			if (a === "on" || a === "1" || a === "true" || a === "enable") next = true;
			else if (a === "off" || a === "0" || a === "false" || a === "disable") next = false;
			else if (!a) next = !cfg.nl;
			else {
				safeNotify(ctx, `Usage: /retry-nl [on|off]  (current: ${cfg.nl ? "on" : "off"})`, "error");
				return;
			}
			cfg = saveConfig({ nl: next, enabled: next ? true : cfg.enabled });
			applySettingsSync(ctx);
			updateFooterStatus(ctx);
			safeNotify(ctx,
				next
					? `kun-retry nl ON — any provider error is retryable, extension maxRetries=${effectiveMaxRetries(cfg)}.${cfg.syncSettings ? " Live agent budget updated." : " syncSettings=false: core budget preserved."} Escape cancels a backoff.`
					: `kun-retry nl OFF — back to maxRetries=${cfg.maxRetries}, status codes + patterns only.`,
				next ? "warning" : "info",
			);
		},
	});

	pi.registerCommand("retry", {
		description:
			"kun-retry: status | on | off | max <n> | delay <ms> | constant <ms|off> | codes <list> | patterns <list> | stall <ms|off> | empty <on|off> | trace [on|off|clear] | sync | help",
		getArgumentCompletions: (prefix: string) => {
			const subs = [
				"status", "on", "off", "max", "delay", "constant", "codes", "patterns",
				"stall", "empty", "trace", "sync", "help",
			];
			if (prefix.startsWith("trace ")) {
				const rest = prefix.slice(6);
				return ["on", "off", "clear"].filter((s) => s.startsWith(rest))
					.map((s) => ({ value: `trace ${s}`, label: s }));
			}
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
			if (!activeRuntime(ctx)) return;
			refreshConfig();
			const raw = (args ?? "").trim();
			const [cmd, ...rest] = raw.split(/\s+/);
			const restJoined = rest.join(" ").trim();
			const sub = (cmd ?? "").toLowerCase();

			if (!sub || sub === "status" || sub === "show") {
				safeNotify(ctx, formatConfigSummary(cfg), "info");
				return;
			}

			if (sub === "on" || sub === "enable") {
				cfg = saveConfig({ enabled: true });
				applySettingsSync(ctx);
				updateFooterStatus(ctx);
				safeNotify(ctx, "kun-retry enabled", "info");
				return;
			}

			if (sub === "off" || sub === "disable") {
				cfg = saveConfig({ enabled: false, nl: false });
				applySettingsSync(ctx);
				updateFooterStatus(ctx);
				safeNotify(ctx, "kun-retry disabled (and nl off)", "info");
				return;
			}

			if (sub === "config") {
				if (!restJoined) {
					safeNotify(ctx, formatConfigSummary(cfg), "info");
					return;
				}
				// JSON patch: /retry config {"maxRetries":20}
				try {
					const patch = JSON.parse(restJoined) as Partial<KunRetryConfig>;
					cfg = saveConfig(patch);
					applySettingsSync(ctx);
					updateFooterStatus(ctx);
					safeNotify(ctx, `kun-retry config updated:\n${formatConfigSummary(cfg)}`, "info");
				} catch (e) {
					safeNotify(ctx, `Invalid JSON patch: ${e instanceof Error ? e.message : String(e)}`, "error");
				}
				return;
			}

			if (sub === "max" || sub === "maxretries") {
				const n = Number(restJoined);
				if (!Number.isFinite(n) || n < 0) {
					safeNotify(ctx, "Usage: /retry max <non-negative integer>", "error");
					return;
				}
				cfg = saveConfig({ maxRetries: Math.floor(n) });
				applySettingsSync(ctx);
				updateFooterStatus(ctx);
				safeNotify(ctx,
					`kun-retry maxRetries=${cfg.maxRetries} (effective ${effectiveMaxRetries(cfg)}). ${cfg.syncSettings ? "Live agent retry budget updated." : "syncSettings=false: core retry budget preserved."}`,
					"info",
				);
				return;
			}

			if (sub === "delay" || sub === "basedelay") {
				const n = Number(restJoined);
				if (!Number.isFinite(n) || n < 0) {
					safeNotify(ctx, "Usage: /retry delay <ms>", "error");
					return;
				}
				cfg = saveConfig({ baseDelayMs: Math.floor(n) });
				applySettingsSync(ctx);
				safeNotify(ctx, `kun-retry baseDelayMs=${cfg.baseDelayMs}. ${cfg.syncSettings ? "Live agent delay updated." : "syncSettings=false: core delay preserved."}`, "info");
				return;
			}

			if (sub === "constant" || sub === "const" || sub === "fixed") {
				if (!restJoined) {
					safeNotify(ctx,
						cfg.constantDelayMs > 0
							? `constantDelayMs=${cfg.constantDelayMs} (${formatDelay(cfg.constantDelayMs)} fixed interval)`
							: "constantDelayMs=0 (off — Pi built-in exponential backoff)",
						"info",
					);
					return;
				}
				const parsed = parseConstantDelayMs(restJoined);
				if (parsed === undefined) {
					safeNotify(ctx, "Usage: /retry constant <ms|5s|2m|off>", "error");
					return;
				}
				cfg = saveConfig({ constantDelayMs: parsed });
				applySettingsSync(ctx);
				if (cfg.constantDelayMs === 0) {
					safeNotify(ctx,
						`kun-retry constant interval off — back to Pi built-in exponential backoff (${cfg.baseDelayMs}ms × 2^(attempt-1)).`,
						"info",
					);
				} else {
					safeNotify(ctx,
						`kun-retry constant interval ON — every retry waits ${formatDelay(cfg.constantDelayMs)}, no exponential growth. Takes effect immediately.`,
						"info",
					);
				}
				updateFooterStatus(ctx);
				return;
			}

			if (sub === "codes" || sub === "statuscodes") {
				if (!restJoined || restJoined === "clear" || restJoined === "none") {
					cfg = saveConfig({ statusCodes: [] });
					safeNotify(ctx, "kun-retry statusCodes cleared", "info");
					return;
				}
				if (restJoined === "default" || restJoined === "reset") {
					cfg = saveConfig({ statusCodes: [...DEFAULT_CONFIG.statusCodes] });
					safeNotify(ctx, `kun-retry statusCodes reset: [${cfg.statusCodes.join(", ")}]`, "info");
					return;
				}
				const codes = parseIntList(restJoined);
				if (!codes.length) {
					safeNotify(ctx, "Usage: /retry codes 401,403,429  | clear | default", "error");
					return;
				}
				cfg = saveConfig({ statusCodes: codes });
				safeNotify(ctx, `kun-retry statusCodes: [${cfg.statusCodes.join(", ")}]`, "info");
				return;
			}

			if (sub === "patterns" || sub === "pattern") {
				if (!restJoined || restJoined === "clear" || restJoined === "none") {
					cfg = saveConfig({ errorPatterns: [] });
					safeNotify(ctx, "kun-retry errorPatterns cleared", "info");
					return;
				}
				const patterns = parsePatternArgs(restJoined);
				if (!patterns.length) {
					safeNotify(ctx, 'Usage: /retry patterns "foo|bar",timeout  or JSON array', "error");
					return;
				}
				// Validate compile
				for (const p of patterns) {
					try {
						new RegExp(p, "i");
					} catch (e) {
						safeNotify(ctx, `Invalid regex ${JSON.stringify(p)}: ${e instanceof Error ? e.message : String(e)}`, "error");
						return;
					}
				}
				cfg = saveConfig({ errorPatterns: patterns });
				safeNotify(ctx, `kun-retry errorPatterns (${cfg.errorPatterns.length}): ${cfg.errorPatterns.join(" | ")}`, "info");
				return;
			}

			if (sub === "stall") {
				if (!restJoined) {
					safeNotify(ctx, `stallTimeoutMs=${cfg.stallTimeoutMs} (0=off)`, "info");
					return;
				}
				const parsed = parseStallTimeoutMs(restJoined);
				if (parsed === undefined) {
					safeNotify(ctx, "Usage: /retry stall <ms|off|0>", "error");
					return;
				}
				cfg = saveConfig({ stallTimeoutMs: parsed });
				safeNotify(ctx, `kun-retry stallTimeoutMs=${cfg.stallTimeoutMs === 0 ? "off" : cfg.stallTimeoutMs}`, "info");
				return;
			}

			if (sub === "empty" || sub === "emptyresponse") {
				if (!restJoined) {
					safeNotify(ctx, `retryEmptyResponse=${cfg.retryEmptyResponse}`, "info");
					return;
				}
				const a = restJoined.toLowerCase();
				let next: boolean;
				if (a === "on" || a === "1" || a === "true" || a === "enable") next = true;
				else if (a === "off" || a === "0" || a === "false" || a === "disable") next = false;
				else {
					safeNotify(ctx, "Usage: /retry empty <on|off>", "error");
					return;
				}
				cfg = saveConfig({ retryEmptyResponse: next });
				safeNotify(ctx, `kun-retry retryEmptyResponse=${cfg.retryEmptyResponse}`, "info");
				return;
			}

			if (sub === "trace") {
				const owner = activeRuntime(ctx);
				if (!owner) return;
				const action = restJoined.toLowerCase();
				if (!action) safeNotify(ctx, owner.diagnostics.format(), "info");
				else if (action === "clear") {
					owner.diagnostics.clear();
					safeNotify(ctx, "kun-retry diagnostic ring cleared", "info");
				} else if (action === "on" || action === "off") {
					owner.diagnostics.enabled = action === "on";
					record(owner, "trace", { enabled: owner.diagnostics.enabled });
					safeNotify(ctx, `kun-retry trace ${action.toUpperCase()} (current runtime only; ${action === "on" ? "metadata entries persisted" : "memory ring only"})`, "info");
				} else safeNotify(ctx, "Usage: /retry trace [on|off|clear]", "error");
				return;
			}

			if (sub === "sync") {
				const sync = applySettingsSync(ctx);
				if (!sync) return;
				safeNotify(ctx,
					`settings.json ${sync.changed ? "updated" : "already in sync"}: maxRetries=${sync.maxRetries}, baseDelayMs=${sync.baseDelayMs}, maxAgentDelayMs=${sync.maxAgentDelayMs}, enabled=${sync.enabled}. Path: ${sync.path}. ${cfg.syncSettings ? "Live agent policy is current." : "syncSettings=false: core settings preserved."}`,
					"info",
				);
				return;
			}

			if (sub === "help") {
				safeNotify(ctx,
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
						"/retry trace [on|off|clear] runtime diagnostic metadata (no arg: show)",
						"/retry-nl [on|off]      unlimited any-error mode",
						"/retry-models           manage model rotation (see /retry-models help)",
						`nl cap constant: ${NL_MAX_RETRIES}`,
					].join("\n"),
					"info",
				);
				return;
			}

			safeNotify(ctx, `Unknown /retry subcommand: ${sub}. Try /retry help`, "error");
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
			if (!activeRuntime(ctx)) return;
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
				safeNotify(ctx,
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
					safeNotify(ctx, `kun-retry: could not read available models: ${e instanceof Error ? e.message : String(e)}`, "error");
					return;
				}
				if (!all.length) {
					safeNotify(ctx, "kun-retry: no configured/available models (check provider auth / API keys)", "info");
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
				safeNotify(ctx,
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
				safeNotify(ctx,
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
				safeNotify(ctx, "kun-retry model rotation cleared (candidates removed, rotation off)", "info");
				return;
			}

			if (sub === "add") {
				const added = parseModelList(restJoined);
				if (!added.length) {
					safeNotify(ctx, "Usage: /retry-models add <provider/id> [more...]", "error");
					return;
				}
				const validAdded = filterAvailable(added);
				const skipped = added.filter((k) => !validAdded.includes(k));
				if (!validAdded.length) {
					safeNotify(ctx,
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
				safeNotify(ctx,
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
					safeNotify(ctx, "Usage: /retry-models remove <provider/id> [more...]", "error");
					return;
				}
				const kept = sessionCandidates.filter((m) => !drop.has(m));
				sessionCandidates = kept;
				sessionRotationOn = kept.length > 0 && sessionRotationOn;
				updateFooterStatus(ctx);
				safeNotify(ctx,
					kept.length
						? `kun-retry candidates (${kept.length}):\n  ${kept.join("\n  ")}`
						: "kun-retry candidates now empty (rotation off)",
					"info",
				);
				return;
			}

			if (sub === "switch" || sub === "switchafter" || sub === "every") {
				if (!restJoined) {
					safeNotify(ctx,
						`switchAfterErrors=${cfg.switchAfterErrors}${cfg.switchAfterErrors === 0 ? " (0 = switching disabled)" : ""}`,
						"info",
					);
					return;
				}
				const n = Number(restJoined);
				if (!Number.isFinite(n) || n < 0) {
					safeNotify(ctx, "Usage: /retry-models switch <non-negative integer>  (0 disables switching)", "error");
					return;
				}
				cfg = saveConfig({ switchAfterErrors: Math.floor(n) });
				errorStreak = 0;
				updateFooterStatus(ctx);
				safeNotify(ctx,
					cfg.switchAfterErrors === 0
						? "kun-retry switchAfterErrors=0 — model switching disabled (rotation idle)"
						: `kun-retry switchAfterErrors=${cfg.switchAfterErrors} — switch model after every ${cfg.switchAfterErrors} retryable error(s)`,
					"info",
				);
				return;
			}

			if (sub === "rotate" || sub === "rotation") {
				if (!restJoined) {
					safeNotify(ctx, `modelRotation=${sessionRotationOn ? "on" : "off"} (${sessionCandidates.length} candidate(s))`, "info");
					return;
				}
				const a = restJoined.toLowerCase();
				let next: boolean;
				if (a === "on" || a === "1" || a === "true" || a === "enable") next = true;
				else if (a === "off" || a === "0" || a === "false" || a === "disable") next = false;
				else {
					safeNotify(ctx, "Usage: /retry-models rotate <on|off>", "error");
					return;
				}
				if (next && sessionCandidates.length === 0) {
					safeNotify(ctx, "kun-retry: set candidates first with /retry-models <provider/id> ...", "error");
					return;
				}
				sessionRotationOn = next;
				errorStreak = 0;
				updateFooterStatus(ctx);
				safeNotify(ctx, `kun-retry modelRotation=${sessionRotationOn ? "on" : "off"}`, "info");
				return;
			}

			if (sub === "active" || sub === "includeactive") {
				if (!restJoined) {
					safeNotify(ctx, `includeActiveInRotation=${cfg.includeActiveInRotation}`, "info");
					return;
				}
				const a = restJoined.toLowerCase();
				let next: boolean;
				if (a === "on" || a === "1" || a === "true" || a === "enable") next = true;
				else if (a === "off" || a === "0" || a === "false" || a === "disable") next = false;
				else {
					safeNotify(ctx, "Usage: /retry-models active <on|off>", "error");
					return;
				}
				cfg = saveConfig({ includeActiveInRotation: next });
				// Changing pool composition mid-sequence: reset the streak so the next
				// switch is computed against the new pool from a clean count.
				errorStreak = 0;
				safeNotify(ctx, `kun-retry includeActiveInRotation=${cfg.includeActiveInRotation}`, "info");
				return;
			}

			if (sub === "thinking" || sub === "think" || sub === "level") {
				if (!restJoined) {
					safeNotify(ctx,
						`rotationThinkingLevel=${cfg.rotationThinkingLevel}${
							cfg.rotationThinkingLevel === "max" ? " (falls back to each model's own highest supported level)" : ""
						}`,
						"info",
					);
					return;
				}
				const a = restJoined.toLowerCase() as RotationThinkingLevel;
				if (!ROTATION_THINKING_LEVELS.includes(a)) {
					safeNotify(ctx,
						`Usage: /retry-models thinking <${ROTATION_THINKING_LEVELS.join("|")}>`,
						"error",
					);
					return;
				}
				cfg = saveConfig({ rotationThinkingLevel: a });
				safeNotify(ctx,
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
				safeNotify(ctx,
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
			safeNotify(ctx,
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
