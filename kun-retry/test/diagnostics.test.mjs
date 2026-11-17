import assert from "node:assert/strict";
import { test } from "node:test";
import { createRetryDiagnostics } from "../src/diagnostics.ts";

test("trace defaults off while in-memory diagnostics record generated timestamps", () => {
	const persisted = [];
	const diagnostics = createRetryDiagnostics((entry) => persisted.push(entry));
	assert.equal(diagnostics.enabled, false);
	const before = Date.now();
	diagnostics.record("retry", { attempt: 2, maxRetries: 4, delayMs: 5_000, sessionId: "session-1" });
	const [entry] = diagnostics.entries();
	assert.equal(entry.phase, "retry");
	assert.equal(entry.sessionId, "session-1");
	assert.equal(entry.at, new Date(entry.at).toISOString());
	assert.ok(Date.parse(entry.at) >= before && Date.parse(entry.at) <= Date.now());
	assert.deepEqual({ ...entry, at: undefined }, {
		at: undefined, phase: "retry", sessionId: "session-1", attempt: 2, maxRetries: 4, delayMs: 5_000,
	});
	assert.deepEqual(persisted, []);
	assert.match(diagnostics.format(), /trace OFF/);
});

test("default ring retains exactly the latest 100 records in chronological order", () => {
	const diagnostics = createRetryDiagnostics();
	for (let attempt = 0; attempt < 350; attempt++) diagnostics.record("retry", { attempt });
	assert.deepEqual(diagnostics.entries().map((entry) => entry.attempt), Array.from({ length: 100 }, (_, i) => i + 250));
});

test("custom ring limits wrap repeatedly and clear resets its cursor", () => {
	const diagnostics = createRetryDiagnostics(undefined, 3);
	for (let attempt = 0; attempt < 10; attempt++) diagnostics.record("retry", { attempt });
	assert.deepEqual(diagnostics.entries().map((entry) => entry.attempt), [7, 8, 9]);
	diagnostics.clear();
	assert.deepEqual(diagnostics.entries(), []);
	for (let attempt = 20; attempt < 24; attempt++) diagnostics.record("retry", { attempt });
	assert.deepEqual(diagnostics.entries().map((entry) => entry.attempt), [21, 22, 23]);
	const single = createRetryDiagnostics(undefined, 1);
	single.record("first");
	single.record("second");
	assert.deepEqual(single.entries().map((entry) => entry.phase), ["second"]);
});

test("invalid limits fall back to 100; zero disables retention but not opt-in persistence", () => {
	for (const limit of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
		const diagnostics = createRetryDiagnostics(undefined, limit);
		for (let i = 0; i < 110; i++) diagnostics.record("test");
		assert.equal(diagnostics.entries().length, 100);
	}
	const persisted = [];
	const zero = createRetryDiagnostics((entry) => persisted.push(entry), 0);
	zero.enabled = true;
	zero.record("test");
	assert.deepEqual(zero.entries(), []);
	assert.equal(persisted.length, 1);
});

test("enabled gates persistence only and does not flush old memory records", () => {
	const persisted = [];
	const diagnostics = createRetryDiagnostics((entry) => persisted.push(entry));
	diagnostics.record("before");
	diagnostics.enabled = true;
	assert.equal(diagnostics.enabled, true);
	assert.deepEqual(persisted, []);
	diagnostics.record("during");
	diagnostics.enabled = false;
	diagnostics.record("after");
	assert.deepEqual(persisted.map((entry) => entry.phase), ["during"]);
	assert.deepEqual(diagnostics.entries().map((entry) => entry.phase), ["before", "during", "after"]);
	const noPersistence = createRetryDiagnostics();
	noPersistence.enabled = true;
	assert.doesNotThrow(() => noPersistence.record("test"));
});

