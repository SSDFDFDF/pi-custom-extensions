/**
 * Claude Code request-body helpers (metadata.user_id + billing system preamble).
 */

const CLAUDE_AGENT_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

/**
 * Ensure Anthropic Messages payload has Claude Code's metadata.user_id.
 * Real Claude Code sends a JSON string:
 *   {"device_id":"...","account_uuid":"","session_id":"..."}
 * Returns true if the payload was modified.
 */
export function ensureClaudeMetadata(
	payload: Record<string, unknown>,
	deviceId: string,
	sessionId: string,
	force = false,
): boolean {
	const existingMeta =
		payload.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
			? ({ ...(payload.metadata as Record<string, unknown>) } as Record<string, unknown>)
			: {};
	let user: Record<string, unknown> = {};
	if (typeof existingMeta.user_id === "string" && existingMeta.user_id.trim()) {
		if (!force) return false;
		try {
			const parsed: unknown = JSON.parse(existingMeta.user_id);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				user = parsed as Record<string, unknown>;
			}
		} catch { /* Replace non-JSON ids only after an explicit identity reset. */ }
	}
	const userId = JSON.stringify({
		...user,
		device_id: deviceId,
		account_uuid: user.account_uuid ?? "",
		session_id: sessionId,
	});
	if (existingMeta.user_id === userId) return false;
	existingMeta.user_id = userId;
	payload.metadata = existingMeta;
	return true;
}

/**
 * Prepend Claude Code's billing-header + Agent SDK identity blocks onto the
 * provider payload's `system` field. Handles both string and content-block
 * array forms. Returns true if modified.
 */
export function prependClaudeBillingSystem(
	payload: Record<string, unknown>,
	version: string,
): boolean {
	const billing = `x-anthropic-billing-header: cc_version=${version}; cc_entrypoint=cli;`;
	const sys = payload.system;

	// Only treat a leading system block that *starts with* the billing header as
	// already present. A mere substring match is too broad (seed prompts may
	// mention the header name in documentation text).
	if (hasLeadingBillingHeader(sys)) return false;

	if (sys == null || sys === "") {
		payload.system = [
			{ type: "text", text: billing },
			{ type: "text", text: CLAUDE_AGENT_IDENTITY },
		];
		return true;
	}

	if (typeof sys === "string") {
		const rest = sys.startsWith(CLAUDE_AGENT_IDENTITY)
			? [{ type: "text", text: sys }]
			: [
					{ type: "text", text: CLAUDE_AGENT_IDENTITY },
					{ type: "text", text: sys },
				];
		payload.system = [{ type: "text", text: billing }, ...rest];
		return true;
	}

	if (Array.isArray(sys)) {
		const blocks = sys.slice();
		const hasIdentity = systemContains(sys, "Claude Agent SDK");
		const prepend: Array<Record<string, unknown>> = [{ type: "text", text: billing }];
		if (!hasIdentity) prepend.push({ type: "text", text: CLAUDE_AGENT_IDENTITY });
		payload.system = prepend.concat(blocks);
		return true;
	}

	return false;
}

/** Union comma-separated anthropic-beta flags, preserving first-seen order. */
export function mergeBetaFlags(existing: string, incoming: string): string {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const part of `${existing},${incoming}`.split(",")) {
		const flag = part.trim();
		if (!flag || seen.has(flag)) continue;
		seen.add(flag);
		out.push(flag);
	}
	return out.join(",");
}

/** True only when the first system block/string starts with the billing header. */
export function hasLeadingBillingHeader(sys: unknown): boolean {
	const prefix = "x-anthropic-billing-header:";
	if (typeof sys === "string") return sys.trimStart().startsWith(prefix);
	if (!Array.isArray(sys) || sys.length === 0) return false;
	const first = sys[0];
	if (typeof first === "string") return first.trimStart().startsWith(prefix);
	if (first && typeof first === "object" && typeof (first as { text?: unknown }).text === "string") {
		return (first as { text: string }).text.trimStart().startsWith(prefix);
	}
	return false;
}

function systemContains(sys: unknown, needle: string): boolean {
	if (typeof sys === "string") return sys.includes(needle);
	if (!Array.isArray(sys)) return false;
	for (const block of sys) {
		if (typeof block === "string" && block.includes(needle)) return true;
		if (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string") {
			if ((block as { text: string }).text.includes(needle)) return true;
		}
	}
	return false;
}
