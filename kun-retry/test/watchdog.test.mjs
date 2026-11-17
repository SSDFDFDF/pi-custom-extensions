import assert from "node:assert/strict";
import { test } from "node:test";
import { createStallWatchdog } from "../src/watchdog.ts";

// Only this standalone module and Node mocks are used: no Pi/config/model imports.
function harness(t, overrides = {}) {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
	const originalSetTimer = globalThis.setTimeout;
	const setTimer = t.mock.method(globalThis, "setTimeout");
	const clearTimer = t.mock.method(globalThis, "clearTimeout");
	const state = { timeoutMs: 100, enabled: true };
	const aborts = [];
	const stalls = [];
	const unavailable = [];
	const records = [];
	const watchdog = createStallWatchdog({
		getTimeoutMs: () => state.timeoutMs,
		isEnabled: () => state.enabled,
		abort: () => {
			aborts.push(Date.now());
			return "direct";
		},
		onStall: () => stalls.push(Date.now()),
		onUnavailable: () => unavailable.push(Date.now()),
		record: (phase, data) => records.push({ phase, data }),
		...overrides,
	});
	t.after(() => {
		watchdog.dispose();
		t.mock.timers.reset();
	});
	return {
		watchdog, state, aborts, stalls, unavailable, records, setTimer, clearTimer, originalSetTimer,
		tick: (ms) => t.mock.timers.tick(ms),
	};
}

test("construction is idle; a request stalls even when no token ever arrives", (t) => {
	const h = harness(t);
	assert.equal(h.setTimer.mock.callCount(), 0);
	h.watchdog.touch();
	h.tick(100);
	assert.equal(h.aborts.length, 0);

	h.watchdog.start();
	h.tick(99);
	assert.equal(h.aborts.length, 0);
	h.tick(1);
	assert.deepEqual(h.aborts, [1_200]);
	assert.deepEqual(h.stalls, [1_200]);
	assert.equal(h.unavailable.length, 0);
	assert.deepEqual(h.records[0], { phase: "stall", data: { timeoutMs: 100, idleMs: 100 } });
	assert.equal(h.records[1].phase, "abort_direct");
	assert.equal(h.watchdog.consumeAbort(), true);
	assert.equal(h.watchdog.consumeAbort(), false);
	h.tick(10_000);
	assert.equal(h.aborts.length, 1, "only one abort attempt for this provider request");
});

test("frequent touch only updates activity; timer renews to the exact last-activity deadline", (t) => {
	const h = harness(t);
	h.watchdog.start();
	for (let i = 0; i < 90; i++) {
		h.tick(1);
		h.watchdog.touch();
	}
	assert.equal(h.setTimer.mock.callCount(), 1, "tokens must not allocate timers");
	assert.equal(h.clearTimer.mock.callCount(), 0, "tokens must not clear timers");
	h.tick(10); // Initial check at 1100; last activity was 1090.
	assert.equal(h.aborts.length, 0);
	assert.equal(h.setTimer.mock.callCount(), 2);
	assert.equal(h.setTimer.mock.calls[1].arguments[1], 90);
	h.tick(89);
	assert.equal(h.aborts.length, 0);
	h.tick(1);
	assert.deepEqual(h.aborts, [1_190], "not an interval boundary or the old deadline");
});

test("sustained high-frequency activity renews without drifting the final deadline", (t) => {
	const h = harness(t);
	h.watchdog.start();
	for (let i = 0; i < 253; i++) {
		h.tick(1);
		h.watchdog.touch();
	}
	assert.equal(h.aborts.length, 0);
	assert.equal(h.setTimer.mock.callCount(), 3);
	h.tick(44); // Before the next check at 1298.
	assert.equal(h.aborts.length, 0);
	h.tick(1);
	assert.equal(h.setTimer.mock.calls[3].arguments[1], 55);
	h.tick(54);
	assert.equal(h.aborts.length, 0);
	h.tick(1);
	assert.deepEqual(h.aborts, [1_353]);
	assert.equal(h.clearTimer.mock.callCount(), 0);
});

test("each provider request starts a fresh deadline and clears the old marker", (t) => {
	const h = harness(t);
	h.watchdog.start();
	const oldCallback = h.setTimer.mock.calls[0].arguments[0];
	h.tick(50);
	h.watchdog.start();
	oldCallback(); // Simulate an already queued, cleared timeout.
	h.tick(99);
	assert.equal(h.aborts.length, 0);
	h.tick(1);
	assert.deepEqual(h.aborts, [1_150]);
	h.watchdog.start();
	assert.equal(h.watchdog.consumeAbort(), false);
	h.tick(100);
	assert.deepEqual(h.aborts, [1_150, 1_250]);
});

