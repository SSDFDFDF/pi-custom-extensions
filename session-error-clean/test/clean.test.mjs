import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	cleanSessionFile,
	findSessionFiles,
	isErrorEntry,
	parseSessionText,
	planClean,
	serializeEntries,
	verifyParentChain,
} from "../src/clean.ts";

function headerLine(id = "sess-1") {
	return JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-14T00:00:00.000Z", cwd: "/tmp" });
}

function userEntry(id, parentId, text) {
	return { type: "message", id, parentId, timestamp: "2026-09-14T00:01:00.000Z", message: { role: "user", content: [{ type: "text", text }], timestamp: 0 } };
}

function errorEntry(id, parentId, errorMessage) {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-09-14T00:02:00.000Z",
		message: {
			role: "assistant",
			content: [],
			provider: "any-claude",
			model: "claude-opus-5",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
			stopReason: "error",
			errorMessage,
			timestamp: 0,
		},
	};
}

function okAssistantEntry(id, parentId) {
	return { type: "message", id, parentId, timestamp: "2026-09-14T00:03:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", timestamp: 0 } };
}

function modelChangeEntry(id, parentId) {
	return { type: "model_change", id, parentId, timestamp: "2026-09-14T00:04:00.000Z", provider: "p", modelId: "m" };
}

const FIFTY_THREE = '503 {"error":{"message":"Service Unavailable","type":"error"},"type":"error"}\n\n[kun-retry-nl] provider returned error; treating no-limit mode (any error) as retryable.';

test("isErrorEntry matches only assistant error messages", () => {
	assert.equal(isErrorEntry(errorEntry("e1", null, FIFTY_THREE), {}), true);
	assert.equal(isErrorEntry(userEntry("u1", null, "hi"), {}), false);
	assert.equal(isErrorEntry(okAssistantEntry("a1", null), {}), false);
	// pattern filter: 503 matches, other errors do not
	assert.equal(isErrorEntry(errorEntry("e2", null, FIFTY_THREE), { pattern: /503/i }), true);
	assert.equal(isErrorEntry(errorEntry("e3", null, "quota exceeded"), { pattern: /503/i }), false);
	assert.equal(isErrorEntry({ __raw: "not json" }, {}), false);
});

test("planClean removes error entries and relinks children through chains", () => {
	const entries = [
		JSON.parse(headerLine()),
		userEntry("u1", null, "hi"),
		errorEntry("e1", "u1", FIFTY_THREE),
		errorEntry("e2", "e1", FIFTY_THREE),
		modelChangeEntry("m1", "e2"),
		errorEntry("e3", "m1", FIFTY_THREE),
		okAssistantEntry("a1", "e3"),
	];
	const plan = planClean(entries);
	assert.deepEqual(plan.removed.map((r) => r.id), ["e1", "e2", "e3"]);
	assert.equal(plan.kept.length, 4);
	const byId = new Map(plan.kept.filter((e) => e.id).map((e) => [e.id, e]));
	assert.equal(byId.get("m1").parentId, "u1", "model_change after two errors relinks to user");
	assert.equal(byId.get("a1").parentId, "m1", "assistant after error relinks through model_change");
	assert.equal(plan.relinked, 2);
	const chain = verifyParentChain(plan.kept);
	assert.equal(chain.ok, true, JSON.stringify(chain));
	// header and user entry untouched
	assert.equal(plan.kept[0].type, "session");
	assert.equal(plan.kept[1].id, "u1");
	assert.equal(plan.kept[1].parentId, null);
});

test("planClean honors pattern filter", () => {
	const entries = [
		JSON.parse(headerLine()),
		userEntry("u1", null, "hi"),
		errorEntry("e1", "u1", FIFTY_THREE),
		errorEntry("e2", "e1", "quota exceeded"),
		okAssistantEntry("a1", "e2"),
	];
	const plan = planClean(entries, { pattern: /503/i });
	assert.deepEqual(plan.removed.map((r) => r.id), ["e1"]);
	const byId = new Map(plan.kept.filter((e) => e.id).map((e) => [e.id, e]));
	assert.equal(byId.get("e2").parentId, "u1");
	assert.equal(byId.get("a1").parentId, "e2");
});

