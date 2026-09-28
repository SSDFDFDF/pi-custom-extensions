import assert from "node:assert/strict";
import { test } from "node:test";
import {
	accountRetryableError,
	buildRotationPool,
	modelKey,
	parseModelKey,
	parseModelList,
	pickNextModelKey,
} from "../src/model-rotation.ts";

test("parseModelKey splits provider from id", () => {
	assert.deepEqual(parseModelKey("openai/gpt-4o"), { provider: "openai", id: "gpt-4o" });
	// Id may contain slashes (e.g. openrouter nested ids).
	assert.deepEqual(parseModelKey("openrouter/anthropic/claude-3.5-sonnet"), {
		provider: "openrouter",
		id: "anthropic/claude-3.5-sonnet",
	});
});

test("parseModelKey rejects malformed tokens", () => {
	assert.equal(parseModelKey(""), undefined);
	assert.equal(parseModelKey("noSlash"), undefined);
	assert.equal(parseModelKey("/leadingSlash"), undefined);
	assert.equal(parseModelKey("trailingSlash/"), undefined);
	assert.equal(parseModelKey("  "), undefined);
});

test("modelKey round-trips a ref", () => {
	assert.equal(modelKey({ provider: "openai", id: "gpt-4o" }), "openai/gpt-4o");
});

test("parseModelList accepts commas and whitespace and dedupes", () => {
	assert.deepEqual(parseModelList("openai/gpt-4o, anthropic/claude-3-5-sonnet"), [
		"openai/gpt-4o",
		"anthropic/claude-3-5-sonnet",
	]);
	assert.deepEqual(parseModelList("openai/gpt-4o   x/y\tx/y"), ["openai/gpt-4o", "x/y"]);
	assert.deepEqual(parseModelList("garbage nope openai/gpt-4o"), ["openai/gpt-4o"]);
});

test("buildRotationPool folds active model at the front when included", () => {
	const pool = buildRotationPool(["b/1", "c/2"], "a/0", true);
	assert.deepEqual(pool, ["a/0", "b/1", "c/2"]);
});

test("buildRotationPool skips active model when excluded", () => {
	const pool = buildRotationPool(["b/1", "c/2"], "a/0", false);
	assert.deepEqual(pool, ["b/1", "c/2"]);
});

test("buildRotationPool does not duplicate an active model already in candidates", () => {
	const pool = buildRotationPool(["a/0", "b/1"], "a/0", true);
	assert.deepEqual(pool, ["a/0", "b/1"]);
});

test("buildRotationPool with includeActive=false keeps an active model that is also a candidate", () => {
	// `includeActive` only controls the auto-folded base; a candidate-listed model
	// is still part of the cycle because the user listed it explicitly.
	const pool = buildRotationPool(["a/0", "b/1"], "a/0", false);
	assert.deepEqual(pool, ["a/0", "b/1"]);
});

test("candidate-only cycle (includeActive=false, active not listed) never returns to the used model", () => {
	const pool = buildRotationPool(["b/1", "c/2"], "a/0", false);
	assert.deepEqual(pool, ["b/1", "c/2"]);
	// From the used model a/0 (not in pool) we cycle b/1 -> c/2 -> b/1, never a/0.
	assert.equal(pickNextModelKey(pool, "a/0", () => true), "b/1");
	assert.equal(pickNextModelKey(pool, "b/1", () => true), "c/2");
	assert.equal(pickNextModelKey(pool, "c/2", () => true), "b/1");
});

test("accountRetryableError increments until threshold then signals switch", () => {
	assert.deepEqual(accountRetryableError(0, 3), { shouldSwitch: false, nextStreak: 1 });
	assert.deepEqual(accountRetryableError(1, 3), { shouldSwitch: false, nextStreak: 2 });
	assert.deepEqual(accountRetryableError(2, 3), { shouldSwitch: true, nextStreak: 0 });
});

test("accountRetryableError with switchAfter=0 never switches", () => {
	assert.deepEqual(accountRetryableError(5, 0), { shouldSwitch: false, nextStreak: 6 });
});

test("accountRetryableError with switchAfter=1 switches every error", () => {
	assert.deepEqual(accountRetryableError(0, 1), { shouldSwitch: true, nextStreak: 0 });
});

test("pickNextModelKey cycles forward from the current model", () => {
	const pool = ["a/0", "b/1", "c/2"];
	const usable = () => true;
	assert.equal(pickNextModelKey(pool, "a/0", usable), "b/1");
	assert.equal(pickNextModelKey(pool, "b/1", usable), "c/2");
	// Wraps around back to the front.
	assert.equal(pickNextModelKey(pool, "c/2", usable), "a/0");
});

test("pickNextModelKey starts at the front when current is not in pool", () => {
	const pool = ["a/0", "b/1"];
	assert.equal(pickNextModelKey(pool, "z/9", () => true), "a/0");
});

test("pickNextModelKey skips unusable models", () => {
	const pool = ["a/0", "b/1", "c/2"];
	// b/1 has no auth, so from a/0 we skip to c/2.
	const usable = (k: string) => k !== "b/1";
	assert.equal(pickNextModelKey(pool, "a/0", usable), "c/2");
});

test("pickNextModelKey returns undefined when nothing else is usable", () => {
	const pool = ["a/0", "b/1"];
	// Only the current model is usable.
	const usable = (k: string) => k === "a/0";
	assert.equal(pickNextModelKey(pool, "a/0", usable), undefined);
});

test("pickNextModelKey returns undefined for an empty pool", () => {
	assert.equal(pickNextModelKey([], "a/0", () => true), undefined);
});

test("pickNextModelKey handles a single-model pool with no alternative", () => {
	assert.equal(pickNextModelKey(["a/0"], "a/0", () => true), undefined);
});
