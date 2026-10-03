/** Claude-shaped identity values. Persistence belongs to the shared session store. */
import { randomBytes, randomUUID } from "node:crypto";

export function uuidV4(): string {
	return randomUUID();
}

export function createDeviceId(): string {
	return randomBytes(32).toString("hex");
}

export { isUuidV4 } from "./ids.ts";

/** Core anthropic-beta flags observed on Claude Code 2.1.198. */
export const CLAUDE_CODE_CORE_BETAS = [
	"claude-code-20250219",
	"interleaved-thinking-2025-05-14",
	"redact-thinking-2026-02-12",
	"thinking-token-count-2026-05-13",
	"context-management-2025-06-27",
	"prompt-caching-scope-2026-01-05",
	"mid-conversation-system-2026-04-07",
	"effort-2025-11-24",
].join(",");
