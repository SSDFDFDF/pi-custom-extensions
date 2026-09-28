/**
 * Soft abort for the stall watchdog.
 *
 * `AgentSession.abort()` is Pi's *user-cancelled* path: it sets
 * `_agentRunAbortRequested = true`, and `_handlePostAgentRun()` checks that flag
 * before anything else and returns immediately, so `_prepareRetry()` is never
 * called. A stall watchdog that aborts through `ctx.abort()` therefore writes a
 * retryable-looking error message that Pi refuses to retry — the silent
 * no-retry failure this module fixes.
 *
 * The watchdog only needs to tear down the stalled provider stream, not cancel
 * the run, so this module aborts the underlying agent run and leaves
 * `_agentRunAbortRequested` false, which keeps Pi's retry path alive.
 *
 * Two routes are needed, because neither alone is sufficient:
 *
 * 1. **Direct** — if the live session has been captured (every Pi mode calls
 *    `bindExtensions` at startup), its `agent.abort()` is called straight away.
 *    This is the clean path and it never touches queued messages.
 *
 * 2. **Deferred** — when no capture exists the watchdog calls `ctx.abort()`, which
 *    in interactive mode routes to `session.abort()`. A one-shot armed flag makes
 *    the patched `abort()` perform the soft abort instead of the cancelling one.
 *    This path matters because `bindExtensions` runs **once per process**: a Pi
 *    process that started before this extension was loaded (or that only ran
 *    `/reload`, which does not re-bind) has no capture, and without the fallback
 *    the watchdog could never retry.
 *
 * The armed flag is a one-shot with a short TTL so a user pressing Escape shortly
 * afterwards still cancels the run normally instead of being mistaken for the
 * watchdog's abort.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";

export interface SoftAbortInstallResult {
	installed: boolean;
	/** Present when neither route could be installed. */
	reason?: string;
}

/** Minimal structural view of the pieces we touch on a live session. */
interface AbortableSession {
	agent?: { abort?: () => void };
	waitForIdle?: () => Promise<void>;
}

const CAPTURE_KEY = Symbol.for("kun-retry.softAbort.capture");
const ARMED_KEY = Symbol.for("kun-retry.softAbort.armed");
const PATCHED_KEY = Symbol.for("kun-retry.softAbort.patched");

/** How long an armed flag stays valid before a later abort is treated as a user cancel. */
const ARM_TTL_MS = 5_000;

type GlobalWithSoftAbort = typeof globalThis & {
	[CAPTURE_KEY]?: AbortableSession | undefined;
	[ARMED_KEY]?: number | undefined;
	[PATCHED_KEY]?: boolean;
};

export type SoftAbortMode = "direct" | "deferred" | "unavailable";

/**
 * Patch the session class once per process:
 * - `bindExtensions` captures the live session for the direct route.
 * - `abort` honours the armed flag for the deferred route.
 *
 * Safe to call again after `/reload`: the prototype patches install a single time
 * and the capture survives shutdown, because `/reload` reuses the same session.
 */
export function installSoftAbortPatch(agentSessionClass: unknown): SoftAbortInstallResult {
	const g = globalThis as GlobalWithSoftAbort;
	if (g[PATCHED_KEY]) return { installed: true };

	const proto = (agentSessionClass as { prototype?: Record<string, unknown> } | undefined)?.prototype;
	const originalBind = proto?.bindExtensions;
	const originalAbort = proto?.abort;
	if (!proto || typeof originalBind !== "function" || typeof originalAbort !== "function") {
		return {
			installed: false,
			reason:
				"AgentSession.prototype.bindExtensions/abort not found; the stall watchdog can only hard-abort, which makes Pi skip auto-retry for a stalled stream",
		};
	}

	const bind = originalBind as (this: AbortableSession, ...args: unknown[]) => Promise<void>;
	proto.bindExtensions = async function patchedBindExtensions(this: AbortableSession, ...args: unknown[]) {
		g[CAPTURE_KEY] = this;
		return bind.apply(this, args);
	};

	const abort = originalAbort as (this: AbortableSession) => Promise<void>;
	proto.abort = async function patchedAbort(this: AbortableSession) {
		if (consumeArmed()) {
			// Tear down only the in-flight provider stream. Deliberately skip
			// retry/compaction/branch-summary cancellation and never touch
			// `_agentRunAbortRequested`: that flag means "user cancelled" and makes Pi
			// skip auto-retry entirely.
			this.agent?.abort?.();
			try {
				await this.waitForIdle?.();
			} catch {
				/* the idle wait is best-effort; the run settles on its own */
			}
			return;
		}
		return abort.call(this);
	};

	g[PATCHED_KEY] = true;
	return { installed: true };
}

/** Whether the deferred route is available at all. */
export function isSoftAbortInstalled(): boolean {
	return (globalThis as GlobalWithSoftAbort)[PATCHED_KEY] === true;
}

function consumeArmed(): boolean {
	const g = globalThis as GlobalWithSoftAbort;
	const armedAt = g[ARMED_KEY];
	if (armedAt === undefined) return false;
	g[ARMED_KEY] = undefined;
	// A stale flag means the watchdog's abort never arrived; treat as a user cancel.
	return Date.now() - armedAt <= ARM_TTL_MS;
}

function armSoftAbort(): void {
	const g = globalThis as GlobalWithSoftAbort;
	g[ARMED_KEY] = Date.now();
	// Expire the flag so a later user abort is not silently converted.
	const timer = setTimeout(() => {
		if (g[ARMED_KEY] !== undefined && Date.now() - g[ARMED_KEY] > ARM_TTL_MS) g[ARMED_KEY] = undefined;
	}, ARM_TTL_MS + 50);
	timer.unref?.();
}

/**
 * Begin a soft abort.
 *
 * - `"direct"`: the stream was already aborted; do **not** call `ctx.abort()`.
 * - `"deferred"`: an armed soft abort is pending; call `ctx.abort()` to route
 *   through the patched session `abort()`.
 * - `"unavailable"`: no soft route exists; the caller should warn and fall back.
 */
export function beginSoftAbort(): SoftAbortMode {
	const g = globalThis as GlobalWithSoftAbort;
	const session = g[CAPTURE_KEY];
	const agentAbort = session?.agent?.abort;
	if (session && typeof agentAbort === "function") {
		agentAbort.call(session.agent);
		void session.waitForIdle?.().catch(() => {});
		return "direct";
	}
	if (!isSoftAbortInstalled()) return "unavailable";
	armSoftAbort();
	return "deferred";
}

/** Whether a soft route is currently usable (capture or armed-capable patch). */
export function canSoftAbort(): boolean {
	const g = globalThis as GlobalWithSoftAbort;
	return typeof g[CAPTURE_KEY]?.agent?.abort === "function" || isSoftAbortInstalled();
}

/**
 * Forget the captured session. Deliberately NOT called on `/reload` (the same
 * session is reused and would then have no direct route); reserved for a session
 * that is genuinely gone, and for tests that need the deferred-only situation.
 */
export function forgetCapturedSession(): void {
	(globalThis as GlobalWithSoftAbort)[CAPTURE_KEY] = undefined;
}

export type { AgentSession as AgentSessionType };