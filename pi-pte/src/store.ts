/**
 * In-memory plan/task store with session reconstruction.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type BoardDetails,
	type PlanDocument,
	type PteState,
	type Task,
	type TaskStatus,
	PTE_STATE_ENTRY,
	cloneState,
	emptyState,
	formatTaskList,
	isTaskStatus,
} from "./types.ts";

export type PersistFn = (customType: string, data: unknown) => void;

const BOARD_TOOL_NAMES = new Set(["update_plan", "task", "plan_doc"]);

export class PteStore {
	private state: PteState = emptyState();
	private persistFn?: PersistFn;
	/** Last custom-entry payload JSON; skip identical consecutive snapshots. */
	private lastPersistedSnapshot?: string;

	setPersist(fn: PersistFn | undefined): void {
		this.persistFn = fn;
	}

	/** Drop process-local persist fingerprint (session switch / shutdown). */
	resetRuntimeCaches(): void {
		this.lastPersistedSnapshot = undefined;
	}

	getState(): PteState {
		return this.state;
	}

	snapshot(): PteState {
		return cloneState(this.state);
	}

	setPlanDoc(doc: PlanDocument | undefined): void {
		this.state.planDoc = doc;
		this.touch();
		this.persist();
	}

	clearTasks(options?: { clearPlanDoc?: boolean }): void {
		this.state.tasks = [];
		// Keep ids monotonic for the session so old transcript references never
		// become ambiguous after a clear.
		this.state.lastExplanation = undefined;
		if (options?.clearPlanDoc) this.state.planDoc = undefined;
		this.touch();
		this.persist();
	}

	/**
	 * Codex-style full checklist replace. At most one in_progress.
	 */
	updatePlan(
		plan: Array<{ step: string; status: TaskStatus }>,
		explanation?: string,
	): { ok: true; tasks: Task[] } | { ok: false; error: string } {
		if (plan.some((item) => !isTaskStatus(item.status))) {
			return { ok: false, error: "Each plan item needs a valid status." };
		}
		const inProgress = plan.filter((p) => p.status === "in_progress");
		if (inProgress.length > 1) {
			return { ok: false, error: "At most one step can be in_progress at a time." };
		}
		if (plan.some((p) => !p.step?.trim())) {
			return { ok: false, error: "Each plan item needs non-empty step text." };
		}

		const now = Date.now();
		const prevBySubject = new Map<string, Task[]>();
		for (const task of this.state.tasks) {
			const queue = prevBySubject.get(task.subject) ?? [];
			queue.push(task);
			prevBySubject.set(task.subject, queue);
		}
		const next: Task[] = [];

		for (const item of plan) {
			const subject = item.step.trim();
			const prev = prevBySubject.get(subject)?.shift();
			next.push({
				id: prev?.id ?? this.allocId(),
				subject,
				description: prev?.description,
				status: item.status,
				activeForm: prev?.activeForm,
				blocks: prev?.blocks ? [...prev.blocks] : undefined,
				blockedBy: prev?.blockedBy ? [...prev.blockedBy] : undefined,
				metadata: prev?.metadata ? { ...prev.metadata } : undefined,
				createdAt: prev?.createdAt ?? now,
				updatedAt: now,
			});
		}

		// A full replace removes omitted tasks, so dependency references to omitted
		// ids must be pruned as part of the same atomic update.
		const retainedIds = new Set(next.map((t) => t.id));
		for (const task of next) {
			task.blocks = pruneIds(task.blocks, retainedIds, task.id);
			task.blockedBy = pruneIds(task.blockedBy, retainedIds, task.id);
		}

		this.bumpSeqFromTasks(next);
		this.state.tasks = next;
		this.state.lastExplanation = explanation;
		this.touch();
		this.persist();
		return { ok: true, tasks: this.snapshot().tasks };
	}

	createTask(input: {
		subject: string;
		description?: string;
		activeForm?: string;
		status?: TaskStatus;
		blocks?: string[];
		blockedBy?: string[];
		metadata?: Record<string, unknown>;
	}): { ok: true; task: Task } | { ok: false; error: string } {
		const subject = input.subject?.trim();
		if (!subject) return { ok: false, error: "subject is required" };
		const status = input.status ?? "pending";
		if (!isTaskStatus(status)) return { ok: false, error: `invalid status: ${status}` };
		if (status === "in_progress") {
			const err = this.ensureSingleInProgress(undefined);
			if (err) return { ok: false, error: err };
		}
		const existingIds = new Set(this.state.tasks.map((task) => task.id));
		const dependencyError = validateDependencyIds(
			[...(input.blocks ?? []), ...(input.blockedBy ?? [])],
			existingIds,
		);
		if (dependencyError) return { ok: false, error: dependencyError };

		const now = Date.now();
		const task: Task = {
			id: this.allocId(),
			subject,
			description: input.description?.trim() || undefined,
			status,
			activeForm: input.activeForm?.trim() || undefined,
			blocks: normalizeIdList(input.blocks),
			blockedBy: normalizeIdList(input.blockedBy),
			metadata: input.metadata,
			createdAt: now,
			updatedAt: now,
		};
		this.state.tasks.push(task);
		this.touch();
		this.persist();
		return { ok: true, task: { ...task } };
	}

	updateTask(input: {
		taskId: string;
		status?: TaskStatus | "deleted";
		subject?: string;
		description?: string;
		activeForm?: string;
		addBlocks?: string[];
		addBlockedBy?: string[];
		metadata?: Record<string, unknown>;
	}): { ok: true; task: Task } | { ok: false; error: string } {
		const task = this.state.tasks.find((t) => t.id === input.taskId);
		if (!task) return { ok: false, error: `task ${input.taskId} not found` };

		if (input.status === "deleted") {
			this.state.tasks = this.state.tasks.filter((t) => t.id !== task.id);
			this.unlinkDeps(task.id);
			const removed: Task = {
				...task,
				status: "cancelled",
				updatedAt: Date.now(),
			};
			this.touch();
			this.persist();
			return { ok: true, task: removed };
		}

		// Validate every requested field before mutating the live task so a rejected
		// patch cannot partially change subject/description/metadata.
		if (input.status !== undefined && !isTaskStatus(input.status)) {
			return { ok: false, error: `invalid status: ${input.status}` };
		}
		if (input.status === "in_progress") {
			const err = this.ensureSingleInProgress(task.id);
			if (err) return { ok: false, error: err };
		}
		const nextSubject = input.subject?.trim();
		if (input.subject !== undefined && !nextSubject) {
			return { ok: false, error: "subject cannot be empty" };
		}
		const dependencyError = validateDependencyIds(
			[...(input.addBlocks ?? []), ...(input.addBlockedBy ?? [])],
			new Set(this.state.tasks.map((candidate) => candidate.id)),
			task.id,
		);
		if (dependencyError) return { ok: false, error: dependencyError };

		if (nextSubject !== undefined) task.subject = nextSubject;
		if (input.description !== undefined) {
			task.description = input.description.trim() || undefined;
		}
		if (input.activeForm !== undefined) {
			task.activeForm = input.activeForm.trim() || undefined;
		}
		if (input.status !== undefined) task.status = input.status;
		if (input.addBlocks?.length) {
			task.blocks = mergeIds(task.blocks, input.addBlocks);
		}
		if (input.addBlockedBy?.length) {
			task.blockedBy = mergeIds(task.blockedBy, input.addBlockedBy);
		}
		if (input.metadata !== undefined) {
			task.metadata = { ...(task.metadata ?? {}), ...input.metadata };
		}
		task.updatedAt = Date.now();
		this.touch();
		this.persist();
		return {
			ok: true,
			task: {
				...task,
				blocks: task.blocks ? [...task.blocks] : undefined,
				blockedBy: task.blockedBy ? [...task.blockedBy] : undefined,
			},
		};
	}

	getTask(taskId: string): Task | undefined {
		const t = this.state.tasks.find((x) => x.id === taskId);
		return t ? { ...t } : undefined;
	}

	listTasks(): Task[] {
		return this.snapshot().tasks;
	}

	boardDetails(partial?: Partial<BoardDetails>): BoardDetails {
		const s = this.snapshot();
		return {
			kind: partial?.kind ?? "state",
			action: partial?.action,
			explanation: partial?.explanation ?? s.lastExplanation,
			tasks: s.tasks,
			nextTaskSeq: s.nextTaskSeq,
			planDoc: s.planDoc,
			planDocCleared: s.planDoc === undefined,
			changedIds: partial?.changedIds,
			error: partial?.error,
		};
	}

	reconstructFromSession(ctx: ExtensionContext): void {
		const branch =
			typeof ctx.sessionManager.getBranch === "function"
				? ctx.sessionManager.getBranch()
				: ctx.sessionManager.getEntries();

		let restored: PteState | undefined;

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

			if (e.type === "custom" && e.customType === PTE_STATE_ENTRY) {
				const parsed = coerceState(e.data);
				if (parsed) restored = parsed;
				continue;
			}

			if (e.type !== "message" || e.message?.role !== "toolResult") continue;
			const toolName = e.message.toolName;
			if (!toolName || !BOARD_TOOL_NAMES.has(toolName)) continue;
			const details = e.message.details as BoardDetails | undefined;
			if (!details || !Array.isArray(details.tasks)) continue;
			const tasks = details.tasks
				.filter((task): task is Task => Boolean(task) && typeof task === "object")
				.map(normalizeTask)
				.filter((task) => task.id.length > 0 && task.subject.length > 0);
			restored = {
				tasks,
				nextTaskSeq: normalizeSequence(details.nextTaskSeq, tasks),
				planDoc: details.planDocCleared
					? undefined
					: details.planDoc ?? restored?.planDoc,
				lastExplanation: details.explanation ?? restored?.lastExplanation,
				updatedAt: Date.now(),
			};
		}

		// The first pass is chronological, so the last valid snapshot of either kind
		// wins. Do not re-prefer a custom entry: tool results can legitimately be
		// newer than the last custom entry on imported/legacy sessions.
		this.state = normalizeState(restored ?? emptyState());
		// Allow the next real mutation to persist even if it matches an older write
		// from a previous in-memory instance of the board.
		this.lastPersistedSnapshot = undefined;
	}

	private touch(): void {
		this.state.updatedAt = Date.now();
	}

	private persist(): void {
		if (!this.persistFn) return;
		const payload = this.boardDetails({ kind: "state" });
		// Drop volatile timestamps so identical boards do not rewrite session JSONL.
		const fingerprint = JSON.stringify({
			tasks: payload.tasks.map((task) => ({
				id: task.id,
				subject: task.subject,
				description: task.description,
				status: task.status,
				activeForm: task.activeForm,
				blocks: task.blocks,
				blockedBy: task.blockedBy,
				metadata: task.metadata,
			})),
			nextTaskSeq: payload.nextTaskSeq,
			planDoc: payload.planDoc
				? { title: payload.planDoc.title, body: payload.planDoc.body }
				: null,
			planDocCleared: payload.planDocCleared === true,
			lastExplanation: this.state.lastExplanation ?? null,
		});
		if (fingerprint === this.lastPersistedSnapshot) return;
		this.lastPersistedSnapshot = fingerprint;
		this.persistFn(PTE_STATE_ENTRY, payload);
	}

	private allocId(): string {
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

	private bumpSeqFromTasks(tasks: Task[]): void {
		let max = normalizeSequence(this.state.nextTaskSeq, tasks) - 1;
		for (const t of tasks) {
			const m = /^t(\d+)$/.exec(t.id);
			if (m) max = Math.max(max, Number(m[1]));
		}
		this.state.nextTaskSeq = Math.max(this.state.nextTaskSeq, max + 1);
	}

	private ensureSingleInProgress(exceptId: string | undefined): string | undefined {
		const others = this.state.tasks.filter(
			(t) => t.status === "in_progress" && t.id !== exceptId,
		);
		if (others.length > 0) {
			return `Only one task may be in_progress. Currently: ${others.map((t) => t.id).join(", ")}. Mark it completed/pending first.`;
		}
		return undefined;
	}

	private unlinkDeps(removedId: string): void {
		for (const t of this.state.tasks) {
			if (t.blocks) t.blocks = t.blocks.filter((id) => id !== removedId);
			if (t.blockedBy) t.blockedBy = t.blockedBy.filter((id) => id !== removedId);
		}
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
		blocks: normalizeIdList(raw?.blocks),
		blockedBy: normalizeIdList(raw?.blockedBy),
		metadata: raw?.metadata && typeof raw.metadata === "object" ? raw.metadata : undefined,
		createdAt: typeof raw?.createdAt === "number" && Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
		updatedAt: typeof raw?.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now(),
	};
}