test("stop cancels timing; touch cannot restart it", (t) => {
	const h = harness(t);
	h.watchdog.start();
	const callback = h.setTimer.mock.calls[0].arguments[0];
	h.tick(50);
	h.watchdog.stop();
	h.watchdog.stop();
	h.watchdog.touch();
	callback();
	h.tick(10_000);
	assert.equal(h.aborts.length, 0);
	assert.equal(h.records.length, 0);
	assert.equal(h.watchdog.consumeAbort(), false);
	assert.equal(h.setTimer.mock.callCount(), 1);
});

test("message_end may stop before reading the one-shot abort marker", (t) => {
	const h = harness(t);
	h.watchdog.start();
	h.tick(100);
	h.watchdog.stop();
	h.watchdog.stop();
	assert.equal(h.watchdog.consumeAbort(), true);
	assert.equal(h.watchdog.consumeAbort(), false);
});

test("direct abort can synchronously stop and consume from message_end", (t) => {
	let watchdog;
	const consumed = [];
	const h = harness(t, {
		abort: () => {
			watchdog.stop();
			consumed.push(watchdog.consumeAbort(), watchdog.consumeAbort());
			return "direct";
		},
	});
	watchdog = h.watchdog;
	watchdog.start();
	h.tick(100);
	assert.deepEqual(consumed, [true, false]);
	assert.equal(watchdog.consumeAbort(), false, "returning direct must not re-arm a consumed marker");
	assert.equal(h.stalls.length, 1);
});

test("shutdown disposes timers permanently, including already queued callbacks", (t) => {
	const h = harness(t);
	h.watchdog.start();
	const callback = h.setTimer.mock.calls[0].arguments[0];
	h.tick(50);
	h.watchdog.dispose();
	h.watchdog.dispose();
	h.watchdog.start();
	h.watchdog.touch();
	callback();
	h.tick(10_000);
	assert.equal(h.aborts.length, 0);
	assert.equal(h.records.length, 0);
	assert.equal(h.setTimer.mock.callCount(), 1);
	assert.equal(h.watchdog.consumeAbort(), false);
});

test("dispose discards a pending abort marker", (t) => {
	const h = harness(t);
	h.watchdog.start();
	h.tick(100);
	h.watchdog.dispose();
	assert.equal(h.watchdog.consumeAbort(), false);
});

test("unavailable abort only notifies; it leaves no rewrite marker or success notification", (t) => {
	let attempts = 0;
	let watchdog;
	const seen = [];
	const h = harness(t, {
		abort: () => { attempts++; return "unavailable"; },
		onUnavailable: () => seen.push(watchdog.consumeAbort()),
	});
	watchdog = h.watchdog;
	watchdog.start();
	h.tick(100);
	watchdog.stop();
	assert.deepEqual(seen, [false]);
	assert.equal(watchdog.consumeAbort(), false);
	assert.equal(h.stalls.length, 0);
	assert.deepEqual(h.records.map(({ phase }) => phase), ["stall", "abort_unavailable"]);
	h.tick(10_000);
	assert.equal(attempts, 1);
});

test("abort exceptions record abort_failed and roll back the pending marker", (t) => {
	const failure = new Error("abort broke");
	let attempts = 0;
	const h = harness(t, {
		abort: () => { attempts++; throw failure; },
	});
	h.watchdog.start();
	assert.doesNotThrow(() => h.tick(100));
	h.watchdog.stop();
	assert.equal(h.watchdog.consumeAbort(), false);
	assert.equal(h.stalls.length, 0);
	assert.equal(h.unavailable.length, 0);
	assert.deepEqual(h.records.map(({ phase }) => phase), ["stall", "abort_failed"]);
	assert.equal(h.records[1].data.errorName, failure.name);
	h.tick(10_000);
	assert.equal(attempts, 1);
});

for (const timeoutMs of [0, -1, NaN, Infinity]) {
	test(`timeout ${timeoutMs} disables timing without polling or abort`, (t) => {
		const h = harness(t);
		h.state.timeoutMs = timeoutMs;
		h.watchdog.start();
		h.watchdog.touch();
		h.tick(10_000);
		assert.equal(h.setTimer.mock.callCount(), 0);
		assert.equal(h.aborts.length, 0);
		assert.equal(h.watchdog.consumeAbort(), false);
	});
}

test("isEnabled=false disables timing, including when timeout is positive", (t) => {
	const h = harness(t);
	h.state.enabled = false;
	h.watchdog.start();
	h.tick(10_000);
	assert.equal(h.setTimer.mock.callCount(), 0);
	assert.equal(h.aborts.length, 0);
	h.state.enabled = true;
	h.watchdog.start();
	h.tick(100);
	assert.equal(h.aborts.length, 1);
});

