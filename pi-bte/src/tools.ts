/**
 * Tool registration — board | task | board_doc
 * task writes are items[]-only: create | update | replace
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
	type Task,
} from "./types.ts";
import {
	normalizeCreateItems,
	normalizeReplaceItems,
	normalizeUpdateItems,
} from "./task-params.ts";

const StatusEnum = StringEnum([
	"pending",
	"in_progress",
	"completed",
	"cancelled",
] as const);

const MutationStatusEnum = StringEnum([
	"pending",
	"in_progress",
	"completed",
	"cancelled",
	"deleted",
] as const);

/** create items: subject required; do not pass taskId. */
const CreateItemSchema = Type.Object({
	subject: Type.String({
		minLength: 1,
		description: "create/replace: task title. Not used alone on update (need taskId).",
	}),
	description: Type.Optional(Type.String()),
	activeForm: Type.Optional(Type.String()),
	status: Type.Optional(StatusEnum),
	blocks: Type.Optional(Type.Array(Type.String())),
	blockedBy: Type.Optional(Type.Array(Type.String())),
});

/** update items: taskId required; patch fields optional. */
const UpdateItemSchema = Type.Object({
	taskId: Type.String({
		minLength: 1,
		description: "update only: existing task id to patch.",
	}),
	status: Type.Optional(MutationStatusEnum),
	subject: Type.Optional(Type.String()),
	description: Type.Optional(Type.String()),
	activeForm: Type.Optional(Type.String()),
	boardId: Type.Optional(
		Type.String({
			description: "update only: move task to board id or empty/standalone.",
		}),
	),
	addBlocks: Type.Optional(Type.Array(Type.String())),
	addBlockedBy: Type.Optional(Type.Array(Type.String())),
	removeBlocks: Type.Optional(Type.Array(Type.String())),
	removeBlockedBy: Type.Optional(Type.Array(Type.String())),
});

/** replace items: subject+status required; optional id keeps identity. */
const ReplaceItemSchema = Type.Object({
	subject: Type.String({ minLength: 1 }),
	status: StatusEnum,
	id: Type.Optional(
		Type.String({
			description: "replace only: existing task id to keep identity on rename.",
		}),
	),
	description: Type.Optional(Type.String()),
	activeForm: Type.Optional(Type.String()),
	blocks: Type.Optional(Type.Array(Type.String())),
	blockedBy: Type.Optional(Type.Array(Type.String())),
});

/**
 * Shared items array (union). Runtime normalizers enforce the shape for each action:
 * - create: subject (+ optional status/deps); no taskId
 * - update: taskId (+ patch fields); no bare create-only rows
 * - replace: subject + status (+ optional id)
 */
