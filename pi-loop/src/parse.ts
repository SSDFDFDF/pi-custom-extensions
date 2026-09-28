/**
 * Argument parsing for the `/loop` command.
 *
 * Supported forms:
 *   /loop 3m                          -> every 3 minutes, default report instruction
 *   /loop 3m 汇报构建状态              -> every 3 minutes with a custom instruction
 *   /loop 1h30m x5 now 检查日志        -> compound interval, 5 ticks max, fire immediately
 *   /loop in 10m 检查日志             -> one shot 10 minutes from now
 *   /loop in 2h every 30m x3 巡检      -> start in 2h, then every 30m, 3 ticks
 *   /loop at 15:30 部署               -> one shot at 15:30 (tomorrow if already passed)
 *   /loop at 2026-09-21 09:30 备份     -> one shot at an explicit date + time
 *   /loop now 汇报                    -> one shot right away
 *   /loop stop | status | help
 */

/** Minimum interval, guards against hammering the model. */
export const MIN_INTERVAL_MS = 5_000;

export const DEFAULT_MESSAGE = "汇报当前进度、状态和下一步计划(简短)";

/** When an `at` time has only just passed, fire instead of rolling a day forward. */
export const AT_GRACE_MS = 60_000;

export interface LoopSpec {
	/** Repeat interval in ms. Undefined marks a one-shot task. */
	intervalMs?: number;
	/** Instruction repeated on every tick. */
	message: string;
	/** Optional tick limit (`xN`). Defaults to 1 for one-shot tasks. */
	limit?: number;
	/** Fire the first tick right away (`now`). */
	immediate: boolean;
	/** Absolute first-tick time in epoch ms, from `at` / `in`. */
	startAt?: number;
}

export type LoopAction =
	| { kind: "start"; spec: LoopSpec; note?: string }
	| { kind: "stop" }
	| { kind: "status" }
	| { kind: "help" }
	| { kind: "error"; message: string };

const UNIT_MS: Record<string, number> = {
	ms: 1,
	s: 1_000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
};

const DURATION_TOKEN = /^(?:\d+(?:\.\d+)?(?:ms|s|m|h|d))+$/;
const DURATION_PART = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/g;
const TIME_TOKEN = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;
const DATE_TOKEN = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const DATE_TIME_TOKEN = /^(\d{4}-\d{1,2}-\d{1,2})[T ](\d{1,2}:\d{2}(?::\d{2})?)$/;

const STOP_WORDS = new Set(["stop", "off", "cancel", "end", "kill", "停止", "取消", "关闭"]);
const STATUS_WORDS = new Set(["status", "state", "info", "ls", "list", "状态", "查看"]);
const HELP_WORDS = new Set(["help", "-h", "--help", "?", "帮助"]);
const NOW_WORDS = new Set(["now", "immediate", "立即", "马上"]);
const AT_WORDS = new Set(["at", "@", "on", "在", "到"]);
const IN_WORDS = new Set(["in", "after", "delay", "wait"]);
const EVERY_WORDS = new Set(["every", "each", "每"]);

/**
 * Parse a duration token: `500ms`, `30s`, `1.5m`, `2h`, `1d`, `1h30m`.
 * A bare number is treated as seconds.
 */
export function parseDuration(input: string): number | undefined {
	const text = input.trim().toLowerCase();
	if (!text) return undefined;
	if (/^\d+(?:\.\d+)?$/.test(text)) return Math.round(Number(text) * 1_000);
	if (!DURATION_TOKEN.test(text)) return undefined;

	let total = 0;
	for (const match of text.matchAll(DURATION_PART)) {
		total += Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
	}
	return Math.round(total);
}

/** Render a duration compactly: `1d2h`, `1h30m`, `3m`, `45s`, `800ms`. */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "0s";
	if (ms < 1_000) return `${Math.round(ms)}ms`;

	let rest = Math.round(ms / 1_000) * 1_000;
	const parts: string[] = [];
	for (const [suffix, size] of [
		["d", UNIT_MS.d],
		["h", UNIT_MS.h],
		["m", UNIT_MS.m],
		["s", UNIT_MS.s],
	] as const) {
		if (rest < size) continue;
		const value = Math.floor(rest / size);
		rest -= value * size;
		parts.push(`${value}${suffix}`);
	}
	return parts.join("") || "0s";
}

