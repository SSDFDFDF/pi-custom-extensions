/**
 * Run: node --experimental-strip-types --test src/codex-identity.test.ts
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
	isUuidV7,
	loadIdentityStore,
	loadOrCreateInstallationId,
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
	assert.equal(r.sessionId, piId);
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
	assert.equal(child.threadId, childPi);
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
	assert.equal(grand.threadId, grandPi);
});

test("resume restores session/thread/window without minting new window", () => {
	const store: CodexIdentityStore = { byPiSession: {} };
	const piId = uuidV7();
	const first = resolveCodexIdentityOnSessionStart({ reason: "startup" }, sm(piId), store);
	// simulate compact persisted
	const advanced = advanceWindowChain(first);
	store.byPiSession[piId] = {
		sessionId: first.sessionId,
		threadId: first.threadId,
		firstWindowId: advanced.firstWindowId,
		previousWindowId: advanced.previousWindowId,
		windowId: advanced.windowId,
		windowNumber: advanced.windowNumber,
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

test("identity store atomic round-trip", () => {
	const dir = mkdtempSync(join(tmpdir(), "mimic-id-"));
	try {
		const path = join(dir, "client-mimic.identity.json");
		const store: CodexIdentityStore = {
			byPiSession: {
				a: {
					sessionId: "s",
					threadId: "t",
					firstWindowId: "w",
					windowId: "w",
					windowNumber: 0,
					updatedAt: "2026-01-01T00:00:00.000Z",
				},
			},
		};
		saveIdentityStore(store, path);
		const loaded = loadIdentityStore(path);
		assert.equal(loaded.byPiSession.a.sessionId, "s");
		assert.equal(JSON.parse(readFileSync(path, "utf8")).byPiSession.a.threadId, "t");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("installation id prefers codex file", () => {
	const dir = mkdtempSync(join(tmpdir(), "mimic-inst-"));
	try {
		const codexPath = join(dir, "codex-installation_id");
		const localPath = join(dir, "local-installation_id");
		const expected = "61c063ab-0ac1-450a-9c59-13c0f3cc185b";
		writeFileSync(codexPath, `${expected}\n`);
		const id = loadOrCreateInstallationId({ codexPath, localPath });
		assert.equal(id, expected);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
