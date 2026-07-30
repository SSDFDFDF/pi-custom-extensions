import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * One named client fingerprint. Everything here is HTTP-header / request-body
 * level only — no TLS/JA3/HTTP2 transport spoofing (out of reach for an
 * extension). Intended for interop with self-hosted gateways/relays that gate
 * on a specific client identity.
 */
export interface MimicProfile {
	/** Human label, e.g. "OpenAI Codex CLI". */
	label: string;
	/**
	 * Headers to add/override on every outgoing provider request.
	 * Values support placeholders (see resolveTemplate): {version}, {session_id},
	 * {thread_id}, {window_id}, {first_window_id}, {previous_window_id},
	 * {window_number}, {turn_id}, {installation_id}, {parent_thread_id},
	 * {uuid}, {uuid_v7}, {os}, {arch}, {node_version}, {platform}, {os_type},
	 * {os_version}, {uname_arch}, {terminal}, {stainless_os}, {stainless_arch},
	 * plus any key defined in `templateVars`.
	 * A value of null deletes the header instead of setting it.
	 */
	headers: Record<string, string | null>;
	/**
	 * Header names pi may add that should be removed before our headers apply
	 * (case-insensitive). Use this to drop pi's own client identifiers.
	 */
	stripHeaders: string[];
	/**
	 * Shallow body field overrides merged into the provider payload
	 * (e.g. { store: false, stream: true }). Values are used verbatim.
	 * Only top-level keys are set; omit to leave the body untouched.
	 *
	 * For Claude-Code-shaped gateways, prefer the dedicated body helpers below
	 * (`ensureMetadataUserId`, `prependBillingSystem`) over hard-coding fields
	 * here — they are applied after bodyPatch and understand Anthropic payload
	 * shapes (string/array system, metadata.user_id).
	 */
	bodyPatch: Record<string, unknown>;
	/**
	 * When true, ensure the Anthropic Messages payload has `metadata.user_id`
	 * in the Claude Code JSON-string form:
	 *   {"device_id":"...","account_uuid":"","session_id":"..."}
	 * Existing metadata.user_id is left alone. device_id is a stable per-machine
	 * hash; session_id reuses pi's session id.
	 */
	ensureMetadataUserId: boolean;
	/**
	 * When true, prepend Claude Code's attribution/identity system blocks:
	 *   1) "x-anthropic-billing-header: cc_version=...; cc_entrypoint=cli;"
	 *   2) "You are a Claude agent, built on Anthropic's Claude Agent SDK."
	 * Works for both string and content-block-array `system` fields. Skips
	 * injection when a billing-header block is already present.
	 */
	prependBillingSystem: boolean;
	/**
	 * When true, inject Codex Responses identity into the request body:
	 * `prompt_cache_key` (= session_id) and flat identity keys. The legacy Codex
	 * profile uses `metadata`; Responses Lite uses current Codex
	 * `client_metadata`. Existing user-set keys are left alone.
	 */
	ensureCodexIdentity: boolean;
	/**
	 * Convert ordinary OpenAI Responses payloads to Codex Responses Lite.
	 * The transform is guarded by the presence of a top-level `input` array.
	 */
	codexResponsesLite: boolean;
	/** Client version string used to fill {version} in headers. */
	version: string;
	/**
	 * npm package name used by `/mimic update` to fetch the latest version and
	 * refresh `version`. Empty string disables auto-update for this profile.
	 */
	npmPackage: string;
	/**
	 * Extra named placeholders usable in header values as {key}. Handy for
	 * client-specific constants that are not derived from the runtime, e.g. an
	 * SDK package version ({stainless_version}). User-defined keys here override
	 * the built-in placeholder set of the same name.
	 */
	templateVars: Record<string, string>;
	/**
	 * Optional per-profile system-prompt behavior. When set (and not "inherit"),
	 * it decides how pi's system prompt is transformed while this profile is
	 * active. See SystemPromptSpec.
	 */
	systemPrompt: SystemPromptSpec;
}

