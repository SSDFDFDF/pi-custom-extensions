/**
 * Small filesystem helpers: atomic write + exclusive lock file.
 * No native deps (works on Linux/WSL/macOS).
 *
 * Lock waits yield via short child sleep (not a CPU busy-spin) so the process
 * does not peg a core. Call sites should stay off the per-request hot path.
 */

import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
	constants,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";

export function atomicWriteFile(path: string, content: string, mode = 0o600): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, content, { mode });
	renameSync(tmp, path);
}

/** Default: fail fast enough not to feel like a hang if another process holds the lock. */
const DEFAULT_LOCK_STALE_MS = 5_000;
const DEFAULT_LOCK_TIMEOUT_MS = 500;

/** Sleep without burning CPU (blocks the event loop briefly — keep timeouts small). */
function sleepMs(ms: number): void {
	const sec = Math.max(0.01, ms / 1000);
	try {
		if (process.platform === "win32") {
			// Best-effort; duration is approximate.
			execFileSync("timeout", ["/T", "0", "/NOBREAK"], { stdio: "ignore" });
		} else {
			execFileSync("sleep", [String(sec)], { stdio: "ignore" });
		}
	} catch {
		// Fallback tiny spin only if sleep binary missing.
		const end = Date.now() + Math.min(ms, 20);
		while (Date.now() < end) {
			/* spin */
		}
	}
}

/**
 * Try once to create lockfile. Returns release fn or null if held.
 */
export function tryAcquireFileLock(lockPath: string): (() => void) | null {
	mkdirSync(dirname(lockPath), { recursive: true });
	try {
		const fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
		try {
			writeFileSync(fd, `${process.pid}\n${Date.now()}\n`);
		} catch {
			// still hold the lock
		}
		return () => {
			try {
				closeSync(fd);
			} catch {
				// ignore
			}
			try {
				unlinkSync(lockPath);
			} catch {
				// ignore
			}
		};
	} catch {
		return null;
	}
}

/**
 * Acquire exclusive lock via O_EXCL lockfile. Returns a release function.
 * Stale locks older than staleMs are broken (best-effort).
 * On timeout throws when strict=true; otherwise returns a no-op release
 * (unlocked best-effort). Callers should keep critical sections tiny.
 */
export function acquireFileLock(
	lockPath: string,
	options?: { timeoutMs?: number; staleMs?: number; strict?: boolean },
): () => void {
	const timeoutMs = options?.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
	const staleMs = options?.staleMs ?? DEFAULT_LOCK_STALE_MS;
	const start = Date.now();

	while (true) {
		const release = tryAcquireFileLock(lockPath);
		if (release) return release;

		// Stale lock recovery
		try {
			if (existsSync(lockPath)) {
				const st = statSync(lockPath);
				if (Date.now() - st.mtimeMs > staleMs) {
					try {
						unlinkSync(lockPath);
						continue;
					} catch {
						// race with another breaker
					}
				}
			}
		} catch {
			// ignore
		}

		if (Date.now() - start >= timeoutMs) {
			if (options?.strict) throw new Error(`Identity store is busy: ${lockPath}. Try again.`);
			console.warn(`[client-mimic] lock timeout on ${lockPath}; continuing unlocked`);
			return () => {};
		}
		sleepMs(20);
	}
}

/** Run fn under exclusive lock for path (uses path + ".lock"). */
export function withFileLock<T>(path: string, fn: () => T, options?: { timeoutMs?: number; strict?: boolean }): T {
	const release = acquireFileLock(`${path}.lock`, options);
	try {
		return fn();
	} finally {
		release();
	}
}

/**
 * Prefer lock; if not acquired quickly, still run fn (best-effort).
 * Use for non-critical identity writes so UI never stalls long.
 */
export function withFileLockBestEffort<T>(path: string, fn: () => T, timeoutMs = 150): T {
	return withFileLock(path, fn, { timeoutMs });
}

export function readJsonFile<T>(path: string): T | undefined {
	try {
		if (!existsSync(path)) return undefined;
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}