/** Render a wall-clock time: `HH:MM[:SS]`, or `MM-DD HH:MM[:SS]` when it is not today. */
export function formatDateTime(ts: number, now: number = Date.now()): string {
	const date = new Date(ts);
	const today = new Date(now);
	const pad = (value: number) => String(value).padStart(2, "0");
	const time = `${pad(date.getHours())}:${pad(date.getMinutes())}${date.getSeconds() ? `:${pad(date.getSeconds())}` : ""}`;
	const sameDay =
		date.getFullYear() === today.getFullYear() &&
		date.getMonth() === today.getMonth() &&
		date.getDate() === today.getDate();
	return sameDay ? time : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

export interface ResolvedAt {
	at: number;
	/** Extra user-facing remark, e.g. the time rolled over to tomorrow. */
	note?: string;
}

/**
 * Turn a `HH:MM[:SS]` token (with an optional `YYYY-MM-DD` date) into an epoch timestamp.
 * A time-only token that already passed rolls forward to tomorrow; an explicit date in the
 * past is rejected. Times missed by less than {@link AT_GRACE_MS} fire right away.
 */
export function resolveAtTime(now: number, timeToken: string, dateToken?: string): ResolvedAt | { error: string } {
	const time = TIME_TOKEN.exec(timeToken);
	if (!time) return { error: `无法解析时间 "${timeToken}",应为 HH:MM 或 HH:MM:SS` };
	const hours = Number(time[1]);
	const minutes = Number(time[2]);
	const seconds = time[3] ? Number(time[3]) : 0;
	if (hours > 23 || minutes > 59 || seconds > 59) return { error: `时间超出范围:${timeToken}` };

	let base: Date;
	if (dateToken !== undefined) {
		const date = DATE_TOKEN.exec(dateToken);
		if (!date) return { error: `无法解析日期 "${dateToken}",应为 YYYY-MM-DD` };
		const [year, month, day] = [Number(date[1]), Number(date[2]) - 1, Number(date[3])];
		base = new Date(year, month, day, hours, minutes, seconds, 0);
		if (base.getFullYear() !== year || base.getMonth() !== month || base.getDate() !== day) {
			return { error: `日期无效:${dateToken}` };
		}
	} else {
		const current = new Date(now);
		base = new Date(current.getFullYear(), current.getMonth(), current.getDate(), hours, minutes, seconds, 0);
	}

	let at = base.getTime();
	let note: string | undefined;
	if (at < now - AT_GRACE_MS) {
		if (dateToken !== undefined) return { error: `指定时间已过去:${formatDateTime(at, now)}` };
		// Same wall-clock time tomorrow, DST-safe.
		base.setDate(base.getDate() + 1);
		at = base.getTime();
		note = `已过今天 ${timeToken},顺延到明天同一时间`;
	}
	// Just missed it: fire now rather than waiting a whole day.
	if (at < now) at = now;
	return { at, note };
}

export function parseCommand(raw: string, now: number = Date.now()): LoopAction {
	const tokens = raw.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return { kind: "status" };

	const head = tokens[0].toLowerCase();
	if (STOP_WORDS.has(head)) return { kind: "stop" };
	if (STATUS_WORDS.has(head)) return { kind: "status" };
	if (HELP_WORDS.has(head)) return { kind: "help" };

	const usage = "用法:/loop 3m 汇报 | /loop in 10m 检查 | /loop at 15:30 部署(详见 /loop help)";

	let intervalMs: number | undefined;
	let limit: number | undefined;
	let immediate = false;
	let startAt: number | undefined;
	let delayMs: number | undefined;
	let note: string | undefined;
	let index = 0;

	while (index < tokens.length) {
		const token = tokens[index].toLowerCase();

		// xN tick limit.
		const count = /^x(\d+)$/.exec(token);
		if (count) {
			const value = Number(count[1]);
			if (value > 0) limit = value;
			index += 1;
			continue;
		}

		// `now`: fire the first tick immediately.
		if (NOW_WORDS.has(token)) {
			immediate = true;
			index += 1;
			continue;
		}

		// `at 15:30` / `在 15:30` / bare `15:30` in the leading position.
		if (AT_WORDS.has(token) || (index === 0 && TIME_TOKEN.test(tokens[index]))) {
			if (startAt !== undefined || delayMs !== undefined) {
				return { kind: "error", message: "只能指定一个开始时间( at / in 二选一)" };
			}
			const keyword = AT_WORDS.has(token);
			const timeToken = keyword ? tokens[index + 1] : tokens[index];
			if (timeToken === undefined) return { kind: "error", message: "at 后面需要时间,如 at 15:30" };

			const combined = DATE_TIME_TOKEN.exec(timeToken);
			let resolved: ResolvedAt | { error: string };
			let consumed: number;
			if (combined) {
				resolved = resolveAtTime(now, combined[2], combined[1]);
				consumed = keyword ? 2 : 1;
			} else if (keyword && DATE_TOKEN.test(timeToken)) {
				const dayTime = tokens[index + 2];
				if (dayTime === undefined || !TIME_TOKEN.test(dayTime)) {
					return { kind: "error", message: `日期后还需要时间:at ${timeToken} HH:MM` };
				}
				resolved = resolveAtTime(now, dayTime, timeToken);
				consumed = 3;
			} else if (TIME_TOKEN.test(timeToken)) {
				resolved = resolveAtTime(now, timeToken);
				consumed = keyword ? 2 : 1;
			} else {
				return { kind: "error", message: `无法解析时间 "${timeToken}",应为 HH:MM[:SS] 或 YYYY-MM-DD HH:MM` };
			}
			if ("error" in resolved) return { kind: "error", message: resolved.error };
			startAt = resolved.at;
			note = resolved.note;
			index += consumed;
			continue;
		}

		// `in 10m` / `after 2h` / `+30m`: relative delay before the first tick.
		if (IN_WORDS.has(token) || token.startsWith("+")) {
			if (startAt !== undefined || delayMs !== undefined) {
				return { kind: "error", message: "只能指定一个开始时间( at / in 二选一)" };
			}
			const inline = token.startsWith("+");
			const delayToken = inline ? token.slice(1) : tokens[index + 1];
			const delay = delayToken === undefined ? undefined : parseDuration(delayToken);
			if (delay === undefined) return { kind: "error", message: "in 后面需要时长,如 in 10m / in 2h30m" };
			if (delay < MIN_INTERVAL_MS) {
				return { kind: "error", message: `延迟太短,最小 ${formatDuration(MIN_INTERVAL_MS)}` };
			}
			delayMs = delay;
			index += inline ? 1 : 2;
			continue;
		}

		// `every 5m`: explicit repeat interval.
		if (EVERY_WORDS.has(token)) {
			const interval = tokens[index + 1] === undefined ? undefined : parseDuration(tokens[index + 1]);
			if (interval === undefined) return { kind: "error", message: "every 后面需要时长,如 every 5m" };
			if (interval < MIN_INTERVAL_MS) {
				return { kind: "error", message: `间隔太短,最小 ${formatDuration(MIN_INTERVAL_MS)}` };
			}
			if (intervalMs !== undefined) return { kind: "error", message: "重复间隔只能指定一次" };
			intervalMs = interval;
			index += 2;
			continue;
		}

		// Legacy shorthand: a bare duration in the leading position is the repeat interval.
		if (index === 0) {
			const interval = parseDuration(token);
			if (interval !== undefined) {
				if (interval < MIN_INTERVAL_MS) {
					return { kind: "error", message: `间隔太短,最小 ${formatDuration(MIN_INTERVAL_MS)}` };
				}
				intervalMs = interval;
				index += 1;
				continue;
			}
		}

		// First instruction word: the rest of the line is the message.
		break;
	}

	if (immediate && (startAt !== undefined || delayMs !== undefined)) {
		return { kind: "error", message: "now 不能与 at / in 同时使用" };
	}

	if (delayMs !== undefined) {
		startAt = now + delayMs;
		// `in 10m x3` repeats at the delay interval, so it runs at +10m, +20m, +30m.
		// A plain `in 10m` stays a genuine one-shot with no repeat interval.
		if (intervalMs === undefined && limit !== undefined && limit > 1) intervalMs = delayMs;
	}

	if (intervalMs === undefined) {
		// No repeat interval: a one-shot task.
		if (limit !== undefined && limit > 1) {
			return {
				kind: "error",
				message: "没有重复间隔,无法执行多次:请加 every <间隔>,如 /loop at 15:30 every 5m x3",
			};
		}
		limit = 1;
	}

	if (intervalMs === undefined && startAt === undefined && !immediate) {
		return { kind: "error", message: `无法解析 "${tokens[0]}"。${usage}` };
	}

	const message = tokens.slice(index).join(" ").trim() || DEFAULT_MESSAGE;
	return { kind: "start", spec: { intervalMs, message, limit, immediate, startAt }, note };
}

/** One-line human description of a loop spec. */
export function describeSpec(spec: LoopSpec, ticks = 0, now: number = Date.now()): string {
	const done = ticks > 0 ? ` · 已执行 ${ticks} 次` : "";
	const instruction = ` · 指令「${spec.message}」`;
	if (spec.limit === 1) {
		const when = spec.immediate
			? "立即"
			: spec.startAt !== undefined
				? `${formatDateTime(spec.startAt, now)}(约 ${formatDuration(spec.startAt - now)} 后)`
				: `${formatDuration(spec.intervalMs ?? 0)} 后`;
		return `${when}执行一次${done}${instruction}`;
	}
	const start = spec.startAt !== undefined ? `${formatDateTime(spec.startAt, now)} 开始 · ` : "";
	const limitText = spec.limit !== undefined ? `共 ${spec.limit} 次` : "不限次数";
	return `${start}每 ${formatDuration(spec.intervalMs ?? 0)} · ${limitText}${done}${instruction}`;
}