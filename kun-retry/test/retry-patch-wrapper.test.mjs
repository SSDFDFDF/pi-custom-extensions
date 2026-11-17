import assert from "node:assert/strict";
import { test } from "node:test";
import { bindRetryHooks, installConstantDelayPatch, MAX_EXPONENT } from "../src/retry-patch.ts";

function makeClass() {
	class Settings {
		constructor(settings) { this.settings = settings; }
		getRetrySettings() { return { ...this.settings }; }
	}
	return class Session {
		constructor(settings = {}) {
			this.sessionManager = {};
			this.settingsManager = new Settings({ enabled: true, maxRetries: 100, baseDelayMs: 2000, ...settings });
			this._retryAttempt = 0;
			this.delays = [];
			this.coreCalls = 0;
			this.agent = { state: { messages: [{ role: "user" }, { role: "assistant" }] } };
		}
		async _prepareRetry() {
			this.coreCalls++;
			const settings = this.settingsManager.getRetrySettings();
			if (!settings.enabled) return false;
			if (++this._retryAttempt > settings.maxRetries) { this._retryAttempt--; return false; }
			this.delays.push(Math.min(settings.baseDelayMs * 2 ** (this._retryAttempt - 1), settings.maxAgentDelayMs ?? 60000));
			this.agent.state.messages = this.agent.state.messages.filter(m => m.role !== "assistant");
			return true;
		}
	};
}
const hooks = (delay = 5000, max = 100, extra = {}) => ({ getConstantDelayMs: () => delay, getMaxRetries: () => max, ...extra });
function setup(settings, h = hooks()) {
	const Class = makeClass();
	assert.equal(installConstantDelayPatch(Class).installed, true);
	const session = new Class(settings);
	const unbind = bindRetryHooks(session.sessionManager, h);
	return { Class, session, unbind };
}

test("unregistered sessions preserve core exponential behavior", async () => {
	const { session, unbind } = setup(); unbind();
	for (let n = 0; n < 5; n++) await session._prepareRetry({});
	assert.deepEqual(session.delays, [2000, 4000, 8000, 16000, 32000]);
});

test("constant delay, cumulative callbacks and core cleanup", async () => {
	const events = [];
	const { session } = setup({}, hooks(5000, 100, { onRetry: info => events.push(info) }));
	for (let n = 0; n < 12; n++) assert.equal(await session._prepareRetry({}), true);
	assert.deepEqual(session.delays, Array(12).fill(5000));
	assert.deepEqual(events.map(e => e.attempt), Array.from({ length: 12 }, (_, n) => n + 1));
	assert.deepEqual(session.agent.state.messages, [{ role: "user" }]);
	assert.equal(Object.hasOwn(session.settingsManager, "getRetrySettings"), false);
});

test("independent parent/child hooks and late shutdown", async () => {
	const { Class, session: parent } = setup({}, hooks(5000));
	const child = new Class();
	const childDispose = bindRetryHooks(child.sessionManager, hooks(9000, 1, { onRetry() { throw Error("stale ctx"); } }));
	await parent._prepareRetry({}); await child._prepareRetry({});
	assert.deepEqual(parent.delays, [5000]); assert.deepEqual(child.delays, [9000]);
	const replacement = hooks(7000);
	bindRetryHooks(child.sessionManager, replacement); childDispose();
	await child._prepareRetry({});
	assert.deepEqual(child.delays, [9000, 7000]);
	await parent._prepareRetry({}); assert.deepEqual(parent.delays, [5000, 5000]);
});

test("one patch per prototype and independent SDK copies", async () => {
	const first = setup({}, hooks(1000));
	const method = first.Class.prototype._prepareRetry;
	installConstantDelayPatch(first.Class);
	assert.equal(first.Class.prototype._prepareRetry, method);
	const second = setup({}, hooks(3000));
	await first.session._prepareRetry({}); await second.session._prepareRetry({});
	assert.deepEqual(first.session.delays, [1000]); assert.deepEqual(second.session.delays, [3000]);
});

