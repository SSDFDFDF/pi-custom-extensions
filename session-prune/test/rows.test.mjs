/**
 * Integration tests: rows built from Pi's real SessionManager, plans applied as
 * real context edits, verified through `buildSessionProjection()` — the exact
 * message list a provider request uses.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { SessionManager, load } from "./load.mjs";

const { buildRows, isNestedToolCallId } = await load("../src/rows.ts");
const { planPrune } = await load("../src/plan.ts");
const { CUSTOM_TYPE, findPruneToUndo, planDrafts, pruneRecord, protectedOmission, readLedger, undoRecord, undoRequest } = await load("../src/ops.ts");

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

function toolResultMessage(toolCallId, toolName, text) {
	return { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError: false, timestamp: Date.now() };
}

/** user, assistant+read call, read result, assistant, user, assistant+grep call, grep result, assistant */
function makeSession() {
	const session = SessionManager.inMemory("/tmp/session-prune-test");
	const ids = {};
	ids.u0 = session.appendMessage({ role: "user", content: "first request", timestamp: Date.now() });
	ids.a1 = session.appendMessage(
		assistantMessage([
			{ type: "text", text: "looking at the file" },
			{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
		]),
	);
	ids.r1 = session.appendMessage(toolResultMessage("c1", "read", "a very long file body that wastes context"));
	ids.a3 = session.appendMessage(assistantMessage([{ type: "text", text: "part one done" }], "stop"));
	ids.u4 = session.appendMessage({ role: "user", content: "second request", timestamp: Date.now() });
	ids.a5 = session.appendMessage(
		assistantMessage([
			{ type: "text", text: "searching" },
			{ type: "toolCall", id: "c2", name: "grep", arguments: { pattern: "needle" } },
		]),
	);
	ids.r6 = session.appendMessage(toolResultMessage("c2", "grep", "needle found here"));
	ids.a7 = session.appendMessage(assistantMessage([{ type: "text", text: "final answer" }], "stop"));
	return { session, ids };
}

/** Apply a plan the way Pi applies boundary drafts. */
function applyPlan(session, plan) {
	for (const decision of plan.decisions) {
		session.appendContextEdit(decision.entryId, decision.action === "omit" ? null : { content: decision.content });
	}
}

function applyDrafts(session, drafts) {
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

test("buildRows maps the session projection", () => {
	const { session } = makeSession();
	const { rows } = buildRows(session);
	assert.deepEqual(
		rows.map((row) => row.role),
		["user", "assistant", "toolResult", "assistant", "user", "assistant", "toolResult", "assistant"],
	);
	assert.deepEqual(
		rows.map((row) => row.index),
		[0, 1, 2, 3, 4, 5, 6, 7],
	);
	assert.ok(rows.every((row) => row.visible && row.editable));
	assert.ok(rows.every((row) => row.tokens > 0));
	assert.deepEqual(rows[1].toolCalls, [{ id: "c1", name: "read" }]);
	assert.equal(rows[2].toolCallId, "c1");
	assert.equal(rows[2].toolName, "read");
	assert.equal(rows[5].text.includes("[call grep"), true);
});

test("dropping a tool result rewrites the assistant message and hides the result", () => {
	const { session, ids } = makeSession();
	const { rows } = buildRows(session);
	const plan = planPrune(rows, { drop: { indices: [2] } });
	applyPlan(session, plan);

	const messages = session.buildSessionProjection().messages;
	assert.equal(messages.length, 7);
	assert.deepEqual(messages[1].content, [{ type: "text", text: "looking at the file" }]);
	assert.equal(messages.some((message) => message.role === "toolResult" && message.toolCallId === "c1"), false);
	// Raw history is untouched.
	assert.equal(session.getEntry(ids.r1).message.toolCallId, "c1");
	assert.equal(session.getBranch().some((entry) => entry.id === ids.r1), true);
});

test("a whitelist keep leaves exactly the named rows in the request", () => {
	const { session } = makeSession();
	const { rows } = buildRows(session);
	const plan = planPrune(rows, { keep: { turns: 1 } });
	applyPlan(session, plan);

	const messages = session.buildSessionProjection().messages;
	assert.deepEqual(messages.map(textOf), ["second request", "searching [call grep]", "needle found here", "final answer"]);
});

test("hidden rows can be listed again and restored", () => {
	const { session } = makeSession();
	const first = buildRows(session).rows;
	applyPlan(session, planPrune(first, { drop: { roles: ["toolResult"] } }));

	const after = buildRows(session).rows;
	assert.deepEqual(
		after.map((row) => row.visible),
		[true, true, false, true, true, true, false, true],
	);
	assert.deepEqual(after[1].toolCalls, []);

	const restore = planPrune(after, { restore: { indices: [2, 6] } });
	applyPlan(session, restore);
	const messages = session.buildSessionProjection().messages;
	assert.equal(messages.length, 8);
	assert.deepEqual(messages[1].content.at(-1), { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } });
	assert.equal(messages.some((message) => message.role === "toolResult" && message.toolCallId === "c2"), true);
});

test("prune records drive undo", () => {
	const { session } = makeSession();
	const before = session.buildSessionProjection().messages.map(textOf);
	const rows = buildRows(session).rows;
	const plan = planPrune(rows, { drop: { roles: ["toolResult"] } });
	const record = pruneRecord(plan, "p-1", "clear tool noise");
	applyDrafts(session, planDrafts(plan, record, "[session-prune] marker"));
	// 8 messages - 2 hidden results + 1 model-visible marker.
	assert.equal(session.buildSessionProjection().messages.length, 7);
	assert.equal(session.buildSessionProjection().messages.at(-1).role, "custom");

	const ledger = readLedger(session.getBranch());
	assert.equal(ledger.prunes.length, 1);
	assert.equal(ledger.prunes[0].data.note, "clear tool noise");
	const target = findPruneToUndo(ledger);
	assert.equal(target.data.opId, "p-1");

	const undoPlan = planPrune(buildRows(session).rows, undoRequest(target.data), { protectLastUser: false });
	applyDrafts(session, planDrafts(undoPlan, undoRecord(target.data, "p-2")));
	const textsAfterUndo = session
		.buildSessionProjection()
		.messages.filter((message) => message.role !== "custom")
		.map(textOf);
	assert.deepEqual(textsAfterUndo, before);
	assert.deepEqual(readLedger(session.getBranch()).undos.map((undo) => undo.data.of), ["p-1"]);
});

test("the running turn is protected when the prune call is visible", () => {
	const { session } = makeSession();
	// The model asks for a prune from inside the last assistant message.
	session.appendMessage({ role: "user", content: "please clean up", timestamp: Date.now() });
	const assistantId = session.appendMessage(
		assistantMessage([{ type: "toolCall", id: "call-prune", name: "session_prune", arguments: {} }]),
	);
	const { rows } = buildRows(session, { toolCallId: "call-prune" });
	const last = rows.at(-1);
	assert.equal(last.entryId, assistantId);
	assert.equal(last.currentTurn, true);
	assert.equal(last.hideProtected, true);

	const plan = planPrune(rows, { keep: { indices: [0] } });
	// Row 0 as asked, the newest user message and the running assistant message are kept.
	assert.deepEqual(plan.keptIndices, [0, 8, 9]);
	assert.equal(plan.decisions.some((decision) => decision.entryId === assistantId), false);
	assert.ok(plan.warnings.some((warning) => warning.includes("last user message")));
	assert.ok(plan.warnings.some((warning) => warning.includes("protected")));
});

test("nested tool call ids are detected", () => {
	assert.equal(isNestedToolCallId("call-1/2"), true);
	assert.equal(isNestedToolCallId("call-1"), false);
	assert.equal(isNestedToolCallId(undefined), false);
});

test("the custom ledger entries do not enter the model context", () => {
	const { session } = makeSession();
	session.appendCustomEntry(CUSTOM_TYPE, { kind: "prune", opId: "x", at: "", targets: [], hidden: 0, kept: 0, editable: 0, freedTokens: 0 });
	const messages = session.buildSessionProjection().messages;
	const rows = buildRows(session).rows;
	assert.equal(messages.length, 8);
	assert.equal(rows.length, 8);
	assert.equal(rows.some((row) => row.role === "custom"), false);
});

test("a nested call protects the running turn even without a user message", () => {
	const session = SessionManager.inMemory("/tmp/session-prune-nested");
	// A run started by pi.sendMessage(..., { triggerTurn: true }): no user message.
	session.appendCustomMessageEntry("test", "injected task", true);
	const assistantId = session.appendMessage(
		assistantMessage([
			{ type: "text", text: "trimming" },
			{ type: "toolCall", id: "parent-call/1", name: "session_prune", arguments: {} },
		]),
	);

	const { rows, warnings } = buildRows(session, { toolCallId: "parent-call/1" });
	const assistantRow = rows.find((row) => row.entryId === assistantId);
	assert.equal(assistantRow.hideProtected, true);
	assert.equal(assistantRow.currentTurn, true);
	assert.equal(rows[0].hideProtected, true, "the injected start of the turn is protected too");

	const plan = planPrune(rows, { keep: { indices: [0] } });
	assert.equal(plan.decisions.some((decision) => decision.entryId === assistantId), false);
	assert.deepEqual(plan.keptIndices, [0, 1]);
	assert.ok(warnings.some((warning) => warning.includes("nested")));
	assert.ok(plan.warnings.some((warning) => warning.includes("protected")));
});

test("protectedOmission refuses unsafe batches instead of patching them", () => {
	const drafts = [
		{
			type: "custom",
			customType: CUSTOM_TYPE,
			data: { kind: "prune", opId: "p-1", at: "", targets: [], hidden: 0, restored: 0, kept: 0, editable: 0, freedTokens: 0 },
		},
		{ type: "context_edit", targetId: "run-assistant", replacement: null },
		{ type: "context_edit", targetId: "run-result", replacement: null },
		{ type: "context_edit", targetId: "old-assistant", replacement: { content: [{ type: "text", text: "x" }] } },
	];

	assert.equal(protectedOmission(drafts, ["run-assistant"]), "run-assistant");
	assert.equal(protectedOmission(drafts, []), undefined);
	assert.equal(protectedOmission(drafts, ["other"]), undefined);
	// Sibling tool results of the running turn may still be pruned.
	assert.equal(protectedOmission(drafts, ["run-result"]), "run-result");
});
