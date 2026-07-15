import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export type JudgeFailPolicy = "fail-closed" | "fail-open";

export interface HybridGoalConfig {
	/** Independent judge on goal_complete / stop attempts. Default false (requires a usable judge model). */
	judgeEnabled: boolean;
	/** On judge transport/parse failure: fail-closed rejects completion; fail-open allows it. */
	judgeFailPolicy: JudgeFailPolicy;
	/** Optional judge model as provider/id. Empty = use current session model. */
	judgeModel: string;
	/** Hard cap on judge rejections before the goal is blocked (MiMo MAX_GOAL_REACT). Default 12. */
	maxReact: number;
	/** Hard cap on automatic continuations (normal working turns). 0 = unlimited. Default 0. */
	maxContinuations: number;
	/** Never auto-transition to blocked; keep retrying instead (good for flaky networks). Default false. */
	neverBlock: boolean;
	/** Max chars of transcript text sent to the judge. Default 120_000. */
	judgeTranscriptChars: number;
	/** Upstream pi-goal git URL for /goal-evol. */
	piGoalUpstream: string;
	/** Upstream MiMo-Code git URL for /goal-evol. */
	mimoUpstream: string;
	/** Cache dir for evolution clones (relative to package or absolute). */
	evolCacheDir: string;
}

export const DEFAULT_CONFIG: HybridGoalConfig = {
	judgeEnabled: true,
	judgeFailPolicy: "fail-closed",
	judgeModel: "",
	maxReact: 12,
	maxContinuations: 0,
	neverBlock: false,
	judgeTranscriptChars: 120_000,
	piGoalUpstream: "https://github.com/narumiruna/pi-extensions.git",
	mimoUpstream: "https://github.com/XiaomiMiMo/MiMo-Code.git",
	evolCacheDir: "cache",
};

const CONFIG_FILE_NAME = "hybrid-goal.config.json";

export function packageRootFromUrl(importMetaUrl: string): string {
	// src/*.ts → package root is parent of src/
	return dirname(dirname(fileURLToPath(importMetaUrl)));
}

export function defaultConfigPath(packageRoot: string): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? ".", ".pi", "agent");
	return join(agentDir, CONFIG_FILE_NAME);
}

export function loadConfig(packageRoot: string): HybridGoalConfig {
	const path = defaultConfigPath(packageRoot);
	if (!existsSync(path)) return { ...DEFAULT_CONFIG };
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<HybridGoalConfig>;
		return normalizeConfig(raw);
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

export function saveConfig(packageRoot: string, patch: Partial<HybridGoalConfig>): HybridGoalConfig {
	const next = normalizeConfig({ ...loadConfig(packageRoot), ...patch });
	const path = defaultConfigPath(packageRoot);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
	return next;
}

export function resolveEvolCacheDir(packageRoot: string, config: HybridGoalConfig): string {
	if (config.evolCacheDir.startsWith("/")) return config.evolCacheDir;
	return join(packageRoot, config.evolCacheDir);
}

export function normalizeConfig(raw: Partial<HybridGoalConfig> | undefined): HybridGoalConfig {
	const base = { ...DEFAULT_CONFIG, ...(raw ?? {}) };
	const maxReact = Number(base.maxReact);
	const maxContinuations = Number(base.maxContinuations);
	const judgeTranscriptChars = Number(base.judgeTranscriptChars);
	return {
		judgeEnabled: base.judgeEnabled !== false,
		judgeFailPolicy: base.judgeFailPolicy === "fail-open" ? "fail-open" : "fail-closed",
		judgeModel: typeof base.judgeModel === "string" ? base.judgeModel.trim() : "",
		maxReact:
			Number.isFinite(maxReact) && maxReact >= 1
				? Math.min(Math.floor(maxReact), 100)
				: DEFAULT_CONFIG.maxReact,
		maxContinuations:
			Number.isFinite(maxContinuations) && maxContinuations >= 0
				? Math.min(Math.floor(maxContinuations), 100_000)
				: DEFAULT_CONFIG.maxContinuations,
		neverBlock: base.neverBlock === true,
		judgeTranscriptChars:
			Number.isFinite(judgeTranscriptChars) && judgeTranscriptChars >= 8_000
				? Math.floor(judgeTranscriptChars)
				: DEFAULT_CONFIG.judgeTranscriptChars,
		piGoalUpstream:
			typeof base.piGoalUpstream === "string" && base.piGoalUpstream.trim()
				? base.piGoalUpstream.trim()
				: DEFAULT_CONFIG.piGoalUpstream,
		mimoUpstream:
			typeof base.mimoUpstream === "string" && base.mimoUpstream.trim()
				? base.mimoUpstream.trim()
				: DEFAULT_CONFIG.mimoUpstream,
		evolCacheDir:
			typeof base.evolCacheDir === "string" && base.evolCacheDir.trim()
				? base.evolCacheDir.trim()
				: DEFAULT_CONFIG.evolCacheDir,
	};
}

export function parseModelRef(ref: string): { provider: string; modelId: string } | undefined {
	const trimmed = ref.trim();
	if (!trimmed) return undefined;
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash === trimmed.length - 1) return undefined;
	return { provider: trimmed.slice(0, slash), modelId: trimmed.slice(slash + 1) };
}
