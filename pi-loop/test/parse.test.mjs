import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DEFAULT_MESSAGE,
	describeSpec,
	formatDateTime,
	formatDuration,
	MIN_INTERVAL_MS,
	parseCommand,
	parseDuration,
} from "../src/parse.ts";

/** Fixed local clock: 2026-09-20 12:00. Keeps the date-free forms deterministic. */
const NOON = new Date(2026, 8, 20, 12, 0, 0).getTime();

test("parseDuration handles units, decimals, compounds and bare seconds", () => {
	assert.equal(parseDuration("500ms"), 500);
	assert.equal(parseDuration("30s"), 30_000);
	assert.equal(parseDuration("3m"), 180_000);
	assert.equal(parseDuration("1.5m"), 90_000);
	assert.equal(parseDuration("2h"), 7_200_000);
	assert.equal(parseDuration("1d"), 86_400_000);
	assert.equal(parseDuration("1h30m"), 5_400_000);
	assert.equal(parseDuration("1m30s"), 90_000);
	assert.equal(parseDuration("180"), 180_000);
	assert.equal(parseDuration("3M"), 180_000);
});

test("parseDuration rejects junk", () => {
	assert.equal(parseDuration(""), undefined);
	assert.equal(parseDuration("soon"), undefined);
	assert.equal(parseDuration("3x"), undefined);
	assert.equal(parseDuration("3m stop"), undefined);
});

test("formatDuration is compact", () => {
	assert.equal(formatDuration(180_000), "3m");
	assert.equal(formatDuration(5_400_000), "1h30m");
	assert.equal(formatDuration(45_000), "45s");
	assert.equal(formatDuration(800), "800ms");
	assert.equal(formatDuration(0), "0s");
});

test("formatDateTime drops the date for today and keeps it otherwise", () => {
	assert.equal(formatDateTime(new Date(2026, 8, 20, 15, 30).getTime(), NOON), "15:30");
	assert.equal(formatDateTime(new Date(2026, 8, 20, 15, 30, 45).getTime(), NOON), "15:30:45");
	assert.equal(formatDateTime(new Date(2026, 8, 21, 9, 5).getTime(), NOON), "09-21 09:05");
});

test("parseCommand starts a legacy interval loop with the default instruction", () => {
	const action = parseCommand("3m");
	assert.equal(action.kind, "start");
	assert.deepEqual(action.kind === "start" ? action.spec : undefined, {
		intervalMs: 180_000,
		message: DEFAULT_MESSAGE,
		limit: undefined,
		immediate: false,
		startAt: undefined,
	});
});

test("parseCommand keeps the instruction verbatim", () => {
	const action = parseCommand("3m 汇报 构建 状态");
	assert.equal(action.kind, "start");
	assert.equal(action.kind === "start" && action.spec.message, "汇报 构建 状态");
});

test("parseCommand reads xN and now flags", () => {
	const action = parseCommand("30s x5 now 检查日志");
	assert.equal(action.kind, "start");
	if (action.kind !== "start") return;
	assert.equal(action.spec.intervalMs, 30_000);
	assert.equal(action.spec.limit, 5);
	assert.equal(action.spec.immediate, true);
	assert.equal(action.spec.startAt, undefined);
	assert.equal(action.spec.message, "检查日志");
});

test("parseCommand does not eat flag-like words inside the instruction", () => {
	const action = parseCommand("1m 看看 now x5");
	assert.equal(action.kind === "start" && action.spec.message, "看看 now x5");
	assert.equal(action.kind === "start" && action.spec.immediate, false);

	// pause/resume only act as commands in the leading position.
	const paused = parseCommand("1m 暂停一下服务");
	assert.equal(paused.kind === "start" && paused.spec.message, "暂停一下服务");
	const resumed = parseCommand("5m resume 部署");
	assert.equal(resumed.kind === "start" && resumed.spec.message, "resume 部署");
});

