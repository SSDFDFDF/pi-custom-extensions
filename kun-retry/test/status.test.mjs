import assert from "node:assert/strict";
import { test } from "node:test";
import { createRetryStatus } from "../src/status.ts";

function fakeTimers(t) {
	let now = 0;
	const timers = [];
	t.mock.method(globalThis, "setTimeout", (callback, delay) => {
		const timer = {
			callback,
			delay,
			due: now + delay,
			cancelled: false,
			fired: false,
			unrefs: 0,
			unref() { this.unrefs++; return this; },
		};
		timers.push(timer);
		return timer;
	});
	t.mock.method(globalThis, "clearTimeout", (timer) => { timer.cancelled = true; });
	return {
		timers,
		advance(ms) {
			const target = now + ms;
			for (;;) {
				const timer = timers.filter((item) => !item.cancelled && !item.fired && item.due <= target)
					.sort((a, b) => a.due - b.due)[0];
				if (!timer) break;
				now = timer.due;
				timer.fired = true;
				timer.callback();
			}
			now = target;
		},
	};
}

function setup(t, overrides = {}, initialRotation = "") {
	const clock = fakeTimers(t);
	const config = { enabled: true, nl: true, constantDelayMs: 5_000, ...overrides };
	let rotation = initialRotation;
	const calls = [];
	const status = createRetryStatus(() => config, () => rotation);
	const ui = { setStatus(key, text) { assert.equal(this, ui); calls.push({ key, text }); } };
	status.capture({ hasUI: true, ui });
	t.after(() => status.dispose());
	return { status, clock, config, calls, rotate(value) { rotation = value; }, last() { return calls.at(-1)?.text; } };
}

test("stable footer reflects unlimited mode, delay and current rotation suffix", (t) => {
	const state = setup(t, {}, " rot/3");
	state.status.refresh();
	assert.deepEqual(state.calls, [{ key: "kun-retry", text: "nl∞ @5s rot/3" }]);
	state.status.refresh();
	assert.equal(state.calls.length, 1, "unchanged UI writes are coalesced");
	state.config.constantDelayMs = 60_000;
	state.rotate("rot/5");
	state.status.refresh();
	assert.equal(state.last(), "nl∞ @1m rot/5");
	state.config.constantDelayMs = 0;
	state.status.refresh();
	assert.equal(state.last(), "nl∞ rot/5");
	state.config.nl = false;
	state.status.refresh();
	assert.equal(state.last(), "retry rot/5");
	state.rotate("");
	state.status.refresh();
	assert.equal(state.last(), undefined, "normal bounded mode keeps the footer quiet");
	assert.equal(state.clock.timers.length, 0, "no background work at construction or refresh");
});

test("receiving expires at 1500ms and restores the latest stable footer", (t) => {
	const state = setup(t, {}, "rot/2");
	state.status.refresh();
	state.status.receiving();
	assert.equal(state.last(), "receiving");
	assert.equal(state.clock.timers[0].delay, 1_500);
	assert.equal(state.clock.timers[0].unrefs, 1);
	state.config.constantDelayMs = 2_000;
	state.rotate("rot/4");
	state.status.refresh();
	assert.equal(state.last(), "receiving", "refresh preserves a live transient");
	state.clock.advance(1_499);
	assert.equal(state.last(), "receiving");
	state.clock.advance(1);
	assert.equal(state.last(), "nl∞ @2s rot/4");
	assert.ok(state.calls.every(({ text }) => text !== undefined), "expiry does not blank a stable footer");
});

test("default retry lasts 8s and info covers the entire delay plus 8s", (t) => {
	const state = setup(t);
	state.status.retry();
	assert.equal(state.last(), "retrying∞");
	state.clock.advance(7_999);
	assert.equal(state.last(), "retrying∞");
	state.clock.advance(1);
	assert.equal(state.last(), "nl∞ @5s");
	state.status.retry({ attempt: 9, maxRetries: 99, delayMs: 12_000 });
	assert.equal(state.last(), "retrying∞ 9 @12s");
	state.clock.advance(19_999);
	assert.equal(state.last(), "retrying∞ 9 @12s");
	state.clock.advance(1);
	assert.equal(state.last(), "nl∞ @5s");
	assert.ok(state.clock.timers.every((timer) => timer.unrefs === 1));
});

