/**
 * Session error-entry cleaning — pure logic + file ops, no pi imports.
 *
 * pi session files are append-only JSONL trees: every entry after the session
 * header has an `id` and a `parentId` pointing at the previous entry of its
 * branch. pi offers no API to modify or delete persisted entries, so cleaning
 * rewrites the file directly:
 *
 * - matched error entries (assistant messages with stopReason "error") are dropped
 * - every surviving entry whose parentId pointed at a dropped entry is relinked
 *   to its nearest surviving ancestor
 * - on load pi derives the active leaf from the last line and walks parentId
 *   links to the root, so a relinked file resumes as a clean linear branch
 *
 * Unparseable lines are preserved verbatim so a rewrite never loses bytes that
 * were there before (pi's own loader skips them too).
 */

import { copyFileSync, existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SessionEntryLike {
	type?: string;
	id?: string;
	parentId?: string | null;
	message?: {
		role?: string;
		stopReason?: string;
		errorMessage?: unknown;
		[key: string]: unknown;
	};
	[key: string]: unknown;
}

/** An unparseable line carried through a rewrite untouched. */
export interface RawLineEntry {
	__raw: string;
}

export interface CleanFilter {
	/**
	 * Only remove error messages whose errorMessage matches this regex.
	 * Undefined/empty matches every error entry.
	 */
	pattern?: RegExp;
}

export interface RemovedError {
	id?: string;
	timestamp?: unknown;
	/** First line of errorMessage, truncated for display. */
	preview: string;
}

export interface CleanPlan {
	/** Total parsed entries before cleaning. */
	total: number;
	/** Surviving entries with relinked parentIds, in original order. */
	kept: SessionEntryLike[];
	/** Error entries selected for removal, in original order. */
	removed: RemovedError[];
	/** Survivors whose parentId had to be patched. */
	relinked: number;
}

export interface CleanFileOptions {
	/** Write `<file>.bak` next to the session file before rewriting. Default false. */
	backup?: boolean;
	/** Compute the plan only; never touch the file. Default false. */
	dryRun?: boolean;
}

export interface CleanFileResult {
	file: string;
	plan: CleanPlan;
	/** Whether the file was actually rewritten (false for dry runs and clean sessions). */
	rewritten: boolean;
	/** Path of the backup written, when any. */
	backupFile?: string;
	bytesBefore: number;
	bytesAfter: number;
}

export function parseSessionText(text: string): Array<SessionEntryLike | RawLineEntry> {
	const out: Array<SessionEntryLike | RawLineEntry> = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			out.push(JSON.parse(trimmed) as SessionEntryLike);
		} catch {
			out.push({ __raw: trimmed });
		}
	}
	return out;
}

export function serializeEntries(entries: Array<SessionEntryLike | RawLineEntry>): string {
	const body = entries.map((e) => ("__raw" in e ? e.__raw : JSON.stringify(e))).join("\n");
	return body ? `${body}\n` : "";
}

export function isSessionFileHeader(entry: SessionEntryLike | RawLineEntry): boolean {
	return !("__raw" in entry) && entry.type === "session";
}

export function isErrorEntry(entry: SessionEntryLike | RawLineEntry, filter: CleanFilter): boolean {
	if ("__raw" in entry) return false;
	if (entry.type !== "message") return false;
	const message = entry.message;
	if (!message || message.role !== "assistant" || message.stopReason !== "error") return false;
	if (filter.pattern) {
		const text = typeof message.errorMessage === "string" ? message.errorMessage : "";
		if (!filter.pattern.test(text)) return false;
	}
	return true;
}