test("planClean keeps error entries without an id (not addressable)", () => {
	const noId = errorEntry(undefined, null, FIFTY_THREE);
	delete noId.id;
	const plan = planClean([JSON.parse(headerLine()), noId]);
	assert.equal(plan.removed.length, 0);
	assert.equal(plan.kept.length, 2);
});

test("parse/serialize preserve unparseable lines verbatim", () => {
	const text = `${headerLine()}\nnot-json-garbage\n${JSON.stringify(userEntry("u1", null, "hi"))}\n`;
	const entries = parseSessionText(text);
	assert.equal(entries.length, 3);
	assert.equal(entries[1].__raw, "not-json-garbage");
	const out = serializeEntries(entries);
	assert.ok(out.includes("not-json-garbage"));
	assert.ok(out.endsWith("\n"));
	assert.deepEqual(JSON.parse(out.split("\n")[2]), userEntry("u1", null, "hi"));
});

test("cleanSessionFile dry run does not write", () => {
	const dir = mkdtempSync(join(tmpdir(), "sec-dry-"));
	const file = join(dir, "s.jsonl");
	writeFileSync(file, `${headerLine()}\n${JSON.stringify(errorEntry("e1", null, FIFTY_THREE))}\n`);
	const before = readFileSync(file, "utf8");
	const result = cleanSessionFile(file, {}, { dryRun: true });
	assert.equal(result.rewritten, false);
	assert.equal(result.plan.removed.length, 1);
	assert.equal(readFileSync(file, "utf8"), before);
});

test("cleanSessionFile rewrites atomically with optional backup", () => {
	const dir = mkdtempSync(join(tmpdir(), "sec-rw-"));
	const file = join(dir, "2026-09-14T00-34-27-902Z_01a09d56-35be-773d-a644-6d7f5dbc1d38.jsonl");
	writeFileSync(
		file,
		[
			headerLine(),
			JSON.stringify(userEntry("u1", null, "hi")),
			JSON.stringify(errorEntry("e1", "u1", FIFTY_THREE)),
			JSON.stringify(errorEntry("e2", "e1", FIFTY_THREE)),
			JSON.stringify(modelChangeEntry("m1", "e2")),
			JSON.stringify(errorEntry("e3", "m1", FIFTY_THREE)),
			JSON.stringify(okAssistantEntry("a1", "e3")),
			"",
		].join("\n"),
	);
	const result = cleanSessionFile(file, {}, { backup: true });
	assert.equal(result.rewritten, true);
	assert.equal(result.plan.removed.length, 3);
	assert.ok(result.backupFile.endsWith(".jsonl.bak"));
	assert.ok(result.bytesAfter < result.bytesBefore);

	// The rewritten file is a valid linear chain: walk parents from last line to root.
	const kept = parseSessionText(readFileSync(file, "utf8"));
	const chain = verifyParentChain(kept);
	assert.equal(chain.ok, true);
	const byId = new Map(kept.filter((e) => e.id).map((e) => [e.id, e]));
	let cur = kept[kept.length - 1];
	const path = [];
	while (cur && cur.parentId !== undefined && cur.parentId !== null) {
		path.push(cur.id ?? cur.type);
		cur = cur.parentId ? byId.get(cur.parentId) : null;
	}
	assert.equal(cur?.id, "u1", "walk terminates at the root user entry (parentId=null)");
	assert.deepEqual(path.reverse(), ["m1", "a1"]);

	// Backup content equals the original.
	assert.ok(readFileSync(result.backupFile, "utf8").includes('"errorMessage"'));
	// No temp files left behind.
	assert.deepEqual(readdirSync(dir).sort(), ["2026-09-14T00-34-27-902Z_01a09d56-35be-773d-a644-6d7f5dbc1d38.jsonl", "2026-09-14T00-34-27-902Z_01a09d56-35be-773d-a644-6d7f5dbc1d38.jsonl.bak"]);
});

test("cleanSessionFile is a no-op when nothing matches", () => {
	const dir = mkdtempSync(join(tmpdir(), "sec-clean-"));
	const file = join(dir, "s.jsonl");
	const text = `${headerLine()}\n${JSON.stringify(okAssistantEntry("a1", null))}\n`;
	writeFileSync(file, text);
	const result = cleanSessionFile(file, {});
	assert.equal(result.rewritten, false);
	assert.equal(result.plan.removed.length, 0);
	assert.equal(readFileSync(file, "utf8"), text);
});