for (const disable of ["enabled", "timeoutMs"]) {
	test(`dynamic disabling via ${disable} is honored at the next check`, (t) => {
		const h = harness(t);
		h.watchdog.start();
		h.tick(50);
		h.state[disable] = disable === "enabled" ? false : 0;
		h.tick(50);
		assert.equal(h.aborts.length, 0);
		assert.equal(h.setTimer.mock.callCount(), 1);
		h.state.enabled = true;
		h.state.timeoutMs = 100;
		h.watchdog.touch();
		h.tick(10_000);
		assert.equal(h.aborts.length, 0, "disabled request does not spontaneously restart");
		h.watchdog.start();
		h.tick(100);
		assert.equal(h.aborts.length, 1);
	});
}

test("a smaller timeout takes effect at the next existing check", (t) => {
	const h = harness(t);
	h.watchdog.start();
	h.tick(60);
	h.watchdog.touch();
	h.state.timeoutMs = 20;
	h.tick(39);
	assert.equal(h.aborts.length, 0);
	h.tick(1);
	assert.deepEqual(h.aborts, [1_100]);
	assert.deepEqual(h.records[0].data, { timeoutMs: 20, idleMs: 40 });
});

test("a smaller timeout still renews when the last activity has not expired", (t) => {
	const h = harness(t);
	h.watchdog.start();
	h.tick(90);
	h.watchdog.touch();
	h.state.timeoutMs = 20;
	h.tick(10);
	assert.equal(h.aborts.length, 0);
	assert.equal(h.setTimer.mock.calls[1].arguments[1], 10);
	h.tick(9);
	assert.equal(h.aborts.length, 0);
	h.tick(1);
	assert.deepEqual(h.aborts, [1_110]);
});

test("a larger timeout is measured from real activity, not the check time", (t) => {
	const h = harness(t);
	h.watchdog.start();
	h.tick(50);
	h.state.timeoutMs = 200;
	h.tick(50);
	assert.equal(h.setTimer.mock.calls[1].arguments[1], 100);
	h.tick(99);
	assert.equal(h.aborts.length, 0);
	h.tick(1);
	assert.deepEqual(h.aborts, [1_200]);
});

test("every allocated timer is unref'ed, including renewals", (t) => {
	const h = harness(t);
	const unrefs = [];
	h.setTimer.mock.mockImplementation((...args) => {
		const timer = h.originalSetTimer(...args);
		unrefs.push(t.mock.method(timer, "unref"));
		return timer;
	});
	h.watchdog.start();
	h.tick(90);
	h.watchdog.touch();
	h.tick(10);
	assert.equal(unrefs.length, 2);
	assert.ok(unrefs.every((unref) => unref.mock.callCount() === 1));
});

test("timeouts exceeding Node's maximum are chunked without early abort", (t) => {
	const h = harness(t);
	const max = 2 ** 31 - 1;
	h.state.timeoutMs = max + 100;
	h.watchdog.start();
	assert.equal(h.setTimer.mock.calls[0].arguments[1], max);
	h.tick(max);
	assert.equal(h.aborts.length, 0);
	assert.equal(h.setTimer.mock.calls[1].arguments[1], 100);
	h.tick(99);
	assert.equal(h.aborts.length, 0);
	h.tick(1);
	assert.equal(h.aborts.length, 1);
});

test("throwing record and onStall observers cannot prevent abort or corrupt pending", (t) => {
	let observed = 0;
	const h = harness(t, {
		record: () => { throw new Error("logger unavailable"); },
		onStall: () => { observed++; throw new Error("UI unavailable"); },
	});
	h.watchdog.start();
	assert.doesNotThrow(() => h.tick(100));
	assert.equal(h.aborts.length, 1);
	assert.equal(observed, 1);
	assert.equal(h.watchdog.consumeAbort(), true);
	h.watchdog.start();
	assert.doesNotThrow(() => h.tick(100));
	assert.equal(h.aborts.length, 2);
});

test("throwing unavailable observer is isolated and never leaves a pending marker", (t) => {
	const h = harness(t, {
		abort: () => "unavailable",
		record: () => { throw new Error("record"); },
		onUnavailable: () => { throw new Error("notice"); },
	});
	h.watchdog.start();
	assert.doesNotThrow(() => h.tick(100));
	assert.equal(h.watchdog.consumeAbort(), false);
	assert.equal(h.stalls.length, 0);
});

test("logging failure does not let an abort exception escape its timer", (t) => {
	const h = harness(t, {
		abort: () => { throw new Error("abort"); },
		record: () => { throw new Error("record"); },
	});
	h.watchdog.start();
	assert.doesNotThrow(() => h.tick(100));
	assert.equal(h.watchdog.consumeAbort(), false);
});

