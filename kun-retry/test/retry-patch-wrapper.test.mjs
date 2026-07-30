import assert from "node:assert/strict";
import { test } from "node:test";
import { installConstantDelayPatch } from "../src/retry-patch.ts";

/**
 * Stand-in for Pi's AgentSession, mirroring the parts of `_prepareRetry` the patch
 * relies on: the retry-settings read, the `_retryAttempt` counter, the budget check,
 * the exponential delay formula, and removal of the failed assistant turn.
 *
 * The sleep is replaced by recording the delay so tests stay instant.
 */
function makeFakeSessionClass(recorded) {
	class FakeSettingsManager {
		constructor(settings) {
			this.settings = settings;
		}
		getRetrySettings() {
			return { ...this.settings };
		}
	}

	class FakeAgentSession {
		constructor(settings) {
			this._retryAttempt = 0;
			this.settingsManager = new FakeSettingsManager(settings);
			this.agent = { state: { messages: [{ role: "user" }, { role: "assistant" }] } };
			this.emitted = [];
		}

		async _prepareRetry(message) {
			const settings = this.settingsManager.getRetrySettings();
			if (!settings.enabled) return false;

			this._retryAttempt++;
			if (this._retryAttempt > settings.maxRetries) {
				this._retryAttempt--;
				return false;
			}

			const delayMs = settings.baseDelayMs * 2 ** (this._retryAttempt - 1);
			this.emitted.push({ attempt: this._retryAttempt, maxAttempts: settings.maxRetries, delayMs });
			recorded.push(delayMs);

			const messages = this.agent.state.messages;
			if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
				this.agent.state.messages = messages.slice(0, -1);
			}
			return true;
		}
	}

	return FakeAgentSession;
}

const recorded = [];
const FakeAgentSession = makeFakeSessionClass(recorded);

let constantDelayMs = 0;
let maxRetries = 1_000_000;
const retryEvents = [];
const exhaustedEvents = [];

// The patch installs once per process, so install here and steer it via the hooks.
const result = installConstantDelayPatch(FakeAgentSession, {
	getConstantDelayMs: () => constantDelayMs,
	getMaxRetries: () => maxRetries,
	onRetry: (info) => retryEvents.push(info),
	onExhausted: (info) => exhaustedEvents.push(info),
});

test("patch installs", () => {
	assert.equal(result.installed, true, result.reason);
});

test("constant off leaves Pi's exponential backoff untouched", async () => {
	constantDelayMs = 0;
	recorded.length = 0;
	const s = new FakeAgentSession({ enabled: true, maxRetries: 10, baseDelayMs: 2_000 });

	for (let i = 0; i < 5; i++) assert.equal(await s._prepareRetry({}), true);

	assert.deepEqual(recorded, [2_000, 4_000, 8_000, 16_000, 32_000]);
	assert.equal(retryEvents.length, 0, "hook stays out of the way when off");
});

test("constant on yields a fixed interval", async () => {
	constantDelayMs = 5_000;
	recorded.length = 0;
	retryEvents.length = 0;
	const s = new FakeAgentSession({ enabled: true, maxRetries: 1_000_000, baseDelayMs: 2_000 });

	for (let i = 0; i < 12; i++) assert.equal(await s._prepareRetry({}), true);

	assert.deepEqual(recorded, Array(12).fill(5_000));
	assert.deepEqual(
		retryEvents.map((e) => e.attempt),
		[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
		"reported attempt numbers are the true cumulative count",
	);
	assert.ok(
		retryEvents.every((e) => e.delayMs === 5_000),
		"hook reports the real interval",
	);
});

test("settingsManager is left clean after each call", async () => {
	constantDelayMs = 3_000;
	const s = new FakeAgentSession({ enabled: true, maxRetries: 100, baseDelayMs: 2_000 });

	await s._prepareRetry({});

	assert.equal(
		Object.hasOwn(s.settingsManager, "getRetrySettings"),
		false,
		"shadow must not outlive the call",
	);
	assert.deepEqual(s.settingsManager.getRetrySettings(), {
		enabled: true,
		maxRetries: 100,
		baseDelayMs: 2_000,
		// baseDelayMs is reported unscaled once the call is over.
	});
});

test("an existing own getRetrySettings property is restored exactly", async () => {
	constantDelayMs = 3_000;
	const s = new FakeAgentSession({ enabled: true, maxRetries: 100, baseDelayMs: 2_000 });
	const ownMethod = () => ({ enabled: true, maxRetries: 100, baseDelayMs: 2_000 });
	Object.defineProperty(s.settingsManager, "getRetrySettings", {
		configurable: true,
		enumerable: true,
		writable: false,
		value: ownMethod,
	});

	await s._prepareRetry({});

	assert.deepEqual(Object.getOwnPropertyDescriptor(s.settingsManager, "getRetrySettings"), {
		configurable: true,
		enumerable: true,
		writable: false,
		value: ownMethod,
	});
});

test("the failed assistant turn is still removed from agent state", async () => {
	constantDelayMs = 1_000;
	const s = new FakeAgentSession({ enabled: true, maxRetries: 100, baseDelayMs: 2_000 });

	await s._prepareRetry({});

	assert.deepEqual(s.agent.state.messages, [{ role: "user" }], "built-in cleanup still runs");
});

test("our budget refuses past maxRetries and reports exhaustion", async () => {
	constantDelayMs = 1_000;
	maxRetries = 3;
	recorded.length = 0;
	exhaustedEvents.length = 0;
	// Pi's own budget is deliberately looser so ours is the one under test.
	const s = new FakeAgentSession({ enabled: true, maxRetries: 1_000_000, baseDelayMs: 2_000 });

	assert.equal(await s._prepareRetry({}), true);
	assert.equal(await s._prepareRetry({}), true);
	assert.equal(await s._prepareRetry({}), true);
	assert.equal(await s._prepareRetry({}), false, "fourth attempt refused");

	assert.deepEqual(recorded, [1_000, 1_000, 1_000]);
	assert.deepEqual(exhaustedEvents, [{ attempt: 3, maxRetries: 3 }]);
	maxRetries = 1_000_000;
});

test("a successful turn restarts the sequence", async () => {
	constantDelayMs = 2_000;
	maxRetries = 2;
	recorded.length = 0;
	const s = new FakeAgentSession({ enabled: true, maxRetries: 1_000_000, baseDelayMs: 2_000 });

	assert.equal(await s._prepareRetry({}), true);
	assert.equal(await s._prepareRetry({}), true);
	assert.equal(await s._prepareRetry({}), false, "budget spent");

	// Pi zeroes _retryAttempt on a successful assistant turn.
	s._retryAttempt = 0;

	assert.equal(await s._prepareRetry({}), true, "budget refreshed after success");
	assert.deepEqual(recorded, [2_000, 2_000, 2_000]);
	maxRetries = 1_000_000;
});

test("disabled retry settings short-circuit before our accounting", async () => {
	constantDelayMs = 2_000;
	recorded.length = 0;
	const s = new FakeAgentSession({ enabled: false, maxRetries: 10, baseDelayMs: 2_000 });

	assert.equal(await s._prepareRetry({}), false);
	assert.deepEqual(recorded, []);
});
