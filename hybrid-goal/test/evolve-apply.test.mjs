import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "src/evolve.ts"), "utf8");

test("evolution mapping preserves hybrid prompts and maps goal-base once", () => {
	const mapMatch = source.match(
		/const PI_GOAL_SRC_MAP:[\s\S]*?= \[([\s\S]*?)\n\];/,
	);
	assert.ok(mapMatch, "PI_GOAL_SRC_MAP must exist");
	const mapBody = mapMatch[1];

	assert.equal(
		(mapBody.match(/extensions\/pi-goal\/src\/goal\.ts/g) ?? []).length,
		1,
		"goal.ts must map to goal-base exactly once",
	);
	assert.match(mapBody, /local: "src\/goal-base\.ts"/);
	assert.doesNotMatch(
		mapBody,
		/local: "src\/prompts\.ts"/,
		"hybrid prompts must not be overwritten by upstream apply",
	);

	const protectedMatch = source.match(
		/const hybridOnly = new Set\(\[([\s\S]*?)\n\t\]\);/,
	);
	assert.ok(protectedMatch, "hybridOnly protection set must exist");
	assert.match(protectedMatch[1], /"src\/prompts\.ts"/);

	assert.doesNotMatch(
		source,
		/Also refresh goal-base\.ts alias/,
		"a second goal-base copy path must not return",
	);

	assert.match(
		source,
		/function verifyAppliedBase/,
		"apply must post-verify with package tests",
	);
	assert.match(
		source,
		/Apply rolled back after post-verify failed/,
		"failed post-verify must roll base modules back",
	);
	assert.match(
		source,
		/pruneEvolCache/,
		"check/apply must prune evol cache bounds",
	);
});
