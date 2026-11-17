import assert from "node:assert/strict";
import { test } from "node:test";
import { forgetSession, installSessionRegistry, resolveSession } from "../src/session-registry.ts";
import { beginSoftAbort, installSoftAbortPatch } from "../src/soft-abort.ts";

function makeClass() {
	return class Session {
		constructor(manager = {}) {
			this.sessionManager = manager;
			this.agent = { abort: () => this.softAborts++ };
			this.softAborts = 0; this.hardAborts = 0;
		}
		_bindExtensionCore() { return "core bound"; }
		async bindExtensions() { return "UI bound"; }
		async abort() { this.hardAborts++; this._agentRunAbortRequested = true; }
	};
}

test("core binding captures exact identity on construction/reload without touching abort", () => {
	const Class = makeClass(); const originalAbort = Class.prototype.abort;
	assert.equal(installSoftAbortPatch(Class).installed, true);
	assert.equal(Class.prototype.abort, originalAbort);
	const first = new Class(), second = new Class();
	assert.equal(first._bindExtensionCore(), "core bound"); second._bindExtensionCore();
	assert.equal(resolveSession(first.sessionManager), first);
	assert.equal(beginSoftAbort(first.sessionManager), "direct");
	assert.equal(first.softAborts, 1); assert.equal(second.softAborts, 0);
	assert.equal(beginSoftAbort({}), "unavailable"); assert.equal(beginSoftAbort(), "unavailable");
	forgetSession(first); assert.equal(resolveSession(first.sessionManager), undefined);
	first._bindExtensionCore(); assert.equal(resolveSession(first.sessionManager), first);
});

test("multiple SDK prototypes independently patched once", async () => {
	const A = makeClass(), B = makeClass();
	installSessionRegistry(A); const method = A.prototype._bindExtensionCore;
	installSessionRegistry(A); installSessionRegistry(B);
	assert.equal(A.prototype._bindExtensionCore, method);
	const a = new A(), b = new B(); await a.bindExtensions(); await b.bindExtensions();
	assert.equal(resolveSession(a.sessionManager), a); assert.equal(resolveSession(b.sessionManager), b);
});

test("stale shutdown does not remove replacement using same manager", () => {
	const Class = makeClass(); installSessionRegistry(Class);
	const manager = {}, old = new Class(manager), next = new Class(manager);
	old._bindExtensionCore(); next._bindExtensionCore(); forgetSession(old);
	assert.equal(resolveSession(manager), next);
});

test("user cancellation, compaction, idle stream fail closed", async () => {
	const Class = makeClass(); installSoftAbortPatch(Class);
	const session = new Class(); session._bindExtensionCore();
	for (const field of ["_agentRunAbortRequested", "isCompacting"]) {
		session[field] = true;
		assert.equal(beginSoftAbort(session.sessionManager), "unavailable"); session[field] = false;
	}
	session.isStreaming = false; assert.equal(beginSoftAbort(session.sessionManager), "unavailable");
	session.isStreaming = true; assert.equal(beginSoftAbort(session.sessionManager), "direct");
	await session.abort(); assert.equal(session.hardAborts, 1);
	assert.equal(beginSoftAbort(session.sessionManager), "unavailable");
});

test("manager replacement cannot resolve a stale alias", () => {
	const Class = makeClass(); installSessionRegistry(Class);
	const session = new Class(), old = session.sessionManager;
	session._bindExtensionCore(); session.sessionManager = {}; session._bindExtensionCore();
	assert.equal(resolveSession(old), undefined); assert.equal(resolveSession(session.sessionManager), session);
});
