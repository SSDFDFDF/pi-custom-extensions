/** Session-scoped policy adapter around Pi's capped agent retry. Core owns sleep, omission and cancellation. */
import { resolveSession } from "./session-registry.ts";

/** @deprecated Legacy planner boundary; the live adapter never rewinds counters. */
export const MAX_EXPONENT = 1000;

/** Clamp for the configured constant interval (1ms .. 1h). */
export const MIN_CONSTANT_DELAY_MS = 1;
export const MAX_CONSTANT_DELAY_MS = 3_600_000;

export interface ConstantRetryPlan {
	/** True when our own budget refuses this retry; the wrapper returns false. */
	exhausted: boolean;
	/** True 1-based attempt number, unaffected by exponent rewinds. */
	cumulative: number;
	/** Whether `_retryAttempt` must be rewound to 0 before delegating. */
	resetRetryAttempt: boolean;
	/** `baseDelayMs` to hand Pi so its formula yields exactly `targetMs`. */
	scaledBaseDelayMs: number;
	/** Exponent Pi will apply after it increments `_retryAttempt`. */
	exponent: number;
}

/**
 * @deprecated Retained as a pure helper for older imports/regression fixtures.
 * Not used by the live adapter: Pi's safe capped formula needs no rewinding.
 *
 * @param retryAttempt Pi's `_retryAttempt` on entry, before Pi increments it.
 *   `0` marks a fresh retry sequence (Pi resets it on a successful assistant
 *   turn, on an aborted backoff, and on final failure), which restarts our
 *   cumulative counter.
 * @param cumulative Our cumulative attempt count for the current sequence.
 * @param maxRetries Effective retry budget.
 * @param targetMs Desired constant interval.
 */
export function planConstantRetry(
	retryAttempt: number,
	cumulative: number,
	maxRetries: number,
	targetMs: number,
): ConstantRetryPlan {
	const fresh = retryAttempt === 0;
	const next = (fresh ? 0 : cumulative) + 1;

	if (next > maxRetries) {
		return {
			exhausted: true,
			cumulative: next - 1,
			resetRetryAttempt: false,
			scaledBaseDelayMs: 0,
			exponent: 0,
		};
	}

	// Pi increments first, so it applies 2 ** (retryAttempt + 1 - 1).
	const resetRetryAttempt = retryAttempt >= MAX_EXPONENT;
	const exponent = resetRetryAttempt ? 0 : retryAttempt;

	return {
		exhausted: false,
		cumulative: next,
		resetRetryAttempt,
		scaledBaseDelayMs: targetMs / 2 ** exponent,
		exponent,
	};
}

export function clampConstantDelayMs(ms: number): number {
	if (!Number.isFinite(ms)) return MIN_CONSTANT_DELAY_MS;
	return Math.min(Math.max(Math.floor(ms), MIN_CONSTANT_DELAY_MS), MAX_CONSTANT_DELAY_MS);
}

/**
 * Parse a `/retry constant` argument. Accepts plain ms plus `5s` / `2m`
 * shorthand; `off` / `0` / `false` / `disable` mean "use Pi's exponential
 * backoff". Returns undefined for unparseable input.
 */
export function parseConstantDelayMs(value: string): number | undefined {
	const normalized = value.trim().toLowerCase();
	if (!normalized) return undefined;
	if (normalized === "off" || normalized === "0" || normalized === "false" || normalized === "disable") return 0;

	const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(normalized);
	if (!match) return undefined;
	const amount = Number(match[1]);
	if (!Number.isFinite(amount) || amount < 0) return undefined;
	const unit = match[2] ?? "ms";
	const factor = unit === "m" ? 60_000 : unit === "s" ? 1_000 : 1;
	return Math.floor(amount * factor);
}

