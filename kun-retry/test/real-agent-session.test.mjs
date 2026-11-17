import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { bindRetryHooks, installConstantDelayPatch } from "../src/retry-patch.ts";
import { registerSession, resolveSession } from "../src/session-registry.ts";
import { beginSoftAbort, installSoftAbortPatch } from "../src/soft-abort.ts";

/**
 * REAL SDK retry/classification/post-run/abort methods, with fake session state
 * and mock backoff timers. No provider is called. Persistence/compaction are
 * stubbed: they require a transcript, not just the SessionManager identity that
 * these session-scoped adapters must use.
 */
const originalAbort = AgentSession.prototype.abort;
const installed = installConstantDelayPatch(AgentSession);
const softAbortInstalled = installSoftAbortPatch(AgentSession);

const CORE_SETTINGS = { enabled: true, maxRetries: 1_000_000, baseDelayMs: 10_000 };
const retryableMessage = () => ({
	role: "assistant",
	content: [],
	stopReason: "error",
	errorMessage: "[stall-watchdog-retry] provider returned error; treating stalled provider stream as retryable.",
});

function makeRealSession({ settings = {}, manager = {}, attempt = 0 } = {}) {
	const session = Object.create(AgentSession.prototype);
	const events = [];
	const omitted = [];
	let agentAborts = 0;
	const coreSettings = { ...CORE_SETTINGS, ...settings };
	session.sessionManager = manager;
	session.settingsManager = { getRetrySettings: () => coreSettings };
	session._retryAttempt = attempt;
	session._agentRunAbortRequested = false;
	session._isAgentRunActive = true;
	session._lastAssistantToolResults = [];
	session._emit = (event) => events.push(event);
	session._omitRecoveryAttempt = (message) => omitted.push(message);
	session._checkCompaction = async () => false;
	session.waitForIdle = async () => {};
	session.agent = {
		abort() { agentAborts += 1; },
		state: { messages: [], model: { provider: "test", id: "no-network", contextWindow: 128_000 } },
		hasQueuedMessages: () => false,
	};
	return { session, events, omitted, coreSettings, agentAborts: () => agentAborts };
}

const constantHooks = (targetMs, overrides = {}) => ({
	getConstantDelayMs: () => targetMs,
	getMaxRetries: () => CORE_SETTINGS.maxRetries,
	...overrides,
});

/** Finish a real backoff without cancelling its retry sequence. */
async function prepare(probe, message = retryableMessage()) {
	const startIndex = probe.events.length;
	const pending = AgentSession.prototype._prepareRetry.call(probe.session, message);
	const start = probe.events.slice(startIndex).find((event) => event.type === "auto_retry_start");
	if (start) mock.timers.tick(start.delayMs);
	const result = await pending;
	return { result, start };
}

async function realRetryDelay({ targetMs, attemptOnEntry = 0, settings = {} }) {
	const probe = makeRealSession({ settings, attempt: attemptOnEntry });
	const getSettings = probe.session.settingsManager.getRetrySettings;
	const unbind = bindRetryHooks(probe.session.sessionManager, constantHooks(targetMs));
	try {
		const { result, start } = await prepare(probe);
		assert.equal(result, true);
		assert.equal(probe.omitted.length, 1, "the real core still owns recovery omission");
		assert.equal(probe.session.settingsManager.getRetrySettings, getSettings, "temporary shadow restored");
		assert.deepEqual(getSettings(), { ...CORE_SETTINGS, ...settings }, "core settings were not mutated");
		return start?.delayMs;
	} finally {
		unbind();
	}
}

test.beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "Date"] }));
test.afterEach(() => mock.timers.reset());

test("real SDK has adapter internals and soft abort never patches user abort", () => {
	for (const name of ["_prepareRetry", "_handlePostAgentRun", "_bindExtensionCore", "bindExtensions", "abort"]) {
		assert.equal(typeof AgentSession.prototype[name], "function", name);
	}
	assert.equal(installed.installed, true, installed.reason);
	assert.equal(softAbortInstalled.installed, true, softAbortInstalled.reason);
	assert.equal(AgentSession.prototype.abort, originalAbort);
	assert.equal(installConstantDelayPatch(AgentSession).installed, true, "installation is idempotent");
	assert.equal(installSoftAbortPatch(AgentSession).installed, true);
	assert.equal(AgentSession.prototype.abort, originalAbort);
});

