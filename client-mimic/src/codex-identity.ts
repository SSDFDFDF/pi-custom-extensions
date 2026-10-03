/**
 * Session-local client identities. All persisted records have the current shape;
 * old files are not read, repaired or migrated.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createDeviceId, uuidV4 } from "./claude-identity.ts";
import { atomicWriteFile, withFileLock } from "./fs-util.ts";
import { isUuidV4, isUuidV7 } from "./ids.ts";

export interface CodexWindowChain {
	firstWindowId: string;
	previousWindowId?: string;
	windowId: string;
	windowNumber: number;
}

export interface CodexIdentityRecord extends CodexWindowChain {
	sessionId: string;
	threadId: string;
	parentThreadId?: string;
	installationId: string;
	deviceId: string;
	claudeSessionId: string;
	updatedAt: string;
}

export interface CodexIdentityState extends Omit<CodexIdentityRecord, "updatedAt"> {
	/** Storage key only; never used as an outgoing client identity. */
	piSessionKey: string;
	turnId: string;
}

export interface CodexIdentityStore {
	byPiSession: Record<string, CodexIdentityRecord>;
}

export interface SessionStartLike {
	reason: string;
	previousSessionFile?: string;
}

export interface SessionManagerLike {
	getSessionId: () => string;
	getHeader: () => { parentSession?: string } | null | undefined;
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

/** RFC 9562 UUIDv7 (time-ordered). */
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

export { isUuid, isUuidV4, isUuidV7 } from "./ids.ts";

export function newWindowChain(): CodexWindowChain {
	const windowId = uuidV7();
	return { firstWindowId: windowId, windowId, windowNumber: 0 };
}

export function advanceWindowChain(chain: CodexWindowChain): CodexWindowChain {
	return {
		firstWindowId: chain.firstWindowId,
		previousWindowId: chain.windowId,
		windowId: uuidV7(),
		windowNumber: chain.windowNumber + 1,
	};
}

export function extractSessionIdFromPath(path: string | undefined): string | undefined {
	const base = path?.split(/[/\\]/).pop() ?? "";
	return base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1];
}

export function createInitialIdentityState(piSessionKey = ""): CodexIdentityState {
	const sessionId = uuidV7();
	return {
		piSessionKey,
		sessionId,
		threadId: sessionId,
		...newWindowChain(),
		turnId: uuidV7(),
		installationId: randomUUID(),
		deviceId: createDeviceId(),
		claudeSessionId: uuidV4(),
	};
}

/** New root and complete identity set, retaining only Pi's storage key. */
export function rotateIdentityState(state: CodexIdentityState): CodexIdentityState {
	return createInitialIdentityState(state.piSessionKey);
}

export function resolveCodexIdentityOnSessionStart(
	event: SessionStartLike,
	sessionManager: SessionManagerLike,
	store: CodexIdentityStore,
): CodexIdentityState {
	const piSessionKey = sessionManager.getSessionId();
	if (!piSessionKey) throw new Error("client-mimic: missing Pi session ID");
	const known = store.byPiSession[piSessionKey];
	if (known) {
		const { updatedAt: _, ...ids } = known;
		return { ...ids, piSessionKey, turnId: uuidV7() };
	}

	const identity = createInitialIdentityState(piSessionKey);
	const parentPath = sessionManager.getHeader()?.parentSession
		?? (event.reason === "fork" ? event.previousSessionFile : undefined);
	const parentKey = extractSessionIdFromPath(parentPath);
	const parent = parentKey && parentKey !== piSessionKey ? store.byPiSession[parentKey] : undefined;
	if (parent) {
		identity.sessionId = parent.sessionId;
		identity.parentThreadId = parent.threadId;
	}
	// An absent parent record is not reconstructed from old Pi IDs.
	persistIdentityState(store, identity);
	return identity;
}

export function recordFromState(state: CodexIdentityState): CodexIdentityRecord {
	const { piSessionKey: _, turnId: __, ...ids } = state;
	return { ...ids, updatedAt: new Date().toISOString() };
}

export function persistIdentityState(store: CodexIdentityStore, state: CodexIdentityState): void {
	if (state.piSessionKey) store.byPiSession[state.piSessionKey] = recordFromState(state);
}

