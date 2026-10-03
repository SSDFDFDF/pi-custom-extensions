type RecordValue = Record<string, unknown>;

export const RESPONSES_APIS = new Set([
	"openai-responses",
	"openai-codex-responses",
	"azure-openai-responses",
]);

function isRecord(value: unknown): value is RecordValue {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Clean only Responses protocol fields in outbound requests, never arbitrary
 * tool arguments/results, tool schemas, metadata, or JSON embedded in user text.
 * No in-place mutations. Undefined means this is not a full-history Responses payload.
 *
 * Note: `payload.include` (e.g. `["reasoning.encrypted_content"]`) is intentionally
 * preserved — Codex/CPA gateways require it on `store: false` reasoning requests,
 * and it only controls the current turn's response stream, not historical input validation.
 */
export function sanitizeResponsesPayload(payload: unknown): RecordValue | undefined {
	if (!isRecord(payload) || !Array.isArray(payload.input)) return undefined;

	const input = payload.input.flatMap((item: unknown): unknown[] => {
		if (!isRecord(item)) return [item];
		if (item.type === "reasoning" || item.type === "encrypted_content") return [];
		if (item.type === "item_reference" && typeof item.id === "string" && item.id.startsWith("rs_")) {
			return [];
		}

		const assistantMessage =
			item.role === "assistant" && (item.type === "message" || item.type === undefined);
		const toolCall = item.type === "function_call" || item.type === "custom_tool_call";
		if (!assistantMessage && !toolCall) return [item];

		const clean = { ...item };
		// Item IDs may be associated with a removed rs_* item on the old backend.
		// call_id is the local call/result pairing key and MUST remain unchanged.
		delete clean.id;
		delete clean.encrypted_content;
		if (assistantMessage && Array.isArray(item.content)) {
			clean.content = item.content.flatMap((block: unknown): unknown[] => {
				if (!isRecord(block)) return [block];
				if (block.type === "encrypted_content") return [];
				if (!("encrypted_content" in block)) return [block];
				const content = { ...block };
				delete content.encrypted_content;
				return [content];
			});
			if (item.content.length > 0 && (clean.content as unknown[]).length === 0) return [];
		}
		return [clean];
	});

	return { ...payload, input };
}
