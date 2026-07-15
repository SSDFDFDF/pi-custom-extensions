import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
	 * {uuid}, {os}, {arch}, {node_version}, {platform}.
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
	 */
	bodyPatch: Record<string, unknown>;
	/** Client version string used to fill {version} in headers. */
	version: string;
	/**
	 * npm package name used by `/mimic update` to fetch the latest version and
	 * refresh `version`. Empty string disables auto-update for this profile.
	 */
	npmPackage: string;
}

export interface MimicConfig {
	/** Master switch. When false no headers/body are touched. */
	enabled: boolean;
	/** Active profile key, or "off" to disable without flipping enabled. */
	active: string;
	/** Named profiles. */
	profiles: Record<string, MimicProfile>;
}

const OS_MAP: Record<string, string> = {
	linux: "Linux",
	darwin: "macOS",
	win32: "Windows",
};

const ARCH_MAP: Record<string, string> = {
	x64: "x64",
	arm64: "arm64",
};

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
			"User-Agent": "codex_cli_rs/{version}",
			"OpenAI-Beta": "responses=experimental",
			// hyphenated form only — underscored aliases are rejected by some proxies
			"session-id": "{session_id}",
		},
		stripHeaders: ["x-stainless-lang", "x-stainless-package-version"],
		// Intentionally empty. Do NOT force stream/store here: `before_provider_request`
		// spreads these over pi's payload verbatim, and forcing `stream` to disagree with
		// pi's actual request mode breaks response parsing (SSE vs JSON). `store`/`stream`
		// are also OpenAI-Responses-specific and can 400 on other providers. Add per-field
		// overrides only when your gateway requires them and they match pi's request mode.
		bodyPatch: {},
	},
	"claude-code": {
		label: "Anthropic Claude Code (claude-cli / tengu)",
		version: "2.1.210",
		npmPackage: "@anthropic-ai/claude-code",
		headers: {
			"User-Agent": "claude-code/{version}",
			"x-app": "cli",
			"X-Claude-Code-Session-Id": "{session_id}",
			"X-Stainless-Lang": "js",
			"X-Stainless-OS": "{os}",
			"X-Stainless-Arch": "{arch}",
			"X-Stainless-Runtime": "node",
			"X-Stainless-Runtime-Version": "{node_version}",
			"X-Stainless-Retry-Count": "0",
		},
		stripHeaders: [],
		bodyPatch: {},
	},
};

export const DEFAULT_CONFIG: MimicConfig = {
	enabled: true,
	active: "off",
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

	return {
		label: typeof src.label === "string" && src.label ? src.label : base?.label ?? key,
		version: typeof src.version === "string" && src.version ? src.version : base?.version ?? "0.0.0",
		npmPackage: typeof src.npmPackage === "string" ? src.npmPackage : base?.npmPackage ?? "",
		headers,
		stripHeaders,
		bodyPatch,
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
		profiles,
	};
}

/** Resolve template placeholders in a header value against runtime context. */
export function resolveTemplate(value: string, ctx: TemplateContext): string {
	return value.replace(/\{(\w+)\}/g, (match, key: string) => {
		switch (key) {
			case "version":
				return ctx.version;
			case "session_id":
				return ctx.sessionId;
			case "uuid":
				return ctx.uuid();
			case "os":
				return OS_MAP[process.platform] ?? "Unknown";
			case "arch":
				return ARCH_MAP[process.arch] ?? `other:${process.arch}`;
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
	uuid: () => string;
}

export function activeProfile(cfg: MimicConfig): MimicProfile | null {
	if (!cfg.enabled || cfg.active === "off") return null;
	return cfg.profiles[cfg.active] ?? null;
}

export function formatStatus(cfg: MimicConfig): string {
	const lines: string[] = [
		`enabled: ${cfg.enabled}`,
		`active: ${cfg.active}`,
		`config: ${defaultConfigPath()}`,
		"profiles:",
	];
	for (const [key, p] of Object.entries(cfg.profiles)) {
		const mark = key === cfg.active ? "*" : " ";
		lines.push(`  ${mark} ${key} — ${p.label} v${p.version}${p.npmPackage ? ` (npm: ${p.npmPackage})` : ""}`);
	}
	return lines.join("\n");
}
