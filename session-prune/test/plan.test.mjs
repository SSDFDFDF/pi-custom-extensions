/**
 * Pure planner tests — no Pi import, plain row objects.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { load } from "./load.mjs";

const { planPrune, selectRows, stripToolCalls } = await load("../src/plan.ts");

let nextId = 0;

function row(partial = {}) {
	const index = partial.index ?? nextId++;
	return {
		index,
		entryId: `entry${String(index).padStart(3, "0")}abcdef`,
		role: "user",
		editable: true,
		visible: true,
		hideProtected: false,
		currentTurn: false,
		tokens: 100,
		text: `message ${index}`,
		...partial,
	};
}

function assistant(index, calls, text) {
	const content = [...(text === undefined ? [] : [{ type: "text", text }]), ...calls.map((call) => ({ type: "toolCall", id: call.id, name: call.name }))];
	return row({
		index,
		role: "assistant",
		toolCalls: calls,
		content,
		rawContent: content,
		text: `${text ?? ""} ${calls.map((call) => `[call ${call.name}]`).join(" ")}`.trim(),
	});
}

function toolResult(index, callId, name = "read") {
	const content = [{ type: "text", text: "tool output" }];
	return row({ index, role: "toolResult", toolCallId: callId, toolName: name, content, rawContent: content, text: `${name}: tool output` });
}

/** user, assistant+read, result, assistant, user, assistant+grep, result, assistant */
function fixture() {
	return [
		row({ index: 0, role: "user", text: "first request" }),
		assistant(1, [{ id: "c1", name: "read" }], "looking at the file"),
		toolResult(2, "c1"),
		assistant(3, [], "done with the first part"),
		row({ index: 4, role: "user", text: "second request" }),
		assistant(5, [{ id: "c2", name: "grep" }], "searching"),
		toolResult(6, "c2", "grep"),
		assistant(7, [], "final answer"),
	];
}

test("whitelist keep hides everything else", () => {
	const rows = fixture();
	const plan = planPrune(rows, { keep: { indices: [4, 7] } });
	const omitted = plan.decisions.filter((decision) => decision.action === "omit").map((decision) => decision.index);
	assert.deepEqual(omitted, [0, 1, 2, 3, 5, 6]);
	assert.equal(plan.visibleAfter, 2);
	assert.deepEqual(plan.keptIndices, [4, 7]);
	assert.equal(plan.tokensBefore, 800);
	assert.equal(plan.tokensAfter, 200);
});

test("whitelist keep protects the newest user message", () => {
	const rows = fixture();
	const plan = planPrune(rows, { keep: { indices: [3] } });
	assert.deepEqual(plan.keptIndices, [3, 4]);
	assert.ok(plan.warnings.some((warning) => warning.includes("last user message")));
});

test("protectLastUser:false lets the whitelist drop it", () => {
	const rows = fixture();
	const plan = planPrune(rows, { keep: { indices: [3] } }, { protectLastUser: false });
	assert.deepEqual(plan.keptIndices, [3]);
});

test("blacklist drop of a tool result strips the call and keeps the assistant text", () => {
	const rows = fixture();
	const plan = planPrune(rows, { drop: { indices: [2] } });
	const byIndex = new Map(plan.decisions.map((decision) => [decision.index, decision]));
	assert.equal(byIndex.get(2)?.action, "omit");
	const replace = byIndex.get(1);
	assert.equal(replace?.action, "replace");
	assert.deepEqual(replace?.content, [{ type: "text", text: "looking at the file" }]);
	assert.equal(plan.visibleAfter, 7);
});

test("dropping every tool result leaves assistant text only", () => {
	const rows = fixture();
	const plan = planPrune(rows, { drop: { roles: ["toolResult"] } });
	assert.deepEqual(
		plan.decisions.map((decision) => `${decision.index}:${decision.action}`).sort(),
		["1:replace", "2:omit", "5:replace", "6:omit"],
	);
});

