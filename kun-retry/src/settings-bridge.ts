import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentDir, type KunRetryConfig, effectiveMaxRetries } from "./config.ts";

type SettingsShape = {
	retry?: {
		enabled?: boolean;
		maxRetries?: number;
		baseDelayMs?: number;
		provider?: Record<string, unknown>;
		[key: string]: unknown;
	};
	[key: string]: unknown;
};

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

	if (!cfg.syncSettings) {
		return {
			changed: false,
			path,
			maxRetries: settings.retry?.maxRetries ?? 3,
			baseDelayMs: settings.retry?.baseDelayMs ?? 2000,
			enabled: settings.retry?.enabled ?? true,
		};
	}

	const prev = settings.retry ?? {};
	const nextRetry = {
		...prev,
		enabled,
		maxRetries,
		baseDelayMs,
	};

	const changed =
		prev.enabled !== nextRetry.enabled ||
		prev.maxRetries !== nextRetry.maxRetries ||
		prev.baseDelayMs !== nextRetry.baseDelayMs;

	if (changed) {
		settings.retry = nextRetry;
		writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
	}

	return {
		changed,
		path,
		maxRetries: nextRetry.maxRetries,
		baseDelayMs: nextRetry.baseDelayMs,
		enabled: nextRetry.enabled !== false,
	};
}
