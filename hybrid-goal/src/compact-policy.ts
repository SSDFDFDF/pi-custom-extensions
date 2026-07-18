/**
 * Pure compact vs goal-budget / context-pressure policy (Codex-aligned).
 *
 * Context compaction rescues the window. Goal budget stops work.
 * Never cancel threshold/manual compact because a goal budget is exhausted.
 *
 * Note: Pi's extension API can only cancel the whole compact-and-retry unit.
 * When status is budget_limited and willRetry is true we cancel so the model is
 * not re-driven after the goal already stopped; user can still /compact manually
 * (willRetry=false) to shrink context.
 *
 * Automatic continuation is deferred when the live context window is critically
 * full (footer % from Pi). Compact success clears the deferral so work can resume.
 */

export type AfterCompactAction =
	| "budget_stop"
	| "pi_retry"
	| "continue"
	| "refresh_only";

/** Default: defer auto-continue at ≥ this context % (Pi getContextUsage). */
export const DEFAULT_CONTINUE_DEFER_CONTEXT_PERCENT = 95;

/** After this many failed best-effort compact attempts, stop auto-retrying compact. */
export const DEFAULT_MAX_COMPACT_FAILS_WHILE_DEFERRED = 2;

/** Whether to stop re-requesting compact after repeated failures. */
export function shouldGiveUpAutoCompactRetries(
	failCount: number,
	maxFails: number = DEFAULT_MAX_COMPACT_FAILS_WHILE_DEFERRED,
): boolean {
	const fails = Number.isFinite(failCount) ? Math.max(0, Math.floor(failCount)) : 0;
	const max = Number.isFinite(maxFails) ? Math.max(1, Math.floor(maxFails)) : DEFAULT_MAX_COMPACT_FAILS_WHILE_DEFERRED;
	return fails >= max;
}

/** Cancel compact only when the goal already stopped on budget and Pi would retry. */
export function shouldCancelCompactionForGoal(
	status: string,
	willRetry: boolean,
): boolean {
	return status === "budget_limited" && willRetry === true;
}

/**
 * Decision after a successful session_compact for the active goal lifecycle.
 * overBudget must be computed from monotonic tokensUsed vs tokenBudget.
 */
export function planAfterCompactAction(input: {
	status: string;
	wasPiRetry: boolean;
	overBudget: boolean;
}): AfterCompactAction {
	if (input.status !== "active") return "refresh_only";
	if (input.overBudget) return "budget_stop";
	if (input.wasPiRetry) return "pi_retry";
	return "continue";
}

export function isOverTokenBudget(
	tokensUsed: number,
	tokenBudget: number | undefined,
): boolean {
	return (
		typeof tokenBudget === "number" &&
		Number.isFinite(tokenBudget) &&
		tokenBudget > 0 &&
		tokensUsed >= tokenBudget
	);
}

/**
 * Whether auto-continuation should wait for compaction.
 * - percent null/unknown → do not defer (cannot measure; avoid permanent stall)
 * - threshold <= 0 → feature off
 * - percent >= threshold → defer
 */
export function shouldDeferContinuationForContext(input: {
	percent: number | null | undefined;
	thresholdPercent: number;
}): boolean {
	const threshold = input.thresholdPercent;
	if (!Number.isFinite(threshold) || threshold <= 0) return false;
	const percent = input.percent;
	if (percent === null || percent === undefined) return false;
	if (!Number.isFinite(percent)) return false;
	return percent >= threshold;
}

