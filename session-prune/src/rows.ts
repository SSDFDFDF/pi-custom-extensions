/**
 * session-prune — turn the live session into planner rows.
 *
 * Reads the compaction-aware session projection (the entries the model actually
 * sees, after every existing context edit) and annotates each one with what the
 * planner needs: editability, current visibility, tool-call links, tokens and a
 * one-line preview. It also works out which entries belong to the turn that is
 * still running, because those must not be hidden while the run is in flight.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	estimateTokens,
	type ExtensionContext,
	type ProjectedSessionEntry,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { previewContent, previewMessage } from "./preview.ts";
import { type MessageContent, type PruneRow, type RowRole, toolCallsIn } from "./plan.ts";

/** Everything the extension reads from `ctx.sessionManager`. */
export type SessionReader = ExtensionContext["sessionManager"];

export interface RowBuildOptions {
	/** Tool call id of the running prune call. */
	toolCallId?: string;
	/** The call came from another tool (codemode): protect the whole current user turn. */
	nested?: boolean;
	previewChars?: number;
}

export interface RowBuildResult {
	rows: PruneRow[];
	warnings: string[];
}

interface Protection {
	currentTurn: Set<string>;
	hideProtected: Set<string>;
	warnings: string[];
}

const NO_PROTECTION: Protection = { currentTurn: new Set(), hideProtected: new Set(), warnings: [] };

/** True for the tool call id shape Pi assigns to calls another tool made. */
export function isNestedToolCallId(toolCallId: string | undefined): boolean {
	return typeof toolCallId === "string" && toolCallId.includes("/");
}

function messageOf(entry: SessionEntry): { role?: string; content?: MessageContent; toolCallId?: string; toolName?: string } | undefined {
	if (entry.type !== "message") return undefined;
	return entry.message as unknown as { role?: string; content?: MessageContent; toolCallId?: string; toolName?: string };
}

function callsTool(entry: SessionEntry, toolCallId: string | undefined): boolean {
	if (toolCallId === undefined) return false;
	const message = messageOf(entry);
	if (message?.role !== "assistant") return false;
	return toolCallsIn(message.content).some((call) => call.id === toolCallId);
}

function contextsModel(entry: SessionEntry): boolean {
	if (entry.type === "message") {
		const role = messageOf(entry)?.role;
		return role === "user" || role === "assistant" || role === "toolResult";
	}
	return entry.type === "custom_message";
}

/**
 * Work out which entries belong to the running turn.
 *
 * A direct tool call is found in the last assistant message that contains its id;
 * that message and everything after it are the running turn. The assistant
 * message itself may still lose tool calls (when their results are pruned) but it
 * is never hidden, and neither are non-result entries after it. For nested calls
 * the owning message cannot be identified, so the whole current user turn is
 * protected instead.
 */
function computeProtection(branch: SessionEntry[], options: RowBuildOptions): Protection {
	if (options.toolCallId === undefined) return NO_PROTECTION;

	const nested = options.nested === true || isNestedToolCallId(options.toolCallId);
	const assistantIndex = nested ? -1 : branch.findLastIndex((entry) => callsTool(entry, options.toolCallId));

	if (assistantIndex >= 0) {
		const currentTurn = new Set<string>();
		const hideProtected = new Set<string>();
		for (let index = assistantIndex; index < branch.length; index += 1) {
			const entry = branch[index];
			if (!contextsModel(entry)) continue;
			currentTurn.add(entry.id);
			const isToolResult = entry.type === "message" && messageOf(entry)?.role === "toolResult";
			if (index === assistantIndex || !isToolResult) hideProtected.add(entry.id);
		}
		return { currentTurn, hideProtected, warnings: [] };
	}

	// Fallback for nested calls (the owning message is another tool's, so its id is
	// unknown) and for a call that is not persisted yet: protect from the start of
	// the running turn — the last user message, injected custom message or assistant
	// message, whichever comes first. If the branch has none, protect everything.
	const lastUserIndex = branch.findLastIndex((entry) => messageOf(entry)?.role === "user");
	const lastCustomIndex = branch.findLastIndex((entry) => entry.type === "custom_message");
	const lastAssistantIndex = branch.findLastIndex((entry) => messageOf(entry)?.role === "assistant");
	const candidates = [lastUserIndex, lastCustomIndex, lastAssistantIndex].filter((index) => index >= 0);
	if (candidates.length === 0) {
		const ids = new Set(branch.filter(contextsModel).map((entry) => entry.id));
		return {
			currentTurn: ids,
			hideProtected: ids,
			warnings: ["the running turn cannot be located; the whole context is protected"],
		};
	}
	const ids = new Set(branch.slice(Math.min(...candidates)).filter(contextsModel).map((entry) => entry.id));
	return {
		currentTurn: ids,
		hideProtected: ids,
		warnings: [
			nested
				? "the prune call is nested; the whole current turn is protected"
				: "the assistant message that called the prune was not found; the current turn is protected",
		],
	};
}