test("cleanSessionFile refuses files without a session header", () => {
	const dir = mkdtempSync(join(tmpdir(), "sec-foreign-"));
	const file = join(dir, "notes.jsonl");
	writeFileSync(file, `{"hello":"world"}\n`);
	assert.throws(() => cleanSessionFile(file, {}), /not a pi session file/);
});

test("findSessionFiles prefers exact _<id>.jsonl matches over partials", () => {
	const dir = mkdtempSync(join(tmpdir(), "sec-find-"));
	const sub = join(dir, "--home-xjc--");
	mkdirSync(sub, { recursive: true });
	writeFileSync(join(sub, "2026-09-14T00-34-27-902Z_01a09d56-35be-773d-a644-6d7f5dbc1d38.jsonl"), "");
	writeFileSync(join(sub, "2026-09-13T10-00-00-000Z_01a09d56-aaaa-bbbb-cccc-dddddddddddd.jsonl"), "");
	writeFileSync(join(sub, "2026-09-13T11-00-00-000Z_deadbeef-0000.jsonl"), "");
	const exact = findSessionFiles(dir, "01a09d56-35be-773d-a644-6d7f5dbc1d38");
	assert.equal(exact.length, 1);
	assert.ok(exact[0].includes("773d-a644-6d7f5dbc1d38"));
	const partial = findSessionFiles(dir, "01a09d56");
	assert.equal(partial.length, 2);
	assert.deepEqual(findSessionFiles(dir, "nope"), []);
});

test("cleanSessionFile with cleanReasoning strips thinkingSignature, empty thinking blocks, textSignature, and fc_* suffixes", () => {
	const dir = mkdtempSync(join(tmpdir(), "sec-reasoning-"));
	const file = join(dir, "r.jsonl");
	const assistantWithReasoning = {
		type: "message",
		id: "a1",
		parentId: "u1",
		timestamp: "2026-09-29T00:02:00.000Z",
		message: {
			role: "assistant",
			responseId: "resp_old_123",
			content: [
				{
					type: "thinking",
					thinking: "",
					thinkingSignature: JSON.stringify({ id: "rs_old_0", type: "reasoning", encrypted_content: "cipher0" }),
				},
				{
					type: "thinking",
					thinking: "human readable summary",
					thinkingSignature: JSON.stringify({ id: "rs_old_1", type: "reasoning", encrypted_content: "cipher" }),
				},
				{
					type: "text",
					text: "hello",
					textSignature: JSON.stringify({ v: 1, id: "msg_old_1", phase: "commentary" }),
				},
				{
					type: "toolCall",
					id: "call_abc|fc_old_1",
					name: "bash",
					arguments: { command: "ls" },
				},
			],
			stopReason: "toolUse",
			timestamp: 0,
		},
	};
	const toolRes = {
		type: "message",
		id: "tr1",
		parentId: "a1",
		timestamp: "2026-09-29T00:03:00.000Z",
		message: {
			role: "toolResult",
			toolCallId: "call_abc|fc_old_1",
			toolName: "bash",
			content: [{ type: "text", text: "ok" }],
			timestamp: 0,
		},
	};
	writeFileSync(
		file,
		[headerLine(), JSON.stringify(userEntry("u1", null, "hi")), JSON.stringify(assistantWithReasoning), JSON.stringify(toolRes), ""].join("\n"),
	);

	const result = cleanSessionFile(file, { cleanErrors: false, cleanReasoning: true }, { backup: true });
	assert.equal(result.rewritten, true);
	assert.equal(result.plan.reasoningCleaned, 2);
	assert.equal(result.plan.signaturesRemoved, 4); // responseId + 2 thinkingSignatures + textSignature
	assert.equal(result.plan.itemIdsRemoved, 2); // toolCall.id + toolResult.toolCallId

	const parsed = parseSessionText(readFileSync(file, "utf8"));
	const cleanedAsst = parsed[2].message;
	assert.equal("responseId" in cleanedAsst, false);
	assert.equal(cleanedAsst.content.length, 3); // empty thinking block removed
	assert.equal(cleanedAsst.content[0].thinking, "human readable summary");
	assert.equal("thinkingSignature" in cleanedAsst.content[0], false);
	assert.equal("textSignature" in cleanedAsst.content[1], false);
	assert.equal(cleanedAsst.content[2].id, "call_abc");
	assert.equal(parsed[3].message.toolCallId, "call_abc");
});