test("parseCommand recognises subcommands", () => {
	assert.equal(parseCommand("stop").kind, "stop");
	assert.equal(parseCommand("停止").kind, "stop");
	assert.equal(parseCommand("pause").kind, "pause");
	assert.equal(parseCommand("suspend").kind, "pause");
	assert.equal(parseCommand("暂停").kind, "pause");
	assert.equal(parseCommand("挂起").kind, "pause");
	assert.equal(parseCommand("resume").kind, "resume");
	assert.equal(parseCommand("continue").kind, "resume");
	assert.equal(parseCommand("恢复").kind, "resume");
	assert.equal(parseCommand("继续").kind, "resume");
	assert.equal(parseCommand("status").kind, "status");
	assert.equal(parseCommand("").kind, "status");
	assert.equal(parseCommand("help").kind, "help");
});

test("pause / resume reject extra arguments", () => {
	const pause = parseCommand("pause 10m");
	assert.equal(pause.kind, "error");
	assert.match(pause.kind === "error" ? pause.message : "", /\/loop resume/);
	assert.equal(parseCommand("resume now").kind, "error");
});

test("parseCommand rejects bad intervals", () => {
	assert.equal(parseCommand("later 汇报").kind, "error");
	const tooShort = parseCommand("1s 汇报");
	assert.equal(tooShort.kind, "error");
	assert.match(
		tooShort.kind === "error" ? tooShort.message : "",
		new RegExp(formatDuration(MIN_INTERVAL_MS)),
	);
});

test("`in <duration>` schedules a single delayed task", () => {
	const action = parseCommand("in 10m 检查日志", NOON);
	assert.equal(action.kind, "start");
	if (action.kind !== "start") return;
	// A plain one-shot: no repeat interval, exactly one run.
	assert.deepEqual(action.spec, {
		intervalMs: undefined,
		message: "检查日志",
		limit: 1,
		immediate: false,
		startAt: NOON + 600_000,
	});
});

test("`in <duration> xN` repeats at the delay interval", () => {
	const action = parseCommand("in 10m x3 巡检", NOON);
	assert.equal(action.kind === "start" && action.spec.intervalMs, 600_000);
	assert.equal(action.kind === "start" && action.spec.limit, 3);
	assert.equal(action.kind === "start" && action.spec.startAt, NOON + 600_000);
});

test("`in <duration> every <interval>` keeps both", () => {
	const action = parseCommand("in 30s every 1m x2 看看", NOON);
	assert.equal(action.kind === "start" && action.spec.startAt, NOON + 30_000);
	assert.equal(action.kind === "start" && action.spec.intervalMs, 60_000);
	assert.equal(action.kind === "start" && action.spec.limit, 2);
});

test("`+<duration>` is shorthand for `in`", () => {
	const action = parseCommand("+10m 检查", NOON);
	assert.equal(action.kind === "start" && action.spec.startAt, NOON + 600_000);
	assert.equal(action.kind === "start" && action.spec.limit, 1);
});

test("`at <time>` schedules a one-shot at a clock time", () => {
	const action = parseCommand("at 15:30 部署", NOON);
	assert.equal(action.kind, "start");
	if (action.kind !== "start") return;
	assert.deepEqual(action.spec, {
		intervalMs: undefined,
		message: "部署",
		limit: 1,
		immediate: false,
		startAt: new Date(2026, 8, 20, 15, 30).getTime(),
	});
});

test("a bare leading time behaves like `at`", () => {
	const action = parseCommand("15:30 开会提醒", NOON);
	assert.equal(action.kind === "start" && action.spec.startAt, new Date(2026, 8, 20, 15, 30).getTime());
	assert.equal(action.kind === "start" && action.spec.intervalMs, undefined);
});

test("`at <time> every <interval> xN` runs a full series", () => {
	const action = parseCommand("at 15:30 every 5m x3 巡检", NOON);
	assert.equal(action.kind === "start" && action.spec.startAt, new Date(2026, 8, 20, 15, 30).getTime());
	assert.equal(action.kind === "start" && action.spec.intervalMs, 300_000);
	assert.equal(action.kind === "start" && action.spec.limit, 3);
});

