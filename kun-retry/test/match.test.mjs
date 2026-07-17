import assert from "node:assert/strict";
import { test } from "node:test";
import {
	appendRetryHint,
	isEmptyAssistantContent,
	matchRetryableError,
	matchesStatusCode,
	neutralizeNonRetryable,
	RETRYABLE_HINT,
} from "../src/match.ts";

test("matches 403 token forms", () => {
	assert.equal(matchesStatusCode("HTTP 403 Forbidden", 403), true);
	assert.equal(matchesStatusCode("status code: 403", 403), true);
	assert.equal(matchesStatusCode("Request failed with 403", 403), true);
	assert.equal(matchesStatusCode("something else 400", 403), false);
});

test("nl matches any error", () => {
	const m = matchRetryableError("totally unique business failure", {
		nl: true,
		statusCodes: [],
		errorPatterns: [],
	});
	assert.ok(m);
	assert.equal(m.tag, "[kun-retry-nl]");
});

test("status code match without nl", () => {
	const m = matchRetryableError("upstream returned HTTP 401 Unauthorized", {
		nl: false,
		statusCodes: [401, 403],
		errorPatterns: [],
	});
	assert.ok(m);
	assert.match(m.tag, /401/);
});

test("custom pattern match", () => {
	const m = matchRetryableError("gateway says: fishy token", {
		nl: false,
		statusCodes: [],
		errorPatterns: ["fishy\\s+token"],
	});
	assert.ok(m);
	assert.equal(m.tag, "[kun-retry-pattern]");
});

test("legacy unknown error", () => {
	const m = matchRetryableError("Unknown error (no error details in response)", {
		nl: false,
		statusCodes: [],
		errorPatterns: [],
	});
	assert.ok(m);
	assert.equal(m.tag, "[unknown-error-retry]");
});

test("legacy OpenAI Responses premature stream end", () => {
	const m = matchRetryableError("OpenAI Responses stream ended before a terminal response event", {
		nl: false,
		statusCodes: [],
		errorPatterns: [],
	});
	assert.ok(m);
	assert.equal(m.tag, "[openai-responses-stream-retry]");
});

test("legacy WebSocket stream closed before completion", () => {
	const m = matchRetryableError("WebSocket stream closed before response.completed", {
		nl: false,
		statusCodes: [],
		errorPatterns: [],
	});
	assert.ok(m);
	assert.equal(m.tag, "[websocket-stream-closed-retry]");
});

test("legacy no response body variants", () => {
	for (const msg of [
		"No response body",
		"Attempted to iterate over an Anthropic response with no body",
	]) {
		const m = matchRetryableError(msg, { nl: false, statusCodes: [], errorPatterns: [] });
		assert.ok(m, msg);
		assert.equal(m.tag, "[no-response-body-retry]");
	}
});

test("legacy generic unknown / error stop reason", () => {
	for (const msg of ["An unknown error occurred", "Provider returned an error stop reason"]) {
		const m = matchRetryableError(msg, { nl: false, statusCodes: [], errorPatterns: [] });
		assert.ok(m, msg);
		assert.equal(m.tag, "[unknown-error-occurred-retry]");
	}
});

test("legacy network errno", () => {
	for (const msg of ["read ECONNRESET", "connect ECONNREFUSED 127.0.0.1:1", "getaddrinfo ENOTFOUND api.example.com"]) {
		const m = matchRetryableError(msg, { nl: false, statusCodes: [], errorPatterns: [] });
		assert.ok(m, msg);
		assert.equal(m.tag, "[network-errno-retry]");
	}
});

test("legacy bad gateway text", () => {
	const m = matchRetryableError("Bad gateway", {
		nl: false,
		statusCodes: [],
		errorPatterns: [],
	});
	assert.ok(m);
	assert.equal(m.tag, "[bad-gateway-retry]");
});

test("HTTP 520 is retryable via status codes", () => {
	const m = matchRetryableError("520 status code (no body)", {
		nl: false,
		statusCodes: [520, 521, 522, 523, 524],
		errorPatterns: [],
	});
	assert.ok(m);
	assert.equal(m.tag, "[kun-retry-http-520]");
});

test("user abort / quota remain non-matching in bounded mode", () => {
	for (const msg of [
		"Operation aborted",
		"Request was aborted",
		"insufficient_quota",
		"Monthly usage limit reached",
		"No API key for provider: foo",
	]) {
		const m = matchRetryableError(msg, { nl: false, statusCodes: [401, 403, 520], errorPatterns: [] });
		assert.equal(m, undefined, msg);
	}
});

test("nl neutralizes non-retryable quota/billing tokens", () => {
	const { text, neutralized } = neutralizeNonRetryable("insufficient_quota: billing problem");
	assert.ok(neutralized.length >= 2);
	// Zero-width space must break the literal token so built-in classifier misses it.
	assert.equal(/insufficient_quota/.test(text), false);
	assert.equal(/billing/.test(text), false);
	// Still human-readable (chars preserved apart from the invisible marker).
	assert.ok(text.includes("quota"));
	assert.ok(text.includes("illing"));
});

test("neutralize is idempotent enough on already-broken text", () => {
	const first = neutralizeNonRetryable("billing").text;
	const second = neutralizeNonRetryable(first).text;
	assert.equal(second, first);
});

test("empty content: no blocks / non-array is empty", () => {
	assert.equal(isEmptyAssistantContent([]), true);
	assert.equal(isEmptyAssistantContent(undefined), true);
	assert.equal(isEmptyAssistantContent(null), true);
});

test("empty content: whitespace-only text is empty", () => {
	assert.equal(isEmptyAssistantContent([{ type: "text", text: "   \n\t" }]), true);
	assert.equal(isEmptyAssistantContent([{ type: "text", text: "" }]), true);
});

test("empty content: thinking-only is empty (reasoning is not usable output)", () => {
	assert.equal(isEmptyAssistantContent([{ type: "thinking", thinking: "  " }]), true);
	assert.equal(isEmptyAssistantContent([{ type: "thinking", thinking: "pondering hard" }]), true);
	assert.equal(
		isEmptyAssistantContent([
			{ type: "thinking", thinking: "pondering" },
			{ type: "text", text: "" },
		]),
		true,
	);
});

test("non-empty content: real text", () => {
	assert.equal(isEmptyAssistantContent([{ type: "text", text: "hello" }]), false);
});

test("non-empty content: tool call", () => {
	assert.equal(isEmptyAssistantContent([{ type: "toolCall", name: "read" }]), false);
});

test("non-empty content: thinking then real text", () => {
	assert.equal(
		isEmptyAssistantContent([
			{ type: "thinking", thinking: "pondering" },
			{ type: "text", text: "here is the answer" },
		]),
		false,
	);
});

test("unknown block type is treated as non-empty (safe)", () => {
	assert.equal(isEmptyAssistantContent([{ type: "image" }]), false);
});

test("appendRetryHint is idempotent", () => {
	const once = appendRetryHint("boom", {
		tag: "[t]",
		label: "x",
		notification: "n",
	});
	assert.ok(once.includes(RETRYABLE_HINT));
	const twice = appendRetryHint(once, {
		tag: "[t]",
		label: "x",
		notification: "n",
	});
	assert.equal(twice, once);
});
