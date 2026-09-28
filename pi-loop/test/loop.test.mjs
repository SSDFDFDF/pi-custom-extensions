import assert from "node:assert/strict";
import { mock, test } from "node:test";
import createLoopExtension from "../src/index.ts";

/** Minimal ExtensionAPI / ExtensionContext stub for the loop extension. */
function createHarness() {
	const messages = [];
	const entries = [];
	const notices = [];
	const statuses = [];
	const handlers = {};
	let command;
	let idle = true;

	const pi = {
		registerCommand(name, options) {
			assert.equal(name, "loop");
			command = options;
		},
		registerMessageRenderer() {},
		on(event, handler) {
			handlers[event] = handler;
		},
		sendMessage(message, options) {
			messages.push({ message, options });
		},
		appendEntry(customType, data) {
			entries.push({ customType, data });
		},
	};

	const ctx = {
		hasUI: true,
		isIdle: () => idle,
		ui: {
			notify: (text, level) => notices.push({ text, level }),
			setStatus: (key, text) => statuses.push({ key, text }),
		},
		sessionManager: { getEntries: () => entries.map(toSessionEntry) },
	};

	createLoopExtension(pi);

	return {
		command: () => command,
		handlers,
		messages,
		entries,
		notices,
		statuses,
		ctx,
		setIdle: (value) => {
			idle = value;
		},
	};
}

function toSessionEntry({ customType, data }) {
	return { type: "custom", customType, data };
}

function lastStatus(harness) {
	return harness.statuses.at(-1)?.text;
}

