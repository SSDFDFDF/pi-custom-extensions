/** pi-pte — structured plan/task tools for Pi. */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, saveConfig } from "./config.ts";
import { PteStore, renderAgentContext } from "./store.ts";
import { registerTools } from "./tools.ts";
import type { PteConfig } from "./types.ts";
import { formatStatusText, refreshUi } from "./ui.ts";

export default function piPte(pi: ExtensionAPI): void {
	const store = new PteStore();
	store.setPersist((customType, data) => pi.appendEntry(customType, data));

	let config: PteConfig = loadConfig();
	let lastUiCtx: ExtensionContext | undefined;

	const paint = (ctx?: ExtensionContext) => {
		const current = ctx ?? lastUiCtx;
		if (!current) return;
		lastUiCtx = current;
		refreshUi(current, store.getState(), config);
	};

	registerTools(pi, store, () => paint());

	pi.registerCommand("pte", {
		description: "Plan-Task tools: status | clear | show | config",
		getArgumentCompletions: (prefix: string) => {
			const items = [
				{ value: "status", label: "status", description: "Show task state" },
				{ value: "clear", label: "clear", description: "Clear tasks" },
				{ value: "clear --doc", label: "clear --doc", description: "Clear tasks and plan doc" },
				{ value: "show", label: "show", description: "Show task state" },
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

			if (sub === "clear") {
				const clearPlanDoc = text.split(/\s+/).slice(1).includes("--doc");
				store.clearTasks({ clearPlanDoc });
				ctx.ui.notify(clearPlanDoc ? "Tasks and plan document cleared." : "Tasks cleared.", "info");
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
					ctx.ui.notify("Usage: /pte config key=value", "warning");
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

			ctx.ui.notify("Usage: /pte [status|show|clear [--doc]|config]", "warning");
		},
	});

	pi.on("before_agent_start", async (event) => {
		if (!config.injectContext) return;
		const state = store.getState();
		if (state.tasks.length === 0 && !state.planDoc) return;
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
		// UI + process-local caches only. Board state remains in session JSONL for resume.
		ctx.ui.setStatus("pte", undefined);
		ctx.ui.setWidget("pte", undefined);
		lastUiCtx = undefined;
		store.resetRuntimeCaches();
	});
}
