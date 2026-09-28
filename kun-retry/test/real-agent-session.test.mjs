import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { installConstantDelayPatch } from "../src/retry-patch.ts";
import { beginSoftAbort, installSoftAbortPatch } from "../src/soft-abort.ts";

/**
 * Integration tests that drive the REAL `AgentSession.prototype` internals.
 *
 * The sibling `retry-patch-wrapper.test.mjs` uses a stand-in class that mirrors
 * Pi's `_prepareRetry`. That runs fast but silently drifts whenever Pi changes its
 * formula — which is exactly how a `maxAgentDelayMs` cap introduced in Pi 0.86.0
 * went unnoticed. These tests call the real prototype instead so such changes fail
 * loudly.
 *
 * `_prepareRetry` sleeps for the computed delay before returning, so the tests
 * abort the retry immediately from the `auto_retry_start` event to keep them fast.
 */

let constantDelayMs = 0;

const installed = installConstantDelayPatch(AgentSession, {
	getConstantDelayMs: () => constantDelayMs,
	getMaxRetries: () => 1_000_000,
});
installSoftAbortPatch(AgentSession);

/** Drive the real `_prepareRetry` and capture the delay Pi actually computed. */
async function realRetryDelay({ targetMs, attemptOnEntry = 0, settings = {} }) {
	constantDelayMs = targetMs;
	const emitted = [];
	const session = Object.create(AgentSession.prototype);
	session._retryAttempt = attemptOnEntry;
	session.settingsManager = {
		getRetrySettings: () => ({
			enabled: true,
			maxRetries: 1_000_000,
			baseDelayMs: 10_000,
			...settings,
		}),
	};
	session._emit = (event) => {
		emitted.push(event);
		if (event.type === "auto_retry_start") {
			// Cancel the backoff sleep right away; the delay is already recorded.
			setTimeout(() => session._retryAbortController?.abort(), 0);
		}
	};
	session._finishCancelledRetry = () => {};
	session.agent = { state: { messages: [{ role: "user" }, { role: "assistant" }] } };

	await AgentSession.prototype._prepareRetry.call(session, { errorMessage: "probe" });
	const start = emitted.find((event) => event.type === "auto_retry_start");
	return start?.delayMs;
}

test("real AgentSession exists with the internals both patches rely on", () => {
	assert.equal(typeof AgentSession.prototype._prepareRetry, "function");
	assert.equal(typeof AgentSession.prototype.bindExtensions, "function");
	assert.equal(typeof AgentSession.prototype.abort, "function");
	assert.equal(installed.installed, true, installed.reason);
});

test("real Pi_ prepareRetry honours the constant interval", async () => {
	assert.equal(await realRetryDelay({ targetMs: 5_000 }), 5_000);
	assert.equal(await realRetryDelay({ targetMs: 1_000 }), 1_000);
});

test("real Pi caps the delay at retry.maxAgentDelayMs, and constant mode stays exact under it", async () => {
	// Under the cap: exact.
	assert.equal(await realRetryDelay({ targetMs: 60_000 }), 60_000);

	// Above the default 60s cap: Pi truncates it. This is the behaviour the
	// settings-bridge compensates for by raising retry.maxAgentDelayMs.
	assert.equal(await realRetryDelay({ targetMs: 90_000 }), 60_000);

	// Raising the cap in settings restores the configured interval.
	assert.equal(await realRetryDelay({ targetMs: 90_000, settings: { maxAgentDelayMs: 90_000 } }), 90_000);
	assert.equal(await realRetryDelay({ targetMs: 3_600_000, settings: { maxAgentDelayMs: 3_600_000 } }), 3_600_000);
});

test("real Pi stays exact across many attempts even with a large exponent", async () => {
	for (const attempt of [0, 1, 5, 20, 40]) {
		assert.equal(await realRetryDelay({ targetMs: 5_000, attemptOnEntry: attempt }), 5_000, `attempt ${attempt}`);
	}
});

test("soft abort tears down only the stream, so Pi still auto-retries", async () => {
	// The capture hook runs before the real bindExtensions body, so an incomplete
	// session object still proves capture works.
	const fakeSession = {
		aborted: 0,
		agent: {
			abort() {
				fakeSession.aborted += 1;
			},
		},
		waitForIdle: async () => {},
	};
	await AgentSession.prototype
		.bindExtensions.call(fakeSession, {})
		.catch(() => {});
	assert.equal(beginSoftAbort(), "direct", "a captured session is aborted directly");
	assert.equal(fakeSession.aborted, 1, "the stream was aborted");

	// The decisive part: Pi's post-run handler retries when the run is NOT marked
	// user-cancelled. `ctx.abort()` would set that flag and skip `_prepareRetry`.
	let prepared = 0;
	const session = Object.create(AgentSession.prototype);
	session._agentRunAbortRequested = false;
	session._lastAssistantMessage = {
		role: "assistant",
		stopReason: "error",
		errorMessage: "[stall-watchdog-retry] provider returned error; treating stalled provider stream as retryable.",
	};
	session._retryAttempt = 1;
	session._isRetryableError = () => true;
	session._prepareRetry = async () => {
		prepared += 1;
		return true;
	};
	session._finishCancelledRetry = () => {};
	session._checkCompaction = async () => false;
	session._emit = () => {};
	session.agent = { hasQueuedMessages: () => false };

	const willRetry = await AgentSession.prototype._handlePostAgentRun.call(session);
	assert.equal(prepared, 1, "retry path ran after a soft abort");
	assert.equal(willRetry, true);
});

test("a user-cancelled run still skips retry (the bug we route around)", async () => {
	let prepared = 0;
	const session = Object.create(AgentSession.prototype);
	session._agentRunAbortRequested = true;
	session._lastAssistantMessage = {
		role: "assistant",
		stopReason: "error",
		errorMessage: "[stall-watchdog-retry] provider returned error",
	};
	session._retryAttempt = 1;
	session._isRetryableError = () => true;
	session._prepareRetry = async () => {
		prepared += 1;
		return true;
	};
	session._finishCancelledRetry = () => {};
	session._checkCompaction = async () => false;
	session._emit = () => {};
	session.agent = { hasQueuedMessages: () => false };

	const willRetry = await AgentSession.prototype._handlePostAgentRun.call(session);
	assert.equal(prepared, 0, "no retry when the run is marked user-cancelled");
	assert.equal(willRetry, false);
});