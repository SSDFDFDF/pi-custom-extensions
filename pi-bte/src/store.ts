/**
 * pi-bte store — boards + flat tasks (optional boardId).
 * No legacy plan/update_plan names.
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
	formatTaskList,
	getActiveBoard,
	getBoard,
	isTaskStatus,
	tasksInScope,
} from "./types.ts";

type PersistFn = (customType: string, data: unknown) => void;

const BOARD_TOOL_NAMES = new Set(["board", "checklist", "task", "board_doc"]);

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

	// ─── Checklist replace ────────────────────────────────────────────

	/**
	 * Full replace of tasks in one scope.
	 * boardId: undefined=active/default, null=standalone, string=that board.
	 * Empty items rejected — use clearTasks.
	 */
	replaceChecklist(
		items: Array<{ step: string; status: TaskStatus; id?: string }>,
		note?: string,
		boardId?: string | null,
	): {
		ok: true;
		tasks: Task[];
		scopeBoardId?: string;
		removedCount: number;
	} | { ok: false; error: string } {
		if (!items.length) {
			return {
				ok: false,
				error:
					"checklist must be non-empty. Use task clear to wipe a scope.",
			};
		}
		if (items.some((item) => !isTaskStatus(item.status))) {
			return { ok: false, error: "Each item needs a valid status." };
		}
		if (items.filter((p) => p.status === "in_progress").length > 1) {
			return { ok: false, error: "At most one step can be in_progress." };
		}
		if (items.some((p) => !p.step?.trim())) {
			return { ok: false, error: "Each item needs non-empty step text." };
		}

		const scope = this.resolveScope(boardId);
		if (scope.error) return { ok: false, error: scope.error };
		const scopeBoardId = scope.boardId;

		if (scopeBoardId) {
			const board = getBoard(this.state, scopeBoardId);
			if (!board) return { ok: false, error: `board ${scopeBoardId} not found` };
			if (note !== undefined) board.note = note || undefined;
			board.updatedAt = Date.now();
		} else if (note !== undefined) {
			this.state.note = note || undefined;
		}

		const scoped = this.state.tasks.filter((t) =>
			scopeBoardId ? t.boardId === scopeBoardId : !t.boardId,
		);
		const outside = this.state.tasks.filter((t) =>
			scopeBoardId ? t.boardId !== scopeBoardId : Boolean(t.boardId),
		);

		const now = Date.now();
		const prevById = new Map(scoped.map((task) => [task.id, task]));
		const claimedIds = new Set<string>();
		const explicitIds = items
			.map((item) => item.id?.trim())
			.filter((id): id is string => Boolean(id));
		if (new Set(explicitIds).size !== explicitIds.length) {
			return { ok: false, error: "Item ids must be unique." };
		}
		for (const id of explicitIds) {
			if (!prevById.has(id)) {
				return { ok: false, error: `Unknown task id: ${id}` };
			}
		}

		const prevBySubject = new Map<string, Task[]>();
		for (const task of scoped) {
			const queue = prevBySubject.get(task.subject) ?? [];
			queue.push(task);
			prevBySubject.set(task.subject, queue);
		}

		const next: Task[] = [];
		for (const item of items) {
			const subject = item.step.trim();
			const explicitId = item.id?.trim();
			let prev: Task | undefined;
			if (explicitId) {
				prev = prevById.get(explicitId);
				claimedIds.add(explicitId);
				const queue = prevBySubject.get(prev?.subject ?? "");
				if (queue && prev) {
					const idx = queue.findIndex((c) => c.id === prev!.id);
					if (idx >= 0) queue.splice(idx, 1);
				}
			} else {
				const queue = prevBySubject.get(subject);
				while (queue?.length) {
					const candidate = queue.shift();
					if (!candidate || claimedIds.has(candidate.id)) continue;
					prev = candidate;
					claimedIds.add(candidate.id);
					break;
				}
			}
			next.push({
				id: prev?.id ?? this.allocTaskId(),
				subject,
				description: prev?.description,
				status: item.status,
				activeForm: prev?.activeForm,
				boardId: scopeBoardId,
				blocks: prev?.blocks ? [...prev.blocks] : undefined,
				blockedBy: prev?.blockedBy ? [...prev.blockedBy] : undefined,
				metadata: prev?.metadata ? { ...prev.metadata } : undefined,
				createdAt: prev?.createdAt ?? now,
				updatedAt: now,
			});
		}

		const retainedIds = new Set(next.map((t) => t.id));
		for (const task of next) {
			task.blocks = pruneIds(task.blocks, retainedIds, task.id);
			task.blockedBy = pruneIds(task.blockedBy, retainedIds, task.id);
		}

		const removedCount = scoped.filter((t) => !next.some((n) => n.id === t.id)).length;
		this.bumpTaskSeq(next);
		this.state.tasks = [...outside, ...next];
		this.touch();
		this.persist();
		return {
			ok: true,
			tasks: next.map(cloneTask),
			scopeBoardId,
			removedCount,
		};
	}

	// ─── Tasks ────────────────────────────────────────────────────────

	createTask(input: {
		subject: string;
		description?: string;
		activeForm?: string;
		status?: TaskStatus;
		/** null/"" = standalone; string = board; omit = active board if any */
		boardId?: string | null;
		blocks?: string[];
		blockedBy?: string[];
		metadata?: Record<string, unknown>;
	}): { ok: true; task: Task } | { ok: false; error: string } {
		const subject = input.subject?.trim();
		if (!subject) return { ok: false, error: "subject is required" };
		const status = input.status ?? "pending";
		if (!isTaskStatus(status)) return { ok: false, error: `invalid status: ${status}` };

		const boardId = this.resolveAssociation(input.boardId);
		if (boardId.error) return { ok: false, error: boardId.error };
		const bid = boardId.boardId;

		const scopeTasks = this.state.tasks.filter((t) =>
			bid ? t.boardId === bid : !t.boardId,
		);
		if (status === "in_progress") {
			const err = ensureSingleInProgress(scopeTasks, undefined, bid);
			if (err) return { ok: false, error: err };
		}

		const existingIds = new Set(scopeTasks.map((t) => t.id));
		const dependencyError = validateDependencyIds(
			[...(input.blocks ?? []), ...(input.blockedBy ?? [])],
			existingIds,
		);
		if (dependencyError) return { ok: false, error: dependencyError };

		const now = Date.now();
		const task: Task = {
			id: this.allocTaskId(),
			subject,
			description: input.description?.trim() || undefined,
			status,
			activeForm: input.activeForm?.trim() || undefined,
			boardId: bid,
			blocks: normalizeIdList(input.blocks),
			blockedBy: normalizeIdList(input.blockedBy),
			metadata: input.metadata ? { ...input.metadata } : undefined,
			createdAt: now,
			updatedAt: now,
		};
		this.state.tasks.push(task);
		this.touch();
		this.persist();
		return { ok: true, task: cloneTask(task) };
	}

	updateTask(input: {
		taskId: string;
		status?: TaskStatus | "deleted";
		subject?: string;
		description?: string;
		activeForm?: string;
		boardId?: string | null;
		addBlocks?: string[];
		addBlockedBy?: string[];
		removeBlocks?: string[];
		removeBlockedBy?: string[];
		metadata?: Record<string, unknown>;
	}): { ok: true; task: Task } | { ok: false; error: string } {
		const task = this.state.tasks.find((t) => t.id === input.taskId);
		if (!task) return { ok: false, error: `task ${input.taskId} not found` };

		if (input.status === "deleted") {
			this.state.tasks = this.state.tasks.filter((t) => t.id !== task.id);
			this.unlinkDeps(task.id, task.boardId);
			const removed = cloneTask({
				...task,
				status: "cancelled",
				updatedAt: Date.now(),
			});
			this.touch();
			this.persist();
			return { ok: true, task: removed };
		}

		if (input.status !== undefined && !isTaskStatus(input.status)) {
			return { ok: false, error: `invalid status: ${input.status}` };
		}

		let nextBoardId = task.boardId;
		if (input.boardId !== undefined) {
			const assoc = this.resolveAssociation(input.boardId);
			if (assoc.error) return { ok: false, error: assoc.error };
			nextBoardId = assoc.boardId;
		}

		const scopeTasks = this.state.tasks.filter((t) =>
			nextBoardId ? t.boardId === nextBoardId : !t.boardId,
		);
		const becomingActive =
			input.status === "in_progress" ||
			(input.status === undefined && task.status === "in_progress");
		if (becomingActive) {
			const err = ensureSingleInProgress(scopeTasks, task.id, nextBoardId);
			if (err) return { ok: false, error: err };
		}

		const nextSubject = input.subject?.trim();
		if (input.subject !== undefined && !nextSubject) {
			return { ok: false, error: "subject cannot be empty" };
		}

		const dependencyError = validateDependencyIds(
			[...(input.addBlocks ?? []), ...(input.addBlockedBy ?? [])],
			new Set(scopeTasks.map((t) => t.id)),
			task.id,
		);
		if (dependencyError) return { ok: false, error: dependencyError };

		if (input.boardId !== undefined && nextBoardId !== task.boardId) {
			const destIds = new Set(scopeTasks.map((t) => t.id));
			task.blocks = pruneIds(task.blocks, destIds, task.id);
			task.blockedBy = pruneIds(task.blockedBy, destIds, task.id);
			this.unlinkDeps(task.id, task.boardId);
		}

		if (nextSubject !== undefined) task.subject = nextSubject;
		if (input.description !== undefined) {
			task.description = input.description.trim() || undefined;
		}
		if (input.activeForm !== undefined) {
			task.activeForm = input.activeForm.trim() || undefined;
		}
		if (input.status !== undefined) task.status = input.status;
		if (input.boardId !== undefined) task.boardId = nextBoardId;
		if (input.addBlocks?.length) task.blocks = mergeIds(task.blocks, input.addBlocks);
		if (input.addBlockedBy?.length) {
			task.blockedBy = mergeIds(task.blockedBy, input.addBlockedBy);
		}
		if (input.removeBlocks?.length) {
			task.blocks = removeIds(task.blocks, input.removeBlocks);
		}
		if (input.removeBlockedBy?.length) {
			task.blockedBy = removeIds(task.blockedBy, input.removeBlockedBy);
		}
		if (input.metadata !== undefined) {
			task.metadata = { ...(task.metadata ?? {}), ...input.metadata };
		}
		task.updatedAt = Date.now();
		this.touch();
		this.persist();
		return { ok: true, task: cloneTask(task) };
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
			this.state.note = undefined;
			if (options?.clearDoc) {
				for (const b of this.state.boards) b.doc = undefined;
			}
			for (const b of this.state.boards) b.note = undefined;
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
				this.state.note = undefined;
			} else {
				this.state.tasks = this.state.tasks.filter((t) => t.boardId !== resolved);
				const board = getBoard(this.state, resolved);
				if (board) {
					board.note = undefined;
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
		// Do not fall back to standalone note while a board is active (scope bleed).
		const scopeNote = active ? active.note : s.note;
		return {
			kind: partial?.kind ?? "state",
			action: partial?.action,
			explanation: partial?.explanation ?? scopeNote,
			tasks: s.tasks,
			scopedTasks: partial?.scopedTasks?.map(cloneTask) ?? tasksInScope(s),
			focusTasks: partial?.focusTasks?.map(cloneTask),
			focusBoardId: partial?.focusBoardId,
			removedCount: partial?.removedCount,
			boards: s.boards,
			activeBoardId: s.activeBoardId,
			note: s.note,
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

	private resolveScope(
		boardId?: string | null,
	): { boardId?: string; error?: string } {
		if (boardId === null) return { boardId: undefined };
		if (boardId !== undefined) {
			if (!getBoard(this.state, boardId)) {
				return { error: `board ${boardId} not found` };
			}
			return { boardId };
		}
		return { boardId: this.state.activeBoardId };
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
			note: this.state.note ?? null,
			nextTaskSeq: payload.nextTaskSeq,
			nextBoardSeq: payload.nextBoardSeq,
			boards: payload.boards.map((b) => ({
				id: b.id,
				title: b.title,
				note: b.note ?? null,
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

	private unlinkDeps(removedId: string, boardId?: string): void {
		for (const t of this.state.tasks) {
			const same = boardId ? t.boardId === boardId : !t.boardId;
			if (!same) continue;
			if (t.blocks) {
				const next = t.blocks.filter((id) => id !== removedId);
				t.blocks = next.length ? next : undefined;
			}
			if (t.blockedBy) {
				const next = t.blockedBy.filter((id) => id !== removedId);
				t.blockedBy = next.length ? next : undefined;
			}
		}
	}
}

function ensureSingleInProgress(
	scopeTasks: Task[],
	exceptId: string | undefined,
	scopeBoardId: string | undefined,
): string | undefined {
	const others = scopeTasks.filter(
		(t) => t.status === "in_progress" && t.id !== exceptId,
	);
	if (others.length > 0) {
		const where = scopeBoardId ? `board ${scopeBoardId}` : "standalone tasks";
		return `Only one task may be in_progress in ${where}. Currently: ${others.map((t) => t.id).join(", ")}.`;
	}
	return undefined;
}

function repairInProgressForScope(
	allTasks: Task[],
	scopeBoardId: string | undefined,
): void {
	const list = allTasks.filter((t) =>
		scopeBoardId ? t.boardId === scopeBoardId : !t.boardId,
	);
	let hasActive = false;
	for (const task of list) {
		if (task.status !== "in_progress") continue;
		if (!hasActive) hasActive = true;
		else task.status = "pending";
	}
}

function normalizeIdList(ids?: string[]): string[] | undefined {
	if (!ids?.length) return undefined;
	const out = [...new Set(ids.map((s) => String(s).trim()).filter(Boolean))];
	return out.length ? out : undefined;
}

function pruneIds(
	ids: string[] | undefined,
	retained: Set<string>,
	selfId: string,
): string[] | undefined {
	const pruned = ids?.filter((id) => id !== selfId && retained.has(id));
	return pruned?.length ? [...new Set(pruned)] : undefined;
}

function mergeIds(existing: string[] | undefined, add: string[]): string[] {
	return [
		...new Set([...(existing ?? []), ...add.map((s) => s.trim()).filter(Boolean)]),
	];
}

function removeIds(
	existing: string[] | undefined,
	remove: string[],
): string[] | undefined {
	if (!existing?.length) return undefined;
	const drop = new Set(remove.map((s) => s.trim()).filter(Boolean));
	const next = existing.filter((id) => !drop.has(id));
	return next.length ? next : undefined;
}

function validateDependencyIds(
	ids: string[],
	existingIds: Set<string>,
	selfId?: string,
): string | undefined {
	for (const raw of ids) {
		const id = String(raw).trim();
		if (!id) continue;
		if (id === selfId) return `task ${id} cannot depend on or block itself`;
		if (!existingIds.has(id)) return `dependency task ${id} not found`;
	}
	return undefined;
}

function normalizeTask(raw: Task): Task {
	return {
		id: String(raw?.id ?? ""),
		subject: String(raw?.subject ?? ""),
		description: typeof raw?.description === "string" ? raw.description : undefined,
		status: isTaskStatus(raw?.status) ? raw.status : "pending",
		activeForm: typeof raw?.activeForm === "string" ? raw.activeForm : undefined,
		boardId:
			typeof raw?.boardId === "string" && raw.boardId.trim()
				? raw.boardId.trim()
				: undefined,
		blocks: normalizeIdList(raw?.blocks),
		blockedBy: normalizeIdList(raw?.blockedBy),
		metadata: raw?.metadata && typeof raw.metadata === "object" ? { ...raw.metadata } : undefined,
		createdAt:
			typeof raw?.createdAt === "number" && Number.isFinite(raw.createdAt)
				? raw.createdAt
				: Date.now(),
		updatedAt:
			typeof raw?.updatedAt === "number" && Number.isFinite(raw.updatedAt)
				? raw.updatedAt
				: Date.now(),
	};
}

function normalizeBoard(raw: Partial<Board>, now: number): Board | undefined {
	const id = String(raw?.id ?? "").trim();
	if (!id) return undefined;
	return {
		id,
		title: String(raw?.title ?? id).trim() || id,
		doc:
			raw?.doc && typeof raw.doc === "object" && typeof raw.doc.body === "string"
				? {
						title: raw.doc.title,
						body: raw.doc.body,
						updatedAt:
							typeof raw.doc.updatedAt === "number" ? raw.doc.updatedAt : now,
					}
				: undefined,
		note: typeof raw?.note === "string" ? raw.note : undefined,
		createdAt:
			typeof raw?.createdAt === "number" && Number.isFinite(raw.createdAt)
				? raw.createdAt
				: now,
		updatedAt:
			typeof raw?.updatedAt === "number" && Number.isFinite(raw.updatedAt)
				? raw.updatedAt
				: now,
	};
}

function coerceState(data: unknown): BteState | undefined {
	if (!data || typeof data !== "object") return undefined;
	const d = data as Record<string, unknown>;
	if (!Array.isArray(d.tasks) && !Array.isArray(d.boards)) return undefined;
	const now = Date.now();

	const boards = Array.isArray(d.boards)
		? (d.boards as Partial<Board>[])
				.map((b) => normalizeBoard(b, now))
				.filter((b): b is Board => Boolean(b))
		: [];

	const boardIds = new Set(boards.map((b) => b.id));
	const tasks = Array.isArray(d.tasks)
		? (d.tasks as Task[])
				.filter((t) => Boolean(t) && typeof t === "object")
				.map(normalizeTask)
				.filter((t) => t.id.length > 0 && t.subject.length > 0)
				.map((t) => ({
					...t,
					boardId: t.boardId && boardIds.has(t.boardId) ? t.boardId : undefined,
				}))
		: [];

	return normalizeState({
		boards,
		tasks,
		activeBoardId:
			typeof d.activeBoardId === "string" && boardIds.has(d.activeBoardId)
				? d.activeBoardId
				: undefined,
		note: typeof d.note === "string" ? d.note : undefined,
		nextTaskSeq: d.nextTaskSeq as number,
		nextBoardSeq: d.nextBoardSeq as number,
		updatedAt: typeof d.updatedAt === "number" ? d.updatedAt : now,
	});
}

function normalizeState(state: BteState): BteState {
	state.nextTaskSeq = normalizeSequence(state.nextTaskSeq, state.tasks);

	let maxBoard = 0;
	for (const board of state.boards) {
		const m = /^b(\d+)$/.exec(board.id);
		if (m) maxBoard = Math.max(maxBoard, Number(m[1]));
	}
	const boardSeq =
		typeof state.nextBoardSeq === "number" && Number.isFinite(state.nextBoardSeq)
			? Math.floor(state.nextBoardSeq)
			: 1;
	state.nextBoardSeq = Math.max(boardSeq, maxBoard + 1);

	const boardIds = new Set(state.boards.map((b) => b.id));
	for (const task of state.tasks) {
		if (task.boardId && !boardIds.has(task.boardId)) task.boardId = undefined;
	}

	const scopes = new Map<string, Task[]>();
	for (const task of state.tasks) {
		const key = task.boardId ?? "";
		const list = scopes.get(key) ?? [];
		list.push(task);
		scopes.set(key, list);
	}
	for (const list of scopes.values()) {
		const retained = new Set(list.map((t) => t.id));
		let hasActive = false;
		for (const task of list) {
			task.blocks = pruneIds(task.blocks, retained, task.id);
			task.blockedBy = pruneIds(task.blockedBy, retained, task.id);
			if (task.status !== "in_progress") continue;
			if (!hasActive) hasActive = true;
			else task.status = "pending";
		}
	}

	if (state.activeBoardId && !boardIds.has(state.activeBoardId)) {
		state.activeBoardId = state.boards[0]?.id;
	}

	return state;
}

function normalizeSequence(value: unknown, tasks: Task[]): number {
	let maxId = 0;
	for (const task of tasks) {
		const match = /^t(\d+)$/.exec(task.id);
		if (match) maxId = Math.max(maxId, Number(match[1]));
	}
	const candidate =
		typeof value === "number" && Number.isFinite(value) && value >= 1
			? Math.floor(value)
			: 1;
	return Math.max(candidate, maxId + 1);
}

export function renderAgentContext(state: BteState): string {
	const lines: string[] = [];
	const active = getActiveBoard(state);
	const scoped = tasksInScope(state);
	const standalone = state.tasks.filter((t) => !t.boardId);

	if (state.boards.length === 0 && state.tasks.length === 0) return "";

	lines.push("[TASK BOARD]");
	lines.push(
		"Prefer task for progress. checklist only to open/rewrite a whole list (omitted steps removed; empty list rejected — use task clear). One in_progress per board (or standalone).",
	);

	if (state.boards.length > 0) {
		const bits = state.boards.map((b) => {
			const n = state.tasks.filter((t) => t.boardId === b.id).length;
			const done = state.tasks.filter(
				(t) => t.boardId === b.id && t.status === "completed",
			).length;
			const star = b.id === state.activeBoardId ? "*" : "";
			return `${star}${b.id} ${b.title} (${done}/${n})`;
		});
		lines.push(`Boards: ${bits.join("; ")}`);
		lines.push(
			active ? `Active: ${active.id} ${active.title}` : "Active: (standalone)",
		);
		const other = state.tasks.filter(
			(t) => t.boardId && t.boardId !== state.activeBoardId,
		).length;
		if (other > 0 || standalone.length > 0) {
			lines.push(
				`Other scopes not expanded — task list boardId="*" (${other} in other boards, ${standalone.length} standalone).`,
			);
		}
		const foreign = state.tasks.filter(
			(t) =>
				t.status === "in_progress" &&
				(t.boardId
					? t.boardId !== state.activeBoardId
					: Boolean(state.activeBoardId)),
		);
		if (foreign.length) {
			lines.push(
				`Active outside current scope: ${foreign
					.map((t) => (t.boardId ? `${t.id}@${t.boardId}` : `${t.id}@standalone`))
					.join(", ")}`,
			);
		}
	}

	if (scoped.length > 0) {
		lines.push(
			formatTaskList(scoped, {
				includeId: true,
				includeDeps: true,
				includeActiveForm: true,
			}),
		);
	}

	if (active && standalone.length > 0 && standalone.length <= 5) {
		lines.push(`Standalone: ${standalone.map((t) => t.subject).join("; ")}`);
	} else if (active && standalone.length > 5) {
		lines.push(`(+${standalone.length} standalone)`);
	}

	if (active?.doc?.body) {
		const body = active.doc.body;
		const snippet =
			body.length > 4000 ? `${body.slice(0, 4000)}\n…(truncated)` : body;
		lines.push("");
		lines.push(`Doc${active.doc.title ? ` (${active.doc.title})` : ""}:`);
		lines.push(snippet);
	}

	// Active board uses board.note only; standalone scope uses state.note.
	const note = active ? active.note : state.note;
	if (note) lines.push(`Note: ${note}`);

	return lines.join("\n");
}
