import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Lightweight structural check only (runtime import needs strip-types + js→ts resolve).
// Behavior of continue vs system rules is covered by product use; harness covers lifecycle.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const prompts = readFileSync(join(root, "src/prompts.ts"), "utf8");

test("continue prompt builder stays short (no full Goal-mode rules re-embed)", () => {
	const start = prompts.indexOf("export function buildContinuePrompt");
	const end = prompts.indexOf("function goalContextBlock", start);
	assert.ok(start >= 0 && end > start);
	const body = prompts.slice(start, end);
	assert.ok(!body.includes("goalModeRules("));
	assert.match(body, /Keep continuation short|continuationMarkerComment/);
});
