import assert from "node:assert/strict";
import test from "node:test";

import {
	clampPromptCacheKey,
	injectPromptCacheKey,
	isChatCompletionsPayload,
	OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH,
} from "../index.ts";

test("adds the session key to Chat Completions payloads", () => {
	const payload = { model: "glm-5.3", messages: [{ role: "user" }], stream: true };
	const next = injectPromptCacheKey(payload, "session-abc");
	assert.equal(next?.prompt_cache_key, "session-abc");
	assert.equal(next?.model, "glm-5.3");
	// Input payload is not mutated.
	assert.equal("prompt_cache_key" in payload, false);
});

test("never overrides an existing key", () => {
	assert.equal(injectPromptCacheKey({ messages: [], prompt_cache_key: "already" }, "s"), undefined);
	assert.deepEqual(injectPromptCacheKey({ messages: [] }, "s"), {
		messages: [],
		prompt_cache_key: "s",
	});
});

test("ignores Responses and Anthropic payloads", () => {
	assert.equal(injectPromptCacheKey({ model: "gpt-6-sol", input: [], stream: true }, "s"), undefined);
	assert.equal(
		injectPromptCacheKey({ model: "claude-opus-5", messages: [], system: "sys", max_tokens: 10 }, "s"),
		undefined,
	);
	assert.equal(
		injectPromptCacheKey({ messages: [], anthropic_version: "2023-06-01" }, "s"),
		undefined,
	);
	assert.equal(injectPromptCacheKey(undefined, "s"), undefined);
	assert.equal(injectPromptCacheKey("not-an-object", "s"), undefined);
});

test("requires a session id", () => {
	assert.equal(injectPromptCacheKey({ messages: [] }, undefined), undefined);
	assert.equal(injectPromptCacheKey({ messages: [] }, ""), undefined);
});

test("classifies payload shapes", () => {
	assert.equal(isChatCompletionsPayload({ messages: [] }), true);
	assert.equal(isChatCompletionsPayload({ messages: [], input: [] }), false);
	assert.equal(isChatCompletionsPayload({ messages: [], system: "" }), false);
	assert.equal(isChatCompletionsPayload({ input: [] }), false);
});

test("clamps keys to 64 characters", () => {
	assert.equal(OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH, 64);
	assert.equal(clampPromptCacheKey("short"), "short");
	const long = "x".repeat(100);
	assert.equal(clampPromptCacheKey(long).length, 64);
	// Astral characters count as one character, like pi-ai's clamp.
	assert.equal(Array.from(clampPromptCacheKey("😀".repeat(100))).length, 64);
});
