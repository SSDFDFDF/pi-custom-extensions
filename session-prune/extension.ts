/**
 * session-prune — Pi extension.
 *
 * Trims the *current session context* by hiding messages that stopped being
 * useful, instead of compacting (summarizing) the whole conversation. The agent
 * drives it through the `session_prune` tool; `/prune` gives the user the same
 * control with selectors and a preview.
 *
 * How it works: Pi's session format is an append-only tree, and it already has
 * the perfect primitive for this — `ContextEditEntry`. Each prune appends
 * `context_edit` entries that omit or replace an earlier message's contribution
 * to the model context. Nothing is deleted: raw history, the transcript, exports
 * and cost accounting keep every message, hidden messages can be restored, the
 * edits are branch-relative like every other session entry, and compaction keeps
 * working on the trimmed projection.
 *
 * Both entry points plan with the same pure engine: the tool hands its edits to
 * Pi's `turn_end` boundary (the documented way for an extension to append
 * context edits), the command writes them directly to the idle session manager.
 */

import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { ensureConfigFile, formatConfigSummary, loadConfig, type SessionPruneConfig } from "./src/config.ts";
import { SELECTOR_HELP, parseSelector } from "./src/dsl.ts";
import { formatListing, formatPlan, formatStatus, markerForPlan } from "./src/format.ts";
import {
	CUSTOM_TYPE,
	type PruneLedgerEntry,
	type PruneRecord,
	appendDrafts,
	findPruneToUndo,
	newOpId,
	protectedOmission,
	planDrafts,
	pruneRecord,
	readLedger,
	undoRecord,
	undoRequest,
	writableSession,
} from "./src/ops.ts";
import { planPrune, type PruneRequest, type PruneRow, type Selector } from "./src/plan.ts";
import { buildRows, isNestedToolCallId } from "./src/rows.ts";

/** Simple selector/action result returned to the model. */
interface PruneToolDetails {
	action: "list" | "apply" | "undo" | "status";
	changes?: number;
	opId?: string;
	hidden?: number;
	kept?: number;
	freedTokens?: number;
	snapshot?: number;
}

const SelectorSchema = Type.Object({
	entryIds: Type.Optional(Type.Array(Type.String(), { description: "Entry ids from the listing; unique prefixes work" })),
	indices: Type.Optional(Type.Array(Type.Number(), { description: "Row numbers from the listing; negative counts from the end (-1 = last row)" })),
	range: Type.Optional(Type.Array(Type.Number(), { description: "[from, to] inclusive row range" })),
	roles: Type.Optional(Type.Array(Type.String(), { description: 'user | assistant | toolResult | custom | bash | summary' })),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Tool names: matches tool results and assistant messages that called them" })),
	match: Type.Optional(Type.String({ description: "Regular expression over the message preview (case-insensitive)" })),
	lastMessages: Type.Optional(Type.Number({ description: "The last N rows" })),
	turns: Type.Optional(Type.Number({ description: "From the Nth-last user message onwards" })),
	beforeIndex: Type.Optional(Type.Number({ description: "Rows before this row number" })),
	afterIndex: Type.Optional(Type.Number({ description: "Rows after this row number" })),
});

const SessionPruneParams = Type.Object({
	action: StringEnum(["list", "apply", "undo", "status"] as const),
	keep: Type.Optional(SelectorSchema),
	restore: Type.Optional(SelectorSchema),
	drop: Type.Optional(SelectorSchema),
	dryRun: Type.Optional(Type.Boolean({ description: "apply: report the plan without changing anything" })),
	snapshot: Type.Optional(Type.Number({ description: "apply: the snapshot number from list; a stale snapshot is rejected" })),
	opId: Type.Optional(Type.String({ description: "undo: the op id of a specific prune" })),
	note: Type.Optional(Type.String({ description: "apply: short reason, stored with the prune record" })),
	all: Type.Optional(Type.Boolean({ description: "list: print every row instead of the default window" })),
	limit: Type.Optional(Type.Number({ description: "list: maximum rows to print" })),
	match: Type.Optional(Type.String({ description: "list: only rows whose preview matches this regular expression" })),
});

