/**
 * rewrite-service contract tests.
 *
 * Loaded through jiti (see test loader note below) because this Node build has
 * no `--experimental-strip-types`. Run: `npm run test:service`.
 *
 * These cover the cross-extension contract that compact-model consumes:
 * versioned shape, fail-open behavior, and publish/clear ownership semantics.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { REWRITE_SERVICE_KEY, createRewriteService, publishRewriteService, clearRewriteService } =
	await jiti.import("./rewrite-service.ts");

const hooks = (overrides = {}) => {
	const events = [];
	const h = {
		activeProfile: () => "codex",
		inactiveReason: () => "active=off",
		applyHeaders: (headers) => {
			events.push("headers");
			headers["user-agent"] = "codex_cli_rs/0.144.4";
		},
		applyPayload: (payload) => {
			events.push("payload");
			return { ...payload, prompt_cache_key: "sess" };
		},
		...overrides,
	};
	h.events = events;
	return h;
};

test("未启用 profile → skip 原因透出，headers 不变", () => {
	const service = createRewriteService(hooks({ activeProfile: () => null }));
	const headers = { a: "1" };
	const outcome = service.rewriteHeaders(headers, { provider: "p", api: "a", id: "i" });
	assert.deepEqual(outcome, { profile: null, skipped: "active=off" });
	assert.deepEqual(headers, { a: "1" });

	const patch = service.patchPayload({ x: 1 }, { provider: "p", api: "a", id: "i" });
	assert.equal(patch.profile, null);
	assert.deepEqual(patch.payload, { x: 1 });
});

test("启用时改写 headers / payload，并按顺序执行", () => {
	const h = hooks();
	const service = createRewriteService(h);
	const headers = {};
	assert.deepEqual(service.rewriteHeaders(headers, { provider: "p", api: "a", id: "i" }), { profile: "codex" });
	assert.equal(headers["user-agent"], "codex_cli_rs/0.144.4");

	const patch = service.patchPayload({ x: 1 }, { provider: "p", api: "a", id: "i" });
	assert.equal(patch.profile, "codex");
	assert.deepEqual(patch.payload, { x: 1, prompt_cache_key: "sess" });
	assert.deepEqual(h.events, ["headers", "payload"]);
});

test("非对象 payload 原样返回，仍视为已启用", () => {
	const h = hooks();
	const service = createRewriteService(h);
	for (const value of [null, "text", 42, undefined]) {
		const patch = service.patchPayload(value, { provider: "", api: "", id: "" });
		assert.equal(patch.profile, "codex");
		assert.equal(patch.payload, value);
	}
	assert.deepEqual(h.events, [], "非对象不应触发改写");
});

test("改写抛错被兜住：请求可继续，payload 原样", () => {
	const h = hooks({
		applyHeaders: () => {
			throw new Error("header boom");
		},
		applyPayload: () => {
			throw new Error("body boom");
		},
	});
	const service = createRewriteService(h);
	assert.deepEqual(service.rewriteHeaders({}, { provider: "", api: "", id: "" }), {
		profile: null,
		skipped: "header rewrite failed: header boom",
	});
	const patch = service.patchPayload({ keep: true }, { provider: "", api: "", id: "" });
	assert.equal(patch.profile, null);
	assert.deepEqual(patch.payload, { keep: true });
	assert.match(patch.skipped, /body rewrite failed: body boom/);
});

test("hooks 自身抛错也被兜住（activeProfile/inactiveReason）", () => {
	const service = createRewriteService(
		hooks({
			activeProfile: () => {
				throw new Error("cfg boom");
			},
			inactiveReason: () => {
				throw new Error("reason boom");
			},
		}),
	);
	assert.equal(service.activeProfile(), null);
	assert.deepEqual(service.rewriteHeaders({}, { provider: "", api: "", id: "" }), {
		profile: null,
		skipped: "inactive",
	});
});

test("publish/clear 所有权：不删除继任实例的服务", () => {
	const first = createRewriteService(hooks());
	const second = createRewriteService(hooks());

	publishRewriteService(first);
	assert.equal(globalThis[REWRITE_SERVICE_KEY], first);

	publishRewriteService(second);
	clearRewriteService(first);
	assert.equal(globalThis[REWRITE_SERVICE_KEY], second, "旧实例不得清除新实例的服务");

	clearRewriteService(second);
	assert.equal(globalThis[REWRITE_SERVICE_KEY], undefined);
});

test("契约形状：version=1 且三个方法齐全", () => {
	const service = createRewriteService(hooks());
	assert.equal(service.version, 1);
	for (const method of ["activeProfile", "rewriteHeaders", "patchPayload"]) {
		assert.equal(typeof service[method], "function", method);
	}
});
