/**
 * session-prune — pure prune planning.
 *
 * A *row* is one model-visible message together with the session entry that owns
 * it. The planner takes the rows of the current session context plus a request
 * (`keep` = whitelist, `drop` = blacklist) and returns the `context_edit`
 * operations that make the model context match the request.
 *
 * Rules that keep the result valid for every provider:
 *
 * - An assistant tool call and its tool results are trimmed together. Dropping a
 *   result removes the call from the assistant message (its text stays); an
 *   assistant message whose calls are all gone loses the empty shell.
 * - A tool result is dropped when its call is no longer retained, so no orphan
 *   results or unanswered calls can reach the provider.
 * - A currently hidden message is restored by replacing it with its original
 *   content, which is how `undo` works on the append-only session tree.
 * - Protected rows (the assistant message that requested the prune, the last
 *   user message in whitelist mode) are never hidden.
 *
 * The module is dependency-free so it can be unit tested with plain objects.
 */

/** A content block as stored in session messages. Only fields the planner reads are typed. */
export interface ContentBlock {
	type?: string;
	id?: string;
	name?: string;
	text?: string;
	thinking?: string;
	signature?: string;
	[key: string]: unknown;
}

export type MessageContent = string | ContentBlock[];

/** Row roles: the four editable ones plus the read-only entries that occupy context space. */
export type RowRole =
	| "user"
	| "assistant"
	| "toolResult"
	| "custom"
	| "bash"
	| "summary"
	| "compaction"
	| "branch";

export interface RowToolCall {
	id: string;
	name: string;
}

/** One model-visible message (or read-only context entry) with its source entry. */
export interface PruneRow {
	/** Position in the model-visible listing; what `indices` / `range` refer to. */
	index: number;
	entryId: string;
	role: RowRole;
	/** Editable rows can be omitted or replaced by a context edit. */
	editable: boolean;
	/** Currently visible in the model context (`false` = already hidden by an edit). */
	visible: boolean;
	/** Never hidden: the assistant message handling this prune, or a protected turn. */
	hideProtected: boolean;
	/** Belongs to the turn that is still running. */
	currentTurn: boolean;
	tokens: number;
	/** One-line preview used by the listing and `match`. */
	text: string;
	/** Assistant rows: tool calls in the content that is visible (or would become visible). */
	toolCalls?: RowToolCall[];
	/** Tool result rows. */
	toolCallId?: string;
	toolName?: string;
	/** Original stored content, used to restore a hidden row. */
	rawContent?: MessageContent;
	/** Content the row currently contributes (post-edit) or would contribute when restored. */
	content?: MessageContent;
}

/**
 * Row selection. Fields are ANDed, array values are ORed, and a selector with no
 * fields matches nothing (so an accidental empty selector is an error, not "all").
 */
export interface Selector {
	/** Entry ids from the listing; unique prefixes are accepted. */
	entryIds?: string[];
	/** Row numbers from the listing; negative values count from the end (-1 = last). */
	indices?: number[];
	/** Inclusive row range; a single value is read as [n, n]. */
	range?: number[];
	/** `user`, `assistant`, `toolResult`, `custom`, `bash`, `summary`, `compaction`, `branch`. */
	roles?: string[];
	/** Tool names: matches tool results and assistant messages that called them. */
	tools?: string[];
	/** Regular expression over the row preview. */
	match?: string;
	/** The last N rows. */
	lastMessages?: number;
	/** From the Nth-last user message onwards. */
	turns?: number;
	/** Rows before this row number. */
	beforeIndex?: number;
	/** Rows after this row number. */
	afterIndex?: number;
}

export interface PruneRequest {
	/** Whitelist: rows to keep; every other editable row is hidden. */
	keep?: Selector;
	/** Put these rows back, restoring their original stored content. */
	restore?: Selector;
	/** Blacklist: rows to hide, applied last so it wins over `keep` and `restore`. */
	drop?: Selector;
}

export interface PlanOptions {
	/** Keep the newest user message visible when `keep` is used. Default true. */
	protectLastUser?: boolean;
	/** Closure convergence guard. */
	maxRounds?: number;
}

