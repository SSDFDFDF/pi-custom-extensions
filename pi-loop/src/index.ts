/**
 * pi-loop — 定时循环 / 定时任务扩展
 *
 * /loop 3m 汇报进度              每 3 分钟自动触发一次,让 agent 执行指令并简短汇报
 * /loop 30s x5 now 检查构建      立即开始,30 秒一次,共 5 次
 * /loop in 10m 检查部署          10 分钟后执行一次
 * /loop at 15:30 every 5m x3 巡检 15:30 开始,每 5 分钟一次,共 3 次
 * /loop stop                     停止
 * /loop pause / resume           暂停 / 恢复(倒计时冻结,从中断处继续)
 * /loop status                   查看当前任务
 * /loop help                     用法
 *
 * 实现要点:
 * - 定时器只在命令/会话事件里创建,绝不在 factory 里创建(扩展可能在无会话的调用中加载)
 * - 触发时若 agent 正忙则跳过本次;单次任务每 30s 重试,循环任务顺延一个间隔
 * - 长延迟按 1h 分片 re-arm,避免 setTimeout 溢出并容忍时钟跳动
 * - session_shutdown 清理定时器;/reload 后从会话条目里自动恢复任务(过期的单次任务跳过)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	AT_GRACE_MS,
	DEFAULT_MESSAGE,
	describeSpec,
	formatDateTime,
	formatDuration,
	type LoopSpec,
	MIN_INTERVAL_MS,
	parseCommand,
} from "./parse.ts";

const STATUS_KEY = "loop";
const STATE_ENTRY = "loop-state";
const TICK_TYPE = "loop-tick";

/** Long delays are armed in chunks so a single setTimeout never overflows. */
const TIMER_CHUNK_MS = 60 * 60_000;
/** Slack when waking from a chunked timer, tolerating clock jitter. */
const WAKE_SLACK_MS = 500;
/** A one-shot that lands while the agent is busy is retried this often. */
const ONE_SHOT_BUSY_RETRY_MS = 30_000;

interface RunningLoop extends LoopSpec {
	/** Completed ticks so far. */
	ticks: number;
	/** Ticks skipped because the agent was busy (reset after each report). */
	skipped: number;
	startedAt: number;
	nextAt: number;
	/** Frozen time-to-next-tick while paused; `undefined` means running. */
	pausedRemainingMs?: number;
	timer?: ReturnType<typeof setTimeout>;
}

interface PersistedState {
	active: boolean;
	intervalMs?: number;
	message?: string;
	limit?: number;
	ticks?: number;
	startAt?: number;
	paused?: boolean;
	remainingMs?: number;
}

interface TickDetails {
	tick: number;
	limit?: number;
	intervalMs?: number;
	message: string;
	skipped: number;
	startAt?: number;
}

const HELP_TEXT = [
	"/loop <间隔> [xN] [now] [指令]            定时循环,如 /loop 3m 汇报进度",
	"/loop in <时长> [every <间隔>] [xN] [指令]  多久后执行(默认一次),如 /loop in 10m 检查日志",
	"/loop at <时间> [every <间隔>] [xN] [指令]  指定时间执行(已过则顺延明天),如 /loop at 15:30 部署",
	"/loop now [指令]                          立即执行一次",
	"/loop stop / status                       停止 / 查看当前任务",
	"/loop pause / resume                      暂停 / 恢复(倒计时冻结)",
	`时长:500ms / 30s / 3m / 2h / 1d / 1h30m / 裸数字按秒算,最小 ${formatDuration(MIN_INTERVAL_MS)}`,
	"时间:HH:MM[:SS] 或 YYYY-MM-DD HH:MM;xN 限定总次数(x1 即单次)",
	"agent 忙碌时顺延重试,下次汇报会带上跳过次数;单次任务每 30s 重试直到空闲",
].join("\n");

