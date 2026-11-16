/**
 * session-prune — text output for the tool, the command and the model-visible
 * marker. Everything here is pure so the wording can be unit tested.
 */

import type { PrunePlan, PruneRow } from "./plan.ts";

export function formatTokens(tokens: number): string {
	if (!Number.isFinite(tokens)) return "?";
	const value = Math.round(tokens);
	if (Math.abs(value) < 1000) return String(value);
	return `${(value / 1000).toFixed(1)}k`;
}

/** Compact list of kept rows; long lists collapse to a count to stay cheap. */
export function formatKept(indices: number[], max = 8): string {
	if (indices.length === 0) return "none";
	if (indices.length > max) return `${indices.length} rows`;
	return formatIndexRanges(indices);
}

function shortId(entryId: string): string {
	return entryId.length > 6 ? entryId.slice(0, 6) : entryId;
}

/** Compact index list: [0,2,3,4,9] -> "0, 2-4, 9". */
export function formatIndexRanges(indices: number[]): string {
	if (indices.length === 0) return "none";
	const sorted = [...indices].sort((a, b) => a - b);
	const parts: string[] = [];
	let start = sorted[0];
	let previous = sorted[0];
	for (let i = 1; i <= sorted.length; i += 1) {
		const current = sorted[i];
		if (current === previous + 1) {
			previous = current;
			continue;
		}
		parts.push(start === previous ? `#${start}` : `#${start}-${previous}`);
		if (current === undefined) break;
		start = current;
		previous = current;
	}
	return parts.join(", ");
}

export interface ListingOptions {
	/** Maximum number of rows to print (default 60). */
	maxRows?: number;
	/** Print every row. */
	all?: boolean;
	/** Only print rows whose preview matches this regular expression. */
	match?: string;
	/** Snapshot number to echo back to `apply`. */
	snapshot?: number;
}

function rowLine(row: PruneRow, widths: { id: number; state: number; role: number; tokens: number }): string {
	const state = !row.editable ? "locked" : row.visible ? "live" : "hidden";
	const role = row.role === "toolResult" && row.toolName ? `toolResult(${row.toolName})` : row.role;
	const index = String(row.index).padStart(3, " ");
	const id = shortId(row.entryId).padEnd(widths.id, " ");
	const stateText = state.padEnd(widths.state, " ");
	const roleText = role.padEnd(widths.role, " ");
	const tokens = formatTokens(row.tokens).padStart(widths.tokens, " ");
	const flags: string[] = [];
	if (row.currentTurn) flags.push("current turn");
	const suffix = flags.length > 0 ? `  [${flags.join(", ")}]` : "";
	return `${index}  ${id}  ${stateText}  ${roleText}  ${tokens}  ${row.text}${suffix}`;
}

/** The `list` output: a table of context rows plus the hints the model needs. */
export function formatListing(rows: PruneRow[], options: ListingOptions = {}): string {
	const editable = rows.filter((row) => row.editable);
	const locked = rows.length - editable.length;
	const editableLive = editable.filter((row) => row.visible).length;
	const editableHidden = editable.length - editableLive;
	const liveTokens = rows.filter((row) => row.visible).reduce((total, row) => total + row.tokens, 0);
	const allTokens = rows.reduce((total, row) => total + row.tokens, 0);
	const header =
		`rows ${rows.length} · ${editableLive} live · ${editableHidden} hidden` +
		`${locked > 0 ? ` · ${locked} locked` : ""} · ~${formatTokens(liveTokens)} of ~${formatTokens(allTokens)} tokens visible`;

	let selected = rows;
	if (options.match !== undefined && options.match.length > 0) {
		let regex: RegExp;
		try {
			regex = new RegExp(options.match, "i");
		} catch (error) {
			throw new Error(`invalid match regex: ${error instanceof Error ? error.message : String(error)}`);
		}
		selected = rows.filter((row) => regex.test(row.text) || regex.test(row.entryId));
	}

	const maxRows = options.all === true ? Number.POSITIVE_INFINITY : Math.max(1, options.maxRows ?? 60);
	const elided = selected.length > maxRows;
	let windowed = selected;
	if (elided) {
		const head = Math.min(5, Math.floor(maxRows / 3));
		const tail = maxRows - head;
		windowed = [...selected.slice(0, head), ...selected.slice(selected.length - tail)];
	}

	const widths = {
		id: Math.max(6, ...windowed.map((row) => shortId(row.entryId).length)),
		state: 6,
		role: Math.max(6, ...windowed.map((row) => (row.role === "toolResult" && row.toolName ? `toolResult(${row.toolName})`.length : row.role.length))),
		tokens: 4,
	};
	const lines = [header, "", `#    id${" ".repeat(widths.id - 2)}  state   role${" ".repeat(Math.max(0, widths.role - 4))}  tokens  preview`];
	for (let i = 0; i < windowed.length; i += 1) {
		if (elided && i === Math.min(5, Math.floor(maxRows / 3))) {
			lines.push(`     … ${selected.length - windowed.length} rows not shown (use all=true or match=) …`);
		}
		lines.push(rowLine(windowed[i], widths));
	}
	lines.push("");
	lines.push(
		'apply with {keep:{…}} to keep only what you name, or {drop:{…}} to hide what you name. ' +
			'Fields AND, arrays OR: {drop:{roles:["toolResult"]}} hides every tool result, {keep:{turns:1}} keeps the last user turn. ' +
			"ids or row numbers may be used.",
	);
	if (options.snapshot !== undefined) {
		lines.push(`snapshot ${options.snapshot} — pass it to apply; a different value means the context changed since this listing.`);
	}
	return lines.join("\n");
}

