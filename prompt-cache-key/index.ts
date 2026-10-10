/**
 * prompt-cache-key — Pi extension
 *
 * Sends `prompt_cache_key` (the Pi session ID) on every OpenAI-compatible
 * Chat Completions request, so custom `models.json` endpoints get the same
 * prompt-cache affinity that Pi's built-in providers do.
 *
 * Why this is needed: pi-ai's `openai-completions` builder only emits the key
 * when the base URL contains `api.openai.com` or cache retention is `"long"`
 * (`pi-ai/dist/api/openai-completions.js`, `buildParams`). Endpoints declared
 * in `models.json` therefore never send it under the default `short` retention.
 *
 * Scope: payloads that look like Chat Completions bodies. OpenAI Responses,
 * Azure Responses, and Codex Responses already send the key themselves, and
 * Anthropic Messages uses `cache_control` instead.
 *
 * The key is clamped to OpenAI's 64-character limit and never overrides a key
 * that is already present. Compaction/summarization requests also match; the
 * extra key is harmless there (OpenAI charges nothing for cache writes).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;

export function clampPromptCacheKey(key: string): string {
	const chars = Array.from(key);
	return chars.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH
		? key
		: chars.slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True for an OpenAI Chat Completions body and no other API Pi speaks. */
export function isChatCompletionsPayload(payload: unknown): payload is Record<string, unknown> {
	if (!isRecord(payload)) return false;
	if (!Array.isArray(payload.messages)) return false; // Chat Completions-only marker
	if (payload.input !== undefined) return false; // openai-responses / azure-openai-responses
	if (payload.system !== undefined) return false; // anthropic-messages
	if (payload.anthropic_version !== undefined) return false;
	return true;
}

/**
 * Returns a copy of `payload` with `prompt_cache_key` set to the session ID,
 * or `undefined` when nothing should change (not a Chat Completions body, no
 * session ID, or a non-empty key is already present).
 */
export function injectPromptCacheKey(
	payload: unknown,
	sessionId: string | undefined,
): Record<string, unknown> | undefined {
	if (!sessionId) return undefined;
	if (!isChatCompletionsPayload(payload)) return undefined;
	const existing = payload.prompt_cache_key;
	if (typeof existing === "string" && existing.length > 0) return undefined;
	return { ...payload, prompt_cache_key: clampPromptCacheKey(sessionId) };
}

export default function (pi: ExtensionAPI) {
	pi.on("before_provider_request", (event, ctx) => {
		// `openai-completions` is the only API that can omit the key; everything
		// else either sends it already or has no such concept.
		if (ctx.model && ctx.model.api !== "openai-completions") return;
		return injectPromptCacheKey(event.payload, ctx.sessionManager.getSessionId());
	});
}
