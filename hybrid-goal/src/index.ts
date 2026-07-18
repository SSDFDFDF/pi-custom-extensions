/**
 * hybrid-goal — Pi extension entrypoint
 *
 * Independent goal runtime for Pi:
 * - /goal continuation, pause/resume, budget, stale-turn guards
 * - MiMo-style optional independent judge on goal_complete
 * - /goal-config for hybrid-goal.config.json
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	loadConfig,
	packageRootFromUrl,
	saveConfig,
	type HybridGoalConfig,
} from "./config.js";
import registerGoal from "./goal.js";

const PACKAGE_ROOT = packageRootFromUrl(import.meta.url);

export default function hybridGoal(pi: ExtensionAPI) {
	const config = loadConfig(PACKAGE_ROOT);
	registerGoal(pi, { packageRoot: PACKAGE_ROOT, config });

	pi.registerCommand("goal-config", {
		description: "Show or set hybrid-goal config: /goal-config [key=value...]",
		getArgumentCompletions: (prefix: string) => {
			const keys = [
				"judgeEnabled=",
				"judgeFailPolicy=",
				"judgeModel=",
				"maxReact=",
				"maxContinuations=",
				"neverBlock=",
				"judgeTranscriptChars=",
				"continueDeferContextPercent=",
			];
			const p = prefix.trimStart();
			const items = keys
				.filter((k) => !p || k.startsWith(p))
				.map((k) => ({
					value: k,
					label: k.replace(/=$/, ""),
					description: "Set config key",
				}));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			await handleConfig(tokenize(args.trim()), ctx);
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
			case "continueDeferContextPercent": {
				const n = Number(value);
				if (!Number.isFinite(n) || n < 0) {
					ctx.ui.notify("continueDeferContextPercent must be >= 0 (0 = off)", "warning");
					return;
				}
				patch.continueDeferContextPercent = Math.min(100, Math.floor(n));
				break;
			}
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
