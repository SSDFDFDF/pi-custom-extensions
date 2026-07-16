/**
 * client-mimic — Pi extension
 *
 * Rewrites outgoing provider HTTP headers (and optionally top-level request-body
 * fields) so pi presents itself as another client — e.g. OpenAI Codex CLI
 * (codex_cli_rs) or Anthropic Claude Code (claude-cli / tengu).
 *
 * Purpose: interop with a self-hosted gateway/relay that gates on a specific
 * client identity. This only touches HTTP headers and request-body JSON. It does
 * NOT change TLS/JA3 or HTTP2 transport fingerprints — those are out of reach for
 * an extension. If your gateway validates transport-level fingerprints, this is
 * not enough on its own.
 *
 * Commands:
 *   /mimic                 show status
 *   /mimic on|off          master switch
 *   /mimic use <profile>   activate a profile (codex | claude-code | off)
 *   /mimic list            list profiles
 *   /mimic show [profile]  print a profile's resolved headers/body/prompt mode
 *   /mimic prompt [...]    system-prompt control:
 *                            /mimic prompt                       show config (all levels)
 *                            /mimic prompt <off|neutral>         set the global default
 *                            /mimic prompt <profile> <inherit|off|neutral|file> [path]
 *   /mimic update [name]   pull latest version from npm and refresh {version}
 *
 * System prompt: this extension also owns pi's system prompt via
 * before_agent_start (folding in the old standalone neutral-system-prompt.ts).
 * The active profile's systemPrompt spec wins unless it is "inherit", in which
 * case the global MimicConfig.systemPrompt applies (default: neutral rewrite).
 *
 * Flag:
 *   --mimic <profile>      activate a profile for this launch (session-only)
 */

import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	defaultConfigPath,
	formatStatus,
	loadConfig,
	resolveTemplate,
	saveConfig,
	type MimicConfig,
	type MimicProfile,
	type SystemPromptSpec,
	type TemplateContext,
} from "./config.ts";
import { applySystemPrompt, effectiveSpec } from "./system-prompt.ts";
import { formatUpdateResults, updateVersions } from "./update.ts";

const FLAG = "mimic";
const STATUS_KEY = "client-mimic";