/** Managed identity values always take precedence over provider/config values. */
export function ensureCodexIdentity(
	payload: Record<string, unknown>,
	ids: CodexBodyIds,
	target: "metadata" | "client_metadata" = "metadata",
): boolean {
	let changed = payload.prompt_cache_key !== ids.sessionId;
	payload.prompt_cache_key = ids.sessionId;
	const existingMeta = payload[target] && typeof payload[target] === "object" && !Array.isArray(payload[target])
		? { ...(payload[target] as Record<string, unknown>) } : {};
	const set = (key: string, value: string | undefined) => {
		if (value === undefined) {
			if (key in existingMeta) {
				delete existingMeta[key];
				changed = true;
			}
		} else if (existingMeta[key] !== value) {
			existingMeta[key] = value;
			changed = true;
		}
	};
	set("session_id", ids.sessionId);
	set("thread_id", ids.threadId);
	set("x-codex-installation-id", ids.installationId);
	set("x-codex-window-id", ids.windowId);
	set("x-codex-parent-thread-id", ids.parentThreadId);
	set("turn_id", ids.turnId);
	// Standard Responses gateways use window diagnostics; Lite has a smaller contract.
	set("first_window_id", target === "metadata" ? ids.firstWindowId : undefined);
	set("previous_window_id", target === "metadata" ? ids.previousWindowId : undefined);
	set("window_number", target === "metadata" && ids.windowNumber != null ? String(ids.windowNumber) : undefined);
	if (changed) payload[target] = existingMeta;
	return changed;
}

/** New filename prevents a still-running old plugin from overwriting this store. */
export function identityStorePath(agentDir?: string): string {
	const dir = agentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? ".", ".pi", "agent");
	return join(dir, "client-mimic.sessions.json");
}

function isIdentityRecord(value: unknown): value is CodexIdentityRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const r = value as Record<string, unknown>;
	const v7 = (id: unknown) => typeof id === "string" && isUuidV7(id);
	const v4 = (id: unknown) => typeof id === "string" && isUuidV4(id);
	return v7(r.sessionId) && v7(r.threadId) && v7(r.windowId) && v7(r.firstWindowId)
		&& (r.parentThreadId === undefined || v7(r.parentThreadId))
		&& (r.previousWindowId === undefined || v7(r.previousWindowId))
		&& v4(r.installationId) && v4(r.claudeSessionId)
		&& typeof r.deviceId === "string" && /^[a-f0-9]{64}$/.test(r.deviceId)
		&& typeof r.windowNumber === "number" && Number.isSafeInteger(r.windowNumber) && r.windowNumber >= 0
		&& typeof r.updatedAt === "string" && Number.isFinite(Date.parse(r.updatedAt));
}

export function loadIdentityStore(path = identityStorePath()): CodexIdentityStore {
	if (!existsSync(path)) return { byPiSession: {} };
	const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<CodexIdentityStore> | null;
	if (!raw || typeof raw !== "object" || !raw.byPiSession || typeof raw.byPiSession !== "object"
		|| Array.isArray(raw.byPiSession) || !Object.values(raw.byPiSession).every(isIdentityRecord)) {
		throw new Error(`Invalid client-mimic session store: ${path}. Clear it; no migration is supported.`);
	}
	return { byPiSession: { ...raw.byPiSession } };
}

export function saveIdentityStore(
	store: CodexIdentityStore,
	path = identityStorePath(),
	options: { onlyKey?: string; strict?: boolean } = {},
): void {
	try {
		withFileLock(path, () => {
			const merged = { ...loadIdentityStore(path).byPiSession };
			for (const [key, record] of Object.entries(store.byPiSession)) {
				if (options.onlyKey !== undefined && key !== options.onlyKey) continue;
				if (!isIdentityRecord(record)) throw new Error(`Invalid client-mimic identity for ${key}`);
				if (options.onlyKey === key || !merged[key] || record.updatedAt > merged[key].updatedAt) merged[key] = record;
			}
			const entries = Object.entries(merged).sort((a, b) => b[1].updatedAt.localeCompare(a[1].updatedAt));
			const trimmed = Object.fromEntries(entries.slice(0, MAX_STORE_ENTRIES));
			atomicWriteFile(path, `${JSON.stringify({ byPiSession: trimmed }, null, 2)}\n`);
			store.byPiSession = trimmed;
		}, { timeoutMs: 200, strict: true });
	} catch (err) {
		if (options.strict) throw err;
		console.warn(`[client-mimic] identity store write failed (${path}):`, err instanceof Error ? err.message : err);
	}
}
