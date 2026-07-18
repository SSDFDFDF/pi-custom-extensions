/** Shared types for pi-pte. */

export type TaskStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface Task {
	id: string;
	subject: string;
	description?: string;
	status: TaskStatus;
	/** Present continuous UI form, e.g. "Writing tests". */
	activeForm?: string;
	blocks?: string[];
	blockedBy?: string[];
	metadata?: Record<string, unknown>;
	createdAt: number;
	updatedAt: number;
}

export interface PlanDocument {
	title?: string;
	body: string;
	updatedAt: number;
}

export interface PteState {
	tasks: Task[];
	nextTaskSeq: number;
	planDoc?: PlanDocument;
	lastExplanation?: string;
	updatedAt: number;
}

export interface PteConfig {
	/** Inject the current board into the agent's per-turn system prompt. */
	injectContext: boolean;
	/** Show footer status and task widget. */
	showWidget: boolean;
	/** Maximum task lines in the widget. */
	widgetMaxTasks: number;
}

export const DEFAULT_CONFIG: PteConfig = {
	injectContext: true,
	showWidget: true,
	widgetMaxTasks: 12,
};

export const PTE_STATE_ENTRY = "pte-state";

export type ToolDetailsKind = "update_plan" | "task" | "plan_doc" | "state";

export interface BoardDetails {
	kind: ToolDetailsKind;
	action?: string;
	explanation?: string;
	tasks: Task[];
	nextTaskSeq: number;
	planDoc?: PlanDocument;
	/** Explicitly distinguishes a cleared document from a legacy omitted field. */
	planDocCleared?: boolean;
	changedIds?: string[];
	error?: string;
}

export function emptyState(now = Date.now()): PteState {
	return {
		tasks: [],
		nextTaskSeq: 1,
		updatedAt: now,
	};
}

export function cloneState(state: PteState): PteState {
	return {
		tasks: state.tasks.map((t) => ({
			...t,
			blocks: t.blocks ? [...t.blocks] : undefined,
			blockedBy: t.blockedBy ? [...t.blockedBy] : undefined,
			metadata: t.metadata ? { ...t.metadata } : undefined,
		})),
		nextTaskSeq: state.nextTaskSeq,
		planDoc: state.planDoc ? { ...state.planDoc } : undefined,
		lastExplanation: state.lastExplanation,
		updatedAt: state.updatedAt,
	};
}

export function formatTaskLine(task: Task): string {
	const mark =
		task.status === "completed"
			? "[x]"
			: task.status === "in_progress"
				? "[~]"
				: task.status === "cancelled"
					? "[-]"
					: "[ ]";
	return `${mark} ${task.id}: ${task.subject}`;
}

export function formatTaskList(tasks: Task[]): string {
	if (tasks.length === 0) return "(no tasks)";
	return tasks.map(formatTaskLine).join("\n");
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
