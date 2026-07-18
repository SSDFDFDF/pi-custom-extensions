/**
 * Tool registration — board | checklist | task | board_doc
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { BteStore } from "./store.ts";
import {
	formatTaskList,
	getActiveBoard,
	getBoard,
	isListOnlyBoardToken,
	parseBoardRef,
	parseListScope,
	type TaskStatus,
} from "./types.ts";

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
	store: BteStore,
	onChange: () => void,
): void {
	// ─── board (optional multi-board) ─────────────────────────────────
	pi.registerTool({
		name: "board",
		label: "Board",
		description:
			"Optional multi-board: create | list | switch | rename | delete. Default path is task-only.",
		promptSnippet: "Optional multi-board (advanced)",
		promptGuidelines: [
			"Skip unless you need more than one checklist board.",
			"switch needs boardId; empty string clears active board.",
		],
		parameters: Type.Object({
			action: StringEnum([
				"create",
				"list",
				"switch",
				"rename",
				"delete",
			] as const),
			boardId: Type.Optional(
				Type.String({
					description:
						"Board id for switch/rename/delete. Empty string on switch clears active.",
				}),
			),
			title: Type.Optional(Type.String({ description: "Title for create/rename" })),
			activate: Type.Optional(
				Type.Boolean({ description: "create: make active (default true)" }),
			),
			deleteTasks: Type.Optional(
				Type.Boolean({
					description: "delete: also remove linked tasks (default false = detach)",
				}),
			),
		}),

		async execute(_id, params) {
			switch (params.action) {
				case "create": {
					const result = store.createBoard({
						title: params.title,
						activate: params.activate,
					});
					onChange();
					if (!result.ok) return err(store, "create", result.error, "board");
					return ok(
						`Created board ${result.board.id}: ${result.board.title}`,
						store.boardDetails({ kind: "board", action: "create" }),
					);
				}
				case "list": {
					const boards = store.listBoards();
					onChange();
					const text = boards.length
						? boards
								.map(
									(b) =>
										`${b.active ? "*" : " "} ${b.id}: ${b.title} (${b.taskCount} tasks)`,
								)
								.join("\n")
						: "No boards";
					return ok(text, store.boardDetails({ kind: "board", action: "list" }));
				}
				case "switch": {
					if (params.boardId === undefined) {
						return err(
							store,
							"switch",
							'boardId required (use "" to clear active board)',
							"board",
						);
					}
					const target = params.boardId === "" ? null : params.boardId;
					const result = store.switchBoard(target);
					onChange();
					if (!result.ok) return err(store, "switch", result.error, "board");
					return ok(
						result.activeBoardId
							? `Active board: ${result.activeBoardId}`
							: "Active board cleared (standalone task scope)",
						store.boardDetails({ kind: "board", action: "switch" }),
					);
				}
				case "rename": {
					if (!params.boardId) {
						return err(store, "rename", "boardId required", "board");
					}
					if (!params.title) {
						return err(store, "rename", "title required", "board");
					}
					const result = store.renameBoard(params.boardId, params.title);
					onChange();
					if (!result.ok) return err(store, "rename", result.error, "board");
					return ok(
						`Renamed ${result.board.id} → ${result.board.title}`,
						store.boardDetails({ kind: "board", action: "rename" }),
					);
				}
				case "delete": {
					if (!params.boardId) {
						return err(store, "delete", "boardId required", "board");
					}
					const result = store.deleteBoard(params.boardId, {
						deleteTasks: params.deleteTasks === true,
					});
					onChange();
					if (!result.ok) return err(store, "delete", result.error, "board");
					return ok(
						`Deleted board ${result.deletedId}${params.deleteTasks ? " (tasks removed)" : " (tasks detached)"}`,
						store.boardDetails({ kind: "board", action: "delete" }),
					);
				}
				default:
					return err(store, "unknown", `Unknown action: ${params.action}`, "board");
			}
		},

		renderCall(args, theme) {
			let text =
				theme.fg("toolTitle", theme.bold("board ")) + theme.fg("muted", args.action);
			if (args.boardId) text += ` ${theme.fg("accent", String(args.boardId))}`;
			if (args.title)
				text += ` ${theme.fg("dim", `"${String(args.title).slice(0, 40)}"`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, _opts, theme) {
			return renderSimple(result, theme);
		},
	});

	// ─── checklist (full replace) ─────────────────────────────────────
	pi.registerTool({
		name: "checklist",
		label: "Replace Checklist",
		description:
			"FULL REPLACE of the checklist in one scope. Omitted steps are deleted. Empty list rejected — use task clear. Prefer task for progress.",
		promptSnippet: "FULL REPLACE checklist (deletes omitted)",
		promptGuidelines: [
			"Bootstrap with task create (or one checklist); then only task update for progress.",
			"Empty items[] is an error. boardId: omit=active, bN=that board, standalone/none=standalone.",
			"Do not pass boardId='*' / 'all' on checklist — those tokens are only for task list/clear.",
		],
		parameters: Type.Object({
			explanation: Type.Optional(Type.String()),
			boardId: Type.Optional(
				Type.String({
					description:
						"Scope: omit=active/default; bN=board; empty/none/standalone=standalone. Not '*' (list/clear only).",
				}),
			),
			items: Type.Array(
				Type.Object({
					id: Type.Optional(
						Type.String({
							description: "Existing task id to keep identity on rename.",
						}),
					),
					step: Type.String(),
					status: StatusEnum,
				}),
				{
					description: "Non-empty full replace list for the scope.",
					minItems: 1,
				},
			),
		}),

		async execute(_id, params) {
			if (isListOnlyBoardToken(params.boardId)) {
				return err(
					store,
					"replace",
					'boardId "*" / "all" is only valid for task list/clear',
					"checklist",
				);
			}
			const scope =
				params.boardId === undefined
					? undefined
					: parseBoardRef(params.boardId);
			const result = store.replaceChecklist(
				params.items.map((p) => ({
					id: typeof p.id === "string" ? p.id : undefined,
					step: p.step,
					status: p.status as TaskStatus,
				})),
				params.explanation,
				scope,
			);
			onChange();
			if (!result.ok) {
				return {
					content: [{ type: "text" as const, text: `Error: ${result.error}` }],
					details: store.boardDetails({
						kind: "checklist",
						explanation: params.explanation,
						error: result.error,
					}),
					isError: true,
				};
			}
			const scopeLabel = result.scopeBoardId
				? `board ${result.scopeBoardId}`
				: "standalone";
			const removed =
				result.removedCount > 0 ? `, removed ${result.removedCount}` : "";
			const text = [
				`Checklist replaced (${scopeLabel}${removed})`,
				params.explanation ? `Note: ${params.explanation}` : undefined,
				formatTaskList(result.tasks),
			]
				.filter(Boolean)
				.join("\n");
			return {
				content: [{ type: "text" as const, text }],
				details: store.boardDetails({
					kind: "checklist",
					explanation: params.explanation,
					focusTasks: result.tasks,
					focusBoardId: result.scopeBoardId ?? null,
					removedCount: result.removedCount,
				}),
			};
		},

		renderCall(args, theme) {
			const n = Array.isArray(args.items) ? args.items.length : 0;
			const note = args.explanation
				? theme.fg("dim", ` — ${String(args.explanation).slice(0, 60)}`)
				: "";
			const scope = args.boardId
				? theme.fg("accent", ` ${String(args.boardId)}`)
				: "";
			return new Text(
				theme.fg("toolTitle", theme.bold("checklist ")) +
					theme.fg("muted", `${n} step(s)`) +
					scope +
					note,
				0,
				0,
			);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as
				| ReturnType<BteStore["boardDetails"]>
				| undefined;
			if (result.isError) {
				const t = result.content[0];
				const msg = t?.type === "text" ? t.text : "error";
				return new Text(theme.fg("error", msg), 0, 0);
			}
			const tasks =
				details?.focusTasks ??
				details?.scopedTasks ??
				[];
			const removed =
				details?.removedCount && details.removedCount > 0
					? theme.fg("dim", ` (−${details.removedCount})`)
					: "";
			const head = theme.fg("success", "✓ Checklist replaced") + removed;
			if (!tasks.length) return new Text(head, 0, 0);
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

	// ─── task (primary) ───────────────────────────────────────────────
	pi.registerTool({
		name: "task",
		label: "Task",
		description:
			"Primary checklist tool: create | update | get | list | clear. Optional boardId; list/clear boardId='*' for all.",
		promptSnippet: "Primary: create/update/list tasks",
		promptGuidelines: [
			"Default tool for progress: task update to complete/start one step.",
			"Bootstrap with task create (or one checklist); then only task update.",
			"Do not pass boardId='*' on create/update; '*' is only for list/clear.",
		],
		parameters: Type.Object({
			action: StringEnum(["create", "update", "get", "list", "clear"] as const),
			subject: Type.Optional(Type.String()),
			description: Type.Optional(Type.String()),
			activeForm: Type.Optional(Type.String()),
			status: Type.Optional(TaskMutationStatusEnum),
			taskId: Type.Optional(Type.String()),
			boardId: Type.Optional(
				Type.String({
					description:
						"create/update: board id or empty/standalone; list/clear: scope, '*'=all.",
				}),
			),
			addBlocks: Type.Optional(Type.Array(Type.String())),
			addBlockedBy: Type.Optional(Type.Array(Type.String())),
			removeBlocks: Type.Optional(Type.Array(Type.String())),
			removeBlockedBy: Type.Optional(Type.Array(Type.String())),
		}),

		async execute(_id, params) {
			switch (params.action) {
				case "list": {
					const scope = parseListScope(params.boardId);
					const tasks = store.listTasks(scope);
					onChange();
					// scopedTasks / focusTasks reflect the listed scope, not only active.
					const focusBoardId =
						scope === "*"
							? undefined
							: scope === null
								? null
								: scope !== undefined
									? scope
									: store.getState().activeBoardId ?? null;
					return ok(
						tasks.length ? formatTaskList(tasks) : "No tasks",
						store.boardDetails({
							kind: "task",
							action: "list",
							scopedTasks: tasks,
							focusTasks: tasks,
							focusBoardId: scope === "*" ? undefined : focusBoardId,
						}),
					);
				}
				case "get": {
					if (!params.taskId) return err(store, "get", "taskId required");
					const t = store.getTask(params.taskId);
					if (!t) return err(store, "get", `task ${params.taskId} not found`);
					return ok(
						JSON.stringify(t, null, 2),
						store.boardDetails({
							kind: "task",
							action: "get",
							changedIds: [t.id],
						}),
					);
				}
				case "create": {
					if (params.status === "deleted") {
						return err(store, "create", "deleted is only valid for task update");
					}
					if (isListOnlyBoardToken(params.boardId)) {
						return err(
							store,
							"create",
							'boardId "*" / "all" is only valid for task list/clear',
						);
					}
					const result = store.createTask({
						subject: params.subject ?? "",
						description: params.description,
						activeForm: params.activeForm,
						status: params.status as TaskStatus | undefined,
						boardId: parseBoardRef(params.boardId),
						blocks: params.addBlocks,
						blockedBy: params.addBlockedBy,
					});
					onChange();
					if (!result.ok) return err(store, "create", result.error);
					const link = result.task.boardId
						? ` (board ${result.task.boardId})`
						: " (standalone)";
					return ok(
						`Created ${result.task.id}: ${result.task.subject}${link}`,
						store.boardDetails({
							kind: "task",
							action: "create",
							changedIds: [result.task.id],
						}),
					);
				}
				case "update": {
					if (!params.taskId) return err(store, "update", "taskId required");
					if (isListOnlyBoardToken(params.boardId)) {
						return err(
							store,
							"update",
							'boardId "*" / "all" is only valid for task list/clear',
						);
					}
					const result = store.updateTask({
						taskId: params.taskId,
						status: params.status as TaskStatus | "deleted" | undefined,
						subject: params.subject,
						description: params.description,
						activeForm: params.activeForm,
						boardId:
							params.boardId === undefined
								? undefined
								: parseBoardRef(params.boardId),
						addBlocks: params.addBlocks,
						addBlockedBy: params.addBlockedBy,
						removeBlocks: params.removeBlocks,
						removeBlockedBy: params.removeBlockedBy,
					});
					onChange();
					if (!result.ok) return err(store, "update", result.error);
					return ok(
						`Updated ${result.task.id} → ${result.task.status}: ${result.task.subject}`,
						store.boardDetails({
							kind: "task",
							action: "update",
							changedIds: [result.task.id],
						}),
					);
				}
				case "clear": {
					const scope = parseListScope(params.boardId);
					const result = store.clearTasks({ scope });
					onChange();
					if (!result.ok) return err(store, "clear", result.error);
					return ok(
						`Cleared ${result.removed} task(s)`,
						store.boardDetails({ kind: "task", action: "clear" }),
					);
				}
				default:
					return err(store, "unknown", `Unknown action: ${params.action}`);
			}
		},

		renderCall(args, theme) {
			let text =
				theme.fg("toolTitle", theme.bold("task ")) + theme.fg("muted", args.action);
			if (args.taskId) text += ` ${theme.fg("accent", String(args.taskId))}`;
			if (args.boardId) text += ` ${theme.fg("accent", `@${String(args.boardId)}`)}`;
			if (args.subject)
				text += ` ${theme.fg("dim", `"${String(args.subject).slice(0, 40)}"`)}`;
			if (args.status) text += ` ${theme.fg("muted", String(args.status))}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, _opts, theme) {
			return renderSimple(result, theme);
		},
	});

	// ─── board_doc ────────────────────────────────────────────────────
	pi.registerTool({
		name: "board_doc",
		label: "Board Doc",
		description:
			"Optional design notes on a board (not required for checklists). get | set | clear.",
		promptSnippet: "Optional design notes",
		promptGuidelines: [
			"Skip unless you need long design notes; checklist progress uses task.",
		],
		parameters: Type.Object({
			action: StringEnum(["get", "set", "clear"] as const),
			boardId: Type.Optional(Type.String()),
			title: Type.Optional(Type.String()),
			body: Type.Optional(Type.String()),
		}),

		async execute(_id, params) {
			const boardId =
				typeof params.boardId === "string" ? params.boardId.trim() || undefined : undefined;
			const state = store.getState();
			const targetId = boardId ?? state.activeBoardId;

			if (params.action === "get") {
				if (boardId && !getBoard(state, boardId)) {
					return err(store, "get", `board ${boardId} not found`, "board_doc");
				}
				if (!targetId) {
					return ok(
						"No board selected and no document.",
						store.boardDetails({ kind: "board_doc", action: "get" }),
					);
				}
				const board = getBoard(state, targetId) ?? getActiveBoard(state);
				const doc = board?.doc;
				if (!doc) {
					return ok(
						`No document on ${targetId}.`,
						store.boardDetails({ kind: "board_doc", action: "get" }),
					);
				}
				return ok(
					`# ${doc.title ?? board?.title ?? "Board"}\n\n${doc.body}`,
					store.boardDetails({ kind: "board_doc", action: "get" }),
				);
			}

			if (params.action === "clear") {
				const result = store.setBoardDoc(undefined, boardId);
				onChange();
				if (!result.ok) {
					return {
						content: [{ type: "text" as const, text: `Error: ${result.error}` }],
						details: store.boardDetails({
							kind: "board_doc",
							action: "clear",
							error: result.error,
						}),
						isError: true,
					};
				}
				return ok(
					"Board document cleared.",
					store.boardDetails({ kind: "board_doc", action: "clear" }),
				);
			}

			if (!params.body?.trim()) {
				return {
					content: [{ type: "text" as const, text: "Error: body required for set" }],
					details: store.boardDetails({
						kind: "board_doc",
						action: "set",
						error: "body required",
					}),
					isError: true,
				};
			}

			const result = store.setBoardDoc(
				{
					title: params.title?.trim() || undefined,
					body: params.body,
					updatedAt: Date.now(),
				},
				boardId,
			);
			onChange();
			if (!result.ok) {
				return {
					content: [{ type: "text" as const, text: `Error: ${result.error}` }],
					details: store.boardDetails({
						kind: "board_doc",
						action: "set",
						error: result.error,
					}),
					isError: true,
				};
			}
			return ok(
				`Board document set (${params.body.length} chars)${params.title ? `: ${params.title}` : ""}`,
				store.boardDetails({ kind: "board_doc", action: "set" }),
			);
		},
	});
}

function ok(text: string, details: ReturnType<BteStore["boardDetails"]>) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

function err(
	store: BteStore,
	action: string,
	message: string,
	kind: "task" | "board" | "checklist" | "board_doc" = "task",
) {
	return {
		content: [{ type: "text" as const, text: `Error: ${message}` }],
		details: store.boardDetails({ kind, action, error: message }),
		isError: true,
	};
}

function renderSimple(
	result: { content: Array<{ type: string; text?: string }>; isError?: boolean },
	theme: { fg: (c: string, t: string) => string },
) {
	const t = result.content[0];
	const msg = t?.type === "text" ? (t.text ?? "") : "";
	if (result.isError) return new Text(theme.fg("error", msg), 0, 0);
	return new Text(theme.fg("success", "✓ ") + theme.fg("muted", msg), 0, 0);
}
