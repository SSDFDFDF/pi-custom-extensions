import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export interface KunRetryConfig {
	/** Master switch for this extension's matching + settings sync. */
	enabled: boolean;
	/**
	 * Overrides Pi built-in `retry.maxRetries` (written into settings.json).
	 * Ignored while `nl` is true (unlimited).
	 */
	maxRetries: number;
	/** Overrides Pi built-in `retry.baseDelayMs` (written into settings.json). */
	baseDelayMs: number;
	/**
	 * Extra HTTP status codes treated as retryable when they appear in errorMessage
	 * (e.g. 401, 403). Empty array disables status-code matching.
	 */
	statusCodes: number[];
	/**
	 * Extra regex patterns (strings) matched against errorMessage (case-insensitive).
	 * Always combined with built-in pi-retry legacy patterns.
	 */
	errorPatterns: string[];
	/**
	 * Stall watchdog timeout in ms. 0 disables.
	 * Flag `--retry-stall-timeout-ms` / env `PI_RETRY_STALL_TIMEOUT_MS` override this.
	 */
	stallTimeoutMs: number;
	/**
	 * No-limit mode: retry every assistant error with effectively unlimited attempts.
	 * Toggle via `/retry-nl`.
	 */
	nl: boolean;
	/** When true, write maxRetries/baseDelayMs/enabled into ~/.pi/agent/settings.json. */
	syncSettings: boolean;
}

export const DEFAULT_CONFIG: KunRetryConfig = {
	enabled: true,
	maxRetries: 10,
	baseDelayMs: 2000,
	statusCodes: [401, 403, 408, 425, 429, 500, 502, 503, 504, 529],
	errorPatterns: [],
	stallTimeoutMs: 90_000,
	nl: false,
	syncSettings: true,
};

/** Effective max retries written into settings when nl is on. */
export const NL_MAX_RETRIES = 1_000_000;

const CONFIG_FILE_NAME = "kun-retry.config.json";

export function packageRootFromUrl(importMetaUrl: string): string {
	return dirname(dirname(fileURLToPath(importMetaUrl)));
}

export function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? ".", ".pi", "agent");
}

export function defaultConfigPath(): string {
	return join(agentDir(), CONFIG_FILE_NAME);
}

export function loadConfig(): KunRetryConfig {
	const path = defaultConfigPath();
	if (!existsSync(path)) return { ...DEFAULT_CONFIG, errorPatterns: [...DEFAULT_CONFIG.errorPatterns], statusCodes: [...DEFAULT_CONFIG.statusCodes] };
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<KunRetryConfig>;
		return normalizeConfig(raw);
	} catch {
		return { ...DEFAULT_CONFIG, errorPatterns: [...DEFAULT_CONFIG.errorPatterns], statusCodes: [...DEFAULT_CONFIG.statusCodes] };
	}
}

export function saveConfig(patch: Partial<KunRetryConfig>): KunRetryConfig {
	const next = normalizeConfig({ ...loadConfig(), ...patch });
	const path = defaultConfigPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
	return next;
}

export function normalizeConfig(raw: Partial<KunRetryConfig> | undefined): KunRetryConfig {
	const base = { ...DEFAULT_CONFIG, ...(raw ?? {}) };
	const maxRetries = Number(base.maxRetries);
	const baseDelayMs = Number(base.baseDelayMs);
	const stallTimeoutMs = Number(base.stallTimeoutMs);

	const statusCodes = Array.isArray(base.statusCodes)
		? base.statusCodes
				.map((c) => Number(c))
				.filter((c) => Number.isInteger(c) && c >= 100 && c <= 599)
		: [...DEFAULT_CONFIG.statusCodes];

	const errorPatterns = Array.isArray(base.errorPatterns)
		? base.errorPatterns
				.filter((p): p is string => typeof p === "string")
				.map((p) => p.trim())
				.filter(Boolean)
		: [];

	return {
		enabled: base.enabled !== false,
		maxRetries:
			Number.isFinite(maxRetries) && maxRetries >= 0
				? Math.min(Math.floor(maxRetries), NL_MAX_RETRIES)
				: DEFAULT_CONFIG.maxRetries,
		baseDelayMs:
			Number.isFinite(baseDelayMs) && baseDelayMs >= 0
				? Math.min(Math.floor(baseDelayMs), 600_000)
				: DEFAULT_CONFIG.baseDelayMs,
		statusCodes: [...new Set(statusCodes)].sort((a, b) => a - b),
		errorPatterns,
		stallTimeoutMs:
			Number.isFinite(stallTimeoutMs) && stallTimeoutMs >= 0
				? Math.min(Math.floor(stallTimeoutMs), 3_600_000)
				: DEFAULT_CONFIG.stallTimeoutMs,
		nl: base.nl === true,
		syncSettings: base.syncSettings !== false,
	};
}

/**
 * Retry budget written into Pi's built-in settings.json.
 *
 * Deliberately independent of `cfg.enabled`: disabling this extension only
 * stops our extra matching + stall watchdog, it must NOT clobber Pi's normal
 * auto-retry budget down to 0. `nl` raises the budget to effectively unlimited.
 */
export function effectiveMaxRetries(cfg: KunRetryConfig): number {
	if (cfg.nl) return NL_MAX_RETRIES;
	return cfg.maxRetries;
}

export function formatConfigSummary(cfg: KunRetryConfig): string {
	const max = effectiveMaxRetries(cfg);
	const maxLabel = cfg.nl ? `unlimited (${NL_MAX_RETRIES})` : String(max);
	return [
		`enabled: ${cfg.enabled}`,
		`nl: ${cfg.nl}`,
		`maxRetries: ${maxLabel} (config ${cfg.maxRetries})`,
		`baseDelayMs: ${cfg.baseDelayMs}`,
		`statusCodes: [${cfg.statusCodes.join(", ")}]`,
		`errorPatterns: ${cfg.errorPatterns.length ? cfg.errorPatterns.map((p) => JSON.stringify(p)).join(", ") : "(none extra)"}`,
		`stallTimeoutMs: ${cfg.stallTimeoutMs === 0 ? "off" : cfg.stallTimeoutMs}`,
		`syncSettings: ${cfg.syncSettings}`,
		`config: ${defaultConfigPath()}`,
	].join("\n");
}
