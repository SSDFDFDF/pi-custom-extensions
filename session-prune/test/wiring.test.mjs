/**
 * Wiring tests: the extension installed on a stubbed ExtensionAPI, the tool and
 * `/prune` command driven against a real SessionManager, boundary drafts applied
 * the way Pi commits them at `turn_end`.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SessionManager, load } from "./load.mjs";

const { default: install } = await load("../extension.ts");
const { readLedger } = await load("../src/ops.ts");

const PRUNE_CALL_ID = "call-prune";

function assistantMessage(content, stopReason = "toolUse") {
	return {
		role: "assistant",
		api: "anthropic-messages",
		provider: "test",
		model: "test-model",
		content,
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function toolResult(toolCallId, toolName, text) {
	return { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError: false, timestamp: Date.now() };
}

/** user, assistant+read call, read result, assistant, user, assistant+grep call, grep result, assistant */
function makeSession() {
	const session = SessionManager.inMemory("/tmp/session-prune-wiring");
	session.appendMessage({ role: "user", content: "first request", timestamp: Date.now() });
	session.appendMessage(
		assistantMessage([
			{ type: "text", text: "looking at the file" },
			{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
		]),
	);
	session.appendMessage(toolResult("c1", "read", "a very long file body"));
	session.appendMessage(assistantMessage([{ type: "text", text: "part one done" }], "stop"));
	session.appendMessage({ role: "user", content: "second request", timestamp: Date.now() });
	session.appendMessage(
		assistantMessage([
			{ type: "text", text: "searching" },
			{ type: "toolCall", id: "c2", name: "grep", arguments: { pattern: "needle" } },
		]),
	);
	session.appendMessage(toolResult("c2", "grep", "needle found"));
	session.appendMessage(assistantMessage([{ type: "text", text: "final answer" }], "stop"));
	return session;
}

/** The same session with the running turn: user message + the assistant message that called session_prune. */
function makeSessionWithRunningTurn() {
	const session = makeSession();
	session.appendMessage({ role: "user", content: "clean this up", timestamp: Date.now() });
	session.appendMessage(
		assistantMessage([
			{ type: "text", text: "trimming" },
			{ type: "toolCall", id: PRUNE_CALL_ID, name: "session_prune", arguments: { action: "apply" } },
		]),
	);
	return session;
}

/** Mimic Pi's boundary commit for a batch of drafts. */
function commitDrafts(session, drafts) {
	for (const draft of drafts) {
		if (draft.type === "custom") session.appendCustomEntry(draft.customType, draft.data);
		else if (draft.type === "context_edit") session.appendContextEdit(draft.targetId, draft.replacement);
		else if (draft.type === "custom_message") session.appendCustomMessageEntry(draft.customType, draft.content, draft.display, draft.details);
	}
}

function textOf(message) {
	if (typeof message.content === "string") return message.content;
	return (message.content ?? [])
		.map((block) => (block.type === "text" ? block.text : block.type === "toolCall" ? `[call ${block.name}]` : block.type))
		.join(" ");
}

function modelMessages(session) {
	return session.buildSessionProjection().messages.filter((message) => message.role !== "custom");
}

function createHarness(session) {
	const handlers = new Map();
	const tools = new Map();
	const commands = new Map();
	const notifications = [];
	const baseContext = {
		mode: "json",
		hasUI: false,
		cwd: "/tmp/session-prune-wiring",
		sessionManager: session,
		ui: {
			notify: (message, level = "info") => notifications.push({ message, level }),
			setStatus: () => {},
			confirm: async () => true,
		},
		isIdle: () => true,
		waitForIdle: async () => {},
		getContextUsage: () => undefined,
	};
	install({
		on: (name, handler) => {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
			return () => {};
		},
		registerTool: (tool) => tools.set(tool.name, tool),
		registerCommand: (name, options) => commands.set(name, options),
		registerEntryRenderer: () => {},
		registerMessageRenderer: () => {},
		appendEntry: (customType, data) => {
			session.appendCustomEntry(customType, data);
		},
	});

	const defaultEvent = (name) =>
		name === "turn_end"
			? { type: "turn_end", messageEntryId: "turn-assistant-entry", toolResultEntryIds: ["turn-result-entry"] }
			: { type: name };

	const emit = async (name, event = defaultEvent(name)) => {
		for (const handler of handlers.get(name) ?? []) {
			const result = await handler(event, baseContext);
			if (result !== undefined) return result;
		}
		return undefined;
	};

	return { tools, commands, notifications, emit, ctx: baseContext };
}

test("the tool lists the context and applies a prune at turn_end", async () => {
	const session = makeSessionWithRunningTurn();
	const { tools, emit, ctx } = createHarness(session);
	const tool = tools.get("session_prune");
	assert.ok(tool);

	const listed = await tool.execute(PRUNE_CALL_ID, { action: "list" }, undefined, undefined, ctx);
	const listing = listed.content[0].text;
	assert.match(listing, /rows 10 · 10 live · 0 hidden/);
	assert.match(listing, /snapshot 0/);
	assert.match(listing, /current turn/);
	assert.equal(listed.details.snapshot, 0);

	const applied = await tool.execute(PRUNE_CALL_ID, { action: "apply", drop: { indices: [2] } }, undefined, undefined, ctx);
	assert.match(applied.content[0].text, /context updated/);
	assert.equal(applied.details.changes, 2);
	assert.equal(session.buildSessionProjection().messages.length, 10, "nothing is written before turn_end");

	const boundary = await emit("turn_end", { type: "turn_end", messageEntryId: "x", toolResultEntryIds: [] });
	assert.ok(boundary?.entries?.length >= 3);
	commitDrafts(session, boundary.entries);

	const messages = session.buildSessionProjection().messages;
	assert.equal(messages.length, 10, "3 dropped -> 1 result, plus the marker");
	assert.deepEqual(messages[1].content, [{ type: "text", text: "looking at the file" }]);
	assert.equal(messages.some((message) => message.role === "toolResult" && message.toolCallId === "c1"), false);
	assert.match(messages.at(-1).content, /\[session-prune\] context trimmed/);

	// The pending prune is consumed once.
	assert.equal(await emit("turn_end"), undefined);
});

test("a stale snapshot is rejected", async () => {
	const session = makeSessionWithRunningTurn();
	const { tools, emit, ctx } = createHarness(session);
	const tool = tools.get("session_prune");

	await tool.execute(PRUNE_CALL_ID, { action: "apply", drop: { indices: [2] } }, undefined, undefined, ctx);
	commitDrafts(session, (await emit("turn_end")).entries);

	await assert.rejects(
		tool.execute(PRUNE_CALL_ID, { action: "apply", snapshot: 0, drop: { indices: [4] } }, undefined, undefined, ctx),
		/stale listing/,
	);
	const fresh = await tool.execute(PRUNE_CALL_ID, { action: "list" }, undefined, undefined, ctx);
	assert.equal(fresh.details.snapshot, 1);
	const applied = await tool.execute(
		PRUNE_CALL_ID,
		{ action: "apply", snapshot: fresh.details.snapshot, drop: { indices: [4] } },
		undefined,
		undefined,
		ctx,
	);
	assert.match(applied.content[0].text, /context updated/);
});

test("dryRun plans without writing", async () => {
	const session = makeSessionWithRunningTurn();
	const { tools, emit, ctx } = createHarness(session);
	const tool = tools.get("session_prune");
	const result = await tool.execute(PRUNE_CALL_ID, { action: "apply", dryRun: true, keep: { turns: 1 } }, undefined, undefined, ctx);
	assert.match(result.content[0].text, /dry run/);
	assert.equal(session.buildSessionProjection().messages.length, 10);
	assert.equal(await emit("turn_end"), undefined);
});

test("undo restores the last prune", async () => {
	const session = makeSessionWithRunningTurn();
	const { tools, emit, ctx } = createHarness(session);
	const tool = tools.get("session_prune");
	const before = modelMessages(session).map(textOf);

	await tool.execute(PRUNE_CALL_ID, { action: "apply", drop: { roles: ["toolResult"] } }, undefined, undefined, ctx);
	commitDrafts(session, (await emit("turn_end")).entries);
	assert.equal(modelMessages(session).length, 8);

	const undone = await tool.execute(PRUNE_CALL_ID, { action: "undo" }, undefined, undefined, ctx);
	assert.match(undone.content[0].text, /restore #1-2, #5-6/);
	commitDrafts(session, (await emit("turn_end")).entries);
	assert.deepEqual(modelMessages(session).map(textOf), before);

	// A second undo has nothing left to do.
	await assert.rejects(tool.execute(PRUNE_CALL_ID, { action: "undo" }, undefined, undefined, ctx), /nothing to undo/);
});

test("status reports config and history", async () => {
	const session = makeSessionWithRunningTurn();
	const { tools, ctx } = createHarness(session);
	const tool = tools.get("session_prune");
	const result = await tool.execute(PRUNE_CALL_ID, { action: "status" }, undefined, undefined, ctx);
	assert.match(result.content[0].text, /session-prune status/);
	assert.match(result.content[0].text, /10\/10 editable live/);
});

test("the running turn cannot be pruned away", async () => {
	const session = makeSessionWithRunningTurn();
	const { tools, emit, ctx } = createHarness(session);
	const tool = tools.get("session_prune");

	const result = await tool.execute(PRUNE_CALL_ID, { action: "apply", keep: { indices: [0] } }, undefined, undefined, ctx);
	assert.match(result.content[0].text, /protected \(current turn\)/);
	commitDrafts(session, (await emit("turn_end")).entries);

	const messages = session.buildSessionProjection().messages;
	// The first user message, the running user message, the running assistant
	// message (with its prune call intact) and the marker.
	assert.equal(messages.length, 4);
	assert.equal(messages[0].content, "first request");
	const running = messages.find((message) => message.role === "assistant");
	assert.equal(running.content.at(-1).id, PRUNE_CALL_ID);
});

test("the /prune command applies selectors and undoes them", async () => {
	const session = makeSession();
	const { commands, notifications, ctx } = createHarness(session);
	const prune = commands.get("prune");
	assert.ok(prune);

	await prune.handler("drop role:toolResult", ctx);
	assert.equal(session.buildSessionProjection().messages.filter((message) => message.role === "toolResult").length, 0);
	assert.ok(notifications.some((note) => /context updated/.test(note.message)));

	await prune.handler("undo", ctx);
	assert.equal(session.buildSessionProjection().messages.filter((message) => message.role === "toolResult").length, 2);

	await prune.handler("list", ctx);
	assert.ok(notifications.some((note) => /rows \d+ · \d+ live/.test(note.message)));

	await prune.handler("status", ctx);
	assert.ok(notifications.some((note) => /session-prune status/.test(note.message)));

	await prune.handler("keep turns:1", ctx);
	assert.equal(session.buildSessionProjection().messages.filter((message) => message.role === "toolResult").length, 1);

	await prune.handler("nonsense", ctx);
	assert.ok(notifications.some((note) => note.level === "error"));
});

test("the /prune command reports bad selectors instead of throwing", async () => {
	const session = makeSession();
	const { commands, notifications, ctx } = createHarness(session);
	await commands.get("prune").handler("drop colour:red", ctx);
	assert.ok(notifications.some((note) => note.level === "error" && /unknown selector/.test(note.message)));
});

test("session_start materializes the config file", async () => {
	const dir = mkdtempSync(join(tmpdir(), "session-prune-config-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		const { emit } = createHarness(makeSession());
		await emit("session_start", { type: "session_start" });
		const config = JSON.parse(readFileSync(join(dir, "session-prune.config.json"), "utf8"));
		assert.equal(config.marker, true);
		assert.equal(config.protectLastUser, true);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("two prunes in one turn merge into one boundary batch", async () => {
	const session = makeSessionWithRunningTurn();
	const { tools, emit, ctx } = createHarness(session);
	const tool = tools.get("session_prune");

	await tool.execute(PRUNE_CALL_ID, { action: "apply", drop: { indices: [2] } }, undefined, undefined, ctx);
	await tool.execute(PRUNE_CALL_ID, { action: "apply", drop: { indices: [6] } }, undefined, undefined, ctx);
	const boundary = await emit("turn_end");
	// Two edits per prune: the result is omitted and its call stripped.
	const edits = boundary.entries.filter((draft) => draft.type === "context_edit");
	assert.equal(edits.length, 4);
	assert.equal(boundary.entries.filter((draft) => draft.type === "custom").length, 2);
	commitDrafts(session, boundary.entries);

	const messages = session.buildSessionProjection().messages;
	assert.equal(messages.some((message) => message.role === "toolResult" && message.toolCallId === "c1"), false);
	assert.equal(messages.some((message) => message.role === "toolResult" && message.toolCallId === "c2"), false);
});

test("a merged turn writes each target once", async () => {
	const session = makeSessionWithRunningTurn();
	const { tools, emit, ctx } = createHarness(session);
	const tool = tools.get("session_prune");

	// The second call wins for the same row.
	await tool.execute(PRUNE_CALL_ID, { action: "apply", drop: { indices: [2] } }, undefined, undefined, ctx);
	await tool.execute(PRUNE_CALL_ID, { action: "apply", restore: { indices: [2] } }, undefined, undefined, ctx);
	const boundary = await emit("turn_end");
	const targets = boundary.entries.filter((draft) => draft.type === "context_edit").map((draft) => draft.targetId);
	assert.equal(new Set(targets).size, targets.length);
});

test("undo of an operation that is already live is still consumed", async () => {
	const session = makeSessionWithRunningTurn();
	const { tools, emit, ctx } = createHarness(session);
	const tool = tools.get("session_prune");

	// Row 4 is the plain assistant message "part one done": a single omission,
	// which is easy to put back by hand.
	await tool.execute(PRUNE_CALL_ID, { action: "apply", drop: { indices: [3] } }, undefined, undefined, ctx);
	commitDrafts(session, (await emit("turn_end")).entries);
	const record = readLedger(session.getBranch()).prunes.at(-1);
	const target = record.data.targets[0];
	const entry = session.getEntry(target.entryId);
	session.appendContextEdit(target.entryId, { content: entry.message.content });

	const undone = await tool.execute(PRUNE_CALL_ID, { action: "undo" }, undefined, undefined, ctx);
	assert.match(undone.content[0].text, /already fully live/);
	commitDrafts(session, (await emit("turn_end")).entries);
	// The operation is consumed, so a second undo has nothing left to do.
	await assert.rejects(tool.execute(PRUNE_CALL_ID, { action: "undo" }, undefined, undefined, ctx), /nothing to undo/);
});

test("an empty session lists nothing and refuses a whitelist", async () => {
	const session = SessionManager.inMemory("/tmp/session-prune-empty");
	const { tools, ctx } = createHarness(session);
	const tool = tools.get("session_prune");

	const listed = await tool.execute("call-1", { action: "list" }, undefined, undefined, ctx);
	assert.match(listed.content[0].text, /rows 0/);

	const status = await tool.execute("call-1", { action: "status" }, undefined, undefined, ctx);
	assert.match(status.content[0].text, /0 rows/);

	await assert.rejects(tool.execute("call-1", { action: "apply", keep: { turns: 1 } }, undefined, undefined, ctx), /matched no rows/);
});
