/**
 * Codex-shaped identity for client-mimic.
 *
 * Mirrors codex-rs AgentControl + AutoCompactWindowIds:
 * - root: session_id == thread_id
 * - child (fork/parentSession): share session_id, new thread_id + parent_thread_id
 * - window chain advances on compact; resume restores the chain
 * - installation_id is machine-stable
 * - turn_id is per outbound request
 */

import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, withFileLockBestEffort } from "./fs-util.ts";
import { isUuid, isUuidV7 } from "./ids.ts";

export interface CodexWindowChain {
	firstWindowId: string;
	previousWindowId?: string;
	windowId: string;
	windowNumber: number;
}

export interface CodexIdentityState extends CodexWindowChain {
	/** Key in the on-disk store (usually pi session id). */
	piSessionKey: string;
	sessionId: string;
	threadId: string;
	parentThreadId?: string;
	turnId: string;
	installationId: string;
}

export interface CodexIdentityRecord extends CodexWindowChain {
	sessionId: string;
	threadId: string;
	parentThreadId?: string;
	updatedAt: string;
}

export interface CodexIdentityStore {
	byPiSession: Record<string, CodexIdentityRecord>;
}

export interface SessionStartLike {
	reason: string;
	previousSessionFile?: string;
}

export interface SessionHeaderLike {
	parentSession?: string;
}

export interface SessionManagerLike {
	getSessionId?: () => string;
	getHeader?: () => SessionHeaderLike | null | undefined;
}

export interface CodexBodyIds {
	sessionId: string;
	threadId: string;
	windowId: string;
	installationId: string;
	parentThreadId?: string;
	firstWindowId?: string;
	previousWindowId?: string;
	windowNumber?: number;
	turnId?: string;
}

const MAX_STORE_ENTRIES = 200;