for (const getter of ["getTimeoutMs", "isEnabled"]) {
	test(`throwing ${getter} at a timer check fails safely and is recorded`, (t) => {
		let broken = false;
		const failure = new Error("config unavailable");
		const h = harness(t, {
			[getter]: () => {
				if (broken) throw failure;
				return getter === "getTimeoutMs" ? 100 : true;
			},
		});
		h.watchdog.start();
		broken = true;
		assert.doesNotThrow(() => h.tick(100));
		assert.equal(h.records[0].phase, "timer_failed");
		assert.equal(h.records[0].data.errorName, failure.name);
		assert.equal(h.watchdog.consumeAbort(), false);
		assert.equal(h.aborts.length, 0);
		broken = false;
		h.watchdog.start();
		h.tick(100);
		assert.equal(h.aborts.length, 1);
	});
}

test("throwing configuration during start is also contained", (t) => {
	const h = harness(t, {
		getTimeoutMs: () => { throw new Error("config"); },
	});
	assert.doesNotThrow(() => h.watchdog.start());
	assert.equal(h.setTimer.mock.callCount(), 0);
	assert.equal(h.records[0].phase, "timer_failed");
	assert.equal(h.watchdog.consumeAbort(), false);
});

test("timer allocation failure during renewal is contained and stops the request", (t) => {
	const h = harness(t);
	h.watchdog.start();
	h.tick(90);
	h.watchdog.touch();
	const failure = new Error("setTimeout unavailable");
	h.setTimer.mock.mockImplementation(() => { throw failure; });
	assert.doesNotThrow(() => h.tick(10));
	assert.deepEqual(h.records, [{ phase: "timer_failed", data: { errorName: failure.name } }]);
	assert.equal(h.watchdog.consumeAbort(), false);
	h.tick(10_000);
	assert.equal(h.aborts.length, 0);
});

test("unref failure cancels the allocated timer without escaping start", (t) => {
	const h = harness(t);
	const failure = new Error("unref unavailable");
	h.setTimer.mock.mockImplementation((...args) => {
		const timer = h.originalSetTimer(...args);
		t.mock.method(timer, "unref", () => { throw failure; });
		return timer;
	});
	assert.doesNotThrow(() => h.watchdog.start());
	assert.deepEqual(h.records, [{ phase: "timer_failed", data: { errorName: failure.name } }]);
	h.tick(10_000);
	assert.equal(h.aborts.length, 0);
	assert.equal(h.watchdog.consumeAbort(), false);
});

test("optional observers may be omitted", (t) => {
	const h = harness(t, { onStall: undefined, onUnavailable: undefined, record: undefined });
	h.watchdog.start();
	assert.doesNotThrow(() => h.tick(100));
	assert.equal(h.aborts.length, 1);
	assert.equal(h.watchdog.consumeAbort(), true);
});

test("observer promise rejections are isolated without unhandled rejections", async (t) => {
	const h = harness(t, {
		record: async () => { throw new Error("async record"); },
		onStall: async () => { throw new Error("async UI"); },
	});
	h.watchdog.start();
	h.tick(100);
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(h.aborts.length, 1);
	assert.equal(h.watchdog.consumeAbort(), true);
});

test("dispose during a stall observer prevents later abort callbacks", (t) => {
	let watchdog;
	const h = harness(t, {
		record: (phase) => { if (phase === "stall") watchdog.dispose(); },
	});
	watchdog = h.watchdog;
	watchdog.start();
	h.tick(100);
	assert.equal(h.aborts.length, 0);
	assert.equal(h.stalls.length, 0);
	assert.equal(watchdog.consumeAbort(), false);
});

test("dispose during direct abort does not resurrect pending or notify afterwards", (t) => {
	let watchdog;
	const h = harness(t, {
		abort: () => { watchdog.dispose(); return "direct"; },
	});
	watchdog = h.watchdog;
	watchdog.start();
	h.tick(100);
	assert.equal(watchdog.consumeAbort(), false);
	assert.equal(h.stalls.length, 0);
	assert.deepEqual(h.records.map(({ phase }) => phase), ["stall"]);
});

for (const route of ["direct", "unavailable", "throws"]) {
	test(`a synchronous new request during ${route} abort is not changed by the old callback`, (t) => {
		let watchdog;
		let attempts = 0;
		const h = harness(t, {
			abort: () => {
				attempts++;
				if (attempts === 1) {
					watchdog.start();
					if (route === "throws") throw new Error("old request abort");
					return route;
				}
				return "direct";
			},
		});
		watchdog = h.watchdog;
		watchdog.start();
		h.tick(100);
		assert.equal(watchdog.consumeAbort(), false);
		assert.equal(h.stalls.length, 0);
		assert.equal(h.unavailable.length, 0);
		h.tick(99);
		assert.equal(attempts, 1);
		h.tick(1);
		assert.equal(attempts, 2);
		assert.equal(watchdog.consumeAbort(), true);
		assert.equal(h.stalls.length, 1);
	});
}
