/**
 * Config for session-error-clean, stored at ~/.pi/agent/session-error-clean.config.json.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";

export interface SessionErrorCleanConfig {
	/**
	 * Rewrite the current session file automatically on session_start when it
	 * contains error entries. File-only: the freshly loaded in-memory context
	 * still replays the errors for the current run — run /clean-errors to also
	 * refresh the live context (it reloads the session from the clean file).
	 */
	autoClean: boolean;
	/**
	 * Default regex filter on errorMessage, applied to every clean. Empty string
	 * removes every error entry. Per-invocation override: /clean-errors pattern <re>.
	 */
	pattern: string;
	/** Write <file>.bak before rewriting a session file. */
	backup: boolean;
}

export const DEFAULT_CONFIG: SessionErrorCleanConfig = {
	autoClean: false,
	pattern: "",
	backup: true,
};

const CONFIG_FILE_NAME = "session-error-clean.config.json";

export function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? ".", ".pi", "agent");
}

export function sessionsRoot(): string {
	return join(agentDir(), "sessions");
}

export function defaultConfigPath(): string {
	return join(agentDir(), CONFIG_FILE_NAME);
}

export function normalizeConfig(raw: Partial<SessionErrorCleanConfig> | undefined): SessionErrorCleanConfig {
	const base = { ...DEFAULT_CONFIG, ...(raw ?? {}) };
	const pattern = typeof base.pattern === "string" ? base.pattern.trim() : "";
	if (pattern) {
		// Reject patterns that would crash every clean with an invalid regex.
		new RegExp(pattern, "i");
	}
	return {
		autoClean: base.autoClean === true,
		pattern,
		backup: base.backup !== false,
	};
}

export function loadConfig(): SessionErrorCleanConfig {
	const path = defaultConfigPath();
	if (!existsSync(path)) return { ...DEFAULT_CONFIG };
	try {
		return normalizeConfig(JSON.parse(readFileSync(path, "utf8")) as Partial<SessionErrorCleanConfig>);
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

export function saveConfig(patch: Partial<SessionErrorCleanConfig>): SessionErrorCleanConfig {
	const next = normalizeConfig({ ...loadConfig(), ...patch });
	const path = defaultConfigPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
	return next;
}

export function formatConfigSummary(cfg: SessionErrorCleanConfig): string {
	return [
		`autoClean: ${cfg.autoClean ? "on" : "off"}`,
		`pattern:   ${cfg.pattern || "(all error entries)"}`,
		`backup:    ${cfg.backup ? "on" : "off"}`,
		`config:    ${defaultConfigPath()}`,
	].join("\n");
}

/** Compile the configured/per-invocation pattern into a RegExp; undefined when empty. */
export function compilePattern(pattern: string | undefined): RegExp | undefined {
	const trimmed = (pattern ?? "").trim();
	if (!trimmed) return undefined;
	return new RegExp(trimmed, "i");
}
