import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { AgentSession } from "@earendil-works/pi-coding-agent";

/**
 * Real extension factories + real SDK prototypes, fake session state and mock
 * timers only. No real model, SDK constructor, reload, or transcript is invoked.
 * The real classifier, _handlePostAgentRun, _prepareRetry and Escape abort run.
 * SessionManager OBJECT identity is the boundary, including parent/child factories
 * and reload; an unknown manager must never hard-abort or fake a retryable abort.
 */
const tempAgentDir = mkdtempSync(join(tmpdir(), "kun-retry-e2e-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousStallTimeout = process.env.PI_RETRY_STALL_TIMEOUT_MS;
process.env.PI_CODING_AGENT_DIR = tempAgentDir;
delete process.env.PI_RETRY_STALL_TIMEOUT_MS;
test.after(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	if (previousStallTimeout === undefined) delete process.env.PI_RETRY_STALL_TIMEOUT_MS;
	else process.env.PI_RETRY_STALL_TIMEOUT_MS = previousStallTimeout;
	rmSync(tempAgentDir, { recursive: true, force: true });
});

const { default: createKunRetry } = await import("../src/index.ts");
const { DEFAULT_CONFIG, saveConfig } = await import("../src/config.ts");
const { resolveSession } = await import("../src/session-registry.ts");
const STALL_MS = 90_000;
const CORE_SETTINGS = { enabled: true, maxRetries: 10, baseDelayMs: 2_000 };
const retryableMessage = () => ({
	role: "assistant", content: [], stopReason: "error", errorMessage: "provider returned error",
});
const abortedMessage = () => ({
	role: "assistant", content: [], stopReason: "aborted", errorMessage: "Error: Request was aborted",
});

test.beforeEach(() => {
	saveConfig({ ...DEFAULT_CONFIG, syncSettings: false, stallTimeoutMs: STALL_MS });
	mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
});
test.afterEach(() => mock.timers.reset());

function makeExtensionHarness(t) {
	const handlers = {};
	const commands = new Map();
	const flags = new Map();
	const entries = [];
	const pi = {
		registerFlag: () => {},
		getFlag: (name) => flags.get(name),
		registerCommand: (name, options) => commands.set(name, options),
		registerMessageRenderer: () => {},
		appendEntry: (customType, data) => entries.push({ customType, data }),
		on: (event, handler) => { handlers[event] = handler; },
	};
	createKunRetry(pi);
	let activeCtx;
	const harness = {
		handlers, commands, entries, flags,
		async start(ctx, reason = "startup") {
			activeCtx = ctx;
			await handlers.session_start({ type: "session_start", reason }, ctx);
		},
		async shutdown() {
			const ctx = activeCtx;
			activeCtx = undefined;
			if (ctx) await handlers.session_shutdown({ type: "session_shutdown" }, ctx);
		},
		async request(ctx) {
			ctx.isIdle = () => false;
			await handlers.before_provider_request({ type: "before_provider_request" }, ctx);
		},
		async end(ctx, message) {
			return handlers.message_end({ type: "message_end", message }, ctx);
		},
		async command(args, ctx) {
			assert.ok(commands.has("retry"), "/retry command registered");
			return commands.get("retry").handler(args, ctx);
		},
	};
	t.after(() => harness.shutdown());
	return harness;
}

/** Fake SDK state; the real _bindExtensionCore executes with a no-op runner. */
function makeRealSession({ captured = true, manager = {}, settings = {} } = {}) {
	const session = Object.create(AgentSession.prototype);
	const events = [];
	const omitted = [];
	let agentAborts = 0;
	const coreSettings = { ...CORE_SETTINGS, ...settings };
	session.sessionManager = manager;
	session.settingsManager = { getRetrySettings: () => coreSettings };
	session.agent = {
		abort() { agentAborts += 1; },
		state: { messages: [], model: { provider: "test", id: "no-network", contextWindow: 128_000 } },
		hasQueuedMessages: () => false,
	};
	session.waitForIdle = async () => {};
	session._isAgentRunActive = true;
	session._agentRunAbortRequested = false;
	session._retryAttempt = 0;
	session._lastAssistantToolResults = [];
	session._emit = (event) => events.push(event);
	session._omitRecoveryAttempt = (message) => omitted.push(message);
	session._checkCompaction = async () => false;
	const capture = () => {
		AgentSession.prototype._bindExtensionCore.call(session, {
			bindCore(core, context) {
				assert.equal(resolveSession(manager), session, "registered before the real core binding callback");
				assert.equal(typeof core.appendEntry, "function");
				assert.equal(typeof context.abort, "function");
			},
		});
		assert.equal(resolveSession(manager), session);
	};
	if (captured) capture();
	else assert.equal(resolveSession(manager), undefined);
	return { session, events, omitted, coreSettings, capture, agentAborts: () => agentAborts };
}

/** abort() takes the genuine Escape/user-cancel path, not a watchdog stub. */
function makeUiContext(probe, { manager = probe.session.sessionManager } = {}) {
	const notices = [];
	const statuses = [];
	const ctx = {
		sessionManager: manager,
		hasUI: true,
		mode: "tui",
		cwd: tempAgentDir,
		isIdle: () => false,
		ui: {
			notify: (text, level) => notices.push({ text, level }),
			setStatus: (key, text) => statuses.push({ key, text }),
		},
		notices, statuses,
		abortCalls: 0,
	};
	ctx.abort = () => {
		ctx.abortCalls += 1;
		void AgentSession.prototype.abort.call(probe.session);
	};
	return ctx;
}

function makeStale(ctx) {
	let getterReads = 0;
	Object.defineProperty(ctx, "hasUI", {
		configurable: true,
		get() { getterReads += 1; throw new Error("UI context belongs to a shut down session"); },
	});
	Object.defineProperty(ctx, "ui", {
		configurable: true,
		get() { getterReads += 1; throw new Error("stale ui getter"); },
	});
	return () => getterReads;
}

/** Assert actual SDK retry decision AND actual SDK backoff, not a fake _prepareRetry. */
async function finishCoreRetry(probe, message, expectedDelayMs) {
	assert.equal(AgentSession.prototype._isRetryableError.call(probe.session, message), true);
	probe.session._lastAssistantMessage = message;
	const priorEvents = probe.events.length;
	const pending = AgentSession.prototype._handlePostAgentRun.call(probe.session);
	const start = probe.events.slice(priorEvents).find((event) => event.type === "auto_retry_start");
	assert.ok(start, "real _handlePostAgentRun reached real _prepareRetry");
	assert.equal(start.delayMs, expectedDelayMs);
	mock.timers.tick(start.delayMs);
	assert.equal(await pending, true, "Pi continues the run for another attempt");
	assert.equal(probe.session._failedResponse, message);
	assert.equal(probe.omitted.at(-1), message, "core recovery omission still runs");
	assert.equal(probe.session._agentRunAbortRequested, false);
	return start;
}

async function watchdogMessage(harness, ctx, message = abortedMessage()) {
	await harness.request(ctx);
	mock.timers.tick(STALL_MS);
	return harness.end(ctx, message);
}

test("stalled stream is soft-aborted, rewritten and retried by the real SDK", async (t) => {
	const harness = makeExtensionHarness(t);
	const probe = makeRealSession();
	const ctx = makeUiContext(probe);
	await harness.start(ctx);
	const rewritten = await watchdogMessage(harness, ctx);
	assert.equal(probe.agentAborts(), 1);
	assert.equal(ctx.abortCalls, 0, "watchdog must never use user-cancel ctx.abort()");
	assert.equal(probe.session._agentRunAbortRequested, false);
	assert.equal(rewritten?.message?.stopReason, "error");
	assert.match(rewritten.message.errorMessage, /\[stall-watchdog-retry\]/);
	await finishCoreRetry(probe, rewritten.message, CORE_SETTINGS.baseDelayMs);
});

test("two extension factories: parent watchdog and retry policy never target child", async (t) => {
	saveConfig({ constantDelayMs: 90_000 });
	const parent = makeExtensionHarness(t);
	const parentProbe = makeRealSession({ manager: { getSessionId: () => "same-id" } });
	const parentCtx = makeUiContext(parentProbe);
	await parent.start(parentCtx);
	await parent.request(parentCtx);

	const child = makeExtensionHarness(t);
	const childProbe = makeRealSession({ manager: { getSessionId: () => "same-id" }, settings: { maxRetries: 0 } });
	const childCtx = makeUiContext(childProbe);
	await child.start(childCtx);
	// A child message must not become the parent's status/retry owner.
	await child.end(childCtx, { role: "assistant", content: [{ type: "text", text: "child done" }], stopReason: "stop" });
	mock.timers.tick(STALL_MS);
	assert.equal(parentProbe.agentAborts(), 1, "only the parent's provider stream was stopped");
	assert.equal(childProbe.agentAborts(), 0);
	assert.equal(parentCtx.abortCalls, 0);
	assert.equal(childCtx.abortCalls, 0);
	const rewritten = await parent.end(parentCtx, abortedMessage());
	assert.equal(rewritten?.message?.stopReason, "error");

	// Child's own core budget remains authoritative when syncSettings=false.
	childProbe.session._lastAssistantMessage = retryableMessage();
	assert.equal(await AgentSession.prototype._handlePostAgentRun.call(childProbe.session), false);
	assert.equal(childProbe.events.length, 0);
	await child.shutdown();
	const childReads = makeStale(childCtx);
	const childStatusCount = childCtx.statuses.length;
	await finishCoreRetry(parentProbe, rewritten.message, 90_000);
	assert.equal(childReads(), 0, "parent core retry must not consult child's stale hasUI/ui getters");
	assert.equal(childCtx.statuses.length, childStatusCount);
	assert.ok(parentCtx.statuses.some(({ text }) => typeof text === "string" && text.includes("retrying")));
});

test("child shutdown invalidates its old watchdog without disarming parent watchdog", async (t) => {
	const parent = makeExtensionHarness(t);
	const parentProbe = makeRealSession();
	const parentCtx = makeUiContext(parentProbe);
	await parent.start(parentCtx);
	await parent.request(parentCtx);
	const child = makeExtensionHarness(t);
	const childProbe = makeRealSession();
	const childCtx = makeUiContext(childProbe);
	await child.start(childCtx);
	await child.request(childCtx);
	await child.shutdown();
	const staleReads = makeStale(childCtx);
	mock.timers.tick(STALL_MS * 2);
	assert.equal(parentProbe.agentAborts(), 1);
	assert.equal(childProbe.agentAborts(), 0, "old child timer is terminal after shutdown");
	assert.equal(staleReads(), 0);
	assert.equal(parentCtx.abortCalls + childCtx.abortCalls, 0);
	assert.equal((await parent.end(parentCtx, abortedMessage()))?.message?.stopReason, "error");
});

test("shutdown unbinds retry hooks and a pending old watchdog cannot fire", async (t) => {
	saveConfig({ constantDelayMs: 90_000 });
	const harness = makeExtensionHarness(t);
	const probe = makeRealSession();
	const ctx = makeUiContext(probe);
	await harness.start(ctx);
	await harness.request(ctx);
	mock.timers.tick(STALL_MS - 1);
	await harness.shutdown();
	const staleReads = makeStale(ctx);
	mock.timers.tick(STALL_MS * 4);
	assert.equal(probe.agentAborts(), 0);
	assert.equal(ctx.abortCalls, 0);
	await finishCoreRetry(probe, retryableMessage(), CORE_SETTINGS.baseDelayMs);
	assert.equal(staleReads(), 0, "unbound core retry never reads disposed context");
});

test("/reload new context with same manager works through _bindExtensionCore, without bindExtensions fallback", async (t) => {
	saveConfig({ constantDelayMs: 90_000 });
	const oldHarness = makeExtensionHarness(t);
	const probe = makeRealSession();
	const oldCtx = makeUiContext(probe);
	await oldHarness.start(oldCtx);
	await oldHarness.request(oldCtx);
	mock.timers.tick(STALL_MS / 2);
	await oldHarness.shutdown();
	const oldReads = makeStale(oldCtx);

	const reloaded = makeExtensionHarness(t);
	// Same session/manager, new extension core binding and new lifecycle ctx.
	// Never invoke bindExtensions here: interactive reload doesn't require it.
	probe.capture();
	const newCtx = makeUiContext(probe);
	await reloaded.start(newCtx, "reload");
	await reloaded.request(newCtx);
	mock.timers.tick(STALL_MS / 2);
	assert.equal(probe.agentAborts(), 0, "old deadline must not abort the new request");
	mock.timers.tick(STALL_MS / 2);
	assert.equal(probe.agentAborts(), 1);
	assert.equal(oldCtx.abortCalls + newCtx.abortCalls, 0);
	const rewritten = await reloaded.end(newCtx, abortedMessage());
	assert.equal(rewritten?.message?.stopReason, "error");
	await finishCoreRetry(probe, rewritten.message, 90_000);
	assert.equal(oldReads(), 0);
});

test("late old shutdown cannot unbind replacement factory hooks on the same manager", async (t) => {
	saveConfig({ constantDelayMs: 90_000 });
	const oldHarness = makeExtensionHarness(t);
	const probe = makeRealSession();
	const oldCtx = makeUiContext(probe);
	await oldHarness.start(oldCtx);
	await oldHarness.request(oldCtx);
	const replacement = makeExtensionHarness(t);
	probe.capture();
	const newCtx = makeUiContext(probe);
	await replacement.start(newCtx, "reload");
	await oldHarness.shutdown();
	const oldReads = makeStale(oldCtx);
	await replacement.request(newCtx);
	mock.timers.tick(STALL_MS);
	assert.equal(probe.agentAborts(), 1, "only replacement's request fired");
	const rewritten = await replacement.end(newCtx, abortedMessage());
	await finishCoreRetry(probe, rewritten.message, 90_000);
	assert.equal(oldReads(), 0);
});

test("unknown manager fails closed: no hard abort and no invented aborted-message rewrite", async (t) => {
	const harness = makeExtensionHarness(t);
	const knownProbe = makeRealSession();
	const unknownProbe = makeRealSession({ captured: false });
	const knownCtx = makeUiContext(knownProbe);
	const unknownCtx = makeUiContext(unknownProbe);
	await harness.start(unknownCtx);
	const message = abortedMessage();
	const rewritten = await watchdogMessage(harness, unknownCtx, message);
	assert.equal(rewritten, undefined, "unowned timeout is not a watchdog-induced abort marker");
	assert.equal(message.stopReason, "aborted");
	assert.equal(unknownCtx.abortCalls, 0, "unavailable must NOT call ctx.abort()");
	assert.equal(knownCtx.abortCalls, 0);
	assert.equal(unknownProbe.agentAborts(), 0);
	assert.equal(knownProbe.agentAborts(), 0, "a last-captured parent is not a fallback target");
	assert.equal(unknownProbe.session._agentRunAbortRequested, false);
	unknownProbe.session._lastAssistantMessage = message;
	assert.equal(await AgentSession.prototype._handlePostAgentRun.call(unknownProbe.session), false);
	assert.equal(unknownProbe.events.length, 0);
});

test("ctx manager with the same textual ID but different identity cannot abort a known session", async (t) => {
	const harness = makeExtensionHarness(t);
	const probe = makeRealSession({ manager: { getSessionId: () => "shared-id" } });
	const ctx = makeUiContext(probe, { manager: { getSessionId: () => "shared-id" } });
	await harness.start(ctx);
	assert.equal(await watchdogMessage(harness, ctx), undefined);
	assert.equal(probe.agentAborts(), 0);
	assert.equal(ctx.abortCalls, 0);
});

test("Escape still marks real user cancellation, and the watchdog cannot invent a retry afterwards", async (t) => {
	const harness = makeExtensionHarness(t);
	const probe = makeRealSession();
	const ctx = makeUiContext(probe);
	await harness.start(ctx);
	const rewritten = await watchdogMessage(harness, ctx);
	assert.equal(probe.session._agentRunAbortRequested, false);
	assert.equal(probe.agentAborts(), 1);
	await AgentSession.prototype.abort.call(probe.session);
	assert.equal(probe.session._agentRunAbortRequested, true);
	assert.equal(probe.agentAborts(), 2);
	probe.session._lastAssistantMessage = rewritten.message;
	assert.equal(await AgentSession.prototype._handlePostAgentRun.call(probe.session), false);
	assert.equal(probe.events.filter((event) => event.type === "auto_retry_start").length, 0);

	// Cancellation before another timer expires also fails closed.
	await harness.request(ctx);
	mock.timers.tick(STALL_MS);
	assert.equal(probe.agentAborts(), 2);
	assert.equal(await harness.end(ctx, abortedMessage()), undefined);
	assert.equal(ctx.abortCalls, 0);
});

test("message_end UI method failures cannot stop watchdog, matched-error or empty-response rewrites", async (t) => {
	const harness = makeExtensionHarness(t);
	const probe = makeRealSession();
	const ctx = makeUiContext(probe);
	await harness.start(ctx);
	ctx.ui.setStatus = () => { throw new Error("broken footer"); };
	ctx.ui.notify = () => { throw new Error("broken notification"); };
	const stalled = await watchdogMessage(harness, ctx);
	assert.equal(stalled?.message?.stopReason, "error");
	assert.equal(probe.agentAborts(), 1);
	await finishCoreRetry(probe, stalled.message, 2_000);

	const matched = await harness.end(ctx, { ...retryableMessage(), errorMessage: "HTTP 403 provider denied request" });
	assert.ok(matched?.message?.errorMessage.includes("provider returned error"));
	assert.equal(AgentSession.prototype._isRetryableError.call(probe.session, matched.message), true);
	const empty = await harness.end(ctx, { role: "assistant", content: [], stopReason: "stop" });
	assert.equal(empty?.message?.stopReason, "error");
	assert.match(empty.message.errorMessage, /\[kun-retry-empty-response\]/);
});

test("throwing lifecycle UI getters do not suppress message_end or core retry", async (t) => {
	const harness = makeExtensionHarness(t);
	const probe = makeRealSession();
	const ctx = makeUiContext(probe);
	await harness.start(ctx);
	await harness.request(ctx);
	makeStale(ctx);
	mock.timers.tick(STALL_MS);
	assert.equal(probe.agentAborts(), 1, "watchdog ownership does not depend on UI getters");
	const rewritten = await harness.end(ctx, abortedMessage());
	assert.equal(rewritten?.message?.stopReason, "error");
	await finishCoreRetry(probe, rewritten.message, 2_000);
});

test("empty-response rewrite contract is preserved, including thinking-only, abort and length exclusions", async (t) => {
	const harness = makeExtensionHarness(t);
	const probe = makeRealSession();
	const ctx = makeUiContext(probe);
	await harness.start(ctx);
	for (const content of [[], [{ type: "text", text: "   " }], [{ type: "thinking", thinking: "internal only" }]]) {
		const message = { role: "assistant", content, stopReason: "stop" };
		const rewritten = await harness.end(ctx, message);
		assert.equal(rewritten?.message?.stopReason, "error");
		assert.match(rewritten.message.errorMessage, /\[kun-retry-empty-response\]/);
		assert.equal(message.stopReason, "stop", "rewrite returns a copy");
		assert.equal(AgentSession.prototype._isRetryableError.call(probe.session, rewritten.message), true);
		assert.equal(await harness.end(ctx, rewritten.message), undefined, "rewrite tag is idempotent");
	}
	for (const message of [
		abortedMessage(),
		{ role: "assistant", content: [], stopReason: "length" },
		{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
		{ role: "assistant", content: [{ type: "toolCall", id: "call", name: "probe", arguments: {} }], stopReason: "toolUse" },
	]) {
		assert.equal(await harness.end(ctx, message), undefined);
	}
	await harness.command("empty off", ctx);
	assert.equal(await harness.end(ctx, { role: "assistant", content: [], stopReason: "stop" }), undefined);
});

test("a successful turn disarms the watchdog and consumes no future abort marker", async (t) => {
	const harness = makeExtensionHarness(t);
	const probe = makeRealSession();
	const ctx = makeUiContext(probe);
	await harness.start(ctx);
	await harness.request(ctx);
	mock.timers.tick(STALL_MS - 1);
	ctx.isIdle = () => true;
	await harness.end(ctx, { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" });
	mock.timers.tick(STALL_MS * 4);
	assert.equal(probe.agentAborts(), 0);
	assert.equal(ctx.abortCalls, 0);
	assert.equal(await harness.end(ctx, abortedMessage()), undefined);
});

test("/retry trace on returns diagnostics and persistence uses the harness, not a real session", async (t) => {
	const harness = makeExtensionHarness(t);
	const probe = makeRealSession();
	const ctx = makeUiContext(probe);
	await harness.start(ctx);
	await harness.command("trace on", ctx);
	assert.ok(ctx.notices.some(({ text }) => /trace.*ON/i.test(text)), "trace command reports enabled diagnostics");
	const rewritten = await watchdogMessage(harness, ctx);
	await finishCoreRetry(probe, rewritten.message, 2_000);
	assert.ok(harness.entries.length > 0, "opt-in diagnostics persisted via pi.appendEntry stub");
	assert.ok(harness.entries.some(({ data }) => data?.phase === "prepare"));
	await harness.command("trace", ctx);
	assert.ok(ctx.notices.some(({ text }) => /prepare/.test(text)), "trace displays observed real retry metadata");
	const retained = harness.entries.length;
	await harness.command("trace off", ctx);
	const afterOff = harness.entries.length;
	assert.ok(afterOff >= retained);
	await finishCoreRetry(probe, retryableMessage(), 4_000);
	assert.equal(harness.entries.length, afterOff, "trace off stops persistence, not core retry");
});

test("syncSettings commands immediately override the real in-memory budget and exponential delay", async (t) => {
	saveConfig({ syncSettings: true, constantDelayMs: 0, maxRetries: 2, baseDelayMs: 3_000 });
	const harness = makeExtensionHarness(t);
	const probe = makeRealSession({ settings: { enabled: false, maxRetries: 0, baseDelayMs: 17 } });
	const getCoreSettings = probe.session.settingsManager.getRetrySettings;
	const ctx = makeUiContext(probe);
	await harness.start(ctx);
	await finishCoreRetry(probe, retryableMessage(), 3_000);
	await harness.command("delay 7000", ctx);
	await harness.command("max 3", ctx);
	await finishCoreRetry(probe, retryableMessage(), 14_000);
	await finishCoreRetry(probe, retryableMessage(), 28_000);
	probe.session._lastAssistantMessage = retryableMessage();
	assert.equal(await AgentSession.prototype._handlePostAgentRun.call(probe.session), false, "updated live budget stops at three");
	assert.equal(probe.session.settingsManager.getRetrySettings, getCoreSettings);
	assert.deepEqual(getCoreSettings(), { enabled: false, maxRetries: 0, baseDelayMs: 17 }, "no core manager mutation");
});

test("syncSettings=false preserves core budget and exponential default cap despite configured extension values", async (t) => {
	saveConfig({ syncSettings: false, maxRetries: 100, baseDelayMs: 111, constantDelayMs: 0 });
	const harness = makeExtensionHarness(t);
	const probe = makeRealSession({ settings: { maxRetries: 2, baseDelayMs: 90_000 } });
	const ctx = makeUiContext(probe);
	await harness.start(ctx);
	await finishCoreRetry(probe, retryableMessage(), 60_000);
	await harness.command("delay 1", ctx);
	await harness.command("max 999", ctx);
	await finishCoreRetry(probe, retryableMessage(), 60_000);
	probe.session._lastAssistantMessage = retryableMessage();
	assert.equal(await AgentSession.prototype._handlePostAgentRun.call(probe.session), false);
	assert.equal(probe.events.filter((event) => event.type === "auto_retry_start").length, 2);
});
