import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
register("./resolve-ts-from-js.mjs", pathToFileURL(join(root, "test/")));

const TEST_CONFIG = {
	judgeEnabled: false,
	judgeFailPolicy: "fail-open",
	judgeModel: "",
	maxReact: 12,
	maxContinuations: 0,
	neverBlock: false,
	judgeTranscriptChars: 120_000,
	continueDeferContextPercent: 95,
};

function createHarness() {
	const events = new Map();
	const notifications = [];
	const sentUserMessages = [];
	const entries = [];
	const compactCalls = [];
	const tools = new Map();
	let activeTools = ["read", "bash", "edit", "write", "grep", "find", "ls"];
	const activeToolHistory = [];
	let commandHandler;
	const branch = [];
	let contextPercent = null;
	let aborted = 0;

	const pi = {
		on(event, handler) {
			const list = events.get(event) ?? [];
			list.push(handler);
			events.set(event, list);
		},
		registerCommand(name, def) {
			if (name === "goal") commandHandler = def.handler;
		},
		registerTool(tool) {
			const name = tool?.name ?? tool?.toolName;
			if (name) {
				tools.set(name, tool);
				// Pi makes newly registered tools available; goal runtime must strip until /goal.
				if (!activeTools.includes(name)) activeTools = [...activeTools, name];
			}
		},
		getActiveTools() {
			return [...activeTools];
		},
		setActiveTools(names) {
			activeTools = [...names];
			activeToolHistory.push([...names]);
		},
		appendEntry(type, data) {
			entries.push({ type, data });
		},
		sendUserMessage(text) {
			sentUserMessages.push(text);
		},
		sendMessage() {},
	};

	return {
		events,
		notifications,
		sentUserMessages,
		entries,
		compactCalls,
		tools,
		activeToolHistory,
		getActiveTools: () => [...activeTools],
		setActiveTools: (names) => {
			activeTools = [...names];
			activeToolHistory.push([...names]);
		},
		branch,
		get aborted() {
			return aborted;
		},
		setContextPercent(pct) {
			contextPercent = pct;
		},
		async boot(registerGoal) {
			registerGoal(pi, { config: TEST_CONFIG });
			const ctx = {
				cwd: "/tmp/hybrid-goal-harness",
				sessionManager: {
					getBranch: () => branch,
					getEntries: () => branch,
				},
				ui: {
					notify(message, level = "info") {
						notifications.push({ message, level });
					},
					setStatus() {},
					theme: undefined,
					confirm: async () => true,
				},
				isIdle: () => true,
				hasPendingMessages: () => false,
				abort() {
					aborted += 1;
				},
				getContextUsage: () =>
					contextPercent === null
						? { tokens: null, contextWindow: 272000, percent: null }
						: {
								tokens: Math.round((contextPercent / 100) * 272000),
								contextWindow: 272000,
								percent: contextPercent,
							},
				compact(options = {}) {
					compactCalls.push(options);
					if (options?.onError && options.__fail) {
						options.onError(new Error(options.__failMessage ?? "compact failed"));
					}
				},
			};
			// Allow tests to force compact onError by mutating last call options via failNextCompact.
			const originalCompact = ctx.compact.bind(ctx);
			ctx.failNextCompact = false;
			ctx.compact = (options = {}) => {
				const opts = { ...options };
				compactCalls.push(opts);
				if (ctx.failNextCompact) {
					ctx.failNextCompact = false;
					opts.onError?.(new Error("compact failed"));
				}
			};

			events.get("session_start")?.[0]?.({}, ctx);
			return {
				ctx,
				async startGoal(args) {
					assert.ok(commandHandler, "goal command registered");
					await commandHandler(args, ctx);
				},
				async runCommand(args) {
					assert.ok(commandHandler, "goal command registered");
					await commandHandler(args, ctx);
				},
				async emit(event, payload = {}) {
					const handlers = events.get(event) ?? [];
					let last;
					for (const h of handlers) last = await h(payload, ctx);
					return last;
				},
				async callTool(name, params = {}) {
					const tool = tools.get(name);
					assert.ok(tool?.execute, `tool registered: ${name}`);
					return tool.execute("call-1", params, new AbortController().signal, () => {}, ctx);
				},
				latestGoalId() {
					for (let i = entries.length - 1; i >= 0; i--) {
						const e = entries[i];
						if (e.type === "goal-state" && e.data?.goal?.id) return e.data.goal.id;
					}
					return undefined;
				},
				latestGoalStatus() {
					for (let i = entries.length - 1; i >= 0; i--) {
						const e = entries[i];
						if (e.type === "goal-state" && e.data?.goal) return e.data.goal.status;
					}
					return undefined;
				},
			};
		},
	};
}

