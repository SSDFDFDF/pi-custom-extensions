/**
 * Pure (no provider imports) Claude Code request-body patching for the
 * provider-level `streamSimple` wrapper.
 *
 * This module is deliberately free of any `@earendil-works/pi-ai` runtime
 * import so it can be unit-tested in isolation. See `provider-wrap.ts` for
 * the `streamSimple` wrapper that uses it.
 */
import { prependClaudeBillingSystem } from "./claude-body.ts";

/** Options used by the wrapper to decide which body helpers to apply. */
export interface ClaudeCodeWrapOptions {
	/** Stable per-machine device id (for metadata.user_id). */
	deviceId: string;
	/** Per-session id used in metadata.user_id. */
	sessionId: string;
	/** Whether to set metadata.user_id (Claude Code JSON form). */
	ensureMetadataUserId: boolean;
	/** Whether to prepend the billing-header + Agent SDK identity system blocks. */
	prependBillingSystem: boolean;
	/** Client version string (fills cc_version in the billing header). */
	version: string;
	/**
	 * Whether to enforce the `thinking` + `output_config` identity pair. Relays
	 * that gate on Claude Code identity require both fields; when thinking is
	 * disabled pi omits `output_config`, so we inject a minimal one. Default true.
	 */
	enforceThinkingIdentity: boolean;
}

/** Minimal effort value to inject when we must fabricate `output_config`. */
const FALLBACK_EFFORT = "high" as const;

/**
 * Apply the Claude Code body patches to a fully-built anthropic-messages
 * params object (i.e. the object `onPayload` receives, after `buildParams`).
 * Returns the (possibly new) params object, or `undefined` when unchanged —
 * matching the `onPayload` return contract.
 */
export function applyClaudeCodeBodyPatch(
	params: Record<string, unknown>,
	opts: ClaudeCodeWrapOptions,
): Record<string, unknown> | undefined {
	let p = params;
	let changed = false;

	const mutate = (fn: (obj: Record<string, unknown>) => void) => {
		if (!changed) {
			// Copy-on-write: only clone once for the whole chain.
			p = { ...p };
			changed = true;
		}
		fn(p);
	};

	// 1. metadata.user_id (Claude Code JSON form).
	if (opts.ensureMetadataUserId) {
		const existingMeta =
			p.metadata && typeof p.metadata === "object" && !Array.isArray(p.metadata)
				? (p.metadata as Record<string, unknown>)
				: null;
		const existingUserId =
			existingMeta && typeof existingMeta.user_id === "string" && existingMeta.user_id.trim()
				? existingMeta.user_id
				: null;
		if (existingUserId === null) {
			mutate((obj) => {
				const meta =
					obj.metadata && typeof obj.metadata === "object" && !Array.isArray(obj.metadata)
						? { ...(obj.metadata as Record<string, unknown>) }
						: {};
				meta.user_id = JSON.stringify({
					device_id: opts.deviceId,
					account_uuid: "",
					session_id: opts.sessionId,
				});
				obj.metadata = meta;
			});
		}
	}

	// 2. Billing-header + Agent SDK identity system preamble.
	if (opts.prependBillingSystem) {
		const probe = { ...p };
		if (prependClaudeBillingSystem(probe, opts.version)) {
			mutate((obj) => {
				prependClaudeBillingSystem(obj, opts.version);
			});
		}
	}

	// 3. Identity pair: ensure both `thinking` and `output_config` exist.
	if (opts.enforceThinkingIdentity) {
		const thinking = p.thinking;
		const hasThinking = thinking != null;
		const hasOutputConfig = p.output_config != null;

		if (!hasThinking) {
			// No thinking at all: inject a minimal adaptive thinking block. This
			// makes the body look like a Claude Code request even when the caller
			// (compaction) set thinkingLevel=off.
			mutate((obj) => {
				obj.thinking = { type: "adaptive", display: "summarized" };
			});
		}
		else if (
			typeof thinking === "object" &&
			(thinking as { type?: unknown }).type === "disabled"
		) {
			// Thinking explicitly disabled: relays still want the pair, so flip
			// to adaptive so there is something meaningful to carry an effort.
			mutate((obj) => {
				(obj as { thinking: { type: string; display?: string } }).thinking = {
					type: "adaptive",
					display: "summarized",
				};
			});
		}

		if (!hasOutputConfig) {
			mutate((obj) => {
				obj.output_config = { effort: FALLBACK_EFFORT };
			});
		}
	}

	return changed ? p : undefined;
}
