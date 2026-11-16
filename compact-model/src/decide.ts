/**
 * compact-model — 决策层（纯函数，可测试，不依赖 pi 运行时）
 *
 * handleBeforeCompact 是 session_before_compact 钩子的完整决策逻辑：
 * 它接收注入的 modelRegistry 视图、官方 compact() 与通知回调，返回一个
 * 指令对象，由 src/index.ts 的钩子装配层执行（return undefined / notify /
 * return {compaction} / throw）。
 *
 * 设计原因：pi 对扩展提供的压缩摘要标记 fromHook=true，默认的文件列表
 * 累积（extractFileOperations 的 !prevCompaction.fromHook 检查）会断裂；
 * carryOverFileOps 在调用官方 compact() 前手动把上一次压缩的
 * details.readFiles / modifiedFiles 并回 preparation.fileOps。
 */

import { join } from "node:path";
import type { CompactModelConfig } from "./config.ts";
import { isConfigured } from "./config.ts";

/** pi SessionEntry 里我们关心的最小形状。 */
export interface CompactionLikeEntry {
	type: string;
	fromHook?: boolean;
	details?: {
		readFiles?: unknown;
		modifiedFiles?: unknown;
	};
}

/** pi CompactionPreparation 的最小形状（只碰我们用到的字段）。 */
export interface PreparationLike {
	firstKeptEntryId: string;
	tokensBefore: number;
	fileOps: {
		read: Set<string>;
		edited: Set<string>;
	};
}

export type ResolvedAuth =
	| { ok: true; apiKey?: string; headers?: Record<string, string | null>; baseUrl?: string; env?: Record<string, string> }
	| { ok: false; error: string };

/** modelRegistry.find + hasConfiguredAuth + getApiKeyAndHeaders 的注入视图。 */
export interface ModelResolution {
	/** registry.find(provider, model) 的结果；undefined = 模型不存在。 */
	model: Record<string, unknown> | undefined;
	/** registry.hasConfiguredAuth(model) 的结果。 */
	hasAuth: boolean;
	/** registry.getApiKeyAndHeaders(model) 的结果。 */
	auth: ResolvedAuth | undefined;
}

export interface CompactCallArgs {
	preparation: unknown;
	model: unknown;
	apiKey: string | undefined;
	/** pi 的 ProviderHeaders 允许 null（删除头）；直接透传给 compact()。 */
	headers: Record<string, string | null> | undefined;
	customInstructions: string | undefined;
	signal: AbortSignal;
	thinkingLevel: string;
	env: Record<string, string> | undefined;
	retry: unknown;
	/** 自定义 streamFn（已包含 client-mimic 改写）；undefined = 官方 completeSimple 直连。 */
	streamFn: unknown;
}

export type Decision =
	| { kind: "passthrough" }
	| { kind: "fallback"; level: "warning" | "error"; message: string }
	| { kind: "compaction"; result: unknown };

export interface HandleParams {
	cfg: CompactModelConfig;
	modelResolution: ModelResolution | undefined;
	/** 注入的官方 compact()（签名裁剪到实际使用的参数）。 */
	compactFn: (args: CompactCallArgs) => Promise<unknown>;
	/** 上一次调用 compactFn 用的准备对象（含可变 fileOps）。 */
	preparation: PreparationLike;
	/** 当前分支的全部条目（找最近一次 compaction 继承文件列表）。 */
	branchEntries: CompactionLikeEntry[];
	customInstructions: string | undefined;
	signal: AbortSignal;
	thinkingLevel: string;
	retry: unknown;
	/** 已包装 client-mimic 改写的 streamFn；不传则走官方默认实现。 */
	streamFn?: unknown;
	notify?: (level: "info" | "warning" | "error", message: string) => void;
}

/**
 * 把 branchEntries 中最近一次 compaction 的文件列表并回 fileOps。
 * 无论 fromHook 与否都继承（我们的 entries 一定 fromHook=true，但老会话里
 * 也可能有 pi 原生生成的 compaction，同样应该延续累积）。
 * 纯函数：只对传入的 Set 做 add，不修改 branchEntries。
 */