/** Compact human form for a delay, used in the footer status and notifications. */
export function formatDelay(ms: number): string {
	if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000}m`;
	if (ms >= 1_000 && ms % 1_000 === 0) return `${ms / 1_000}s`;
	return `${ms}ms`;
}

export type RetrySettings = { enabled: boolean; maxRetries: number; baseDelayMs: number; maxAgentDelayMs?: number };
export interface ConstantDelayHooks {
	getConstantDelayMs(): number;
	getMaxRetries(): number;
	/** Optional live override. Undefined preserves project/core settings (syncSettings=false). */
	getSettings?(): Partial<RetrySettings> | undefined;
	onRetry?(info: { attempt: number; maxRetries: number; delayMs: number; exponent: number }): void;
	onExhausted?(info: { attempt: number; maxRetries: number }): void;
	record?(phase: string, data?: Record<string, unknown>): void;
}
export interface InstallResult { installed: boolean; reason?: string }
type SessionLike = { sessionManager?: object; _retryAttempt: number; settingsManager: { getRetrySettings(): RetrySettings } };
const STATE = Symbol.for("kun-retry.retryState.v2");
const PATCHED = Symbol.for("kun-retry.constantDelay.patch.v2");
const globals = globalThis as typeof globalThis & { [STATE]?: {
	hooks: WeakMap<object, { hooks: ConstantDelayHooks; owner?: WeakRef<object> }>;
} };
const state = globals[STATE] ??= { hooks: new WeakMap() };

/** Disposer removes only its own registration, so a late old shutdown cannot unbind a replacement. */
export function bindRetryHooks(manager: object, hooks: ConstantDelayHooks): () => void {
	const owner = resolveSession(manager);
	const registration = { hooks, owner: owner ? new WeakRef(owner) : undefined };
	state.hooks.set(manager, registration);
	return () => { if (state.hooks.get(manager) === registration) state.hooks.delete(manager); };
}

function observe(hooks: ConstantDelayHooks, fn: (() => void) | undefined): void {
	const failed = (error: unknown) => {
		try {
			const result: unknown = hooks.record?.("callback_failed", { errorName: error instanceof Error ? error.name : "unknown" });
			if (result && typeof (result as PromiseLike<unknown>).then === "function") void Promise.resolve(result).catch(() => {});
		} catch { /* observer only */ }
	};
	try {
		const result: unknown = fn?.();
		if (result && typeof (result as PromiseLike<unknown>).then === "function") void Promise.resolve(result).catch(failed);
	} catch (error) { failed(error); }
}

/** One wrapper per prototype (including independent SDK copies), with no last-loaded hooks. */
export function installConstantDelayPatch(agentSessionClass: unknown): InstallResult {
	// A live /reload may still have the v1 wrapper underneath us. Disable its
	// process-global hooks so it delegates without consulting a stale child ctx.
	(globalThis as Record<symbol, unknown>)[Symbol.for("kun-retry.constantDelay.hooks")] = undefined;
	const proto = (agentSessionClass as { prototype?: Record<PropertyKey, unknown> } | undefined)?.prototype;
	if (proto && Object.hasOwn(proto, PATCHED)) return { installed: true };
	const original = proto?._prepareRetry;
	if (!proto || typeof original !== "function") return { installed: false, reason: "AgentSession._prepareRetry unavailable; live policy and constant delay unavailable" };
	const originalFn = original as (this: SessionLike, message: unknown) => Promise<boolean>;
	proto._prepareRetry = async function (this: SessionLike, message: unknown) {
		const registration = this.sessionManager && state.hooks.get(this.sessionManager);
		if (!registration || (registration.owner && registration.owner.deref() !== this)) return originalFn.call(this, message);
		const hooks = registration.hooks;
		let settings: RetrySettings;
		let target: number;
		let max: number;
		try {
			settings = { ...this.settingsManager.getRetrySettings(), ...hooks.getSettings?.() };
			target = hooks.getConstantDelayMs();
			max = target > 0 ? Math.min(settings.maxRetries, hooks.getMaxRetries()) : settings.maxRetries;
		} catch (error) {
			observe(hooks, () => hooks.record?.("policy_failed", { errorName: error instanceof Error ? error.name : "unknown" }));
			return originalFn.call(this, message);
		}
		const count = this._retryAttempt;
		observe(hooks, () => hooks.record?.("prepare", { coreAttempt: count, attempt: count, enabled: settings.enabled, maxRetries: max, constantDelayMs: target }));
		if (!settings.enabled || count >= max) {
			observe(hooks, () => hooks.record?.("declined", { reason: settings.enabled ? "budget" : "disabled", attempt: count, maxRetries: max }));
			if (settings.enabled) observe(hooks, () => hooks.onExhausted?.({ attempt: count, maxRetries: max }));
			return false;
		}
		const constant = target > 0;
		const exponential = settings.baseDelayMs * 2 ** count;
		const delayMs = constant ? clampConstantDelayMs(target) : Math.min(Number.isSafeInteger(exponential) ? exponential : Number.MAX_SAFE_INTEGER, settings.maxAgentDelayMs ?? 60_000);
		// Current Pi caps the curve: base=T and cap=T yields T even after
		// exponent overflow. No counter rewind or duplicate budget accounting.
		// This override is read only by this agent-turn call, not summarization.
		const nextSettings = {
			...settings, maxRetries: max,
			...(constant ? { baseDelayMs: delayMs, maxAgentDelayMs: delayMs } : {}),
		};
		const manager = this.settingsManager;
		const descriptor = Object.getOwnPropertyDescriptor(manager, "getRetrySettings");
		let restored = false;
		const restore = () => {
			if (restored) return;
			restored = true;
			if (Object.getOwnPropertyDescriptor(manager, "getRetrySettings")?.value !== shadow) return;
			if (descriptor) Object.defineProperty(manager, "getRetrySettings", descriptor);
			else delete (manager as { getRetrySettings?: unknown }).getRetrySettings;
		};
		const shadow = () => {
			restore();
			observe(hooks, () => hooks.onRetry?.({ attempt: count + 1, maxRetries: max, delayMs, exponent: count }));
			return nextSettings;
		};
		try {
			Object.defineProperty(manager, "getRetrySettings", { configurable: true, writable: true, enumerable: descriptor?.enumerable ?? false, value: shadow });
		} catch {
			observe(hooks, () => hooks.record?.("adapter_unavailable", { reason: "settings_not_shadowable" }));
			return originalFn.call(this, message);
		}
		try {
			const result = await originalFn.call(this, message);
			observe(hooks, () => hooks.record?.("prepared", { continue: result, attempt: count + 1, coreAttempt: this._retryAttempt }));
			return result;
		} catch (error) {
			observe(hooks, () => hooks.record?.("prepare_failed", { errorName: error instanceof Error ? error.name : "unknown" }));
			throw error;
		} finally { restore(); }
	};
	Object.defineProperty(proto, PATCHED, { value: true });
	return { installed: true };
}
