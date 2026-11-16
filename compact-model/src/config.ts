/**
 * compact-model — 配置读写
 *
 * 配置文件: `<agentDir>/compact-model.config.json`（默认 ~/.pi/agent，尊重
 * PI_CODING_AGENT_DIR）。首次加载时写入默认值。风格与字段约束对齐
 * kun-retry/src/config.ts。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import process from "node:process";

export interface CompactModelConfig {
	/** 总开关：false 时钩子第一行就 return（零侵入）。 */
	enabled: boolean;
	/** 压缩专用模型 provider id（models.json 里的 key）。 */
	provider: string;
	/** 压缩专用模型 id。 */
	model: string;
	/** 压缩时的 thinking level："off"（默认，省钱）或 "inherit"（会话级别）。 */
	thinkingLevel: "off" | "inherit";
	/** 指定模型解析/调用失败时是否回退 pi 原版压缩。true = 永不阻断会话。 */
	fallbackToDefault: boolean;
}

export const DEFAULT_CONFIG: CompactModelConfig = {
	enabled: false,
	provider: "",
	model: "",
	thinkingLevel: "off",
	fallbackToDefault: true,
};

const CONFIG_FILE_NAME = "compact-model.config.json";

export function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function configPath(): string {
	return join(agentDir(), CONFIG_FILE_NAME);
}

function asString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function asBoolean(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") return value;
	return fallback;
}

function asThinkingLevel(value: unknown): "off" | "inherit" {
	return value === "inherit" ? "inherit" : "off";
}

/** 规范化任意输入（文件内容或运行时 patch）为完整配置，非法字段回退默认。 */
export function normalizeConfig(raw: Partial<CompactModelConfig> | undefined): CompactModelConfig {
	const base = { ...DEFAULT_CONFIG, ...(raw ?? {}) };
	return {
		enabled: asBoolean(base.enabled, DEFAULT_CONFIG.enabled),
		provider: asString(base.provider),
		model: asString(base.model),
		thinkingLevel: asThinkingLevel(base.thinkingLevel),
		fallbackToDefault: asBoolean(base.fallbackToDefault, DEFAULT_CONFIG.fallbackToDefault),
	};
}

/** 未启用 = enabled=false 或 provider/model 为空。 */
export function isConfigured(cfg: CompactModelConfig): boolean {
	return cfg.enabled && cfg.provider !== "" && cfg.model !== "";
}

export function loadConfig(): CompactModelConfig {
	return loadConfigFrom(configPath());
}

/** 从指定路径读配置；文件不存在时静默返回默认（不触发写回，避免循环）。 */
function loadConfigFrom(path: string): CompactModelConfig {
	if (!existsSync(path)) return { ...DEFAULT_CONFIG };
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<CompactModelConfig>;
		return normalizeConfig(raw);
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

/** 原子写：先 .tmp 再 rename，避免半截文件。 */
export function saveConfig(patch: Partial<CompactModelConfig>): CompactModelConfig {
	const next = normalizeConfig({ ...loadConfigFrom(configPath()), ...patch });
	const path = configPath();
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(next, null, "\t")}\n`);
	renameSync(tmp, path);
	return next;
}

/** /compact-model status 的展示文本。 */
export function formatConfigSummary(cfg: CompactModelConfig): string {
	const target = isConfigured(cfg) ? `${cfg.provider}/${cfg.model}` : "(未设置)";
	return [
		`enabled: ${cfg.enabled}`,
		`model: ${target}`,
		`thinkingLevel: ${cfg.thinkingLevel}`,
		`fallbackToDefault: ${cfg.fallbackToDefault}`,
	].join("\n");
}