const TOOL_DESCRIPTION = [
	"Trim the current session context: keep the messages that matter and hide the rest. Use it to remove stale tool output, dead ends or superseded discussion before they fill the context window. Raw history is preserved and hidden messages can be restored; this is targeted trimming, not compaction.",
	"",
	'action="list" — numbered context rows (id, state, role, tokens, preview) plus the snapshot number.',
	'action="apply" — `keep` is a whitelist (every other editable row is hidden), `restore` puts rows back with their original content, `drop` is a blacklist applied last. The edit lands at the end of the current turn, so the next request already sees the trimmed context.',
	'action="undo" — restore the newest prune, or the one named by opId.',
	'action="status" — config and how much context is live.',
	"",
	"Selectors: fields AND, arrays OR. Examples: {drop:{roles:[\"toolResult\"]}} hides every tool result; {keep:{turns:1}} keeps the last user turn; {keep:{indices:[-4,-3,-2,-1]}} keeps the last four rows; {drop:{tools:[\"read\"], match:\"node_modules\"}} hides matching read output. Tool calls and their results are always trimmed together (dropping a result keeps the assistant text), the running turn is never removed, locked rows (compaction/branch summaries) cannot be edited, and keep always retains the newest user message.",
].join("\n");

/**
 * The newest assistant message: the best approximation of the turn that is
 * finishing when `turn_end` did not provide its exact entry id (the
 * `agent_before_settle` fallback).
 */
function lastAssistantEntryId(session: ExtensionContext["sessionManager"]): string | undefined {
	const branch = session.getBranch();
	const index = branch.findLastIndex((entry) => entry.type === "message" && entry.message.role === "assistant");
	return index < 0 ? undefined : branch[index].id;
}

/**
 * Refusal notice for a batch that would have hidden the running turn. It replaces
 * the batch, so nothing is written except the notice the model reads next turn.
 */
function refusalDrafts(entryId: string): SessionBoundaryDraft[] {
	return [
		{
			type: "custom_message",
			customType: CUSTOM_TYPE,
			content: `[session-prune] prune refused: it would have removed the running turn (#${entryId.slice(0, 6)}), which must stay visible. Nothing changed — run it again after this turn.`,
			display: true,
		},
	];
}

/** The snapshot number the model echoes back to detect a stale listing. */
function contextSnapshot(session: ExtensionContext["sessionManager"]): number {
	const ledger = readLedger(session.getBranch());
	return ledger.prunes.length + ledger.undos.length;
}

function warningsLine(warnings: string[]): string {
	if (warnings.length === 0) return "";
	return `\nnotes: ${warnings.slice(0, 5).join(" · ")}`;
}