export default function clientMimic(pi: ExtensionAPI) {
	pi.registerFlag(FLAG, {
		description: "Activate a client-mimic profile for this launch (e.g. codex, claude-code, off).",
		type: "string",
	});

	let cfg: MimicConfig = loadConfig();
	// Flag override lives only in memory for this launch; it does not rewrite the file.
	let flagOverride: string | undefined;
	// The launch flag is honored once. After the first session_start (or after the
	// user runs /mimic use, which clears the override), later sessions must not
	// resurrect the flag and silently override an explicit config choice.
	let flagConsumed = false;
	// Stable per-session id reused for {session_id}. Regenerated on each session_start.
	let sessionId = randomUUID();
	// Stable per-machine device id for Claude Code metadata.user_id (hashed host+user).
	const deviceId = stableDeviceId();

	const refresh = () => {
		cfg = loadConfig();
		return cfg;
	};

	/** Effective active key: flag override wins, else config. */
	const effectiveActive = (): string => {
		if (flagOverride !== undefined) return flagOverride;
		return cfg.active;
	};

	/** Effective profile honoring the flag override. */
	const effectiveProfile = (): MimicProfile | null => {
		if (!cfg.enabled) return null;
		const key = effectiveActive();
		if (key === "off") return null;
		return cfg.profiles[key] ?? null;
	};

	const templateCtx = (profile: MimicProfile, ctx: ExtensionContext): TemplateContext => ({
		version: profile.version,
		sessionId: ctx.sessionManager.getSessionId?.() ?? sessionId,
		uuid: () => randomUUID(),
		vars: profile.templateVars,
	});

	const updateFooter = (ctx: Pick<ExtensionContext, "hasUI" | "ui">) => {
		if (!ctx.hasUI) return;
		const key = effectiveActive();
		if (!cfg.enabled || key === "off" || !cfg.profiles[key]) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		ctx.ui.setStatus(STATUS_KEY, `mimic:${key}`);
	};

	// ── Lifecycle ────────────────────────────────────────────────────────────

	pi.on("session_start", (_event, ctx) => {
		refresh();
		sessionId = randomUUID();

		if (!flagConsumed) {
			flagConsumed = true;
			const flagValue = pi.getFlag(FLAG);
			if (typeof flagValue === "string" && flagValue.trim()) {
				const v = flagValue.trim();
				if (v === "off" || cfg.profiles[v]) {
					flagOverride = v;
				} else if (ctx.hasUI) {
					ctx.ui.notify(`client-mimic: unknown profile "${v}" from --mimic; ignoring.`, "warning");
				}
			}
		}

		updateFooter(ctx);

		if (ctx.hasUI) {
			const p = effectiveProfile();
			if (p) {
				ctx.ui.notify(`client-mimic active: ${effectiveActive()} (${p.label} v${p.version})`, "info");
			}
		}
	});

	// ── Header rewrite ─────────────────────────────────────────────────────────

	pi.on("before_provider_headers", (event, ctx) => {
		const profile = effectiveProfile();
		if (!profile) return;

		const tctx = templateCtx(profile, ctx);

		// 1. Strip pi's own identifying headers (case-insensitive match).
		if (profile.stripHeaders.length) {
			const lowerStrip = new Set(profile.stripHeaders.map((s) => s.toLowerCase()));
			for (const existing of Object.keys(event.headers)) {
				if (lowerStrip.has(existing.toLowerCase())) {
					event.headers[existing] = null;
				}
			}
		}

		// 2. Apply profile headers (string = set/override, null = delete).
		// HTTP header names are case-insensitive, but event.headers is a plain
		// object with case-sensitive keys. To avoid emitting both e.g. "user-agent"
		// (from the provider) and "User-Agent" (from the profile), drop every
		// existing key that matches case-insensitively before writing the profile's
		// canonical spelling. Deletion uses null so it also cancels a same-name key
		// added by an earlier-loaded extension.
		//
		// anthropic-beta is special-cased: merge with any existing value (union of
		// comma-separated flags) so we don't clobber betas pi already set for
		// thinking/tool-streaming while still forcing Claude Code identity flags.
		for (const [name, rawValue] of Object.entries(profile.headers)) {
			const lower = name.toLowerCase();
			const existingKeys = Object.keys(event.headers).filter((k) => k.toLowerCase() === lower);
			const existingValue = existingKeys
				.map((k) => event.headers[k])
				.find((v): v is string => typeof v === "string" && v.trim().length > 0);

			for (const existing of existingKeys) {
				if (existing !== name) event.headers[existing] = null;
			}

			if (rawValue === null) {
				event.headers[name] = null;
				continue;
			}

			const resolved = resolveTemplate(rawValue, tctx);
			if (lower === "anthropic-beta" && existingValue) {
				event.headers[name] = mergeBetaFlags(existingValue, resolved);
			} else {
				event.headers[name] = resolved;
			}
		}
	});

	// ── Body patch ───────────────────────────────────────────────────────────

	pi.on("before_provider_request", (event, ctx) => {
		const profile = effectiveProfile();
		if (!profile) return;

		const payload = { ...(event.payload as Record<string, unknown>) };
		let changed = false;

		// 1. Shallow bodyPatch overrides (config-driven).
		const patchKeys = Object.keys(profile.bodyPatch);
		if (patchKeys.length) {
			Object.assign(payload, profile.bodyPatch);
			changed = true;
		}

		// 2. Claude Code metadata.user_id (JSON string with device/session).
		if (profile.ensureMetadataUserId) {
			const sid = ctx.sessionManager.getSessionId?.() ?? sessionId;
			if (ensureClaudeMetadata(payload, deviceId, sid)) changed = true;
		}

		// 3. Claude Code billing/identity system preamble.
		if (profile.prependBillingSystem) {
			if (prependClaudeBillingSystem(payload, profile.version)) changed = true;
		}

		return changed ? payload : undefined;
	});

	// ── System prompt ──────────────────────────────────────────────────────────

	pi.on("before_agent_start", (event, ctx) => {
		// System-prompt handling is independent of the header master switch: even
		// with mimic "off"/disabled, the global systemPrompt (neutral by default)
		// still applies. effectiveProfile() returns null unless a profile is truly
		// active, so the global spec governs in that case.
		const profile = effectiveProfile();
		const spec = effectiveSpec(cfg, profile);
		const result = applySystemPrompt(event.systemPrompt, spec);
		if (result.warning && ctx.hasUI) {
			ctx.ui.notify(`client-mimic: ${result.warning}`, "warning");
		}
		return result.prompt === event.systemPrompt ? undefined : { systemPrompt: result.prompt };
	});

	// ── Commands ───────────────────────────────────────────────────────────────

	pi.registerCommand("mimic", {
		description:
			"client-mimic: status | on | off | use <profile> | list | show [profile] | update [name|all]",
		getArgumentCompletions: (prefix: string) => {
			const subs = ["status", "on", "off", "use", "list", "show", "update", "prompt"];
			const profiles = Object.keys(loadConfig().profiles);
			const parts = prefix.split(/\s+/);
			let items: { value: string; label: string }[];
			if (parts.length <= 1) {
				items = subs.map((s) => ({ value: s, label: s }));
			} else if (parts[0] === "use" || parts[0] === "show") {
				items = [...profiles, "off"].map((p) => ({ value: `${parts[0]} ${p}`, label: p }));
			} else if (parts[0] === "update") {
				items = ["all", ...profiles].map((p) => ({ value: `update ${p}`, label: p }));
			} else if (parts[0] === "prompt") {
				// `/mimic prompt <mode>` sets the global default; `/mimic prompt <profile> <mode>`
				// targets one profile. Offer both global modes and profile names at depth 2.
				if (parts.length <= 2) {
					items = ["off", "neutral", ...profiles].map((m) => ({ value: `prompt ${m}`, label: m }));
				} else if (profiles.includes(parts[1])) {
					items = ["inherit", "off", "neutral", "file"].map((m) => ({
						value: `prompt ${parts[1]} ${m}`,
						label: m,
					}));
				} else {
					return null;
				}
			} else {
				return null;
			}
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length ? filtered : null;
		},
		handler: async (args, ctx) => {
			refresh();
			const raw = (args ?? "").trim();
			const [cmd, ...rest] = raw.split(/\s+/);
			const restJoined = rest.join(" ").trim();
			const sub = (cmd ?? "").toLowerCase();

			if (!sub || sub === "status" || sub === "show") {
				if (sub === "show" && restJoined) {
					showProfile(ctx, restJoined);
					return;
				}
				const overrideNote =
					flagOverride !== undefined ? `\n(flag override active: --mimic ${flagOverride})` : "";
				ctx.ui.notify(`${formatStatus(cfg)}${overrideNote}`, "info");
				return;
			}

			if (sub === "on" || sub === "enable") {
				cfg = saveConfig({ enabled: true });
				updateFooter(ctx);
				ctx.ui.notify(`client-mimic enabled (active: ${cfg.active})`, "info");
				return;
			}

			if (sub === "off" || sub === "disable") {
				cfg = saveConfig({ enabled: false });
				updateFooter(ctx);
				ctx.ui.notify("client-mimic disabled", "info");
				return;
			}

			if (sub === "use" || sub === "profile") {
				const target = restJoined.toLowerCase();
				if (!target) {
					ctx.ui.notify(`Usage: /mimic use <${[...Object.keys(cfg.profiles), "off"].join("|")}>`, "error");
					return;
				}
				if (target !== "off" && !cfg.profiles[target]) {
					ctx.ui.notify(`Unknown profile "${target}". Available: ${Object.keys(cfg.profiles).join(", ")}, off`, "error");
					return;
				}
				cfg = saveConfig({ active: target, enabled: target === "off" ? cfg.enabled : true });
				// Clear any flag override so the config choice takes effect this session.
				flagOverride = undefined;
				updateFooter(ctx);
				const p = cfg.profiles[target];
				ctx.ui.notify(
					target === "off"
						? "client-mimic: no profile active (off)"
						: `client-mimic now mimicking: ${target} (${p.label} v${p.version})`,
					"info",
				);
				return;
			}

			if (sub === "list") {
				ctx.ui.notify(formatStatus(cfg), "info");
				return;
			}

			if (sub === "update") {
				ctx.ui.notify("client-mimic: querying npm registry…", "info");
				const results = await updateVersions(restJoined || undefined, ctx.signal);
				refresh();
				updateFooter(ctx);
				ctx.ui.notify(`client-mimic update results:\n${formatUpdateResults(results)}`, "info");
				return;
			}

			if (sub === "prompt") {
				const tokens = rest.map((t) => t.toLowerCase()).filter(Boolean);

				// No args: show current system-prompt configuration.
				if (tokens.length === 0) {
					const profile = effectiveProfile();
					const spec = effectiveSpec(cfg, profile);
					const lines = [
						`global systemPrompt: ${describeSpec(cfg.systemPrompt)}`,
						`active profile: ${effectiveActive()}`,
					];
					if (profile) lines.push(`profile systemPrompt: ${describeSpec(profile.systemPrompt)}`);
					lines.push(`effective (this session): ${describeSpec(spec)}`);
					for (const [key, p] of Object.entries(cfg.profiles)) {
						lines.push(`  ${key}: ${describeSpec(p.systemPrompt)}`);
					}
					lines.push(
						"",
						"Global:      /mimic prompt <off|neutral>",
						"Per-profile: /mimic prompt <profile> <inherit|off|neutral|file> [path]",
					);
					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}

				// `/mimic prompt <profile> <mode> [path]` — per-profile control.
				if (cfg.profiles[tokens[0]]) {
					const key = tokens[0];
					const mode = tokens[1];
					if (!mode || !["inherit", "off", "neutral", "file"].includes(mode)) {
						ctx.ui.notify(
							`Usage: /mimic prompt ${key} <inherit|off|neutral|file> [path]`,
							"error",
						);
						return;
					}
					let nextSpec: SystemPromptSpec;
					if (mode === "file") {
						// Default to the tracked seed file for this profile when no path is given.
						const path = rest.slice(1).join(" ").trim() || `extensions/client-mimic/prompts/${key}.md`;
						const prev = cfg.profiles[key].systemPrompt;
						const apply = prev.mode === "file" && prev.apply ? prev.apply : "replace";
						nextSpec = { mode: "file", file: path, apply };
					} else {
						nextSpec = { mode: mode as SystemPromptSpec["mode"] };
					}
					const nextProfiles = {
						...cfg.profiles,
						[key]: { ...cfg.profiles[key], systemPrompt: nextSpec },
					};
					cfg = saveConfig({ profiles: nextProfiles });
					ctx.ui.notify(`client-mimic: ${key} systemPrompt = ${describeSpec(cfg.profiles[key].systemPrompt)}`, "info");
					return;
				}

				// `/mimic prompt <mode>` — global default (inherit not allowed here).
				const target = tokens[0];
				if (target !== "off" && target !== "neutral") {
					ctx.ui.notify(
						`Unknown target "${target}". Global: /mimic prompt <off|neutral>. Per-profile: /mimic prompt <${Object.keys(cfg.profiles).join("|")}> <mode> [path]`,
						"error",
					);
					return;
				}
				cfg = saveConfig({ systemPrompt: { mode: target } });
				ctx.ui.notify(`client-mimic global system prompt: ${target}`, "info");
				return;
			}

			if (sub === "help") {
				ctx.ui.notify(
					[
						"/mimic status            show config + active profile",
						"/mimic on | off          master switch",
						"/mimic use <profile>     activate codex | claude-code | off",
						"/mimic list              list profiles",
						"/mimic show [profile]    print resolved headers + body patch",
						"/mimic prompt                show system-prompt config (all levels)",
						"/mimic prompt <off|neutral>  set the global default",
						"/mimic prompt <profile> <inherit|off|neutral|file> [path]  per-profile",
						"/mimic update [name|all] refresh version(s) from npm registry",
						"flag: --mimic <profile>  session-only override at launch",
					].join("\n"),
					"info",
				);
				return;
			}

			ctx.ui.notify(`Unknown /mimic subcommand: ${sub}. Try /mimic help`, "error");
		},
	});

	function showProfile(ctx: ExtensionContext, key: string) {
		const profile = cfg.profiles[key.toLowerCase()];
		if (!profile) {
			ctx.ui.notify(`Unknown profile "${key}". Available: ${Object.keys(cfg.profiles).join(", ")}`, "error");
			return;
		}
		const tctx: TemplateContext = {
			version: profile.version,
			sessionId: ctx.sessionManager.getSessionId?.() ?? sessionId,
			uuid: () => "<uuid>",
		};
		const lines: string[] = [`${key} — ${profile.label} v${profile.version}`];
		if (profile.npmPackage) lines.push(`npm: ${profile.npmPackage}`);
		lines.push("headers:");
		for (const [name, rawValue] of Object.entries(profile.headers)) {
			if (rawValue === null) lines.push(`  - ${name}: (deleted)`);
			else lines.push(`  ${name}: ${resolveTemplate(rawValue, tctx)}`);
		}
		if (profile.stripHeaders.length) lines.push(`strip: ${profile.stripHeaders.join(", ")}`);
		const bodyKeys = Object.keys(profile.bodyPatch);
		if (bodyKeys.length) lines.push(`bodyPatch: ${JSON.stringify(profile.bodyPatch)}`);
		lines.push(`ensureMetadataUserId: ${profile.ensureMetadataUserId}`);
		lines.push(`prependBillingSystem: ${profile.prependBillingSystem}`);
		const varKeys = Object.keys(profile.templateVars);
		if (varKeys.length) lines.push(`templateVars: ${JSON.stringify(profile.templateVars)}`);
		lines.push(`systemPrompt: ${describeSpec(profile.systemPrompt)}`);
		ctx.ui.notify(lines.join("\n"), "info");
	}
}

