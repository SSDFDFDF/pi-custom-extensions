import {
	isContextOverflow,
	type AssistantMessage as PiAssistantMessage,
	type Usage,
} from "@earendil-works/pi-ai";
import { assistantUsageTokens, nonNegativeFiniteNumber } from "./accounting.js";
import {
	type AgentStopReason,
	type AssistantMessageLike,
	CONTRADICTORY_COMPLETION_PATTERNS,
	NON_RETRYABLE_GOAL_ERROR_RE,
	RETRYABLE_GOAL_ERROR_PATTERNS,
	USAGE_LIMIT_GOAL_ERROR_PATTERNS,
} from "./goal-types.js";
import type { ActiveGoal } from "./persistence.js";

export function isContradictoryCompletionSummary(summary: string) {
	return CONTRADICTORY_COMPLETION_PATTERNS.some((pattern) => pattern.test(summary));
}

export function goalIdRejectionReason(goal: ActiveGoal, requestedGoalId: string) {
	if (!requestedGoalId) return "missing goal_id";
	if (requestedGoalId !== goal.id) return "goal_id does not match the active goal";
	return undefined;
}

export function isUsageLimitedGoalInterruption(assistant: AssistantMessageLike) {
	const errorMessage = assistant.errorMessage;
	return (
		assistant.stopReason === "error" &&
		typeof errorMessage === "string" &&
		USAGE_LIMIT_GOAL_ERROR_PATTERNS.some((pattern) => pattern.test(errorMessage))
	);
}

export function isRetryableGoalInterruption(assistant: AssistantMessageLike) {
	if (assistant.stopReason !== "error") return false;
	if (!assistant.errorMessage) return false;
	if (
		isUsageLimitedGoalInterruption(assistant) ||
		NON_RETRYABLE_GOAL_ERROR_RE.test(assistant.errorMessage)
	) {
		return false;
	}
	return (
		isGoalContextOverflow(assistant) ||
		RETRYABLE_GOAL_ERROR_PATTERNS.some((pattern) => pattern.test(assistant.errorMessage ?? ""))
	);
}

export function isGoalContextOverflow(assistant: AssistantMessageLike) {
	return isContextOverflow(toPiAssistantMessage(assistant));
}

export function toPiAssistantMessage(assistant: AssistantMessageLike): PiAssistantMessage {
	return {
		role: "assistant",
		content: assistant.content ?? [],
		api: assistant.api ?? "openai-responses",
		provider: assistant.provider ?? "unknown",
		model: assistant.model ?? "unknown",
		usage: assistant.usage ?? zeroUsage(),
		stopReason: assistant.stopReason ?? "error",
		errorMessage: assistant.errorMessage,
		timestamp: assistant.timestamp ?? Date.now(),
	};
}

export function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
	};
}

export function findFinalAssistantMessage(messages: unknown[]): AssistantMessageLike | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!message || typeof message !== "object") continue;
		const candidate = message as AssistantMessageLike;
		if (candidate.role !== "assistant") continue;
		return {
			role: "assistant",
			stopReason: isAgentStopReason(candidate.stopReason) ? candidate.stopReason : undefined,
			errorMessage:
				typeof candidate.errorMessage === "string" ? candidate.errorMessage : undefined,
			content: candidate.content,
			api: candidate.api,
			provider: candidate.provider,
			model: typeof candidate.model === "string" ? candidate.model : undefined,
			usage: normalizeUsage(candidate.usage),
			timestamp: typeof candidate.timestamp === "number" ? candidate.timestamp : undefined,
		};
	}
	return undefined;
}

function isAgentStopReason(value: unknown): value is AgentStopReason {
	return ["stop", "length", "toolUse", "error", "aborted"].includes(String(value));
}

function normalizeUsage(value: unknown): Usage | undefined {
	if (!value || typeof value !== "object") return undefined;
	const usage = value as Partial<Usage>;
	if (typeof usage.input !== "number" || typeof usage.output !== "number") return undefined;
	return {
		input: nonNegativeFiniteNumber(usage.input),
		output: nonNegativeFiniteNumber(usage.output),
		cacheRead: nonNegativeFiniteNumber(usage.cacheRead),
		cacheWrite: nonNegativeFiniteNumber(usage.cacheWrite),
		totalTokens: assistantUsageTokens(usage),
		cost: {
			input: usage.cost?.input ?? 0,
			output: usage.cost?.output ?? 0,
			cacheRead: usage.cost?.cacheRead ?? 0,
			cacheWrite: usage.cost?.cacheWrite ?? 0,
			total: usage.cost?.total ?? 0,
		},
	};
}
