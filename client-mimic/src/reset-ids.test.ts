import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import clientMimic from "./index.ts";
import { DEFAULT_PROFILES } from "./config.ts";
import { identityStorePath, loadIdentityStore, uuidV7 } from "./codex-identity.ts";
import { isUuidV4, isUuidV7 } from "./ids.ts";

async function isolated(run: (dir: string) => Promise<void>, config: Record<string, unknown> = {}) {
	const dir = mkdtempSync(join(tmpdir(), "mimic-reset-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	writeFileSync(join(dir, "client-mimic.config.json"), JSON.stringify({
		enabled: true, active: "codex", systemPrompt: { mode: "off" }, ...config,
	}));
	try {
		await run(dir);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	}
}

function harness(piId = uuidV7()) {
	const handlers = new Map<string, (event: any, ctx: any) => any>();
	const commands = new Map<string, any>();
	const providers = new Map<string, any>();
	const notifications: Array<{ text: string; level: string }> = [];
	let sessionId = piId;
	let parentSession: string | undefined;
	let idle = true;
	let pending = false;
	const ctx = {
		hasUI: true,
		ui: {
			notify(text: string, level: string) { notifications.push({ text, level }); },
			setStatus() {},
		},
		sessionManager: {
			getSessionId: () => sessionId,
			getHeader: () => ({ parentSession }),
		},
		isIdle: () => idle,
		hasPendingMessages: () => pending,
	};
	clientMimic({
		registerFlag() {},
		getFlag() {},
		on(event: string, handler: any) { handlers.set(event, handler); },
		registerCommand(name: string, command: any) { commands.set(name, command); },
		registerProvider(name: string, provider: any) { providers.set(name, provider); },
	} as unknown as ExtensionAPI);
	const emit = (event: string, value = {}) => handlers.get(event)!({ type: event, ...value }, ctx);
	return {
		piId, notifications, providers, commands, emit,
		busy(value: boolean, queued = false) { idle = !value; pending = queued; },
		start(reason = "startup", id = sessionId, parent?: string, previousSessionFile?: string) {
			sessionId = id;
			parentSession = parent;
			emit("session_start", { reason, previousSessionFile });
		},
		command: (args: string) => commands.get("mimic").handler(args, ctx),
		headers() {
			const headers: Record<string, string | null> = {};
			emit("before_provider_headers", { headers });
			return headers;
		},
		body(payload: Record<string, unknown> = {}) {
			return emit("before_provider_request", { payload }) ?? payload;
		},
		record: () => loadIdentityStore().byPiSession[sessionId],
	};
}

