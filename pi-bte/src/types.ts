/** Shared types for pi-bte (clean model, no legacy names). */

export type TaskStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface Task {
	id: string;
	subject: string;
	description?: string;
	status: TaskStatus;
	/** Present continuous UI form, e.g. "Writing tests". */
	activeForm?: string;
	/** Optional board association; omit for standalone. */
	boardId?: string;
	blocks?: string[];
	blockedBy?: string[];
	metadata?: Record<string, unknown>;
	createdAt: number;
	updatedAt: number;
}

export interface BoardDoc {
	title?: string;
	body: string;
	updatedAt: number;
}

/** Optional multi-board container. Tasks link via task.boardId. */
export interface Board {
	id: string;
	title: string;
	doc?: BoardDoc;
	createdAt: number;
	updatedAt: number;
}

export interface BteState {
	boards: Board[];
	/** Default scope for tools; undefined = standalone tasks. */
	activeBoardId?: string;
	tasks: Task[];
	nextTaskSeq: number;
	nextBoardSeq: number;
	updatedAt: number;
}

export interface BteConfig {
	injectContext: boolean;
	showWidget: boolean;
}

export const DEFAULT_CONFIG: BteConfig = {
	injectContext: true,
	showWidget: true,
};

export const BTE_STATE_ENTRY = "bte-state";

export type ToolDetailsKind = "board" | "task" | "board_doc" | "state";

export interface BoardDetails {
	kind: ToolDetailsKind;
	action?: string;
	/** Full task list (all scopes) — session reconstruction. */
	tasks: Task[];
	/** Active/default scope tasks. */
	scopedTasks: Task[];
	/** Scope just mutated (tool result focus). */
	focusTasks?: Task[];
	/** Board id of focusTasks, or null for standalone. */
	focusBoardId?: string | null;
	boards: Board[];
	activeBoardId?: string;
	nextTaskSeq: number;
	nextBoardSeq: number;
	doc?: BoardDoc;
	changedIds?: string[];
	error?: string;
}

export function emptyState(now = Date.now()): BteState {
	return {
		boards: [],
		tasks: [],
		nextTaskSeq: 1,
		nextBoardSeq: 1,
		updatedAt: now,
	};
}

export function cloneTask(task: Task): Task {
	return {
		...task,
		blocks: task.blocks ? [...task.blocks] : undefined,
		blockedBy: task.blockedBy ? [...task.blockedBy] : undefined,
		metadata: task.metadata ? { ...task.metadata } : undefined,
	};
}

export function cloneBoard(board: Board): Board {
	return {
		...board,
		doc: board.doc ? { ...board.doc } : undefined,
	};
}

export function cloneState(state: BteState): BteState {
	return {
		boards: state.boards.map(cloneBoard),
		activeBoardId: state.activeBoardId,
		tasks: state.tasks.map(cloneTask),
		nextTaskSeq: state.nextTaskSeq,
		nextBoardSeq: state.nextBoardSeq,
		updatedAt: state.updatedAt,
	};
}

export function getBoard(state: BteState, boardId?: string): Board | undefined {
	if (!boardId) return undefined;
	return state.boards.find((b) => b.id === boardId);
}

export function getActiveBoard(state: BteState): Board | undefined {
	return getBoard(state, state.activeBoardId);
}

/** Tasks in a scope: board id, null=standalone, undefined=active/default, "*"=all. */
export function tasksInScope(
	state: BteState,
	scope?: string | null | "*",
): Task[] {
	if (scope === "*") return state.tasks;
	if (scope === null) return state.tasks.filter((t) => !t.boardId);
	if (scope !== undefined) {
		return state.tasks.filter((t) => t.boardId === scope);
	}
	if (state.activeBoardId) {
		return state.tasks.filter((t) => t.boardId === state.activeBoardId);
	}
	return state.tasks.filter((t) => !t.boardId);
}

export function statusMark(status: TaskStatus): string {
	if (status === "completed") return "[x]";
	if (status === "in_progress") return "[~]";
	if (status === "cancelled") return "[-]";
	return "[ ]";
}

export function formatTaskLine(
	task: Task,
	options?: { includeId?: boolean; includeDeps?: boolean; includeActiveForm?: boolean },
): string {
	const includeId = options?.includeId !== false;
	const includeDeps = options?.includeDeps === true;
	const includeActiveForm = options?.includeActiveForm === true;
	const mark = statusMark(task.status);
	const title =
		includeActiveForm && task.status === "in_progress" && task.activeForm
			? `${task.subject} (${task.activeForm})`
			: task.subject;
	let line = includeId ? `${mark} ${task.id}: ${title}` : `${mark} ${title}`;
	if (includeDeps) {
		const parts: string[] = [];
		if (task.blockedBy?.length) parts.push(`blockedBy=${task.blockedBy.join(",")}`);
		if (task.blocks?.length) parts.push(`blocks=${task.blocks.join(",")}`);
		if (parts.length) line += ` [${parts.join(" ")}]`;
	}
	return line;
}

export function formatTaskList(
	tasks: Task[],
	options?: { includeId?: boolean; includeDeps?: boolean; includeActiveForm?: boolean },
): string {
	if (tasks.length === 0) return "(no tasks)";
	return tasks.map((task) => formatTaskLine(task, options)).join("\n");
}

export function countByStatus(tasks: Task[]): Record<TaskStatus, number> {
	const counts: Record<TaskStatus, number> = {
		pending: 0,
		in_progress: 0,
		completed: 0,
		cancelled: 0,
	};
	for (const task of tasks) counts[task.status] += 1;
	return counts;
}

export const TASK_STATUSES: TaskStatus[] = [
	"pending",
	"in_progress",
	"completed",
	"cancelled",
];

export function isTaskStatus(value: unknown): value is TaskStatus {
	return typeof value === "string" && (TASK_STATUSES as string[]).includes(value);
}

/**
 * Board association for create/update scope.
 * undefined = inherit active; null = standalone; string = board id.
 */
export function parseBoardRef(
	value: string | undefined | null,
): string | null | undefined {
	if (value === undefined) return undefined;
	if (value === null) return null;
	const raw = String(value).trim();
	if (!raw) return null;
	const lower = raw.toLowerCase();
	if (lower === "standalone" || lower === "none" || lower === "null") return null;
	// list/clear-only tokens — callers should reject before association
	if (raw === "*" || lower === "all") return raw;
	return raw;
}

/** True if value is a list/clear-only scope token, not a board association. */
export function isListOnlyBoardToken(value: string | undefined | null): boolean {
	if (value === undefined || value === null) return false;
	const raw = String(value).trim().toLowerCase();
	return raw === "*" || raw === "all";
}

/**
 * list/clear scope: undefined=active, null=standalone, "*"=all, string=board id.
 */
export function parseListScope(
	value: string | undefined | null,
): string | null | "*" | undefined {
	if (value === undefined) return undefined;
	if (value === null) return null;
	const raw = String(value).trim();
	if (!raw) return null;
	if (raw === "*" || raw.toLowerCase() === "all") return "*";
	const lower = raw.toLowerCase();
	if (lower === "standalone" || lower === "none" || lower === "null") return null;
	return raw;
}