function lockedRoleFor(role: string | undefined): RowRole {
	switch (role) {
		case "bashExecution":
			return "bash";
		case "custom":
			return "custom";
		case "compactionSummary":
			return "compaction";
		case "branchSummary":
			return "branch";
		default:
			return "summary";
	}
}

function messageTokens(message: AgentMessage | undefined): number {
	if (message === undefined) return 0;
	try {
		return estimateTokens(message);
	} catch {
		return 0;
	}
}

function rowPreview(entry: SessionEntry, message: AgentMessage | undefined, previewChars: number): string {
	switch (entry.type) {
		case "message":
			return previewMessage(message, previewChars);
		case "custom_message":
			return previewContent(entry.content as MessageContent, previewChars);
		case "compaction":
			return `compaction summary: ${previewContent(entry.summary, previewChars)}`;
		case "branch_summary":
			return `branch summary: ${previewContent(entry.summary, previewChars)}`;
		default:
			return previewMessage(message, previewChars);
	}
}

function messageRow(
	entry: SessionEntry,
	projected: ProjectedSessionEntry,
	index: number,
	protection: Protection,
	previewChars: number,
): PruneRow | undefined {
	const message = messageOf(entry);
	const rawMessage = entry.type === "message" ? (entry.message as AgentMessage) : undefined;
	const visibleMessage = projected.messages[0];
	const visible = projected.messages.length > 0;
	const role = message?.role as RowRole | undefined;

	switch (entry.type) {
		case "message": {
			if (role !== "user" && role !== "assistant" && role !== "toolResult") {
				const lockedRole = lockedRoleFor(message?.role);
				return {
					index,
					entryId: entry.id,
					role: lockedRole,
					editable: false,
					visible: true,
					hideProtected: true,
					currentTurn: protection.currentTurn.has(entry.id),
					tokens: messageTokens(visibleMessage ?? rawMessage),
					text: rowPreview(entry, rawMessage, previewChars),
				};
			}
			const rawContent = message?.content;
			const effective = visible ? ((visibleMessage as { content?: MessageContent } | undefined)?.content ?? rawContent) : rawContent;
			return {
				index,
				entryId: entry.id,
				role,
				editable: true,
				visible,
				hideProtected: protection.hideProtected.has(entry.id),
				currentTurn: protection.currentTurn.has(entry.id),
				tokens: messageTokens(visibleMessage ?? rawMessage),
				text: rowPreview(entry, visibleMessage ?? rawMessage, previewChars),
				toolCalls: role === "assistant" ? toolCallsIn(effective) : undefined,
				toolCallId: role === "toolResult" ? message?.toolCallId : undefined,
				toolName: role === "toolResult" ? message?.toolName : undefined,
				rawContent,
				content: effective,
			};
		}
		case "custom_message": {
			const rawContent = entry.content as MessageContent;
			return {
				index,
				entryId: entry.id,
				role: "custom",
				editable: true,
				visible,
				hideProtected: protection.hideProtected.has(entry.id),
				currentTurn: protection.currentTurn.has(entry.id),
				tokens: messageTokens(visibleMessage),
				text: rowPreview(entry, visibleMessage, previewChars),
				rawContent,
				content: visible ? ((visibleMessage as { content?: MessageContent } | undefined)?.content ?? rawContent) : rawContent,
			};
		}
		case "compaction":
			return {
				index,
				entryId: entry.id,
				role: "compaction",
				editable: false,
				visible: true,
				hideProtected: true,
				currentTurn: protection.currentTurn.has(entry.id),
				tokens: projected.messages.reduce((total, item) => total + messageTokens(item), 0),
				text: rowPreview(entry, undefined, previewChars),
			};
		case "branch_summary":
			return {
				index,
				entryId: entry.id,
				role: "branch",
				editable: false,
				visible: true,
				hideProtected: true,
				currentTurn: protection.currentTurn.has(entry.id),
				tokens: projected.messages.reduce((total, item) => total + messageTokens(item), 0),
				text: rowPreview(entry, undefined, previewChars),
			};
		default:
			return undefined;
	}
}

/**
 * Build the row listing for the current leaf.
 *
 * Row numbers are the positions in this listing, which is exactly the message
 * order the model sees (compaction checkpoints included, state-only entries
 * skipped).
 */
export function buildRows(session: SessionReader, options: RowBuildOptions = {}): RowBuildResult {
	const projection = session.buildSessionProjection();
	const protection = computeProtection(session.getBranch(), options);
	const previewChars = options.previewChars ?? 90;

	const rows: PruneRow[] = [];
	for (const projected of projection.entries) {
		const row = messageRow(projected.sourceEntry, projected, rows.length, protection, previewChars);
		if (row !== undefined) rows.push(row);
	}
	return { rows, warnings: protection.warnings };
}
