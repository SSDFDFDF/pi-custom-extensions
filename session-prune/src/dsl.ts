/**
 * session-prune — `/prune` selector syntax.
 *
 * ```
 * id:abc123,def456   session entry ids (unique prefixes work too)
 * #3  #3-7  #-3      row numbers from the listing; ranges; negative counts from the end
 * role:toolResult,user,assistant,custom,bash,summary
 * tool:read,grep     tool results of these tools, or assistant messages that called them
 * text:/regex/       message preview matches (text:substring is literal)
 * last:5             the last N rows
 * turns:2            from the second-last user message onwards
 * before:#5 after:#5 rows before/after a row number
 * ```
 *
 * Whitespace-separated tokens are ANDed, commas inside a token are ORed — the
 * same semantics as the tool's JSON selectors.
 */

import type { Selector } from "./plan.ts";

export const SELECTOR_HELP = [
	"selectors (space = AND, comma = OR):",
	"  id:abc123,def456     entry ids from the listing (prefixes allowed)",
	"  #3  #3-7  #-3        row numbers, ranges, negative from the end",
	"  role:toolResult,user",
	"  tool:read,grep       tool results of these tools, or calls to them",
	"  text:/regex/         match the message preview (text:word is literal)",
	"  last:5               the last 5 rows",
	"  turns:2              from the second-last user message onwards",
	"  before:#5 after:#5   rows before/after a row number",
].join("\n");

function fail(message: string): never {
	throw new Error(`${message}\n${SELECTOR_HELP}`);
}

function toNumber(value: string, token: string): number {
	const number = Number(value);
	if (!Number.isFinite(number)) fail(`"${token}" needs a number`);
	return Math.trunc(number);
}

function parseRowRef(value: string, token: string): { index?: number; range?: [number, number] } {
	const text = value.startsWith("#") ? value.slice(1) : value;
	const rangeMatch = /^(\d+)-(\d+)$/.exec(text);
	if (rangeMatch) return { range: [Number(rangeMatch[1]), Number(rangeMatch[2])] };
	return { index: toNumber(text, token) };
}

export function parseSelector(tokens: string[]): Selector {
	const entryIds: string[] = [];
	const indices: number[] = [];
	const roles: string[] = [];
	const tools: string[] = [];
	const texts: string[] = [];
	let lastMessages: number | undefined;
	let turns: number | undefined;
	let beforeIndex: number | undefined;
	let afterIndex: number | undefined;

	for (const token of tokens) {
		const trimmed = token.trim();
		if (trimmed.length === 0) continue;

		if (trimmed.startsWith("#")) {
			const parsed = parseRowRef(trimmed, trimmed);
			if (parsed.range) {
				// Expanded with a guard so a typo like #0-999999 cannot allocate.
				for (let index = parsed.range[0]; index <= Math.min(parsed.range[1], parsed.range[0] + 10_000); index += 1) indices.push(index);
			} else if (parsed.index !== undefined) {
				indices.push(parsed.index);
			}
			continue;
		}

		const separator = trimmed.indexOf(":");
		if (separator < 0) fail(`unknown selector "${trimmed}"`);
		const key = trimmed.slice(0, separator).toLowerCase();
		const value = trimmed.slice(separator + 1);

		switch (key) {
			case "id":
				for (const item of value.split(",")) if (item.trim().length > 0) entryIds.push(item.trim());
				break;
			case "role":
				for (const item of value.split(",")) if (item.trim().length > 0) roles.push(item.trim());
				break;
			case "tool":
				for (const item of value.split(",")) if (item.trim().length > 0) tools.push(item.trim());
				break;
			case "text": {
				if (value.length === 0) fail('"text:" needs a value');
				if (value.length > 2 && value.startsWith("/") && value.endsWith("/")) texts.push(value.slice(1, -1));
				else texts.push(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
				break;
			}
			case "last":
				lastMessages = toNumber(value, trimmed);
				break;
			case "turns":
				turns = toNumber(value, trimmed);
				break;
			case "before": {
				const parsed = parseRowRef(value, trimmed);
				beforeIndex = parsed.range ? parsed.range[0] : parsed.index;
				break;
			}
			case "after": {
				const parsed = parseRowRef(value, trimmed);
				afterIndex = parsed.range ? parsed.range[1] : parsed.index;
				break;
			}
			default:
				fail(`unknown selector "${trimmed}"`);
		}
	}

	const selector: Selector = {};
	if (entryIds.length > 0) selector.entryIds = entryIds;
	if (indices.length > 0) selector.indices = indices;
	if (roles.length > 0) selector.roles = roles;
	if (tools.length > 0) selector.tools = tools;
	if (texts.length > 0) selector.match = texts.length === 1 ? texts[0] : texts.map((text) => `(?=[\\s\\S]*?${text})`).join("");
	if (lastMessages !== undefined) selector.lastMessages = lastMessages;
	if (turns !== undefined) selector.turns = turns;
	if (beforeIndex !== undefined) selector.beforeIndex = beforeIndex;
	if (afterIndex !== undefined) selector.afterIndex = afterIndex;
	return selector;
}