export default function sessionPrune(pi: ExtensionAPI) {
	/** Prune plan waiting for this turn's `turn_end` boundary. */
	let pending: { sessionId: string; drafts: SessionBoundaryDraft[] } | undefined;

	const config = (): SessionPruneConfig => loadConfig();

	/** Rows for the current context, with the running turn protected when known. */
	const rowsFor = (session: ExtensionContext["sessionManager"], toolCallId?: string): { rows: PruneRow[]; warnings: string[] } =>
		buildRows(session, {
			...(toolCallId === undefined ? {} : { toolCallId, nested: isNestedToolCallId(toolCallId) }),
			previewChars: config().previewChars,
		});

	/**
	 * Queue boundary drafts for this turn. Several prune calls in one turn merge:
	 * the ledger and marker entries stay in call order, and the newest edit of a
	 * target wins.
	 */
	const queueDrafts = (sessionId: string, drafts: SessionBoundaryDraft[]): void => {
		if (pending === undefined || pending.sessionId !== sessionId) {
			pending = { sessionId, drafts };
			return;
		}
		const merged = [...pending.drafts, ...drafts];
		const lastEdit = new Map<string, number>();
		merged.forEach((draft, index) => {
			if (draft.type === "context_edit") lastEdit.set(draft.targetId, index);
		});
		pending = {
			sessionId,
			drafts: merged.filter((draft, index) => draft.type !== "context_edit" || lastEdit.get(draft.targetId) === index),
		};
	};

	const applyRequest = (
		rows: PruneRow[],
		request: PruneRequest,
		options: { action: "apply" | "undo"; dryRun?: boolean; note?: string; undoOf?: PruneRecord; markWhenEmpty?: boolean },
	): { text: string; details: PruneToolDetails; drafts?: SessionBoundaryDraft[] } => {
		const settings = config();
		const plan = planPrune(rows, request, { protectLastUser: settings.protectLastUser });
		if (plan.decisions.length === 0) {
			if (options.markWhenEmpty === true && options.undoOf !== undefined) {
				// The targets are already live: record the undo so the operation is
				// consumed instead of being offered again forever.
				const opId = newOpId();
				return {
					text: `session-prune: op ${options.undoOf.opId} is already fully live; marked as undone (op ${opId}).`,
					details: { action: options.action, changes: 0, opId },
					drafts: [{ type: "custom", customType: CUSTOM_TYPE, data: undoRecord(options.undoOf, opId) }],
				};
			}
			return {
				text:
					"session-prune: no changes — the selection already matches the context" +
					warningsLine(plan.warnings),
				details: { action: options.action, changes: 0 },
			};
		}
		if (options.dryRun === true) {
			return {
				text: `session-prune: ${formatPlan(plan, { dryRun: true })}${warningsLine(plan.warnings)}`,
				details: { action: options.action, changes: plan.decisions.length },
			};
		}

		const opId = newOpId();
		const record = options.undoOf === undefined ? pruneRecord(plan, opId, options.note) : undoRecord(options.undoOf, opId);
		const marker = settings.marker ? markerForPlan(plan, { opId, ...(options.undoOf === undefined ? {} : { of: options.undoOf.opId }) }) : undefined;
		const drafts = planDrafts(plan, record, marker);
		return {
			text: `session-prune: ${formatPlan(plan, { opId })}${warningsLine(plan.warnings)}\nThe trim is applied at the end of this turn; the next request sees the trimmed context.`,
			details: {
				action: options.action,
				changes: plan.decisions.length,
				opId,
				hidden: plan.visibleBefore - plan.visibleAfter,
				kept: plan.visibleAfter,
				freedTokens: Math.max(0, plan.tokensBefore - plan.tokensAfter),
			},
			drafts,
		};
	};

	pi.registerTool<typeof SessionPruneParams, PruneToolDetails>({
		name: "session_prune",
		label: "Session Prune",
		description: TOOL_DESCRIPTION,
		promptSnippet: "Trim the session context (keep/drop messages) without deleting history",
		promptGuidelines: [
			'Use session_prune action="list" before a large cleanup and name what must survive with keep; stale tool output, dead ends and resolved errors are the usual noise.',
			"Prune stale context as you go instead of letting it pile up until compaction summarizes everything.",
		],
		parameters: SessionPruneParams,
		executionMode: "sequential",
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const settings = config();
			const { rows, warnings } = rowsFor(ctx.sessionManager, toolCallId);
			const snapshot = contextSnapshot(ctx.sessionManager);

			switch (params.action) {
				case "list": {
					const limit = params.limit ?? (params.all === true ? Number.POSITIVE_INFINITY : settings.maxListed);
					const text = `session-prune list\n${formatListing(rows, { maxRows: limit, all: params.all, match: params.match, snapshot })}${warningsLine(warnings)}`;
					return { content: [{ type: "text", text }], details: { action: "list", snapshot } };
				}
				case "status": {
					const ledger = readLedger(ctx.sessionManager.getBranch());
					const last = ledger.prunes.at(-1);
					const text = formatStatus({
						config: formatConfigSummary(settings),
						rows,
						pruneOps: ledger.prunes.length,
						undoOps: ledger.undos.length,
						...(last === undefined
							? {}
							: { lastOp: { opId: last.data.opId, at: last.data.at, hidden: last.data.hidden, freedTokens: last.data.freedTokens } }),
					});
					return { content: [{ type: "text", text }], details: { action: "status", snapshot } };
				}
				case "apply": {
					if (params.snapshot !== undefined && params.snapshot !== snapshot) {
						throw new Error(
							`stale listing: the context changed since snapshot ${params.snapshot} (now ${snapshot}). Run action="list" again.`,
						);
					}
					const request: PruneRequest = {
						...(params.keep === undefined ? {} : { keep: params.keep as Selector }),
						...(params.restore === undefined ? {} : { restore: params.restore as Selector }),
						...(params.drop === undefined ? {} : { drop: params.drop as Selector }),
					};
					const outcome = applyRequest(rows, request, {
						action: "apply",
						...(params.dryRun === true ? { dryRun: true } : {}),
						...(params.note ? { note: params.note } : {}),
					});
					if (outcome.drafts !== undefined) {
						// Consumed by the turn_end handler below, which owns the append.
						queueDrafts(ctx.sessionManager.getSessionId(), outcome.drafts);
					}
					return { content: [{ type: "text", text: outcome.text }], details: outcome.details };
				}
				case "undo": {
					const ledger = readLedger(ctx.sessionManager.getBranch());
					const target = findPruneToUndo(ledger, params.opId);
					const outcome = applyRequest(rows, undoRequest(target.data), {
						action: "undo",
						undoOf: target.data,
						markWhenEmpty: true,
					});
					if (outcome.drafts !== undefined) {
						queueDrafts(ctx.sessionManager.getSessionId(), outcome.drafts);
					}
					return { content: [{ type: "text", text: outcome.text }], details: outcome.details };
				}
			}
		},
	});

	pi.on("turn_end", (event, ctx) => {
		const waiting = pending;
		pending = undefined;
		if (waiting === undefined || waiting.sessionId !== ctx.sessionManager.getSessionId()) return;
		// The turn that is finishing must stay visible (its tool calls may still be
		// stripped, and sibling results may still be pruned). Refusing the whole
		// batch keeps the plan consistent if that invariant is ever violated.
		const offender = protectedOmission(waiting.drafts, [event.messageEntryId]);
		return { entries: offender === undefined ? waiting.drafts : refusalDrafts(offender) };
	});

	// Safety net: if a run settles without a turn boundary (no assistant message),
	// apply a waiting prune instead of dropping it.
	pi.on("agent_before_settle", (_event, ctx) => {
		const waiting = pending;
		pending = undefined;
		if (waiting === undefined || waiting.sessionId !== ctx.sessionManager.getSessionId()) return;
		const lastAssistant = lastAssistantEntryId(ctx.sessionManager);
		const offender = protectedOmission(waiting.drafts, lastAssistant === undefined ? [] : [lastAssistant]);
		return { entries: offender === undefined ? waiting.drafts : refusalDrafts(offender) };
	});

	pi.on("session_start", () => {
		pending = undefined;
		// Materialize the config file so its defaults are discoverable.
		try {
			ensureConfigFile();
		} catch {
			// A read-only agent dir is not fatal: loadConfig() falls back to defaults.
		}
	});

	pi.on("session_shutdown", () => {
		pending = undefined;
	});

	pi.registerEntryRenderer<PruneLedgerEntry>(CUSTOM_TYPE, (entry, options, theme) => {
		const data = entry.data;
		if (data === undefined) return undefined;
		if (data.kind === "prune") {
			const note = data.note ? ` · ${data.note}` : "";
			const parts: string[] = [];
			if (data.hidden > 0) parts.push(`hid ${data.hidden} row(s) · ~${data.freedTokens} tokens freed`);
			if (data.restored > 0) parts.push(`restored ${data.restored} row(s)`);
			return new Text(theme.fg("dim", `[prune ${data.opId}] ${parts.length > 0 ? parts.join(" · ") : "no change"}${note}`), 0, 0);
		}
		return new Text(theme.fg("dim", `[prune] restored ${data.restored} row(s) (undo of ${data.of}${options.expanded ? `, op ${data.opId}` : ""})`), 0, 0);
	});

	pi.registerCommand("prune", {
		description: "Trim the session context: /prune list|keep|drop|restore|undo|status|help",
		getArgumentCompletions: (prefix) => {
			const options = ["list", "status", "help", "keep ", "drop ", "restore ", "undo "];
			return options.filter((option) => option.startsWith(prefix)).map((option) => ({ value: option, label: option }));
		},
		handler: async (args, ctx) => {
			const settings = config();
			const tokens = args.trim().split(/\s+/).filter((token) => token.length > 0);
			const subcommand = (tokens.shift() ?? "list").toLowerCase();
			const report = (message: string, level: "info" | "warning" | "error" = "info") => ctx.ui.notify(`session-prune\n${message}`, level);

			try {
				if (subcommand === "help") {
					report(
						[
							"/prune list [N] [text:…]   show context rows",
							"/prune keep <selector…>    hide everything else",
							"/prune drop <selector…>    hide matching rows",
							"/prune restore <selector…> put rows back (original content)",
							"/prune undo [opId]         undo the newest prune",
							"/prune status",
							"",
							SELECTOR_HELP,
						].join("\n"),
					);
					return;
				}

				if (subcommand === "list") {
					const limit = tokens[0] !== undefined && /^\d+$/.test(tokens[0]) ? Number(tokens.shift()) : 20;
					const matchToken = tokens.find((token) => token.startsWith("text:"));
					const { rows } = rowsFor(ctx.sessionManager);
					const match = matchToken === undefined ? undefined : parseSelector([matchToken]).match;
					report(formatListing(rows, { maxRows: limit, match, snapshot: contextSnapshot(ctx.sessionManager) }));
					return;
				}

				if (subcommand === "status") {
					const ledger = readLedger(ctx.sessionManager.getBranch());
					const last = ledger.prunes.at(-1);
					report(
						formatStatus({
							config: formatConfigSummary(settings),
							rows: rowsFor(ctx.sessionManager).rows,
							pruneOps: ledger.prunes.length,
							undoOps: ledger.undos.length,
							...(last === undefined
								? {}
								: { lastOp: { opId: last.data.opId, at: last.data.at, hidden: last.data.hidden, freedTokens: last.data.freedTokens } }),
						}),
					);
					return;
				}

				if (subcommand === "keep" || subcommand === "drop" || subcommand === "restore") {
					if (tokens.length === 0) {
						report(`usage: /prune ${subcommand} <selector…>\n\n${SELECTOR_HELP}`, "error");
						return;
					}
					const selector = parseSelector(tokens);
					if (!ctx.isIdle()) await ctx.waitForIdle();
					const { rows } = rowsFor(ctx.sessionManager);
					const plan = planPrune(
						rows,
						{ [subcommand]: selector } as PruneRequest,
						{ protectLastUser: settings.protectLastUser },
					);
					if (plan.decisions.length === 0) {
						report(`no changes — the selection already matches the context${warningsLine(plan.warnings)}`);
						return;
					}
					const preview = formatPlan(plan, { dryRun: true });
					if (ctx.hasUI) {
						const confirmed = await ctx.ui.confirm(`session-prune: ${plan.decisions.length} change(s)`, preview);
						if (!confirmed) {
							report("cancelled");
							return;
						}
					}
					const session = writableSession(ctx.sessionManager);
					if (session === undefined) {
						report("this mode cannot write context edits; use the session_prune tool instead", "error");
						return;
					}
					const opId = newOpId();
					const record = pruneRecord(plan, opId);
					const marker = settings.marker ? markerForPlan(plan, { opId }) : undefined;
					appendDrafts(pi, session, planDrafts(plan, record, marker));
					report(formatPlan(plan, { opId }));
					return;
				}

				if (subcommand === "undo") {
					if (!ctx.isIdle()) await ctx.waitForIdle();
					const ledger = readLedger(ctx.sessionManager.getBranch());
					const target = findPruneToUndo(ledger, tokens[0]);
					const { rows } = rowsFor(ctx.sessionManager);
					const plan = planPrune(rows, undoRequest(target.data), { protectLastUser: false });
					const session = writableSession(ctx.sessionManager);
					if (session === undefined) {
						report("this mode cannot write context edits; use the session_prune tool instead", "error");
						return;
					}
					if (plan.decisions.length === 0) {
						const opId = newOpId();
						appendDrafts(pi, session, [{ type: "custom", customType: CUSTOM_TYPE, data: undoRecord(target.data, opId) }]);
						report(`op ${target.data.opId} is already fully live; marked as undone (op ${opId})`);
						return;
					}
					const opId = newOpId();
					const marker = settings.marker ? markerForPlan(plan, { opId, of: target.data.opId }) : undefined;
					appendDrafts(pi, session, planDrafts(plan, undoRecord(target.data, opId), marker));
					report(formatPlan(plan, { opId }));
					return;
				}

				report(`unknown subcommand "${subcommand}"; try /prune help`, "error");
			} catch (error) {
				report(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
