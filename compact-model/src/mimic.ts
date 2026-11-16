/**
 * compact-model — client-mimic 适配层
 *
 * 为什么需要这一层：pi 的压缩摘要走 `completeSummarization` → provider
 * `streamSimple`，不经过扩展钩子 `before_provider_headers` /
 * `before_provider_request`。client-mimic 的客户端伪装平时正是靠这两个钩子
 * 生效的，所以压缩请求会以 pi 的默认指纹发出——对接了客户端指纹校验的网关
 * 就会拒绝这次压缩（而普通对话正常）。
 *
 * 解决方式：client-mimic 把同一套改写逻辑发布成进程级服务
 * （`Symbol.for("pi.client-mimic.rewrite-service")`，见其
 * `src/rewrite-service.ts`），本模块解析该服务，在压缩请求上按与普通回合
 * 相同的顺序执行 header 改写 + payload 改写，再委托给上游 streamSimple。
 *
 * 契约与降级：
 * - 服务不存在（未安装 client-mimic）、版本不符、未启用（active=off）→ 原样透传。
 * - 改写抛错 → 忽略该步，请求照常发出（压缩绝不因伪装失败而中断）。
 * - 顺序与 pi 的两个钩子一致：`rewriteHeaders` 先（签发本请求的 Codex turn id），
 *   `patchPayload` 后（消费该 turn id）。
 */

/** 与 client-mimic 共享的进程级服务键。字符串必须两端一致。 */
export const REWRITE_SERVICE_KEY = Symbol.for("pi.client-mimic.rewrite-service");

/** 兼容的契约版本（见 client-mimic/src/rewrite-service.ts）。 */
const SUPPORTED_SERVICE_VERSION = 1;

export interface MimicModelInfo {
	provider: string;
	api: string;
	id: string;
}

export interface MimicPatchOutcome {
	profile: string | null;
	payload: unknown;
	skipped?: string;
}

/** client-mimic 发布的服务（结构化类型，不做跨扩展 import）。 */
export interface MimicRewriteService {
	version: number;
	activeProfile(): string | null;
	rewriteHeaders(headers: Record<string, string | null>, model: MimicModelInfo): unknown;
	patchPayload(payload: unknown, model: MimicModelInfo): MimicPatchOutcome;
}

/** 与 pi 的 provider streamSimple 同形；只做透传，不关心内部实现。 */
export type StreamSimpleLike = (
	model: unknown,
	context: unknown,
	options?: Record<string, unknown>,
) => unknown;

/**
 * 解析已发布的改写服务。任何不符合契约的全局值都视为“未安装”。
 */
export function resolveMimicService(
	holder: unknown = globalThis,
): MimicRewriteService | undefined {
	const candidate = (holder as Record<symbol, unknown> | undefined)?.[REWRITE_SERVICE_KEY];
	if (!candidate || typeof candidate !== "object") return undefined;
	const service = candidate as Partial<MimicRewriteService>;
	if (service.version !== SUPPORTED_SERVICE_VERSION) return undefined;
	if (typeof service.activeProfile !== "function") return undefined;
	if (typeof service.rewriteHeaders !== "function") return undefined;
	if (typeof service.patchPayload !== "function") return undefined;
	return service as MimicRewriteService;
}

function modelInfoOf(model: unknown): MimicModelInfo {
	const m = (model ?? {}) as Record<string, unknown>;
	return {
		provider: typeof m.provider === "string" ? m.provider : "",
		api: typeof m.api === "string" ? m.api : "",
		id: typeof m.id === "string" ? m.id : "",
	};
}

/** 当前启用的伪装 profile；无服务或未启用时返回 null。 */
export function activeMimicProfile(
	resolve: () => MimicRewriteService | undefined = () => resolveMimicService(),
): string | null {
	const service = resolve();
	if (!service) return null;
	try {
		return service.activeProfile();
	} catch {
		return null;
	}
}

export interface RewritingStreamOptions {
	/** 服务解析器（测试注入）。默认读取全局符号。 */
	resolveService?: () => MimicRewriteService | undefined;
	/** 真正的 provider streamSimple（生产环境注入 pi-ai/compat 的实现）。 */
	delegate: StreamSimpleLike;
}

/**
 * 构造一个“先做客户端伪装、再委托”的 streamSimple。
 *
 * 只有当前存在激活的 client-mimic profile 时才注入改写，否则完全等同于
 * delegate——未配置伪装的环境里没有额外开销，也没有行为变化。
 */
export function createRewritingStreamFn(options: RewritingStreamOptions): StreamSimpleLike {
	const { delegate } = options;
	const resolve = options.resolveService ?? (() => resolveMimicService());

	return (model, context, streamOptions) => {
		const service = resolve();
		if (!service) return delegate(model, context, streamOptions);

		let active: string | null = null;
		try {
			active = service.activeProfile();
		} catch {
			active = null;
		}
		if (!active) return delegate(model, context, streamOptions);

		const info = modelInfoOf(model);
		const headers: Record<string, string | null> = {
			...((streamOptions?.headers as Record<string, string | null> | undefined) ?? {}),
		};

		// 1. Header 改写（签发本请求的 turn id）。
		try {
			service.rewriteHeaders(headers, info);
		} catch {
			// 伪装失败不影响压缩本身。
		}

		// 2. Payload 改写（在 provider 构建完请求体后，与原钩子同序）。
		const previousOnPayload = streamOptions?.onPayload as
			| ((payload: unknown, model: unknown) => unknown)
			| undefined;
		const onPayload = async (payload: unknown, m: unknown) => {
			let current = payload;
			if (typeof previousOnPayload === "function") {
				const next = await previousOnPayload(current, m);
				if (next !== undefined) current = next;
			}
			try {
				const outcome = service.patchPayload(current, info);
				if (outcome && outcome.payload !== undefined) current = outcome.payload;
			} catch {
				// 同上：只丢弃这一步改写。
			}
			return current;
		};

		return delegate(model, context, {
			...(streamOptions ?? {}),
			headers,
			onPayload,
		});
	};
}
