import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	DEFAULT_CONFIG,
	configPath,
	formatConfigSummary,
	isProviderAllowed,
	loadConfig,
	matchesProviderEntry,
	normalizeConfig,
	resolveSessionHeaderNames,
	saveConfig,
	withHeadersDisabled,
	withPromptCacheKeyDisabled,
} from "../config.ts";

/** Run `fn` with the extension's config file pointed at a fresh temp dir. */
function withTempAgentDir(fn) {
	const dir = mkdtempSync(join(tmpdir(), "prompt-cache-key-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		return fn(dir);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	}
}

test("defaults: headers on with X-Session-ID, prompt_cache_key off", () => {
	const config = normalizeConfig({});
	assert.equal(config.headers.enabled, true);
	assert.deepEqual(config.headers.presets, ["generic"]);
	assert.equal(config.promptCacheKey.enabled, false);
	assert.equal(config.autoDisableOnRejection, true);
	assert.deepEqual(resolveSessionHeaderNames(config.headers.presets, config.headers.names), [
		"X-Session-ID",
	]);
});

test("normalizes presets, names, apis, filters and disabled lists", () => {
	const config = normalizeConfig({
		headers: {
			enabled: false,
			presets: ["generic", "openrouter", "bogus", "generic"],
			names: [" X-Extra ", "", 42],
			apis: ["openai-completions"],
			providers: { allow: ["a*"], deny: ["b", 7] },
		},
		promptCacheKey: { enabled: true, providers: { allow: [], deny: ["c"] } },
		autoDisableOnRejection: false,
		disabled: {
			promptCacheKeyProviders: ["c", "c"],
			headerProviders: { c: ["X-Session-ID", "X-Session-ID"], d: [], "": ["x"] },
		},
	});
	assert.equal(config.headers.enabled, false);
	assert.deepEqual(config.headers.presets, ["generic", "openrouter"]);
	assert.deepEqual(config.headers.names, ["X-Extra"]);
	assert.deepEqual(config.headers.apis, ["openai-completions"]);
	assert.deepEqual(config.headers.providers, { allow: ["a*"], deny: ["b"] });
	assert.equal(config.promptCacheKey.enabled, true);
	assert.deepEqual(config.promptCacheKey.providers, { allow: [], deny: ["c"] });
	assert.equal(config.autoDisableOnRejection, false);
	assert.deepEqual(config.disabled.promptCacheKeyProviders, ["c"]);
	assert.deepEqual(config.disabled.headerProviders, { c: ["x-session-id"] });
});

test("an explicitly empty preset list stays empty", () => {
	assert.deepEqual(normalizeConfig({ headers: { presets: [] } }).headers.presets, []);
});

test("provider matching supports exact, glob and deny-wins", () => {
	assert.equal(matchesProviderEntry("*", "anything"), true);
	assert.equal(matchesProviderEntry("custom-*", "custom-a"), true);
	assert.equal(matchesProviderEntry("custom-*", "other"), false);
	assert.equal(matchesProviderEntry("custom-a", "custom-a"), true);
	assert.equal(matchesProviderEntry("custom-a", "custom-ab"), false);

	assert.equal(isProviderAllowed("p", { allow: [], deny: [] }), true);
	assert.equal(isProviderAllowed("p", { allow: ["p"], deny: [] }), true);
	assert.equal(isProviderAllowed("p", { allow: ["q"], deny: [] }), false);
	// deny wins over allow
	assert.equal(isProviderAllowed("p", { allow: ["*"], deny: ["p"] }), false);
});

test("missing config file falls back to defaults", () => {
	withTempAgentDir(() => {
		const config = loadConfig();
		assert.deepEqual(config, normalizeConfig(DEFAULT_CONFIG));
	});
});

test("save then load round-trips through the config file", () => {
	withTempAgentDir(() => {
		const config = normalizeConfig(DEFAULT_CONFIG);
		config.promptCacheKey.enabled = true;
		config.headers.providers.deny = ["custom-jcp-966112-xyz-nvidia"];
		saveConfig(config);
		const raw = JSON.parse(readFileSync(configPath(), "utf8"));
		assert.equal(raw.promptCacheKey.enabled, true);
		assert.deepEqual(loadConfig(), config);
	});
});

test("disabled entries are added once and never removed by the helpers", () => {
	const config = normalizeConfig({});
	const once = withHeadersDisabled(config, "custom-a", ["X-Session-ID", " x-session-id "]);
	assert.deepEqual(once.disabled.headerProviders, { "custom-a": ["x-session-id"] });
	const twice = withHeadersDisabled(once, "custom-a", ["X-Session-ID"]);
	assert.equal(twice, once);
	assert.notEqual(once, config);
	// Input config is untouched.
	assert.deepEqual(config.disabled.headerProviders, {});

	const keyOnce = withPromptCacheKeyDisabled(config, "custom-a");
	assert.deepEqual(keyOnce.disabled.promptCacheKeyProviders, ["custom-a"]);
	assert.equal(withPromptCacheKeyDisabled(keyOnce, "custom-a"), keyOnce);
	assert.deepEqual(config.disabled.promptCacheKeyProviders, []);
});

test("summary reports the effective state", () => {
	const summary = formatConfigSummary(normalizeConfig(DEFAULT_CONFIG));
	assert.match(summary, /headers: on — X-Session-ID/);
	assert.match(summary, /prompt_cache_key: off/);
	const on = normalizeConfig({ promptCacheKey: { enabled: true } });
	assert.match(formatConfigSummary(on), /prompt_cache_key: on/);
});
