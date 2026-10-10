/**
 * prompt-cache-key — Pi extension
 *
 * Two independent affinity signals for custom `models.json` endpoints, which
 * pi-ai does not cover on its own:
 *
 * 1. Session-affinity HTTP headers (`before_provider_headers`), default ON.
 *    pi-ai only sends them when it detects OpenRouter
 *    (`compat.sendSessionAffinityHeaders`), so every other OpenAI-compatible
 *    base URL gets no affinity header at all. Preset `generic` sends the
 *    vendor-neutral `X-Session-ID`.
 *
 * 2. The `prompt_cache_key` body field (`before_provider_request`), default OFF.
 *    pi-ai only emits it when the base URL contains `api.openai.com` or cache
 *    retention is `"long"`. Many strict gateways reject the field outright with
 *    HTTP 400 (`Unsupported parameter(s): prompt_cache_key`), so it is opt-in.
 *
 * Scope: bodies are only patched when they look like Chat Completions payloads.
 * OpenAI Responses, Azure Responses, and Codex Responses already send the key
 * themselves, and Anthropic Messages uses `cache_control` instead.
 *
 * Rejected parameters are disabled per provider automatically (see
 * `autoDisableOnRejection`), so a strict gateway degrades instead of failing
 * every request in Pi's (possibly unlimited) retry loop.
 *
 * Config: `~/.pi/agent/prompt-cache-key.config.json`, created with defaults on
 * first load. `/prompt-cache` shows and edits the runtime state.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type PromptCacheKeyConfig,
	type SessionHeaderPreset,
	cloneConfig,
	ensureConfigFile,
	formatConfigSummary,
	isProviderAllowed,
	loadConfig,
	rejectedHeadersFor,
	resolveSessionHeaderNames,
	saveConfig,
	updateConfig,
	withHeadersDisabled,
	withPromptCacheKeyDisabled,
	configPath,
} from "./config.ts";

export const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;

/** `400: {"message":"Validation: Unsupported parameter(s): `prompt_cache_key`"}` */
const REJECTION_HINT_PATTERN =
	/(unsupported|unknown|unexpected|invalid|unrecognized|not\s+(?:allowed|permitted|supported|recognized)|extra\s+(?:field|key|param)|forbidden|validation)/i;
const REJECTION_STATUS_PATTERN = /\b(?:400|422)\b/;

