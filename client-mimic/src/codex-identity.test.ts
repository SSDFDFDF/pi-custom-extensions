/**
 * Run: node --loader /tmp/client-mimic-test-loader.mjs --test src/codex-identity.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	advanceWindowChain,
	ensureCodexIdentity,
	extractSessionIdFromPath,
	isUuidV4,
	isUuidV7,
	loadIdentityStore,
	newWindowChain,
	resolveCodexIdentityOnSessionStart,
	saveIdentityStore,
	uuidV7,
	type CodexIdentityStore,
	type SessionManagerLike,
} from "./codex-identity.ts";

function sm(id: string, parentSession?: string): SessionManagerLike {
	return {
		getSessionId: () => id,
		getHeader: () => (parentSession ? { parentSession } : {}),
	};
}

test("uuidV7 is version 7", () => {
	const id = uuidV7();
	assert.equal(isUuidV7(id), true);
	assert.equal(id[14], "7");
});

test("window chain advances with stable first id", () => {
	const a = newWindowChain();
	assert.equal(a.windowNumber, 0);
	assert.equal(a.firstWindowId, a.windowId);
	assert.equal(a.previousWindowId, undefined);

	const b = advanceWindowChain(a);
	assert.equal(b.firstWindowId, a.firstWindowId);
	assert.equal(b.previousWindowId, a.windowId);
	assert.notEqual(b.windowId, a.windowId);
	assert.equal(b.windowNumber, 1);

	const c = advanceWindowChain(b);
	assert.equal(c.firstWindowId, a.firstWindowId);
	assert.equal(c.previousWindowId, b.windowId);
	assert.equal(c.windowNumber, 2);
});

test("root session_id equals thread_id", () => {
	const store: CodexIdentityStore = { byPiSession: {} };
	const piId = uuidV7();
	const r = resolveCodexIdentityOnSessionStart({ reason: "startup" }, sm(piId), store);
	assert.equal(r.sessionId, r.threadId);
	assert.ok(isUuidV7(r.sessionId));
	assert.ok(isUuidV4(r.installationId));
	assert.ok(isUuidV4(r.claudeSessionId));
	assert.match(r.deviceId, /^[a-f0-9]{64}$/);
	assert.equal(r.parentThreadId, undefined);
	assert.equal(r.windowNumber, 0);
	assert.ok(store.byPiSession[piId]);
});

test("fork child shares session, new thread, has parent", () => {
	const store: CodexIdentityStore = { byPiSession: {} };
	const rootPi = uuidV7();
	const childPi = uuidV7();
	const rootPath = `/tmp/sessions/2026-01-01T00-00-00_${rootPi}.jsonl`;

	const root = resolveCodexIdentityOnSessionStart({ reason: "startup" }, sm(rootPi), store);
	const child = resolveCodexIdentityOnSessionStart(
		{ reason: "fork", previousSessionFile: rootPath },
		sm(childPi, rootPath),
		store,
	);

	assert.equal(child.sessionId, root.sessionId);
	assert.notEqual(child.threadId, child.sessionId);
	assert.equal(child.parentThreadId, root.threadId);
	assert.equal(child.windowNumber, 0);
	assert.notEqual(child.windowId, root.windowId);
});

test("grandchild inherits root session_id", () => {
	const store: CodexIdentityStore = { byPiSession: {} };
	const rootPi = uuidV7();
	const childPi = uuidV7();
	const grandPi = uuidV7();
	const rootPath = `/x/${rootPi}.jsonl`;
	const childPath = `/x/${childPi}.jsonl`;

	const root = resolveCodexIdentityOnSessionStart({ reason: "startup" }, sm(rootPi), store);
	const child = resolveCodexIdentityOnSessionStart(
		{ reason: "fork", previousSessionFile: rootPath },
		sm(childPi, rootPath),
		store,
	);
	const grand = resolveCodexIdentityOnSessionStart(
		{ reason: "fork", previousSessionFile: childPath },
		sm(grandPi, childPath),
		store,
	);

	assert.equal(grand.sessionId, root.sessionId);
	assert.equal(grand.parentThreadId, child.threadId);
	assert.notEqual(grand.threadId, child.threadId);
});

test("resume restores session/thread/window without minting new window", () => {
	const store: CodexIdentityStore = { byPiSession: {} };
	const piId = uuidV7();
	const first = resolveCodexIdentityOnSessionStart({ reason: "startup" }, sm(piId), store);
	const advanced = advanceWindowChain(first);
	store.byPiSession[piId] = {
		...first,
		...advanced,
		updatedAt: new Date().toISOString(),
	};

	const resumed = resolveCodexIdentityOnSessionStart({ reason: "resume" }, sm(piId), store);
	assert.equal(resumed.sessionId, first.sessionId);
	assert.equal(resumed.threadId, first.threadId);
	assert.equal(resumed.windowId, advanced.windowId);
	assert.equal(resumed.windowNumber, 1);
	assert.equal(resumed.previousWindowId, advanced.previousWindowId);
	assert.equal(resumed.firstWindowId, first.firstWindowId);
});

test("extractSessionIdFromPath reads pi session filenames", () => {
	const id = "019f7285-cf6f-7428-947e-9ebb00085b55";
	assert.equal(
		extractSessionIdFromPath(`/home/xjc/.pi/agent/sessions/--home--/2026-07-17T23-59-59-855Z_${id}.jsonl`),
		id,
	);
	assert.equal(extractSessionIdFromPath(undefined), undefined);
});

test("ensureCodexIdentity sets prompt_cache_key and refreshes window", () => {
	const payload: Record<string, unknown> = {};
	const sid = uuidV7();
	const tid = uuidV7();
	const wid1 = uuidV7();
	const wid2 = uuidV7();

	assert.equal(
		ensureCodexIdentity(payload, {
			sessionId: sid,
			threadId: tid,
			windowId: wid1,
			installationId: "install",
			firstWindowId: wid1,
			windowNumber: 0,
			turnId: "turn-1",
		}),
		true,
	);
	assert.equal(payload.prompt_cache_key, sid);
	const meta1 = payload.metadata as Record<string, unknown>;
	assert.equal(meta1.session_id, sid);
	assert.equal(meta1.thread_id, tid);
	assert.equal(meta1["x-codex-window-id"], wid1);
	assert.equal(meta1.turn_id, "turn-1");

	// second call refreshes window/turn, keeps session
	assert.equal(
		ensureCodexIdentity(payload, {
			sessionId: sid,
			threadId: tid,
			windowId: wid2,
			installationId: "install",
			firstWindowId: wid1,
			previousWindowId: wid1,
			windowNumber: 1,
			turnId: "turn-2",
		}),
		true,
	);
	const meta2 = payload.metadata as Record<string, unknown>;
	assert.equal(meta2.session_id, sid);
	assert.equal(meta2["x-codex-window-id"], wid2);
	assert.equal(meta2.previous_window_id, wid1);
	assert.equal(meta2.window_number, "1");
	assert.equal(meta2.turn_id, "turn-2");
});

test("ensureCodexIdentity uses current Codex client_metadata for Lite requests", () => {
	const payload: Record<string, unknown> = {};
	ensureCodexIdentity(
		payload,
		{
			sessionId: "session",
			threadId: "thread",
			windowId: "window",
			installationId: "install",
			firstWindowId: "first-window",
			previousWindowId: "previous-window",
			windowNumber: 4,
			turnId: "turn",
			parentThreadId: "parent",
		},
		"client_metadata",
	);

	assert.equal(payload.prompt_cache_key, "session");
	assert.equal(payload.metadata, undefined);
	assert.deepEqual(payload.client_metadata, {
		session_id: "session",
		thread_id: "thread",
		"x-codex-installation-id": "install",
		"x-codex-window-id": "window",
		turn_id: "turn",
		"x-codex-parent-thread-id": "parent",
	});
});

test("identity store atomic round-trip", () => {
	const dir = mkdtempSync(join(tmpdir(), "mimic-id-"));
	try {
		const path = join(dir, "client-mimic.sessions.json");
		const sid = uuidV7();
		const wid = uuidV7();
		const store: CodexIdentityStore = {
			byPiSession: {
				a: {
					sessionId: sid,
					threadId: sid,
					firstWindowId: wid,
					windowId: wid,
					windowNumber: 0,
					installationId: "00000000-0000-4000-8000-000000000001",
					claudeSessionId: "00000000-0000-4000-8000-000000000002",
					deviceId: "a".repeat(64),
					updatedAt: "2026-01-01T00:00:00.000Z",
				},
			},
		};
		saveIdentityStore(store, path);
		const loaded = loadIdentityStore(path);
		assert.equal(loaded.byPiSession.a.sessionId, sid);
		assert.equal(JSON.parse(readFileSync(path, "utf8")).byPiSession.a.threadId, sid);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("loadIdentityStore throws on legacy or corrupt data without migration", () => {
	const dir = mkdtempSync(join(tmpdir(), "mimic-store-"));
	try {
		const path = join(dir, "client-mimic.sessions.json");
		writeFileSync(path, JSON.stringify({ byPiSession: { old: { sessionId: "s" } } }));
		assert.throws(() => loadIdentityStore(path), /Invalid client-mimic session store/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
