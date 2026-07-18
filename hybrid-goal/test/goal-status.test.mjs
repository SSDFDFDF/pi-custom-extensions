import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const statusSrc = readFileSync(join(root, "src/goal-status.ts"), "utf8");
const typesSrc = readFileSync(join(root, "src/goal-types.ts"), "utf8");

test("status uses ◍ space goal and can show defer:ctx", () => {
	assert.match(statusSrc, /"◍"/);
	assert.match(statusSrc, /"goal"/);
	assert.match(statusSrc, /defer:ctx/);
});

test("notifyGoal drops info noise", () => {
	assert.match(typesSrc, /export function notifyGoal/);
	assert.match(typesSrc, /if \(level === "info"\) return;/);
});