test("real _prepareRetry honours exact constant intervals", async () => {
	for (const targetMs of [1, 1_000, 5_000, 60_000]) {
		assert.equal(await realRetryDelay({ targetMs }), targetMs);
	}
});

test("constant mode raises only this call's cap, without a settings-file bridge", async () => {
	assert.equal(await realRetryDelay({ targetMs: 90_000 }), 90_000, "default cap must not truncate constant mode");
	assert.equal(await realRetryDelay({ targetMs: 90_000, settings: { maxAgentDelayMs: 20_000 } }), 90_000);
	assert.equal(await realRetryDelay({ targetMs: 3_600_000 }), 3_600_000);
});

test("real exponential mode keeps Pi's default 60s cap", async () => {
	assert.equal(await realRetryDelay({ targetMs: 0, attemptOnEntry: 0 }), 10_000);
	assert.equal(await realRetryDelay({ targetMs: 0, attemptOnEntry: 1 }), 20_000);
	assert.equal(await realRetryDelay({ targetMs: 0, attemptOnEntry: 4 }), 60_000);
	assert.equal(await realRetryDelay({ targetMs: 0, attemptOnEntry: 4, settings: { maxAgentDelayMs: 120_000 } }), 120_000);
});

test("constant mode stays exact across exponent overflow without rewinding native budget", async () => {
	for (const attempt of [0, 1, 5, 20, 40, 999, 1000, 1500]) {
		assert.equal(await realRetryDelay({ targetMs: 5_000, attemptOnEntry: attempt }), 5_000, `attempt ${attempt}`);
	}
	const probe = makeRealSession({ attempt: 999 });
	const retries = [];
	const unbind = bindRetryHooks(probe.session.sessionManager, constantHooks(90_000, {
		getMaxRetries: () => 1001,
		onRetry: (info) => retries.push(info),
	}));
	try {
		assert.equal((await prepare(probe)).start.delayMs, 90_000);
		assert.equal(probe.session._retryAttempt, 1000);
		assert.equal((await prepare(probe)).start.delayMs, 90_000);
		assert.equal(probe.session._retryAttempt, 1001, "native attempt remains authoritative");
		assert.deepEqual(retries.map((info) => info.attempt), [1000, 1001]);
		assert.deepEqual(await prepare(probe), { result: false, start: undefined }, "cumulative budget still exhausts");
	} finally { unbind(); }
});

test("parent and child real sessions use separate manager hooks, not IDs or last-installed policy", async () => {
	const parent = makeRealSession({ manager: { getSessionId: () => "same-id" } });
	const child = makeRealSession({ manager: { getSessionId: () => "same-id" } });
	const parentUnbind = bindRetryHooks(parent.session.sessionManager, constantHooks(90_000));
	const childUnbind = bindRetryHooks(child.session.sessionManager, constantHooks(3_000));
	try {
		// Both adapters are in flight before either sleep finishes.
		const parentPending = AgentSession.prototype._prepareRetry.call(parent.session, retryableMessage());
		const childPending = AgentSession.prototype._prepareRetry.call(child.session, retryableMessage());
		assert.equal(parent.events[0].delayMs, 90_000);
		assert.equal(child.events[0].delayMs, 3_000);
		mock.timers.tick(90_000);
		assert.deepEqual(await Promise.all([parentPending, childPending]), [true, true]);
		childUnbind();
		assert.equal((await prepare(parent)).start.delayMs, 90_000, "child shutdown cannot remove parent policy");
		assert.equal((await prepare(child)).start.delayMs, 20_000, "unbound child uses core settings");
	} finally { parentUnbind(); childUnbind(); }
});