/**
 * How the active profile transforms pi's system prompt.
 *
 * - mode "inherit": defer to the global MimicConfig.systemPrompt setting.
 * - mode "off": leave pi's built-in system prompt untouched.
 * - mode "neutral": apply the neutral "kun / π" identity rewrite (the behavior
 *   of the standalone neutral-system-prompt extension), keeping pi's generated
 *   tool list, guidelines, skills, and context intact.
 * - mode "file": load text from `file` and combine it with pi's prompt per
 *   `apply` (replace | prepend | append). Relative paths resolve against the
 *   agent dir (~/.pi/agent). Missing files fall back to leaving the prompt
 *   untouched (a warning is surfaced by the extension).
 */
export interface SystemPromptSpec {
	mode: "inherit" | "off" | "neutral" | "file";
	/** Path to the prompt file when mode is "file". */
	file?: string;
	/** How a file prompt combines with pi's prompt. Default: "replace". */
	apply?: "replace" | "prepend" | "append";
}

export interface MimicConfig {
	/** Master switch. When false no headers/body are touched. */
	enabled: boolean;
	/** Active profile key, or "off" to disable without flipping enabled. */
	active: string;
	/**
	 * Default system-prompt behavior when the active profile's systemPrompt.mode
	 * is "inherit" (or when no profile is active). Uses the same SystemPromptSpec
	 * shape but "inherit" is treated as "off" at this level.
	 */
	systemPrompt: SystemPromptSpec;
	/** Named profiles. */
	profiles: Record<string, MimicProfile>;
}

/**
 * Stainless SDK OS token (X-Stainless-OS). Matches the values the JS Stainless
 * runtime emits: "MacOS", "Linux", "Windows", "Unknown".
 */
const STAINLESS_OS_MAP: Record<string, string> = {
	linux: "Linux",
	darwin: "MacOS",
	win32: "Windows",
};

/**
 * Stainless SDK arch token (X-Stainless-Arch): "x64", "arm64", "x32", or
 * "other:<arch>".
 */
const STAINLESS_ARCH_MAP: Record<string, string> = {
	x64: "x64",
	arm64: "arm64",
	ia32: "x32",
};

/**
 * OS type token used by Codex's User-Agent, modeled on the `os_info` crate's
 * `OsType` Display output that the real client embeds, e.g. "Linux", "Mac OS",
 * "Windows".
 */
const OS_TYPE_MAP: Record<string, string> = {
	linux: "Linux",
	darwin: "Mac OS",
	win32: "Windows",
};

/**
 * uname-style machine arch used by Codex's User-Agent (os_info architecture()):
 * "x86_64", "arm64"/"aarch64", etc. On Linux the kernel reports "aarch64"; on
 * macOS the common form is "arm64".
 */
function unameArch(): string {
	switch (process.arch) {
		case "x64":
			return "x86_64";
		case "arm64":
			return process.platform === "darwin" ? "arm64" : "aarch64";
		case "ia32":
			return "i686";
		default:
			return process.arch;
	}
}

/**
 * Terminal identifier token used by Codex's User-Agent, mirroring codex's
 * terminal-detection `user_agent_token()`: `TERM_PROGRAM/TERM_PROGRAM_VERSION`
 * when present, else `TERM`, else "unknown".
 */
function terminalToken(): string {
	const prog = (process.env.TERM_PROGRAM ?? "").trim();
	if (prog) {
		const ver = (process.env.TERM_PROGRAM_VERSION ?? "").trim();
		return ver ? `${prog}/${ver}` : prog;
	}
	const term = (process.env.TERM ?? "").trim();
	return term || "unknown";
}

/**
 * Default profiles. Header sets are modeled on the real clients as of the
 * versions noted, but the target here is a self-hosted gateway that only
 * checks these fields — not byte-perfect parity with the official backends.
 */