test("persistence errors are isolated and cannot stop subsequent ring recording", () => {
	let calls = 0;
	const diagnostics = createRetryDiagnostics(() => { calls++; throw Error("stale session"); });
	diagnostics.enabled = true;
	assert.doesNotThrow(() => {
		diagnostics.record("first", { reason: "stale-session", errorName: "Error" });
		diagnostics.record("second");
	});
	assert.equal(calls, 2);
	assert.equal(diagnostics.entries().length, 2);
	assert.equal(diagnostics.entries()[0].reason, "stale-session");
});

test("sanitize excludes sensitive fields case-insensitively without losing retry metadata", () => {
	const persisted = [];
	const diagnostics = createRetryDiagnostics((entry) => persisted.push(entry));
	diagnostics.enabled = true;
	const sensitive = [
		"payload", "providerPayload", "CONTENT", "responseContent", "apiKey", "api_key", "X-API-KEY",
		"token", "accessToken", "refresh_token", "headers", "requestHeaders", "errorMessage", "error_message",
		"rawErrorMessage", "text", "providerText", "message", "body", "rawResponse", "requestBody",
		"responseBody", "prompt", "systemPrompt", "messages", "password", "secret", "credentials",
		"authorization", "cookie", "stack", "raw", "data", "error", "response", "request",
	];
	const data = Object.fromEntries(sensitive.map((key) => [key, "TOP-SECRET"]));
	Object.assign(data, {
		attempt: 2, maxRetries: 10, delayMs: 5_000, exponent: 1, errorName: "TimeoutError",
		reason: "stall-timeout", sessionId: "sid", provider: "provider-id", model: "model-id",
		messageId: "message-id", requestId: "request-id", responseStatus: 429, errorCount: 2,
		textLength: 10,
	});
	diagnostics.record("retry", data);
	const [entry] = diagnostics.entries();
	for (const key of sensitive) assert.equal(Object.hasOwn(entry, key), false, key);
	assert.deepEqual({ ...entry, at: undefined }, {
		at: undefined, phase: "retry", attempt: 2, maxRetries: 10, delayMs: 5_000, exponent: 1,
		errorName: "TimeoutError", reason: "stall-timeout", sessionId: "sid", provider: "provider-id", model: "model-id",
		messageId: "message-id", requestId: "request-id", responseStatus: 429, errorCount: 2, textLength: 10,
	});
	assert.doesNotMatch(JSON.stringify(persisted), /TOP-SECRET/);
	assert.doesNotMatch(diagnostics.format(), /TOP-SECRET/);
});

test("sanitize allows only bounded JSON primitives and flat arrays, never provider objects", () => {
	const diagnostics = createRetryDiagnostics();
	const cyclic = {}; cyclic.self = cyclic;
	const data = {
		finite: 12.5, flag: true, absent: null, reason: "a".repeat(2_000),
		statuses: [429, 503, "safe", false, null, { content: "SECRET" }, ["SECRET"], undefined, Infinity, 1n],
		many: Array.from({ length: 100 }, (_, i) => i),
		nested: { payload: "SECRET", attempt: 1 }, cyclic,
		errorObject: Error("SECRET"), date: new Date(), map: new Map(),
		fn: () => {}, undef: undefined, symbol: Symbol("SECRET"), big: 1n, nan: NaN, inf: Infinity,
		toJSON() { assert.fail("sanitize must not call toJSON"); },
	};
	assert.doesNotThrow(() => diagnostics.record("test", data));
	const [entry] = diagnostics.entries();
	assert.equal(entry.finite, 12.5);
	assert.equal(entry.flag, true);
	assert.equal(entry.absent, null);
	assert.equal(entry.reason.length, 256);
	assert.deepEqual(entry.statuses, [429, 503, "safe", false, null]);
	assert.deepEqual(entry.many, Array.from({ length: 20 }, (_, i) => i));
	for (const key of ["nested", "cyclic", "errorObject", "date", "map", "fn", "undef", "symbol", "big", "nan", "inf", "toJSON"]) {
		assert.equal(Object.hasOwn(entry, key), false, key);
	}
	assert.doesNotThrow(() => JSON.stringify(entry));
	assert.doesNotMatch(JSON.stringify(entry), /SECRET/);
});