/** Why a decision was produced. */
export type PlanReason = "hidden" | "restored" | "calls-stripped";

export interface PlanDecision {
	index: number;
	entryId: string;
	action: "omit" | "replace";
	reason: PlanReason;
	/** Replacement content for `replace`. */
	content?: MessageContent;
}

export interface PrunePlan {
	decisions: PlanDecision[];
	editableCount: number;
	visibleBefore: number;
	visibleAfter: number;
	tokensBefore: number;
	tokensAfter: number;
	/** Editable rows visible after the plan. */
	keptIndices: number[];
	warnings: string[];
}

// ---------------------------------------------------------------------------
// Content helpers
// ---------------------------------------------------------------------------

/** Normalize message content to a block array. */
export function toBlocks(content: MessageContent | undefined): ContentBlock[] {
	if (content === undefined) return [];
	if (typeof content === "string") return content.length > 0 ? [{ type: "text", text: content }] : [];
	return content;
}

/** Structural equality that is cheap for the large (image) blocks we must not stringify. */
export function contentEqual(a: MessageContent | undefined, b: MessageContent | undefined): boolean {
	if (a === b) return true;
	if (a === undefined || b === undefined) return false;
	if (typeof a === "string" || typeof b === "string") return a === b;
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) {
		const left = a[i];
		const right = b[i];
		if (left === right) continue;
		if (left.type !== right.type || left.text !== right.text || left.thinking !== right.thinking) return false;
		if (left.id !== right.id || left.signature !== right.signature) return false;
	}
	return true;
}

/** Tool calls contained in a content value. */
export function toolCallsIn(content: MessageContent | undefined): RowToolCall[] {
	const calls: RowToolCall[] = [];
	for (const block of toBlocks(content)) {
		if (block.type === "toolCall" && typeof block.id === "string") {
			calls.push({ id: block.id, name: typeof block.name === "string" ? block.name : "?" });
		}
	}
	return calls;
}

