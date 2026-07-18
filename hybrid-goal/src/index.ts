/**
 * hybrid-goal — Pi extension entrypoint
 *
 * Combines:
 * - pi-goal continuation / pause / budget / stale-turn state machine
 * - MiMo-style independent judge on goal_complete + maxReact hard cap
 * - /goal-evol controlled self-evolution against upstream sources
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	loadConfig,
	packageRootFromUrl,
	saveConfig,
	type HybridGoalConfig,
} from "./config.js";
import {
	applyEvolutionBase,
	formatReportSummary,
	listRecentReports,
	runEvolutionCheck,
} from "./evolve.js";
import registerGoal from "./goal.js";

const PACKAGE_ROOT = packageRootFromUrl(import.meta.url);

export default function hybridGoal(pi: ExtensionAPI) {
	const config = loadConfig(PACKAGE_ROOT);

	// Core goal runtime (command /goal + tools + lifecycle)
	registerGoal(pi, { packageRoot: PACKAGE_ROOT, config });

	// Evolution command
	pi.registerCommand("goal-evol", {
		description:
			"Evolve hybrid-goal from upstream pi-goal + MiMo-Code: check | apply | config | status",
		getArgumentCompletions: (prefix: string) => {
			const items = [
				{ value: "check", label: "check", description: "Fetch upstream and write a report" },
				{ value: "apply", label: "apply", description: "Apply accounting helper after confirmation" },
				{
					value: "apply --force",
					label: "apply --force",
					description: "Re-sync base even if no diff",
				},
				{ value: "status", label: "status", description: "Show config and recent reports" },
				{ value: "config", label: "config", description: "Show or set hybrid config keys" },
			];
			const p = prefix.trimStart();
			if (!p) return items;
			const filtered = items.filter(
				(i) => i.value.startsWith(p) || i.label.startsWith(p),
			);
			return filtered.length ? filtered : null;
		},
		handler: async (args, ctx) => {
			const tokens = tokenize(args.trim());
			const sub = tokens[0]?.toLowerCase() ?? "status";

			if (sub === "status" || sub === "show") {
				const cfg = loadConfig(PACKAGE_ROOT);
				const reports = listRecentReports(PACKAGE_ROOT, cfg, 5);
				ctx.ui.notify(
					[
						"hybrid-goal status",
						`package: ${PACKAGE_ROOT}`,
						`judge: ${cfg.judgeEnabled ? "on" : "off"} (${cfg.judgeFailPolicy})`,
						`judgeModel: ${cfg.judgeModel || "(session model)"}`,
						`maxReact (judge rejects): ${cfg.maxReact}`,
						`maxContinuations: ${cfg.maxContinuations === 0 ? "unlimited" : cfg.maxContinuations}`,
						`neverBlock: ${cfg.neverBlock ? "on (never auto-block; keep retrying)" : "off"}`,
						`upstreams:`,
						`  pi-goal: ${cfg.piGoalUpstream}`,
						`  mimo: ${cfg.mimoUpstream}`,
						`recent reports: ${reports.length ? reports.join(", ") : "(none)"}`,
						`commands: /goal-evol check | apply | config | status`,
					].join("\n"),
					"info",
				);
				return;
			}

			if (sub === "config") {
				await handleConfig(tokens.slice(1), ctx);
				return;
			}

			if (sub === "check") {
				ctx.ui.notify("Fetching upstream pi-goal + MiMo-Code…", "info");
				try {
					const cfg = loadConfig(PACKAGE_ROOT);
					const report = await runEvolutionCheck(pi, PACKAGE_ROOT, cfg);
					ctx.ui.notify(formatReportSummary(report), "info");
				} catch (error) {
					ctx.ui.notify(
						`goal-evol check failed: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				}
				return;
			}

			if (sub === "apply") {
				const force = tokens.includes("--force");
				const cfg = loadConfig(PACKAGE_ROOT);
				const ok = await ctx.ui.confirm(
					"Apply upstream helpers?",
					[
						"This rewrites only apply-safe helpers (currently src/accounting.ts) from the latest /goal-evol check cache.",
						"Hybrid runtime/forks are NOT replaced: goal, command, persistence, judge, evol, index, config, prompts.",
						"Upstream queue/runtime modules stay in cache/upstream-snapshots for review only.",
						"A backup is written under cache/backups/.",
						"npm test runs after apply; failed apply rolls back written files.",
						"You must /reload after a successful apply.",
						force ? "Force mode: re-sync even if no diff." : "",
					]
						.filter(Boolean)
						.join("\n"),
				);
				if (!ok) {
					ctx.ui.notify("Apply cancelled.", "info");
					return;
				}
				const result = await applyEvolutionBase(pi, PACKAGE_ROOT, cfg, { force });
				ctx.ui.notify(result.message, result.ok ? "info" : "warning");
				if (result.ok) {
					ctx.ui.notify("Run /reload to load the applied sources.", "warning");
				}
				return;
			}

			ctx.ui.notify(
				"Usage: /goal-evol check | apply [--force] | config [key=value...] | status",
				"warning",
			);
		},
	});

	// Reload helper command name reserved for post-apply UX
	pi.registerCommand("goal-evol-reload", {
		description: "Reload runtime after /goal-evol apply (alias of /reload-runtime path)",
		handler: async (_args, ctx) => {
			ctx.ui.notify("Reloading extensions…", "info");
			await ctx.reload();
		},
	});
}

async function handleConfig(
	tokens: string[],
	ctx: {
		ui: {
			notify: (message: string, level?: "info" | "warning" | "error") => void;
		};
	},
) {
	if (tokens.length === 0) {
		const cfg = loadConfig(PACKAGE_ROOT);
		ctx.ui.notify(`hybrid-goal.config.json:\n${JSON.stringify(cfg, null, 2)}`, "info");
		return;
	}

	const patch: Partial<HybridGoalConfig> = {};
	for (const token of tokens) {
		const eq = token.indexOf("=");
		if (eq <= 0) {
			ctx.ui.notify(`Invalid config token (use key=value): ${token}`, "warning");
			return;
		}
		const key = token.slice(0, eq);
		const value = token.slice(eq + 1);
		switch (key) {
			case "judgeEnabled":
				patch.judgeEnabled = value === "true" || value === "1" || value === "on";
				break;
			case "judgeFailPolicy":
				if (value !== "fail-open" && value !== "fail-closed") {
					ctx.ui.notify("judgeFailPolicy must be fail-open or fail-closed", "warning");
					return;
				}
				patch.judgeFailPolicy = value;
				break;
			case "judgeModel":
				patch.judgeModel = value;
				break;
			case "maxReact": {
				const n = Number(value);
				if (!Number.isFinite(n) || n < 1) {
					ctx.ui.notify("maxReact must be a positive number", "warning");
					return;
				}
				patch.maxReact = Math.floor(n);
				break;
			}
			case "maxContinuations": {
				const n = Number(value);
				if (!Number.isFinite(n) || n < 0) {
					ctx.ui.notify("maxContinuations must be >= 0 (0 = unlimited)", "warning");
					return;
				}
				patch.maxContinuations = Math.floor(n);
				break;
			}
			case "neverBlock":
				patch.neverBlock = value === "true" || value === "1" || value === "on";
				break;
			case "judgeTranscriptChars": {
				const n = Number(value);
				if (!Number.isFinite(n) || n < 8000) {
					ctx.ui.notify("judgeTranscriptChars must be >= 8000", "warning");
					return;
				}
				patch.judgeTranscriptChars = Math.floor(n);
				break;
			}
			case "piGoalUpstream":
				patch.piGoalUpstream = value;
				break;
			case "mimoUpstream":
				patch.mimoUpstream = value;
				break;
			default:
				ctx.ui.notify(`Unknown config key: ${key}`, "warning");
				return;
		}
	}

	const next = saveConfig(PACKAGE_ROOT, patch);
	ctx.ui.notify(
		`Config updated (reload to apply runtime options fully):\n${JSON.stringify(next, null, 2)}`,
		"info",
	);
}

function tokenize(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	for (const char of input) {
		if (quote) {
			if (char === quote) quote = undefined;
			else current += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current) tokens.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	if (current) tokens.push(current);
	return tokens;
}
