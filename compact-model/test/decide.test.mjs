import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { load } from "./load.mjs";

const { handleBeforeCompact, carryOverFileOps, readRetrySettings } = await load("../src/decide.ts");
const { normalizeConfig } = await load("../src/config.ts");

const neverAbort = new AbortController().signal;
const abortedSignal = AbortController.abort ? AbortController.abort(new Error("user cancelled")) : (() => { const c = new AbortController(); c.abort(); return c.signal; })();

const basePreparation = () => ({
	firstKeptEntryId: "entry-42",
	tokensBefore: 12345,
	fileOps: { read: new Set(["a.ts"]), edited: new Set(["b.ts"]) },
});

const compactStub = (impl) => {
	const calls = [];
	const fn = async (args) => {
		calls.push(args);
		if (impl) return impl(args);
		return { summary: "s", firstKeptEntryId: "entry-42", tokensBefore: 12345 };
	};
	fn.calls = calls;
	return fn;
};

const run = (overrides = {}) => {
	const params = {
		cfg: normalizeConfig({ enabled: true, provider: "p", model: "m" }),
		modelResolution: {
			model: { id: "m", provider: "p", reasoning: false },
			hasAuth: true,
			auth: { ok: true, apiKey: "sk-x", headers: { "X-T": "1" }, baseUrl: "https://gw.example/v1", env: { FOO: "1" } },
		},
		compactFn: compactStub(),
		preparation: basePreparation(),
		branchEntries: [],
		customInstructions: "保留 XX 细节",
		signal: neverAbort,
		thinkingLevel: "off",
		retry: { enabled: true, maxRetries: 5 },
		...overrides,
	};
	return { params, promise: handleBeforeCompact(params) };
};

// ── carryOverFileOps ────────────────────────────────────────────────────

test("carryOverFileOps: 只继承最近一次 compaction,且 fromHook 也继承", () => {
	const fileOps = { read: new Set(["kept.ts"]), edited: new Set() };
	const branchEntries = [
		{ type: "message" },
		{ type: "compaction", details: { readFiles: ["old-should-not.ts"], modifiedFiles: [] } }, // 更早的,不该继承
		{ type: "compaction", fromHook: true, details: { readFiles: ["r1.ts", 42, "kept.ts"], modifiedFiles: ["w1.ts"] } },
		{ type: "message" },
	];
	carryOverFileOps(branchEntries, fileOps);
	assert.deepEqual([...fileOps.read].sort(), ["kept.ts", "r1.ts"]);
	assert.deepEqual([...fileOps.edited], ["w1.ts"]);
	// 不修改 branchEntries
	assert.deepEqual(branchEntries[1].details.readFiles, ["old-should-not.ts"]);
});

test("carryOverFileOps: 无 compaction 条目时是 no-op", () => {
	const fileOps = { read: new Set(), edited: new Set() };
	carryOverFileOps([{ type: "message" }, { type: "branch_summary" }], fileOps);
	assert.equal(fileOps.read.size, 0);
	assert.equal(fileOps.edited.size, 0);
});

test("carryOverFileOps: details 缺失/非数组字段安全跳过", () => {
	const fileOps = { read: new Set(), edited: new Set() };
	carryOverFileOps([{ type: "compaction" }], fileOps);
	carryOverFileOps([{ type: "compaction", details: {} }], fileOps);
	carryOverFileOps([{ type: "compaction", details: { readFiles: "not-an-array" } }], fileOps);
	assert.equal(fileOps.read.size, 0);
});

// ── handleBeforeCompact 决策分支 ────────────────────────────────────────

test("未启用 → passthrough(零侵入,不解析模型不调 compact)", async () => {
	const compactFn = compactStub();
	const decision = await handleBeforeCompact({
		cfg: normalizeConfig({}),
		modelResolution: undefined,
		compactFn,
		preparation: basePreparation(),
		branchEntries: [],
		customInstructions: undefined,
		signal: neverAbort,
		thinkingLevel: "off",
		retry: undefined,
	});
	assert.deepEqual(decision, { kind: "passthrough" });
	assert.equal(compactFn.calls.length, 0);
});

test("启用但模型不存在 + fallback=true → fallback(warning)", async () => {
	const { promise } = run({ modelResolution: { model: undefined, hasAuth: false, auth: undefined } });
	assert.deepEqual(await promise, {
		kind: "fallback",
		level: "warning",
		message: "compact-model: 模型 p/m 不存在于 models.json / 注册 provider",
	});
});

test("启用但模型不存在 + fallback=false → fallback(error)(装配层负责 throw)", async () => {
	const { params, promise } = run({
		cfg: normalizeConfig({ enabled: true, provider: "p", model: "m", fallbackToDefault: false }),
		modelResolution: { model: undefined, hasAuth: false, auth: undefined },
	});
	const decision = await promise;
	assert.equal(decision.kind, "fallback");
	assert.equal(decision.level, "error");
});

test("无鉴权 → fallback(warning)", async () => {
	const { promise } = run({ modelResolution: { model: { id: "m" }, hasAuth: false, auth: undefined } });
	const decision = await promise;
	assert.equal(decision.kind, "fallback");
	assert.equal(decision.level, "warning");
	assert.ok(decision.message.includes("无可用鉴权"));
});