/** Remove the given tool calls, keeping every other block. */
export function stripToolCalls(content: MessageContent | undefined, ids: Set<string>): ContentBlock[] {
	return toBlocks(content).filter((block) => !(block.type === "toolCall" && typeof block.id === "string" && ids.has(block.id)));
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

const ROLE_ALIASES: Record<string, RowRole> = {
	user: "user",
	human: "user",
	assistant: "assistant",
	ai: "assistant",
	tool: "toolResult",
	tools: "toolResult",
	toolresult: "toolResult",
	tool_result: "toolResult",
	tool_result_message: "toolResult",
	custom: "custom",
	custom_message: "custom",
	bash: "bash",
	bash_execution: "bash",
	bashexecution: "bash",
	summary: "summary",
	compaction: "compaction",
	compact: "compaction",
	branch: "branch",
	branch_summary: "branch",
};

function normalizeRole(value: string): RowRole | undefined {
	return ROLE_ALIASES[value.trim().toLowerCase()];
}

/** Resolve a maybe-negative row number (-1 = last row). */
function resolveIndex(value: number, rows: PruneRow[]): number {
	if (!Number.isFinite(value)) return Number.NaN;
	if (value >= 0) return Math.trunc(value);
	const last = rows.length === 0 ? -1 : rows[rows.length - 1].index;
	return Math.trunc(last + 1 + value);
}

/**
 * Resolve a selector to row indices. Throws on malformed input (bad regex) so the
 * tool can surface the error instead of silently pruning the wrong rows.
 */
export function selectRows(rows: PruneRow[], selector: Selector): Set<number> {
	const groups: Array<Set<number>> = [];

	if (selector.entryIds !== undefined) {
		const set = new Set<number>();
		for (const id of selector.entryIds) {
			const needle = String(id).trim();
			if (needle.length === 0) continue;
			for (const row of rows) {
				if (row.entryId === needle || row.entryId.startsWith(needle)) set.add(row.index);
			}
		}
		groups.push(set);
	}

	if (selector.indices !== undefined) {
		const set = new Set<number>();
		for (const raw of selector.indices) {
			const index = resolveIndex(Number(raw), rows);
			if (Number.isFinite(index)) set.add(index);
		}
		groups.push(set);
	}

	if (selector.range !== undefined && selector.range.length > 0) {
		const values = selector.range.map((value) => resolveIndex(Number(value), rows));
		const low = Math.min(...values);
		const high = Math.max(...values);
		const set = new Set<number>();
		for (const row of rows) if (row.index >= low && row.index <= high) set.add(row.index);
		groups.push(set);
	}

	if (selector.roles !== undefined) {
		const wanted = new Set<RowRole>();
		for (const role of selector.roles) {
			const normalized = normalizeRole(String(role));
			if (normalized !== undefined) wanted.add(normalized);
		}
		groups.push(new Set(rows.filter((row) => wanted.has(row.role)).map((row) => row.index)));
	}

	if (selector.tools !== undefined) {
		const wanted = selector.tools.map((tool) => String(tool).trim().toLowerCase()).filter((tool) => tool.length > 0);
		const set = new Set<number>();
		for (const row of rows) {
			const names: string[] = [];
			if (row.toolName) names.push(row.toolName.toLowerCase());
			for (const call of row.toolCalls ?? []) names.push(call.name.toLowerCase());
			if (names.some((name) => wanted.includes(name))) set.add(row.index);
		}
		groups.push(set);
	}

	if (selector.match !== undefined && selector.match.length > 0) {
		let regex: RegExp;
		try {
			regex = new RegExp(selector.match, "i");
		} catch (error) {
			throw new Error(`invalid match regex ${JSON.stringify(selector.match)}: ${error instanceof Error ? error.message : String(error)}`);
		}
		groups.push(new Set(rows.filter((row) => regex.test(row.text)).map((row) => row.index)));
	}

	if (selector.lastMessages !== undefined) {
		const count = Math.max(0, Math.trunc(selector.lastMessages));
		const last = rows.length === 0 ? -1 : rows[rows.length - 1].index;
		groups.push(new Set(rows.filter((row) => row.index > last - count).map((row) => row.index)));
	}

	if (selector.turns !== undefined) {
		const count = Math.max(0, Math.trunc(selector.turns));
		const userRows = rows.filter((row) => row.role === "user");
		const startRow = count === 0 ? undefined : userRows[Math.max(0, userRows.length - count)];
		groups.push(new Set(startRow === undefined ? [] : rows.filter((row) => row.index >= startRow.index).map((row) => row.index)));
	}

	if (selector.beforeIndex !== undefined) {
		const limit = resolveIndex(Number(selector.beforeIndex), rows);
		groups.push(new Set(rows.filter((row) => row.index < limit).map((row) => row.index)));
	}

	if (selector.afterIndex !== undefined) {
		const start = resolveIndex(Number(selector.afterIndex), rows);
		groups.push(new Set(rows.filter((row) => row.index > start).map((row) => row.index)));
	}

	if (groups.length === 0) return new Set();

	const [first, ...rest] = groups;
	const result = new Set(first);
	for (const group of rest) {
		for (const index of [...result]) if (!group.has(index)) result.delete(index);
	}
	return result;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/**
 * Turn a request into context edits.
 *
 * Whitelist mode (`keep`) computes a target visibility for every editable row;
 * blacklist mode (`drop`) starts from the current visibility so repeated prunes
 * compose. The closure then repairs tool call/result pairing, and only rows whose
 * state actually changes produce an edit, keeping the session tree small.
 */
export function planPrune(rows: PruneRow[], request: PruneRequest, options: PlanOptions = {}): PrunePlan {
	const warnings: string[] = [];
	const editable = rows.filter((row) => row.editable);
	const byIndex = new Map(rows.map((row) => [row.index, row]));

	if (request.keep === undefined && request.drop === undefined && request.restore === undefined) {
		throw new Error('apply needs "keep", "restore" or "drop"');
	}

	const keep = request.keep === undefined ? undefined : selectRows(rows, request.keep);
	const restore = request.restore === undefined ? undefined : selectRows(rows, request.restore);
	const drop = request.drop === undefined ? undefined : selectRows(rows, request.drop);

	if (keep !== undefined && keep.size === 0) {
		throw new Error('keep selector matched no rows; call action="list" first and select ids or row numbers');
	}

	const visible = new Map<number, boolean>();
	for (const row of editable) {
		visible.set(row.index, keep === undefined ? row.visible : keep.has(row.index));
	}
	const explicitlyRestored = new Set<number>();
	if (restore !== undefined) {
		for (const index of restore) {
			const row = byIndex.get(index);
			if (row === undefined || !row.editable) continue;
			visible.set(index, true);
			explicitlyRestored.add(index);
		}
	}
	if (drop !== undefined) {
		for (const index of drop) if (visible.has(index)) visible.set(index, false);
	}

	/** Rows whose stored original content comes back: explicit restores and anything that becomes visible again. */
	const restored = new Set<number>();
	for (const row of editable) {
		if (explicitlyRestored.has(row.index) && visible.get(row.index) === true) restored.add(row.index);
		else if (row.visible === false && visible.get(row.index) === true) restored.add(row.index);
	}

	// Rows the planner must not hide, whatever the selector said.
	const forcedVisible = new Set<number>();
	for (const row of editable) {
		if (visible.get(row.index) === false && row.hideProtected) {
			visible.set(row.index, true);
			forcedVisible.add(row.index);
			warnings.push(`kept #${row.index} ${row.entryId.slice(0, 6)}: protected (current turn)`);
		}
	}
	if (options.protectLastUser !== false && keep !== undefined) {
		const lastUser = [...editable].reverse().find((row) => row.role === "user");
		if (lastUser !== undefined && visible.get(lastUser.index) === false) {
			visible.set(lastUser.index, true);
			forcedVisible.add(lastUser.index);
			warnings.push(`kept #${lastUser.index} ${lastUser.entryId.slice(0, 6)}: last user message`);
		}
	}

	/** Content a row contributes after the request's restores, before pairing repairs. */
	const replacement = new Map<number, MessageContent>();
	const effectiveContent = (row: PruneRow): MessageContent | undefined =>
		replacement.get(row.index) ?? (restored.has(row.index) ? row.rawContent : row.content);

	// Bringing a tool result back must bring its call back: when the assistant
	// message lost the block in an earlier prune, reset it to its stored content
	// and let the pairing pass below strip whatever is still hidden.
	const rawCallOwner = new Map<string, number>();
	for (const row of editable) {
		if (row.role !== "assistant") continue;
		for (const call of toolCallsIn(row.rawContent)) rawCallOwner.set(call.id, row.index);
	}
	for (const index of restored) {
		const row = byIndex.get(index);
		if (row === undefined || row.role !== "toolResult" || row.toolCallId === undefined) continue;
		const ownerIndex = rawCallOwner.get(row.toolCallId);
		const owner = ownerIndex === undefined ? undefined : byIndex.get(ownerIndex);
		if (owner === undefined) continue;
		if (visible.get(owner.index) !== true) {
			warnings.push(`dropped #${row.index}: its assistant message #${owner.index} is hidden`);
			continue;
		}
		if (owner.rawContent === undefined) continue;
		if (toolCallsIn(effectiveContent(owner)).some((call) => call.id === row.toolCallId)) continue;
		replacement.set(owner.index, owner.rawContent);
	}

	// Pairing index over editable rows.
	const callOwner = new Map<string, number>();
	const callResults = new Map<string, number[]>();
	for (const row of editable) {
		if (row.role === "assistant") {
			for (const call of toolCallsIn(effectiveContent(row))) callOwner.set(call.id, row.index);
		} else if (row.role === "toolResult" && row.toolCallId !== undefined) {
			const list = callResults.get(row.toolCallId) ?? [];
			list.push(row.index);
			callResults.set(row.toolCallId, list);
		}
	}

	const rowCalls = (row: PruneRow): RowToolCall[] => toolCallsIn(effectiveContent(row));
	const isHidden = (index: number): boolean => visible.get(index) === false && !forcedVisible.has(index);

	const maxRounds = options.maxRounds ?? 8;
	for (let round = 0; round < maxRounds; round += 1) {
		let changed = false;

		// Assistant messages: drop calls whose results are hidden, or the shell.
		for (const row of editable) {
			if (row.role !== "assistant" || visible.get(row.index) !== true) continue;
			const calls = rowCalls(row);
			if (calls.length === 0) continue;
			const dropped = calls.filter((call) => {
				const results = callResults.get(call.id);
				return results !== undefined && results.some((index) => isHidden(index));
			});
			if (dropped.length === 0) continue;

			const current = effectiveContent(row);
			const next = stripToolCalls(current, new Set(dropped.map((call) => call.id)));
			if (next.length === 0) {
				if (row.hideProtected) {
					// The message cannot be emptied (it carries the running prune call):
					// keep it whole and keep the results it still calls.
					replacement.delete(row.index);
					for (const call of calls) {
						for (const index of callResults.get(call.id) ?? []) {
							forcedVisible.add(index);
							visible.set(index, true);
						}
					}
					warnings.push(`kept tool results of #${row.index}: the protected assistant message cannot be emptied`);
					changed = true;
					continue;
				}
				visible.set(row.index, false);
				changed = true;
				continue;
			}
			if (!contentEqual(next, current)) {
				replacement.set(row.index, next);
				changed = true;
			}
		}

		// Tool results: hide orphans.
		for (const row of editable) {
			if (row.role !== "toolResult" || row.toolCallId === undefined || visible.get(row.index) !== true) continue;
			const ownerIndex = callOwner.get(row.toolCallId);
			const owner = ownerIndex === undefined ? undefined : byIndex.get(ownerIndex);
			const retained =
				owner !== undefined &&
				visible.get(owner.index) === true &&
				rowCalls(owner).some((call) => call.id === row.toolCallId);
			if (retained) continue;
			if (row.hideProtected) {
				forcedVisible.add(row.index);
				visible.set(row.index, true);
				warnings.push(`kept #${row.index} ${row.entryId.slice(0, 6)}: protected tool result`);
				continue;
			}
			visible.set(row.index, false);
			changed = true;
		}

		if (!changed) break;
	}

	// Decisions for the state that changed.
	const decisions: PlanDecision[] = [];
	const keptIndices: number[] = [];
	let tokensBefore = 0;
	let tokensAfter = 0;
	let visibleBefore = 0;
	let visibleAfter = 0;

	for (const row of editable) {
		const wantVisible = visible.get(row.index) === true;
		if (row.visible) {
			visibleBefore += 1;
			tokensBefore += row.tokens;
		}
		if (wantVisible) {
			visibleAfter += 1;
			tokensAfter += row.tokens;
			keptIndices.push(row.index);
		}

		if (!wantVisible) {
			if (row.visible) decisions.push({ index: row.index, entryId: row.entryId, action: "omit", reason: "hidden" });
			continue;
		}
		const next = replacement.get(row.index);
		if (!row.visible) {
			const content = next ?? row.rawContent;
			if (content === undefined) {
				warnings.push(`cannot restore #${row.index} ${row.entryId.slice(0, 6)}: no stored content`);
				continue;
			}
			decisions.push({ index: row.index, entryId: row.entryId, action: "replace", content, reason: "restored" });
			continue;
		}
		if (next !== undefined && !contentEqual(next, row.content)) {
			decisions.push({ index: row.index, entryId: row.entryId, action: "replace", content: next, reason: "calls-stripped" });
			continue;
		}
		if (restored.has(row.index) && row.rawContent !== undefined && !contentEqual(row.rawContent, row.content)) {
			decisions.push({ index: row.index, entryId: row.entryId, action: "replace", content: row.rawContent, reason: "restored" });
		}	}

	// Selected rows that cannot be edited at all.
	for (const index of [...(keep ?? []), ...(restore ?? []), ...(drop ?? [])]) {
		const row = byIndex.get(index);
		if (row !== undefined && !row.editable) warnings.push(`#${index} ${row.entryId.slice(0, 6)} is ${row.role} and cannot be edited`);
	}

	return {
		decisions,
		editableCount: editable.length,
		visibleBefore,
		visibleAfter,
		tokensBefore,
		tokensAfter,
		keptIndices,
		warnings,
	};
}