export function carryOverFileOps(
	branchEntries: CompactionLikeEntry[],
	fileOps: { read: Set<string>; edited: Set<string> },
): void {
	for (let i = branchEntries.length - 1; i >= 0; i--) {
		const entry = branchEntries[i];
		if (entry.type !== "compaction") continue;
		const details = entry.details;
		if (Array.isArray(details?.readFiles)) {
			for (const f of details.readFiles) if (typeof f === "string") fileOps.read.add(f);
		}
		if (Array.isArray(details?.modifiedFiles)) {
			for (const f of details.modifiedFiles) if (typeof f === "string") fileOps.edited.add(f);
		}
		return; // 只继承最近一次
	}
}

/**
 * session_before_compact 的完整决策。所有 pi 交互（modelRegistry、compact、
 * notify）都通过参数注入，index.ts 只做装配。
 */
export async function handleBeforeCompact(params: HandleParams): Promise<Decision> {
	const { cfg, modelResolution, compactFn, preparation, branchEntries, customInstructions, signal } = params;

	// 1. 未配置 → 零侵入，原版行为。
	if (!isConfigured(cfg)) return { kind: "passthrough" };

	// 2. 解析模型与鉴权。fail：回退模式下 warning（静默回退原版），
	// 不回退模式下 error（装配层负责 throw）。
	const fail = (message: string): Decision => ({
		kind: "fallback",
		level: cfg.fallbackToDefault ? "warning" : "error",
		message,
	});

	if (!modelResolution?.model) {
		return fail(`compact-model: 模型 ${cfg.provider}/${cfg.model} 不存在于 models.json / 注册 provider`);
	}
	if (!modelResolution.hasAuth) {
		return fail(`compact-model: ${cfg.provider}/${cfg.model} 无可用鉴权（先 /login 或配置 apiKey）`);
	}
	const auth = modelResolution.auth;
	if (auth && auth.ok === false) {
		return fail(`compact-model: 鉴权解析失败: ${auth.error}`);
	}

	// 3. 组装请求模型（baseUrl 覆盖网关型 provider 的端点）。
	const baseModel = modelResolution.model;
	const requestModel =
		auth && auth.ok === true && auth.baseUrl
			? { ...baseModel, baseUrl: auth.baseUrl }
			: baseModel;

	// 4. fileOps 累积继承（pi 对 fromHook=true 的压缩不自动继承）。
	carryOverFileOps(branchEntries, preparation.fileOps);

	// 5. 调用官方 compact()：同一套 prompt/切点/文件列表/usage 合并，只换模型。
	try {
		const result = await compactFn({
			preparation,
			model: requestModel,
			apiKey: auth && auth.ok === true ? auth.apiKey : undefined,
			headers: auth && auth.ok === true ? (auth.headers ?? undefined) : undefined,
			customInstructions,
			signal,
			thinkingLevel: params.thinkingLevel,
			env: auth && auth.ok === true ? auth.env : undefined,
			retry: params.retry,
			streamFn: params.streamFn,
		});
		return { kind: "compaction", result };
	} catch (error) {
		if (signal.aborted) return { kind: "passthrough" };
		// 运行期失败即使回退也用 error 级通知（比“模型缺失”更显眼），但语义仍是回退。
		return {
			kind: "fallback",
			level: "error",
			message: `compact-model: 压缩调用失败: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}


/** 读 <agentDir>/settings.json 的 retry 字段（RetryPolicy 形状），失败返回 undefined。 */
export function readRetrySettings(agentDir: string, readFile: (p: string) => string): unknown {
	try {
		const raw = JSON.parse(readFile(join(agentDir, "settings.json"))) as Record<string, unknown>;
		const retry = raw.retry;
		if (retry && typeof retry === "object") return retry;
		return undefined;
	} catch {
		return undefined;
	}
}
