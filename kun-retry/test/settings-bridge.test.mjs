import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { DEFAULT_MAX_AGENT_DELAY_MS, effectiveMaxAgentDelayMs } from "../src/settings-bridge.ts";

/**
 * Pure-function tests for the retry-delay cap helper. The file-writing path is
 * exercised indirectly by `/retry sync` and by startup, and is intentionally not
 * run here so a test never mutates the user's real settings.json.
 */

test("constant mode off leaves the cap untouched", () => {
	const cfg = { ...DEFAULT_CONFIG, constantDelayMs: 0 };
	assert.equal(effectiveMaxAgentDelayMs(cfg, undefined), undefined, "do not invent a cap");
	assert.equal(effectiveMaxAgentDelayMs(cfg, 30_000), 30_000, "preserve a user value");
});

test("a constant interval above the default cap raises maxAgentDelayMs", () => {
	const cfg = { ...DEFAULT_CONFIG, constantDelayMs: 90_000 };
	assert.equal(effectiveMaxAgentDelayMs(cfg, undefined), 90_000, "raises past Pi's 60s default");
	assert.equal(effectiveMaxAgentDelayMs(cfg, 300_000), 300_000, "keeps a larger existing cap");
});

test("a constant interval under the cap does not lower it", () => {
	const cfg = { ...DEFAULT_CONFIG, constantDelayMs: 5_000 };
	assert.equal(effectiveMaxAgentDelayMs(cfg, undefined), DEFAULT_MAX_AGENT_DELAY_MS, "default cap stays");
	assert.equal(effectiveMaxAgentDelayMs(cfg, 120_000), 120_000, "never shrinks a user cap");
});

test("an invalid existing cap falls back to Pi's default", () => {
	const cfg = { ...DEFAULT_CONFIG, constantDelayMs: 90_000 };
	assert.equal(effectiveMaxAgentDelayMs(cfg, Number.NaN), 90_000);
	// A non-number (hand-edited settings.json) must not poison the comparison.
	assert.equal(effectiveMaxAgentDelayMs(cfg, "120000"), 90_000);
});