export const DEFAULT_PROFILES: Record<string, MimicProfile> = {
	codex: {
		label: "OpenAI Codex CLI (codex_cli_rs)",
		// Realistic pinned default so requests are plausible before the first
		// `/mimic update`. Refresh with `/mimic update codex`.
		version: "0.144.4",
		npmPackage: "@openai/codex",
		headers: {
			originator: "codex_cli_rs",
			// Real Codex User-Agent is
			//   codex_cli_rs/{version} ({OS Type} {OS Version}; {uname arch}) {terminal}
			// e.g. "codex_cli_rs/0.144.4 (Linux 6.8.0; x86_64) unknown". The bare
			// "codex_cli_rs/{version}" form used before is easy to fingerprint as
			// non-CLI; the full form matches the client's default_client.rs.
			"User-Agent": "codex_cli_rs/{version} ({os_type} {os_version}; {uname_arch}) {terminal}",
			"OpenAI-Beta": "responses=experimental",
			// Codex also sends a bare `version` header on Responses requests; some
			// gateways (see Sub2API PR #2494) validate it. Mirror the CLI version.
			version: "{version}",
			// Root sessions set session_id == thread_id (UUIDv7). Subagent trees
			// would share session_id across different thread_ids; pi has no subagent
			// tree here, so both map to the same per-session UUIDv7.
			"session-id": "{session_id}",
			"thread-id": "{thread_id}",
			// Machine-stable + context-window identity from codex-rs client.rs.
			"x-codex-installation-id": "{installation_id}",
			"x-codex-window-id": "{window_id}",
			// Present only on child threads (fork/parentSession). Empty → header deleted.
			"x-codex-parent-thread-id": "{parent_thread_id}",
		},
		stripHeaders: ["x-stainless-lang", "x-stainless-package-version"],
		// Intentionally empty. Do NOT force stream/store here: `before_provider_request`
		// spreads these over pi's payload verbatim, and forcing `stream` to disagree with
		// pi's actual request mode breaks response parsing (SSE vs JSON). `store`/`stream`
		// are also OpenAI-Responses-specific and can 400 on other providers. Add per-field
		// overrides only when your gateway requires them and they match pi's request mode.
		bodyPatch: {},
		ensureMetadataUserId: false,
		prependBillingSystem: false,
		// Inject prompt_cache_key + Responses client_metadata shaped like codex-rs.
		ensureCodexIdentity: true,
		codexResponsesLite: false,
		templateVars: {},
		systemPrompt: { mode: "inherit" },
	},
	"codex-lite": {
		label: "OpenAI Codex CLI (Responses Lite)",
		version: "0.145.0",
		npmPackage: "@openai/codex",
		headers: {
			originator: "codex_cli_rs",
			"User-Agent": "codex_cli_rs/{version} ({os_type} {os_version}; {uname_arch}) {terminal}",
			"OpenAI-Beta": "responses=experimental",
			version: "{version}",
			"session-id": "{session_id}",
			"thread-id": "{thread_id}",
			"x-codex-installation-id": "{installation_id}",
			"x-codex-window-id": "{window_id}",
			"x-codex-parent-thread-id": "{parent_thread_id}",
			"x-openai-internal-codex-responses-lite": "true",
		},
		stripHeaders: ["x-stainless-lang", "x-stainless-package-version"],
		bodyPatch: {},
		ensureMetadataUserId: false,
		prependBillingSystem: false,
		ensureCodexIdentity: true,
		codexResponsesLite: true,
		templateVars: {},
		systemPrompt: { mode: "inherit" },
	},
	"claude-code": {
		label: "Anthropic Claude Code (claude-cli)",
		// Pin to a version observed on the wire. Refresh with `/mimic update`.
		version: "2.1.198",
		npmPackage: "@anthropic-ai/claude-code",
		headers: {
			// Real Claude Code User-Agent is "claude-cli/{version} (external, cli)",
			// NOT "claude-code/{version}". The latter is trivially fingerprinted.
			"User-Agent": "claude-cli/{version} (external, cli)",
			"x-app": "cli",
			// Session id the real CLI always sends; some gateways require it.
			"X-Claude-Code-Session-Id": "{session_id}",
			// API version + the direct-browser-access flag the real CLI sends.
			"anthropic-version": "2023-06-01",
			"anthropic-dangerous-direct-browser-access": "true",
			// Claude Code identity betas (from local 2.1.198 telemetry). Core set
			// always present; pi may add more (thinking/tool). Merged at request
			// time — not replaced. Optional flags (context-1m, advisor, …) can be
			// appended in the live config if a gateway requires them.
			"anthropic-beta":
				"claude-code-20250219,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,effort-2025-11-24",
			// Stainless SDK metadata (the underlying @anthropic-ai/sdk).
			"X-Stainless-Lang": "js",
			"X-Stainless-Package-Version": "{stainless_version}",
			"X-Stainless-OS": "{stainless_os}",
			"X-Stainless-Arch": "{stainless_arch}",
			"X-Stainless-Runtime": "node",
			"X-Stainless-Runtime-Version": "{node_version}",
			"X-Stainless-Retry-Count": "0",
			"X-Stainless-Timeout": "600",
		},
		stripHeaders: [],
		bodyPatch: {},
		// Body-level Claude Code fingerprints required by some self-hosted
		// gateways (e.g. "this group only allows Claude Code clients").
		ensureMetadataUserId: true,
		prependBillingSystem: true,
		ensureCodexIdentity: false,
		codexResponsesLite: false,
		// Version of the bundled @anthropic-ai/sdk that recent Claude Code
		// builds ship (captured from 2.1.198 on the wire: 0.94.0). Not the
		// same as the CLI version; refresh by hand if your gateway checks it.
		templateVars: { stainless_version: "0.94.0" },
		systemPrompt: { mode: "inherit" },
	},
};

