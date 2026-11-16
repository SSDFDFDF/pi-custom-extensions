/**
 * session-prune configuration.
 *
 * File: `~/.pi/agent/session-prune.config.json` (override the agent dir with
 * `PI_CODING_AGENT_DIR`). Missing file / missing fields / parse errors fall back
 * to {@link DEFAULT_CONFIG}, so the extension always has a usable config.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";

const CONFIG_FILE_NAME = "session-prune.config.json";

export interface SessionPruneConfig {
	/** Append a short custom message that tells the model the context was trimmed. */
	marker: boolean;
	/** Characters of each message shown in the listing. */
	previewChars: number;
	/** Rows shown by `list` when `all` is not set. */
	maxListed: number;
	/** Never hide the newest user message when `keep` (whitelist) is used. */
	protectLastUser: boolean;
}

export const DEFAULT_CONFIG: SessionPruneConfig = {
	marker: true,
	previewChars: 90,
	maxListed: 60,
	protectLastUser: true,
};

export function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? ".", ".pi", "agent");
}

export function configPath(): string {
	return join(agentDir(), CONFIG_FILE_NAME);
}

export function cloneConfig(config: SessionPruneConfig = DEFAULT_CONFIG): SessionPruneConfig {
	return { ...config };
}

function asBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function asCount(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function normalizeConfig(raw: unknown): SessionPruneConfig {
	const value = (raw ?? {}) as Record<string, unknown>;
	return {
		marker: asBoolean(value.marker, DEFAULT_CONFIG.marker),
		previewChars: asCount(value.previewChars, DEFAULT_CONFIG.previewChars, 20, 400),
		maxListed: asCount(value.maxListed, DEFAULT_CONFIG.maxListed, 5, 500),
		protectLastUser: asBoolean(value.protectLastUser, DEFAULT_CONFIG.protectLastUser),
	};
}

export function loadConfig(): SessionPruneConfig {
	const path = configPath();
	if (!existsSync(path)) return cloneConfig();
	try {
		return normalizeConfig(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return cloneConfig();
	}
}

export function saveConfig(config: SessionPruneConfig): SessionPruneConfig {
	const normalized = normalizeConfig(config);
	const path = configPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(normalized, null, 2)}\n`);
	return normalized;
}

/** Create the config file with defaults when it is missing. */
export function ensureConfigFile(): SessionPruneConfig {
	const path = configPath();
	if (existsSync(path)) return loadConfig();
	return saveConfig(cloneConfig());
}

export function formatConfigSummary(config: SessionPruneConfig): string {
	return `marker=${config.marker ? "on" : "off"} previewChars=${config.previewChars} maxListed=${config.maxListed} protectLastUser=${config.protectLastUser ? "on" : "off"}`;
}