test("reserved fields, oversized keys and prototype pollution cannot alter generated entries", () => {
	const diagnostics = createRetryDiagnostics();
	const data = JSON.parse('{"__proto__":{"polluted":true},"constructor":"SECRET","prototype":"SECRET","at":"fake","phase":"fake","attempt":3}');
	data["k".repeat(65)] = "SECRET";
	data["bad\nkey"] = "SECRET";
	diagnostics.record("real", data);
	const [entry] = diagnostics.entries();
	assert.equal(entry.phase, "real");
	assert.notEqual(entry.at, "fake");
	assert.equal(entry.attempt, 3);
	assert.equal(Object.getPrototypeOf(entry), Object.prototype);
	assert.equal(Object.hasOwn(entry, "__proto__"), false);
	assert.equal(Object.hasOwn(entry, "constructor"), false);
	assert.equal(Object.hasOwn(entry, "prototype"), false);
	assert.equal({}.polluted, undefined);
	assert.doesNotMatch(JSON.stringify(entry), /SECRET/);
});

test("metadata field count, phase and terminal controls are bounded", () => {
	const diagnostics = createRetryDiagnostics();
	diagnostics.record("p".repeat(500), Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`field${i}`, i])));
	const [entry] = diagnostics.entries();
	assert.equal(entry.phase.length, 256);
	assert.equal(Object.keys(entry).length, 34, "32 metadata fields plus at and phase");
	diagnostics.record("retry\n\u001b[31m\u009b", { reason: "known\r\n\t\u001b[2J\u007f\u009b" });
	assert.doesNotMatch(diagnostics.entries()[1].phase, /[\u0000-\u001f\u007f-\u009f]/);
	assert.doesNotMatch(diagnostics.entries()[1].reason, /[\u0000-\u001f\u007f-\u009f]/);
	assert.equal(diagnostics.format().split("\n").length, 3);
});

test("sanitize never invokes data or array accessors and isolates hostile proxies", () => {
	const diagnostics = createRetryDiagnostics();
	let getters = 0;
	const data = { attempt: 1 };
	Object.defineProperty(data, "reason", { enumerable: true, get() { getters++; throw Error("SECRET"); } });
	Object.defineProperty(data, "payload", { enumerable: true, get() { getters++; throw Error("SECRET"); } });
	const values = [1, 2, 3];
	Object.defineProperty(values, "1", { get() { getters++; throw Error("SECRET"); } });
	data.values = values;
	assert.doesNotThrow(() => diagnostics.record("safe", data));
	assert.equal(getters, 0);
	assert.deepEqual(diagnostics.entries()[0].values, [1, 3]);
	assert.doesNotThrow(() => diagnostics.record("keys-fail", new Proxy({}, { ownKeys() { throw Error("SECRET"); } })));
	assert.doesNotThrow(() => diagnostics.record("descriptor-fail", new Proxy({ reason: "SECRET", attempt: 2 }, {
		getOwnPropertyDescriptor(target, key) { if (key === "reason") throw Error("SECRET"); return Reflect.getOwnPropertyDescriptor(target, key); },
	})));
	assert.equal(diagnostics.entries().at(-1).attempt, 2);
	assert.doesNotMatch(diagnostics.format(), /SECRET/);
});

test("input, returned entries and persistence are independent copies including arrays", () => {
	const data = { attempt: 1, statuses: [429, 503] };
	const diagnostics = createRetryDiagnostics((entry) => {
		entry.phase = "corrupted";
		entry.statuses.push(999);
		entry.attempt = 999;
	});
	diagnostics.enabled = true;
	diagnostics.record("retry", data);
	data.attempt = 2;
	data.statuses.push(999);
	const first = diagnostics.entries();
	first[0].attempt = 100;
	first[0].statuses.push(999);
	first.push({ phase: "fake" });
	const second = diagnostics.entries();
	assert.equal(second.length, 1);
	assert.equal(second[0].phase, "retry");
	assert.equal(second[0].attempt, 1);
	assert.deepEqual(second[0].statuses, [429, 503]);
	assert.notEqual(first, second);
	assert.notEqual(first[0], second[0]);
	assert.notEqual(first[0].statuses, second[0].statuses);
});

