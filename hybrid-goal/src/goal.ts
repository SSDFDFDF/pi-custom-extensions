import { randomUUID } from "node:crypto";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	checkpointGoalActiveTime,
	currentTokenTotal,
	formatTokenCount,
	nonNegativeFiniteNumber,
	updateGoalUsage,
} from "./accounting.js";
import { completeGoalArguments, parseCommand, validateObjective } from "./command.js";
import {
	DEFAULT_MAX_COMPACT_FAILS_WHILE_DEFERRED,
	isOverTokenBudget,
	planAfterCompactAction,
	shouldCancelCompactionForGoal,
	shouldDeferContinuationForContext,
	shouldGiveUpAutoCompactRetries,
} from "./compact-policy.js";
import {
	loadConfig,
	packageRootFromUrl,
} from "./config.js";
import {
	evaluateGoalJudge,
	formatVerdictForAgent,
	shouldAllowCompletionOnJudgeError,
	type JudgeVerdict,
} from "./judge.js";
import {
	type ActiveGoal,
	clearLegacyPersistedGoal,
	type GoalStateEntryData,
	loadGoalFromSession,
} from "./persistence.js";
import {
	buildContinuePrompt,
	buildGoalPrompt,
	buildGoalSystemPrompt,
	buildObjectiveUpdatedPrompt,
	buildResumePrompt,
	type GoalStatus,
} from "./prompts.js";
import {
	findFinalAssistantMessage,
	goalIdRejectionReason,
	isContradictoryCompletionSummary,
	isGoalContextOverflow,
	isRetryableGoalInterruption,
	isUsageLimitedGoalInterruption,
} from "./goal-interruptions.js";
import {
	blocksStaleGoalToolCalls,
	formatStatus,
	goalSummary,
	isResumableGoalStatus,
	stoppedStatusLabel,
} from "./goal-status.js";
import {
	BUDGET_WRAP_UP_MESSAGE_TYPE,
	BUDGET_WRAP_UP_PROMPT,
	CONTINUATION_MARKER_PREFIX,
	GOAL_STATE_ENTRY_TYPE,
	GOAL_USAGE_PERSIST_MIN_MS,
	type GoalRuntime,
	type HybridGoalOptions,
	type StatusContext,
	MAX_BLOCKER_EVIDENCE_LENGTH,
	MAX_BLOCKER_REASON_LENGTH,
	MAX_CANCELLED_CONTINUATION_PROMPTS,
	STATUS_KEY,
	notifyGoal,
	type AssistantMessageLike,
	type ContinuationTicket,
} from "./goal-types.js";

export {
	isOverTokenBudget,
	planAfterCompactAction,
	shouldCancelCompactionForGoal,
	shouldDeferContinuationForContext,
	shouldGiveUpAutoCompactRetries,
} from "./compact-policy.js";
export {
	findFinalAssistantMessage,
	isContradictoryCompletionSummary,
	isRetryableGoalInterruption,
	isUsageLimitedGoalInterruption,
} from "./goal-interruptions.js";
export { formatStatus } from "./goal-status.js";
export type { HybridGoalOptions, StatusContext } from "./goal-types.js";

// Orchestration remains in this file: tools, commands, event hooks, continuation.
// Pure helpers live in goal-status / goal-interruptions / compact-policy / accounting.


function continuationMarker(goal: { id: string; iteration: number }) {
	return `${goal.id}:${goal.iteration}:${randomUUID()}`;
}