export const DEFAULT_CONFIG: MimicConfig = {
	enabled: true,
	active: "off",
	// Preserve the prior standalone-extension behavior: neutral "kun / π" rewrite
	// by default. Set to { mode: "off" } to keep pi's built-in prompt verbatim.
	systemPrompt: { mode: "neutral" },
	profiles: DEFAULT_PROFILES,
};

const CONFIG_FILE_NAME = "client-mimic.config.json";

export function packageRootFromUrl(importMetaUrl: string): string {
	return dirname(dirname(fileURLToPath(importMetaUrl)));
}

export function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? ".", ".pi", "agent");
}

export function defaultConfigPath(): string {
	return join(agentDir(), CONFIG_FILE_NAME);
}

/** Deep-ish clone of the default config so callers never mutate the constant. */
function freshDefault(): MimicConfig {
	return normalizeConfig(undefined);
}

export function loadConfig(): MimicConfig {
	const path = defaultConfigPath();
	if (!existsSync(path)) return freshDefault();
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<MimicConfig>;
		return normalizeConfig(raw);
	} catch {
		return freshDefault();
	}
}

export function saveConfig(patch: Partial<MimicConfig>): MimicConfig {
	const next = normalizeConfig({ ...loadConfig(), ...patch });
	const path = defaultConfigPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
	return next;
}

/** Coerce arbitrary input into a valid SystemPromptSpec. */
function normalizeSystemPrompt(
	raw: unknown,
	fallback: SystemPromptSpec,
	allowInherit: boolean,
): SystemPromptSpec {
	if (!raw || typeof raw !== "object") return { ...fallback };
	const src = raw as Partial<SystemPromptSpec>;
	const modes = allowInherit
		? ["inherit", "off", "neutral", "file"]
		: ["off", "neutral", "file"];
	const mode = typeof src.mode === "string" && modes.includes(src.mode) ? src.mode : fallback.mode;
	const spec: SystemPromptSpec = { mode: mode as SystemPromptSpec["mode"] };
	if (spec.mode === "file") {
		spec.file = typeof src.file === "string" ? src.file : fallback.file;
		const apply = src.apply ?? fallback.apply ?? "replace";
		spec.apply = apply === "prepend" || apply === "append" ? apply : "replace";
	}
	return spec;
}