test("reset replaces all identities, persists across reload/resume, and leaves Pi history alone", async () => {
	await isolated(async (dir) => {
		const h = harness();
		h.start();
		h.emit("session_compact");
		const old = h.record();
		const oldHeaders = h.headers();
		const oldTurn = h.body().metadata.turn_id;
		const config = readFileSync(join(dir, "client-mimic.config.json"), "utf8");

		await h.command("reset-ids");
		const next = h.record();
		assert.notEqual(next.sessionId, old.sessionId);
		assert.equal(next.sessionId, next.threadId);
		assert.notEqual(next.windowId, old.windowId);
		assert.notEqual(next.firstWindowId, old.firstWindowId);
		assert.equal(next.firstWindowId, next.windowId);
		assert.equal(next.previousWindowId, undefined);
		assert.equal(next.parentThreadId, undefined);
		assert.equal(next.windowNumber, 0);
		assert.ok(isUuidV7(next.sessionId));
		assert.ok(isUuidV7(next.windowId));
		assert.ok(isUuidV4(next.claudeSessionId));
		assert.ok(isUuidV4(next.installationId));
		assert.notEqual(next.installationId, oldHeaders["x-codex-installation-id"]);
		assert.match(next.deviceId, /^[a-f0-9]{64}$/);
		assert.notEqual(next.deviceId, old.deviceId);

		// No old legacy files created
		assert.equal(existsSync(join(dir, "client-mimic.device_id")), false);
		assert.equal(existsSync(join(dir, "client-mimic.installation_id")), false);
		assert.equal(existsSync(join(dir, "client-mimic.claude-sessions.json")), false);
		assert.equal(existsSync(join(dir, "client-mimic.identity.json")), false);
		assert.equal(existsSync(join(dir, "client-mimic.sessions.json")), true);

		const headers = h.headers();
		const payload = h.body({ prompt_cache_key: h.piId, metadata: {
			session_id: old.sessionId, thread_id: old.threadId,
			"x-codex-installation-id": oldHeaders["x-codex-installation-id"],
			"x-codex-parent-thread-id": "old-parent", previous_window_id: old.windowId, custom: "keep",
		} });
		assert.equal(headers["session-id"], next.sessionId);
		assert.equal(payload.prompt_cache_key, next.sessionId);
		assert.equal(payload.metadata.session_id, headers["session-id"]);
		assert.equal(payload.metadata.thread_id, headers["thread-id"]);
		assert.equal(payload.metadata["x-codex-installation-id"], headers["x-codex-installation-id"]);
		assert.equal(payload.metadata["x-codex-window-id"], headers["x-codex-window-id"]);
		assert.equal(payload.metadata["x-codex-parent-thread-id"], undefined);
		assert.equal(payload.metadata.previous_window_id, undefined);
		assert.equal(payload.metadata.custom, "keep");
		assert.ok(isUuidV7(payload.metadata.turn_id));
		assert.notEqual(payload.metadata.turn_id, oldTurn);
		assert.equal(readFileSync(join(dir, "client-mimic.config.json"), "utf8"), config);

		const reloaded = harness(h.piId);
		reloaded.start("reload");
		assert.equal(reloaded.headers()["session-id"], next.sessionId);
		assert.equal(reloaded.headers()["x-codex-installation-id"], next.installationId);
		await reloaded.command("use claude-code");
		const claudeHeaders = reloaded.headers();
		const claudeBody = reloaded.body({ metadata: { user_id: JSON.stringify({
			device_id: "old", session_id: "old", account_uuid: "real-account", extra: 1,
		}) } });
		const user = JSON.parse(claudeBody.metadata.user_id);
		assert.equal(user.session_id, claudeHeaders["X-Claude-Code-Session-Id"]);
		assert.equal(user.session_id, next.claudeSessionId);
		assert.equal(user.device_id, next.deviceId);
		assert.equal(user.account_uuid, "real-account");
		assert.equal(user.extra, 1);

		reloaded.start("new", uuidV7(), undefined, `/tmp/${h.piId}.jsonl`);
		assert.equal(reloaded.record().parentThreadId, undefined);
		assert.notEqual(reloaded.record().sessionId, next.sessionId);
		reloaded.start("resume", h.piId);
		assert.equal(reloaded.headers()["X-Claude-Code-Session-Id"], next.claudeSessionId);
		reloaded.emit("session_compact");
		assert.equal(reloaded.record().sessionId, next.sessionId);
		assert.equal(reloaded.record().previousWindowId, next.windowId);
		assert.equal(reloaded.record().claudeSessionId, next.claudeSessionId);
	});
});

test("reset a child detaches only that conversation; stale writers cannot undo it", async () => {
	await isolated(async () => {
		const root = harness();
		root.start();
		const child = harness();
		const parentPath = `/tmp/${root.piId}.jsonl`;
		child.start("fork", child.piId, parentPath, parentPath);
		assert.equal(child.record().sessionId, root.record().sessionId);
		const sibling = harness();
		sibling.start("fork", sibling.piId, parentPath, parentPath);
		const beforeRoot = root.record();
		const beforeSibling = sibling.record();
		await child.command("reset-ids");
		const reset = child.record();
		assert.notEqual(reset.sessionId, beforeRoot.sessionId);
		assert.equal(reset.parentThreadId, undefined);
		assert.deepEqual(root.record(), beforeRoot);
		assert.deepEqual(sibling.record(), beforeSibling);
		// Both have snapshots predating the child's reset.
		root.emit("session_compact");
		sibling.emit("session_compact");
		assert.deepEqual(child.record(), reset);
		const restarted = harness(child.piId);
		restarted.start("startup", child.piId, parentPath);
		assert.equal(restarted.record().sessionId, reset.sessionId);
		assert.equal(restarted.record().parentThreadId, undefined);
	});
});

test("busy, queued, invalid arguments and locked-store resets leave identities unchanged", async () => {
	await isolated(async () => {
		const h = harness();
		h.start();
		const before = h.record();
		for (const [busy, queued] of [[true, false], [false, true]]) {
			h.busy(busy, queued);
			await h.command("reset-ids");
			assert.equal(h.notifications.at(-1)!.level, "warning");
			assert.deepEqual(h.record(), before);
		}
		h.busy(false);
		await h.command("reset-ids all");
		assert.equal(h.notifications.at(-1)!.level, "error");
		const path = identityStorePath();
		writeFileSync(`${path}.lock`, `${process.pid}\n`);
		await h.command("reset-ids");
		assert.equal(h.notifications.at(-1)!.level, "error");
		assert.match(h.notifications.at(-1)!.text, /IDs unchanged/);
		assert.deepEqual(h.record(), before);
		assert.equal(h.headers()["session-id"], before.sessionId);
		rmSync(`${path}.lock`);
		await h.command("reset-ids");
		assert.notEqual(h.record().sessionId, before.sessionId);
	});
});

