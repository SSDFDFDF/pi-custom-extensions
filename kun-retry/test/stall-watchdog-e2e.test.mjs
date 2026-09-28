import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { AgentSession } from "@earendil-works/pi-coding-agent";

/**
 * End-to-end test of the stall-watchdog retry path.
 *
 * Drives the REAL extension factory with the REAL `AgentSession.prototype`, so the
 * whole chain is exercised: watchdog fires -> soft abort -> `message_end` rewrite ->
 * `_handlePostAgentRun` -> `_prepareRetry`.
 *
 * Regression coverage for two bugs:
 *   1. `ctx.abort()` marked the run user-cancelled, so Pi silently skipped retry
 *      ("matched but never retried").
 *   2. Capture was tied to `bindExtensions`, which interactive mode calls once per
 *      process, so a `/reload`ed instance had no direct route and fell back to the
 *      retry-suppressing abort.
 */

// Point config/settings at a throwaway dir so the test never touches real files.
const tempAgentDir = mkdtempSync(join(tmpdir(), "kun-retry-e2e-"));
process.env.PI_CODING_AGENT_DIR = tempAgentDir;
test.after(() => rmSync(tempAgentDir, { recursive: true, force: true }));

const { default: createKunRetry } = await import("../src/index.ts");
const { forgetCapturedSession } = await import("../src/soft-abort.ts");

function makeExtensionHarness() {
	const handlers = {};
	const flags = new Map();
	const pi = {
		registerFlag: (name, options) => flags.set(name, options),
		getFlag: (name) => flags.get(name),
		registerCommand: () => {},
		registerMessageRenderer: () => {},
		on: (event, handler) => {
			handlers[event] = handler;
		},
	};
	createKunRetry(pi);
	return { handlers };
}

/**
 * A UI context whose `abort()` routes into the REAL `AgentSession.prototype.abort`,
 * exactly as interactive mode does. `sessionAborts` counts sessions that reached the
 * user-cancel path.
 */
function makeUiContext(session) {
	const notices = [];
	const statuses = [];
	const ctx = {
		hasUI: true,
		mode: "tui",
		cwd: tempAgentDir,
		isIdle: () => true,
		ui: {
			notify: (text, level) => notices.push({ text, level }),
			setStatus: (key, text) => statuses.push({ key, text }),
		},
		notices,
		statuses,
		abortCalls: 0,
	};
	ctx.abort = () => {
		ctx.abortCalls += 1;
		void AgentSession.prototype.abort.call(session);
	};
	return ctx;
}

async function makeRealSession({ captured = true } = {}) {
	const session = Object.create(AgentSession.prototype);
	let agentAborts = 0;
	let cancelledFlags = 0;
	session.agent = {
		abort: () => {
			agentAborts += 1;
		},
		state: { messages: [{ role: "user" }, { role: "assistant" }] },
		hasQueuedMessages: () => false,
	};
	session.waitForIdle = async () => {};
	session._agentRunAbortRequested = false;
	session._retryAttempt = 0;
	session._emit = () => {};
	session._finishCancelledRetry = () => {
		cancelledFlags += 1;
	};
	session._checkCompaction = async () => false;
	let prepareRetryCalls = 0;
	session._prepareRetry = async () => {
		prepareRetryCalls += 1;
		return true;
	};

	if (captured) {
		// The real body needs a full runtime binding; capture-before-throw suffices.
		await AgentSession.prototype.bindExtensions.call(session, {}).catch(() => {});
	} else {
		forgetCapturedSession();
	}

	return {
		session,
		agentAborts: () => agentAborts,
		prepareRetryCalls: () => prepareRetryCalls,
		wasCancelled: () => session._agentRunAbortRequested === true,
	};
}

/** Run one watchdog cycle and return the rewritten message. */
async function runWatchdogCycle(handlers, ctx) {
	ctx.isIdle = () => false;
	await handlers.session_start({ type: "session_start", reason: "startup" }, ctx);
	await handlers.before_provider_request({ type: "before_provider_request" }, ctx);
	mock.timers.tick(90_000); // past the default 90s stall timeout

	const rewritten = await handlers.message_end(
		{
			type: "message_end",
			message: {
				role: "assistant",
				content: [],
				stopReason: "aborted",
				errorMessage: "Error: Request was aborted",
			},
		},
		ctx,
	);
	return rewritten;
}