function normalizeProfile(key: string, raw: Partial<MimicProfile> | undefined): MimicProfile {
	const base = DEFAULT_PROFILES[key];
	const src = raw ?? {};
	const headers: Record<string, string | null> = {};
	const rawHeaders = (src.headers ?? base?.headers ?? {}) as Record<string, unknown>;
	for (const [k, v] of Object.entries(rawHeaders)) {
		if (v === null) headers[k] = null;
		else if (typeof v === "string") headers[k] = v;
	}
	const stripHeaders = Array.isArray(src.stripHeaders)
		? src.stripHeaders.filter((s): s is string => typeof s === "string").map((s) => s.trim()).filter(Boolean)
		: [...(base?.stripHeaders ?? [])];
	const bodyPatch =
		src.bodyPatch && typeof src.bodyPatch === "object" && !Array.isArray(src.bodyPatch)
			? { ...(src.bodyPatch as Record<string, unknown>) }
			: { ...(base?.bodyPatch ?? {}) };
	const templateVars: Record<string, string> = {};
	const rawVars = (src.templateVars ?? base?.templateVars ?? {}) as Record<string, unknown>;
	for (const [k, v] of Object.entries(rawVars)) {
		if (typeof v === "string") templateVars[k] = v;
	}

	return {
		label: typeof src.label === "string" && src.label ? src.label : base?.label ?? key,
		version: typeof src.version === "string" && src.version ? src.version : base?.version ?? "0.0.0",
		npmPackage: typeof src.npmPackage === "string" ? src.npmPackage : base?.npmPackage ?? "",
		headers,
		stripHeaders,
		bodyPatch,
		ensureMetadataUserId:
			typeof src.ensureMetadataUserId === "boolean"
				? src.ensureMetadataUserId
				: (base?.ensureMetadataUserId ?? false),
		prependBillingSystem:
			typeof src.prependBillingSystem === "boolean"
				? src.prependBillingSystem
				: (base?.prependBillingSystem ?? false),
		ensureCodexIdentity:
			typeof src.ensureCodexIdentity === "boolean"
				? src.ensureCodexIdentity
				: (base?.ensureCodexIdentity ?? false),
		codexResponsesLite:
			typeof src.codexResponsesLite === "boolean"
				? src.codexResponsesLite
				: (base?.codexResponsesLite ?? false),
		templateVars,
		systemPrompt: normalizeSystemPrompt(src.systemPrompt, base?.systemPrompt ?? { mode: "inherit" }, true),
	};
}

export function normalizeConfig(raw: Partial<MimicConfig> | undefined): MimicConfig {
	const src = raw ?? {};
	const profilesSrc =
		src.profiles && typeof src.profiles === "object" ? (src.profiles as Record<string, Partial<MimicProfile>>) : {};
	// Union of default keys and any user-defined keys.
	const keys = new Set<string>([...Object.keys(DEFAULT_PROFILES), ...Object.keys(profilesSrc)]);
	const profiles: Record<string, MimicProfile> = {};
	for (const key of keys) {
		profiles[key] = normalizeProfile(key, profilesSrc[key]);
	}

	const active = typeof src.active === "string" && src.active ? src.active : "off";

	return {
		enabled: src.enabled !== false,
		active: active === "off" || profiles[active] ? active : "off",
		systemPrompt: normalizeSystemPrompt(src.systemPrompt, { mode: "neutral" }, false),
		profiles,
	};
}