/** RFC 9562 UUIDv7 (time-ordered). Codex SessionId/ThreadId/window_id use this. */
export function uuidV7(): string {
	const bytes = randomBytes(16);
	const now = BigInt(Date.now());
	bytes[0] = Number((now >> 40n) & 0xffn);
	bytes[1] = Number((now >> 32n) & 0xffn);
	bytes[2] = Number((now >> 24n) & 0xffn);
	bytes[3] = Number((now >> 16n) & 0xffn);
	bytes[4] = Number((now >> 8n) & 0xffn);
	bytes[5] = Number(now & 0xffn);
	bytes[6] = (bytes[6] & 0x0f) | 0x70;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export { isUuid, isUuidV7 } from "./ids.ts";

export function newWindowChain(): CodexWindowChain {
	const firstWindowId = uuidV7();
	return {
		firstWindowId,
		previousWindowId: undefined,
		windowId: firstWindowId,
		windowNumber: 0,
	};
}

/** Advance context window after compact (session/thread unchanged). */
export function advanceWindowChain(chain: CodexWindowChain): CodexWindowChain {
	return {
		firstWindowId: chain.firstWindowId,
		previousWindowId: chain.windowId,
		windowId: uuidV7(),
		windowNumber: chain.windowNumber + 1,
	};
}

export function normalizeWindowFields(known: Partial<CodexWindowChain>): CodexWindowChain {
	const windowId = known.windowId && isUuidV7(known.windowId) ? known.windowId : uuidV7();
	const firstWindowId =
		known.firstWindowId && isUuidV7(known.firstWindowId) ? known.firstWindowId : windowId;
	const previousWindowId =
		known.previousWindowId && isUuidV7(known.previousWindowId)
			? known.previousWindowId
			: undefined;
	const windowNumber =
		typeof known.windowNumber === "number" && Number.isFinite(known.windowNumber)
			? Math.max(0, Math.floor(known.windowNumber))
			: 0;
	return { firstWindowId, previousWindowId, windowId, windowNumber };
}

export function extractSessionIdFromPath(path: string | undefined): string | undefined {
	if (!path) return undefined;
	const base = path.split(/[/\\]/).pop() ?? "";
	const m = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
	return m?.[1];
}

export function readParentSessionPath(sessionManager: SessionManagerLike): string | undefined {
	try {
		const header = sessionManager.getHeader?.();
		if (header?.parentSession) return header.parentSession;
	} catch {
		// ignore
	}
	return undefined;
}

export function createInitialIdentityState(installationId: string): CodexIdentityState {
	const sessionId = uuidV7();
	const win = newWindowChain();
	return {
		piSessionKey: sessionId,
		sessionId,
		threadId: sessionId,
		parentThreadId: undefined,
		...win,
		turnId: uuidV7(),
		installationId,
	};
}

/**
 * Resolve Codex session/thread/window for a pi session_start.
 * Pure w.r.t. store mutation: updates `store.byPiSession` and returns resolved state fields
 * (caller supplies installationId + mints turnId).
 */
export function resolveCodexIdentityOnSessionStart(
	event: SessionStartLike,
	sessionManager: SessionManagerLike,
	store: CodexIdentityStore,
): Omit<CodexIdentityState, "turnId" | "installationId"> {
	const piIdRaw = sessionManager.getSessionId?.() ?? "";
	const piId = piIdRaw && isUuidV7(piIdRaw) ? piIdRaw : piIdRaw || uuidV7();
	const piThread = isUuidV7(piId) ? piId : uuidV7();

	const known = store.byPiSession[piId];
	if ((event.reason === "resume" || event.reason === "reload") && known) {
		const win = normalizeWindowFields(known);
		const resolved = {
			piSessionKey: piId,
			sessionId: known.sessionId,
			threadId: known.threadId,
			parentThreadId: known.parentThreadId,
			...win,
		};
		store.byPiSession[piId] = { ...resolved, updatedAt: new Date().toISOString() };
		return resolved;
	}

	const parentPath =
		readParentSessionPath(sessionManager) ??
		(event.reason === "fork" || event.reason === "new" ? event.previousSessionFile : undefined);
	const parentPiId = extractSessionIdFromPath(parentPath);
	const parentRecord = parentPiId ? store.byPiSession[parentPiId] : undefined;

	const isChild =
		event.reason === "fork" ||
		(parentRecord != null && parentPiId !== piId) ||
		(parentPath != null && parentPiId != null && parentPiId !== piId);

	let sessionId: string;
	let threadId: string;
	let parentThreadId: string | undefined;

	if (isChild && parentRecord) {
		sessionId = parentRecord.sessionId;
		threadId = piThread;
		parentThreadId = parentRecord.threadId;
	} else if (isChild && parentPiId) {
		sessionId = isUuidV7(parentPiId) ? parentPiId : uuidV7();
		threadId = piThread;
		parentThreadId = isUuidV7(parentPiId) ? parentPiId : sessionId;
	} else if (known) {
		const win = normalizeWindowFields(known);
		const resolved = {
			piSessionKey: piId,
			sessionId: known.sessionId,
			threadId: known.threadId,
			parentThreadId: known.parentThreadId,
			...win,
		};
		store.byPiSession[piId] = { ...resolved, updatedAt: new Date().toISOString() };
		return resolved;
	} else {
		sessionId = piThread;
		threadId = piThread;
		parentThreadId = undefined;
	}

	const win = newWindowChain();
	const resolved = {
		piSessionKey: piId,
		sessionId,
		threadId,
		parentThreadId,
		...win,
	};
	store.byPiSession[piId] = { ...resolved, updatedAt: new Date().toISOString() };
	return resolved;
}

export function recordFromState(state: CodexIdentityState): CodexIdentityRecord {
	return {
		sessionId: state.sessionId,
		threadId: state.threadId,
		parentThreadId: state.parentThreadId,
		firstWindowId: state.firstWindowId,
		previousWindowId: state.previousWindowId,
		windowId: state.windowId,
		windowNumber: state.windowNumber,
		updatedAt: new Date().toISOString(),
	};
}

export function persistIdentityState(store: CodexIdentityStore, state: CodexIdentityState): void {
	if (!state.piSessionKey) return;
	store.byPiSession[state.piSessionKey] = recordFromState(state);
}

/**
 * Inject Codex Responses identity into request body.
 * session/thread/installation: set if missing.
 * window/turn chain: always refresh (they move over time).
 */
export function ensureCodexIdentity(
	payload: Record<string, unknown>,
	ids: CodexBodyIds,
	target: "metadata" | "client_metadata" = "metadata",
): boolean {
	let changed = false;
	if (
		payload.prompt_cache_key === undefined ||
		payload.prompt_cache_key === null ||
		payload.prompt_cache_key === ""
	) {
		payload.prompt_cache_key = ids.sessionId;
		changed = true;
	}

	const existingMeta =
		payload[target] && typeof payload[target] === "object" && !Array.isArray(payload[target])
			? ({ ...(payload[target] as Record<string, unknown>) } as Record<string, unknown>)
			: {};

	const setAlways = (key: string, value: string) => {
		if (existingMeta[key] !== value) {
			existingMeta[key] = value;
			changed = true;
		}
	};
	const setIfMissing = (key: string, value: string) => {
		if (existingMeta[key] === undefined || existingMeta[key] === null || existingMeta[key] === "") {
			existingMeta[key] = value;
			changed = true;
		}
	};

	setIfMissing("session_id", ids.sessionId);
	setIfMissing("thread_id", ids.threadId);
	setIfMissing("x-codex-installation-id", ids.installationId);
	setAlways("x-codex-window-id", ids.windowId);
	// These window-chain diagnostics predate Codex's current client_metadata
	// contract. Preserve them in the legacy metadata mode only.
	if (target === "metadata") {
		if (ids.firstWindowId) setAlways("first_window_id", ids.firstWindowId);
		if (ids.previousWindowId) setAlways("previous_window_id", ids.previousWindowId);
		else if ("previous_window_id" in existingMeta) {
			delete existingMeta.previous_window_id;
			changed = true;
		}
		if (ids.windowNumber != null) setAlways("window_number", String(ids.windowNumber));
	}
	if (ids.turnId) setAlways("turn_id", ids.turnId);
	if (ids.parentThreadId) setIfMissing("x-codex-parent-thread-id", ids.parentThreadId);
	if (changed) payload[target] = existingMeta;
	return changed;
}

// ── Persistence ──────────────────────────────────────────────────────────────

export function identityStorePath(agentDir?: string): string {
	const dir =
		agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? ".", ".pi", "agent");
	return join(dir, "client-mimic.identity.json");
}

