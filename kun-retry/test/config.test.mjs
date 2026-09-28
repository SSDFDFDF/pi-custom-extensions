import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DEFAULT_CONFIG, loadConfig, normalizeConfig, saveConfig } from "../src/config.ts";

test("rotation behavior defaults", () => {
	// Only these two rotation fields are persisted; the candidate list is
	// session-scoped and must NOT live in config.
	assert.equal(DEFAULT_CONFIG.switchAfterErrors, 3);
	assert.equal(DEFAULT_CONFIG.includeActiveInRotation, true);
	assert.equal("candidateModels" in DEFAULT_CONFIG, false);
	assert.equal("modelRotation" in DEFAULT_CONFIG, false);
});

test("switchAfterErrors clamps to [0, 1000] and falls back on garbage", () => {
	assert.equal(normalizeConfig({ switchAfterErrors: 0 }).switchAfterErrors, 0);
	assert.equal(normalizeConfig({ switchAfterErrors: 5 }).switchAfterErrors, 5);
	assert.equal(normalizeConfig({ switchAfterErrors: 99999 }).switchAfterErrors, 1000);
	assert.equal(normalizeConfig({ switchAfterErrors: -1 }).switchAfterErrors, DEFAULT_CONFIG.switchAfterErrors);
	assert.equal(normalizeConfig({ switchAfterErrors: "x" }).switchAfterErrors, DEFAULT_CONFIG.switchAfterErrors);
});

test("includeActiveInRotation defaults true, honors false", () => {
	assert.equal(normalizeConfig({}).includeActiveInRotation, true);
	assert.equal(normalizeConfig({ includeActiveInRotation: false }).includeActiveInRotation, false);
});

test("rotationThinkingLevel defaults to max and validates input", () => {
	assert.equal(DEFAULT_CONFIG.rotationThinkingLevel, "max");
	assert.equal(normalizeConfig({}).rotationThinkingLevel, "max");
	assert.equal(normalizeConfig({ rotationThinkingLevel: "inherit" }).rotationThinkingLevel, "inherit");
	assert.equal(normalizeConfig({ rotationThinkingLevel: "high" }).rotationThinkingLevel, "high");
	// Unknown level falls back to the default.
	assert.equal(
		normalizeConfig({ rotationThinkingLevel: "ultra" as never }).rotationThinkingLevel,
		"max",
	);
});

test("unknown/legacy keys are dropped from the normalized config", () => {
	// Older configs may still carry modelRotation/candidateModels; normalization
	// must ignore them instead of echoing them back.
	const c = normalizeConfig({
		modelRotation: true,
		candidateModels: ["openai/gpt-4o"],
	} as unknown as Parameters<typeof normalizeConfig>[0]);
	assert.equal("modelRotation" in c, false);
	assert.equal("candidateModels" in c, false);
});

test("saveConfig round-trips the persisted rotation fields through loadConfig", () => {
	const dir = mkdtempSync(join(tmpdir(), "kun-retry-cfg-"));
	const prev = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		saveConfig({ switchAfterErrors: 2, includeActiveInRotation: false, rotationThinkingLevel: "inherit" });
		const reloaded = loadConfig();
		assert.equal(reloaded.switchAfterErrors, 2);
		assert.equal(reloaded.includeActiveInRotation, false);
		assert.equal(reloaded.rotationThinkingLevel, "inherit");

		// The file must not contain a candidate list.
		const raw = JSON.parse(readFileSync(join(dir, "kun-retry.config.json"), "utf8")) as Record<string, unknown>;
		assert.equal("candidateModels" in raw, false);
		assert.equal("modelRotation" in raw, false);
	} finally {
		if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prev;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("legacy candidate fields written to disk are ignored on load", () => {
	const dir = mkdtempSync(join(tmpdir(), "kun-retry-cfg-"));
	const prev = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		saveConfig({ switchAfterErrors: 4 });
		const path = join(dir, "kun-retry.config.json");
		const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		raw.candidateModels = ["openai/gpt-4o"];
		raw.modelRotation = true;
		writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
		const loaded = loadConfig();
		assert.equal(loaded.switchAfterErrors, 4);
		assert.equal("candidateModels" in loaded, false);
		assert.equal("modelRotation" in loaded, false);
	} finally {
		if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prev;
		rmSync(dir, { recursive: true, force: true });
	}
});