export function clampPromptCacheKey(key: string): string {
	const chars = Array.from(key);
	return chars.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH
		? key
		: chars.slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True for an OpenAI Chat Completions body and no other API Pi speaks. */
export function isChatCompletionsPayload(payload: unknown): payload is Record<string, unknown> {
	if (!isRecord(payload)) return false;
	if (!Array.isArray(payload.messages)) return false; // Chat Completions-only marker
	if (payload.input !== undefined) return false; // openai-responses / azure-openai-responses
	if (payload.system !== undefined) return false; // anthropic-messages
	if (payload.anthropic_version !== undefined) return false;
	return true;
}

/**
 * Returns a copy of `payload` with `prompt_cache_key` set to the session ID,
 * or `undefined` when nothing should change (not a Chat Completions body, no
 * session ID, or a non-empty key is already present).
 */
export function injectPromptCacheKey(
	payload: unknown,
	sessionId: string | undefined,
): Record<string, unknown> | undefined {
	if (!sessionId) return undefined;
	if (!isChatCompletionsPayload(payload)) return undefined;
	const existing = payload.prompt_cache_key;
	if (typeof existing === "string" && existing.length > 0) return undefined;
	return { ...payload, prompt_cache_key: clampPromptCacheKey(sessionId) };
}

/** Pure: header names to inject for `provider` with this config, minus rejected ones. */
export function sessionHeaderNamesFor(
	config: PromptCacheKeyConfig,
	provider: string,
): string[] {
	if (!config.headers.enabled) return [];
	if (!isProviderAllowed(provider, config.headers.providers)) return [];
	const rejected = rejectedHeadersFor(config, provider);
	return resolveSessionHeaderNames(config.headers.presets, config.headers.names).filter(
		(name) => !rejected.has(name.toLowerCase()),
	);
}

/** Pure: whether the `prompt_cache_key` body field should be injected for `provider`. */
export function promptCacheKeyEnabledFor(
	config: PromptCacheKeyConfig,
	provider: string,
): boolean {
	if (!config.promptCacheKey.enabled) return false;
	if (!isProviderAllowed(provider, config.promptCacheKey.providers)) return false;
	return !config.disabled.promptCacheKeyProviders.includes(provider);
}

/**
 * Sets each name in `names` on `headers` unless a case-equivalent header is
 * already present. Returns the names actually written.
 */
export function applySessionHeaders(
	headers: Record<string, string | null>,
	names: string[],
	sessionId: string,
): string[] {
	const existing = new Set(Object.keys(headers).map((name) => name.toLowerCase()));
	const written: string[] = [];
	for (const name of names) {
		const lower = name.toLowerCase();
		if (existing.has(lower)) continue;
		headers[name] = sessionId;
		existing.add(lower);
		written.push(name);
	}
	return written;
}

export interface RejectedParameters {
	/** The provider rejected the `prompt_cache_key` body field. */
	promptCacheKey: boolean;
	/** Header names mentioned in a rejection response, in input order. */
	headers: string[];
}

/**
 * Extract parameters a provider explicitly rejected.
 *
 * Requires a 400/422 status, a rejection keyword, and an exact parameter name,
 * so gateway errors that merely echo the request body do not disable anything.
 */
export function detectRejections(errorMessage: string, headerNames: string[]): RejectedParameters {
	if (!REJECTION_STATUS_PATTERN.test(errorMessage)) return { promptCacheKey: false, headers: [] };
	if (!REJECTION_HINT_PATTERN.test(errorMessage)) return { promptCacheKey: false, headers: [] };
	const lower = errorMessage.toLowerCase();
	return {
		promptCacheKey: lower.includes("prompt_cache_key"),
		headers: headerNames.filter((name) => name && lower.includes(name.toLowerCase())),
	};
}

type AssistantErrorShape = {
	role?: unknown;
	provider?: unknown;
	errorMessage?: unknown;
};

export default function (pi: ExtensionAPI) {
	let config = loadConfig();

	const refreshConfig = (): PromptCacheKeyConfig => {
		config = loadConfig();
		return config;
	};

	const setStatus = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		// Keep the footer quiet in the default configuration.
		if (!config.promptCacheKey.enabled) {
			ctx.ui.setStatus("prompt-cache-key", undefined);
			return;
		}
		ctx.ui.setStatus("prompt-cache-key", "cache-key");
	};

	pi.on("session_start", (_event, ctx) => {
		try {
			ensureConfigFile();
		} catch {
			// Read-only config dir: defaults still apply.
		}
		refreshConfig();
		setStatus(ctx);
	});

	// ── HTTP header layer: session affinity ────────────────────────────────

	pi.on("before_provider_headers", (event, ctx) => {
		if (!config.headers.enabled) return;
		const model = ctx.model;
		const provider = model?.provider;
		if (!provider) return;
		if (config.headers.apis.length > 0 && !config.headers.apis.includes(model?.api ?? "")) return;
		const sessionId = ctx.sessionManager.getSessionId();
		if (!sessionId) return;
		const names = sessionHeaderNamesFor(config, provider);
		if (names.length === 0) return;
		applySessionHeaders(event.headers, names, sessionId);
	});

	// ── Body layer: prompt_cache_key (opt-in) ──────────────────────────────

	pi.on("before_provider_request", (event, ctx) => {
		if (!config.promptCacheKey.enabled) return;
		// `openai-completions` is the only API that can omit the key; everything
		// else either sends it already or has no such concept.
		if (ctx.model && ctx.model.api !== "openai-completions") return;
		const provider = ctx.model?.provider;
		if (provider && !promptCacheKeyEnabledFor(config, provider)) return;
		return injectPromptCacheKey(event.payload, ctx.sessionManager.getSessionId());
	});

	// ── Degrade gracefully when a gateway rejects a parameter ──────────────

	pi.on("message_end", (event, ctx) => {
		if (!config.autoDisableOnRejection) return;
		const message = event.message as unknown as AssistantErrorShape;
		if (message.role !== "assistant") return;
		if (typeof message.errorMessage !== "string" || !message.errorMessage) return;
		const provider =
			typeof message.provider === "string" && message.provider
				? message.provider
				: ctx.model?.provider;
		if (!provider) return;

		const headerNames = resolveSessionHeaderNames(config.headers.presets, config.headers.names);
		const rejected = detectRejections(message.errorMessage, headerNames);
		const notes: string[] = [];
		let next = config;

		if (rejected.promptCacheKey && promptCacheKeyEnabledFor(config, provider)) {
			next = withPromptCacheKeyDisabled(next, provider);
			notes.push("prompt_cache_key body field");
		}
		const rejectedHere = rejected.headers.filter(
			(name) => !rejectedHeadersFor(config, provider).has(name.toLowerCase()),
		);
		if (rejectedHere.length > 0) {
			next = withHeadersDisabled(next, provider, rejectedHere);
			notes.push(`header(s) ${rejectedHere.join(", ")}`);
		}
		if (notes.length === 0) return;

		try {
			config = saveConfig(next);
		} catch {
			// Persisting failed (read-only dir); keep the in-memory degradation.
			config = cloneConfig(next);
		}
		ctx.ui.notify(
			`prompt-cache-key: ${provider} rejected ${notes.join(" and ")}; disabled for this provider.`,
			"warning",
		);
	});

	// ── /prompt-cache ──────────────────────────────────────────────────────

	pi.registerCommand("prompt-cache", {
		description:
			"prompt-cache-key: status | headers <on|off> | key <on|off> | auto <on|off> | reset [provider] | path",
		getArgumentCompletions: (prefix: string) => {
			const subs = ["status", "headers", "key", "auto", "reset", "path"];
			if (prefix.startsWith("headers ") || prefix.startsWith("key ") || prefix.startsWith("auto ")) {
				const rest = prefix.slice(prefix.indexOf(" ") + 1);
				return ["on", "off"]
					.filter((value) => value.startsWith(rest))
					.map((value) => ({ value: `${prefix.split(" ")[0]} ${value}`, label: value }));
			}
			return subs
				.filter((sub) => sub.startsWith(prefix))
				.map((sub) => ({ value: sub, label: sub }));
		},
		handler: async (args, ctx) => {
			refreshConfig();
			const [action = "status", value] = (args ?? "").trim().toLowerCase().split(/\s+/, 2);
			const parseToggle = (input: string | undefined, current: boolean): boolean | undefined => {
				if (input === undefined || input === "") return !current;
				if (input === "on" || input === "1" || input === "true" || input === "enable") return true;
				if (input === "off" || input === "0" || input === "false" || input === "disable") return false;
				return undefined;
			};

			switch (action) {
				case "headers":
				case "key":
				case "auto": {
					const current =
						action === "headers"
							? config.headers.enabled
							: action === "key"
								? config.promptCacheKey.enabled
								: config.autoDisableOnRejection;
					const next = parseToggle(value, current);
					if (next === undefined) {
						ctx.ui.notify(`Usage: /prompt-cache ${action} [on|off]`, "error");
						return;
					}
					config = updateConfig((draft) => {
						if (action === "headers") draft.headers.enabled = next;
						else if (action === "key") draft.promptCacheKey.enabled = next;
						else draft.autoDisableOnRejection = next;
					});
					setStatus(ctx);
					ctx.ui.notify(
						`prompt-cache-key: ${action} ${next ? "on" : "off"}\n${formatConfigSummary(config)}`,
						"info",
					);
					return;
				}
				case "reset": {
					config = updateConfig((draft) => {
						if (value) {
							draft.disabled.promptCacheKeyProviders = draft.disabled.promptCacheKeyProviders.filter(
								(provider) => provider !== value,
							);
							delete draft.disabled.headerProviders[value];
							return;
						}
						draft.disabled.promptCacheKeyProviders = [];
						draft.disabled.headerProviders = {};
					});
					ctx.ui.notify(`prompt-cache-key: cleared\n${formatConfigSummary(config)}`, "info");
					return;
				}
				case "path": {
					ctx.ui.notify(configPath(), "info");
					return;
				}
				default:
					ctx.ui.notify(formatConfigSummary(config), "info");
					return;
			}
		},
	});
}

export { configPath };
