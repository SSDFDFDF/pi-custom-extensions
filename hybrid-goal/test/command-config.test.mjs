import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const commandUrl = pathToFileURL(join(root, "src/command.ts")).href;
const { parseCommand, parseTokenBudget, validateObjective, completeGoalArguments } =
	await import(commandUrl);

test("parseCommand start/show/pause", () => {
	assert.deepEqual(parseCommand(""), { kind: "show" });
	assert.deepEqual(parseCommand("pause"), { kind: "pause" });
	assert.equal(typeof parseCommand("implement snake"), "object");
	assert.equal(parseCommand("implement snake").kind, "start");
	assert.equal(parseCommand("implement snake").objective, "implement snake");
});

test("parseTokenBudget", () => {
	assert.equal(parseTokenBudget("100k"), 100_000);
	assert.equal(parseTokenBudget("1.5m"), 1_500_000);
	assert.equal(parseTokenBudget("bad"), undefined);
});

test("validateObjective length", () => {
	assert.equal(validateObjective("x"), undefined);
	assert.match(validateObjective("x".repeat(5000)) ?? "", /too long/);
});

test("completeGoalArguments", () => {
	const all = completeGoalArguments("");
	assert.ok(all?.some((x) => x.value === "pause"));
});
