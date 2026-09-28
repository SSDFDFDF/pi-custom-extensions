import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentDir, type KunRetryConfig, effectiveMaxRetries } from "./config.ts";

type SettingsShape = {
	retry?: {
		enabled?: boolean;
		maxRetries?: number;
		baseDelayMs?: number;
		maxAgentDelayMs?: number;
		provider?: Record<string, unknown>;
		[key: string]: unknown;
	};
	[key: string]: unknown;
};

/** Pi's default cap for agent-level retry delay (see docs/settings.md). */
export const DEFAULT_MAX_AGENT_DELAY_MS = 60_000;

/**
 * Retry delay cap to write into settings.json.
 *
 * Pi 0.86.0 computes `min(baseDelayMs * 2 ** (attempt - 1), retry.maxAgentDelayMs ?? 60000)`,
 * so a constant interval above the cap is silently truncated. When constant mode is
 * on we therefore raise the cap to fit the configured interval, keeping any larger
 * value the user already set. With constant mode off the value is left untouched.
 */
export function effectiveMaxAgentDelayMs(cfg: KunRetryConfig, existing: number | undefined): number | undefined {
	if (cfg.constantDelayMs <= 0) return existing;
	const current = typeof existing === "number" && Number.isFinite(existing) ? existing : DEFAULT_MAX_AGENT_DELAY_MS;
	return Math.max(current, cfg.constantDelayMs);
}

export function settingsPath(): string {
	return join(agentDir(), "settings.json");
}

export function readSettingsFile(): SettingsShape {
	const path = settingsPath();
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf8")) as SettingsShape;
	} catch {
		return {};
	}
}

/**
 * Sync extension retry policy into Pi's built-in settings.json so
 * agent-session `_prepareRetry` uses our maxRetries / baseDelayMs.
 *
 * In-memory settings update only after process restart or `/reload`.
 * Returns whether the file changed.
 */
export function syncBuiltinRetrySettings(cfg: KunRetryConfig): {
	changed: boolean;
	path: string;
	maxRetries: number;
	baseDelayMs: number;
	maxAgentDelayMs: number;
	enabled: boolean;
} {
	const path = settingsPath();
	const settings = readSettingsFile();
	const maxRetries = effectiveMaxRetries(cfg);
	const baseDelayMs = cfg.baseDelayMs;
	// Pi's built-in auto-retry stays ON regardless of cfg.enabled. cfg.enabled only
	// gates our own matching + stall watchdog; disabling it must not silently turn
	// off Pi's normal transient-error retry or reset the user's retry budget to 0.
	const enabled = true;
	const maxAgentDelayMs = effectiveMaxAgentDelayMs(cfg, settings.retry?.maxAgentDelayMs);

	if (!cfg.syncSettings) {
		return {
			changed: false,
			path,
			maxRetries: settings.retry?.maxRetries ?? 3,
			baseDelayMs: settings.retry?.baseDelayMs ?? 2000,
			maxAgentDelayMs: settings.retry?.maxAgentDelayMs ?? DEFAULT_MAX_AGENT_DELAY_MS,
			enabled: settings.retry?.enabled ?? true,
		};
	}

	const prev = settings.retry ?? {};
	const nextRetry = {
		...prev,
		enabled,
		maxRetries,
		baseDelayMs,
		// Only write the cap when constant mode needs it; otherwise leave the user's
		// value (or Pi's default) alone.
		...maxAgentDelayMs === undefined ? {} : { maxAgentDelayMs },
	};

	const changed =
		prev.enabled !== nextRetry.enabled ||
		prev.maxRetries !== nextRetry.maxRetries ||
		prev.baseDelayMs !== nextRetry.baseDelayMs ||
		(maxAgentDelayMs !== undefined && prev.maxAgentDelayMs !== maxAgentDelayMs);

	if (changed) {
		settings.retry = nextRetry;
		writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
	}

	return {
		changed,
		path,
		maxRetries: nextRetry.maxRetries,
		baseDelayMs: nextRetry.baseDelayMs,
		maxAgentDelayMs: nextRetry.maxAgentDelayMs ?? DEFAULT_MAX_AGENT_DELAY_MS,
		enabled: nextRetry.enabled !== false,
	};
}