const ItemsSchema = Type.Optional(
	Type.Array(Type.Union([CreateItemSchema, UpdateItemSchema, ReplaceItemSchema]), {
		description:
			"Required for create/update/replace (min 1). create=[{subject,…}]; update=[{taskId,…}]; replace=[{subject,status,id?,…}]. Do not mix shapes in one call.",
		minItems: 1,
	}),
);

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
			"Skip unless you need more than one task board.",
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
					if (!result.ok) return err(store, "create", result.error, "board");
					onChange();
					return ok(
						`Created board ${result.board.id}: ${result.board.title}`,
						store.boardDetails({ kind: "board", action: "create" }),
					);
				}
				case "list": {
					const boards = store.listBoards();
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
					if (!result.ok) return err(store, "switch", result.error, "board");
					onChange();
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
					if (!result.ok) return err(store, "rename", result.error, "board");
					onChange();
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
					if (!result.ok) return err(store, "delete", result.error, "board");
					onChange();
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

	// ─── task (primary, items[] writes) ───────────────────────────────
	pi.registerTool({
		name: "task",
		label: "Task",
		description:
			"Task tool: create | update | replace | get | list | clear. create/update/replace use items[] only (length 1 = single). create=append, update=patch by id (omitted kept), replace=full scope snapshot (omitted deleted).",
		promptSnippet: "Primary: items[] create/update/replace + list",
		promptGuidelines: [
			"create/update/replace always use items[] — never parallel single-field forms.",
			"create = append only (items need subject); update = patch by taskId (safe); replace = full rewrite (subject+status; omitted deleted).",
			"Do not mix create rows (subject) with update rows (taskId) in one items[] call.",
			"Bootstrap with create items[] (or one replace); progress with update items[].",
			"Do not pass boardId='*' on create/update/replace; '*' is only for list/clear.",
		],
		parameters: Type.Object({
			action: StringEnum([
				"create",
				"update",
				"replace",
				"get",
				"list",
				"clear",
			] as const),
			items: ItemsSchema,
			taskIds: Type.Optional(
				Type.Array(Type.String(), {
					description: "get: one or more task ids.",
					minItems: 1,
				}),
			),
			boardId: Type.Optional(
				Type.String({
					description:
						"create/replace: target scope (board id or empty/standalone). list/clear: scope, '*'=all. Not for update (use item.boardId to move).",
				}),
			),
			explanation: Type.Optional(
				Type.String({
					description: "replace only: optional scope note.",
				}),
			),
		}),

		async execute(_id, params) {
			switch (params.action) {
				case "list": {
					const scope = parseListScope(params.boardId);
					const tasks = store.listTasks(scope);
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
					const ids = (params.taskIds ?? [])
						.map((id) => String(id).trim())
						.filter(Boolean);
					if (!ids.length) {
						return err(store, "get", "taskIds required (non-empty array)");
					}
					const found: Task[] = [];
					for (const id of ids) {
						const t = store.getTask(id);
						if (!t) return err(store, "get", `task ${id} not found`);
						found.push(t);
					}
					return ok(
						JSON.stringify(found.length === 1 ? found[0] : found, null, 2),
						store.boardDetails({
							kind: "task",
							action: "get",
							changedIds: found.map((t) => t.id),
							focusTasks: found,
						}),
					);
				}
				case "create": {
					if (isListOnlyBoardToken(params.boardId)) {
						return err(
							store,
							"create",
							'boardId "*" / "all" is only valid for task list/clear',
						);
					}
					const items = normalizeCreateItems(params.items);
					if (!items.ok) return err(store, "create", items.error);
					const result = store.createTasks({
						items: items.value,
						boardId: parseBoardRef(params.boardId),
					});
					if (!result.ok) return err(store, "create", result.error);
					onChange();
					const link =
						result.tasks[0]?.boardId
							? ` (board ${result.tasks[0].boardId})`
							: " (standalone)";
					const summary = result.tasks
						.map((t) => `${t.id}: ${t.subject}`)
						.join("; ");
					return ok(
						`Created ${result.tasks.length} task(s)${link}: ${summary}`,
						store.boardDetails({
							kind: "task",
							action: "create",
							changedIds: result.tasks.map((t) => t.id),
							focusTasks: result.tasks,
							focusBoardId: result.tasks[0]?.boardId ?? null,
						}),
					);
				}
				case "update": {
					const items = normalizeUpdateItems(params.items);
					if (!items.ok) return err(store, "update", items.error);
					for (const it of items.value) {
						if (isListOnlyBoardToken(it.boardId)) {
							return err(
								store,
								"update",
								'boardId "*" / "all" is only valid for task list/clear',
							);
						}
					}
					const result = store.updateTasks({
						items: items.value.map((it) => ({
							...it,
							boardId:
								it.boardId === undefined ? undefined : parseBoardRef(it.boardId),
						})),
					});
					if (!result.ok) return err(store, "update", result.error);
					onChange();
					const summary = result.tasks
						.map((t) => `${t.id}→${t.status}: ${t.subject}`)
						.join("; ");
					return ok(
						`Updated ${result.tasks.length} task(s): ${summary}`,
						store.boardDetails({
							kind: "task",
							action: "update",
							changedIds: result.tasks.map((t) => t.id),
							focusTasks: result.tasks,
						}),
					);
				}
				case "replace": {
					if (isListOnlyBoardToken(params.boardId)) {
						return err(
							store,
							"replace",
							'boardId "*" / "all" is only valid for task list/clear',
						);
					}
					const items = normalizeReplaceItems(params.items);
					if (!items.ok) return err(store, "replace", items.error);
					const scope =
						params.boardId === undefined
							? undefined
							: parseBoardRef(params.boardId);
					const result = store.replaceTasks(
						items.value,
						params.explanation,
						scope,
					);
					if (!result.ok) {
						return {
							content: [{ type: "text" as const, text: `Error: ${result.error}` }],
							details: store.boardDetails({
								kind: "task",
								action: "replace",
								explanation: params.explanation,
								error: result.error,
							}),
							isError: true,
						};
					}
					onChange();
					const scopeLabel = result.scopeBoardId
						? `board ${result.scopeBoardId}`
						: "standalone";
					const removed =
						result.removedCount > 0 ? `, removed ${result.removedCount}` : "";
					const text = [
						`Replaced scope (${scopeLabel}${removed})`,
						params.explanation ? `Note: ${params.explanation}` : undefined,
						formatTaskList(result.tasks),
					]
						.filter(Boolean)
						.join("\n");
					return {
						content: [{ type: "text" as const, text }],
						details: store.boardDetails({
							kind: "task",
							action: "replace",
							explanation: params.explanation,
							focusTasks: result.tasks,
							focusBoardId: result.scopeBoardId ?? null,
							removedCount: result.removedCount,
							changedIds: result.tasks.map((t) => t.id),
						}),
					};
				}
				case "clear": {
					const scope = parseListScope(params.boardId);
					const result = store.clearTasks({ scope });
					if (!result.ok) return err(store, "clear", result.error);
					onChange();
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
			if (args.boardId) text += ` ${theme.fg("accent", `@${String(args.boardId)}`)}`;
			const n = Array.isArray(args.items) ? args.items.length : 0;
			if (n > 0) text += ` ${theme.fg("dim", `${n} item(s)`)}`;
			const ids = Array.isArray(args.taskIds) ? args.taskIds.length : 0;
			if (ids > 0) text += ` ${theme.fg("accent", `${ids} id(s)`)}`;
			if (args.explanation)
				text += theme.fg("dim", ` — ${String(args.explanation).slice(0, 40)}`);
			return new Text(text, 0, 0);
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
			if (details?.action === "replace" && details.focusTasks?.length) {
				const tasks = details.focusTasks;
				const removed =
					details.removedCount && details.removedCount > 0
						? theme.fg("dim", ` (−${details.removedCount})`)
						: "";
				const head = theme.fg("success", "✓ Replaced") + removed;
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
			}
			return renderSimple(result, theme);
		},
	});

	// ─── board_doc ────────────────────────────────────────────────────
	pi.registerTool({
		name: "board_doc",
		label: "Board Doc",
		description:
			"Optional design notes on a board. get | set | clear.",
		promptSnippet: "Optional design notes",
		promptGuidelines: [
			"Skip unless you need long design notes; task progress uses the task tool.",
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
				onChange();
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
			onChange();
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
	kind: "task" | "board" | "board_doc" = "task",
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