export function installationIdPath(agentDir?: string): string {
	const dir =
		agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? ".", ".pi", "agent");
	return join(dir, "client-mimic.installation_id");
}

export function codexInstallationIdPath(home = process.env.HOME ?? "."): string {
	return join(home, ".codex", "installation_id");
}

export function loadIdentityStore(path = identityStorePath()): CodexIdentityStore {
	try {
		if (existsSync(path)) {
			const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<CodexIdentityStore>;
			if (raw && typeof raw === "object" && raw.byPiSession && typeof raw.byPiSession === "object") {
				return { byPiSession: { ...raw.byPiSession } };
			}
		}
	} catch (err) {
		console.warn(
			`[client-mimic] identity store unreadable (${path}):`,
			err instanceof Error ? err.message : err,
		);
	}
	return { byPiSession: {} };
}

export function saveIdentityStore(
	store: CodexIdentityStore,
	path = identityStorePath(),
): void {
	// session_start / compact only — short lock timeout so UI cannot hang.
	withFileLockBestEffort(
		path,
		() => {
			try {
				// Merge with on-disk state so parallel writers don't clobber each other.
				const disk = loadIdentityStore(path);
				const merged: Record<string, CodexIdentityRecord> = {
					...disk.byPiSession,
					...store.byPiSession,
				};
				const entries = Object.entries(merged).sort((a, b) =>
					(b[1].updatedAt || "").localeCompare(a[1].updatedAt || ""),
				);
				const trimmed: Record<string, CodexIdentityRecord> = {};
				for (const [k, v] of entries.slice(0, MAX_STORE_ENTRIES)) trimmed[k] = v;
				store.byPiSession = trimmed;
				atomicWriteFile(path, `${JSON.stringify(store, null, 2)}\n`);
			} catch (err) {
				console.warn(
					`[client-mimic] identity store write failed (${path}):`,
					err instanceof Error ? err.message : err,
				);
			}
		},
		/*timeoutMs*/ 200,
	);
}

/**
 * Prefer real Codex `~/.codex/installation_id`; else persist under pi agent dir.
 */
export function loadOrCreateInstallationId(options?: {
	codexPath?: string;
	localPath?: string;
}): string {
	const codexPath = options?.codexPath ?? codexInstallationIdPath();
	try {
		if (existsSync(codexPath)) {
			const raw = readFileSync(codexPath, "utf8").trim();
			if (isUuid(raw)) return raw;
		}
	} catch {
		// fall through
	}
	const localPath = options?.localPath ?? installationIdPath();
	try {
		if (existsSync(localPath)) {
			const raw = readFileSync(localPath, "utf8").trim();
			if (raw) return raw;
		}
	} catch {
		// fall through
	}
	return withFileLockBestEffort(localPath, () => {
		try {
			if (existsSync(localPath)) {
				const raw = readFileSync(localPath, "utf8").trim();
				if (raw) return raw;
			}
		} catch {
			// fall through
		}
		const id = randomUUID();
		try {
			atomicWriteFile(localPath, `${id}\n`);
		} catch (err) {
			console.warn(
				`[client-mimic] installation_id persist failed:`,
				err instanceof Error ? err.message : err,
			);
		}
		return id;
	});
}
