import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { formatDuration, formatTokenCount } from "./accounting.js";
import type { ActiveGoal } from "./persistence.js";
import type { GoalStatus } from "./prompts.js";
import type { GoalRuntime, StatusTheme } from "./goal-types.js";

/** ◍ marker color: contrast against the status text color. */
function statusMarkerColor(baseColor: ThemeColor): ThemeColor {
	return baseColor === "success" ? "accent" : "success";
}

function formatBudget(goal: ActiveGoal) {
	return `${formatTokenCount(goal.tokensUsed)}/${formatTokenCount(goal.tokenBudget ?? 0)}`;
}

export function formatStatus(
	goal: ActiveGoal | undefined,
	runtime?: Pick<
		GoalRuntime,
		| "judgeRejectCount"
		| "continuationCount"
		| "config"
		| "lastVerdict"
		| "continuationDeferredForContext"
	>,
	theme?: StatusTheme,
) {
	if (!goal) return undefined;
	const color = (c: ThemeColor, text: string) => (theme ? theme.fg(c, text) : text);
	const prefix = (baseColor: ThemeColor) =>
		`${color(statusMarkerColor(baseColor), "◍")} ${color(baseColor, "goal")}`;
	if (goal.status === "complete") {
		return `${prefix("success")} ${color("success", "complete")}`;
	}
	let base: string;
	let baseColor: ThemeColor;
	if (goal.status === "paused") {
		base = "paused";
		baseColor = "warning";
	} else if (goal.status === "blocked") {
		base = "blocked";
		baseColor = "error";
	} else if (goal.status === "usage_limited") {
		base = "usage";
		baseColor = "warning";
	} else if (goal.status === "budget_limited") {
		base = `budget ${formatBudget(goal)}`;
		baseColor = "warning";
	} else if (goal.tokenBudget !== undefined) {
		base = `active ${formatBudget(goal)}`;
		baseColor = "accent";
	} else {
		base = `active ${formatDuration(goal.timeUsedSeconds)}`;
		baseColor = "accent";
	}
	const head = prefix(baseColor);
	if (!runtime) return `${head} ${color(baseColor, base)}`;
	const contCap =
		runtime.config.neverBlock || runtime.config.maxContinuations <= 0
			? "∞"
			: String(runtime.config.maxContinuations);
	const rejectCap = runtime.config.neverBlock ? "∞" : String(runtime.config.maxReact);
	const bits = [`${head} ${color(baseColor, base)}`, color("muted", `c${runtime.continuationCount}/${contCap}`)];
	if (runtime.judgeRejectCount > 0)
		bits.push(color("warning", `x${runtime.judgeRejectCount}/${rejectCap}`));
	if (
		runtime.continuationDeferredForContext &&
		runtime.continuationDeferredForContext.goalId === goal.id
	) {
		const pct = runtime.continuationDeferredForContext.percent;
		bits.push(color("warning", `defer:ctx ${pct.toFixed(0)}%`));
	}
	if (runtime.config.neverBlock) bits.push(color("muted", "nb"));
	if (!runtime.config.judgeEnabled) bits.push(color("dim", "j:off"));
	else if (runtime.lastVerdict?.error) bits.push(color("error", "j:err"));
	else if (runtime.lastVerdict?.impossible) bits.push(color("error", "j:imp"));
	else if (runtime.lastVerdict?.ok) bits.push(color("success", "j:ok"));
	else if (runtime.lastVerdict) bits.push(color("warning", "j:no"));
	return bits.join(" ");
}

export function goalSummary(goal: ActiveGoal, runtime?: GoalRuntime) {
	const lines = [
		`Goal: ${goal.text}`,
		`Status: ${goal.status}`,
		`Iteration: ${goal.iteration}`,
		`Active elapsed: ${formatDuration(goal.timeUsedSeconds)}`,
		`Tokens: ${goal.tokenBudget === undefined ? formatTokenCount(goal.tokensUsed) : formatBudget(goal)}`,
	];
	if (runtime) {
		const contCap =
			runtime.config.neverBlock || runtime.config.maxContinuations <= 0
				? "∞"
				: String(runtime.config.maxContinuations);
		const rejectCap = runtime.config.neverBlock ? "∞" : String(runtime.config.maxReact);
		lines.push(`Continuations: ${runtime.continuationCount}/${contCap}`);
		lines.push(`Judge rejects: ${runtime.judgeRejectCount}/${rejectCap}`);
		if (runtime.continuationDeferredForContext?.goalId === goal.id) {
			lines.push(
				`Context deferral: ${runtime.continuationDeferredForContext.percent.toFixed(1)}% (waiting for compact)`,
			);
		}
		if (runtime.config.neverBlock) lines.push("Never-block: on (retries instead of blocking)");
		lines.push(`Judge: ${runtime.config.judgeEnabled ? "on" : "off"} (${runtime.config.judgeFailPolicy})`);
		if (runtime.lastVerdict) {
			lines.push(
				`Last judge: ${runtime.lastVerdict.ok ? "ok" : runtime.lastVerdict.impossible ? "impossible" : "rejected"}${runtime.lastVerdict.error ? " (error)" : ""} — ${runtime.lastVerdict.reason.slice(0, 200)}`,
			);
		}
	}
	lines.push(`Commands: ${goalCommandHint(goal.status)}`);
	return lines.join("\n");
}

export function goalCommandHint(status: GoalStatus) {
	if (status === "active") return "/goal edit <objective>, /goal pause, /goal clear";
	if (isResumableGoalStatus(status)) {
		return "/goal edit <objective>, /goal resume, /goal clear";
	}
	return "/goal edit <objective>, /goal clear";
}

export function blocksStaleGoalToolCalls(status: GoalStatus) {
	return status === "paused" || status === "blocked" || status === "usage_limited";
}

export function isResumableGoalStatus(status: GoalStatus) {
	return blocksStaleGoalToolCalls(status) || status === "budget_limited";
}

export function stoppedStatusLabel(status: GoalStatus) {
	if (status === "usage_limited") return "usage-limited";
	if (status === "budget_limited") return "budget-limited";
	return status;
}

export { formatBudget };