test("bounded retry shows the supplied attempt, budget and delay", (t) => {
	const state = setup(t, { nl: false });
	state.status.retry({ attempt: 2, maxRetries: 4, delayMs: 1_250 });
	assert.equal(state.last(), "retrying 2/4 @1250ms");
	state.status.retry({ attempt: 3, delayMs: 0 });
	assert.equal(state.last(), "retrying 3 @0ms");
	state.status.retry();
	assert.equal(state.last(), "retrying");
});

test("clear restores stable state and invalidates even already queued timers", (t) => {
	const state = setup(t, {}, "rot/3");
	state.status.receiving();
	const old = state.clock.timers[0];
	state.status.clear();
	assert.equal(old.cancelled, true);
	assert.equal(state.last(), "nl∞ @5s rot/3");
	state.status.retry({ attempt: 1, delayMs: 30_000 });
	const writes = state.calls.length;
	old.callback();
	assert.equal(state.calls.length, writes);
	assert.equal(state.last(), "retrying∞ 1 @30s");
});

test("repeated transient updates extend visibility and reject superseded callbacks", (t) => {
	const state = setup(t);
	state.status.receiving();
	const old = state.clock.timers[0];
	state.clock.advance(1_000);
	state.status.receiving();
	assert.equal(state.calls.length, 1);
	old.callback();
	state.clock.advance(1_499);
	assert.equal(state.last(), "receiving");
	state.clock.advance(1);
	assert.equal(state.last(), "nl∞ @5s");
});

test("disabling clears transients and cancelling their timers cannot later write", (t) => {
	const state = setup(t);
	state.status.retry({ attempt: 1, delayMs: 5_000 });
	const old = state.clock.timers[0];
	state.config.enabled = false;
	state.status.refresh();
	assert.equal(state.last(), undefined);
	assert.equal(old.cancelled, true);
	state.status.receiving();
	assert.equal(state.clock.timers.length, 1, "disabled status does not arm a timer");
	state.config.enabled = true;
	state.status.refresh();
	assert.equal(state.last(), "nl∞ @5s");
	const writes = state.calls.length;
	old.callback();
	assert.equal(state.calls.length, writes);
});

test("capture snapshots raw UI and method without retaining guarded ctx getters", (t) => {
	const clock = fakeTimers(t);
	let stale = false;
	let hasUIReads = 0;
	let uiReads = 0;
	let methodReads = 0;
	const calls = [];
	const ui = {
		get setStatus() {
			methodReads++;
			if (stale) throw new Error("stale method getter");
			return function (key, text) { assert.equal(this, ui); calls.push({ key, text }); };
		},
	};
	const ctx = {
		get hasUI() { hasUIReads++; if (stale) throw new Error("stale hasUI"); return true; },
		get ui() { uiReads++; if (stale) throw new Error("stale UI"); return ui; },
	};
	const status = createRetryStatus(() => ({ enabled: true, nl: true, constantDelayMs: 5_000 }));
	t.after(() => status.dispose());
	status.capture(ctx);
	stale = true;
	assert.doesNotThrow(() => { status.receiving(); status.refresh(); clock.advance(1_500); status.clear(); });
	assert.equal(calls.at(-1).text, "nl∞ @5s");
	assert.deepEqual([hasUIReads, uiReads, methodReads], [1, 1, 1]);
});

test("hasUI/ui/setStatus failures are isolated and invalid capture drops the old writer", (t) => {
	const state = setup(t);
	state.status.refresh();
	const initialWrites = state.calls.length;
	for (const ctx of [
		{ hasUI: false, get ui() { assert.fail("headless mode must not read ui"); } },
		{ get hasUI() { throw new Error("hasUI getter"); } },
		{ hasUI: true, get ui() { throw new Error("ui getter"); } },
		{ hasUI: true, ui: { get setStatus() { throw new Error("method getter"); } } },
		{ hasUI: true, ui: { setStatus() { throw new Error("method call"); } } },
		{ hasUI: true, ui: null },
		{ hasUI: true, ui: { setStatus: undefined } },
		null,
	]) {
		assert.doesNotThrow(() => {
			state.status.capture(ctx);
			state.status.receiving();
			state.status.retry();
			state.status.refresh();
			state.status.clear();
			state.clock.advance(60_000);
		});
	}
	assert.equal(state.calls.length, initialWrites);
});

