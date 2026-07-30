/**
 * Constant-interval retry backoff for Pi's built-in auto-retry.
 *
 * Pi computes its agent-level retry delay in `AgentSession._prepareRetry` as:
 *
 *     delayMs = settings.baseDelayMs * 2 ** (this._retryAttempt - 1)
 *
 * There is no cap and no jitter, so a long-running unlimited (`nl`) session
 * eventually waits days between attempts, and past ~2^31 ms Node's timer clamps
 * the delay back to 1ms and turns the backoff into a hot loop.
 *
 * Rather than reimplement retry, this module wraps `_prepareRetry` and, only when
 * constant mode is on, hands Pi a `baseDelayMs` pre-divided by the exponent Pi is
 * about to apply. Pi's own formula then lands exactly on the configured constant
 * interval, and everything else in `_prepareRetry` still runs untouched: budget
 * accounting, removal of the failed assistant turn from agent state, the
 * `auto_retry_start` event, the abortable sleep (Escape still cancels), and the
 * `auto_retry_end` bookkeeping. With constant mode off, the original method runs
 * completely unmodified.
 *
 * The scaling stays exact because the target is divided and re-multiplied by the
 * same power of two. To keep `2 ** exponent` finite over very long unlimited runs,
 * `_retryAttempt` is rewound once the exponent reaches {@link MAX_EXPONENT}; our
 * own cumulative counter remains authoritative for the retry budget.
 */

/** Exponent at which `_retryAttempt` is rewound to keep `2 ** exponent` finite. */
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
 * Pure planner for one `_prepareRetry` call.
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

export interface ConstantDelayHooks {
	/** Constant interval in ms; `0` falls through to Pi's exponential backoff. */
	getConstantDelayMs(): number;
	/** Effective retry budget used for our own accounting. */
	getMaxRetries(): number;
	/** Called before the backoff sleep, with the true cumulative attempt number. */
	onRetry?(info: { attempt: number; maxRetries: number; delayMs: number; exponent: number }): void;
	/** Called when our own budget check refuses the retry. */
	onExhausted?(info: { attempt: number; maxRetries: number }): void;
}

export interface InstallResult {
	installed: boolean;
	/** Present when the patch could not be installed. */
	reason?: string;
}

type RetrySettings = { enabled: boolean; maxRetries: number; baseDelayMs: number };
type SettingsManagerLike = { getRetrySettings(): RetrySettings };
type SessionLike = {
	_retryAttempt: number;
	settingsManager: SettingsManagerLike;
};

const HOOKS_KEY = Symbol.for("kun-retry.constantDelay.hooks");
const PATCHED_KEY = Symbol.for("kun-retry.constantDelay.patched");

type GlobalWithPatch = typeof globalThis & {
	[HOOKS_KEY]?: ConstantDelayHooks | undefined;
	[PATCHED_KEY]?: boolean;
};

const CUMULATIVE = new WeakMap<object, number>();

/**
 * Patch `AgentSession.prototype._prepareRetry` once per process and point it at
 * `hooks`. Safe to call again after `/reload`: the patch is installed a single
 * time and later calls only swap the hooks, so reloading never stacks wrappers.
 */
export function installConstantDelayPatch(
	agentSessionClass: unknown,
	hooks: ConstantDelayHooks,
): InstallResult {
	const g = globalThis as GlobalWithPatch;
	g[HOOKS_KEY] = hooks;

	if (g[PATCHED_KEY]) return { installed: true };

	const proto = (agentSessionClass as { prototype?: Record<string, unknown> } | undefined)?.prototype;
	const original = proto?._prepareRetry;
	if (!proto || typeof original !== "function") {
		return {
			installed: false,
			reason: "AgentSession.prototype._prepareRetry not found; constant retry interval unavailable (Pi will use its built-in exponential backoff)",
		};
	}

	const originalFn = original as (this: unknown, message: unknown) => Promise<boolean>;

	proto._prepareRetry = async function patchedPrepareRetry(this: SessionLike, message: unknown) {
		const active = (globalThis as GlobalWithPatch)[HOOKS_KEY];
		const rawTarget = active?.getConstantDelayMs() ?? 0;
		if (!active || rawTarget <= 0) {
			return originalFn.call(this, message);
		}

		const targetMs = clampConstantDelayMs(rawTarget);
		const maxRetries = active.getMaxRetries();
		const plan = planConstantRetry(this._retryAttempt, CUMULATIVE.get(this) ?? 0, maxRetries, targetMs);

		if (plan.exhausted) {
			CUMULATIVE.set(this, plan.cumulative);
			active.onExhausted?.({ attempt: plan.cumulative, maxRetries });
			// Leave `_retryAttempt` alone: `_handlePostAgentRun` reports the final
			// failure from it, exactly as it does when Pi's own budget check refuses.
			return false;
		}

		CUMULATIVE.set(this, plan.cumulative);
		if (plan.resetRetryAttempt) this._retryAttempt = 0;
		active.onRetry?.({
			attempt: plan.cumulative,
			maxRetries,
			delayMs: targetMs,
			exponent: plan.exponent,
		});

		// Shadow `getRetrySettings` for exactly one call. `_prepareRetry` invokes it
		// synchronously as its first statement, and the shadow removes itself there,
		// so nothing else can observe the scaled `baseDelayMs`.
		const manager = this.settingsManager;
		const realGetRetrySettings = manager.getRetrySettings;
		const originalOwnDescriptor = Object.getOwnPropertyDescriptor(manager, "getRetrySettings");
		let restored = false;
		let shadowedGetRetrySettings: SettingsManagerLike["getRetrySettings"];
		const restore = () => {
			if (restored) return;
			restored = true;
			const current = Object.getOwnPropertyDescriptor(manager, "getRetrySettings");
			if (current?.value !== shadowedGetRetrySettings) return;
			if (originalOwnDescriptor) {
				Object.defineProperty(manager, "getRetrySettings", originalOwnDescriptor);
			} else {
				delete (manager as Partial<SettingsManagerLike>).getRetrySettings;
			}
		};

		shadowedGetRetrySettings = function (this: unknown) {
			const settings = realGetRetrySettings.call(this ?? manager);
			restore();
			return { ...settings, baseDelayMs: plan.scaledBaseDelayMs };
		};
		Object.defineProperty(manager, "getRetrySettings", {
			configurable: true,
			enumerable: originalOwnDescriptor?.enumerable ?? false,
			writable: true,
			value: shadowedGetRetrySettings,
		});

		try {
			return await originalFn.call(this, message);
		} finally {
			restore();
		}
	};

	g[PATCHED_KEY] = true;
	return { installed: true };
}