test("an assistant message that only made calls disappears with them", () => {
	const rows = [assistant(0, [{ id: "c1", name: "read" }]), toolResult(1, "c1")];
	const plan = planPrune(rows, { drop: { indices: [1] } });
	assert.deepEqual(
		plan.decisions.map((decision) => `${decision.index}:${decision.action}`),
		["0:omit", "1:omit"],
	);
});

test("orphan tool results disappear with their assistant message", () => {
	const rows = fixture();
	const plan = planPrune(rows, { drop: { indices: [1] } });
	const omitted = plan.decisions.filter((decision) => decision.action === "omit").map((decision) => decision.index);
	assert.deepEqual(omitted, [1, 2]);
});

test("keep restores a hidden row with its original content", () => {
	const rows = fixture();
	rows[3] = { ...rows[3], visible: false };
	const plan = planPrune(rows, { keep: { indices: [3] } });
	const decision = plan.decisions.find((entry) => entry.index === 3);
	assert.equal(decision?.action, "replace");
	assert.deepEqual(decision?.content, [{ type: "text", text: "done with the first part" }]);
});

test("restore resets content that an earlier prune replaced", () => {
	const rows = fixture();
	const original = [{ type: "text", text: "looking at the file" }, { type: "toolCall", id: "c1", name: "read" }];
	rows[1] = { ...rows[1], content: original.slice(0, 1), text: "looking at the file", toolCalls: [] };
	rows[2] = { ...rows[2], visible: false };
	const plan = planPrune(rows, { restore: { indices: [1, 2] } });
	const indexes = plan.decisions.map((decision) => `${decision.index}:${decision.action}`);
	assert.deepEqual(indexes, ["1:replace", "2:replace"]);
	const restored = plan.decisions[0].content;
	assert.deepEqual(restored, original);
});

test("a protected assistant message is never hidden but loses pruned calls", () => {
	const rows = fixture();
	// The running turn: the assistant message made a sibling call (c2, persisted
	// result) and the prune call (c3, no result entry yet).
	const content = [
		{ type: "text", text: "searching" },
		{ type: "toolCall", id: "c2", name: "grep" },
		{ type: "toolCall", id: "c3", name: "session_prune" },
	];
	rows[5] = { ...rows[5], hideProtected: true, currentTurn: true, content, rawContent: content, toolCalls: [{ id: "c2", name: "grep" }, { id: "c3", name: "session_prune" }] };
	rows[6] = { ...rows[6], currentTurn: true };
	rows[7] = { ...rows[7], currentTurn: true };

	const plan = planPrune(rows, { keep: { indices: [4] } });
	assert.deepEqual(plan.keptIndices, [4, 5]);
	assert.ok(plan.warnings.some((warning) => warning.includes("protected")));

	const replaced = plan.decisions.find((decision) => decision.index === 5);
	assert.equal(replaced?.action, "replace");
	// The sibling call is gone with its result, the prune call stays.
	assert.deepEqual(replaced?.content, [
		{ type: "text", text: "searching" },
		{ type: "toolCall", id: "c3", name: "session_prune" },
	]);
	assert.equal(plan.decisions.some((decision) => decision.index === 6 && decision.action === "omit"), true);
	assert.equal(plan.decisions.some((decision) => decision.index === 7 && decision.action === "omit"), true);
});

test("drop wins over keep", () => {
	const rows = fixture();
	const plan = planPrune(rows, { keep: { indices: [4, 7] }, drop: { indices: [7] } });
	assert.deepEqual(plan.keptIndices, [4]);
});

