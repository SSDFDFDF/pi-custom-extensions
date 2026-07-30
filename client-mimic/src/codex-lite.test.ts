import assert from "node:assert/strict";
import test from "node:test";
import { applyCodexResponsesLite } from "./codex-lite.ts";

test("converts a regular Responses payload to the Codex Lite contract", () => {
	const tools = [{ type: "function", name: "shell", parameters: { type: "object" } }];
	const payload: Record<string, unknown> = {
		model: "gpt-5.6-sol",
		instructions: "system prompt",
		input: [{ role: "user", content: "hello" }],
		tools,
		tool_choice: "required",
		parallel_tool_calls: true,
		max_output_tokens: 128000,
		reasoning: { effort: "high", summary: "auto" },
		text: { format: { type: "text" } },
		include: ["some.other.field"],
	};

	assert.equal(applyCodexResponsesLite(payload), true);
	assert.equal("tools" in payload, false);
	assert.equal("instructions" in payload, false);
	assert.equal("max_output_tokens" in payload, false);
	assert.equal(payload.tool_choice, "auto");
	assert.equal(payload.parallel_tool_calls, false);
	assert.deepEqual(payload.reasoning, {
		effort: "high",
		summary: "auto",
		context: "all_turns",
	});
	assert.deepEqual(payload.text, { format: { type: "text" }, verbosity: "low" });
	assert.deepEqual(payload.include, ["some.other.field", "reasoning.encrypted_content"]);

	const input = payload.input as Record<string, unknown>[];
	assert.deepEqual(input[0], {
		type: "additional_tools",
		role: "developer",
		tools,
	});
	assert.deepEqual(input[1], {
		type: "message",
		role: "developer",
		content: [{ type: "input_text", text: "system prompt" }],
	});
	assert.deepEqual(input[2], { role: "user", content: "hello" });
});

test("is idempotent after a payload has been converted", () => {
	const payload: Record<string, unknown> = {
		model: "gpt-5.6-sol",
		input: [],
		tools: [],
	};

	assert.equal(applyCodexResponsesLite(payload), true);
	const converted = structuredClone(payload);
	assert.equal(applyCodexResponsesLite(payload), false);
	assert.deepEqual(payload, converted);
});

test("does not rewrite non-Responses payloads", () => {
	const payload: Record<string, unknown> = {
		model: "claude-opus-4-1",
		messages: [{ role: "user", content: "hello" }],
		max_tokens: 1024,
	};

	assert.equal(applyCodexResponsesLite(payload), false);
	assert.deepEqual(payload, {
		model: "claude-opus-4-1",
		messages: [{ role: "user", content: "hello" }],
		max_tokens: 1024,
	});
});