async function loadGoal() {
	return (await import(pathToFileURL(join(root, "src/goal.ts")).href)).default;
}

test("hook harness: over-budget active does not cancel threshold compact", async () => {
	const registerGoal = await loadGoal();
	const h = createHarness();
	const runtime = await h.boot(registerGoal);
	await runtime.startGoal("--tokens 10 finish the work");

	// Billable growth well over budget: 100 input + 20 output
	h.branch.push({
		type: "message",
		message: {
			role: "assistant",
			usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120 },
		},
	});

	const before = await runtime.emit("session_before_compact", {
		reason: "threshold",
		willRetry: false,
	});
	assert.equal(before?.cancel, undefined, "must not cancel threshold compact when active over budget");

	const after = await runtime.emit("session_compact", {
		reason: "threshold",
		willRetry: false,
	});
	assert.equal(after, undefined);
	// Budget stop should warn; no auto-continue user message required if already over budget.
	assert.ok(
		h.notifications.some((n) => /budget reached|token budget/i.test(n.message)),
		`expected budget notification, got ${JSON.stringify(h.notifications)}`,
	);
});

test("hook harness: budget_limited + willRetry cancels; manual compact allowed", async () => {
	const h = createHarness();
	const runtime = await h.boot(await loadGoal());
	await runtime.startGoal("--tokens 10 finish the work");
	h.branch.push({
		type: "message",
		message: {
			role: "assistant",
			usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120 },
		},
	});
	await runtime.emit("session_before_compact", { reason: "threshold", willRetry: false });
	await runtime.emit("session_compact", { reason: "threshold", willRetry: false });

	const cancelRetry = await runtime.emit("session_before_compact", {
		reason: "overflow",
		willRetry: true,
	});
	assert.deepEqual(cancelRetry, { cancel: true });

	const allowManual = await runtime.emit("session_before_compact", {
		reason: "manual",
		willRetry: false,
	});
	assert.equal(allowManual?.cancel, undefined);
});

test("hook harness: high context defers continue and requests compact; failures give up", async () => {
	const h = createHarness();
	const runtime = await h.boot(await loadGoal());
	await runtime.startGoal("finish the work");

	// Normal agent_end queues continuation
	await runtime.emit("agent_end", {
		messages: [{ role: "assistant", stopReason: "stop", content: [] }],
	});

	h.setContextPercent(119.2);
	const beforeMsgs = h.sentUserMessages.length;
	// First settle: defer + compact request that fails immediately via onError.
	runtime.ctx.failNextCompact = true;
	await runtime.emit("agent_settled", {});
	assert.equal(h.sentUserMessages.length, beforeMsgs, "must not send continue at 119%");
	assert.ok(h.compactCalls.length >= 1, "should request compact");
	assert.ok(
		h.notifications.some((n) => /deferred/i.test(n.message)),
		"should warn about deferral",
	);
	assert.ok(
		h.notifications.some((n) => /compact failed/i.test(n.message)),
		`expected first compact failure notice: ${JSON.stringify(h.notifications)}`,
	);

	// Second settle: compactRequested was cleared by failure → request again and fail.
	runtime.ctx.failNextCompact = true;
	await runtime.emit("agent_settled", {});
	assert.ok(
		h.notifications.some((n) => /failed 2|manual|new session/i.test(n.message)),
		`expected give-up notice: ${JSON.stringify(h.notifications)}`,
	);

	// Still deferred: no continue while high
	const mid = h.sentUserMessages.length;
	await runtime.emit("agent_settled", {});
	assert.equal(h.sentUserMessages.length, mid);

	// Compact success clears defer and re-queues on session_compact continue path
	h.setContextPercent(40);
	await runtime.emit("session_before_compact", { reason: "manual", willRetry: false });
	await runtime.emit("session_compact", { reason: "manual", willRetry: false });
	assert.ok(
		h.sentUserMessages.length > mid ||
			h.notifications.some((n) => /budget reached/i.test(n.message)),
		"after compact, either continue or budget stop",
	);
});

