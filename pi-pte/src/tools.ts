/**
 * Tool registration for pi-pte.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { PteStore } from "./store.ts";
import { formatTaskList, type TaskStatus } from "./types.ts";

const StatusEnum = StringEnum([
	"pending",
	"in_progress",
	"completed",
	"cancelled",
] as const);
const TaskMutationStatusEnum = StringEnum([
	"pending",
	"in_progress",
	"completed",
	"cancelled",
	"deleted",
] as const);

export function registerTools(
	pi: ExtensionAPI,
	store: PteStore,
	onChange: () => void,
): void {
	pi.registerTool({
		name: "update_plan",
		label: "Update Plan",
		description:
			"Replace the current task plan/checklist. Provide plan items with step text and status (pending | in_progress | completed | cancelled). At most one step may be in_progress. Use for multi-step work to show progress and approach.",
		promptSnippet: "Replace the agent checklist (full plan update)",
		promptGuidelines: [
			"Use update_plan for multi-step work (roughly 3+ steps) to show the checklist and track progress.",
			"Keep at most one update_plan step in_progress; mark steps completed as you finish them.",
			"Prefer update_plan for full checklist rewrites; use task for single-item create/update.",
		],
		parameters: Type.Object({
			explanation: Type.Optional(
				Type.String({ description: "Optional explanation for this plan update." }),
			),
			plan: Type.Array(
				Type.Object({
					step: Type.String({ description: "Task step text." }),
					status: StatusEnum,
				}),
				{ description: "The list of steps (full replace)." },
			),
		}),

		async execute(_id, params) {
			const result = store.updatePlan(
				params.plan.map((p) => ({
					step: p.step,
					status: p.status as TaskStatus,
				})),
				params.explanation,
			);
			onChange();

			if (!result.ok) {
				return {
					content: [{ type: "text" as const, text: `Error: ${result.error}` }],
					details: store.boardDetails({
						kind: "update_plan",
						explanation: params.explanation,
						error: result.error,
					}),
					isError: true,
				};
			}

			const text = [
				"Plan updated",
				params.explanation ? `Note: ${params.explanation}` : undefined,
				formatTaskList(result.tasks),
			]
				.filter(Boolean)
				.join("\n");

			return {
				content: [{ type: "text" as const, text }],
				details: store.boardDetails({
					kind: "update_plan",
					explanation: params.explanation,
				}),
			};
		},

		renderCall(args, theme) {
			const n = Array.isArray(args.plan) ? args.plan.length : 0;
			const note = args.explanation
				? theme.fg("dim", ` — ${String(args.explanation).slice(0, 60)}`)
				: "";
			return new Text(
				theme.fg("toolTitle", theme.bold("update_plan ")) +
					theme.fg("muted", `${n} step(s)`) +
					note,
				0,
				0,
			);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as ReturnType<PteStore["boardDetails"]> | undefined;
			if (result.isError) {
				const t = result.content[0];
				const msg = t?.type === "text" ? t.text : "error";
				return new Text(theme.fg("error", msg), 0, 0);
			}
			const tasks = details?.tasks ?? [];
			const head = theme.fg("success", "✓ Plan updated");
			if (tasks.length === 0) return new Text(head, 0, 0);
			const show = expanded ? tasks : tasks.slice(0, 8);
			let body = head;
			for (const t of show) {
				const mark =
					t.status === "completed"
						? theme.fg("success", "✓")
						: t.status === "in_progress"
							? theme.fg("accent", "►")
							: t.status === "cancelled"
								? theme.fg("dim", "–")
								: theme.fg("dim", "○");
				const subj =
					t.status === "completed" || t.status === "cancelled"
						? theme.fg("dim", t.subject)
						: theme.fg("muted", t.subject);
				body += `\n${mark} ${theme.fg("accent", t.id)} ${subj}`;
			}
			if (!expanded && tasks.length > 8) {
				body += `\n${theme.fg("dim", `… ${tasks.length - 8} more`)}`;
			}
			return new Text(body, 0, 0);
		},
	});

	pi.registerTool({
		name: "task",
		label: "Task",
		description:
			"Granular task board: create | update | get | list | clear. Prefer for single-item changes; use update_plan for full checklist replace.",
		promptSnippet: "Create/update/list individual tasks",
		promptGuidelines: [
			"Use task when adding or patching one item; use update_plan to replace the whole checklist.",
			"Use task with action=list or get to inspect current tasks if needed.",
		],
		parameters: Type.Object({
			action: StringEnum(["create", "update", "get", "list", "clear"] as const),
			subject: Type.Optional(
				Type.String({ description: "Short task title (create/update)" }),
			),
			description: Type.Optional(Type.String({ description: "Longer description" })),
			activeForm: Type.Optional(
				Type.String({
					description: "Present continuous UI form, e.g. 'Writing tests'",
				}),
			),
			status: Type.Optional(TaskMutationStatusEnum),
			taskId: Type.Optional(Type.String({ description: "Task id for get/update" })),
			addBlocks: Type.Optional(
				Type.Array(Type.String(), { description: "Task ids this task blocks" }),
			),
			addBlockedBy: Type.Optional(
				Type.Array(Type.String(), {
					description: "Task ids that block this task",
				}),
			),
		}),

		async execute(_id, params) {
			switch (params.action) {
				case "list": {
					const tasks = store.listTasks();
					onChange();
					return {
						content: [
							{
								type: "text" as const,
								text: tasks.length ? formatTaskList(tasks) : "No tasks",
							},
						],
						details: store.boardDetails({ kind: "task", action: "list" }),
					};
				}
				case "get": {
					if (!params.taskId) {
						return err(store, "get", "taskId required");
					}
					const t = store.getTask(params.taskId);
					if (!t) return err(store, "get", `task ${params.taskId} not found`);
					return {
						content: [{ type: "text" as const, text: JSON.stringify(t, null, 2) }],
						details: store.boardDetails({
							kind: "task",
							action: "get",
							changedIds: [t.id],
						}),
					};
				}
				case "create": {
					if (params.status === "deleted") {
						return err(store, "create", "deleted is only valid for task update");
					}
					const result = store.createTask({
						subject: params.subject ?? "",
						description: params.description,
						activeForm: params.activeForm,
						status: params.status as TaskStatus | undefined,
						blocks: params.addBlocks,
						blockedBy: params.addBlockedBy,
					});
					onChange();
					if (!result.ok) return err(store, "create", result.error);
					return {
						content: [
							{
								type: "text" as const,
								text: `Created ${result.task.id}: ${result.task.subject}`,
							},
						],
						details: store.boardDetails({
							kind: "task",
							action: "create",
							changedIds: [result.task.id],
						}),
					};
				}
				case "update": {
					if (!params.taskId) return err(store, "update", "taskId required");
					const result = store.updateTask({
						taskId: params.taskId,
						status: params.status as TaskStatus | "deleted" | undefined,
						subject: params.subject,
						description: params.description,
						activeForm: params.activeForm,
						addBlocks: params.addBlocks,
						addBlockedBy: params.addBlockedBy,
					});
					onChange();
					if (!result.ok) return err(store, "update", result.error);
					return {
						content: [
							{
								type: "text" as const,
								text: `Updated ${result.task.id} → ${result.task.status}: ${result.task.subject}`,
							},
						],
						details: store.boardDetails({
							kind: "task",
							action: "update",
							changedIds: [result.task.id],
						}),
					};
				}
				case "clear": {
					const n = store.listTasks().length;
					store.clearTasks();
					onChange();
					return {
						content: [{ type: "text" as const, text: `Cleared ${n} task(s)` }],
						details: store.boardDetails({ kind: "task", action: "clear" }),
					};
				}
				default:
					return err(store, "unknown", `Unknown action: ${params.action}`);
			}
		},

		renderCall(args, theme) {
			let text =
				theme.fg("toolTitle", theme.bold("task ")) + theme.fg("muted", args.action);
			if (args.taskId) text += ` ${theme.fg("accent", String(args.taskId))}`;
			if (args.subject)
				text += ` ${theme.fg("dim", `"${String(args.subject).slice(0, 40)}"`)}`;
			if (args.status) text += ` ${theme.fg("muted", String(args.status))}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, _opts, theme) {
			const t = result.content[0];
			const msg = t?.type === "text" ? t.text : "";
			if (result.isError) return new Text(theme.fg("error", msg), 0, 0);
			return new Text(theme.fg("success", "✓ ") + theme.fg("muted", msg), 0, 0);
		},
	});

	pi.registerTool({
		name: "plan_doc",
		label: "Plan Doc",
		description:
			"Manage a living plan document (design notes, decision log, acceptance). Actions: get | set | clear. Complements the executable checklist; does not replace it.",
		promptSnippet: "Read/write living plan markdown document",
		promptGuidelines: [
			"Use plan_doc for long-horizon design notes; use update_plan/task for the executable checklist.",
		],
		parameters: Type.Object({
			action: StringEnum(["get", "set", "clear"] as const),
			title: Type.Optional(Type.String()),
			body: Type.Optional(Type.String({ description: "Full markdown body for set" })),
		}),

		async execute(_id, params) {
			if (params.action === "get") {
				const doc = store.getState().planDoc;
				if (!doc) {
					return {
						content: [{ type: "text" as const, text: "No plan document set." }],
						details: store.boardDetails({ kind: "plan_doc", action: "get" }),
					};
				}
				return {
					content: [
						{
							type: "text" as const,
							text: `# ${doc.title ?? "Plan"}\n\n${doc.body}`,
						},
					],
					details: store.boardDetails({ kind: "plan_doc", action: "get" }),
				};
			}

			if (params.action === "clear") {
				store.setPlanDoc(undefined);
				onChange();
				return {
					content: [{ type: "text" as const, text: "Plan document cleared." }],
					details: store.boardDetails({ kind: "plan_doc", action: "clear" }),
				};
			}

			if (!params.body?.trim()) {
				return {
					content: [{ type: "text" as const, text: "Error: body required for set" }],
					details: store.boardDetails({
						kind: "plan_doc",
						action: "set",
						error: "body required",
					}),
					isError: true,
				};
			}

			store.setPlanDoc({
				title: params.title?.trim() || undefined,
				body: params.body,
				updatedAt: Date.now(),
			});
			onChange();
			return {
				content: [
					{
						type: "text" as const,
						text: `Plan document set (${params.body.length} chars)${params.title ? `: ${params.title}` : ""}`,
					},
				],
				details: store.boardDetails({ kind: "plan_doc", action: "set" }),
			};
		},
	});
}

function err(store: PteStore, action: string, message: string) {
	return {
		content: [{ type: "text" as const, text: `Error: ${message}` }],
		details: store.boardDetails({ kind: "task", action, error: message }),
		isError: true,
	};
}
