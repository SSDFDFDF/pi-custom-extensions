import type { Usage } from "@earendil-works/pi-ai";

/**
 * Goal token accounting.
 *
 * - Billable unit (Codex-aligned): max(0, input - cacheRead) + output
 * - tokensUsed is a **monotonic lifetime spend** for the goal: compaction may shrink
 *   the live branch total, but must not reduce tokensUsed ("no budget refill").
 * - lastAccountedBillable is a watermark on the current branch cumulative billable total.
 *   When the branch total grows, the delta is added to tokensUsed.
 *   When the branch total shrinks (compact), only the watermark resets.
 */
export interface GoalAccountingState {
	status: string;
	/** Billable cumulative on the branch when the goal started (informational / migration). */
	baselineTokens: number;
	/**
	 * Last observed billable cumulative on the current branch.
	 * Undefined on legacy snapshots; reconstructed as baselineTokens + tokensUsed.
	 */
	lastAccountedBillable?: number;
	/** Monotonic goal spend since start (never decreases on compact). */
	tokensUsed: number;
	timeUsedSeconds: number;
	activeStartedAt?: number;
	updatedAt: number;
}

interface AssistantUsageEntryLike {
	type?: unknown;
	message?: unknown;
}

interface UsageContext {
	sessionManager?: unknown;
}

export function checkpointGoalActiveTime(
	goal: GoalAccountingState,
	now: number,
	continueClock: boolean,
) {
	const accumulated = nonNegativeFiniteNumber(goal.timeUsedSeconds);
	const startedAt = goal.activeStartedAt;
	if (typeof startedAt === "number" && Number.isFinite(startedAt)) {
		goal.timeUsedSeconds = accumulated + Math.max(0, now - startedAt) / 1000;
	} else {
		goal.timeUsedSeconds = accumulated;
	}
	goal.activeStartedAt = continueClock ? now : undefined;
}

/**
 * Ensure lastAccountedBillable is set for monotonic updates.
 * Legacy goals only had baselineTokens + absolute tokensUsed ≈ total - baseline.
 */
export function ensureAccountingWatermark(goal: GoalAccountingState) {
	if (isNonNegativeFiniteNumber(goal.lastAccountedBillable)) return;
	const baseline = nonNegativeFiniteNumber(goal.baselineTokens);
	const used = nonNegativeFiniteNumber(goal.tokensUsed);
	// Reconstruct pre-compact watermark so the next delta is not double-counted.
	goal.lastAccountedBillable = Math.min(Number.MAX_SAFE_INTEGER, baseline + used);
}

/**
 * Update monotonic tokensUsed from the current session branch.
 * Compact-driven drops in branch billable only move the watermark, not tokensUsed.
 */
export function updateGoalUsage(
	goal: GoalAccountingState,
	ctx: UsageContext,
	continueClock = goal.status === "active",
) {
	const now = Date.now();
	goal.baselineTokens = nonNegativeFiniteNumber(goal.baselineTokens);
	goal.tokensUsed = nonNegativeFiniteNumber(goal.tokensUsed);
	ensureAccountingWatermark(goal);

	const total = currentTokenTotal(ctx);
	const last = nonNegativeFiniteNumber(goal.lastAccountedBillable);
	if (total > last) {
		goal.tokensUsed = Math.min(Number.MAX_SAFE_INTEGER, goal.tokensUsed + (total - last));
	}
	// Always align watermark to the live branch (grow or shrink after compact).
	goal.lastAccountedBillable = total;

	checkpointGoalActiveTime(goal, now, continueClock);
	goal.updatedAt = now;
}

export function formatDuration(seconds: number) {
	const wholeSeconds = Math.max(0, Math.floor(nonNegativeFiniteNumber(seconds)));
	if (wholeSeconds < 60) return `${wholeSeconds}s`;
	const minutes = Math.floor(wholeSeconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${minutes % 60}m`;
}

export function formatTokenCount(value: number) {
	if (value < 1_000) return `${value}`;
	if (value < 1_000_000) {
		return `${Number.isInteger(value / 1_000) ? value / 1_000 : (value / 1_000).toFixed(1)}k`;
	}
	return `${Number.isInteger(value / 1_000_000) ? value / 1_000_000 : (value / 1_000_000).toFixed(1)}m`;
}

export function isNonNegativeFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function nonNegativeFiniteNumber(value: unknown) {
	return isNonNegativeFiniteNumber(value) ? value : 0;
}

export function normalizeTokenBudget(value: unknown) {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0
		? value
		: undefined;
}

/**
 * Full context-window style token count for a usage object.
 * Prefer totalTokens when providers report it; otherwise sum all components.
 */
export function assistantUsageTokens(value: unknown) {
	if (!value || typeof value !== "object") return 0;
	const usage = value as Partial<Usage>;
	if (isNonNegativeFiniteNumber(usage.totalTokens)) return usage.totalTokens;
	return Math.min(
		Number.MAX_SAFE_INTEGER,
		nonNegativeFiniteNumber(usage.input) +
			nonNegativeFiniteNumber(usage.output) +
			nonNegativeFiniteNumber(usage.cacheRead) +
			nonNegativeFiniteNumber(usage.cacheWrite),
	);
}

/**
 * Goal-budget billable tokens for one assistant usage, Codex-aligned:
 * non-cached input + output (cache hits do not count against the goal budget).
 *
 * Formula: max(0, input - cacheRead) + output
 */
export function goalBillableUsageTokens(value: unknown) {
	if (!value || typeof value !== "object") return 0;
	const usage = value as Partial<Usage>;
	const input = nonNegativeFiniteNumber(usage.input);
	const cacheRead = nonNegativeFiniteNumber(usage.cacheRead);
	const output = nonNegativeFiniteNumber(usage.output);
	const nonCachedInput = Math.max(0, input - cacheRead);
	return Math.min(Number.MAX_SAFE_INTEGER, nonCachedInput + output);
}

export function cumulativeAssistantTokens(entries: unknown[]) {
	let total = 0;
	for (const entry of entries) {
		const candidate = entry as AssistantUsageEntryLike;
		if (candidate?.type !== "message") continue;
		const message = candidate.message as { role?: unknown; usage?: unknown } | undefined;
		if (message?.role !== "assistant") continue;
		total = Math.min(Number.MAX_SAFE_INTEGER, total + assistantUsageTokens(message.usage));
	}
	return total;
}

/** Cumulative goal-budget tokens across assistant messages on the branch. */
export function cumulativeGoalBillableTokens(entries: unknown[]) {
	let total = 0;
	for (const entry of entries) {
		const candidate = entry as AssistantUsageEntryLike;
		if (candidate?.type !== "message") continue;
		const message = candidate.message as { role?: unknown; usage?: unknown } | undefined;
		if (message?.role !== "assistant") continue;
		total = Math.min(Number.MAX_SAFE_INTEGER, total + goalBillableUsageTokens(message.usage));
	}
	return total;
}

export function currentTokenTotal(ctx: UsageContext): number {
	const sessionManager = ctx.sessionManager as { getBranch?: () => unknown[] } | undefined;
	return cumulativeGoalBillableTokens(sessionManager?.getBranch?.() ?? []);
}
