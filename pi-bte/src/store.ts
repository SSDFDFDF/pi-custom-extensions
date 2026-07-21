/**
 * pi-bte store — boards + flat tasks (optional boardId).
 * Task writes are items[]-only: createTasks | updateTasks.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type Board,
	type BoardDetails,
	type BoardDoc,
	type BteState,
	type Task,
	type TaskStatus,
	BTE_STATE_ENTRY,
	cloneBoard,
	cloneState,
	cloneTask,
	emptyState,
	getActiveBoard,
	getBoard,
	isTaskStatus,
	tasksInScope,
} from "./types.ts";
import {
	applyTaskPatch,
	coerceState,
	deleteTaskFromWorking,
	enforceOneInProgressPerScope,
	normalizeIdList,
	normalizeSequence,
	normalizeState,
	pruneIds,
	repairInProgressForScope,
	validateDependencyIds,
	validateUpdateBatch,
} from "./store-helpers.ts";

type PersistFn = (customType: string, data: unknown) => void;

const BOARD_TOOL_NAMES = new Set(["board", "task", "board_doc"]);

export class BteStore {
	private state: BteState = emptyState();
	private persistFn?: PersistFn;
	private lastPersistedSnapshot?: string;

	setPersist(fn: PersistFn | undefined): void {
		this.persistFn = fn;
	}

	resetRuntimeCaches(): void {
		this.lastPersistedSnapshot = undefined;
	}

	/** Public read API — always a deep clone so callers cannot mutate store memory. */
	getState(): BteState {
		return cloneState(this.state);
	}

	// ─── Boards ───────────────────────────────────────────────────────

	createBoard(input?: {
		title?: string;
		activate?: boolean;
	}): { ok: true; board: Board } | { ok: false; error: string } {
		const now = Date.now();
		const title = input?.title?.trim() || `Board ${this.state.nextBoardSeq}`;
		const board: Board = {
			id: this.allocBoardId(),
			title,
			createdAt: now,
			updatedAt: now,
		};
		this.state.boards.push(board);
		// Honor activate strictly: false never steals focus; default true activates.
		if (input?.activate !== false) {
			this.state.activeBoardId = board.id;
		}
		this.touch();
		this.persist();
		return { ok: true, board: cloneBoard(board) };
	}

	listBoards(): Array<Board & { active: boolean; taskCount: number }> {
		return this.state.boards.map((b) => ({
			...cloneBoard(b),
			active: b.id === this.state.activeBoardId,
			taskCount: this.state.tasks.filter((t) => t.boardId === b.id).length,
		}));
	}

	switchBoard(
		boardId: string | null,
	): { ok: true; activeBoardId?: string } | { ok: false; error: string } {
		if (boardId === null || boardId === "") {
			this.state.activeBoardId = undefined;
			this.touch();
			this.persist();
			return { ok: true, activeBoardId: undefined };
		}
		if (!getBoard(this.state, boardId)) {
			return { ok: false, error: `board ${boardId} not found` };
		}
		this.state.activeBoardId = boardId;
		this.touch();
		this.persist();
		return { ok: true, activeBoardId: boardId };
	}

	renameBoard(
		boardId: string,
		title: string,
	): { ok: true; board: Board } | { ok: false; error: string } {
		const board = getBoard(this.state, boardId);
		if (!board) return { ok: false, error: `board ${boardId} not found` };
		const next = title.trim();
		if (!next) return { ok: false, error: "title cannot be empty" };
		board.title = next;
		board.updatedAt = Date.now();
		this.touch();
		this.persist();
		return { ok: true, board: cloneBoard(board) };
	}

	deleteBoard(
		boardId: string,
		options?: { deleteTasks?: boolean },
	): { ok: true; deletedId: string } | { ok: false; error: string } {
		const idx = this.state.boards.findIndex((b) => b.id === boardId);
		if (idx < 0) return { ok: false, error: `board ${boardId} not found` };

		if (options?.deleteTasks) {
			this.state.tasks = this.state.tasks.filter((t) => t.boardId !== boardId);
		} else {
			for (const t of this.state.tasks) {
				if (t.boardId === boardId) {
					t.boardId = undefined;
					t.updatedAt = Date.now();
				}
			}
			repairInProgressForScope(this.state.tasks, undefined);
		}

		this.state.boards.splice(idx, 1);
		if (this.state.activeBoardId === boardId) {
			this.state.activeBoardId = this.state.boards[0]?.id;
		}
		this.touch();
		this.persist();
		return { ok: true, deletedId: boardId };
	}

	setBoardDoc(
		doc: BoardDoc | undefined,
		boardId?: string,
	): { ok: true } | { ok: false; error: string } {
		const id = boardId ?? this.state.activeBoardId;
		if (!id) {
			return {
				ok: false,
				error: "No board selected. Create/switch a board or pass boardId.",
			};
		}
		const board = getBoard(this.state, id);
		if (!board) return { ok: false, error: `board ${id} not found` };
		board.doc = doc;
		board.updatedAt = Date.now();
		this.touch();
		this.persist();
		return { ok: true };
	}

	// ─── Tasks (items[] only) ─────────────────────────────────────────

	/**
	 * Append one or more tasks (never deletes).
	 * boardId: undefined=active, null=standalone, string=board.
	 * Dependencies may only reference already-existing task ids (not same-batch).
	 */
	createTasks(input: {
		items: Array<{
			subject: string;
			description?: string;
			activeForm?: string;
			status?: TaskStatus;
			blocks?: string[];
			blockedBy?: string[];
			metadata?: Record<string, unknown>;
		}>;
		boardId?: string | null;
	}): { ok: true; tasks: Task[] } | { ok: false; error: string } {
		const items = input.items ?? [];
		if (!items.length) {
			return { ok: false, error: "items must be non-empty" };
		}

		const boardId = this.resolveAssociation(input.boardId);
		if (boardId.error) return { ok: false, error: boardId.error };
		const bid = boardId.boardId;

		const scopeTasks = this.state.tasks.filter((t) =>
			bid ? t.boardId === bid : !t.boardId,
		);
		const knownIds = new Set(scopeTasks.map((t) => t.id));
		let inProgressCount = scopeTasks.filter((t) => t.status === "in_progress").length;

		const now = Date.now();
		const created: Task[] = [];

		for (let i = 0; i < items.length; i++) {
			const raw = items[i];
			const subject = raw.subject?.trim();
			if (!subject) {
				return { ok: false, error: `items[${i}]: subject is required` };
			}
			const status = raw.status ?? "pending";
			if (!isTaskStatus(status)) {
				return { ok: false, error: `items[${i}]: invalid status: ${status}` };
			}
			if (status === "in_progress") {
				inProgressCount += 1;
				if (inProgressCount > 1) {
					const where = bid ? `board ${bid}` : "standalone tasks";
					return {
						ok: false,
						error: `Only one task may be in_progress in ${where}.`,
					};
				}
			}
			const blocks = normalizeIdList(raw.blocks);
			const blockedBy = normalizeIdList(raw.blockedBy);
			const dependencyError = validateDependencyIds(
				[...(blocks ?? []), ...(blockedBy ?? [])],
				knownIds,
			);
			if (dependencyError) {
				return { ok: false, error: `items[${i}]: ${dependencyError}` };
			}
			created.push({
				id: this.allocTaskId(),
				subject,
				description: raw.description?.trim() || undefined,
				status,
				activeForm: raw.activeForm?.trim() || undefined,
				boardId: bid,
				blocks,
				blockedBy,
				metadata: raw.metadata ? { ...raw.metadata } : undefined,
				createdAt: now,
				updatedAt: now,
			});
		}

		this.state.tasks.push(...created);
		this.touch();
		this.persist();
		return { ok: true, tasks: created.map(cloneTask) };
	}

	/**
	 * Patch one or more existing tasks by id. Omitted tasks are left alone.
	 * status "deleted" removes the task. All-or-nothing.
	 */
	updateTasks(input: {
		items: Array<TaskUpdateItem>;
	}): { ok: true; tasks: Task[] } | { ok: false; error: string } {
		const items = input.items ?? [];
		if (!items.length) {
			return { ok: false, error: "items must be non-empty" };
		}

		const pre = validateUpdateBatch(items, this.state.tasks);
		if (!pre.ok) return pre;

		// Work on clones; commit only if every item validates.
		const working = this.state.tasks.map(cloneTask);
		const byId = new Map(working.map((t) => [t.id, t]));
		const touched: Task[] = [];

		for (let i = 0; i < items.length; i++) {
			const inputItem = items[i];
			const taskId = inputItem.taskId.trim();
			const task = byId.get(taskId);
			if (!task) return { ok: false, error: `items[${i}]: task ${taskId} not found` };

			if (inputItem.status === "deleted") {
				deleteTaskFromWorking(working, byId, task);
				touched.push(
					cloneTask({
						...task,
						status: "cancelled",
						updatedAt: Date.now(),
					}),
				);
				continue;
			}

			const patched = applyTaskPatch(task, inputItem, working, (boardId) =>
				this.resolveAssociation(boardId),
			);
			if (!patched.ok) {
				return { ok: false, error: `items[${i}]: ${patched.error}` };
			}
			touched.push(cloneTask(task));
		}

		const inProgErr = enforceOneInProgressPerScope(working);
		if (inProgErr) return { ok: false, error: inProgErr };

		this.state.tasks = working;
		this.touch();
		this.persist();
		return { ok: true, tasks: touched };
	}

	getTask(taskId: string): Task | undefined {
		const t = this.state.tasks.find((x) => x.id === taskId);
		return t ? cloneTask(t) : undefined;
	}

	listTasks(scope?: string | null | "*"): Task[] {
		return tasksInScope(this.state, scope).map(cloneTask);
	}

	clearTasks(options?: {
		scope?: string | null | "*";
		clearDoc?: boolean;
	}): { ok: true; removed: number } | { ok: false; error: string } {
		const scope = options?.scope;
		let removed = 0;
		if (scope === "*") {
			removed = this.state.tasks.length;
			this.state.tasks = [];
			if (options?.clearDoc) {
				for (const b of this.state.boards) b.doc = undefined;
			}
		} else {
			const resolved =
				scope === null
					? null
					: scope !== undefined
						? scope
						: this.state.activeBoardId;
			if (
				scope !== undefined &&
				scope !== null &&
				scope !== "*" &&
				!getBoard(this.state, scope)
			) {
				return { ok: false, error: `board ${scope} not found` };
			}
			const before = this.state.tasks.length;
			if (resolved === null || resolved === undefined) {
				this.state.tasks = this.state.tasks.filter((t) => t.boardId);
			} else {
				this.state.tasks = this.state.tasks.filter((t) => t.boardId !== resolved);
				const board = getBoard(this.state, resolved);
				if (board) {
					if (options?.clearDoc) board.doc = undefined;
					board.updatedAt = Date.now();
				}
			}
			removed = before - this.state.tasks.length;
		}
		this.touch();
		this.persist();
		return { ok: true, removed };
	}

	boardDetails(partial?: Partial<BoardDetails>): BoardDetails {
		const s = this.getState();
		const active = getActiveBoard(s);
		return {
			kind: partial?.kind ?? "state",
			action: partial?.action,
			tasks: s.tasks,
			scopedTasks: partial?.scopedTasks?.map(cloneTask) ?? tasksInScope(s),
			focusTasks: partial?.focusTasks?.map(cloneTask),
			focusBoardId: partial?.focusBoardId,
			boards: s.boards,
			activeBoardId: s.activeBoardId,
			nextTaskSeq: s.nextTaskSeq,
			nextBoardSeq: s.nextBoardSeq,
			doc: active?.doc,
			changedIds: partial?.changedIds,
			error: partial?.error,
		};
	}

	reconstructFromSession(ctx: ExtensionContext): void {
		const branch =
			typeof ctx.sessionManager.getBranch === "function"
				? ctx.sessionManager.getBranch()
				: ctx.sessionManager.getEntries();

		let restored: BteState | undefined;

		for (const entry of branch) {
			const e = entry as {
				type?: string;
				customType?: string;
				data?: unknown;
				message?: {
					role?: string;
					toolName?: string;
					details?: unknown;
				};
			};

			if (e.type === "custom" && e.customType === BTE_STATE_ENTRY) {
				const parsed = coerceState(e.data);
				if (parsed) restored = parsed;
				continue;
			}

			if (e.type !== "message" || e.message?.role !== "toolResult") continue;
			const toolName = e.message.toolName;
			if (!toolName || !BOARD_TOOL_NAMES.has(toolName)) continue;
			const parsed = coerceState(e.message.details);
			if (parsed) restored = parsed;
		}

		this.state = normalizeState(restored ?? emptyState());
		this.lastPersistedSnapshot = undefined;
	}

	private resolveAssociation(
		boardId?: string | null,
	): { boardId?: string; error?: string } {
		if (boardId === null) return { boardId: undefined };
		if (typeof boardId === "string") {
			const id = boardId.trim();
			if (!id) return { boardId: undefined };
			const lower = id.toLowerCase();
			if (id === "*" || lower === "all") {
				return {
					error: 'boardId "*" / "all" is only valid for task list/clear',
				};
			}
			if (!getBoard(this.state, id)) {
				return { error: `board ${id} not found` };
			}
			return { boardId: id };
		}
		return { boardId: this.state.activeBoardId };
	}

	private touch(): void {
		this.state.updatedAt = Date.now();
	}

	private persist(): void {
		if (!this.persistFn) return;
		const payload = this.boardDetails({ kind: "state" });
		const fingerprint = JSON.stringify({
			activeBoardId: payload.activeBoardId ?? null,
			nextTaskSeq: payload.nextTaskSeq,
			nextBoardSeq: payload.nextBoardSeq,
			boards: payload.boards.map((b) => ({
				id: b.id,
				title: b.title,
				doc: b.doc ? { title: b.doc.title, body: b.doc.body } : null,
			})),
			tasks: payload.tasks.map((task) => ({
				id: task.id,
				subject: task.subject,
				description: task.description,
				status: task.status,
				activeForm: task.activeForm,
				boardId: task.boardId ?? null,
				blocks: task.blocks,
				blockedBy: task.blockedBy,
				metadata: task.metadata,
			})),
		});
		if (fingerprint === this.lastPersistedSnapshot) return;
		this.lastPersistedSnapshot = fingerprint;
		this.persistFn(BTE_STATE_ENTRY, payload);
	}

	private allocBoardId(): string {
		this.state.nextBoardSeq = Math.max(1, Math.floor(this.state.nextBoardSeq || 1));
		let id = `b${this.state.nextBoardSeq}`;
		const existing = new Set(this.state.boards.map((b) => b.id));
		while (existing.has(id)) {
			this.state.nextBoardSeq += 1;
			id = `b${this.state.nextBoardSeq}`;
		}
		this.state.nextBoardSeq += 1;
		return id;
	}

	private allocTaskId(): string {
		this.state.nextTaskSeq = normalizeSequence(this.state.nextTaskSeq, this.state.tasks);
		let id = `t${this.state.nextTaskSeq}`;
		const existing = new Set(this.state.tasks.map((t) => t.id));
		while (existing.has(id)) {
			this.state.nextTaskSeq += 1;
			id = `t${this.state.nextTaskSeq}`;
		}
		this.state.nextTaskSeq += 1;
		return id;
	}

	private bumpTaskSeq(tasks: Task[]): void {
		let max = normalizeSequence(this.state.nextTaskSeq, this.state.tasks) - 1;
		for (const t of tasks) {
			const m = /^t(\d+)$/.exec(t.id);
			if (m) max = Math.max(max, Number(m[1]));
		}
		this.state.nextTaskSeq = Math.max(this.state.nextTaskSeq, max + 1);
	}
}
