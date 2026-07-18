import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG, normalizeConfig } from "../src/config.ts";

test("normalizeConfig continueDeferContextPercent defaults and clamps", () => {
	assert.equal(normalizeConfig({}).continueDeferContextPercent, 95);
	assert.equal(normalizeConfig({ continueDeferContextPercent: 0 }).continueDeferContextPercent, 0);
	assert.equal(
		normalizeConfig({ continueDeferContextPercent: 120 }).continueDeferContextPercent,
		100,
	);
	assert.equal(
		normalizeConfig({ continueDeferContextPercent: -3 }).continueDeferContextPercent,
		0,
	);
});

test("normalizeConfig preserves other defaults", () => {
	const c = normalizeConfig({});
	assert.equal(c.judgeEnabled, DEFAULT_CONFIG.judgeEnabled);
	assert.equal(c.maxContinuations, 0);
	assert.equal(c.neverBlock, false);
	assert.equal(c.continueDeferContextPercent, DEFAULT_CONFIG.continueDeferContextPercent);
});