test("format shows a readable trace of only the latest 20 retained records", () => {
	const diagnostics = createRetryDiagnostics();
	assert.match(diagnostics.format(), /trace OFF/);
	assert.match(diagnostics.format(), /no diagnostic entries/);
	diagnostics.enabled = true;
	for (let attempt = 1; attempt <= 25; attempt++) {
		diagnostics.record(`phase-${String(attempt).padStart(2, "0")}`, { attempt, maxRetries: 50, reason: "retryable", errorName: "Error" });
	}
	const text = diagnostics.format();
	assert.match(text, /trace ON.*25 retained, latest 20/);
	assert.doesNotMatch(text, /phase-0[1-5]\b/);
	assert.match(text, /phase-06 attempt=6 maxRetries=50 reason="retryable" errorName="Error"/);
	assert.match(text, /phase-25 attempt=25/);
	assert.equal(text.split("\n").length, 21);
	assert.equal(diagnostics.entries().length, 25, "format does not consume the ring");
	diagnostics.clear();
	assert.match(diagnostics.format(), /trace ON.*0 retained/);
});

test("dispose permanently blocks record/persist and retains readable existing entries", () => {
	let persists = 0;
	const diagnostics = createRetryDiagnostics(() => { persists++; });
	diagnostics.enabled = true;
	diagnostics.record("before");
	const snapshot = diagnostics.entries();
	const staleCallback = () => diagnostics.record("stale", { attempt: 2 });
	diagnostics.dispose();
	diagnostics.dispose();
	diagnostics.enabled = true;
	assert.equal(diagnostics.enabled, false);
	assert.doesNotThrow(() => {
		staleCallback();
		diagnostics.record("forbidden", new Proxy({}, { ownKeys() { assert.fail("disposed record must not inspect input"); } }));
	});
	assert.equal(persists, 1);
	assert.deepEqual(diagnostics.entries(), snapshot);
	assert.match(diagnostics.format(), /before/);
	diagnostics.clear();
	staleCallback();
	assert.deepEqual(diagnostics.entries(), []);
});

test("dispose during metadata inspection or persistence prevents subsequent callback records", () => {
	let persists = 0;
	const diagnostics = createRetryDiagnostics(() => { persists++; });
	diagnostics.enabled = true;
	const data = new Proxy({ attempt: 1 }, {
		ownKeys(target) { diagnostics.dispose(); return Reflect.ownKeys(target); },
	});
	diagnostics.record("shutdown", data);
	assert.equal(persists, 0);
	assert.deepEqual(diagnostics.entries(), []);
	const reentrant = createRetryDiagnostics(() => { reentrant.dispose(); reentrant.record("stale"); });
	reentrant.enabled = true;
	reentrant.record("last");
	assert.deepEqual(reentrant.entries().map((entry) => entry.phase), ["last"]);
});

test("missing or malformed runtime metadata is safely reduced to a phase and time", () => {
	const diagnostics = createRetryDiagnostics();
	for (const data of [undefined, null, 42, "raw text", Error("SECRET")]) {
		assert.doesNotThrow(() => diagnostics.record("test", data));
	}
	for (const entry of diagnostics.entries()) assert.deepEqual(Object.keys(entry).sort(), ["at", "phase"]);
	diagnostics.record(undefined, { sessionId: 42 });
	assert.equal(diagnostics.entries().at(-1).phase, "unknown");
	assert.equal(Object.hasOwn(diagnostics.entries().at(-1), "sessionId"), false);
	assert.doesNotMatch(diagnostics.format(), /SECRET/);
});