/** One-line human description of a SystemPromptSpec. */
function describeSpec(spec: { mode: string; file?: string; apply?: string }): string {
	if (spec.mode === "file") {
		return `file (${spec.apply ?? "replace"}: ${spec.file ?? "<unset>"})`;
	}
	return spec.mode;
}

/** Stable 64-char hex device id (sha256 of host+user), matching Claude Code's shape. */
function stableDeviceId(): string {
	const seed = `${hostname()}|${process.env.USER ?? process.env.USERNAME ?? ""}|${process.platform}|${process.arch}`;
	return createHash("sha256").update(seed).digest("hex");
}

/** Union comma-separated anthropic-beta flags, preserving first-seen order. */
function mergeBetaFlags(existing: string, incoming: string): string {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const part of `${existing},${incoming}`.split(",")) {
		const flag = part.trim();
		if (!flag || seen.has(flag)) continue;
		seen.add(flag);
		out.push(flag);
	}
	return out.join(",");
}

/**
 * Ensure Anthropic Messages payload has Claude Code's metadata.user_id.
 * Real Claude Code sends a JSON string:
 *   {"device_id":"...","account_uuid":"","session_id":"..."}
 * Returns true if the payload was modified.
 */
function ensureClaudeMetadata(
	payload: Record<string, unknown>,
	deviceId: string,
	sessionId: string,
): boolean {
	const existingMeta =
		payload.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
			? ({ ...(payload.metadata as Record<string, unknown>) } as Record<string, unknown>)
			: {};
	if (typeof existingMeta.user_id === "string" && existingMeta.user_id.trim()) {
		return false;
	}
	existingMeta.user_id = JSON.stringify({
		device_id: deviceId,
		account_uuid: "",
		session_id: sessionId,
	});
	payload.metadata = existingMeta;
	return true;
}

