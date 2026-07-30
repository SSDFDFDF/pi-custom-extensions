/**
 * Convert a regular OpenAI Responses request into the Responses Lite shape
 * used by current Codex for models whose metadata sets `use_responses_lite`.
 *
 * The function mutates the supplied shallow-cloned payload. It deliberately
 * checks for an `input` array so enabling the profile cannot rewrite an
 * Anthropic Messages or other unrelated provider payload.
 */
export function applyCodexResponsesLite(payload: Record<string, unknown>): boolean {
	if (!Array.isArray(payload.input)) return false;

	let changed = false;
	const prefix: Record<string, unknown>[] = [];

	// Codex Lite transports tools as the first input item, not as a top-level
	// Responses field. Include the item even for an empty tool list, matching
	// codex-rs's request builder.
	if (Array.isArray(payload.tools)) {
		prefix.push({
			type: "additional_tools",
			role: "developer",
			tools: payload.tools,
		});
		delete payload.tools;
		changed = true;
	}

	// Pi normally already represents its system prompt as a developer input
	// message. This also handles custom providers that populate `instructions`.
	if (typeof payload.instructions === "string" && payload.instructions.length > 0) {
		prefix.push({
			type: "message",
			role: "developer",
			content: [{ type: "input_text", text: payload.instructions }],
		});
	}
	if ("instructions" in payload) {
		delete payload.instructions;
		changed = true;
	}

	if (prefix.length > 0) {
		payload.input = [...prefix, ...payload.input];
		changed = true;
	}

	// ResponsesApiRequest in codex-rs does not send this SDK field. Pi derives
	// it from the model's advertised maxTokens, which is the likely validation
	// incompatibility for relays implementing only the Lite contract.
	if ("max_output_tokens" in payload) {
		delete payload.max_output_tokens;
		changed = true;
	}

	if (payload.tool_choice !== "auto") {
		payload.tool_choice = "auto";
		changed = true;
	}
	if (payload.parallel_tool_calls !== false) {
		payload.parallel_tool_calls = false;
		changed = true;
	}

	const reasoning = isRecord(payload.reasoning) ? { ...payload.reasoning } : {};
	if (reasoning.context !== "all_turns") {
		reasoning.context = "all_turns";
		payload.reasoning = reasoning;
		changed = true;
	}

	const text = isRecord(payload.text) ? { ...payload.text } : {};
	if (text.verbosity === undefined) {
		text.verbosity = "low";
		payload.text = text;
		changed = true;
	}

	const include = Array.isArray(payload.include) ? [...payload.include] : [];
	if (!include.includes("reasoning.encrypted_content")) {
		include.push("reasoning.encrypted_content");
		payload.include = include;
		changed = true;
	}

	return changed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