export function planClean(
	entries: Array<SessionEntryLike | RawLineEntry>,
	filter: CleanFilter = {},
): CleanPlan {
	// removedId -> its original parentId; resolves relink targets through
	// chains of consecutive removals (err1 -> err2 -> err3 -> model_change).
	const removedParent = new Map<string, string | null>();
	for (const entry of entries) {
		if (!isErrorEntry(entry, filter)) continue;
		if (typeof entry.id !== "string") continue; // not addressable; keep it
		removedParent.set(entry.id, entry.parentId ?? null);
	}

	const resolveParent = (id: string | null): string | null => {
		let cur = id;
		let guard = 0;
		while (cur !== null && removedParent.has(cur)) {
			if (++guard > entries.length) return null; // cycle safety on hand-edited files
			cur = removedParent.get(cur) ?? null;
		}
		return cur;
	};

	const kept: Array<SessionEntryLike | RawLineEntry> = [];
	const removed: RemovedError[] = [];
	let relinked = 0;
	for (const entry of entries) {
		if (!("__raw" in entry) && typeof entry.id === "string" && removedParent.has(entry.id)) {
			removed.push({
				id: entry.id,
				timestamp: entry.timestamp,
				preview: previewErrorMessage(entry.message?.errorMessage),
			});
			continue;
		}
		const parent = entry.parentId ?? null;
		const resolved = resolveParent(parent);
		if (parent !== null && resolved !== parent) {
			kept.push({ ...entry, parentId: resolved });
			relinked++;
		} else {
			kept.push(entry);
		}
	}

	return { total: entries.length, kept, removed, relinked };
}

function previewErrorMessage(value: unknown, max = 120): string {
	const text = typeof value === "string" ? value : "(no errorMessage)";
	const firstLine = text.split("\n", 1)[0] ?? "";
	return firstLine.length > max ? `${firstLine.slice(0, max)}…` : firstLine;
}

/**
 * Clean one session file in place.
 *
 * Throws if the file does not exist or its first entry is not a pi session
 * header — foreign files are never rewritten.
 */
export function cleanSessionFile(file: string, filter: CleanFilter = {}, options: CleanFileOptions = {}): CleanFileResult {
	const bytesBefore = statSync(file).size;
	const text = readFileSync(file, "utf8");
	const entries = parseSessionText(text);
	if (entries.length === 0 || !isSessionFileHeader(entries[0])) {
		throw new Error(`not a pi session file (first line is not a session header): ${file}`);
	}

	const plan = planClean(entries, filter);
	if (options.dryRun || plan.removed.length === 0) {
		return { file, plan, rewritten: false, bytesBefore, bytesAfter: bytesBefore };
	}

	const backupFile = options.backup ? `${file}.bak` : undefined;
	if (backupFile) copyFileSync(file, backupFile);

	const next = serializeEntries(plan.kept);
	const tmp = `${file}.clean-tmp`;
	writeFileSync(tmp, next);
	renameSync(tmp, file);

	return { file, plan, rewritten: true, backupFile, bytesBefore, bytesAfter: Buffer.byteLength(next) };
}

/**
 * Find session files under a sessions root (`~/.pi/agent/sessions`) whose file
 * name (`<timestamp>_<sessionId>.jsonl`) contains the target id/prefix.
 * Exact `_<target>.jsonl` suffix matches are preferred and returned alone.
 */
export function findSessionFiles(sessionsRoot: string, target: string): string[] {
	if (!existsSync(sessionsRoot)) return [];
	const exact: string[] = [];
	const partial: string[] = [];
	for (const dir of readdirSync(sessionsRoot, { withFileTypes: true })) {
		if (!dir.isDirectory()) continue;
		const dirPath = join(sessionsRoot, dir.name);
		for (const name of readdirSync(dirPath)) {
			if (!name.endsWith(".jsonl")) continue;
			if (name.endsWith(`_${target}.jsonl`)) exact.push(join(dirPath, name));
			else if (name.includes(target)) partial.push(join(dirPath, name));
		}
	}
	return exact.length > 0 ? exact : partial;
}

/** Every kept entry's parentId must reference a kept entry (or be a root null). */
export function verifyParentChain(entries: Array<SessionEntryLike | RawLineEntry>): { ok: boolean; dangling: string[] } {
	const ids = new Set<string>();
	for (const entry of entries) if (!("__raw" in entry) && typeof entry.id === "string") ids.add(entry.id);
	const dangling: string[] = [];
	for (const entry of entries) {
		if ("__raw" in entry) continue;
		const parent = entry.parentId ?? null;
		if (parent !== null && !ids.has(parent)) dangling.push(`${entry.id ?? "?"} -> ${parent}`);
	}
	return { ok: dangling.length === 0, dangling };
}
