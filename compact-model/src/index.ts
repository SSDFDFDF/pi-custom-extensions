/**
 * compact-model — pi hooks + /compact-model 命令（装配层）
 *
 * 原理：拦截 session_before_compact，配置启用时用指定 provider/model 调用
 * pi 官方导出的 compact()（同一套摘要 prompt、切点、文件列表、usage 合并），
 * 仅替换 LLM 与鉴权；未配置时钩子第一行返回，完全零侵入。
 *
 * 已知限制：
 * - streamFn 固定传 undefined → compact() 走 completeSimple 直连，不经
 *   ModelRuntime 的 streamSimple；client-mimic 的 wrapProviders（wrap
 *   streamSimple）不覆盖本路径。需要客户端伪装的端点不适合作为压缩模型。
 * - thinkingLevel 默认 "off"：压缩是单次离线摘要，烧 thinking 不划算；
 *   "inherit" 会用会话当前级别（仅当模型 reasoning 时生效）。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { compact } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import {
	type CompactModelConfig,
	agentDir,
	formatConfigSummary,
	loadConfig,
	saveConfig,
} from "./config.ts";
import { handleBeforeCompact, readRetrySettings, type ModelResolution } from "./decide.ts";

function notify(ctx: ExtensionContext, level: "info" | "warning" | "error", message: string): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

/** 解析配置指向的模型：find + hasConfiguredAuth + getApiKeyAndHeaders。 */
async function resolveModel(
	ctx: ExtensionContext,
	cfg: CompactModelConfig,
): Promise<ModelResolution | undefined> {
	if (!cfg.provider || !cfg.model) return undefined;
	const model = ctx.modelRegistry.find(cfg.provider, cfg.model);
	if (!model) return { model: undefined, hasAuth: false, auth: undefined };
	const hasAuth = ctx.modelRegistry.hasConfiguredAuth(model);
	let auth: ModelResolution["auth"];
	try {
		auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	} catch (error) {
		auth = { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
	return { model: model as unknown as Record<string, unknown>, hasAuth, auth };
}

const describeProviders = (ctx: ExtensionContext): string => {
	const providers = new Set(ctx.modelRegistry.getAvailable().map((m) => m.provider));
	return [...providers].join(", ");
};

/** pi 内部同款：滤掉 null（删除头标记）后的 headers；全空返回 undefined。 */
function withoutDeletedHeaders(
	headers: Record<string, string | null> | undefined,
): Record<string, string> | undefined {
	if (!headers) return undefined;
	const kept = Object.fromEntries(
		Object.entries(headers).filter((entry) => entry[1] !== null),
	) as Record<string, string>;
	return Object.keys(kept).length > 0 ? kept : undefined;
}

export default function compactModel(pi: ExtensionAPI) {
	let cfg = loadConfig();

	pi.on("session_before_compact", async (event, ctx) => {
		// 零侵入退出：未配置时不碰任何东西。
		if (!(cfg.enabled && cfg.provider && cfg.model)) return undefined;

		const modelResolution = await resolveModel(ctx, cfg);
		const decision = await handleBeforeCompact({
			cfg,
			modelResolution,
			compactFn: (args) =>
				compact(
					args.preparation as never,
					args.model as never,
					args.apiKey,
					withoutDeletedHeaders(args.headers),
					args.customInstructions,
					args.signal,
					args.thinkingLevel as never,
					undefined, // streamFn: 有意走 completeSimple 直连
					args.env,
					args.retry as never,
					undefined,
					undefined,
				),
			preparation: event.preparation as never,
			branchEntries: event.branchEntries as never,
			customInstructions: event.customInstructions,
			signal: event.signal,
			thinkingLevel: cfg.thinkingLevel === "inherit" ? (ctx.thinkingLevel ?? "off") : "off",
			retry: readRetrySettings(agentDir(), (p) => readFileSync(p, "utf8")),
		});

		switch (decision.kind) {
			case "passthrough":
				return undefined;
			case "fallback":
				if (!cfg.fallbackToDefault) {
					// 用户要求不回退：抛错让 pi 走 session_compact_failed。
					throw new Error(decision.message);
				}
				notify(ctx, decision.level, decision.message);
				notify(ctx, "warning", "compact-model: 回退 pi 原版压缩。可用 provider: " + describeProviders(ctx));
				return undefined;
			case "compaction": {
				notify(
					ctx,
					"info",
					`compact-model: 使用 ${cfg.provider}/${cfg.model} 压缩 (${event.reason})`,
				);
				// 官方 compact() 的返回值，形状就是 CompactionResult。
				return { compaction: decision.result as import("@earendil-works/pi-coding-agent").CompactionResult };
			}
		}
	});

	// 指定模型失败时的排障提示（fromExtension=true 说明是本扩展接管的那次）。
	pi.on("session_compact_failed", (event, ctx) => {
		if (!event.fromExtension) return;
		const message = event.errorMessage ?? "未知错误";
		notify(ctx, "error", `compact-model: 压缩失败 — ${message}`);
		notify(ctx, "info", `compact-model: 可用 /compact-model test 检查 ${cfg.provider}/${cfg.model}`);
	});

	pi.registerCommand("compact-model", {
		description:
			"compact-model: status | set <provider> <model> | off | thinking [off|inherit] | fallback [on|off] | test | path",
		getArgumentCompletions: (prefix) => {
			const subs = ["status", "set", "off", "thinking", "fallback", "test", "path"];
			const [head, rest] = prefix.split(/\s+/, 2);
			if (head === "set") {
				if (rest === undefined) return subs.filter((s) => s.startsWith("set")).map((s) => ({ value: s, label: s }));
				return [];
			}
			if (head === "thinking" || head === "fallback") {
				const values = head === "thinking" ? ["off", "inherit"] : ["on", "off"];
				return values
					.filter((v) => v.startsWith(rest ?? ""))
					.map((v) => ({ value: `${head} ${v}`, label: v }));
			}
			return subs
				.filter((s) => s.startsWith(prefix))
				.map((s) => ({ value: s, label: s }));
		},
		handler: async (args, ctx) => {
			cfg = loadConfig(); // 每次命令重读，支持外部手改配置后生效
			const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const [action = "status", ...rest] = tokens;
			const report = (message: string, level: "info" | "warning" | "error" = "info") =>
				notify(ctx, level, `compact-model: ${message}`);

			switch (action) {
				case "status": {
					const lines = [formatConfigSummary(cfg)];
					if (cfg.provider && cfg.model) {
						const resolution = await resolveModel(ctx, cfg);
						if (!resolution?.model) {
							lines.push(`解析: ✗ 模型不存在（可用 provider: ${describeProviders(ctx)}）`);
						} else {
							lines.push(`解析: ✓ ${cfg.provider}/${cfg.model}，鉴权: ${resolution.hasAuth ? "已配置" : "未配置"}`);
						}
					}
					report(lines.join("\n"));
					return;
				}
				case "set": {
					const [provider, model] = rest;
					if (!provider || !model) {
						report("用法: /compact-model set <provider> <modelId>", "error");
						return;
					}
					const found = ctx.modelRegistry.find(provider, model);
					if (!found) {
						report(
							`模型 ${provider}/${model} 不存在。可用 provider: ${describeProviders(ctx)}`,
							"error",
						);
						return;
					}
					cfg = saveConfig({ provider, model, enabled: true });
					report(`已设置压缩模型 → ${provider}/${model}\n${formatConfigSummary(cfg)}`);
					return;
				}
				case "off": {
					cfg = saveConfig({ enabled: false });
					report(`已停用，恢复 pi 原版压缩。\n${formatConfigSummary(cfg)}`);
					return;
				}
				case "thinking": {
					const [value] = rest;
					if (value !== "off" && value !== "inherit") {
						report(`当前: ${cfg.thinkingLevel}。用法: /compact-model thinking [off|inherit]`, "warning");
						return;
					}
					cfg = saveConfig({ thinkingLevel: value });
					report(`thinkingLevel → ${value}`);
					return;
				}
				case "fallback": {
					const [value] = rest;
					if (value !== "on" && value !== "off") {
						report(`当前: ${cfg.fallbackToDefault ? "on" : "off"}。用法: /compact-model fallback [on|off]`, "warning");
						return;
					}
					cfg = saveConfig({ fallbackToDefault: value === "on" });
					report(`fallbackToDefault → ${value}（off = 失败时直接报错不回退原版）`);
					return;
				}
				case "test": {
					if (!(cfg.provider && cfg.model)) {
						report("尚未设置模型，先 /compact-model set <provider> <modelId>", "warning");
						return;
					}
					const model = ctx.modelRegistry.find(cfg.provider, cfg.model);
					if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
						report(`模型不存在或无鉴权: ${cfg.provider}/${cfg.model}`, "error");
						return;
					}
					report(`正在测试 ${cfg.provider}/${cfg.model} …`);
					const started = Date.now();
					try {
						const response = await ctx.modelRegistry.complete(
							model,
							{
								messages: [
									{
										role: "user",
										content: [{ type: "text", text: "Reply with exactly: pong" }],
										timestamp: Date.now(),
									},
								],
							},
							{ maxTokens: 32, cacheRetention: "none" },
						);
						const text = response.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text)
							.join("")
							.trim();
						report(`✓ ${cfg.provider}/${cfg.model} 可用（${Date.now() - started}ms，回复: ${text || "(空)"}）`);
					} catch (error) {
						report(`✗ 调用失败: ${error instanceof Error ? error.message : String(error)}`, "error");
					}
					return;
				}
				case "path": {
					report(`配置文件: ${agentDir()}/compact-model.config.json`);
					return;
				}
				default: {
					report(`未知子命令 "${action}"。可用: status | set | off | thinking | fallback | test | path`, "warning");
				}
			}
		},
	});
}