/** Wall-clock `HH:MM:SS` of an epoch timestamp, for `at` expressions in tests. */
function clockTime(ts) {
	const date = new Date(ts);
	const pad = (value) => String(value).padStart(2, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

test("registers the /loop command", () => {
	const harness = createHarness();
	assert.ok(harness.command());
	assert.match(harness.command().description, /\/loop/);
	assert.deepEqual(
		harness.command().getArgumentCompletions("st"),
		[
			{ value: "stop", label: "stop", description: "停止当前循环" },
			{ value: "status", label: "status", description: "查看当前循环" },
		],
	);
});

test("ticks on schedule, reports, and stops at the count limit", async (t) => {
	mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	t.after(() => mock.timers.reset());

	const harness = createHarness();
	await harness.handlers.session_start({ reason: "startup" }, harness.ctx);
	await harness.command().handler("10s x2 汇报进度", harness.ctx);

	assert.equal(harness.messages.length, 0, "no tick before the first interval");
	assert.match(lastStatus(harness), /loop 10s → #1\/2/);

	mock.timers.tick(10_000);
	assert.equal(harness.messages.length, 1);
	const first = harness.messages[0];
	assert.equal(first.message.customType, "loop-tick");
	assert.equal(first.options.deliverAs, "followUp");
	assert.equal(first.options.triggerTurn, true);
	assert.equal(first.message.details.tick, 1);
	assert.match(first.message.content, /定时循环 #1\/2 · 间隔 10s/);
	assert.match(first.message.content, /汇报进度/);

	mock.timers.tick(10_000);
	assert.equal(harness.messages.length, 2);
	assert.equal(harness.messages[1].message.details.tick, 2);

	// Limit reached: loop stopped, status cleared, no further ticks.
	mock.timers.tick(60_000);
	assert.equal(harness.messages.length, 2);
	assert.equal(lastStatus(harness), undefined);
	assert.equal(harness.entries.at(-1).data.active, false);
	assert.match(harness.notices.at(-1).text, /结束\(已完成 2 次\)/);
});

test("`now` fires immediately", async (t) => {
	mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	t.after(() => mock.timers.reset());

	const harness = createHarness();
	await harness.handlers.session_start({ reason: "startup" }, harness.ctx);
	await harness.command().handler("1m now x1", harness.ctx);

	mock.timers.tick(0);
	assert.equal(harness.messages.length, 1);
	assert.match(harness.messages[0].message.content, /汇报当前进度/);
});

test("`in <duration>` waits, fires once, then stops", async (t) => {
	mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	t.after(() => mock.timers.reset());

	const harness = createHarness();
	await harness.handlers.session_start({ reason: "startup" }, harness.ctx);
	await harness.command().handler("in 10s 检查部署", harness.ctx);

	assert.equal(harness.messages.length, 0, "nothing before the delay elapses");
	assert.match(lastStatus(harness), /loop 单次/);

	mock.timers.tick(9_999);
	assert.equal(harness.messages.length, 0, "not yet");
	mock.timers.tick(1);

	assert.equal(harness.messages.length, 1);
	const details = harness.messages[0].message.details;
	assert.equal(details.tick, 1);
	assert.equal(details.limit, 1);
	assert.equal(details.intervalMs, undefined, "one-shot carries no repeat interval");
	assert.match(harness.messages[0].message.content, /\[定时任务 #1\/1/);

	// One-shot: no further ticks, task stopped.
	mock.timers.tick(60_000);
	assert.equal(harness.messages.length, 1);
	assert.equal(harness.entries.at(-1).data.active, false);
	assert.match(harness.notices.at(-1).text, /定时任务完成\(已执行 1 次\)/);
});

test("`at HH:MM:SS` fires at the specified clock time", async (t) => {
	mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	t.after(() => mock.timers.reset());

	const harness = createHarness();
	await harness.handlers.session_start({ reason: "startup" }, harness.ctx);
	const target = clockTime(Date.now() + 30_000);
	await harness.command().handler(`at ${target} 提醒上线`, harness.ctx);

	assert.equal(harness.messages.length, 0);
	assert.match(lastStatus(harness), /→ \d{2}:\d{2}:\d{2} in /);

	mock.timers.tick(15_000);
	assert.equal(harness.messages.length, 0, "too early");
	mock.timers.tick(15_000);
	assert.equal(harness.messages.length, 1);
	assert.match(harness.messages[0].message.content, /\[定时任务 #1\/1 · 计划/);
});

test("`at` combined with `every` and `xN` runs the whole series", async (t) => {
	mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	t.after(() => mock.timers.reset());

	const harness = createHarness();
	await harness.handlers.session_start({ reason: "startup" }, harness.ctx);
	const target = clockTime(Date.now() + 30_000);
	await harness.command().handler(`at ${target} every 5m x2 巡检`, harness.ctx);

	mock.timers.tick(30_000);
	assert.equal(harness.messages.length, 1);
	assert.equal(harness.messages[0].message.details.tick, 1);
	assert.equal(harness.messages[0].message.details.intervalMs, 300_000);

	mock.timers.tick(300_000);
	assert.equal(harness.messages.length, 2);
	assert.equal(harness.messages[1].message.details.tick, 2);

	mock.timers.tick(300_000);
	assert.equal(harness.messages.length, 2, "series finished");
	assert.equal(harness.entries.at(-1).data.active, false);
});

test("skips a tick while the agent is busy and reports the skip later", async (t) => {
	mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	t.after(() => mock.timers.reset());

	const harness = createHarness();
	await harness.handlers.session_start({ reason: "startup" }, harness.ctx);
	await harness.command().handler("10s 看看状态", harness.ctx);

	harness.setIdle(false);
	mock.timers.tick(10_000);
	assert.equal(harness.messages.length, 0, "busy agent: tick skipped");

	harness.setIdle(true);
	mock.timers.tick(10_000);
	assert.equal(harness.messages.length, 1);
	assert.equal(harness.messages[0].message.details.skipped, 1);
	assert.match(harness.messages[0].message.content, /1 次触发因为正在忙碌被跳过/);

	// Skip counter resets after being reported.
	mock.timers.tick(10_000);
	assert.equal(harness.messages[1].message.details.skipped, 0);
});

test("a busy one-shot retries after 30s instead of waiting a full interval", async (t) => {
	mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	t.after(() => mock.timers.reset());

	const harness = createHarness();
	await harness.handlers.session_start({ reason: "startup" }, harness.ctx);
	await harness.command().handler("in 10s 检查部署", harness.ctx);

	harness.setIdle(false);
	mock.timers.tick(10_000);
	assert.equal(harness.messages.length, 0, "due but busy");

	mock.timers.tick(29_999);
	assert.equal(harness.messages.length, 0, "still in the retry window");

	harness.setIdle(true);
	mock.timers.tick(1);
	assert.equal(harness.messages.length, 1);
	assert.equal(harness.messages[0].message.details.skipped, 1);
});

test("stop cancels the loop, and stopping twice warns", async (t) => {
	mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	t.after(() => mock.timers.reset());

	const harness = createHarness();
	await harness.handlers.session_start({ reason: "startup" }, harness.ctx);
	await harness.command().handler("10s", harness.ctx);
	await harness.command().handler("stop", harness.ctx);

	mock.timers.tick(60_000);
	assert.equal(harness.messages.length, 0);
	assert.equal(lastStatus(harness), undefined);

	await harness.command().handler("stop", harness.ctx);
	assert.equal(harness.notices.at(-1).level, "warning");
});

test("restores an active loop on /reload but not on plain startup", async (t) => {
	mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	t.after(() => mock.timers.reset());

	const harness = createHarness();
	await harness.handlers.session_start({ reason: "startup" }, harness.ctx);
	await harness.command().handler("10s 汇报", harness.ctx);
	mock.timers.tick(10_000);
	assert.equal(harness.messages.length, 1);

	// /reload tears the runtime down, then a fresh instance restores from the session.
	await harness.handlers.session_shutdown({ reason: "reload" }, harness.ctx);
	const reloaded = createHarness();
	reloaded.entries.push(...harness.entries);
	await reloaded.handlers.session_start({ reason: "reload" }, reloaded.ctx);
	mock.timers.tick(10_000);
	assert.equal(reloaded.messages.length, 1);
	assert.equal(reloaded.messages[0].message.details.tick, 2, "tick numbering continues");

	// Opening the same session later must not silently resume the loop.
	const opened = createHarness();
	opened.entries.push(...harness.entries);
	await opened.handlers.session_start({ reason: "resume" }, opened.ctx);
	mock.timers.tick(60_000);
	assert.equal(opened.messages.length, 0);
});

test("reload restores a pending one-shot, and skips an expired one", async (t) => {
	mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
	t.after(() => mock.timers.reset());

	// Pending one-shot: half the delay elapsed before reload.
	const pending = createHarness();
	await pending.handlers.session_start({ reason: "startup" }, pending.ctx);
	await pending.command().handler("in 10s 检查部署", pending.ctx);
	mock.timers.tick(5_000);
	await pending.handlers.session_shutdown({ reason: "reload" }, pending.ctx);

	const resumed = createHarness();
	resumed.entries.push(...pending.entries);
	await resumed.handlers.session_start({ reason: "reload" }, resumed.ctx);
	mock.timers.tick(4_999);
	assert.equal(resumed.messages.length, 0);
	mock.timers.tick(1);
	assert.equal(resumed.messages.length, 1);

	// Expired one-shot: the start time passed while pi was closed.
	const expired = createHarness();
	await expired.handlers.session_start({ reason: "startup" }, expired.ctx);
	await expired.command().handler("in 10s 已错过的任务", expired.ctx);
	await expired.handlers.session_shutdown({ reason: "reload" }, expired.ctx);
	mock.timers.tick(120_000);

	const after = createHarness();
	after.entries.push(...expired.entries);
	await after.handlers.session_start({ reason: "reload" }, after.ctx);
	mock.timers.tick(600_000);
	assert.equal(after.messages.length, 0, "expired one-shot never fires");
	assert.match(after.notices.at(-1).text, /过期,已跳过/);
	assert.equal(after.notices.at(-1).level, "warning");
});

test("rejects intervals below the minimum", async () => {
	const harness = createHarness();
	await harness.handlers.session_start({ reason: "startup" }, harness.ctx);
	await harness.command().handler("1s 汇报", harness.ctx);
	assert.equal(harness.messages.length, 0);
	assert.equal(harness.notices.at(-1).level, "warning");
	assert.match(harness.notices.at(-1).text, /间隔太短/);
});