test("stalled stream is retried via the direct soft-abort route", async (t) => {
	mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	t.after(() => mock.timers.reset());

	const { handlers } = makeExtensionHarness();
	const { session, agentAborts, prepareRetryCalls, wasCancelled } = await makeRealSession();
	const ctx = makeUiContext(session);

	const rewritten = await runWatchdogCycle(handlers, ctx);

	assert.equal(agentAborts(), 1, "watchdog aborted the stalled provider stream");
	assert.equal(ctx.abortCalls, 0, "direct route must not call ctx.abort()");
	assert.equal(wasCancelled(), false, "run is not marked user-cancelled, so retry can run");
	assert.equal(rewritten?.message?.stopReason, "error", "stalled turn rewritten as retryable");

	// Pi's real classifier must accept the rewritten text.
	assert.equal(
		AgentSession.prototype._isRetryableError.call(session, rewritten.message),
		true,
		"Pi treats the stall as retryable",
	);

	// The decisive assertion: the retry decision is actually reached.
	session._lastAssistantMessage = rewritten.message;
	const willRetry = await AgentSession.prototype._handlePostAgentRun.call(session);
	assert.equal(prepareRetryCalls(), 1, "_prepareRetry was reached");
	assert.equal(willRetry, true, "Pi continues the run for another attempt");
});

test("a /reloaded session (no capture) still retries via the deferred route", async (t) => {
	mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	t.after(() => mock.timers.reset());

	// This is the exact situation that broke after `/reload`: interactive mode does
	// not re-run bindExtensions, so there is no captured session. The watchdog calls
	// ctx.abort(), and the armed flag must convert it into a soft abort.
	const { handlers } = makeExtensionHarness();
	const { session, agentAborts, prepareRetryCalls, wasCancelled } = await makeRealSession({ captured: false });
	const ctx = makeUiContext(session);

	const rewritten = await runWatchdogCycle(handlers, ctx);

	assert.equal(ctx.abortCalls, 1, "deferred route goes through ctx.abort()");
	assert.equal(agentAborts(), 1, "the patched session abort aborted only the stream");
	assert.equal(wasCancelled(), false, "the run was NOT marked user-cancelled");
	assert.ok(rewritten?.message);

	session._lastAssistantMessage = rewritten.message;
	const willRetry = await AgentSession.prototype._handlePostAgentRun.call(session);
	assert.equal(prepareRetryCalls(), 1, "retry path ran after the deferred soft abort");
	assert.equal(willRetry, true);
});

test("armed flag is one-shot: a later user abort cancels normally", async (t) => {
	mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	t.after(() => mock.timers.reset());

	const { handlers } = makeExtensionHarness();
	const { session, agentAborts } = await makeRealSession({ captured: false });
	const ctx = makeUiContext(session);

	await runWatchdogCycle(handlers, ctx);
	assert.equal(session._agentRunAbortRequested, false, "watchdog soft-aborted without cancelling");
	assert.equal(agentAborts(), 1, "only the soft abort touched the stream");

	// The next abort is a genuine user cancel (Escape). Real abort() only cancels
	// while a run is active, so provide the flags the real body reads.
	session._isAgentRunActive = true;
	session.abortRetry = () => {};
	session.abortCompaction = () => {};
	session.abortBranchSummary = () => {};
	await AgentSession.prototype.abort.call(session);

	assert.equal(session._agentRunAbortRequested, true, "user abort still cancels the run");
	assert.equal(agentAborts(), 2, "user abort took the real path and stopped the run");
});

test("watchdog disarms on a successful turn and never fires", async (t) => {
	mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	t.after(() => mock.timers.reset());

	const { handlers } = makeExtensionHarness();
	const { session, agentAborts } = await makeRealSession();
	const ctx = makeUiContext(session);

	ctx.isIdle = () => false;
	await handlers.session_start({ type: "session_start", reason: "startup" }, ctx);
	await handlers.before_provider_request({ type: "before_provider_request" }, ctx);

	// A normal completion arrives well before the timeout.
	ctx.isIdle = () => true;
	await handlers.message_end(
		{
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
		},
		ctx,
	);
	mock.timers.tick(600_000);

	assert.equal(agentAborts(), 0, "watchdog disarmed after the turn completed");
	assert.equal(ctx.abortCalls, 0);
});

test("regression guard: a genuine user cancel skips retry (the old failure mode)", async () => {
	// Documents why the watchdog must not use the user-cancel path.
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
	assert.equal(prepared, 0, "user-cancelled runs are never retried");
	assert.equal(willRetry, false);
});