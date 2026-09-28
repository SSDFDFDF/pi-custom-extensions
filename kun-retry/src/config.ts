import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";

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
	 * Constant retry interval in ms. `0` disables constant mode, which restores Pi's
	 * built-in exponential backoff (`baseDelayMs * 2 ** (attempt - 1)`) untouched.
	 *
	 * When positive, every auto-retry waits exactly this long, no matter how many
	 * attempts have already failed. Implemented by patching the delay Pi computes,
	 * not by reimplementing retry: budget accounting, error-message removal, event
	 * emission and Escape-cancellation all still run in Pi's `_prepareRetry`.
	 */
	constantDelayMs: number;
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
	/**
	 * Treat a completed-but-empty assistant response (no text / thinking / tool
	 * calls, non-error stopReason) as retryable. The provider returned HTTP 200
	 * with nothing usable, which Pi's built-in classifier never sees because the
	 * stopReason is not "error". When true, kun-retry rewrites it into a retryable
	 * error so the built-in retry path engages.
	 */
	retryEmptyResponse: boolean;
	/** When true, write maxRetries/baseDelayMs/enabled into ~/.pi/agent/settings.json. */
	syncSettings: boolean;
	/**
	 * Consecutive retryable errors before switching to the next candidate model.
	 * `0` disables switching. Persisted because it is a behavioral parameter,
	 * unlike the candidate list which is session-scoped.
	 */
	switchAfterErrors: number;
	/**
	 * Fold the session's active model into the rotation pool (at the front) so
	 * the cycle alternates between already-used and candidate models.
	 * Persisted because it is a behavioral parameter.
	 */
	includeActiveInRotation: boolean;
	/**
	 * Thinking level applied after a rotation model switch. Pi's own switch logic
	 * prefers settings.defaultThinkingLevel over the current session level, which
	 * can silently downgrade a manually raised level. kun-retry sets this
	 * explicitly after `setModel` to override that.
	 *
	 * - a concrete level: apply it (clamped to what the target model supports)
	 * - "inherit": restore the level the session had before the switch
	 *
	 * Defaults to "max" (the strongest level); Pi clamps it down for models that
	 * support less.
	 */
	rotationThinkingLevel: RotationThinkingLevel;
}

/** Concrete thinking levels plus "inherit" (keep the pre-switch session level). */
export type RotationThinkingLevel =
	| "inherit"
	| "off"
	| "minimal"
	| "low"
	| "medium"
	| "high"
	| "xhigh"
	| "max";

export const ROTATION_THINKING_LEVELS: readonly RotationThinkingLevel[] = [
	"inherit",
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

export const DEFAULT_CONFIG: KunRetryConfig = {
	enabled: true,
	maxRetries: 10,
	baseDelayMs: 2000,
	constantDelayMs: 0,
	// 520–524: Cloudflare edge/origin transient failures (524 also in Pi builtin).
	statusCodes: [401, 403, 408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529],
	errorPatterns: [],
	stallTimeoutMs: 90_000,
	nl: false,
	retryEmptyResponse: true,
	syncSettings: true,
	switchAfterErrors: 3,
	includeActiveInRotation: true,
	rotationThinkingLevel: "max",
};

/** Effective max retries written into settings when nl is on. */
export const NL_MAX_RETRIES = 1_000_000;

const CONFIG_FILE_NAME = "kun-retry.config.json";

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
	const constantDelayMs = Number(base.constantDelayMs);
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

	const switchAfterErrors = Number(base.switchAfterErrors);

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
		constantDelayMs:
			Number.isFinite(constantDelayMs) && constantDelayMs >= 0
				? Math.min(Math.floor(constantDelayMs), 3_600_000)
				: DEFAULT_CONFIG.constantDelayMs,
		statusCodes: [...new Set(statusCodes)].sort((a, b) => a - b),
		errorPatterns,
		stallTimeoutMs:
			Number.isFinite(stallTimeoutMs) && stallTimeoutMs >= 0
				? Math.min(Math.floor(stallTimeoutMs), 3_600_000)
				: DEFAULT_CONFIG.stallTimeoutMs,
		nl: base.nl === true,
		retryEmptyResponse: base.retryEmptyResponse !== false,
		syncSettings: base.syncSettings !== false,
		switchAfterErrors:
			Number.isFinite(switchAfterErrors) && switchAfterErrors >= 0
				? Math.min(Math.floor(switchAfterErrors), 1000)
				: DEFAULT_CONFIG.switchAfterErrors,
		includeActiveInRotation: base.includeActiveInRotation !== false,
		rotationThinkingLevel: ROTATION_THINKING_LEVELS.includes(
			base.rotationThinkingLevel as RotationThinkingLevel,
		)
			? (base.rotationThinkingLevel as RotationThinkingLevel)
			: DEFAULT_CONFIG.rotationThinkingLevel,
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
		`delay: ${
			cfg.constantDelayMs > 0
				? `constant ${cfg.constantDelayMs}ms`
				: `exponential (baseDelayMs ${cfg.baseDelayMs} × 2^(attempt-1), Pi built-in)`
		}`,
		`baseDelayMs: ${cfg.baseDelayMs}`,
		`constantDelayMs: ${cfg.constantDelayMs === 0 ? "off (use built-in exponential)" : cfg.constantDelayMs}`,
		`statusCodes: [${cfg.statusCodes.join(", ")}]`,
		`errorPatterns: ${cfg.errorPatterns.length ? cfg.errorPatterns.map((p) => JSON.stringify(p)).join(", ") : "(none extra)"}`,
		`stallTimeoutMs: ${cfg.stallTimeoutMs === 0 ? "off" : cfg.stallTimeoutMs}`,
		`retryEmptyResponse: ${cfg.retryEmptyResponse}`,
		`syncSettings: ${cfg.syncSettings}`,
		`switchAfterErrors: ${cfg.switchAfterErrors}${cfg.switchAfterErrors === 0 ? " (0 = switching disabled)" : ""}`,
		`includeActiveInRotation: ${cfg.includeActiveInRotation}`,
		`rotationThinkingLevel: ${cfg.rotationThinkingLevel}`,
		`config: ${defaultConfigPath()}`,
	].join("\n");
}
