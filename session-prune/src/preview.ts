/**
 * session-prune — one-line previews of session messages.
 *
 * Used by the listing the model reads and by the tool-result summaries. Kept
 * separate from the planner so both stay testable without Pi loaded.
 */

import { toBlocks, type ContentBlock, type MessageContent } from "./plan.ts";

function collapse(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function truncate(text: string, maxChars: number): string {
	const clean = collapse(text);
	if (clean.length <= maxChars) return clean;
	return `${clean.slice(0, Math.max(0, maxChars - 1))}…`;
}

function blockText(block: ContentBlock): string {
	if (block.type === "image") return "[image]";
	if (block.type === "text" && typeof block.text === "string") return block.text;
	if (block.type === "thinking") return block.thinking ? "[thinking]" : "[redacted thinking]";
	if (block.type === "toolCall") {
		const name = typeof block.name === "string" ? block.name : "?";
		const args = firstArgument(block.arguments);
		return args === undefined ? `[call ${name}]` : `[call ${name}(${args})]`;
	}
	return "";
}

function firstArgument(args: unknown): string | undefined {
	if (args === null || typeof args !== "object") return undefined;
	for (const value of Object.values(args as Record<string, unknown>)) {
		if (typeof value === "string" && value.length > 0) return truncate(value, 40);
	}
	return undefined;
}

/** Preview of a message's content. */
export function previewContent(content: MessageContent | undefined, maxChars: number): string {
	if (typeof content === "string") return truncate(content, maxChars);
	const parts: string[] = [];
	for (const block of toBlocks(content)) {
		const text = blockText(block);
		if (text.length > 0) parts.push(text);
	}
	return truncate(parts.join(" "), maxChars);
}

interface MessageLike {
	role?: string;
	content?: unknown;
	toolName?: string;
	command?: string;
	exitCode?: number | null;
	summary?: string;
	isError?: boolean;
}

/** Preview of any session message / custom message content. */
export function previewMessage(message: unknown, maxChars: number): string {
	if (message === undefined || message === null) return "(empty)";
	if (typeof message === "string") return truncate(message, maxChars);
	const value = message as MessageLike;
	if (typeof value.content === "string" || Array.isArray(value.content)) {
		return previewContent(value.content as MessageContent, maxChars);
	}
	if (typeof value.command === "string") return truncate(`$ ${value.command}`, maxChars);
	if (typeof value.summary === "string") return truncate(value.summary, maxChars);
	return `(${value.role ?? "message"})`;
}