test("auth ok=false → fallback(含错误信息)", async () => {
	const { promise } = run({ modelResolution: { model: { id: "m" }, hasAuth: true, auth: { ok: false, error: "boom" } } });
	const decision = await promise;
	assert.equal(decision.kind, "fallback");
	assert.ok(decision.message.includes("boom"));
});

test("streamFn 透传（mimic 适配层注入）", async () => {
	const compactFn = compactStub();
	const fakeStreamFn = () => ({ result: async () => ({}) });
	const { promise } = run({ compactFn, streamFn: fakeStreamFn });
	await promise;
	assert.equal(compactFn.calls[0].streamFn, fakeStreamFn);
});

test("未提供 streamFn → undefined（官方默认实现）", async () => {
	const compactFn = compactStub();
	const { promise } = run({ compactFn });
	await promise;
	assert.equal(compactFn.calls[0].streamFn, undefined);
});

test("成功 → compaction,并验证传给 compact() 的参数", async () => {
	const compactFn = compactStub();
	const preparation = basePreparation();
	const { promise } = run({
		compactFn,
		preparation,
		branchEntries: [{ type: "compaction", fromHook: true, details: { readFiles: ["prev.ts"], modifiedFiles: [] } }],
	});
	const decision = await promise;
	assert.equal(decision.kind, "compaction");

	const call = compactFn.calls[0];
	assert.equal(call.model.baseUrl, "https://gw.example/v1");
	assert.equal(call.model.id, "m");
	assert.equal(call.apiKey, "sk-x");
	assert.deepEqual(call.headers, { "X-T": "1" });
	assert.equal(call.customInstructions, "保留 XX 细节");
	assert.equal(call.thinkingLevel, "off");
	assert.deepEqual(call.env, { FOO: "1" });
	assert.deepEqual(call.retry, { enabled: true, maxRetries: 5 });
	assert.equal(call.signal, neverAbort);
	assert.equal(call.preparation, preparation);
	// fileOps 继承发生
	assert.ok(preparation.fileOps.read.has("prev.ts"));
});

test("auth 无 baseUrl → model 原样透传(不复制)", async () => {
	const compactFn = compactStub();
	const model = { id: "m", provider: "p" };
	const { promise } = run({
		compactFn,
		modelResolution: { model, hasAuth: true, auth: { ok: true, apiKey: "k" } },
	});
	await promise;
	assert.equal(compactFn.calls[0].model, model);
	assert.equal(compactFn.calls[0].headers, undefined);
	assert.equal(compactFn.calls[0].env, undefined);
});

test("compact 抛错 + signal.aborted → passthrough", async () => {
	const { promise } = run({
		compactFn: async () => {
			throw new Error("stream terminated");
		},
		signal: abortedSignal,
	});
	assert.deepEqual(await promise, { kind: "passthrough" });
});

test("compact 抛错 + fallback=true → fallback(error)", async () => {
	const { promise } = run({
		compactFn: async () => {
			throw new Error("stream terminated");
		},
	});
	const decision = await promise;
	assert.equal(decision.kind, "fallback");
	assert.equal(decision.level, "error");
	assert.ok(decision.message.includes("stream terminated"));
});

test("compact 抛错 + fallback=false → fallback(error)(装配层 throw)", async () => {
	const { promise } = run({
		cfg: normalizeConfig({ enabled: true, provider: "p", model: "m", fallbackToDefault: false }),
		compactFn: async () => {
			throw new Error("quota exceeded");
		},
	});
	const decision = await promise;
	assert.equal(decision.kind, "fallback");
	assert.equal(decision.level, "error");
});

test("thinkingLevel=inherit 透传装配层解析的级别", async () => {
	const compactFn = compactStub();
	const { promise } = run({ compactFn, thinkingLevel: "max" });
	await promise;
	assert.equal(compactFn.calls[0].thinkingLevel, "max");
});

// ── readRetrySettings ───────────────────────────────────────────────────

test("readRetrySettings: 正常 settings.json → retry 对象", () => {
	const dir = mkdtempSync(join(tmpdir(), "cm-retry-"));
	try {
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ defaultModel: "x", retry: { enabled: true, maxRetries: 9, baseDelayMs: 100, maxAgentDelayMs: 500 } }));
		const retry = readRetrySettings(dir, (p) => {
			assert.equal(p, join(dir, "settings.json"));
			return readFileSync(p, "utf8");
		});
		assert.deepEqual(retry, { enabled: true, maxRetries: 9, baseDelayMs: 100, maxAgentDelayMs: 500 });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("readRetrySettings: 无 retry 字段 / 无文件 / 损坏 → undefined", () => {
	const dir = mkdtempSync(join(tmpdir(), "cm-retry-"));
	try {
		mkdirSync(dir, { recursive: true });
		const read = (p) => readFileSync(p, "utf8");
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ other: 1 }));
		assert.equal(readRetrySettings(dir, read), undefined);
		assert.equal(readRetrySettings(join(dir, "nope"), read), undefined);
		writeFileSync(join(dir, "settings.json"), "{broken");
		assert.equal(readRetrySettings(dir, read), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
