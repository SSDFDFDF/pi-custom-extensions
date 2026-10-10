/**
 * prompt-cache-key configuration.
 *
 * File: `~/.pi/agent/prompt-cache-key.config.json` (override the agent dir with
 * `PI_CODING_AGENT_DIR`). Missing file / missing fields / parse errors fall back
 * to {@link DEFAULT_CONFIG}, so the extension always has a usable config.
 *
 * Two independent features:
 *
 * 1. `headers` — session-affinity HTTP headers injected in `before_provider_headers`
 *    (default ON, preset `generic` → `X-Session-ID`). Vendor-neutral, cheap, and
 *    the only affinity signal every OpenAI/Anthropic-compatible gateway sees.
 * 2. `promptCacheKey` — the `prompt_cache_key` body field (default OFF). Many
 *    strict gateways reject the field with HTTP 400
 *    (`Unsupported parameter(s): prompt_cache_key`), so it is opt-in.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";

/** Header names contributed by each session-affinity preset. */
export const SESSION_HEADER_PRESETS: Record<string, readonly string[]> = {
	/** Vendor-neutral header; understood by most relays and gateways. */
	generic: ["X-Session-ID"],
	/** OpenAI / Azure style affinity headers. */
	openai: ["session_id", "x-client-request-id", "x-session-affinity"],
	/** OpenRouter's affinity header. */
	openrouter: ["x-session-id"],
	/** opencode session header. */
	opencode: ["x-opencode-session"],
};

export type SessionHeaderPreset = "generic" | "openai" | "openrouter" | "opencode";

export const SESSION_HEADER_PRESET_NAMES: SessionHeaderPreset[] = [
	"generic",
	"openai",
	"openrouter",
	"opencode",
];

/** Provider allow/deny filter. Empty `allow` means "all providers". */
export interface ProviderFilter {
	allow: string[];
	deny: string[];
}

export interface PromptCacheKeyConfig {
	headers: {
		enabled: boolean;
		/** Presets to apply, in order. */
		presets: SessionHeaderPreset[];
		/** Extra literal header names appended after the presets. */
		names: string[];
		/** API ids to limit header injection to. Empty = every API. */
		apis: string[];
		providers: ProviderFilter;
	};
	promptCacheKey: {
		/** Default OFF: `prompt_cache_key` is rejected by many strict gateways. */
		enabled: boolean;
		providers: ProviderFilter;
	};
	/** Auto-disable a rejected feature for the provider that rejected it. */
	autoDisableOnRejection: boolean;
	disabled: {
		/** Providers whose gateway rejected the `prompt_cache_key` body field. */
		promptCacheKeyProviders: string[];
		/** Provider id → lowercased header names rejected by that provider. */
		headerProviders: Record<string, string[]>;
	};
}

export const DEFAULT_CONFIG: PromptCacheKeyConfig = {
	headers: {
		enabled: true,
		presets: ["generic"],
		names: [],
		apis: [],
		providers: { allow: [], deny: [] },
	},
	promptCacheKey: {
		enabled: false,
		providers: { allow: [], deny: [] },
	},
	autoDisableOnRejection: true,
	disabled: {
		promptCacheKeyProviders: [],
		headerProviders: {},
	},
};

const CONFIG_FILE_NAME = "prompt-cache-key.config.json";

export function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? ".", ".pi", "agent");
}

export function configPath(): string {
	return join(agentDir(), CONFIG_FILE_NAME);
}

export function cloneConfig(config: PromptCacheKeyConfig): PromptCacheKeyConfig {
	return {
		headers: {
			...config.headers,
			presets: [...config.headers.presets],
			names: [...config.headers.names],
			apis: [...config.headers.apis],
			providers: {
				allow: [...config.headers.providers.allow],
				deny: [...config.headers.providers.deny],
			},
		},
		promptCacheKey: {
			...config.promptCacheKey,
			providers: {
				allow: [...config.promptCacheKey.providers.allow],
				deny: [...config.promptCacheKey.providers.deny],
			},
		},
		autoDisableOnRejection: config.autoDisableOnRejection,
		disabled: {
			promptCacheKeyProviders: [...config.disabled.promptCacheKeyProviders],
			headerProviders: Object.fromEntries(
				Object.entries(config.disabled.headerProviders).map(([key, value]) => [key, [...value]]),
			),
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeStringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") continue;
		const trimmed = entry.trim();
		if (trimmed && !out.includes(trimmed)) out.push(trimmed);
	}
	return out;
}

function normalizeFilter(value: unknown): ProviderFilter {
	const record = isRecord(value) ? value : {};
	return { allow: normalizeStringList(record.allow), deny: normalizeStringList(record.deny) };
}

function normalizePresets(value: unknown): SessionHeaderPreset[] {
	if (!Array.isArray(value)) return [...DEFAULT_CONFIG.headers.presets];
	const out: SessionHeaderPreset[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") continue;
		const preset = entry.trim().toLowerCase() as SessionHeaderPreset;
		if (SESSION_HEADER_PRESET_NAMES.includes(preset) && !out.includes(preset)) out.push(preset);
	}
	return out;
}

function normalizeHeaderProviders(value: unknown): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	if (!isRecord(value)) return out;
	for (const [provider, names] of Object.entries(value)) {
		const key = provider.trim();
		if (!key) continue;
		const list = normalizeStringList(names).map((name) => name.toLowerCase());
		if (list.length > 0) out[key] = [...new Set(list)];
	}
	return out;
}

