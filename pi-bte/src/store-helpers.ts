/**
 * Store helpers: update batch, deps, normalize/coerce session state.
 */

import {
	type Board,
	type BteState,
	type Task,
	type TaskStatus,
	isTaskStatus,
} from "./types.ts";

export type TaskUpdateItem = {
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
};

export function validateUpdateBatch(
	items: Array<TaskUpdateItem>,
	existing: Task[],
): { ok: true } | { ok: false; error: string } {
	const seen = new Set<string>();
	const existingIds = new Set(existing.map((t) => t.id));
	for (let i = 0; i < items.length; i++) {
		const id = items[i].taskId?.trim();
		if (!id) return { ok: false, error: `items[${i}]: taskId is required` };
		if (seen.has(id)) {
			return { ok: false, error: `items[${i}]: duplicate taskId ${id}` };
		}
		seen.add(id);
		if (!existingIds.has(id)) {
			return { ok: false, error: `items[${i}]: task ${id} not found` };
		}
	}
	return { ok: true };
}

function stripIdFromDeps(tasks: Task[], removedId: string): void {
	for (const t of tasks) {
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

export function deleteTaskFromWorking(
	working: Task[],
	byId: Map<string, Task>,
	task: Task,
): void {
	byId.delete(task.id);
	const idx = working.findIndex((t) => t.id === task.id);
	if (idx >= 0) working.splice(idx, 1);
	stripIdFromDeps(working, task.id);
}

export function applyTaskPatch(
	task: Task,
	inputItem: TaskUpdateItem,
	working: Task[],
	resolveAssociation: (boardId?: string | null) => {
		boardId?: string;
		error?: string;
	},
): { ok: true } | { ok: false; error: string } {
	if (inputItem.status !== undefined && !isTaskStatus(inputItem.status)) {
		return { ok: false, error: `invalid status: ${inputItem.status}` };
	}

	let nextBoardId = task.boardId;
	if (inputItem.boardId !== undefined) {
		const assoc = resolveAssociation(inputItem.boardId);
		if (assoc.error) return { ok: false, error: assoc.error };
		nextBoardId = assoc.boardId;
	}

	const nextSubject = inputItem.subject?.trim();
	if (inputItem.subject !== undefined && !nextSubject) {
		return { ok: false, error: "subject cannot be empty" };
	}

	const scopeTasks = working.filter((t) =>
		nextBoardId ? t.boardId === nextBoardId : !t.boardId,
	);
	const dependencyError = validateDependencyIds(
		[...(inputItem.addBlocks ?? []), ...(inputItem.addBlockedBy ?? [])],
		new Set(scopeTasks.map((t) => t.id)),
		task.id,
	);
	if (dependencyError) return { ok: false, error: dependencyError };

	if (inputItem.boardId !== undefined && nextBoardId !== task.boardId) {
		const destIds = new Set(scopeTasks.map((t) => t.id));
		task.blocks = pruneIds(task.blocks, destIds, task.id);
		task.blockedBy = pruneIds(task.blockedBy, destIds, task.id);
		// Unlink from old-scope peers only.
		for (const t of working) {
			const same = task.boardId ? t.boardId === task.boardId : !t.boardId;
			if (!same || t.id === task.id) continue;
			if (t.blocks) {
				const next = t.blocks.filter((id) => id !== task.id);
				t.blocks = next.length ? next : undefined;
			}
			if (t.blockedBy) {
				const next = t.blockedBy.filter((id) => id !== task.id);
				t.blockedBy = next.length ? next : undefined;
			}
		}
	}

	if (nextSubject !== undefined) task.subject = nextSubject;
	if (inputItem.description !== undefined) {
		task.description = inputItem.description.trim() || undefined;
	}
	if (inputItem.activeForm !== undefined) {
		task.activeForm = inputItem.activeForm.trim() || undefined;
	}
	if (inputItem.status !== undefined) task.status = inputItem.status;
	if (inputItem.boardId !== undefined) task.boardId = nextBoardId;
	if (inputItem.addBlocks?.length) {
		task.blocks = mergeIds(task.blocks, inputItem.addBlocks);
	}
	if (inputItem.addBlockedBy?.length) {
		task.blockedBy = mergeIds(task.blockedBy, inputItem.addBlockedBy);
	}
	if (inputItem.removeBlocks?.length) {
		task.blocks = removeIds(task.blocks, inputItem.removeBlocks);
	}
	if (inputItem.removeBlockedBy?.length) {
		task.blockedBy = removeIds(task.blockedBy, inputItem.removeBlockedBy);
	}
	if (inputItem.metadata !== undefined) {
		task.metadata = { ...(task.metadata ?? {}), ...inputItem.metadata };
	}
	task.updatedAt = Date.now();
	return { ok: true };
}

// Removed: Multiple in_progress tasks are now allowed per scope

export function repairInProgressForScope(
	allTasks: Task[],
	scopeBoardId: string | undefined,
): void {
	// Removed: Multiple in_progress tasks are now allowed per scope
	// This function is kept for compatibility but does nothing
}

export function normalizeIdList(ids?: string[]): string[] | undefined {
	if (!ids?.length) return undefined;
	const out = [...new Set(ids.map((s) => String(s).trim()).filter(Boolean))];
	return out.length ? out : undefined;
}

export function pruneIds(
	ids: string[] | undefined,
	retained: Set<string>,
	selfId: string,
): string[] | undefined {
	const pruned = ids?.filter((id) => id !== selfId && retained.has(id));
	return pruned?.length ? [...new Set(pruned)] : undefined;
}

export function mergeIds(existing: string[] | undefined, add: string[]): string[] {
	return [
		...new Set([...(existing ?? []), ...add.map((s) => s.trim()).filter(Boolean)]),
	];
}

export function removeIds(
	existing: string[] | undefined,
	remove: string[],
): string[] | undefined {
	if (!existing?.length) return undefined;
	const drop = new Set(remove.map((s) => s.trim()).filter(Boolean));
	const next = existing.filter((id) => !drop.has(id));
	return next.length ? next : undefined;
}

export function validateDependencyIds(
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

export function coerceState(data: unknown): BteState | undefined {
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
		nextTaskSeq: d.nextTaskSeq as number,
		nextBoardSeq: d.nextBoardSeq as number,
		updatedAt: typeof d.updatedAt === "number" ? d.updatedAt : now,
	});
}

export function normalizeState(state: BteState): BteState {
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
		for (const task of list) {
			task.blocks = pruneIds(task.blocks, retained, task.id);
			task.blockedBy = pruneIds(task.blockedBy, retained, task.id);
		}
	}

	if (state.activeBoardId && !boardIds.has(state.activeBoardId)) {
		state.activeBoardId = state.boards[0]?.id;
	}

	return state;
}

export function normalizeSequence(value: unknown, tasks: Task[]): number {
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
