import assert from "node:assert/strict";
import test from "node:test";
import sessionErrorClean from "../index.ts";
import { RESPONSES_APIS, sanitizeResponsesPayload } from "../src/sanitize.ts";

function fixture() {
	return {
		model: "gpt-test",
		stream: true,
		store: false,
		reasoning: { effort: "high", summary: "auto", context: "all_turns" },
		prompt_cache_key: "keep-cache",
		include: ["reasoning.encrypted_content", "message.output_text.logprobs"],
		tools: [
			{
				type: "function",
				name: "read",
				parameters: {
					type: "object",
					properties: { encrypted_content: { type: "string" } },
				},
			},
		],
		input: [
			{
				role: "user",
				content: [
					{ type: "input_text", text: '{"encrypted_content":"user data"}' },
					{ type: "input_image", image_url: "data:image/png;base64,AAAA" },
				],
			},
			{ type: "reasoning", id: "rs_old", summary: [], encrypted_content: "cipher" },
			{
				type: "function_call",
				id: "fc_old",
				call_id: "call_1",
				name: "read",
				arguments: '{"encrypted_content":"argument data"}',
			},
			{
				type: "function_call_output",
				call_id: "call_1",
				output: '{"type":"reasoning","encrypted_content":"result data"}',
			},
			{
				type: "message",
				role: "assistant",
				id: "msg_old",
				phase: "final_answer",
				content: [{ type: "output_text", text: "正文", annotations: [] }],
			},
		],
	};
}

function freezeDeep(value: any) {
	if (value && typeof value === "object") {
		Object.values(value).forEach(freezeDeep);
		Object.freeze(value);
	}
	return value;
}

function clean(payload: unknown): any {
	const result = sanitizeResponsesPayload(payload);
	assert.ok(result);
	return result;
}

test("drop reasoning from input, retain include (required by CPA/Codex), active thinking, and request settings", () => {
	const source = fixture();
	const result = clean(source);
	assert.equal(result.input.length, 4);
	assert.equal(
		result.input.some((item: any) => item.type === "reasoning"),
		false,
	);
	assert.deepEqual(result.include, ["reasoning.encrypted_content", "message.output_text.logprobs"]);
	for (const key of ["model", "stream", "store", "reasoning", "prompt_cache_key", "tools"] as const) {
		assert.deepEqual(result[key], source[key]);
	}
});

test("remove old item IDs but retain call/result pairing and assistant phase", () => {
	const result = clean(fixture());
	assert.equal("id" in result.input[1], false);
	assert.equal(result.input[1].call_id, "call_1");
	assert.equal(result.input[2].call_id, "call_1");
	assert.equal("id" in result.input[3], false);
	assert.equal(result.input[3].phase, "final_answer");
});

test("do not parse user text or tool data, strip schemas, or drop images", () => {
	const source = fixture();
	const result = clean(source);
	assert.deepEqual(result.input[0], source.input[0]);
	assert.deepEqual(result.input[2], source.input[3]);
	assert.equal(result.input[1].arguments, source.input[2].arguments);
	assert.deepEqual(result.tools, source.tools);
});

test("immutable and idempotent, including frozen histories", () => {
	const source = freezeDeep(fixture());
	const snapshot = JSON.stringify(source);
	const result = clean(source);
	assert.equal(JSON.stringify(source), snapshot);
	assert.deepEqual(clean(result), result);
});

test("support custom tool calls without touching call IDs or custom input", () => {
	const result = clean({
		input: [
			{ type: "custom_tool_call", id: "ctc_1", call_id: "c1", name: "patch", input: "abc" },
			{ type: "custom_tool_call_output", call_id: "c1", output: "ok" },
		],
	});
	assert.deepEqual(result.input, [
		{ type: "custom_tool_call", call_id: "c1", name: "patch", input: "abc" },
		{ type: "custom_tool_call_output", call_id: "c1", output: "ok" },
	]);
});

test("preserve Lite additional_tools and developer IDs", () => {
	const source = {
		input: [
			{ type: "additional_tools", role: "developer", id: "at_1", tools: [] },
			{ type: "message", role: "developer", id: "msg_1", content: "instructions" },
			{ type: "reasoning", id: "rs_1", summary: [] },
		],
		reasoning: { context: "all_turns" },
	};
	assert.deepEqual(clean(source), { ...source, input: source.input.slice(0, 2) });
});

test("remove reasoning references and assistant encrypted protocol fields", () => {
	const result = clean({
		input: [
			{ type: "item_reference", id: "rs_123" },
			{ type: "encrypted_content", data: "cipher" },
			{
				type: "message",
				role: "assistant",
				encrypted_content: "cipher",
				content: [
					{ type: "encrypted_content", data: "cipher" },
					{ type: "output_text", text: "ok", encrypted_content: "cipher" },
				],
			},
			{ role: "assistant", content: [{ type: "encrypted_content", data: "cipher" }] },
		],
	});
	assert.deepEqual(result.input, [
		{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
	]);
});

test("hook covers each Responses API and compat subcommand toggles it", async () => {
	const handlers = new Map<string, any>();
	const commands = new Map<string, any>();
	sessionErrorClean({
		on: (name: string, handler: any) => {
			handlers.set(name, handler);
		},
		registerFlag: () => {},
		getFlag: () => false,
		registerCommand: (name: string, command: any) => {
			commands.set(name, command);
		},
	} as any);
	const notifications: string[] = [];
	const ctx = {
		model: { api: "openai-responses" },
		hasUI: true,
		ui: { notify: (message: string) => notifications.push(message) },
		sessionManager: { getSessionFile: () => undefined },
	};
	for (const api of RESPONSES_APIS) {
		const payload = handlers.get("before_provider_request")({ payload: fixture() }, { ...ctx, model: { api } });
		assert.ok(Array.isArray(payload.input));
		assert.equal(
			payload.input.some((item: any) => item.type === "reasoning"),
			false,
		);
		assert.ok(payload.include.includes("reasoning.encrypted_content"));
	}
	await commands.get("clean-errors").handler("compat off", ctx);
	assert.equal(handlers.get("before_provider_request")({ payload: fixture() }, ctx), undefined);
	await commands.get("clean-errors").handler("compat on", ctx);
	assert.ok(handlers.get("before_provider_request")({ payload: fixture() }, ctx));
});