test("UI and diagnostic observer failures cannot block core", async () => {
	const { session } = setup({}, hooks(1000, 100, { onRetry() { throw Error("stale"); }, record() { throw Error("disk"); } }));
	assert.equal(await session._prepareRetry({}), true);
	assert.equal(session.coreCalls, 1);
});

test("policy getter failure delegates to core without stale UI", async () => {
	const { session } = setup({}, hooks(1000, 100, { getConstantDelayMs() { throw Error("bad getter"); } }));
	assert.equal(await session._prepareRetry({}), true);
	assert.deepEqual(session.delays, [2000]);
});

test("own settings descriptor is restored exactly", async () => {
	const { session } = setup();
	const get = () => ({ enabled: true, maxRetries: 100, baseDelayMs: 2000 });
	Object.defineProperty(session.settingsManager, "getRetrySettings", { configurable: true, enumerable: true, writable: false, value: get });
	const descriptor = Object.getOwnPropertyDescriptor(session.settingsManager, "getRetrySettings");
	await session._prepareRetry({});
	assert.deepEqual(Object.getOwnPropertyDescriptor(session.settingsManager, "getRetrySettings"), descriptor);
});

test("nonconfigurable settings fails closed to unmodified core", async () => {
	const { session } = setup();
	Object.defineProperty(session.settingsManager, "getRetrySettings", { configurable: false, value: () => ({ enabled: true, maxRetries: 100, baseDelayMs: 2000 }) });
	assert.equal(await session._prepareRetry({}), true);
	assert.deepEqual(session.delays, [2000]);
});

test("disabled core does not schedule a retry or consume a budget", async () => {
	const events = [];
	const { session } = setup({ enabled: false }, hooks(1000, 100, { onRetry: e => events.push(e) }));
	assert.equal(await session._prepareRetry({}), false);
	assert.equal(session._retryAttempt, 0); assert.deepEqual(events, []);
});

test("core and extension budgets both respected unless live settings override", async () => {
	const { session } = setup({ maxRetries: 1 }, hooks(1000, 3));
	assert.equal(await session._prepareRetry({}), true); assert.equal(await session._prepareRetry({}), false);
	bindRetryHooks(session.sessionManager, hooks(1000, 3, { getSettings: () => ({ maxRetries: 3 }) }));
	assert.equal(await session._prepareRetry({}), true); assert.equal(await session._prepareRetry({}), true);
	assert.equal(await session._prepareRetry({}), false);
	session._retryAttempt = 0;
	assert.equal(await session._prepareRetry({}), true);
});

test("native budget remains accurate past exponent overflow and constant off", async () => {
	let delay = 5;
	const events = [];
	const { session } = setup({ maxRetries: 1003 }, hooks(0, 1003, { getConstantDelayMs: () => delay, onRetry: e => events.push(e) }));
	// A session first bound mid-run must seed its cumulative count from core.
	session._retryAttempt = MAX_EXPONENT;
	assert.equal(await session._prepareRetry({}), true);
	assert.equal(session._retryAttempt, 1001); assert.equal(events[0].attempt, 1001);
	delay = 0;
	assert.equal(await session._prepareRetry({}), true); assert.equal(await session._prepareRetry({}), true);
	assert.equal(await session._prepareRetry({}), false);
	assert.deepEqual(events.map(e => e.attempt), [1001, 1002, 1003]);
});

test("settings shadow is restored before callbacks in the core and async pause", async () => {
	const { session, Class } = setup();
	const other = new Class(); other.settingsManager = session.settingsManager;
	bindRetryHooks(other.sessionManager, hooks(3000));
	await Promise.all([session._prepareRetry({}), other._prepareRetry({})]);
	assert.deepEqual(session.delays, [5000]); assert.deepEqual(other.delays, [3000]);
	assert.equal(session.settingsManager.getRetrySettings().baseDelayMs, 2000);
});