export default function (pi: ExtensionAPI) {
	let loop: RunningLoop | undefined;
	let statusTimer: ReturnType<typeof setInterval> | undefined;
	let sessionCtx: ExtensionContext | undefined;

	const ui = () => (sessionCtx?.hasUI ? sessionCtx.ui : undefined);

	function renderStatus(): void {
		const view = ui();
		if (!view) return;
		if (!loop) {
			view.setStatus(STATUS_KEY, undefined);
			return;
		}
		const now = Date.now();
		const paused = loop.pausedRemainingMs !== undefined;
		// A paused loop is frozen: show the stored remainder instead of a live countdown.
		const remaining = paused ? Math.max(0, loop.pausedRemainingMs ?? 0) : Math.max(0, loop.nextAt - now);
		const countdown = formatDuration(Math.ceil(remaining / 1000) * 1_000);
		const head = `${paused ? "⏸" : "⏱"}${loop.intervalMs ? ` ${formatDuration(loop.intervalMs)}` : " 单次"}`;
		const tail = paused ? `· 剩 ${countdown}` : `in ${countdown}`;
		// Waiting for a scheduled start: show the target time rather than a tick number.
		if (loop.startAt !== undefined && loop.ticks === 0 && remaining > 0) {
			// While paused even the target clock is frozen, so a long pause shows no stale date.
			view.setStatus(STATUS_KEY, `${head} → ${formatDateTime(loop.startAt, paused ? frozenNow(loop) : now)} ${tail}`);
			return;
		}
		const next = `#${loop.ticks + 1}${loop.limit ? `/${loop.limit}` : ""}`;
		view.setStatus(STATUS_KEY, `${head} → ${next} ${tail}`);
	}

	function clearTimers(): void {
		if (loop?.timer) clearTimeout(loop.timer);
		if (loop) loop.timer = undefined;
		if (statusTimer) {
			clearInterval(statusTimer);
			statusTimer = undefined;
		}
	}

	function persist(): void {
		const state: PersistedState = loop
			? {
					active: true,
					intervalMs: loop.intervalMs,
					message: loop.message,
					limit: loop.limit,
					ticks: loop.ticks,
					startAt: loop.startAt,
					paused: loop.pausedRemainingMs !== undefined,
					remainingMs: loop.pausedRemainingMs,
				}
			: { active: false };
		pi.appendEntry(STATE_ENTRY, state);
	}

	/** Arm the timer for `loop.nextAt`, re-arming in chunks for very long delays. */
	function armTimer(): void {
		if (!loop) return;
		if (loop.pausedRemainingMs !== undefined) return;
		const chunk = Math.min(Math.max(0, loop.nextAt - Date.now()), TIMER_CHUNK_MS);
		loop.timer = setTimeout(() => {
			if (!loop) return;
			if (loop.pausedRemainingMs !== undefined) return;
			if (loop.nextAt - Date.now() > WAKE_SLACK_MS) {
				armTimer();
				return;
			}
			fire();
		}, chunk);
		loop.timer.unref?.();

		if (!statusTimer && ui()) {
			statusTimer = setInterval(renderStatus, 1_000);
			statusTimer.unref?.();
		}
		renderStatus();
	}

	function schedule(delayMs: number): void {
		if (!loop) return;
		loop.nextAt = Date.now() + delayMs;
		armTimer();
	}

	/** Clock view of a paused loop, so descriptions read as the frozen remainder. */
	function frozenNow(state: RunningLoop): number {
		return state.startAt !== undefined && state.pausedRemainingMs !== undefined
			? state.startAt - state.pausedRemainingMs
			: Date.now();
	}

	/** Delay before the first tick: scheduled start, `now`, or the plain interval. */
	function firstDelay(spec: LoopSpec, now: number, restored: boolean): number {
		if (spec.startAt !== undefined) {
			if (spec.startAt > now) return spec.startAt - now;
			// Start time already reached: fire now, except a restored repeating loop that
			// paces itself by interval so a reload does not inject an extra tick.
			if (!restored || spec.limit === 1) return 0;
		}
		if (spec.immediate) return 0;
		return spec.intervalMs ?? 0;
	}

	function buildPrompt(state: RunningLoop, tick: number): string {
		const label = `#${tick}${state.limit ? `/${state.limit}` : ""}`;
		const header = state.intervalMs
			? `[定时循环 ${label} · 间隔 ${formatDuration(state.intervalMs)} · 自动触发]`
			: `[定时任务 ${label}${state.startAt !== undefined ? ` · 计划 ${formatDateTime(state.startAt)}` : ""} · 自动触发]`;
		const lines = [header, state.message];
		if (state.skipped > 0) {
			lines.push(`(此前 ${state.skipped} 次触发因为正在忙碌被跳过)`);
		}
		return lines.join("\n");
	}

	function fire(): void {
		if (!loop) return;

		// Agent is mid-turn: skip this tick instead of piling up queued reports.
		if (sessionCtx && !sessionCtx.isIdle()) {
			loop.skipped += 1;
			schedule(loop.intervalMs ?? ONE_SHOT_BUSY_RETRY_MS);
			return;
		}

		loop.ticks += 1;
		const tick = loop.ticks;
		const details: TickDetails = {
			tick,
			limit: loop.limit,
			intervalMs: loop.intervalMs,
			message: loop.message,
			skipped: loop.skipped,
			startAt: loop.startAt,
		};

		pi.sendMessage<TickDetails>(
			{
				customType: TICK_TYPE,
				content: buildPrompt(loop, tick),
				display: true,
				details,
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
		loop.skipped = 0;
		// Keep the persisted tick count fresh so /reload continues the numbering.
		persist();

		if (loop.limit && tick >= loop.limit) {
			stop(loop.intervalMs ? `定时循环结束(已完成 ${tick} 次)` : `定时任务完成(已执行 ${tick} 次)`);
			return;
		}
		schedule(loop.intervalMs ?? ONE_SHOT_BUSY_RETRY_MS);
	}

	function start(spec: LoopSpec, resumeTicks = 0, restored = false, pausedRemainingMs?: number): void {
		const replaced = Boolean(loop);
		clearTimers();
		loop = { ...spec, ticks: resumeTicks, skipped: 0, startedAt: Date.now(), nextAt: 0, pausedRemainingMs };
		persist();
		const prefix = replaced ? "替换旧任务," : "";
		if (pausedRemainingMs !== undefined) {
			renderStatus();
			ui()?.notify(
				`${prefix}定时任务已暂停(剩 ${formatDuration(pausedRemainingMs)}),/loop resume 继续:${describeSpec(loop, resumeTicks, frozenNow(loop))}`,
				"info",
			);
			return;
		}
		ui()?.notify(`${prefix}定时任务已启动:${describeSpec(loop, resumeTicks)}`, "info");
		schedule(firstDelay(loop, Date.now(), restored));
	}

	/** Freeze the countdown; the remaining time survives `/reload` via the persisted state. */
	function pause(): boolean {
		if (!loop || loop.pausedRemainingMs !== undefined) return false;
		loop.pausedRemainingMs = Math.max(0, loop.nextAt - Date.now());
		clearTimers();
		persist();
		renderStatus();
		ui()?.notify(`定时任务已暂停(剩 ${formatDuration(loop.pausedRemainingMs)}),/loop resume 继续`, "info");
		return true;
	}

	/** Resume a paused loop from the frozen remainder. */
	function resume(): boolean {
		if (!loop || loop.pausedRemainingMs === undefined) return false;
		const remaining = loop.pausedRemainingMs;
		loop.pausedRemainingMs = undefined;
		// Keep `startAt` truthful: the first tick now lands after the frozen remainder.
		if (loop.startAt !== undefined) loop.startAt = Date.now() + remaining;
		schedule(remaining);
		persist();
		ui()?.notify(`定时任务已恢复(剩 ${formatDuration(remaining)} 后触发)`, "info");
		return true;
	}

	function stop(note?: string): boolean {
		if (!loop) return false;
		clearTimers();
		loop = undefined;
		persist();
		ui()?.setStatus(STATUS_KEY, undefined);
		if (note) ui()?.notify(note, "info");
		return true;
	}

	function restoreFromSession(ctx: ExtensionContext): void {
		const entries = ctx.sessionManager.getEntries();
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index];
			if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) continue;
			const state = entry.data as PersistedState | undefined;
			if (!state?.active) return;

			const now = Date.now();
			const oneShot = state.limit === 1;
			const repeatable = state.intervalMs !== undefined && state.intervalMs >= MIN_INTERVAL_MS;
			const startAt = state.startAt;
			// A paused task keeps its frozen countdown, so its start time cannot expire.
			const pausedState = state.paused === true && state.remainingMs !== undefined;
			// A one-shot whose start time passed while pi was closed cannot run retroactively.
			if (!pausedState && oneShot && startAt !== undefined && startAt < now - AT_GRACE_MS) {
				ui()?.notify(
					`有一条定时任务(原定 ${formatDateTime(startAt, now)})在会话关闭期间过期,已跳过`,
					"warning",
				);
				return;
			}
			if (repeatable || startAt !== undefined) {
				loop = undefined;
				// A paused loop restores frozen, exactly where the user left it.
				start(
					{
						intervalMs: state.intervalMs,
						message: state.message || DEFAULT_MESSAGE,
						limit: state.limit,
						immediate: false,
						startAt,
					},
					state.ticks ?? 0,
					true,
					pausedState ? Math.max(0, state.remainingMs ?? 0) : undefined,
				);
			}
			return;
		}
	}

	pi.registerCommand("loop", {
		description:
			"定时循环/定时任务:/loop 3m | /loop in 10m | /loop at 15:30 [every <间隔>] [xN] [now] | stop | pause | resume | status",
		getArgumentCompletions: (prefix) => {
			const items = [
				{ value: "in", label: "in", description: "多久后执行,如 in 10m / in 2h" },
				{ value: "at", label: "at", description: "指定时间执行,如 at 15:30" },
				{ value: "every", label: "every", description: "重复间隔(与 at/in 连用)" },
				{ value: "30s", label: "30s", description: "每 30 秒" },
				{ value: "1m", label: "1m", description: "每 1 分钟" },
				{ value: "3m", label: "3m", description: "每 3 分钟" },
				{ value: "5m", label: "5m", description: "每 5 分钟" },
				{ value: "15m", label: "15m", description: "每 15 分钟" },
				{ value: "now", label: "now", description: "立即触发第一次" },
				{ value: "x5", label: "x5", description: "共执行 5 次" },
				{ value: "stop", label: "stop", description: "停止当前循环" },
				{ value: "pause", label: "pause", description: "暂停当前循环(倒计时冻结)" },
				{ value: "resume", label: "resume", description: "恢复暂停的循环" },
				{ value: "status", label: "status", description: "查看当前循环" },
				{ value: "help", label: "help", description: "用法说明" },
			];
			const filtered = items.filter((item) => item.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			sessionCtx ??= ctx;
			const action = parseCommand(args);

			switch (action.kind) {
				case "start":
					start(action.spec);
					if (action.note) ctx.ui.notify(action.note, "info");
					return;
				case "stop":
					if (!stop("定时任务已停止")) ctx.ui.notify("当前没有运行中的任务", "warning");
					return;
				case "pause":
					if (loop?.pausedRemainingMs !== undefined) ctx.ui.notify("定时任务已处于暂停状态", "warning");
					else if (!pause()) ctx.ui.notify("当前没有运行中的任务", "warning");
					return;
				case "resume":
					if (!resume()) ctx.ui.notify("没有已暂停的任务", "warning");
					return;
				case "status":
					ctx.ui.notify(
						loop
							? loop.pausedRemainingMs !== undefined
								? `定时任务已暂停:剩 ${formatDuration(loop.pausedRemainingMs)} · ${describeSpec(loop, loop.ticks, frozenNow(loop))}`
								: `定时任务运行中:${describeSpec(loop, loop.ticks)} · 下次约 ${formatDuration(Math.max(0, loop.nextAt - Date.now()))} 后`
							: `当前没有运行中的任务\n${HELP_TEXT}`,
						"info",
					);
					return;
				case "help":
					ctx.ui.notify(HELP_TEXT, "info");
					return;
				case "error":
					ctx.ui.notify(action.message, "warning");
					return;
			}
		},
	});

	pi.registerMessageRenderer<TickDetails>(TICK_TYPE, (message, _options, theme) => {
		const details = message.details;
		if (!details) return undefined;
		const label = `#${details.tick}${details.limit ? `/${details.limit}` : ""}`;
		let text = theme.fg("accent", details.intervalMs ? `⏱ Loop ${label}` : `⏱ Task ${label}`);
		if (details.intervalMs) {
			text += theme.fg("dim", ` · 每 ${formatDuration(details.intervalMs)}`);
		} else if (details.startAt !== undefined) {
			text += theme.fg("dim", ` · 计划 ${formatDateTime(details.startAt)}`);
		}
		text += ` ${theme.fg("muted", details.message)}`;
		if (details.skipped > 0) {
			text += theme.fg("dim", ` · 跳过 ${details.skipped} 次`);
		}
		return new Text(text, 0, 0);
	});

	pi.on("session_start", (event, ctx) => {
		sessionCtx = ctx;
		clearTimers();
		loop = undefined;
		// Keep the loop alive across /reload; do not auto-start when opening an old session.
		if (event.reason === "reload") restoreFromSession(ctx);
		renderStatus();
	});

	pi.on("session_shutdown", () => {
		clearTimers();
		loop = undefined;
		ui()?.setStatus(STATUS_KEY, undefined);
		sessionCtx = undefined;
	});
}