/** Resolve template placeholders in a header value against runtime context. */
export function resolveTemplate(value: string, ctx: TemplateContext): string {
	return value.replace(/\{(\w+)\}/g, (match, key: string) => {
		// Profile-defined vars win over built-ins of the same name.
		if (ctx.vars && key in ctx.vars) return ctx.vars[key];
		switch (key) {
			case "version":
				return ctx.version;
			case "session_id":
				return ctx.sessionId;
			case "thread_id":
				return ctx.threadId ?? ctx.sessionId;
			case "window_id":
				return ctx.windowId ?? ctx.sessionId;
			case "first_window_id":
				return ctx.firstWindowId ?? ctx.windowId ?? ctx.sessionId;
			case "previous_window_id":
				return ctx.previousWindowId ?? "";
			case "window_number":
				return ctx.windowNumber != null ? String(ctx.windowNumber) : "0";
			case "turn_id":
				return ctx.turnId ?? "";
			case "installation_id":
				return ctx.installationId ?? "";
			case "parent_thread_id":
				// Root has no parent; empty string lets header apply treat it as delete.
				return ctx.parentThreadId ?? "";
			case "uuid":
				return ctx.uuid();
			case "uuid_v7":
				return ctx.uuidV7 ? ctx.uuidV7() : ctx.uuid();
			case "os":
				return STAINLESS_OS_MAP[process.platform] ?? "Unknown";
			case "stainless_os":
				return STAINLESS_OS_MAP[process.platform] ?? "Unknown";
			case "arch":
				return STAINLESS_ARCH_MAP[process.arch] ?? `other:${process.arch}`;
			case "stainless_arch":
				return STAINLESS_ARCH_MAP[process.arch] ?? `other:${process.arch}`;
			case "os_type":
				return OS_TYPE_MAP[process.platform] ?? "Unknown";
			case "os_version":
				return os.release() || "unknown";
			case "uname_arch":
				return unameArch();
			case "terminal":
				return terminalToken();
			case "node_version":
				return process.version;
			case "platform":
				return process.platform;
			default:
				return match;
		}
	});
}

export interface TemplateContext {
	version: string;
	sessionId: string;
	/** Thread id; root Codex sessions use sessionId. */
	threadId?: string;
	/** Parent thread id for child/subagent threads. */
	parentThreadId?: string;
	/** Current context-window id (UUIDv7); advances on compact. */
	windowId?: string;
	/** First window in this thread's chain. */
	firstWindowId?: string;
	/** Previous window after compact. */
	previousWindowId?: string;
	/** Monotonic window index (0-based). */
	windowNumber?: number;
	/** Per outbound-request turn id. */
	turnId?: string;
	/** Machine-stable installation id (Codex ~/.codex/installation_id shape). */
	installationId?: string;
	uuid: () => string;
	/** Optional UUIDv7 factory (Codex SessionId/ThreadId/window_id). */
	uuidV7?: () => string;
	/** Profile-defined template vars, overriding built-in placeholders. */
	vars?: Record<string, string>;
}

export function activeProfile(cfg: MimicConfig): MimicProfile | null {
	if (!cfg.enabled || cfg.active === "off") return null;
	return cfg.profiles[cfg.active] ?? null;
}

/** One-line human description of a SystemPromptSpec (e.g. for status output). */
export function describeSystemPrompt(spec: SystemPromptSpec): string {
	if (spec.mode === "file") {
		return `file (${spec.apply ?? "replace"}: ${spec.file ?? "<unset>"})`;
	}
	return spec.mode;
}

/**
 * The system-prompt spec that actually takes effect, given the active profile:
 * a profile spec wins unless it is "inherit"; a global "inherit" resolves to
 * "off". Mirrors system-prompt.ts effectiveSpec so status output matches runtime.
 */
export function effectiveSystemPrompt(cfg: MimicConfig): SystemPromptSpec {
	const profile = activeProfile(cfg);
	if (profile && profile.systemPrompt.mode !== "inherit") return profile.systemPrompt;
	return cfg.systemPrompt.mode === "inherit" ? { mode: "off" } : cfg.systemPrompt;
}

export function formatStatus(cfg: MimicConfig): string {
	const lines: string[] = [
		`enabled: ${cfg.enabled}`,
		`active: ${cfg.active}`,
		`config: ${defaultConfigPath()}`,
		`system prompt: global=${describeSystemPrompt(cfg.systemPrompt)} | effective=${describeSystemPrompt(effectiveSystemPrompt(cfg))}`,
		"profiles:",
	];
	for (const [key, p] of Object.entries(cfg.profiles)) {
		const mark = key === cfg.active ? "*" : " ";
		lines.push(
			`  ${mark} ${key} — ${p.label} v${p.version}${p.npmPackage ? ` (npm: ${p.npmPackage})` : ""} [prompt: ${describeSystemPrompt(p.systemPrompt)}]`,
		);
	}
	return lines.join("\n");
}
