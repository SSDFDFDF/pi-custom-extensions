/**
 * Claude Code identity helpers (session v4, stable device_id).
 * Cross-checked against local Claude Code 2.1.198 telemetry + restored source maps.
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { atomicWriteFile, withFileLockBestEffort } from "./fs-util.ts";
import { isUuidV4 } from "./ids.ts";

/** RFC 4122 UUIDv4 (Claude Code session_id shape). */
export function uuidV4(): string {
	return randomUUID();
}

export { isUuidV4 } from "./ids.ts";

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? ".", ".pi", "agent");
}

export function claudeSessionMapPath(dir = agentDir()): string {
	return join(dir, "client-mimic.claude-sessions.json");
}

export function deviceIdPath(dir = agentDir()): string {
	return join(dir, "client-mimic.device_id");
}

function loadClaudeSessionMap(path: string): Record<string, string> {
	try {
		if (existsSync(path)) {
			const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
			if (raw && typeof raw === "object") return { ...raw };
		}
	} catch {
		// corrupt → empty
	}
	return {};
}

function saveClaudeSessionMap(map: Record<string, string>, path: string): void {
	const entries = Object.entries(map);
	const trimmed =
		entries.length > 200 ? Object.fromEntries(entries.slice(entries.length - 200)) : map;
	atomicWriteFile(path, `${JSON.stringify(trimmed, null, 2)}\n`);
}

/**
 * Claude Code session id for the current pi session.
 * - If pi session id is already UUIDv4, use it (matches real CLI).
 * - Else reuse a persisted mapping for that pi id, or mint a new v4 and store it.
 */
export function resolveClaudeSessionId(piSessionId: string | undefined): string {
	if (piSessionId && isUuidV4(piSessionId)) return piSessionId;
	const key = piSessionId && piSessionId.length > 0 ? piSessionId : "_anonymous";
	const path = claudeSessionMapPath();
	// Fast path: unlocked read when mapping already exists (common on resume).
	const unlocked = loadClaudeSessionMap(path);
	const hit = unlocked[key];
	if (hit && isUuidV4(hit)) return hit;
	// Slow path: mint + persist under short lock (session_start only, not per request).
	return withFileLockBestEffort(path, () => {
		const map = loadClaudeSessionMap(path);
		const existing = map[key];
		if (existing && isUuidV4(existing)) return existing;
		const id = uuidV4();
		map[key] = id;
		try {
			saveClaudeSessionMap(map, path);
		} catch (err) {
			console.warn(
				`[client-mimic] claude session map write failed:`,
				err instanceof Error ? err.message : err,
			);
		}
		return id;
	});
}

/** 64-char hex device id (sha256), matching Claude Code telemetry shape. */
export function hashDeviceId(seed?: string): string {
	const s =
		seed ??
		`${hostname()}|${process.env.USER ?? process.env.USERNAME ?? ""}|${process.platform}|${process.arch}`;
	return createHash("sha256").update(s).digest("hex");
}

/**
 * Prefer persisted device id; create once and reuse across restarts.
 * Shape: 64 lowercase hex (same as real Claude Code device_id).
 */
export function loadOrCreateDeviceId(path = deviceIdPath()): string {
	// Fast path: unlocked read (common after first create).
	try {
		if (existsSync(path)) {
			const raw = readFileSync(path, "utf8").trim().toLowerCase();
			if (/^[0-9a-f]{64}$/.test(raw)) return raw;
		}
	} catch {
		// fall through
	}
	return withFileLockBestEffort(path, () => {
		try {
			if (existsSync(path)) {
				const raw = readFileSync(path, "utf8").trim().toLowerCase();
				if (/^[0-9a-f]{64}$/.test(raw)) return raw;
			}
		} catch {
			// fall through
		}
		const id = hashDeviceId();
		try {
			atomicWriteFile(path, `${id}\n`);
		} catch (err) {
			console.warn(
				`[client-mimic] device_id persist failed:`,
				err instanceof Error ? err.message : err,
			);
		}
		return id;
	});
}

/**
 * Core anthropic-beta flags observed on Claude Code 2.1.198 (local telemetry).
 * Merged at request time with any betas pi already set.
 */
export const CLAUDE_CODE_CORE_BETAS = [
	"claude-code-20250219",
	"interleaved-thinking-2025-05-14",
	"redact-thinking-2026-02-12",
	"thinking-token-count-2026-05-13",
	"context-management-2025-06-27",
	"prompt-caching-scope-2026-01-05",
	"mid-conversation-system-2026-04-07",
	"effort-2025-11-24",
].join(",");
