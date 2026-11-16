/**
 * session-prune — operation records and application.
 *
 * Every prune writes an append-only ledger entry (a `custom` session entry) that
 * lists what it hid, so `undo` can put those exact rows back without guessing
 * which context edits were ours. Actual edits become `context_edit` entries:
 * Pi applies them to the model context while raw history, the transcript and
 * exports keep every message.
 */

import { randomBytes } from "node:crypto";
import type { SessionBoundaryDraft, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { PrunePlan, Selector } from "./plan.ts";

/** `customType` for both the ledger entries and the model-visible marker. */
export const CUSTOM_TYPE = "session-prune";

export interface PruneTarget {
	entryId: string;
	/** What the decision did, so undo knows whether content must be reset too. */
	action: "omit" | "replace";
}

export interface PruneRecord {
	kind: "prune";
	opId: string;
	at: string;
	note?: string;
	targets: PruneTarget[];
	/** Rows that became hidden. */
	hidden: number;
	/** Rows that became visible again (restore). */
	restored: number;
	kept: number;
	editable: number;
	freedTokens: number;
}

export interface UndoRecord {
	kind: "undo";
	opId: string;
	/** `opId` of the prune being undone. */
	of: string;
	at: string;
	restored: number;
}

export type PruneLedgerEntry = PruneRecord | UndoRecord;

export function newOpId(): string {
	return randomBytes(4).toString("hex");
}

export function pruneRecord(plan: PrunePlan, opId: string, note?: string): PruneRecord {
	return {
		kind: "prune",
		opId,
		at: new Date().toISOString(),
		...(note ? { note } : {}),
		targets: plan.decisions.map((decision) => ({ entryId: decision.entryId, action: decision.action })),
		hidden: plan.decisions.filter((decision) => decision.action === "omit").length,
		restored: plan.decisions.filter((decision) => decision.reason === "restored").length,
		kept: plan.visibleAfter,
		editable: plan.editableCount,
		freedTokens: Math.max(0, plan.tokensBefore - plan.tokensAfter),
	};
}

/** The boundary drafts that realize a plan: ledger record, edits, marker. */
export function planDrafts(plan: PrunePlan, record: PruneLedgerEntry, marker?: string): SessionBoundaryDraft[] {
	const drafts: SessionBoundaryDraft[] = [{ type: "custom", customType: CUSTOM_TYPE, data: record }];
	for (const decision of plan.decisions) {
		// Fail loudly instead of emitting a batch that is missing one edit: a partial
		// plan could leave a tool result without its call. The planner cannot produce
		// this (a replace always carries content).
		if (decision.action === "replace" && decision.content === undefined) {
			throw new Error(`cannot apply a replace decision for ${decision.entryId}: no replacement content`);
		}
		drafts.push({
			type: "context_edit",
			targetId: decision.entryId,
			replacement: decision.action === "omit" ? null : { content: decision.content as never },
		});
	}
	if (marker !== undefined && marker.length > 0) {
		drafts.push({ type: "custom_message", customType: CUSTOM_TYPE, content: marker, display: true, details: { opId: record.opId } });
	}
	return drafts;
}

/**
 * Whether a batch would omit one of the entries that must stay visible.
 *
 * This is deliberately all-or-nothing instead of a per-draft filter: dropping a
 * single omission from a plan could leave a tool result without its call (or the
 * reverse) and produce a transcript providers reject. The planner already keeps
 * those entries visible, so a violation means the plan is unsafe and the whole
 * batch must be refused.
 */
export function protectedOmission(drafts: SessionBoundaryDraft[], protectedIds: Iterable<string>): string | undefined {
	const protectedSet = new Set(protectedIds);
	if (protectedSet.size === 0) return undefined;
	for (const draft of drafts) {
		if (draft.type === "context_edit" && draft.replacement === null && protectedSet.has(draft.targetId)) return draft.targetId;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export interface Ledger {
	prunes: Array<{ entryId: string; data: PruneRecord }>;
	undos: Array<{ entryId: string; data: UndoRecord }>;
}

function recordData(entry: SessionEntry): PruneLedgerEntry | undefined {
	if (entry.type !== "custom" || entry.customType !== CUSTOM_TYPE) return undefined;
	const data = entry.data as PruneLedgerEntry | undefined;
	if (data === null || typeof data !== "object") return undefined;
	if (data.kind === "prune" || data.kind === "undo") return data;
	return undefined;
}

export function readLedger(branch: SessionEntry[]): Ledger {
	const ledger: Ledger = { prunes: [], undos: [] };
	for (const entry of branch) {
		const data = recordData(entry);
		if (data?.kind === "prune") ledger.prunes.push({ entryId: entry.id, data });
		else if (data?.kind === "undo") ledger.undos.push({ entryId: entry.id, data });
	}
	return ledger;
}

/** The prune a plain `undo` targets: the newest one that was not undone yet. */
export function findPruneToUndo(ledger: Ledger, opId?: string): { entryId: string; data: PruneRecord } {
	const undone = new Set(ledger.undos.map((undo) => undo.data.of));
	if (opId !== undefined && opId.length > 0) {
		const found = ledger.prunes.find((prune) => prune.data.opId === opId);
		if (found === undefined) throw new Error(`no prune operation ${JSON.stringify(opId)} on this branch`);
		if (undone.has(opId)) throw new Error(`operation ${opId} was already undone`);
		return found;
	}
	const candidate = [...ledger.prunes].reverse().find((prune) => !undone.has(prune.data.opId));
	if (candidate === undefined) throw new Error("nothing to undo: no prune operation is waiting");
	return candidate;
}

export function undoRecord(record: PruneRecord, opId: string): UndoRecord {
	return { kind: "undo", opId, of: record.opId, at: new Date().toISOString(), restored: record.targets.length };
}

/** Restore request for a prune record. */
export function undoRequest(record: PruneRecord): { restore: Selector } {
	return { restore: { entryIds: record.targets.map((target) => target.entryId) } };
}

/**
 * The command path writes to the real `SessionManager` behind the read-only view
 * `ctx.sessionManager` exposes, exactly like `/tree` navigation does internally.
 * Context edits and custom messages have no command-only API; the runner types
 * them as read-only because lifecycle handlers must not append them mid-run.
 */
export interface WritableSession {
	appendContextEdit(targetId: string, replacement: { content: unknown } | null): string;
	appendCustomMessageEntry(customType: string, content: unknown, display: boolean, details?: unknown): string;
}

export interface AppendApi {
	appendEntry(customType: string, data?: unknown): void;
}

/** Context edits and custom messages need the real session manager; ledger entries use the public API. */
export function writableSession(session: unknown): WritableSession | undefined {
	const candidate = session as Partial<WritableSession> | undefined;
	if (candidate !== undefined && typeof candidate.appendContextEdit === "function" && typeof candidate.appendCustomMessageEntry === "function") {
		return candidate as WritableSession;
	}
	return undefined;
}

/** Apply drafts to a live, idle session. Returns the number of appended entries. */
export function appendDrafts(api: AppendApi, session: WritableSession, drafts: SessionBoundaryDraft[]): number {
	let count = 0;
	for (const draft of drafts) {
		switch (draft.type) {
			case "custom":
				api.appendEntry(draft.customType, draft.data);
				count += 1;
				break;
			case "context_edit":
				session.appendContextEdit(draft.targetId, draft.replacement as { content: unknown } | null);
				count += 1;
				break;
			case "custom_message":
				session.appendCustomMessageEntry(draft.customType, draft.content, draft.display, draft.details);
				count += 1;
				break;
			default:
				break;
		}
	}
	return count;
}
