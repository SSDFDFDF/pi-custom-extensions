import { mergeBetaFlags } from "./claude-body.ts";
import { resolveTemplate, type MimicProfile, type TemplateContext } from "./config.ts";

const ID_HEADERS: Record<string, string> = {
	"session-id": "session_id",
	"session_id": "session_id",
	"x-claude-code-session-id": "session_id",
	"thread-id": "thread_id",
	"x-codex-parent-thread-id": "parent_thread_id",
	"x-codex-installation-id": "installation_id",
	"x-codex-window-id": "window_id",
};

/** Shared in-place rewrite for normal requests and provider-level compaction. */
export function rewriteHeaders(
	headers: Record<string, string | null | undefined>,
	profile: MimicProfile,
	tctx: TemplateContext,
	forceIdentity = false,
): void {
	const strip = new Set(profile.stripHeaders.map((name) => name.toLowerCase()));
	for (const name of Object.keys(headers)) {
		if (strip.has(name.toLowerCase())) headers[name] = null;
	}
	for (const [name, rawValue] of Object.entries(profile.headers)) {
		const lower = name.toLowerCase();
		const existingKeys = Object.keys(headers).filter((key) => key.toLowerCase() === lower);
		const existingValue = existingKeys.map((key) => headers[key])
			.find((value): value is string => typeof value === "string" && value.trim().length > 0);
		for (const key of existingKeys) {
			if (key !== name) headers[key] = null;
		}
		if (rawValue === null) {
			headers[name] = null;
			continue;
		}
		// Explicit resets also replace hard-coded IDs in managed identity headers.
		const value = forceIdentity && ID_HEADERS[lower] ? `{${ID_HEADERS[lower]}}` : rawValue;
		const resolved = resolveTemplate(value, tctx);
		headers[name] = !resolved ? null
			: lower === "anthropic-beta" && existingValue ? mergeBetaFlags(existingValue, resolved)
			: resolved;
	}
}
