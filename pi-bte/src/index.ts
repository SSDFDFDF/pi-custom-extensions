/** pi-bte — structured board/task tools for Pi. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, saveConfig } from "./config.ts";
import { BteStore, renderAgentContext } from "./store.ts";
import { registerTools } from "./tools.ts";
import type { BteConfig } from "./types.ts";
import { formatStatusText, refreshUi } from "./ui.ts";

export default function piBte(pi: ExtensionAPI): void {
	const store = new BteStore();
	store.setPersist((customType, data) => pi.appendEntry(customType, data));

	let config: BteConfig = loadConfig();
	let lastUiCtx: ExtensionContext | undefined;

	const paint = (ctx?: ExtensionContext) => {
		const current = ctx ?? lastUiCtx;
		if (!current) return;
		lastUiCtx = current;
		refreshUi(current, store.getState(), config);
	};

	registerTools(pi, store, () => paint());

	pi.registerCommand("bte", {
		description: "Board/task tools: status | clear | show | boards | config",
		getArgumentCompletions: (prefix: string) => {
			const items = [
				{ value: "status", label: "status", description: "Show task state" },
				{ value: "clear", label: "clear", description: "Clear tasks in scope" },
				{ value: "clear --doc", label: "clear --doc", description: "Clear tasks and board doc" },
				{ value: "clear --all", label: "clear --all", description: "Clear all tasks" },
				{ value: "show", label: "show", description: "Show task state" },
				{ value: "boards", label: "boards", description: "List boards" },
				{ value: "config", label: "config", description: "Show or set config" },
			];
			const query = prefix.trimStart();
			if (!query) return items;
			const filtered = items.filter((item) => item.value.startsWith(query));
			return filtered.length ? filtered : null;
		},
		handler: async (args, ctx) => {
			lastUiCtx = ctx;
			const text = (args ?? "").trim();
			const sub = text.split(/\s+/)[0]?.toLowerCase() || "status";

			if (sub === "status" || sub === "show") {
				ctx.ui.notify(formatStatusText(store.getState()), "info");
				return;
			}

			if (sub === "boards") {
				const boards = store.listBoards();
				ctx.ui.notify(
					boards.length
						? boards
								.map(
									(b) =>
										`${b.active ? "*" : " "} ${b.id}: ${b.title} (${b.taskCount} tasks)`,
								)
								.join("\n")
						: "No boards",
					"info",
				);
				return;
			}

			if (sub === "clear") {
				const flags = text.split(/\s+/).slice(1);
				const clearDoc = flags.includes("--doc");
				const all = flags.includes("--all");
				const result = store.clearTasks({
					clearDoc,
					scope: all ? "*" : undefined,
				});
				if (!result.ok) {
					ctx.ui.notify(result.error, "error");
					return;
				}
				ctx.ui.notify(
					clearDoc
						? `Cleared ${result.removed} task(s) and document(s).`
						: `Cleared ${result.removed} task(s).`,
					"info",
				);
				paint(ctx);
				return;
			}

			if (sub === "config") {
				const rest = text.slice(sub.length).trim();
				if (!rest) {
					ctx.ui.notify(JSON.stringify(config, null, 2), "info");
					return;
				}
				const match = /^(\w+)=(.*)$/.exec(rest);
				if (!match) {
					ctx.ui.notify("Usage: /bte config key=value", "warning");
					return;
				}
				const [, key, raw] = match;
				const next = { ...config };
				if (key === "injectContext" || key === "showWidget") {
					if (!["true", "false", "1", "0", "yes", "no"].includes(raw)) {
						ctx.ui.notify(`${key} must be true or false`, "error");
						return;
					}
					next[key] = raw === "true" || raw === "1" || raw === "yes";
				} else if (key === "widgetMaxTasks") {
					const value = Number(raw);
					if (!Number.isFinite(value) || value < 1) {
						ctx.ui.notify("widgetMaxTasks must be a positive number", "error");
						return;
					}
					next.widgetMaxTasks = Math.floor(value);
				} else {
					ctx.ui.notify(`Unknown config key: ${key}`, "error");
					return;
				}
				config = next;
				saveConfig(config);
				paint(ctx);
				ctx.ui.notify(`Saved ${key}`, "info");
				return;
			}

			ctx.ui.notify(
				"Usage: /bte [status|show|boards|clear [--doc|--all]|config]",
				"warning",
			);
		},
	});

	pi.on("before_agent_start", async (event) => {
		if (!config.injectContext) return;
		const state = store.getState();
		if (state.tasks.length === 0 && state.boards.length === 0) return;
		const content = renderAgentContext(state);
		if (!content) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${content}` };
	});

	pi.on("session_start", async (_event, ctx) => {
		lastUiCtx = ctx;
		store.reconstructFromSession(ctx);
		paint(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		lastUiCtx = ctx;
		store.reconstructFromSession(ctx);
		paint(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus("bte", undefined);
		ctx.ui.setWidget("bte", undefined);
		lastUiCtx = undefined;
		store.resetRuntimeCaches();
	});
}
