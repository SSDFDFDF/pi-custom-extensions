import type { AssistantMessage as PiAssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { ActiveGoal } from "./persistence.js";
import type { HybridGoalConfig } from "./config.js";
import type { JudgeVerdict } from "./judge.js";

export type AgentStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";
export type GoalRecoveryKind = "provider_retry" | "compaction_retry";
export type StatusTheme = { fg: (color: ThemeColor, text: string) => string };

export interface HybridGoalOptions {
	packageRoot?: string;
	config?: HybridGoalConfig;
}

export interface ContinuationTicket {
	goalId: string;
	iteration: number;
	marker: string;
	prompt: string;
}

export interface BudgetWrapUp {
	goalId: string;
	delivered: boolean;
}

export interface GoalRecovery {
	goalId: string;
	kind: GoalRecoveryKind;
}

export interface AssistantMessageLike {
	role: "assistant";
	stopReason?: AgentStopReason;
	errorMessage?: string;
	content?: PiAssistantMessage["content"];
	api?: PiAssistantMessage["api"];
	provider?: PiAssistantMessage["provider"];
	model?: string;
	usage?: Usage;
	timestamp?: number;
}

export interface StatusContext {
	cwd: string;
	ui: {
		confirm: (title: string, message: string) => Promise<boolean>;
		notify: (message: string, level?: "info" | "warning" | "error") => void;
		setStatus: (key: string, value: string | undefined) => void;
		theme?: StatusTheme;
	};
	isIdle?: () => boolean;
	hasPendingMessages?: () => boolean;
	abort?: () => void;
	sessionManager?: unknown;
	getContextUsage?: () =>
		| { tokens: number | null; contextWindow: number; percent: number | null }
		| undefined;
	compact?: (options?: {
		customInstructions?: string;
		onComplete?: (result: unknown) => void;
		onError?: (error: Error) => void;
	}) => void;
}

export interface ContextDeferral {
	goalId: string;
	percent: number;
	at: number;
	notified: boolean;
	compactRequested: boolean;
	/** Consecutive best-effort compact failures while deferred. */
	compactFailCount: number;
	/** After too many compact failures, stop re-requesting compact until cleared. */
	giveUpCompact: boolean;
}

export interface GoalRuntime {
	readonly pi: ExtensionAPI;
	readonly packageRoot: string;
	config: HybridGoalConfig;
	activeGoal?: ActiveGoal;
	continuationIntent?: ContinuationTicket;
	continuationDelivery?: ContinuationTicket;
	goalRecovery?: GoalRecovery;
	budgetWrapUp?: BudgetWrapUp;
	staleGoalToolCallsBlocked: boolean;
	cancelledContinuationMarkers: Set<string>;
	judgeRejectCount: number;
	continuationCount: number;
	lastVerdict?: JudgeVerdict;
	lastPersistedGoalSnapshot?: string;
	lastPersistedGoalAt?: number;
	goalPersistDirty: boolean;
	continuationDeferredForContext?: ContextDeferral;
}

export const STATUS_KEY = "goal";
export const GOAL_STATE_ENTRY_TYPE = "goal-state";
export const MAX_BLOCKER_REASON_LENGTH = 1_000;
export const MAX_BLOCKER_EVIDENCE_LENGTH = 4_000;
export const MAX_CANCELLED_CONTINUATION_PROMPTS = 20;
export const GOAL_USAGE_PERSIST_MIN_MS = 5_000;
export const CONTINUATION_MARKER_PREFIX = "pi-goal-continuation:";
export const BUDGET_WRAP_UP_MESSAGE_TYPE = "goal-budget-wrap-up";
export const BUDGET_WRAP_UP_PROMPT =
	"The active /goal token budget is exhausted. Stop substantive work and do not call substantive tools. Summarize progress, verified results, remaining work, and blockers concisely. Treat completion as unproven. Do not call goal_complete unless authoritative, requirement-by-requirement evidence already proves every requirement is complete. Weak, indirect, or missing evidence is not enough. Budget exhaustion is not completion.";

export const CONTRADICTORY_COMPLETION_PATTERNS = [
	/(?<!could\s)\bnot\s+(?:yet\s+)?(?:complete|completed|done|finished)\b/i,
	/\bstill\s+(?:incomplete|failing|failing\s+tests?|fails?)\b/i,
	/\btests?\s+(?:still\s+)?fail(?:ing)?\b/i,
] as const;

export const USAGE_LIMIT_GOAL_ERROR_PATTERNS = [
	/usage[_\s-]*(?:limit|cap)|chatgpt.{0,32}usage/i,
	/quota.{0,32}(?:reached|exceeded|exhausted|depleted)|(?:reached|exceeded|exhausted|depleted).{0,32}quota/i,
	/insufficient[_\s-]*(?:quota|credits?)|out of credits|out of budget|available balance|payment required/i,
	/(?:credit|balance).{0,32}(?:low|exhausted|depleted)|billing/i,
] as const;

export const NON_RETRYABLE_GOAL_ERROR_RE =
	/multi-auth rotation failed|credentials tried|unauthori[sz]ed|invalid api key/i;

export const RETRYABLE_GOAL_ERROR_PATTERNS = [
	/overloaded|rate.?limit|too many requests|\b(?:429|500|502|503|504)\b|service.?unavailable|server.?error|internal.?error/i,
	/provider.?returned.?error|you can retry your request|try your request again|please retry your request/i,
	/network.?error|connection.?(?:error|refused|lost)|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up/i,
	/timed? out|timeout|terminated|websocket.?(?:closed|error)|ended without|stream ended before message_stop|http2 request did not get a response|retry delay/i,
	/context[_\s-]*length[_\s-]*exceeded|input exceeds the context window/i,
] as const;

/** Compact lifecycle noise: keep warnings/errors, drop routine info. */
export function notifyGoal(
	ctx: Pick<StatusContext, "ui">,
	message: string,
	level: "info" | "warning" | "error" = "info",
) {
	if (level === "info") return;
	ctx.ui.notify(message, level);
}
