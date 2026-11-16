import { test } from "node:test";
import assert from "node:assert/strict";

import { load } from "./load.mjs";

const { REWRITE_SERVICE_KEY, createRewritingStreamFn, resolveMimicService, activeMimicProfile } =
	await load("../src/mimic.ts");

const MODEL = { provider: "custom-x", api: "openai-completions", id: "cheap-flash" };

/** 假 provider：记录调用参数，返回一个带 result() 的流。 */
const fakeDelegate = (response = { content: [{ type: "text", text: "ok" }] }) => {
	const calls = [];
	const fn = (model, context, options) => {
		calls.push({ model, context, options });
		return { result: async () => response };
	};
	fn.calls = calls;
	return fn;
};

/** 假 client-mimic 服务：记录调用顺序，按需改写。 */
const fakeService = (overrides = {}) => {
	const events = [];
	const service = {
		version: 1,
		activeProfile: () => "codex",
		rewriteHeaders: (headers, model) => {
			events.push({ step: "headers", model });
			headers["user-agent"] = "codex_cli_rs/0.144.4";
			headers["x-stainless-lang"] = null;
			return { profile: "codex" };
		},
		patchPayload: (payload) => {
			events.push({ step: "payload", payload });
			return { profile: "codex", payload: { ...payload, prompt_cache_key: "sess-1" } };
		},
		...overrides,
	};
	service.events = events;
	return service;
};

const options = () => ({ headers: { "x-existing": "1" }, maxTokens: 64 });

test("无 client-mimic 服务 → 完全透传（不注入 headers/onPayload）", async () => {
	const delegate = fakeDelegate();
	const stream = createRewritingStreamFn({ resolveService: () => undefined, delegate });
	const opts = options();
	await stream(MODEL, { messages: [] }, opts);
	assert.equal(delegate.calls.length, 1);
	assert.deepEqual(delegate.calls[0].options, opts);
});

test("服务存在但未激活（activeProfile=null）→ 透传", async () => {
	const delegate = fakeDelegate();
	const service = fakeService({ activeProfile: () => null });
	const stream = createRewritingStreamFn({ resolveService: () => service, delegate });
	await stream(MODEL, { messages: [] }, options());
	assert.equal(service.events.length, 0);
	assert.equal(delegate.calls[0].options.onPayload, undefined);
});

test("激活时先改写 headers，再用 onPayload 改写 body；模型信息透传", async () => {
	const delegate = fakeDelegate();
	const service = fakeService();
	const stream = createRewritingStreamFn({ resolveService: () => service, delegate });

	await stream(MODEL, { messages: [{ role: "user", content: "hi" }] }, options());

	assert.equal(delegate.calls.length, 1);
	const sent = delegate.calls[0].options;
	// 原 headers 保留，伪装头写入，strip 标记保留为 null（pi 的 ProviderHeaders 允许）
	assert.equal(sent.headers["x-existing"], "1");
	assert.equal(sent.headers["user-agent"], "codex_cli_rs/0.144.4");
	assert.equal(sent.headers["x-stainless-lang"], null);
	assert.equal(sent.maxTokens, 64, "其他 stream 选项必须原样保留");

	// 模型信息（provider/api/id）传给服务
	assert.deepEqual(service.events[0], {
		step: "headers",
		model: { provider: "custom-x", api: "openai-completions", id: "cheap-flash" },
	});

	// onPayload 链：payload 经服务改写后返回
	const patched = await sent.onPayload({ model: "m" }, MODEL);
	assert.deepEqual(patched, { model: "m", prompt_cache_key: "sess-1" });
	assert.equal(service.events[1].step, "payload");
});

test("已有 onPayload 时按 prev → mimic 的顺序链式执行", async () => {
	const delegate = fakeDelegate();
	const service = fakeService({
		patchPayload: (payload) => ({ profile: "codex", payload: { ...payload, stage: [...payload.stage, "mimic"] } }),
	});
	const stream = createRewritingStreamFn({ resolveService: () => service, delegate });
	const opts = {
		...options(),
		onPayload: (payload) => ({ ...payload, stage: [...payload.stage, "prev"] }),
	};
	await stream(MODEL, { messages: [] }, opts);

	const patched = await delegate.calls[0].options.onPayload({ stage: [] }, MODEL);
	assert.deepEqual(patched.stage, ["prev", "mimic"]);
});

test("改写抛错不影响请求：headers 保持原样，payload 原样返回", async () => {
	const delegate = fakeDelegate();
	const service = fakeService({
		rewriteHeaders: () => {
			throw new Error("header boom");
		},
		patchPayload: () => {
			throw new Error("body boom");
		},
	});
	const stream = createRewritingStreamFn({ resolveService: () => service, delegate });
	await stream(MODEL, { messages: [] }, options());

	assert.equal(delegate.calls.length, 1, "必须仍然发出请求");
	assert.equal(delegate.calls[0].options.headers["user-agent"], undefined);
	const payload = await delegate.calls[0].options.onPayload({ untouched: true }, MODEL);
	assert.deepEqual(payload, { untouched: true });
});

test("activeProfile 自身抛错 → 视为未激活并透传", async () => {
	const delegate = fakeDelegate();
	const service = fakeService({
		activeProfile: () => {
			throw new Error("boom");
		},
	});
	const stream = createRewritingStreamFn({ resolveService: () => service, delegate });
	await stream(MODEL, { messages: [] }, options());
	assert.equal(delegate.calls[0].options.onPayload, undefined);
});

test("resolveMimicService: 正确发布/版本不符/非法值/清除", () => {
	const holder = {};
	assert.equal(resolveMimicService(holder), undefined);

	holder[REWRITE_SERVICE_KEY] = fakeService();
	assert.ok(resolveMimicService(holder));

	holder[REWRITE_SERVICE_KEY] = { ...fakeService(), version: 99 };
	assert.equal(resolveMimicService(holder), undefined, "版本不符必须拒绝");

	holder[REWRITE_SERVICE_KEY] = { version: 1, activeProfile: () => "x" };
	assert.equal(resolveMimicService(holder), undefined, "缺方法必须拒绝");

	holder[REWRITE_SERVICE_KEY] = "nope";
	assert.equal(resolveMimicService(holder), undefined);
});

test("activeMimicProfile: 有服务 → profile；无服务/抛错 → null", () => {
	assert.equal(activeMimicProfile(() => fakeService()), "codex");
	assert.equal(activeMimicProfile(() => undefined), null);
	assert.equal(
		activeMimicProfile(() =>
			fakeService({
				activeProfile: () => {
					throw new Error("boom");
				},
			}),
		),
		null,
	);
});