test("hook harness: pause blocks stale tools; resume clears and continues", async () => {
	const h = createHarness();
	const runtime = await h.boot(await loadGoal());
	await runtime.startGoal("finish the work");
	const goalId = runtime.latestGoalId();
	assert.ok(goalId);

	// Active: tool_call not blocked by stale guard
	const open = await runtime.emit("tool_call", { toolName: "bash" });
	assert.equal(open?.block, undefined);

	await runtime.runCommand("pause");
	assert.equal(runtime.latestGoalStatus(), "paused");
	assert.ok(h.aborted >= 1, "pause should abort current turn");

	const blocked = await runtime.emit("tool_call", { toolName: "bash" });
	assert.equal(blocked?.block, true);
	assert.match(String(blocked?.reason ?? ""), /stale|stopped|interrupted/i);

	// goal_complete with stale pause state rejected
	const completeWhilePaused = await runtime.callTool("goal_complete", {
		goal_id: goalId,
		summary: "done with evidence",
	});
	assert.match(String(completeWhilePaused?.content?.[0]?.text ?? ""), /not active|paused/i);

	const beforeResumeMsgs = h.sentUserMessages.length;
	await runtime.runCommand("resume");
	assert.equal(runtime.latestGoalStatus(), "active");
	assert.ok(
		h.sentUserMessages.length > beforeResumeMsgs,
		"resume should send resume prompt",
	);

	const openAgain = await runtime.emit("tool_call", { toolName: "bash" });
	assert.equal(openAgain?.block, undefined);
});

test("hook harness: agent abort pauses goal and blocks stale tools", async () => {
	const h = createHarness();
	const runtime = await h.boot(await loadGoal());
	await runtime.startGoal("finish the work");

	await runtime.emit("agent_end", {
		messages: [{ role: "assistant", stopReason: "aborted", content: [] }],
	});
	assert.equal(runtime.latestGoalStatus(), "paused");
	const blocked = await runtime.emit("tool_call", { toolName: "read" });
	assert.equal(blocked?.block, true);
});

test("hook harness: goal_complete rejects empty summary; accepts with judge off", async () => {
	const h = createHarness();
	const runtime = await h.boot(await loadGoal());
	await runtime.startGoal("finish the work");
	const goalId = runtime.latestGoalId();

	const empty = await runtime.callTool("goal_complete", {
		goal_id: goalId,
		summary: "   ",
	});
	assert.match(String(empty?.content?.[0]?.text ?? ""), /summary is empty/i);
	assert.equal(runtime.latestGoalStatus(), "active");

	const ok = await runtime.callTool("goal_complete", {
		goal_id: goalId,
		summary: "Implemented and verified with tests in worktree.",
	});
	assert.match(String(ok?.content?.[0]?.text ?? ""), /Goal complete/i);
	assert.equal(ok?.terminate, true);
});

test("hook harness: goal tools inactive until /goal; active while running; off after complete/pause", async () => {
	const h = createHarness();
	const runtime = await h.boot(await loadGoal());

	// session_start with no goal should strip auto-activated goal tools
	assert.equal(h.getActiveTools().includes("goal_complete"), false);
	assert.equal(h.getActiveTools().includes("goal_blocked"), false);

	await runtime.startGoal("finish the work");
	assert.equal(h.getActiveTools().includes("goal_complete"), true);
	assert.equal(h.getActiveTools().includes("goal_blocked"), true);
	// other tools preserved
	assert.equal(h.getActiveTools().includes("bash"), true);

	await runtime.runCommand("pause");
	assert.equal(h.getActiveTools().includes("goal_complete"), false);
	assert.equal(h.getActiveTools().includes("goal_blocked"), false);

	await runtime.runCommand("resume");
	assert.equal(h.getActiveTools().includes("goal_complete"), true);

	const goalId = runtime.latestGoalId();
	const ok = await runtime.callTool("goal_complete", {
		goal_id: goalId,
		summary: "Implemented and verified with tests in worktree.",
	});
	assert.match(String(ok?.content?.[0]?.text ?? ""), /Goal complete/i);
	assert.equal(h.getActiveTools().includes("goal_complete"), false);
	assert.equal(h.getActiveTools().includes("goal_blocked"), false);
});

test("hook harness: before_agent_start re-syncs goal tools with active goal", async () => {
	const h = createHarness();
	const runtime = await h.boot(await loadGoal());
	await runtime.startGoal("finish the work");
	assert.equal(h.getActiveTools().includes("goal_complete"), true);

	// External tool-set change drops goal tools mid-run.
	h.setActiveTools(h.getActiveTools().filter((n) => n !== "goal_complete" && n !== "goal_blocked"));
	assert.equal(h.getActiveTools().includes("goal_complete"), false);

	const result = await runtime.emit("before_agent_start", {
		prompt: "continue",
		systemPrompt: "base",
	});
	assert.match(String(result?.systemPrompt ?? ""), /Active \/goal/);
	assert.equal(h.getActiveTools().includes("goal_complete"), true);
	assert.equal(h.getActiveTools().includes("goal_blocked"), true);
});