/** The `apply` tool result / command summary. */
export function formatPlan(plan: PrunePlan, options: { dryRun?: boolean; opId?: string; note?: string } = {}): string {
	const omitted: number[] = [];
	const replaced: number[] = [];
	const restored: number[] = [];
	for (const decision of plan.decisions) {
		if (decision.action === "omit") omitted.push(decision.index);
		else if (decision.reason === "restored") restored.push(decision.index);
		else replaced.push(decision.index);
	}
	const parts: string[] = [];
	if (omitted.length > 0) parts.push(`omit ${formatIndexRanges(omitted)}`);
	if (replaced.length > 0) parts.push(`replace ${formatIndexRanges(replaced)}`);
	if (restored.length > 0) parts.push(`restore ${formatIndexRanges(restored)}`);

	const lines: string[] = [];
	const headline = options.dryRun === true ? "dry run — nothing was changed" : `context updated${options.opId ? ` (op ${options.opId})` : ""}`;
	lines.push(
		`${headline}: ${plan.decisions.length} change${plan.decisions.length === 1 ? "" : "s"} · ` +
			`${plan.visibleAfter} of ${plan.editableCount} editable rows visible · ` +
			`~${formatTokens(plan.tokensAfter)} tokens now visible (was ~${formatTokens(plan.tokensBefore)})`,
	);
	if (parts.length > 0) lines.push(`  ${parts.join(" · ")}`);
	if (options.note) lines.push(`  note: ${options.note}`);

	const keptRanges = formatKept(plan.keptIndices);
	if (keptRanges !== "none") lines.push(`  kept ${keptRanges}`);
	for (const warning of plan.warnings.slice(0, 6)) lines.push(`  ! ${warning}`);
	if (plan.warnings.length > 6) lines.push(`  ! … ${plan.warnings.length - 6} more`);
	if (options.dryRun !== true && plan.decisions.length > 0) {
		lines.push(
			`Row numbers shift after this prune; re-run the listing before using indices. ` +
				`Undo: action="undo"${options.opId ? ` opId="${options.opId}"` : ""} · /prune undo`,
		);
	}
	return lines.join("\n");
}

/** Model-visible marker appended after a prune (custom message). */
export function formatMarker(plan: PrunePlan, options: { opId?: string } = {}): string {
	const hidden = plan.decisions.filter((decision) => decision.action === "omit").map((decision) => decision.index);
	const freed = Math.max(0, plan.tokensBefore - plan.tokensAfter);
	const lines = [
		`[session-prune] context trimmed: ${hidden.length} message${hidden.length === 1 ? "" : "s"} omitted (~${formatTokens(freed)} tokens freed), ` +
			`${plan.visibleAfter} of ${plan.editableCount} rows kept.`,
	];
	const kept = formatKept(plan.keptIndices, 6);
	if (kept !== "none") lines.push(`kept ${kept}`);
	lines.push(`restore with session_prune action="undo"${options.opId ? ` opId="${options.opId}"` : ""}`);
	return lines.join(" · ");
}

/** Model-visible marker appended after a restore (undo). */
export function formatRestoreMarker(plan: PrunePlan, options: { opId?: string; of?: string } = {}): string {
	const restored = plan.decisions.length;
	const tokens = Math.max(0, plan.tokensAfter - plan.tokensBefore);
	const origin = options.of === undefined ? "" : ` (undo of ${options.of})`;
	return (
		`[session-prune] context restored: ${restored} message${restored === 1 ? "" : "s"} put back` +
		`${tokens > 0 ? ` (~${formatTokens(tokens)} tokens)` : ""}${origin}${options.opId === undefined ? "" : ` · op ${options.opId}`}.`
	);
}

/** Marker for any plan: a trim when rows were hidden, a restore otherwise. */
export function markerForPlan(plan: PrunePlan, options: { opId?: string; of?: string } = {}): string {
	return plan.decisions.some((decision) => decision.action === "omit") ? formatMarker(plan, options) : formatRestoreMarker(plan, options);
}

export interface StatusInput {
	config: string;
	rows: PruneRow[];
	pruneOps: number;
	undoOps: number;
	lastOp?: { opId: string; at: string; hidden: number; freedTokens: number };
}

export function formatStatus(input: StatusInput): string {
	const editable = input.rows.filter((row) => row.editable);
	const liveTokens = input.rows.filter((row) => row.visible).reduce((total, row) => total + row.tokens, 0);
	const allTokens = input.rows.reduce((total, row) => total + row.tokens, 0);
	const lines = [
		"session-prune status",
		`  config: ${input.config}`,
		`  context: ${input.rows.length} rows · ${editable.filter((row) => row.visible).length}/${editable.length} editable live · ~${formatTokens(liveTokens)} of ~${formatTokens(allTokens)} tokens visible`,
		`  history: ${input.pruneOps} prune op(s), ${input.undoOps} undo op(s)`,
	];
	if (input.lastOp) {
		lines.push(
			`  last: ${input.lastOp.opId} (${input.lastOp.hidden} rows hidden, ~${formatTokens(input.lastOp.freedTokens)} freed, ${input.lastOp.at})`,
		);
	}
	return lines.join("\n");
}