test("selectors: roles, tools, text, turns, last and ranges", () => {
	const rows = fixture();
	const selected = (selector) => [...selectRows(rows, selector)].sort((a, b) => a - b);

	assert.deepEqual(selected({ roles: ["toolResult"] }), [2, 6]);
	assert.deepEqual(selected({ tools: ["read"] }), [1, 2]);
	assert.deepEqual(selected({ tools: ["grep"] }), [5, 6]);
	assert.deepEqual(selected({ match: "second" }), [4]);
	assert.deepEqual(selected({ turns: 1 }), [4, 5, 6, 7]);
	assert.deepEqual(selected({ lastMessages: 2 }), [6, 7]);
	assert.deepEqual(selected({ range: [2, 4] }), [2, 3, 4]);
	assert.deepEqual(selected({ indices: [-1, -2] }), [6, 7]);
	assert.deepEqual(selected({ range: [-3, -1] }), [5, 6, 7]);
	assert.deepEqual(selected({ beforeIndex: 2 }), [0, 1]);
	assert.deepEqual(selected({ afterIndex: 6 }), [7]);
	assert.deepEqual(selected({ entryIds: ["entry004"] }), [4]);
	// fields AND: assistant rows that called read
	assert.deepEqual(selected({ roles: ["assistant"], tools: ["read"] }), [1]);
});

test("empty and malformed selectors", () => {
	const rows = fixture();
	assert.equal(selectRows(rows, {}).size, 0);
	assert.throws(() => planPrune(rows, { keep: { indices: [] } }), /matched no rows/);
	assert.throws(() => planPrune(rows, { drop: { match: "(" } }), /invalid match regex/);
	assert.throws(() => planPrune(rows, {}), /needs "keep", "restore" or "drop"/);
});

test("no decisions when the request matches the current state", () => {
	const rows = fixture();
	rows[0] = { ...rows[0], visible: false };
	// Hidden and asked to stay hidden (drop wins over restore): nothing to write.
	assert.equal(planPrune(rows, { drop: { indices: [0] }, restore: { indices: [0] } }).decisions.length, 0);
	assert.equal(planPrune(rows, { keep: { indices: [4] } }).decisions.length, 6);
});

test("stripToolCalls keeps unknown blocks", () => {
	const content = [
		{ type: "text", text: "a" },
		{ type: "thinking", thinking: "hmm" },
		{ type: "toolCall", id: "x", name: "read" },
	];
	assert.deepEqual(stripToolCalls(content, new Set(["x"])), [
		{ type: "text", text: "a" },
		{ type: "thinking", thinking: "hmm" },
	]);
});

test("a running turn loses sibling results without orphaning anything", () => {
	// The assistant message being finalized made a sibling call (c1, result row 2)
	// and the prune call (c2, no result yet); only the prune call may survive.
	const rows = [
		row({ index: 0, role: "user" }),
		assistant(1, [{ id: "c1", name: "read" }, { id: "c2", name: "session_prune" }], "trimming"),
		toolResult(2, "c1"),
	];
	rows[1] = { ...rows[1], hideProtected: true, currentTurn: true };
	rows[2] = { ...rows[2], currentTurn: true };

	const plan = planPrune(rows, { keep: { indices: [0] } });
	assert.deepEqual(plan.keptIndices, [0, 1]);
	assert.deepEqual(
		plan.decisions.map((decision) => `${decision.index}:${decision.action}`).sort(),
		["1:replace", "2:omit"],
	);
	const replaced = plan.decisions.find((decision) => decision.index === 1);
	assert.deepEqual(replaced.content, [
		{ type: "text", text: "trimming" },
		{ type: "toolCall", id: "c2", name: "session_prune" },
	]);
});

test("locked rows cannot be selected but are reported", () => {
	const rows = fixture();
	rows[0] = { ...rows[0], role: "compaction", editable: false, rawContent: undefined };
	const plan = planPrune(rows, { drop: { indices: [0] } });
	assert.equal(plan.decisions.length, 0);
	assert.ok(plan.warnings.some((warning) => warning.includes("cannot be edited")));
	assert.deepEqual(plan.keptIndices.filter((index) => index !== 0).length > 0, true);
});
