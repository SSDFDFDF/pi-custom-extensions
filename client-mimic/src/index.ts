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
 *   /mimic show [profile]  print a profile's resolved headers/body
 *   /mimic update [name]   pull latest version from npm and refresh {version}
 *
 * Flag:
 *   --mimic <profile>      activate a profile for this launch (session-only)
 */

import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	formatStatus,
	loadConfig,
	resolveTemplate,
	saveConfig,
	type MimicConfig,
	type MimicProfile,
	type TemplateContext,
} from "./config.ts";
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
		for (const [name, rawValue] of Object.entries(profile.headers)) {
			const lower = name.toLowerCase();
			for (const existing of Object.keys(event.headers)) {
				if (existing !== name && existing.toLowerCase() === lower) {
					event.headers[existing] = null;
				}
			}
			event.headers[name] = rawValue === null ? null : resolveTemplate(rawValue, tctx);
		}
	});

	// ── Body patch ───────────────────────────────────────────────────────────

	pi.on("before_provider_request", (event) => {
		const profile = effectiveProfile();
		if (!profile) return;
		const keys = Object.keys(profile.bodyPatch);
		if (!keys.length) return;

		const payload = event.payload as Record<string, unknown>;
		return { ...payload, ...profile.bodyPatch };
	});

	// ── Commands ───────────────────────────────────────────────────────────────

	pi.registerCommand("mimic", {
		description:
			"client-mimic: status | on | off | use <profile> | list | show [profile] | update [name|all]",
		getArgumentCompletions: (prefix: string) => {
			const subs = ["status", "on", "off", "use", "list", "show", "update"];
			const profiles = Object.keys(loadConfig().profiles);
			const parts = prefix.split(/\s+/);
			let items: { value: string; label: string }[];
			if (parts.length <= 1) {
				items = subs.map((s) => ({ value: s, label: s }));
			} else if (parts[0] === "use" || parts[0] === "show") {
				items = [...profiles, "off"].map((p) => ({ value: `${parts[0]} ${p}`, label: p }));
			} else if (parts[0] === "update") {
				items = ["all", ...profiles].map((p) => ({ value: `update ${p}`, label: p }));
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

			if (sub === "help") {
				ctx.ui.notify(
					[
						"/mimic status            show config + active profile",
						"/mimic on | off          master switch",
						"/mimic use <profile>     activate codex | claude-code | off",
						"/mimic list              list profiles",
						"/mimic show [profile]    print resolved headers + body patch",
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
		ctx.ui.notify(lines.join("\n"), "info");
	}
}
