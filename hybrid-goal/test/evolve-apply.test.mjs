import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "src/evolve.ts"), "utf8");

test("evolution mapping applies only accounting helper, not hybrid runtime", () => {
	const mapMatch = source.match(/const PI_GOAL_SRC_MAP:[\s\S]*?= \[([\s\S]*?)\n\];/);
	assert.ok(mapMatch, "PI_GOAL_SRC_MAP must exist");
	const mapBody = mapMatch[1];

	assert.doesNotMatch(
		mapBody,
		/local: "src\/goal-base\.ts"/,
		"dead goal-base snapshot must not be an apply target",
	);
	assert.doesNotMatch(
		mapBody,
		/local: "src\/goal\.ts"/,
		"hybrid live goal runtime must not be overwritten by apply",
	);
	assert.doesNotMatch(
		mapBody,
		/local: "src\/prompts\.ts"/,
		"hybrid prompts must not be overwritten by upstream apply",
	);
	assert.match(mapBody, /local: "src\/accounting\.ts"/);
	assert.doesNotMatch(
		mapBody,
		/local: "src\/command\.ts"/,
		"hybrid single-goal command.ts must not be auto-applied from upstream",
	);
	assert.doesNotMatch(
		mapBody,
		/local: "src\/persistence\.ts"/,
		"hybrid single-goal persistence.ts must not be auto-applied from upstream",
	);

	assert.match(
		source,
		/const PI_GOAL_REVIEW_ONLY/,
		"upstream modular runtime must be review-only cached, not applied",
	);

	const protectedMatch = source.match(/const hybridOnly = new Set\(\[([\s\S]*?)\n\t\]\);/);
	assert.ok(protectedMatch, "hybridOnly protection set must exist");
	assert.match(protectedMatch[1], /"src\/goal\.ts"/);
	assert.match(protectedMatch[1], /"src\/command\.ts"/);
	assert.match(protectedMatch[1], /"src\/persistence\.ts"/);
	assert.match(protectedMatch[1], /"src\/prompts\.ts"/);
	assert.match(protectedMatch[1], /"src\/judge\.ts"/);

	assert.doesNotMatch(
		source,
		/Also refresh goal-base\.ts alias/,
		"a second goal-base copy path must not return",
	);

	assert.match(source, /function verifyAppliedBase/, "apply must post-verify with package tests");
	assert.match(
		source,
		/Apply rolled back after post-verify failed/,
		"failed post-verify must roll applied files back",
	);
	assert.match(source, /pruneEvolCache/, "check/apply must prune evol cache bounds");

	assert.equal(
		existsSync(join(root, "src/goal-base.ts")),
		false,
		"src/goal-base.ts must not exist in the live package",
	);
});