test("an `at` time already passed today rolls to tomorrow with a note", () => {
	const action = parseCommand("at 09:00 复盘", NOON);
	assert.equal(action.kind === "start" && action.spec.startAt, new Date(2026, 8, 21, 9, 0).getTime());
	assert.match(action.kind === "start" ? (action.note ?? "") : "", /明天/);
});

test("a time missed by under a minute fires right away", () => {
	const now = new Date(2026, 8, 20, 15, 30, 20).getTime();
	const action = parseCommand("at 15:30 检查", now);
	assert.equal(action.kind === "start" && action.spec.startAt, now);
});

test("explicit date + time is accepted in both spacings", () => {
	const spaced = parseCommand("at 2026-09-21 09:30 备份", NOON);
	const joined = parseCommand("at 2026-09-21T09:30 备份", NOON);
	const expected = new Date(2026, 8, 21, 9, 30).getTime();
	assert.equal(spaced.kind === "start" && spaced.spec.startAt, expected);
	assert.equal(joined.kind === "start" && joined.spec.startAt, expected);
});

test("an explicit date in the past is rejected", () => {
	const action = parseCommand("at 2026-09-19 09:30 备份", NOON);
	assert.equal(action.kind, "error");
	assert.match(action.kind === "error" ? action.message : "", /已过去/);
});

test("`now` alone runs a single immediate task", () => {
	const action = parseCommand("now 汇报一次", NOON);
	assert.equal(action.kind === "start" && action.spec.immediate, true);
	assert.equal(action.kind === "start" && action.spec.limit, 1);
	assert.equal(action.kind === "start" && action.spec.intervalMs, undefined);
	assert.equal(action.kind === "start" && action.spec.startAt, undefined);
});

test("`every <interval>` alone is an unbounded loop", () => {
	const action = parseCommand("every 5m x2 巡检", NOON);
	assert.equal(action.kind === "start" && action.spec.intervalMs, 300_000);
	assert.equal(action.kind === "start" && action.spec.limit, 2);
});

test("conflicting or incomplete schedules produce errors", () => {
	const cases = [
		["at 15:30 now 检查", /now/],
		["in 10m at 15:30 检查", /开始时间/],
		["in 10m +5m 检查", /开始时间/],
		["at 15:30 x3 检查", /every/],
		["x3 检查", /没有重复间隔/],
		["in 检查", /in 后面需要时长/],
		["every 汇报", /every 后面需要时长/],
		["at 检查", /无法解析/],
		["in 2s 检查", /延迟太短/],
		["at 25:00 检查", /超出范围/],
		["at 2026-09-21 备份", /日期后还需要时间/],
	];
	for (const [input, pattern] of cases) {
		const action = parseCommand(input, NOON);
		assert.equal(action.kind, "error", `expected error for "${input}"`);
		assert.match(action.kind === "error" ? action.message : "", pattern, `wrong error for "${input}"`);
	}
});

test("describeSpec renders one-shot, delayed and repeating forms", () => {
	const oneShot = describeSpec({ message: "检查", limit: 1, immediate: false, intervalMs: 300_000 }, 0, NOON);
	assert.match(oneShot, /5m 后执行一次/);

	const scheduled = describeSpec(
		{ message: "检查", limit: 1, immediate: false, startAt: NOON + 600_000 },
		0,
		NOON,
	);
	assert.match(scheduled, /\(约 10m 后\)执行一次/);

	const repeating = describeSpec(
		{ message: "巡检", limit: 3, immediate: false, intervalMs: 300_000, startAt: NOON + 600_000 },
		0,
		NOON,
	);
	assert.match(repeating, /每 5m · 共 3 次/);
	assert.match(repeating, /指令「巡检」/);
});