test("a failing setStatus can recover on the next refresh", (t) => {
	fakeTimers(t);
	let fail = true;
	const writes = [];
	const status = createRetryStatus(() => ({ enabled: true, nl: true, constantDelayMs: 5_000 }));
	t.after(() => status.dispose());
	status.capture({ hasUI: true, ui: { setStatus(_key, text) { if (fail) throw Error("stale"); writes.push(text); } } });
	assert.doesNotThrow(() => status.refresh());
	fail = false;
	status.refresh();
	assert.deepEqual(writes, ["nl∞ @5s"]);
});

test("replacement capture routes existing timer expiry only to the new raw UI", (t) => {
	const state = setup(t);
	state.status.receiving();
	const newer = [];
	state.status.capture({ hasUI: true, ui: { setStatus(key, text) { newer.push({ key, text }); } } });
	state.status.refresh();
	assert.equal(newer.at(-1).text, "receiving");
	state.clock.advance(1_500);
	assert.equal(newer.at(-1).text, "nl∞ @5s");
	assert.equal(state.calls.length, 1);
});

test("dispose is terminal: no UI writes, getter access or timers even through old callbacks", (t) => {
	const state = setup(t);
	state.status.retry({ attempt: 1, delayMs: 5_000 });
	const old = state.clock.timers[0];
	state.status.dispose();
	assert.equal(old.cancelled, true);
	const writes = state.calls.length;
	const forbidden = { get hasUI() { assert.fail("disposed capture must not read ctx"); } };
	assert.doesNotThrow(() => {
		old.callback();
		state.clock.advance(60_000);
		state.status.dispose();
		state.status.capture(forbidden);
		state.status.receiving();
		state.status.retry({ get delayMs() { assert.fail("disposed retry must not read info"); } });
		state.status.clear();
		state.status.refresh();
	});
	assert.equal(state.calls.length, writes);
	assert.equal(state.clock.timers.length, 1);
});

test("long retry delays are chunked to avoid Node's timer overflow", (t) => {
	const state = setup(t);
	const maximum = 2_147_483_647;
	state.status.retry({ attempt: 1, delayMs: maximum + 12_000 });
	assert.equal(state.clock.timers[0].delay, maximum);
	state.clock.advance(maximum);
	assert.equal(state.clock.timers[1].delay, 20_000);
	assert.match(state.last(), /^retrying∞/);
	state.clock.advance(19_999);
	assert.match(state.last(), /^retrying∞/);
	state.clock.advance(1);
	assert.equal(state.last(), "nl∞ @5s");
	assert.ok(state.clock.timers.every((timer) => timer.unrefs === 1));
});

test("shutdown or replacement inside a UI callback cannot arm an obsolete timer", (t) => {
	const clock = fakeTimers(t);
	const config = { enabled: true, nl: true, constantDelayMs: 5_000 };
	const shutdown = createRetryStatus(() => config);
	shutdown.capture({ hasUI: true, ui: { setStatus() { shutdown.dispose(); } } });
	shutdown.receiving();
	assert.equal(clock.timers.length, 0);

	const replacement = createRetryStatus(() => config);
	const writes = [];
	replacement.capture({ hasUI: true, ui: { setStatus(_key, text) {
		writes.push(text);
		if (text === "receiving") replacement.retry({ attempt: 1, delayMs: 30_000 });
	} } });
	t.after(() => replacement.dispose());
	replacement.receiving();
	assert.equal(clock.timers.length, 1);
	assert.equal(clock.timers[0].delay, 38_000);
	assert.deepEqual(writes, ["receiving", "retrying∞ 1 @30s"]);
	replacement.refresh();
	assert.equal(writes.length, 2, "outer writer must not overwrite the nested retry's cached status");
	clock.advance(1_500);
	assert.equal(writes.at(-1), "retrying∞ 1 @30s");
	clock.advance(36_500);
	assert.equal(writes.at(-1), "nl∞ @5s");
});

test("invalid delay and failing callbacks cannot crash footer operations", (t) => {
	const state = setup(t);
	for (const delayMs of [-5, NaN, Infinity]) {
		assert.doesNotThrow(() => state.status.retry({ attempt: 1, delayMs }));
		assert.equal(state.clock.timers.at(-1).delay, 8_000);
	}
	for (const status of [
		createRetryStatus(() => { throw Error("config"); }),
		createRetryStatus(() => state.config, () => { throw Error("suffix"); }),
	]) {
		status.capture({ hasUI: true, ui: { setStatus() {} } });
		assert.doesNotThrow(() => { status.refresh(); status.receiving(); status.retry(); state.clock.advance(60_000); status.clear(); });
		status.dispose();
	}
});