test("unreadable identity storage leaves runtime IDs untouched and reports failure instead of success", async () => {
	await isolated(async () => {
		const h = harness();
		h.start();
		const before = h.headers();
		const path = identityStorePath();
		renameSync(path, `${path}.saved`);
		mkdirSync(path); // A directory is neither a readable store nor a writable file.
		const originalWarn = console.warn;
		console.warn = () => {};
		try {
			await h.command("reset-ids");
			assert.equal(h.notifications.at(-1)!.level, "error");
			assert.match(h.notifications.at(-1)!.text, /IDs unchanged/);
			assert.equal(h.headers()["session-id"], before["session-id"]);
			assert.equal(h.headers()["x-codex-installation-id"], before["x-codex-installation-id"]);
		} finally {
			console.warn = originalWarn;
			rmSync(path, { recursive: true });
			renameSync(`${path}.saved`, path);
		}
	});
});

test("reset works while off and persists a replacement for a native UUIDv4 Claude session", async () => {
	await isolated(async () => {
		const h = harness(randomUUID());
		h.start();
		await h.command("reset-ids");
		const next = h.record();
		assert.deepEqual(h.headers(), {});
		await h.command("use claude-code");
		assert.notEqual(next.claudeSessionId, h.piId);
		assert.equal(h.headers()["X-Claude-Code-Session-Id"], next.claudeSessionId);
		assert.equal(h.commands.get("mimic").getArgumentCompletions("reset")[0].value, "reset-ids");
		await h.command("ids");
		assert.ok(h.notifications.at(-1)!.text.includes(h.piId));
		assert.ok(h.notifications.at(-1)!.text.includes(next.claudeSessionId));
	}, { active: "off" });
});

test("custom Claude profiles and show use the requested identity family", async () => {
	await isolated(async () => {
		const h = harness();
		h.start();
		assert.equal(h.providers.size, 0, "Codex must not be wrapped as Anthropic");
		await h.command("show claude-code");
		assert.match(h.notifications.at(-1)!.text, /X-Claude-Code-Session-Id: [a-f0-9-]{14}4/);
		await h.command("use custom-claude");
		assert.equal(h.providers.size, 1);
		const registered = h.providers.get("relay");
		await h.command("reset-ids");
		assert.equal(h.providers.get("relay"), registered, "reset updates options without nested wrappers");
		const headers = h.headers();
		assert.ok(isUuidV4(headers["X-Claude-Code-Session-Id"]!));
		assert.equal(JSON.parse(h.body().metadata.user_id).session_id, headers["X-Claude-Code-Session-Id"]);
	}, { wrapProviders: ["relay"], profiles: { "custom-claude": DEFAULT_PROFILES["claude-code"] } });
});

test("reset replaces pinned identity headers/template vars and Lite cache metadata", async () => {
	await isolated(async () => {
		const h = harness();
		h.start();
		await h.command("reset-ids");
		const headers = h.headers();
		const body = h.body({ input: [], prompt_cache_key: "old", client_metadata: { session_id: "old" } });
		assert.equal(headers["session-id"], h.record().sessionId);
		assert.equal(headers["thread-id"], h.record().threadId);
		assert.equal(body.prompt_cache_key, headers["session-id"]);
		assert.equal(body.client_metadata.session_id, headers["session-id"]);
	}, { active: "codex-lite", profiles: { "codex-lite": {
		headers: { ...DEFAULT_PROFILES["codex-lite"].headers, "session-id": "pinned" },
		templateVars: { thread_id: "pinned" },
	} } });
});

test("file prompt arguments do not include the mode token", async () => {
	await isolated(async (dir) => {
		const h = harness();
		h.start();
		await h.command("prompt codex file /tmp/My Prompt.md");
		let cfg = JSON.parse(readFileSync(join(dir, "client-mimic.config.json"), "utf8"));
		assert.equal(cfg.profiles.codex.systemPrompt.file, "/tmp/My Prompt.md");
		await h.command("prompt codex file");
		cfg = JSON.parse(readFileSync(join(dir, "client-mimic.config.json"), "utf8"));
		assert.equal(cfg.profiles.codex.systemPrompt.file, "extensions/client-mimic/prompts/codex.md");
	});
});