export function normalizeConfig(raw: unknown): PromptCacheKeyConfig {
	const record = isRecord(raw) ? raw : {};
	const headers = isRecord(record.headers) ? record.headers : {};
	const promptCacheKey = isRecord(record.promptCacheKey) ? record.promptCacheKey : {};
	const disabled = isRecord(record.disabled) ? record.disabled : {};

	return {
		headers: {
			enabled: headers.enabled !== false,
			presets: normalizePresets(headers.presets),
			names: normalizeStringList(headers.names),
			apis: normalizeStringList(headers.apis),
			providers: normalizeFilter(headers.providers),
		},
		promptCacheKey: {
			enabled: promptCacheKey.enabled === true,
			providers: normalizeFilter(promptCacheKey.providers),
		},
		autoDisableOnRejection: record.autoDisableOnRejection !== false,
		disabled: {
			promptCacheKeyProviders: normalizeStringList(disabled.promptCacheKeyProviders),
			headerProviders: normalizeHeaderProviders(disabled.headerProviders),
		},
	};
}

export function loadConfig(): PromptCacheKeyConfig {
	const path = configPath();
	if (!existsSync(path)) return cloneConfig(DEFAULT_CONFIG);
	try {
		return normalizeConfig(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return cloneConfig(DEFAULT_CONFIG);
	}
}

export function saveConfig(config: PromptCacheKeyConfig): PromptCacheKeyConfig {
	const normalized = normalizeConfig(config);
	const path = configPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(normalized, null, 2)}\n`);
	return normalized;
}

/** Load, mutate a copy, persist. Returns the persisted config. */
export function updateConfig(mutate: (draft: PromptCacheKeyConfig) => void): PromptCacheKeyConfig {
	const draft = loadConfig();
	mutate(draft);
	return saveConfig(draft);
}

/** Write the default config file when none exists (discoverability). */
export function ensureConfigFile(): void {
	const path = configPath();
	if (existsSync(path)) return;
	saveConfig(cloneConfig(DEFAULT_CONFIG));
}

/**
 * Simple provider matching: `*` = any, a trailing `*` = prefix match, otherwise
 * an exact provider id. Deliberately not a full glob engine.
 */
export function matchesProviderEntry(entry: string, provider: string): boolean {
	if (entry === "*") return true;
	if (entry.endsWith("*")) return provider.startsWith(entry.slice(0, -1));
	return entry === provider;
}

export function isProviderAllowed(provider: string, filter: ProviderFilter): boolean {
	if (filter.deny.some((entry) => matchesProviderEntry(entry, provider))) return false;
	if (filter.allow.length === 0) return true;
	return filter.allow.some((entry) => matchesProviderEntry(entry, provider));
}

/** Ordered, case-insensitively de-duplicated header names for the given presets. */
export function resolveSessionHeaderNames(presets: SessionHeaderPreset[], extraNames: string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const push = (name: string) => {
		const trimmed = name.trim();
		if (!trimmed) return;
		const lower = trimmed.toLowerCase();
		if (seen.has(lower)) return;
		seen.add(lower);
		out.push(trimmed);
	};
	for (const preset of presets) {
		for (const name of SESSION_HEADER_PRESETS[preset] ?? []) push(name);
	}
	for (const name of extraNames) push(name);
	return out;
}

/** Pure: mark `provider` as rejecting the `prompt_cache_key` body field. */
export function withPromptCacheKeyDisabled(
	config: PromptCacheKeyConfig,
	provider: string,
): PromptCacheKeyConfig {
	const key = provider.trim();
	if (!key || config.disabled.promptCacheKeyProviders.includes(key)) return config;
	return {
		...config,
		disabled: {
			...config.disabled,
			promptCacheKeyProviders: [...config.disabled.promptCacheKeyProviders, key],
		},
	};
}

/** Pure: mark `names` (any case) as rejected by `provider`. */
export function withHeadersDisabled(
	config: PromptCacheKeyConfig,
	provider: string,
	names: string[],
): PromptCacheKeyConfig {
	const key = provider.trim();
	if (!key) return config;
	const lower = [
		...new Set(
			names.map((name) => name.trim().toLowerCase()).filter(Boolean),
		),
	];
	if (lower.length === 0) return config;
	const existing = config.disabled.headerProviders[key] ?? [];
	const added = lower.filter((name) => !existing.includes(name));
	if (added.length === 0) return config;
	return {
		...config,
		disabled: {
			...config.disabled,
			headerProviders: { ...config.disabled.headerProviders, [key]: [...existing, ...added] },
		},
	};
}

/** Lowercased header names already rejected by `provider`. */
export function rejectedHeadersFor(
	config: PromptCacheKeyConfig,
	provider: string,
): Set<string> {
	return new Set(config.disabled.headerProviders[provider] ?? []);
}

export function formatConfigSummary(config: PromptCacheKeyConfig): string {
	const headerNames = resolveSessionHeaderNames(config.headers.presets, config.headers.names);
	const headerState = config.headers.enabled
		? headerNames.length > 0
			? `on — ${headerNames.join(", ")}`
			: "on — no header names configured"
		: "off";
	const keyState = config.promptCacheKey.enabled ? "on" : "off";
	const disabledKeys = config.disabled.promptCacheKeyProviders;
	const disabledHeaders = Object.entries(config.disabled.headerProviders).map(
		([provider, names]) => `${provider}: ${names.join(", ")}`,
	);
	return [
		`headers: ${headerState}`,
		`prompt_cache_key: ${keyState}`,
		`autoDisableOnRejection: ${config.autoDisableOnRejection}`,
		`config: ${configPath()}`,
		...(disabledKeys.length > 0 ? [`disabled prompt_cache_key: ${disabledKeys.join(", ")}`] : []),
		...(disabledHeaders.length > 0 ? [`disabled headers: ${disabledHeaders.join("; ")}`] : []),
	].join("\n");
}
