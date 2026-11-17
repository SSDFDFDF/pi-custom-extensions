import assert from "node:assert/strict";
import { test } from "node:test";
import { bindRetryHooks, installConstantDelayPatch } from "../src/retry-patch.ts";
import { registerSession } from "../src/session-registry.ts";

class Session {
	constructor(manager = {}) {
		this.sessionManager = manager; this._retryAttempt = 0; this.delay = 0;
		this.settingsManager = { getRetrySettings: () => ({ enabled: true, maxRetries: 10, baseDelayMs: 2000 }) };
	}
	async _prepareRetry() {
		const settings = this.settingsManager.getRetrySettings();
		this._retryAttempt++;
		this.delay = Math.min(settings.baseDelayMs * 2 ** (this._retryAttempt - 1), settings.maxAgentDelayMs ?? 60000);
		return true;
	}
}
installConstantDelayPatch(Session);
const policy = (delay, extra = {}) => ({ getConstantDelayMs: () => delay, getMaxRetries: () => 10, ...extra });

test("reused manager does not dispatch new owner's policy into an old AgentSession", async () => {
	const manager = {}, old = new Session(manager), fresh = new Session(manager);
	registerSession(old); const oldDispose = bindRetryHooks(manager, policy(3000));
	registerSession(fresh); bindRetryHooks(manager, policy(7000)); oldDispose();
	await old._prepareRetry({}); await fresh._prepareRetry({});
	assert.equal(old.delay, 2000); assert.equal(fresh.delay, 7000);
});

test("async UI and diagnostic rejection is contained, including failure reporter", async () => {
	const session = new Session(); registerSession(session);
	const dispose = bindRetryHooks(session.sessionManager, policy(5000, {
		onRetry: async () => { throw Error("UI rejected"); },
		record: async () => { throw Error("record rejected"); },
	}));
	assert.equal(await session._prepareRetry({}), true);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(session.delay, 5000); dispose();
});

test("constant settings shadow disappears before onRetry sees shared settings", async () => {
	const session = new Session(); registerSession(session);
	let observed;
	const dispose = bindRetryHooks(session.sessionManager, policy(5000, {
		onRetry: () => { observed = session.settingsManager.getRetrySettings(); },
	}));
	await session._prepareRetry({});
	assert.equal(observed.baseDelayMs, 2000); assert.equal(observed.maxAgentDelayMs, undefined);
	dispose();
});