test("late old unbind cannot remove replacement hooks for the same manager", async () => {
	const probe = makeRealSession();
	const oldUnbind = bindRetryHooks(probe.session.sessionManager, constantHooks(1_000));
	const newUnbind = bindRetryHooks(probe.session.sessionManager, constantHooks(90_000));
	try {
		oldUnbind();
		assert.equal((await prepare(probe)).start.delayMs, 90_000);
		newUnbind();
		assert.equal((await prepare(probe)).start.delayMs, 20_000);
	} finally { oldUnbind(); newUnbind(); }
});

test("live settings override enabled, budget and exponential base without mutating core settings", async () => {
	const probe = makeRealSession({ settings: { enabled: false, maxRetries: 0, baseDelayMs: 11 } });
	let live = { enabled: true, maxRetries: 2, baseDelayMs: 7_000 };
	const unbind = bindRetryHooks(probe.session.sessionManager, constantHooks(0, { getSettings: () => live }));
	try {
		assert.equal((await prepare(probe)).start.delayMs, 7_000);
		live = { ...live, baseDelayMs: 3_000 };
		assert.equal((await prepare(probe)).start.delayMs, 6_000, "next call sees live delay");
		assert.equal((await prepare(probe)).result, false, "live retry budget exhausted");
		live = { ...live, enabled: false, maxRetries: 10 };
		assert.equal((await prepare(probe)).result, false, "live disable is immediate");
		live = undefined;
		assert.equal((await prepare(probe)).result, false, "syncSettings=false preserves disabled project/core settings");
		assert.deepEqual(probe.session.settingsManager.getRetrySettings(), probe.coreSettings);
	} finally { unbind(); }
});

test("throwing onRetry/onExhausted/record observers never interrupt real core retry", async () => {
	const probe = makeRealSession();
	const phases = [];
	const unbind = bindRetryHooks(probe.session.sessionManager, constantHooks(90_000, {
		getMaxRetries: () => 1,
		onRetry() { throw new Error("stale UI"); },
		onExhausted() { throw new Error("stale UI"); },
		record(phase) { phases.push(phase); throw new Error("stale persistence"); },
	}));
	try {
		assert.equal((await prepare(probe)).start.delayMs, 90_000);
		assert.equal((await prepare(probe)).result, false);
		assert.ok(phases.includes("callback_failed"));
		assert.equal(probe.omitted.length, 1);
	} finally { unbind(); }
});

test("policy getter failures delegate to real core rather than breaking a retry", async () => {
	const probe = makeRealSession();
	const unbind = bindRetryHooks(probe.session.sessionManager, constantHooks(90_000, {
		getSettings() { throw new Error("policy unavailable"); },
		record() { throw new Error("observer unavailable"); },
	}));
	try { assert.equal((await prepare(probe)).start.delayMs, 10_000); }
	finally { unbind(); }
});

test("soft abort capture precedes real _bindExtensionCore binding, including reload recapture", () => {
	const probe = makeRealSession();
	const manager = probe.session.sessionManager;
	const capture = (session) => AgentSession.prototype._bindExtensionCore.call(session, {
		bindCore(core, context) {
			assert.equal(resolveSession(manager), session, "captured before real core binding callback");
			assert.equal(typeof core.appendEntry, "function");
			assert.equal(typeof context.abort, "function");
		},
	});
	capture(probe.session);
	assert.equal(resolveSession(manager), probe.session);
	assert.equal(beginSoftAbort(manager), "direct");
	assert.equal(probe.agentAborts(), 1);
	assert.equal(probe.session._agentRunAbortRequested, false);

	const replacement = makeRealSession({ manager });
	capture(replacement.session);
	assert.equal(resolveSession(manager), replacement.session, "reload/construction recaptures owning session");
	assert.equal(beginSoftAbort(manager), "direct");
	assert.equal(replacement.agentAborts(), 1);
	assert.equal(probe.agentAborts(), 1, "old session is no longer targeted");
});

