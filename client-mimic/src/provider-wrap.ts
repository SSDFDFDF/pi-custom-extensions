/**
 * Provider-level `streamSimple` wrapper that makes Claude-Code-style body
 * and header patching take effect even during pi paths that bypass extension
 * hooks — most importantly context compaction (`completeSummarization`),
 * which calls the provider's `streamSimple` directly.
 *
 * The fix: wrap the registered provider's `streamSimple` so that every call:
 *   1. Applies header rewrites (User-Agent, X-Stainless-*, anthropic-beta, etc.)
 *      by merging them into options.headers before the delegate call
 *   2. Chains an `onPayload` callback which:
 *      a. runs any pre-existing `options.onPayload` (normal-turn patches)
 *      b. applies Claude Code body helpers (metadata.user_id, billing/identity)
 *      c. ensures the `thinking` + `output_config` pair is present
 *
 * The wrapper delegates the actual HTTP call to the built-in anthropic
 * `streamSimple` (from `anthropicMessagesApi()`), which reads `model.baseUrl`,
 * `options.apiKey`, and `options.headers` — so our header rewrites take effect.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { anthropicMessagesApi } from "@earendil-works/pi-ai";
import {
	applyClaudeCodeBodyPatch,
	type ClaudeCodeWrapOptions,
} from "./claude-cc-body-fix.ts";
import { resolveTemplate, type TemplateContext, type MimicProfile } from "./config.ts";
import { mergeBetaFlags } from "./claude-body.ts";

export { applyClaudeCodeBodyPatch, type ClaudeCodeWrapOptions } from "./claude-cc-body-fix.ts";

/** Extended options including profile headers and template context. */
export interface WrapperOptions extends ClaudeCodeWrapOptions {
	/** The active mimic profile with headers to apply. */
	profile: MimicProfile;
	/** Template context for resolving header placeholders. */
	templateContext: TemplateContext;
}

/**
 * Build a `streamSimple` function that wraps the built-in anthropic
 * streamSimple, injecting both header rewrites and body patches.
 */
export function createClaudeCodeStreamSimpleWrapper(opts: WrapperOptions) {
	// Delegate to the built-in anthropic-messages streamSimple — the same
	// function the unwrapped provider would reach via getApiProvider().
	const delegate = anthropicMessagesApi().streamSimple;

	return function wrappedStreamSimple(model: any, context: any, options: any) {
		const prevOnPayload = options?.onPayload;

		const chainedOnPayload = async (payload: any, m: any) => {
			// 1. Run any pre-existing onPayload first (normal-turn before_provider_request).
			let current: any = payload;
			if (typeof prevOnPayload === "function") {
				const next = await prevOnPayload(current, m);
				if (next !== undefined) current = next;
			}
			// 2. Apply our Claude Code body patch.
			if (current && typeof current === "object") {
				const patched = applyClaudeCodeBodyPatch(
					current as Record<string, unknown>,
					opts,
				);
				if (patched !== undefined) return patched;
			}
			return current;
		};

		const wrappedOptions = { ...(options ?? {}) };
		// Always set onPayload so our patch runs even on compaction paths that
		// never set one. If prevOnPayload existed, it is chained inside.
		wrappedOptions.onPayload = chainedOnPayload;

		// Apply header rewrites: this fixes the core issue where compaction
		// bypasses before_provider_headers and sends pi's default headers.
		const existingHeaders = (options?.headers ?? {}) as Record<string, string | null | undefined>;
		const rewrittenHeaders = applyHeaderRewrites(
			existingHeaders,
			opts.profile,
			opts.templateContext,
		);
		wrappedOptions.headers = rewrittenHeaders;

		return delegate(model, context, wrappedOptions);
	};
}

/**
 * Apply the mimic profile's header rewrites to the existing headers object.
 * Mirrors the logic from index.ts `before_provider_headers` hook.
 */
function applyHeaderRewrites(
	existingHeaders: Record<string, string | null | undefined>,
	profile: MimicProfile,
	tctx: TemplateContext,
): Record<string, string | null | undefined> {
	const headers = { ...existingHeaders };

	// 1. Strip pi's own identifying headers (case-insensitive match).
	if (profile.stripHeaders.length) {
		const lowerStrip = new Set(profile.stripHeaders.map((s) => s.toLowerCase()));
		for (const existing of Object.keys(headers)) {
			if (lowerStrip.has(existing.toLowerCase())) {
				headers[existing] = null;
			}
		}
	}

	// 2. Apply profile headers (string = set/override, null = delete).
	// Handle case-insensitive deduplication and anthropic-beta merging.
	for (const [name, rawValue] of Object.entries(profile.headers)) {
		const lower = name.toLowerCase();
		const existingKeys = Object.keys(headers).filter((k) => k.toLowerCase() === lower);
		const existingValue = existingKeys
			.map((k) => headers[k])
			.find((v): v is string => typeof v === "string" && v.trim().length > 0);

		for (const existing of existingKeys) {
			if (existing !== name) headers[existing] = null;
		}

		if (rawValue === null) {
			headers[name] = null;
			continue;
		}

		const resolved = resolveTemplate(rawValue, tctx);
		// Empty resolved values delete the header (e.g. parent_thread_id on root).
		if (!resolved) {
			headers[name] = null;
			continue;
		}
		if (lower === "anthropic-beta" && existingValue) {
			headers[name] = mergeBetaFlags(existingValue, resolved);
		} else {
			headers[name] = resolved;
		}
	}

	return headers;
}

/**
 * Register the wrapper for the given provider ids via the legacy
 * `registerProvider(name, config)` merge form. This preserves the provider's
 * existing baseUrl/apiKey/models from models.json while overlaying our
 * `streamSimple`. `api` must also be set (validator requires it when
 * `streamSimple` is present).
 */
export function registerClaudeCodeWrappers(
	pi: ExtensionAPI,
	providerIds: string[],
	opts: WrapperOptions,
): { wrapped: string[]; skipped: string[] } {
	const wrapped: string[] = [];
	const skipped: string[] = [];
	for (const id of providerIds) {
		const trimmed = id.trim();
		if (!trimmed) continue;
		try {
			const streamSimple = createClaudeCodeStreamSimpleWrapper(opts);
			pi.registerProvider(trimmed, {
				api: "anthropic-messages",
				streamSimple,
			});
			wrapped.push(trimmed);
		}
		catch (err) {
			console.error(`[client-mimic] failed to wrap provider "${trimmed}":`, err);
			skipped.push(trimmed);
		}
	}
	return { wrapped, skipped };
}
