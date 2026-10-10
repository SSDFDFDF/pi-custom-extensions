import assert from "node:assert/strict";
import test from "node:test";

import {
	applySessionHeaders,
	clampPromptCacheKey,
	detectRejections,
	injectPromptCacheKey,
	isChatCompletionsPayload,
	OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH,
	promptCacheKeyEnabledFor,
	sessionHeaderNamesFor,
} from "../index.ts";
import { DEFAULT_CONFIG, cloneConfig, normalizeConfig, resolveSessionHeaderNames } from "../config.ts";

const defaults = () => normalizeConfig(cloneConfig(DEFAULT_CONFIG));

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

test("resolves preset and extra header names without case duplicates", () => {
	assert.deepEqual(resolveSessionHeaderNames(["generic"], []), ["X-Session-ID"]);
	assert.deepEqual(resolveSessionHeaderNames(["generic", "openrouter"], []), ["X-Session-ID"]);
	assert.deepEqual(resolveSessionHeaderNames(["openai"], []), [
		"session_id",
		"x-client-request-id",
		"x-session-affinity",
	]);
	assert.deepEqual(resolveSessionHeaderNames([], ["X-My-Session"]), ["X-My-Session"]);
	assert.deepEqual(resolveSessionHeaderNames(["generic"], ["x-session-id", "  "]), ["X-Session-ID"]);
});

test("applies session headers without overriding existing ones", () => {
	const headers = { session_id: "already" };
	const written = applySessionHeaders(headers, ["session_id", "X-Session-ID"], "s1");
	assert.deepEqual(written, ["X-Session-ID"]);
	assert.deepEqual(headers, { session_id: "already", "X-Session-ID": "s1" });

	// Case-insensitive collision: the existing header wins.
	const mixed = { "x-session-id": "gateway" };
	assert.deepEqual(applySessionHeaders(mixed, ["X-Session-ID"], "s1"), []);
	assert.deepEqual(mixed, { "x-session-id": "gateway" });
});

test("headers default to the generic X-Session-ID preset", () => {
	assert.deepEqual(sessionHeaderNamesFor(defaults(), "custom-a"), ["X-Session-ID"]);
});

test("header injection honours enable flag, API filter and provider filter", () => {
	const off = defaults();
	off.headers.enabled = false;
	assert.deepEqual(sessionHeaderNamesFor(off, "custom-a"), []);

	const denied = defaults();
	denied.headers.providers.deny = ["custom-b*"];
	assert.deepEqual(sessionHeaderNamesFor(denied, "custom-a"), ["X-Session-ID"]);
	assert.deepEqual(sessionHeaderNamesFor(denied, "custom-b-eu"), []);

	const allowed = defaults();
	allowed.headers.providers.allow = ["custom-a"];
	assert.deepEqual(sessionHeaderNamesFor(allowed, "custom-b"), []);
	assert.deepEqual(sessionHeaderNamesFor(allowed, "custom-a"), ["X-Session-ID"]);
});

test("rejected headers are skipped per provider only", () => {
	const config = defaults();
	config.disabled.headerProviders["custom-a"] = ["x-session-id"];
	assert.deepEqual(sessionHeaderNamesFor(config, "custom-a"), []);
	assert.deepEqual(sessionHeaderNamesFor(config, "custom-b"), ["X-Session-ID"]);
});

test("prompt_cache_key is opt-in and provider filtered", () => {
	// Default config: OFF, matching the shipped default.
	assert.equal(defaults().promptCacheKey.enabled, false);
	assert.equal(promptCacheKeyEnabledFor(defaults(), "custom-a"), false);

	const on = defaults();
	on.promptCacheKey.enabled = true;
	assert.equal(promptCacheKeyEnabledFor(on, "custom-a"), true);

	on.promptCacheKey.providers.deny = ["custom-a"];
	assert.equal(promptCacheKeyEnabledFor(on, "custom-a"), false);
	assert.equal(promptCacheKeyEnabledFor(on, "custom-b"), true);

	const recovered = defaults();
	recovered.promptCacheKey.enabled = true;
	recovered.disabled.promptCacheKeyProviders = ["custom-a"];
	assert.equal(promptCacheKeyEnabledFor(recovered, "custom-a"), false);
	assert.equal(promptCacheKeyEnabledFor(recovered, "custom-b"), true);
});

test("detects the gateway rejection seen in this repo", () => {
	const message =
		'400: {"message":"Validation: Unsupported parameter(s): `prompt_cache_key`","type":"bad_response_status_code"}';
	assert.deepEqual(detectRejections(message, ["X-Session-ID"]), {
		promptCacheKey: true,
		headers: [],
	});
});

test("detects a rejected header by name", () => {
	const message = "400: Invalid request: unknown header X-Session-ID";
	assert.deepEqual(detectRejections(message, ["X-Session-ID", "x-client-request-id"]), {
		promptCacheKey: false,
		headers: ["X-Session-ID"],
	});
});

test("does not disable on echoes, other statuses, or unrelated errors", () => {
	// Gateway 500 that echoes the request body containing the key: no 400/422.
	assert.deepEqual(detectRejections('500 gateway_error: {"prompt_cache_key":"abc"}', ["X-Session-ID"]), {
		promptCacheKey: false,
		headers: [],
	});
	// 400 for another reason; the key is only present in an echoed body.
	assert.deepEqual(detectRejections('400: rate limit exceeded for prompt_cache_key', ["X-Session-ID"]), {
		promptCacheKey: false,
		headers: [],
	});
	// 400 with a rejection hint but for a different parameter.
	assert.deepEqual(detectRejections("400: Unsupported parameter(s): `temperature`", ["X-Session-ID"]), {
		promptCacheKey: false,
		headers: [],
	});
});
