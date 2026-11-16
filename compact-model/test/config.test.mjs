import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { load } from "./load.mjs";

const {
	DEFAULT_CONFIG,
	normalizeConfig,
	loadConfig,
	saveConfig,
	isConfigured,
	formatConfigSummary,
	configPath,
} = await load("../src/config.ts");

let tmpAgentDir;

beforeEach(() => {
	tmpAgentDir = mkdtempSync(join(tmpdir(), "compact-model-test-"));
	process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
});

afterEach(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	rmSync(tmpAgentDir, { recursive: true, force: true });
});

test("DEFAULT_CONFIG 内容", () => {
	assert.deepEqual(DEFAULT_CONFIG, {
		enabled: false,
		provider: "",
		model: "",
		thinkingLevel: "off",
		fallbackToDefault: true,
		followClientMimic: true,
	});
});

test("normalizeConfig: 非法字段回退默认", () => {
	assert.deepEqual(
		normalizeConfig({
			enabled: "yes",
			provider: 42,
			model: " deepseek-flash ",
			thinkingLevel: "max",
			fallbackToDefault: 0,
		}),
		{
			enabled: false, // 非布尔回退默认
			provider: "", // 非字符串回退空
			model: "deepseek-flash", // 字符串 trim
			thinkingLevel: "off", // 乱值回退 off
			fallbackToDefault: true, // 非布尔回退默认
			followClientMimic: true, // 缺省 → 默认 true（跟随 client-mimic）
		},
	);
});

test("normalizeConfig: 合法输入保留", () => {
	assert.deepEqual(
		normalizeConfig({
			enabled: true,
			provider: " deepseek ",
			model: "v4.1-flash",
			thinkingLevel: "inherit",
			fallbackToDefault: false,
			followClientMimic: false,
		}),
		{
			enabled: true,
			provider: "deepseek",
			model: "v4.1-flash",
			thinkingLevel: "inherit",
			fallbackToDefault: false,
			followClientMimic: false,
		},
	);
});

test("loadConfig: 无文件 → 默认值（首次不落盘，由 saveConfig/命令首次写入）", () => {
	const cfg = loadConfig();
	assert.deepEqual(cfg, DEFAULT_CONFIG);
});

test("loadConfig: 损坏 JSON → 默认值", () => {
	writeFileSync(configPath(), "{ this is not json");
	const cfg = loadConfig();
	assert.deepEqual(cfg, DEFAULT_CONFIG);
});

test("saveConfig + loadConfig roundtrip（含原子写：不留 .tmp）", () => {
	const saved = saveConfig({ enabled: true, provider: "p", model: "m", thinkingLevel: "inherit" });
	assert.equal(saved.enabled, true);
	assert.equal(saved.provider, "p");
	assert.equal(saved.model, "m");
	assert.equal(saved.thinkingLevel, "inherit");

	const reread = loadConfig();
	assert.deepEqual(reread, saved);

	const raw = JSON.parse(readFileSync(configPath(), "utf8"));
	assert.equal(raw.enabled, true);
	assert.ok(!existsSync(join(tmpAgentDir, "compact-model.config.json.tmp")), "不应残留 .tmp 文件");
});

test("saveConfig 是 merge 语义而非整体替换", () => {
	saveConfig({ provider: "a", model: "b", enabled: true });
	const next = saveConfig({ model: "c" });
	assert.equal(next.provider, "a");
	assert.equal(next.model, "c");
	assert.equal(next.enabled, true);
});

test("isConfigured: enabled 与 provider/model 缺一不可", () => {
	assert.equal(isConfigured(normalizeConfig({})), false);
	assert.equal(isConfigured(normalizeConfig({ enabled: true })), false);
	assert.equal(isConfigured(normalizeConfig({ enabled: true, provider: "p" })), false);
	assert.equal(isConfigured(normalizeConfig({ enabled: true, provider: "p", model: "m" })), true);
	assert.equal(isConfigured(normalizeConfig({ provider: "p", model: "m" })), false);
});

test("formatConfigSummary 包含各字段", () => {
	const text = formatConfigSummary(normalizeConfig({ enabled: true, provider: "p", model: "m" }));
	assert.ok(text.includes("enabled: true"));
	assert.ok(text.includes("p/m"));
	assert.ok(text.includes("thinkingLevel: off"));
	assert.ok(text.includes("fallbackToDefault: true"));
	assert.ok(text.includes("followClientMimic: true"));
});