function escapeRegExpText(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractContinuationMarker(prompt: string) {
	const match = new RegExp(
		`<!--\\s*${escapeRegExpText(CONTINUATION_MARKER_PREFIX)}([^\\s-]+)\\s*-->`,
	).exec(prompt);
	return match?.[1];
}

function hasContinuationWork(
	goalId: string,
	intentGoalId?: string,
	deliveryGoalId?: string,
) {
	return intentGoalId === goalId || deliveryGoalId === goalId;
}

interface GoalCompleteDetails {
	goal: string;
	goal_id: string;
	summary: string;
	judge?: JudgeVerdict;
}

interface GoalBlockedDetails {
	goal: string;
	goal_id: string;
	reason: string;
	evidence: string;
	repeated_turns: number;
}

function createGoalRuntime(pi: ExtensionAPI, options?: HybridGoalOptions): GoalRuntime {
	const packageRoot = options?.packageRoot ?? packageRootFromUrl(import.meta.url);
	const config = options?.config ?? loadConfig(packageRoot);
	return {
		pi,
		packageRoot,
		config,
		staleGoalToolCallsBlocked: false,
		cancelledContinuationMarkers: new Set(),
		judgeRejectCount: 0,
		continuationCount: 0,
		goalPersistDirty: false,
		continuationDeferredForContext: undefined,
	};
}

function registerGoalRuntime(pi: ExtensionAPI, options?: HybridGoalOptions) {
	const runtime = createGoalRuntime(pi, options);

	const goalCompleteTool = defineTool({
		name: "goal_complete",
		label: "Goal Complete",
		description:
			"Mark the active /goal as complete after all required work is done and verified, using the current goal_id stale-turn guard. Do not use for partial progress, blockers, failing, or unverified work.",
		promptSnippet:
			"Mark the active /goal as complete after fully finishing and verifying it, with the current goal_id",
		promptGuidelines: [
			"When a /goal is active, keep working until the goal is complete; do not stop with only a plan or partial progress.",
			"Before calling goal_complete, audit the active goal requirement by requirement against the current files, command output, tests, or external state.",
			"Pass the exact goal_id shown in the current /goal prompt; never reuse a goal_id from an older, stopped, replaced, or cleared turn.",
			"Call goal_complete only after the requested goal is fully implemented, verified, and no known required work remains; otherwise keep working.",
			"An independent judge model reviews goal_complete claims against the transcript; weak or missing transcript evidence will reject completion and you must continue.",
		],
		parameters: Type.Object({
			goal_id: Type.String({
				description:
					"The exact goal_id shown in the current active /goal prompt. Used only to reject stale completion calls from older turns.",
			}),
			summary: Type.String({
				description:
					"State what was completed and what evidence verified it. Do not use this tool to report partial progress, blockers, failures, or remaining work.",
			}),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const completedGoal = runtime.activeGoal;
			const goal = completedGoal?.text ?? "unknown goal";
			const requestedGoalId = typeof params.goal_id === "string" ? params.goal_id.trim() : "";
			const summary = typeof params.summary === "string" ? params.summary.trim() : "";

			if (!completedGoal) {
				const rejection = "Goal completion rejected: no active goal.";
				ctx.ui.notify(rejection, "warning");

				return {
					content: [{ type: "text", text: rejection }],
					details: { goal, goal_id: requestedGoalId, summary } satisfies GoalCompleteDetails,
				};
			}

			const completingDuringBudgetWrapUp =
				completedGoal.status === "budget_limited" &&
				runtime.budgetWrapUp?.goalId === completedGoal.id &&
				runtime.budgetWrapUp.delivered;
			const staleGoalRejection = goalIdRejectionReason(completedGoal, requestedGoalId);
			if (staleGoalRejection) {
				const rejection = `Goal completion rejected: ${staleGoalRejection}.`;
				ctx.ui.notify(rejection, "warning");
				if (completingDuringBudgetWrapUp) {
					updateGoalUsage(completedGoal, ctx);
					persistGoal(completedGoal);
					updateStatus(ctx, completedGoal);
					clearBudgetWrapUp();
				}

				return {
					content: [{ type: "text", text: rejection }],
					details: { goal, goal_id: requestedGoalId, summary } satisfies GoalCompleteDetails,
					terminate: completingDuringBudgetWrapUp || undefined,
				};
			}
			if (completedGoal.status !== "active" && !completingDuringBudgetWrapUp) {
				const rejection = `Goal completion rejected: goal is ${completedGoal.status}, not active.`;
				ctx.ui.notify(rejection, "warning");

				return {
					content: [{ type: "text", text: rejection }],
					details: { goal, goal_id: requestedGoalId, summary } satisfies GoalCompleteDetails,
				};
			}

			const rejectionReason = !summary
				? "summary is empty"
				: isContradictoryCompletionSummary(summary)
					? "summary says the goal is not complete"
					: undefined;
			if (rejectionReason) {
				updateGoalUsage(completedGoal, ctx);
				persistGoal(completedGoal);
				updateStatus(ctx, completedGoal);
				const rejection = `Goal completion rejected: ${rejectionReason}.`;
				ctx.ui.notify(rejection, "warning");
				if (completingDuringBudgetWrapUp) clearBudgetWrapUp();

				return {
					content: [
						{
							type: "text",
							text: rejection,
						},
					],
					details: { goal, goal_id: requestedGoalId, summary } satisfies GoalCompleteDetails,
					terminate: completingDuringBudgetWrapUp || undefined,
				};
			}

			// --- Hybrid: independent judge gate (MiMo cold verifier) ---
			let judgeVerdict: JudgeVerdict | undefined;
			if (runtime.config.judgeEnabled) {
				ctx.ui.notify("Running independent goal judge…", "info");
				judgeVerdict = await evaluateGoalJudge({
					condition: completedGoal.text,
					summary,
					config: runtime.config,
					ctx: ctx as never,
					signal,
				});
				judgeVerdict.attempt = runtime.judgeRejectCount;
				runtime.lastVerdict = judgeVerdict;
				persistVerdict(judgeVerdict, completedGoal);

				const allow = judgeVerdict.impossible
					? false
					: judgeVerdict.error
						? shouldAllowCompletionOnJudgeError(judgeVerdict, runtime.config.judgeFailPolicy)
						: judgeVerdict.ok;

				if (!allow) {
					runtime.judgeRejectCount += 1;
					updateGoalUsage(completedGoal, ctx);
					persistGoal(completedGoal);
					updateStatus(ctx, completedGoal);

					// neverBlock: impossible verdict and maxReact caps degrade to
					// "keep working" instead of terminating the goal. Useful when
					// transient failures (network, provider) should be retried forever.
					if (judgeVerdict.impossible && !runtime.config.neverBlock) {
						cancelContinuationWork();
						clearBudgetWrapUp();
						blockStaleGoalToolCalls();
						runtime.activeGoal = transitionGoal(completedGoal, "blocked");
						persistGoal(runtime.activeGoal);
						updateStatus(ctx, runtime.activeGoal);
						const msg = formatVerdictForAgent(judgeVerdict);
						ctx.ui.notify(msg, "warning");
						return {
							content: [{ type: "text", text: msg }],
							details: {
								goal,
								goal_id: requestedGoalId,
								summary,
								judge: judgeVerdict,
							} satisfies GoalCompleteDetails,
							terminate: true,
						};
					}

					if (
						runtime.judgeRejectCount >= runtime.config.maxReact &&
						!runtime.config.neverBlock
					) {
						const msg = `Judge rejected completion and maxReact (${runtime.config.maxReact}) reached; stopping goal as blocked. Last reason: ${judgeVerdict.reason}`;
						cancelContinuationWork();
						clearBudgetWrapUp();
						blockStaleGoalToolCalls();
						runtime.activeGoal = transitionGoal(completedGoal, "blocked");
						persistGoal(runtime.activeGoal);
						updateStatus(ctx, runtime.activeGoal);
						ctx.ui.notify(msg, "warning");
						return {
							content: [{ type: "text", text: msg }],
							details: {
								goal,
								goal_id: requestedGoalId,
								summary,
								judge: judgeVerdict,
							} satisfies GoalCompleteDetails,
							terminate: true,
						};
					}

					const capNote = runtime.config.neverBlock
						? judgeVerdict.impossible
							? " (neverBlock: judge said impossible, but retrying anyway)"
							: ` (reject ${runtime.judgeRejectCount}, neverBlock: no hard cap)`
						: ` (reject ${runtime.judgeRejectCount}/${runtime.config.maxReact})`;
					const rejection = `${formatVerdictForAgent(judgeVerdict)} Keep working and gather stronger transcript evidence before calling goal_complete again.${capNote}`;
					ctx.ui.notify(rejection, "warning");
					if (completingDuringBudgetWrapUp) clearBudgetWrapUp();
					return {
						content: [{ type: "text", text: rejection }],
						details: {
							goal,
							goal_id: requestedGoalId,
							summary,
							judge: judgeVerdict,
						} satisfies GoalCompleteDetails,
					};
				}
			}

			runtime.activeGoal = transitionGoal(completedGoal, "complete");
			updateGoalUsage(runtime.activeGoal, ctx);
			persistGoal(runtime.activeGoal);

			ctx.ui.setStatus(STATUS_KEY, formatStatus(runtime.activeGoal, runtime, ctx.ui.theme));
			clearActiveGoal(ctx);
			showCompletionStatus(ctx);
			const judgeNote = judgeVerdict ? ` [judge: ${judgeVerdict.reason.slice(0, 80)}]` : "";
			ctx.ui.notify(`Goal complete: ${goal}${judgeNote}`, "info");

			return {
				content: [
					{
						type: "text",
						text: `Goal complete: ${summary}${judgeVerdict ? `\nJudge: ${judgeVerdict.reason}` : ""}`,
					},
				],
				details: {
					goal,
					goal_id: requestedGoalId,
					summary,
					judge: judgeVerdict,
				} satisfies GoalCompleteDetails,
				terminate: true,
			};
		},
	});

	const goalBlockedTool = defineTool({
		name: "goal_blocked",
		label: "Goal Blocked",
		description:
			"Stop the active /goal only at a true impasse after the same blocker recurs for at least three consecutive goal turns, with the current goal_id and concrete evidence that user or external action is required. Do not use for ordinary clarification, uncertainty, or recoverable failures.",
		promptSnippet:
			"Mark the active /goal blocked only after the same blocker recurs for three consecutive goal turns",
		promptGuidelines: [
			"Use goal_blocked only for a true impasse after the same blocker recurs for at least three consecutive goal turns and concrete evidence shows user or external action is required.",
			"After a blocked goal is resumed, start a fresh three-turn blocker audit before using goal_blocked again.",
			"Do not use goal_blocked for ordinary clarification, incomplete work, uncertainty, difficult tasks, or recoverable tool/provider failures.",
			"Pass goal_blocked the exact current goal_id; never reuse a goal_id from an older, stopped, replaced, or cleared goal turn.",
		],
		parameters: Type.Object({
			goal_id: Type.String({
				description: "The exact goal_id shown in the current active /goal prompt.",
			}),
			reason: Type.String({
				minLength: 1,
				maxLength: MAX_BLOCKER_REASON_LENGTH,
				description: "The specific user or external action required to unblock the goal.",
			}),
			evidence: Type.String({
				minLength: 1,
				maxLength: MAX_BLOCKER_EVIDENCE_LENGTH,
				description: "Concrete evidence from the repeated attempts that proves the impasse.",
			}),
			repeated_turns: Type.Integer({
				minimum: 3,
				description: "Number of separate turns spent trying to resolve this same blocker.",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const blockedGoal = runtime.activeGoal;
			const goal = blockedGoal?.text ?? "unknown goal";
			const requestedGoalId = typeof params.goal_id === "string" ? params.goal_id.trim() : "";
			const reason = typeof params.reason === "string" ? params.reason.trim() : "";
			const evidence = typeof params.evidence === "string" ? params.evidence.trim() : "";
			const repeatedTurns =
				typeof params.repeated_turns === "number" ? params.repeated_turns : Number.NaN;
			const reject = (rejectionReason: string) => {
				const rejection = `goal_blocked rejected: ${rejectionReason}.`;
				ctx.ui.notify(rejection, "warning");
				return {
					content: [{ type: "text" as const, text: rejection }],
					details: {
						goal,
						goal_id: requestedGoalId,
						reason: reason.slice(0, MAX_BLOCKER_REASON_LENGTH),
						evidence: evidence.slice(0, MAX_BLOCKER_EVIDENCE_LENGTH),
						repeated_turns: Number.isFinite(repeatedTurns) ? repeatedTurns : 0,
					} satisfies GoalBlockedDetails,
				};
			};

			if (!blockedGoal) return reject("no active goal");
			const staleGoalRejection = goalIdRejectionReason(blockedGoal, requestedGoalId);
			if (staleGoalRejection) return reject(staleGoalRejection);
			if (blockedGoal.status !== "active") {
				return reject(`goal is ${blockedGoal.status}, not active`);
			}
			if (!reason) return reject("reason is empty");
			if (reason.length > MAX_BLOCKER_REASON_LENGTH) return reject("reason is too long");
			if (!evidence) return reject("evidence is empty");
			if (evidence.length > MAX_BLOCKER_EVIDENCE_LENGTH) return reject("evidence is too long");
			if (!Number.isInteger(repeatedTurns)) return reject("repeated_turns must be a whole number");
			if (repeatedTurns < 3) return reject("repeated_turns must be at least 3");

			updateGoalUsage(blockedGoal, ctx);
			cancelContinuationWork();
			clearBudgetWrapUp();
			clearGoalRecoveryForGoal(blockedGoal.id);
			blockStaleGoalToolCalls();
			runtime.activeGoal = transitionGoal(blockedGoal, "blocked");
			persistGoal(runtime.activeGoal);
			updateStatus(ctx, runtime.activeGoal);
			ctx.ui.notify(`Goal blocked: ${truncateNotification(reason)}`, "warning");

			return {
				content: [{ type: "text", text: `Goal blocked: ${reason}` }],
				details: {
					goal,
					goal_id: requestedGoalId,
					reason,
					evidence,
					repeated_turns: repeatedTurns,
				} satisfies GoalBlockedDetails,
				terminate: true,
			};
		},
	});

	pi.registerTool(goalCompleteTool);
	pi.registerTool(goalBlockedTool);

	pi.registerCommand("goal", {
		description: "Run a goal to completion: /goal [--tokens 100k] <goal_to_complete>",
		getArgumentCompletions: completeGoalArguments,
		handler: async (args, ctx) => {
			const result = parseCommand(args);
			if (typeof result === "string") {
				ctx.ui.notify(result, "warning");
				return;
			}

			switch (result.kind) {
				case "show":
					showGoal(ctx);
					return;
				case "pause":
					pauseGoal(ctx);
					return;
				case "resume":
					await resumeGoal(runtime.pi, ctx);
					return;
				case "clear":
					clearGoal(ctx);
					return;
				case "edit":
					await editGoal(result.objective ?? "", result.tokenBudget, runtime.pi, ctx);
					return;
				case "start":
					await startGoal(result.objective ?? "", result.tokenBudget, runtime.pi, ctx);
					return;
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		clearContinuationTracking();
		clearGoalRecovery();
		clearBudgetWrapUp();
		clearStaleGoalToolCallBlock();
		runtime.activeGoal = loadGoalFromSession(ctx);
		if (runtime.activeGoal) {
			if (runtime.activeGoal.status === "active") {
				updateGoalUsage(runtime.activeGoal, ctx);
				if (limitActiveGoalForBudget(ctx, false)) return;
			}
			persistGoal(runtime.activeGoal);
			updateStatus(ctx, runtime.activeGoal);
		} else ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (runtime.activeGoal) {
			updateGoalUsage(runtime.activeGoal, ctx, false);
			persistGoal(runtime.activeGoal, { force: true });
		}
		// Drop session-scoped runtime only. Goal snapshot stays in session JSONL for resume.
		clearContinuationTracking();
		clearGoalRecovery();
		clearBudgetWrapUp();
		clearStaleGoalToolCallBlock();
		runtime.lastPersistedGoalSnapshot = undefined;
		runtime.lastPersistedGoalAt = undefined;
		runtime.goalPersistDirty = false;
		runtime.lastVerdict = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("session_before_compact", (event, ctx) => {
		// Context compaction must never be cancelled for goal token-budget reasons.
		// Budget is a work-stop signal; compact is a context-window rescue (Codex-aligned).
		const compactEvent = event as {
			reason?: unknown;
			willRetry?: unknown;
		};
		const reason =
			typeof compactEvent.reason === "string" ? compactEvent.reason : "unknown";
		const willRetry = compactEvent.willRetry === true;

		if (!runtime.activeGoal) return;

		// Always drop our own pending continuation so compact is not racing a large continue prompt.
		cancelContinuationWork();

		if (shouldCancelCompactionForGoal(runtime.activeGoal.status, willRetry)) {
			// budget_limited + overflow willRetry: do not re-drive the model after the goal stopped.
			// Threshold/manual compact (willRetry=false) remains allowed.
			notifyGoal(
				ctx,
				`Goal is budget-limited; cancelled overflow compact-and-retry (${reason}). Compact without retry is still allowed.`,
				"warning",
			);
			return { cancel: true as const };
		}

		if (runtime.activeGoal.status === "active") {
			updateGoalUsage(runtime.activeGoal, ctx);
			// Snapshot only — do not transition to budget_limited here (would previously cancel compact).
			persistGoal(runtime.activeGoal);
			updateStatus(ctx, runtime.activeGoal);
		} else {
			updateGoalUsage(runtime.activeGoal, ctx, false);
			persistGoal(runtime.activeGoal);
			updateStatus(ctx, runtime.activeGoal);
		}

		// Routine compact start is silent; warnings cover cancel/defer/budget paths.
	});

	pi.on("session_compact", (event, ctx) => {
		const compactEvent = event as { reason?: unknown; willRetry?: unknown };
		const reason =
			typeof compactEvent.reason === "string" ? compactEvent.reason : "unknown";

		if (!runtime.activeGoal) {
			clearGoalRecovery();
			return;
		}

		// Restore snapshot if present, then recompute usage after history rewrite.
		// Monotonic accounting: compact may shrink branch billable, but tokensUsed does not refill.
		const restoredGoal = loadGoalFromSession(ctx);
		if (restoredGoal?.id === runtime.activeGoal.id) {
			// Keep the higher in-memory spend if session snapshot lagged.
			const memUsed = runtime.activeGoal.tokensUsed;
			runtime.activeGoal = restoredGoal;
			if (memUsed > runtime.activeGoal.tokensUsed) {
				runtime.activeGoal.tokensUsed = memUsed;
			}
		}

		const wasPiRetry = isPiOwnedCompactionRetry(event, runtime.activeGoal.id);
		updateGoalUsage(
			runtime.activeGoal,
			ctx,
			runtime.activeGoal.status === "active",
		);

		const action = planAfterCompactAction({
			status: runtime.activeGoal.status,
			overBudget: isOverTokenBudget(
				runtime.activeGoal.tokensUsed,
				runtime.activeGoal.tokenBudget,
			),
			wasPiRetry,
		});

		// Successful compact always clears context-pressure deferral for this goal.
		clearContinuationContextDeferral(runtime.activeGoal.id);

		if (action === "budget_stop") {
			// Apply budget after compact succeeds — never cancel compact for budget.
			limitActiveGoalForBudget(ctx, false);
			clearGoalRecoveryForGoal(runtime.activeGoal.id);
			notifyGoal(
				ctx,
				`Compact finished (${reason}); goal token budget reached, no auto-continuation.`,
				"warning",
			);
			return;
		}

		persistGoal(runtime.activeGoal);
		updateStatus(ctx, runtime.activeGoal);

		if (action === "pi_retry") {
			clearGoalRecoveryForGoal(runtime.activeGoal.id);
			// Silent success: Pi owns recovery.
			return;
		}

		if (action === "continue") {
			clearGoalRecoveryForGoal(runtime.activeGoal.id);
			requestContinuation(runtime.activeGoal);
			// Manual compaction does not emit agent_settled. This common dispatcher is
			// therefore the narrow fallback; threshold compaction leaves the intent for
			// agent_settled when Pi is still busy.
			dispatchContinuationIfSettled(ctx);
			// Silent success path; status line reflects continuation counters.
			return;
		}

		// refresh_only: non-active goals — accounting/status only; never re-continue.
		clearGoalRecovery();
		// Silent refresh for non-active goals.
	});

	pi.on("input", (event) => {
		if (event.source === "extension") {
			if (consumeCancelledContinuationPrompt(event.text)) return { action: "handled" as const };
			return;
		}
		if (/^\/goal(?:\s|$)/u.test(event.text.trimStart())) return;
		clearGoalRecovery();
		clearBudgetWrapUp();
		clearStaleGoalToolCallBlock();
	});

	pi.on("context", (event) => {
		const messages = event.messages.filter((message) => keepBudgetWrapUpMessage(message));
		if (messages.length !== event.messages.length) return { messages };
	});

	pi.on("tool_call", (event, ctx) => {
		if (
			runtime.activeGoal?.status === "budget_limited" &&
			runtime.budgetWrapUp?.goalId === runtime.activeGoal.id &&
			event.toolName !== "goal_complete"
		) {
			// A blocked tool result would normally trigger another model call. Abort the
			// wrap-up instead so a tool-seeking model cannot create an unbounded loop.
			abortCurrentTurn(ctx);
			return {
				block: true,
				reason: "Goal token budget is exhausted; only goal_complete is allowed during wrap-up.",
			};
		}
		if (!runtime.staleGoalToolCallsBlocked) return;
		if (!runtime.activeGoal || !blocksStaleGoalToolCalls(runtime.activeGoal.status)) {
			clearStaleGoalToolCallBlock();
			return;
		}
		return {
			block: true,
			reason: "Blocked stale /goal tool call after the goal stopped or was interrupted.",
		};
	});

	pi.on("tool_execution_end", (_event, ctx) => {
		if (
			runtime.activeGoal?.status === "budget_limited" &&
			runtime.budgetWrapUp?.goalId === runtime.activeGoal.id &&
			!runtime.budgetWrapUp.delivered
		) {
			queueBudgetWrapUp(ctx, runtime.activeGoal);
			return;
		}
		if (runtime.activeGoal?.status !== "active") return;

		// AgentSession persists assistant message_end before tool execution events,
		// so the completed assistant call's usage is authoritative at this boundary.
		updateGoalUsage(runtime.activeGoal, ctx);
		// Usage-only snapshots are throttled — a real session showed hundreds of
		// near-duplicate goal-state entries from every tool_execution_end.
		persistGoal(runtime.activeGoal, { force: false });
		updateStatus(ctx, runtime.activeGoal);
		limitActiveGoalForBudget(ctx, true);
	});

	pi.on("before_agent_start", (event) => {
		markContinuationStarted(event.prompt);
		if (runtime.activeGoal?.status !== "active") return;

		return {
			systemPrompt: `${event.systemPrompt}\n\n${buildGoalSystemPrompt(runtime.activeGoal)}`,
		};
	});

	pi.on("agent_end", (event, ctx) => {
		if (!runtime.activeGoal) return;
		if (
			runtime.activeGoal.status === "budget_limited" &&
			runtime.budgetWrapUp?.goalId === runtime.activeGoal.id
		) {
			updateGoalUsage(runtime.activeGoal, ctx);
			persistGoal(runtime.activeGoal, { force: true });
			updateStatus(ctx, runtime.activeGoal);
			clearBudgetWrapUp();
			return;
		}
		if (runtime.activeGoal.status !== "active") return;

		const goalId = runtime.activeGoal.id;
		const alreadyAwaitingContinuation = hasContinuationWorkForGoal(goalId);
		const finalAssistant = findFinalAssistantMessage(event.messages);

		if (!alreadyAwaitingContinuation) runtime.activeGoal = incrementGoal(runtime.activeGoal);
		updateGoalUsage(runtime.activeGoal, ctx);
		// Flush any throttled usage-only writes before turn boundary decisions.
		if (runtime.goalPersistDirty) persistGoal(runtime.activeGoal, { force: true });

		if (finalAssistant?.stopReason === "aborted") {
			clearGoalRecoveryForGoal(goalId);
			stopGoalAfterAgentEnd(ctx, runtime.activeGoal, finalAssistant, "paused");
			return;
		}

		if (finalAssistant?.stopReason === "error") {
			if (isRetryableGoalInterruption(finalAssistant)) {
				if (limitActiveGoalForBudget(ctx, false)) return;
				runtime.goalRecovery = {
					goalId,
					kind: isGoalContextOverflow(finalAssistant) ? "compaction_retry" : "provider_retry",
				};
				cancelContinuationWork();
				persistGoal(runtime.activeGoal);
				updateStatus(ctx, runtime.activeGoal);
				return;
			}
			clearGoalRecoveryForGoal(goalId);
			// neverBlock: a non-retryable error would normally stop the goal as blocked.
			// Instead, keep retrying via continuation (usage limits still stop; those are
			// hard external caps, not transient failures).
			if (runtime.config.neverBlock && !isUsageLimitedGoalInterruption(finalAssistant)) {
				if (limitActiveGoalForBudget(ctx, false)) return;
				persistGoal(runtime.activeGoal);
				updateStatus(ctx, runtime.activeGoal);
				const retryGoal = runtime.activeGoal;
				if (retryGoal && retryGoal.id === goalId && retryGoal.status === "active") {
					requestContinuation(retryGoal);
					ctx.ui.notify(
						"Goal hit a non-retryable error but neverBlock is on; retrying automatically.",
						"warning",
					);
				}
				return;
			}
			stopGoalAfterAgentEnd(
				ctx,
				runtime.activeGoal,
				finalAssistant,
				isUsageLimitedGoalInterruption(finalAssistant) ? "usage_limited" : "blocked",
			);
			return;
		}

		clearGoalRecoveryForGoal(goalId);

		if (limitActiveGoalForBudget(ctx, false)) return;

		persistGoal(runtime.activeGoal);
		updateStatus(ctx, runtime.activeGoal);

		const currentGoal = runtime.activeGoal;
		if (!currentGoal || currentGoal.id !== goalId || currentGoal.status !== "active") return;
		const queued = requestContinuation(currentGoal);
		if (!queued && runtime.activeGoal?.status === "blocked") {
			updateStatus(ctx, runtime.activeGoal);
			ctx.ui.notify(
				`Goal blocked: automatic continuation hit maxContinuations (${runtime.config.maxContinuations}). Run /goal resume to retry or /goal clear.`,
				"warning",
			);
		}
	});

	pi.on("agent_settled", (_event, ctx) => {
		dispatchContinuationIfSettled(ctx);
	});

	async function startGoal(
		objective: string,
		tokenBudget: number | undefined,
		pi: ExtensionAPI,
		ctx: StatusContext,
	) {
		const validationError = validateObjective(objective);
		if (validationError) {
			ctx.ui.notify(validationError, "warning");
			return;
		}

		const existingGoal = runtime.activeGoal?.status !== "complete" ? runtime.activeGoal : undefined;
		if (existingGoal) {
			const shouldReplace = await ctx.ui.confirm(
				"Replace goal?",
				`Current goal: ${existingGoal.text}\n\nNew goal: ${objective}`,
			);
			if (!shouldReplace) {
				ctx.ui.notify(`Goal kept: ${existingGoal.text}`, "info");
				return;
			}
		}

		cancelContinuationWork();
		clearGoalRecovery();
		clearBudgetWrapUp();
		clearStaleGoalToolCallBlock();
		runtime.activeGoal = createGoal(objective, tokenBudget, currentTokenTotal(ctx));
		runtime.judgeRejectCount = 0;
		runtime.continuationCount = 0;
		runtime.lastVerdict = undefined;
		persistGoal(runtime.activeGoal);
		updateStatus(ctx, runtime.activeGoal);
		const startedGoal = runtime.activeGoal;
		const sent = await sendGoalPrompt(pi, ctx, startedGoal);
		if (!sent) {
			if (runtime.activeGoal?.id === startedGoal.id) {
				if (existingGoal) {
					updateGoalUsage(existingGoal, ctx);
					if (existingGoal.status === "active") {
						abortCurrentTurn(ctx);
						runtime.activeGoal = transitionGoal(existingGoal, "paused");
						blockStaleGoalToolCalls();
					} else {
						runtime.activeGoal = existingGoal;
						if (blocksStaleGoalToolCalls(runtime.activeGoal.status)) blockStaleGoalToolCalls();
						else clearStaleGoalToolCallBlock();
					}
					persistGoal(runtime.activeGoal);
					updateStatus(ctx, runtime.activeGoal);
				} else {
					clearActiveGoal(ctx);
				}
			}
			return;
		}
		ctx.ui.notify(
			existingGoal ? `Goal replaced: ${objective}` : `Goal started: ${objective}`,
			"info",
		);
	}

	function pauseGoal(ctx: StatusContext) {
		if (!runtime.activeGoal) {
			ctx.ui.notify("No active goal.", "info");
			return;
		}
		if (runtime.activeGoal.status !== "active") {
			ctx.ui.notify(
				`Goal is ${runtime.activeGoal.status}; only active goals can be paused.`,
				"warning",
			);
			return;
		}
		updateGoalUsage(runtime.activeGoal, ctx);
		cancelContinuationWork();
		clearBudgetWrapUp();
		blockStaleGoalToolCalls();
		abortCurrentTurn(ctx);
		runtime.activeGoal = transitionGoal(runtime.activeGoal, "paused");
		persistGoal(runtime.activeGoal);
		updateStatus(ctx, runtime.activeGoal);
		ctx.ui.notify(`Goal paused: ${runtime.activeGoal.text}`, "info");
	}

	async function resumeGoal(pi: ExtensionAPI, ctx: StatusContext) {
		if (!runtime.activeGoal) {
			ctx.ui.notify("No active goal.", "info");
			return;
		}
		if (!isResumableGoalStatus(runtime.activeGoal.status)) {
			ctx.ui.notify(
				`Goal is ${runtime.activeGoal.status}; only paused, blocked, usage-limited, or budget-limited goals can be resumed.`,
				"warning",
			);
			return;
		}
		if (
			runtime.activeGoal.tokenBudget !== undefined &&
			runtime.activeGoal.tokensUsed >= runtime.activeGoal.tokenBudget
		) {
			ctx.ui.notify(
				`Goal token budget is still reached: ${formatBudget(runtime.activeGoal)}`,
				"warning",
			);
			return;
		}
		const stoppedGoal = runtime.activeGoal;
		const stoppedStatus = stoppedGoal.status;
		cancelContinuationWork();
		clearGoalRecovery();
		clearBudgetWrapUp();
		clearStaleGoalToolCallBlock();
		runtime.activeGoal = transitionGoal(nextGoalInstance(runtime.activeGoal), "active");
		runtime.judgeRejectCount = 0;
		runtime.continuationCount = 0;
		runtime.lastVerdict = undefined;
		persistGoal(runtime.activeGoal);
		updateStatus(ctx, runtime.activeGoal);
		if (runtime.activeGoal.status !== "active") {
			ctx.ui.notify(
				`Goal token budget is still reached: ${formatBudget(runtime.activeGoal)}`,
				"warning",
			);
			return;
		}
		const resumedGoal = runtime.activeGoal;
		const sent = await sendResumePrompt(pi, ctx, resumedGoal, stoppedStatus);
		if (!sent) {
			if (runtime.activeGoal?.id === resumedGoal.id && runtime.activeGoal.status === "active") {
				runtime.activeGoal = stoppedGoal;
				persistGoal(runtime.activeGoal);
				updateStatus(ctx, runtime.activeGoal);
				if (blocksStaleGoalToolCalls(runtime.activeGoal.status)) blockStaleGoalToolCalls();
			}
			return;
		}
		ctx.ui.notify(
			`Goal resumed from ${stoppedStatusLabel(stoppedStatus)}: ${resumedGoal.text}`,
			"info",
		);
	}

	function clearGoal(ctx: StatusContext) {
		if (!runtime.activeGoal) {
			ctx.ui.notify("No active goal.", "info");
			cancelContinuationWork();
			clearGoalRecovery();
			clearBudgetWrapUp();
			clearStaleGoalToolCallBlock();
			clearPersistedGoal(ctx.cwd);
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}

		const stoppedGoal = runtime.activeGoal.text;
		clearActiveGoal(ctx);
		ctx.ui.notify(`Goal cleared: ${stoppedGoal}`, "warning");
	}

	async function editGoal(
		objective: string,
		tokenBudget: number | undefined,
		pi: ExtensionAPI,
		ctx: StatusContext,
	) {
		const validationError = validateObjective(objective);
		if (validationError) {
			ctx.ui.notify(validationError, "warning");
			return;
		}
		if (!runtime.activeGoal) {
			ctx.ui.notify("No active goal. Use /goal <objective> to start one.", "warning");
			return;
		}

		updateGoalUsage(runtime.activeGoal, ctx);
		const previousGoal = { ...runtime.activeGoal };
		cancelContinuationWork();
		clearGoalRecovery();
		clearBudgetWrapUp();
		const previousStatus = runtime.activeGoal.status;
		runtime.activeGoal = transitionGoal(
			{
				...nextGoalInstance(runtime.activeGoal),
				text: objective,
				tokenBudget: tokenBudget ?? runtime.activeGoal.tokenBudget,
			},
			editedGoalStatus(previousStatus),
		);
		persistGoal(runtime.activeGoal);
		updateStatus(ctx, runtime.activeGoal);
		const editedGoal = runtime.activeGoal;
		if (!editedGoal) return;
		if (editedGoal.status === "active") {
			clearStaleGoalToolCallBlock();
			const sent = await sendObjectiveUpdatedPrompt(pi, ctx, editedGoal);
			if (!sent) {
				if (runtime.activeGoal?.id === editedGoal.id) {
					if (previousStatus === "active") {
						abortCurrentTurn(ctx);
						runtime.activeGoal = transitionGoal(previousGoal, "paused");
						blockStaleGoalToolCalls();
					} else {
						runtime.activeGoal = previousGoal;
						if (blocksStaleGoalToolCalls(runtime.activeGoal.status)) blockStaleGoalToolCalls();
						else clearStaleGoalToolCallBlock();
					}
					persistGoal(runtime.activeGoal);
					updateStatus(ctx, runtime.activeGoal);
				}
				return;
			}
		} else if (blocksStaleGoalToolCalls(editedGoal.status)) {
			blockStaleGoalToolCalls();
		} else {
			clearStaleGoalToolCallBlock();
		}
		ctx.ui.notify(`Goal updated: ${objective}`, "info");
	}

	function showGoal(ctx: StatusContext) {
		if (!runtime.activeGoal) {
			ctx.ui.notify("Usage: /goal <objective>\nNo goal is currently set.", "info");
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		updateGoalUsage(runtime.activeGoal, ctx);
		persistGoal(runtime.activeGoal);
		updateStatus(ctx, runtime.activeGoal);
		ctx.ui.notify(goalSummary(runtime.activeGoal, runtime), "info");
	}

	function stopGoalAfterAgentEnd(
		ctx: StatusContext,
		goal: ActiveGoal,
		assistant: AssistantMessageLike,
		status: "paused" | "blocked" | "usage_limited",
	) {
		cancelContinuationWork();
		clearBudgetWrapUp();
		blockStaleGoalToolCalls();
		abortCurrentTurn(ctx);
		runtime.activeGoal = transitionGoal(goal, status);
		persistGoal(runtime.activeGoal);
		updateStatus(ctx, runtime.activeGoal);

		const details = assistant.errorMessage
			? ` (${truncateNotification(assistant.errorMessage)})`
			: "";
		if (status === "paused") {
			ctx.ui.notify(
				`Goal paused after interruption${details}. Run /goal resume to continue.`,
				"warning",
			);
			return;
		}
		if (status === "usage_limited") {
			ctx.ui.notify(
				`Goal stopped after provider usage limit${details}. Run /goal resume when usage is available.`,
				"warning",
			);
			return;
		}
		ctx.ui.notify(
			`Goal blocked after agent error${details}. Resolve the blocker or run /goal resume to retry.`,
			"warning",
		);
	}

	function requestContinuation(goal: ActiveGoal) {
		if (hasContinuationWorkForGoal(goal.id)) return false;
		const maxCont = runtime.config.maxContinuations;
		// maxContinuations of 0 means unlimited auto-continuation. neverBlock never
		// caps continuations either (used for network-flaky long runs).
		if (!runtime.config.neverBlock && maxCont > 0 && runtime.continuationCount >= maxCont) {
			// Hard cap on automatic continuations: stop auto-continuation and mark blocked.
			cancelContinuationWork();
			clearBudgetWrapUp();
			blockStaleGoalToolCalls();
			runtime.activeGoal = transitionGoal(goal, "blocked");
			persistGoal(runtime.activeGoal);
			// status updated by caller paths that have ctx
			return false;
		}
		runtime.continuationCount += 1;
		const marker = continuationMarker(goal);
		const capNote =
			maxCont > 0 && !runtime.config.neverBlock
				? `${runtime.continuationCount}/${maxCont}`
				: `${runtime.continuationCount}/∞`;
		runtime.continuationIntent = {
			goalId: goal.id,
			iteration: goal.iteration,
			marker,
			prompt: buildContinuePrompt(goal, marker) + `\n\nHybrid guard: automatic re-entry ${capNote}.`,
		};
		return true;
	}

	function clearContinuationContextDeferral(goalId?: string) {
		const deferred = runtime.continuationDeferredForContext;
		if (!deferred) return;
		if (goalId && deferred.goalId !== goalId) return;
		runtime.continuationDeferredForContext = undefined;
	}

	function readContextPercent(ctx: StatusContext): number | null {
		try {
			const usage = ctx.getContextUsage?.();
			const percent = usage?.percent;
			return typeof percent === "number" && Number.isFinite(percent) ? percent : null;
		} catch {
			return null;
		}
	}

	function noteCompactFailure(ctx: StatusContext, goalId: string, detail: string) {
		const deferred = runtime.continuationDeferredForContext;
		if (!deferred || deferred.goalId !== goalId) return;
		deferred.compactRequested = false;
		deferred.compactFailCount = (deferred.compactFailCount ?? 0) + 1;
		if (
			shouldGiveUpAutoCompactRetries(
				deferred.compactFailCount,
				DEFAULT_MAX_COMPACT_FAILS_WHILE_DEFERRED,
			)
		) {
			deferred.giveUpCompact = true;
			notifyGoal(
				ctx,
				`Goal compact failed ${deferred.compactFailCount}× while deferred (${detail}). Auto-continue stays held; run /compact manually or start a new session.`,
				"error",
			);
			return;
		}
		notifyGoal(
			ctx,
			`Goal compact failed while deferred (${detail}). Will retry on next settle (${deferred.compactFailCount}/${DEFAULT_MAX_COMPACT_FAILS_WHILE_DEFERRED}).`,
			"warning",
		);
	}

	/**
	 * If Pi reports critical context pressure, hold auto-continue and best-effort
	 * request compact (Codex-like: do not keep burning when the window is full).
	 */
	function deferContinuationIfContextCritical(ctx: StatusContext, goalId: string): boolean {
		const threshold = runtime.config.continueDeferContextPercent;
		const percent = readContextPercent(ctx);
		if (!shouldDeferContinuationForContext({ percent, thresholdPercent: threshold })) {
			// Pressure cleared without a compact event (e.g. model switch / unknown).
			if (
				runtime.continuationDeferredForContext?.goalId === goalId &&
				(percent === null || percent < threshold)
			) {
				clearContinuationContextDeferral(goalId);
			}
			return false;
		}

		const pct = percent as number;
		const existing = runtime.continuationDeferredForContext;
		if (existing?.goalId === goalId) {
			existing.percent = pct;
			existing.at = Date.now();
		} else {
			runtime.continuationDeferredForContext = {
				goalId,
				percent: pct,
				at: Date.now(),
				notified: false,
				compactRequested: false,
				compactFailCount: 0,
				giveUpCompact: false,
			};
		}

		const deferred = runtime.continuationDeferredForContext;
		if (deferred && !deferred.notified) {
			deferred.notified = true;
			notifyGoal(
				ctx,
				`Goal auto-continue deferred: context ${pct.toFixed(1)}% ≥ ${threshold}%. Waiting for compact (or run /compact).`,
				"warning",
			);
		}
		if (deferred && !deferred.compactRequested && !deferred.giveUpCompact) {
			deferred.compactRequested = true;
			try {
				ctx.compact?.({
					customInstructions:
						"Preserve the active /goal objective, verified progress, open requirements, and next steps.",
					onError: (error) => {
						noteCompactFailure(
							ctx,
							goalId,
							error instanceof Error ? error.message : String(error),
						);
					},
				});
			} catch (error) {
				noteCompactFailure(
					ctx,
					goalId,
					error instanceof Error ? error.message : String(error),
				);
			}
		}
		return true;
	}

	function dispatchContinuationIfSettled(ctx: StatusContext) {
		const intent = runtime.continuationIntent;
		if (!intent) return false;
		if (
			!runtime.activeGoal ||
			runtime.activeGoal.id !== intent.goalId ||
			runtime.activeGoal.status !== "active"
		) {
			runtime.continuationIntent = undefined;
			return false;
		}
		if (ctx.isIdle?.() !== true || hasPendingMessages(ctx)) return false;

		// Codex-aligned: do not auto-push when the live window is critically full.
		if (deferContinuationIfContextCritical(ctx, intent.goalId)) {
			return false;
		}

		runtime.continuationIntent = undefined;
		runtime.continuationDelivery = intent;
		try {
			runtime.pi.sendUserMessage(intent.prompt);
			return true;
		} catch (error) {
			if (runtime.continuationDelivery?.marker === intent.marker)
				runtime.continuationDelivery = undefined;
			if (runtime.activeGoal?.id === intent.goalId && runtime.activeGoal.status === "active") {
				runtime.continuationIntent = intent;
			}
			ctx.ui.notify(`Goal prompt failed: ${formatError(error)}`, "error");
			return false;
		}
	}

	function hasContinuationWorkForGoal(goalId: string) {
		return hasContinuationWork(
			goalId,
			runtime.continuationIntent?.goalId,
			runtime.continuationDelivery?.goalId,
		);
	}

	function updateStatus(ctx: StatusContext, goal: ActiveGoal) {
		ctx.ui.setStatus(STATUS_KEY, formatStatus(goal, runtime, ctx.ui.theme));
	}

	function persistVerdict(verdict: JudgeVerdict, goal: ActiveGoal) {
		try {
			runtime.pi.appendEntry("hybrid-goal-verdict", {
				goalId: goal.id,
				verdict,
				at: Date.now(),
			});
		} catch {
			// best-effort
		}
	}

	function blockStaleGoalToolCalls() {
		runtime.staleGoalToolCallsBlocked = true;
	}

	function clearStaleGoalToolCallBlock() {
		runtime.staleGoalToolCallsBlocked = false;
	}

	function clearGoalRecovery() {
		runtime.goalRecovery = undefined;
	}

	function clearBudgetWrapUp() {
		runtime.budgetWrapUp = undefined;
	}

	function keepBudgetWrapUpMessage(message: unknown) {
		if (!message || typeof message !== "object") return true;
		const candidate = message as {
			role?: unknown;
			customType?: unknown;
			details?: { goalId?: unknown };
		};
		if (candidate.role !== "custom" || candidate.customType !== BUDGET_WRAP_UP_MESSAGE_TYPE) {
			return true;
		}
		return (
			typeof candidate.details?.goalId === "string" &&
			candidate.details.goalId === runtime.budgetWrapUp?.goalId &&
			candidate.details.goalId === runtime.activeGoal?.id
		);
	}

	function queueBudgetWrapUp(ctx: StatusContext, goal: ActiveGoal) {
		if (!runtime.budgetWrapUp || runtime.budgetWrapUp.goalId !== goal.id) {
			runtime.budgetWrapUp = { goalId: goal.id, delivered: false };
		}
		if (runtime.budgetWrapUp.delivered) return true;
		runtime.budgetWrapUp.delivered = true;
		try {
			runtime.pi.sendMessage(
				{
					customType: BUDGET_WRAP_UP_MESSAGE_TYPE,
					content: BUDGET_WRAP_UP_PROMPT,
					display: true,
					details: { goalId: goal.id },
				},
				{ deliverAs: "steer" },
			);
			return true;
		} catch (error) {
			runtime.budgetWrapUp.delivered = false;
			ctx.ui.notify(`Goal budget wrap-up failed: ${formatError(error)}`, "error");
			return false;
		}
	}

	function limitActiveGoalForBudget(ctx: StatusContext, sendWrapUp: boolean) {
		const goal = runtime.activeGoal;
		if (
			goal?.status !== "active" ||
			goal.tokenBudget === undefined ||
			goal.tokensUsed < goal.tokenBudget
		) {
			return false;
		}

		cancelContinuationWork();
		clearGoalRecoveryForGoal(goal.id);
		clearBudgetWrapUp();
		runtime.activeGoal = transitionGoal(goal, "budget_limited");
		persistGoal(runtime.activeGoal);
		updateStatus(ctx, runtime.activeGoal);
		ctx.ui.notify(`Goal token budget reached: ${formatBudget(runtime.activeGoal)}`, "warning");
		if (sendWrapUp) queueBudgetWrapUp(ctx, runtime.activeGoal);
		return true;
	}

	function clearGoalRecoveryForGoal(goalId: string) {
		if (runtime.goalRecovery?.goalId === goalId) runtime.goalRecovery = undefined;
	}

	function isPiOwnedCompactionRetry(event: unknown, goalId: string) {
		const compaction = event as { reason?: unknown; willRetry?: unknown };
		if (compaction.willRetry === true) return true;
		return (
			runtime.goalRecovery?.goalId === goalId &&
			runtime.goalRecovery.kind === "compaction_retry" &&
			(compaction.reason === undefined || compaction.reason === "overflow")
		);
	}

	function clearContinuationTracking() {
		runtime.continuationIntent = undefined;
		runtime.continuationDelivery = undefined;
		runtime.cancelledContinuationMarkers.clear();
		runtime.continuationDeferredForContext = undefined;
	}

	function cancelContinuationWork() {
		if (runtime.continuationDelivery)
			rememberCancelledContinuationMarker(runtime.continuationDelivery.marker);
		runtime.continuationIntent = undefined;
		runtime.continuationDelivery = undefined;
	}

	function rememberCancelledContinuationMarker(marker: string) {
		runtime.cancelledContinuationMarkers.add(marker);
		if (runtime.cancelledContinuationMarkers.size <= MAX_CANCELLED_CONTINUATION_PROMPTS) return;
		const oldest = runtime.cancelledContinuationMarkers.values().next().value;
		if (oldest) runtime.cancelledContinuationMarkers.delete(oldest);
	}

	function consumeCancelledContinuationPrompt(prompt: string) {
		const marker = extractContinuationMarker(prompt);
		return marker ? runtime.cancelledContinuationMarkers.delete(marker) : false;
	}

	function markContinuationStarted(prompt: string) {
		const marker = extractContinuationMarker(prompt);
		if (!marker) {
			// A user, retry, or another extension started newer work. Cancel both an
			// unsent intent and a delivery that may have lost the non-atomic idle race;
			// the newer work's agent_end will record a fresh intent.
			cancelContinuationWork();
			return;
		}
		if (runtime.continuationDelivery?.marker === marker) runtime.continuationDelivery = undefined;
	}

	function persistGoal(goal: ActiveGoal, options?: { force?: boolean }) {
		const force = options?.force ?? true;
		const snapshot = serializeGoalPersistSnapshot(goal);
		const now = Date.now();
		if (!force) {
			if (snapshot === runtime.lastPersistedGoalSnapshot) {
				runtime.goalPersistDirty = false;
				return;
			}
			// Throttle usage accounting writes (tool_execution_end). Status / id /
			// iteration changes always use force:true (default).
			if (
				runtime.lastPersistedGoalAt !== undefined &&
				now - runtime.lastPersistedGoalAt < GOAL_USAGE_PERSIST_MIN_MS
			) {
				runtime.goalPersistDirty = true;
				return;
			}
		}
		runtime.lastPersistedGoalSnapshot = snapshot;
		runtime.lastPersistedGoalAt = now;
		runtime.goalPersistDirty = false;
		runtime.pi.appendEntry<GoalStateEntryData>(GOAL_STATE_ENTRY_TYPE, { goal });
	}

	function clearPersistedGoal(cwd: string) {
		runtime.lastPersistedGoalSnapshot = undefined;
		runtime.lastPersistedGoalAt = undefined;
		runtime.goalPersistDirty = false;
		runtime.pi.appendEntry<GoalStateEntryData>(GOAL_STATE_ENTRY_TYPE, { goal: null });
		clearLegacyPersistedGoal(cwd);
	}

	function clearActiveGoal(ctx: StatusContext) {
		cancelContinuationWork();
		clearGoalRecovery();
		clearBudgetWrapUp();
		clearStaleGoalToolCallBlock();
		runtime.activeGoal = undefined;
		runtime.judgeRejectCount = 0;
		runtime.continuationCount = 0;
		runtime.lastVerdict = undefined;
		clearPersistedGoal(ctx.cwd);
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}

	function showCompletionStatus(ctx: StatusContext) {
		// Persistent: keep the colored "goal complete" marker in the footer until the
		// next goal starts or the user clears it (no auto-clear timer).
		ctx.ui.setStatus(STATUS_KEY, formatStatus({ status: "complete" } as ActiveGoal, undefined, ctx.ui.theme));
	}
}

/** Stable enough for dedupe: ignore high-churn timeUsedSeconds alone when status/id/iteration/tokens match. */

function serializeGoalPersistSnapshot(goal: ActiveGoal): string {
	return JSON.stringify({
		id: goal.id,
		status: goal.status,
		iteration: goal.iteration,
		tokensUsed: Math.round(goal.tokensUsed),
		lastAccountedBillable:
			goal.lastAccountedBillable === undefined
				? null
				: Math.round(goal.lastAccountedBillable),
		tokenBudget: goal.tokenBudget ?? null,
		text: goal.text,
	});
}

function createGoal(
	text: string,
	tokenBudget: number | undefined,
	baselineTokens: number,
): ActiveGoal {
	const now = Date.now();
	const baseline = nonNegativeFiniteNumber(baselineTokens);
	return {
		id: randomUUID(),
		text,
		status: "active",
		startedAt: now,
		updatedAt: now,
		iteration: 0,
		tokenBudget,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		baselineTokens: baseline,
		lastAccountedBillable: baseline,
		activeStartedAt: now,
	};
}

function transitionGoal(goal: ActiveGoal, requestedStatus: GoalStatus): ActiveGoal {
	const now = Date.now();
	const status =
		requestedStatus === "active" &&
		goal.tokenBudget !== undefined &&
		goal.tokensUsed >= goal.tokenBudget
			? "budget_limited"
			: requestedStatus;
	const next = { ...goal, status, updatedAt: now };
	checkpointGoalActiveTime(next, now, status === "active");
	return next;
}

function nextGoalInstance(goal: ActiveGoal): ActiveGoal {
	return { ...goal, id: randomUUID(), updatedAt: Date.now() };
}

function editedGoalStatus(status: GoalStatus): GoalStatus {
	if (status === "paused" || status === "blocked" || status === "usage_limited") return status;
	return "active";
}

function incrementGoal(goal: ActiveGoal): ActiveGoal {
	return { ...goal, iteration: goal.iteration + 1, updatedAt: Date.now() };
}

async function sendGoalPrompt(pi: ExtensionAPI, ctx: StatusContext, goal: ActiveGoal) {
	return sendPrompt(pi, ctx, buildGoalPrompt(goal));
}

async function sendObjectiveUpdatedPrompt(pi: ExtensionAPI, ctx: StatusContext, goal: ActiveGoal) {
	return sendPrompt(pi, ctx, buildObjectiveUpdatedPrompt(goal));
}

async function sendResumePrompt(
	pi: ExtensionAPI,
	ctx: StatusContext,
	goal: ActiveGoal,
	stoppedStatus: GoalStatus,
) {
	return sendPrompt(pi, ctx, buildResumePrompt(goal, stoppedStatus));
}

async function sendPrompt(pi: ExtensionAPI, ctx: StatusContext, prompt: string) {
	try {
		const sent = ctx.isIdle?.()
			? (pi.sendUserMessage(prompt) as void | Promise<void>)
			: (pi.sendUserMessage(prompt, { deliverAs: "followUp" }) as void | Promise<void>);
		await sent;
		return true;
	} catch (error) {
		ctx.ui.notify(`Goal prompt failed: ${formatError(error)}`, "error");
		return false;
	}
}

function hasPendingMessages(ctx: StatusContext) {
	return ctx.hasPendingMessages?.() ?? false;
}

function abortCurrentTurn(ctx: StatusContext) {
	try {
		ctx.abort?.();
	} catch {
		// Best effort: stale goal guards still prevent follow-on tool calls.
	}
}

function formatError(error: unknown) {
	return truncateNotification(error instanceof Error ? error.message : String(error));
}

function truncateNotification(value: string) {
	return value.length > 160 ? `${value.slice(0, 157)}...` : value;
}

function formatBudget(goal: ActiveGoal) {
	return `${formatTokenCount(goal.tokensUsed)}/${formatTokenCount(goal.tokenBudget ?? 0)}`;
}

export default function goal(pi: ExtensionAPI, options?: HybridGoalOptions) {
	registerGoalRuntime(pi, options);
}