test("bindExtensions wrapper registers before its real body and host injection can capture incomplete state", async () => {
	const probe = makeRealSession();
	let capturedInBody = false;
	probe.session._applyExtensionBindings = () => {
		capturedInBody = resolveSession(probe.session.sessionManager) === probe.session;
		throw new Error("incomplete extension runtime");
	};
	await assert.rejects(AgentSession.prototype.bindExtensions.call(probe.session, {}), /incomplete extension runtime/);
	assert.equal(capturedInBody, true, "registration precedes the real binding body even if it fails");
	// Failed bindings may roll back; embedders can inject a known session explicitly.
	registerSession(probe.session);
	assert.equal(resolveSession(probe.session.sessionManager), probe.session);
	assert.equal(beginSoftAbort(probe.session.sessionManager), "direct");
	assert.equal(probe.agentAborts(), 1);
});

test("soft abort requires exact manager identity and refuses unknown/cancelled/idle/compacting ownership", () => {
	const parent = makeRealSession({ manager: { getSessionId: () => "same-id" } });
	const child = makeRealSession({ manager: { getSessionId: () => "same-id" } });
	registerSession(parent.session);
	registerSession(child.session);
	assert.equal(beginSoftAbort(undefined), "unavailable");
	assert.equal(beginSoftAbort({ getSessionId: () => "same-id" }), "unavailable");
	assert.equal(beginSoftAbort(parent.session.sessionManager), "direct");
	assert.equal(parent.agentAborts(), 1);
	assert.equal(child.agentAborts(), 0);
	parent.session._agentRunAbortRequested = true;
	assert.equal(beginSoftAbort(parent.session.sessionManager), "unavailable");
	parent.session._agentRunAbortRequested = false;
	parent.session._isAgentRunActive = false;
	assert.equal(beginSoftAbort(parent.session.sessionManager), "unavailable");
	parent.session._isAgentRunActive = true;
	parent.session._compactionAbortController = new AbortController();
	assert.equal(beginSoftAbort(parent.session.sessionManager), "unavailable");
	assert.equal(parent.agentAborts(), 1);
	assert.equal(child.agentAborts(), 0);
});

test("soft abort reaches real classification, post-run retry and real _prepareRetry", async () => {
	const probe = makeRealSession();
	registerSession(probe.session);
	const message = retryableMessage();
	assert.equal(beginSoftAbort(probe.session.sessionManager), "direct");
	assert.equal(probe.session._agentRunAbortRequested, false);
	assert.equal(AgentSession.prototype._isRetryableError.call(probe.session, message), true);
	probe.session._lastAssistantMessage = message;
	const pending = AgentSession.prototype._handlePostAgentRun.call(probe.session);
	assert.equal(probe.events[0].type, "auto_retry_start");
	mock.timers.tick(probe.events[0].delayMs);
	assert.equal(await pending, true);
	assert.equal(probe.session._failedResponse, message);
	assert.equal(probe.omitted[0], message);
});

test("Escape still executes real abort, cancels the backoff and prevents post-run retry", async () => {
	const probe = makeRealSession();
	registerSession(probe.session);
	const unbind = bindRetryHooks(probe.session.sessionManager, constantHooks(90_000));
	try {
		const pending = AgentSession.prototype._prepareRetry.call(probe.session, retryableMessage());
		assert.ok(probe.session._retryAbortController, "core backoff is active");
		assert.equal(beginSoftAbort(probe.session.sessionManager), "direct");
		assert.equal(probe.session._agentRunAbortRequested, false);
		await AgentSession.prototype.abort.call(probe.session);
		assert.equal(await pending, false, "real abortRetry cancels sleep");
		assert.equal(probe.session._agentRunAbortRequested, true);
		assert.equal(probe.agentAborts(), 2);
		assert.equal(probe.session._retryAttempt, 0);
		probe.session._lastAssistantMessage = retryableMessage();
		assert.equal(await AgentSession.prototype._handlePostAgentRun.call(probe.session), false);
		assert.equal(probe.events.filter((event) => event.type === "auto_retry_start").length, 1, "user-cancelled run never schedules another retry");
	} finally { unbind(); }
});