function coerceState(data: unknown): PteState | undefined {
	if (!data || typeof data !== "object") return undefined;
	const d = data as Partial<PteState> & BoardDetails;
	if (!Array.isArray(d.tasks)) return undefined;
	const tasks = d.tasks
		.filter((task): task is Task => Boolean(task) && typeof task === "object")
		.map(normalizeTask)
		.filter((task) => task.id.length > 0 && task.subject.length > 0);
	return normalizeState({
		tasks,
		nextTaskSeq: d.nextTaskSeq,
		planDoc: d.planDocCleared ? undefined : d.planDoc,
		lastExplanation: d.lastExplanation ?? d.explanation,
		updatedAt: typeof d.updatedAt === "number" ? d.updatedAt : Date.now(),
	});
}

function normalizeState(state: PteState): PteState {
	state.nextTaskSeq = normalizeSequence(state.nextTaskSeq, state.tasks);
	const retainedIds = new Set(state.tasks.map((task) => task.id));
	let hasActive = false;
	for (const task of state.tasks) {
		task.blocks = pruneIds(task.blocks, retainedIds, task.id);
		task.blockedBy = pruneIds(task.blockedBy, retainedIds, task.id);
		if (task.status !== "in_progress") continue;
		if (!hasActive) {
			hasActive = true;
		} else {
			// Repair malformed/imported snapshots deterministically while preserving
			// every task. Subsequent active tasks return to pending.
			task.status = "pending";
		}
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

export function renderAgentContext(state: PteState): string {
	const lines: string[] = [];

	if (state.tasks.length > 0) {
		lines.push("[TASK BOARD]");
		lines.push(
			"Use the available structured planning tools to keep this board current.",
		);
		lines.push(
			"Keep at most one task in_progress. Mark steps completed as you finish them; rewrite the board when scope changes.",
		);
	}

	if (state.tasks.length > 0) {
		lines.push("");
		lines.push("Current tasks:");
		lines.push(formatTaskList(state.tasks));
	}

	if (state.planDoc?.body) {
		const body = state.planDoc.body;
		const snippet =
			body.length > 4000 ? `${body.slice(0, 4000)}\n…(truncated)` : body;
		lines.push("");
		lines.push(
			`Living plan document${state.planDoc.title ? `: ${state.planDoc.title}` : ""}:`,
		);
		lines.push(snippet);
	}

	if (state.lastExplanation) {
		lines.push("");
		lines.push(`Last plan note: ${state.lastExplanation}`);
	}

	return lines.join("\n");
}
