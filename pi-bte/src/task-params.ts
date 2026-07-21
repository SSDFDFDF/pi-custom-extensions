/**
 * Runtime normalization of task tool items[] by action.
 */

import { isTaskStatus, type TaskStatus } from "./types.ts";

export function asStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.map(String);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeCreateItems(
	raw: unknown,
):
	| {
			ok: true;
			value: Array<{
				subject: string;
				description?: string;
				activeForm?: string;
				status?: TaskStatus;
				blocks?: string[];
				blockedBy?: string[];
			}>;
	  }
	| { ok: false; error: string } {
	if (!Array.isArray(raw) || raw.length === 0) {
		return { ok: false, error: "items must be a non-empty array" };
	}
	const value = [];
	for (let i = 0; i < raw.length; i++) {
		const it = raw[i];
		if (!isPlainObject(it)) {
			return { ok: false, error: `items[${i}] must be an object` };
		}
		const taskId =
			typeof it.taskId === "string" && it.taskId.trim() ? it.taskId.trim() : "";
		if (taskId) {
			return {
				ok: false,
				error: `items[${i}]: create does not take taskId (use action=update to patch ${taskId})`,
			};
		}
		if (typeof it.id === "string" && it.id.trim()) {
			return {
				ok: false,
				error: `items[${i}]: create does not take id (ids are assigned automatically)`,
			};
		}
		const subject = typeof it.subject === "string" ? it.subject : "";
		if (!subject.trim()) {
			return { ok: false, error: `items[${i}]: subject is required for create` };
		}
		if (it.status !== undefined && !isTaskStatus(it.status)) {
			return { ok: false, error: `items[${i}]: invalid status` };
		}
		value.push({
			subject,
			description: typeof it.description === "string" ? it.description : undefined,
			activeForm: typeof it.activeForm === "string" ? it.activeForm : undefined,
			status: it.status as TaskStatus | undefined,
			blocks: asStringArray(it.blocks),
			blockedBy: asStringArray(it.blockedBy),
		});
	}
	return { ok: true, value };
}

export function normalizeUpdateItems(
	raw: unknown,
):
	| {
			ok: true;
			value: Array<{
				taskId: string;
				status?: TaskStatus | "deleted";
				subject?: string;
				description?: string;
				activeForm?: string;
				boardId?: string;
				addBlocks?: string[];
				addBlockedBy?: string[];
				removeBlocks?: string[];
				removeBlockedBy?: string[];
			}>;
	  }
	| { ok: false; error: string } {
	if (!Array.isArray(raw) || raw.length === 0) {
		return { ok: false, error: "items must be a non-empty array" };
	}
	const value = [];
	for (let i = 0; i < raw.length; i++) {
		const it = raw[i];
		if (!isPlainObject(it)) {
			return { ok: false, error: `items[${i}] must be an object` };
		}
		const taskId = typeof it.taskId === "string" ? it.taskId.trim() : "";
		if (!taskId) {
			const looksLikeCreate =
				typeof it.subject === "string" && it.subject.trim().length > 0;
			return {
				ok: false,
				error: looksLikeCreate
					? `items[${i}]: update needs taskId (got subject only — use action=create to append)`
					: `items[${i}]: taskId is required for update`,
			};
		}
		if (
			it.status !== undefined &&
			it.status !== "deleted" &&
			!isTaskStatus(it.status)
		) {
			return { ok: false, error: `items[${i}]: invalid status` };
		}
		value.push({
			taskId,
			status: it.status as TaskStatus | "deleted" | undefined,
			subject: typeof it.subject === "string" ? it.subject : undefined,
			description: typeof it.description === "string" ? it.description : undefined,
			activeForm: typeof it.activeForm === "string" ? it.activeForm : undefined,
			boardId: typeof it.boardId === "string" ? it.boardId : undefined,
			addBlocks: asStringArray(it.addBlocks),
			addBlockedBy: asStringArray(it.addBlockedBy),
			removeBlocks: asStringArray(it.removeBlocks),
			removeBlockedBy: asStringArray(it.removeBlockedBy),
		});
	}
	return { ok: true, value };
}