const CLAUDE_AGENT_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

/**
 * Prepend Claude Code's billing-header + Agent SDK identity blocks onto the
 * provider payload's `system` field. Handles both string and content-block
 * array forms. Returns true if modified.
 */
function prependClaudeBillingSystem(payload: Record<string, unknown>, version: string): boolean {
	const billing = "x-anthropic-billing-header: cc_version=" + version + "; cc_entrypoint=cli;";
	const sys = payload.system;

	// Only treat a leading system block that *starts with* the billing header as
	// already present. A mere substring match is too broad (seed prompts may
	// mention the header name in documentation text).
	if (hasLeadingBillingHeader(sys)) return false;

	if (sys == null || sys === "") {
		payload.system = [
			{ type: "text", text: billing },
			{ type: "text", text: CLAUDE_AGENT_IDENTITY },
		];
		return true;
	}

	if (typeof sys === "string") {
		// Keep as content blocks so the gateway can match the first block exactly
		// the way the real CLI does (array of text blocks).
		const rest = sys.startsWith(CLAUDE_AGENT_IDENTITY)
			? [{ type: "text", text: sys }]
			: [
					{ type: "text", text: CLAUDE_AGENT_IDENTITY },
					{ type: "text", text: sys },
				];
		payload.system = [{ type: "text", text: billing }, ...rest];
		return true;
	}

	if (Array.isArray(sys)) {
		const blocks = sys.slice();
		const hasIdentity = systemContains(sys, "Claude Agent SDK");
		const prepend: Array<Record<string, unknown>> = [{ type: "text", text: billing }];
		if (!hasIdentity) prepend.push({ type: "text", text: CLAUDE_AGENT_IDENTITY });
		payload.system = prepend.concat(blocks);
		return true;
	}

	return false;
}

/** True only when the first system block/string starts with the billing header. */
function hasLeadingBillingHeader(sys: unknown): boolean {
	const prefix = "x-anthropic-billing-header:";
	if (typeof sys === "string") return sys.trimStart().startsWith(prefix);
	if (!Array.isArray(sys) || sys.length === 0) return false;
	const first = sys[0];
	if (typeof first === "string") return first.trimStart().startsWith(prefix);
	if (first && typeof first === "object" && typeof (first as { text?: unknown }).text === "string") {
		return (first as { text: string }).text.trimStart().startsWith(prefix);
	}
	return false;
}

function systemContains(sys: unknown, needle: string): boolean {
	if (typeof sys === "string") return sys.includes(needle);
	if (!Array.isArray(sys)) return false;
	for (const block of sys) {
		if (typeof block === "string" && block.includes(needle)) return true;
		if (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string") {
			if (((block as { text: string }).text).includes(needle)) return true;
		}
	}
	return false;
}
