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
 *   /mimic use <profile>   activate a profile (codex | codex-lite | claude-code | off)
 *   /mimic list            list profiles
 *   /mimic show [profile]  print a profile's resolved headers/body/prompt mode
 *   /mimic reset-ids       replace all managed identities for this conversation
 *   /mimic ids             show current identities
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

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	ensureClaudeMetadata,
	prependClaudeBillingSystem,
} from "./claude-body.ts";
import {
	advanceWindowChain,
	createInitialIdentityState,
	ensureCodexIdentity,
	loadIdentityStore,
	persistIdentityState,
	recordFromState,
	resolveCodexIdentityOnSessionStart,
	rotateIdentityState,
	saveIdentityStore,
	uuidV7,
	type CodexIdentityState,
	type CodexIdentityStore,
} from "./codex-identity.ts";
import { applyCodexResponsesLite } from "./codex-lite.ts";
import {
	formatStatus,
	loadConfig,
	saveConfig,
	type MimicConfig,
	type MimicProfile,
	type SystemPromptSpec,
	type TemplateContext,
} from "./config.ts";
import { rewriteHeaders } from "./headers.ts";
import { applySystemPrompt, effectiveSpec } from "./system-prompt.ts";
import { formatUpdateResults, updateVersions } from "./update.ts";
import {
	registerClaudeCodeWrappers,
	type WrapperOptions,
} from "./provider-wrap.ts";

const FLAG = "mimic";
const STATUS_KEY = "client-mimic";
const RESET_TEMPLATE_KEYS = new Set([
	"session_id", "thread_id", "parent_thread_id", "window_id", "first_window_id",
	"previous_window_id", "window_number", "turn_id", "installation_id", "uuid", "uuid_v7",
]);

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
	// Codex and Claude identities stored together per Pi conversation.
	const identityStore: CodexIdentityStore = { byPiSession: {} };
	let identity: CodexIdentityState = createInitialIdentityState("");

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

	const persistCurrentIdentity = () => {
		persistIdentityState(identityStore, identity);
		saveIdentityStore(identityStore, undefined, { onlyKey: identity.piSessionKey });
	};

	/** Session id exposed in headers/body: Claude profile wants v4; Codex keeps tree ids. */
	const headerSessionId = (profile: MimicProfile): string => {
		if (!profile.ensureCodexIdentity && (profile.ensureMetadataUserId || profile.prependBillingSystem ||
			Object.keys(profile.headers).some((name) => name.toLowerCase() === "x-claude-code-session-id"))) {
			return identity.claudeSessionId;
		}
		return identity.sessionId;
	};

	const templateCtx = (profile: MimicProfile): TemplateContext => {
		const sessionId = headerSessionId(profile);
		return {
			version: profile.version,
			sessionId,
			threadId: identity.threadId,
			parentThreadId: identity.parentThreadId,
			windowId: identity.windowId,
			firstWindowId: identity.firstWindowId,
			previousWindowId: identity.previousWindowId,
			windowNumber: identity.windowNumber,
			turnId: identity.turnId,
			installationId: identity.installationId,
			uuid: () => crypto.randomUUID(),
			uuidV7: () => uuidV7(),
			vars: Object.fromEntries(Object.entries(profile.templateVars).filter(([key]) =>
				!RESET_TEMPLATE_KEYS.has(key))),
		};
	};

	const updateFooter = (ctx: Pick<ExtensionContext, "hasUI" | "ui">) => {
		if (!ctx.hasUI) return;
		const key = effectiveActive();
		if (!cfg.enabled || key === "off" || !cfg.profiles[key]) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		ctx.ui.setStatus(STATUS_KEY, `mimic:${key}`);
	};

	/**
	 * Register provider-level `streamSimple` wrappers (body and header patching
	 * at the lowest layer) so the patches survive code paths that bypass extension
	 * hooks — chiefly context compaction. Only Claude-shaped profiles can wrap
	 * Anthropic providers; applying this wrapper to Codex would change its API.
	 * Options are resolved afresh per request so resets and on/off apply without
	 * nested registrations or stale session snapshots.
	 */
	const registeredWrappers = new Set<string>();
	const currentWrapOptions = (): WrapperOptions | null => {
		const profile = effectiveProfile();
		if (!profile || (!profile.ensureMetadataUserId && !profile.prependBillingSystem)) return null;
		return {
			deviceId: identity.deviceId,
			sessionId: headerSessionId(profile),
			ensureMetadataUserId: profile.ensureMetadataUserId,
			prependBillingSystem: profile.prependBillingSystem,
			version: profile.version,
			enforceThinkingIdentity: true,
			forceIdentity: true,
			profile,
			templateContext: templateCtx(profile),
		};
	};
	const maybeRegisterWrappers = (ctx: Pick<ExtensionContext, "hasUI" | "ui">) => {
		if (!currentWrapOptions()) return;
		const ids = cfg.wrapProviders.filter((id) => !registeredWrappers.has(id));
		if (!ids.length) return;
		const wrapped: string[] = [];
		const skipped: string[] = [];
		for (const id of ids) {
			const result = registerClaudeCodeWrappers(pi, [id], () =>
				cfg.wrapProviders.includes(id) ? currentWrapOptions() : null);
			wrapped.push(...result.wrapped);
			skipped.push(...result.skipped);
		}
		for (const id of wrapped) registeredWrappers.add(id);
		if (ctx.hasUI) {
			if (wrapped.length) {
				ctx.ui.notify(
					`client-mimic: wrapped provider streamSimple for ${wrapped.join(", ")}`,
					"info",
				);
			}
			for (const id of skipped) {
				ctx.ui.notify(`client-mimic: failed to wrap provider "${id}"`, "warning");
			}
		}
	};

	// ── Lifecycle ────────────────────────────────────────────────────────────

	pi.on("session_start", (event, ctx) => {
		refresh();
		try {
			identityStore.byPiSession = loadIdentityStore().byPiSession;
		} catch (err) {
			identityStore.byPiSession = {};
			if (ctx.hasUI) {
				ctx.ui.notify(`client-mimic: ${err instanceof Error ? err.message : String(err)}`, "warning");
			}
		}
		identity = resolveCodexIdentityOnSessionStart(event, ctx.sessionManager, identityStore);
		persistCurrentIdentity();

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

		// Provider-level wrapping: when a Claude-Code-shaped profile is active and
		// the user listed provider ids in `wrapProviders`, wrap their
		// `streamSimple` so the body patches (incl. the thinking+output_config
		// identity pair) also take effect during compaction, which calls the
		// provider's `streamSimple` directly and skips `before_provider_request`.
		maybeRegisterWrappers(ctx);

		if (ctx.hasUI) {
			const p = effectiveProfile();
			if (p) {
				const tree =
					identity.parentThreadId != null
						? ` child thread=${identity.threadId.slice(0, 8)}… session=${identity.sessionId.slice(0, 8)}…`
						: ` root=${identity.sessionId.slice(0, 8)}…`;
				ctx.ui.notify(
					`client-mimic active: ${effectiveActive()} (${p.label} v${p.version})${tree} win#${identity.windowNumber}`,
					"info",
				);
			}
		}
	});

	// Compact advances the Codex context-window chain (session/thread unchanged).
	pi.on("session_compact", (_event, ctx) => {
		const win = advanceWindowChain(identity);
		identity = { ...identity, ...win };
		persistCurrentIdentity();
		if (ctx.hasUI && effectiveProfile()?.ensureCodexIdentity) {
			ctx.ui.notify(
				`client-mimic: context window advanced → #${identity.windowNumber} ${identity.windowId.slice(0, 8)}…`,
				"info",
			);
		}
	});

	// ── Header rewrite ─────────────────────────────────────────────────────────

	pi.on("before_provider_headers", (event, ctx) => {
		const profile = effectiveProfile();
		if (!profile) return;

		// One turn_id per outbound request when mimicking Codex.
		if (profile.ensureCodexIdentity) {
			identity = { ...identity, turnId: uuidV7() };
		}
		const tctx = templateCtx(profile);

		rewriteHeaders(event.headers, profile, tctx, true);
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
			if (ensureClaudeMetadata(payload, identity.deviceId, identity.claudeSessionId, true)) changed = true;
		}

		// 3. Claude Code billing/identity system preamble.
		if (profile.prependBillingSystem) {
			if (prependClaudeBillingSystem(payload, profile.version)) changed = true;
		}

		// 4. Codex Responses identity. Responses Lite uses Codex's current
		// client_metadata field; the original codex profile keeps its legacy
		// metadata shape for backwards compatibility with existing gateways.
		const isCompatibleCodexPayload = !profile.codexResponsesLite || Array.isArray(payload.input);
		if (profile.ensureCodexIdentity && isCompatibleCodexPayload) {
			if (
				ensureCodexIdentity(payload, {
					sessionId: identity.sessionId,
					threadId: identity.threadId,
					windowId: identity.windowId,
					installationId: identity.installationId,
					parentThreadId: identity.parentThreadId,
					firstWindowId: identity.firstWindowId,
					previousWindowId: identity.previousWindowId,
					windowNumber: identity.windowNumber,
					turnId: identity.turnId,
				},
				profile.codexResponsesLite ? "client_metadata" : "metadata",
				)
			) {
				changed = true;
			}
		}

		// 5. Codex Responses Lite transport contract.
		if (profile.codexResponsesLite) {
			if (applyCodexResponsesLite(payload)) changed = true;
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
			"client-mimic: status | on | off | use <profile> | ids | reset-ids | show [profile] | update [name|all]",
		getArgumentCompletions: (prefix: string) => {
			const subs = ["status", "on", "off", "use", "list", "show", "ids", "reset-ids", "update", "prompt", "help"];
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

			if (sub === "ids") {
				ctx.ui.notify(identitySummary(), "info");
				return;
			}

			if (sub === "reset-ids") {
				if (restJoined) {
					ctx.ui.notify("Usage: /mimic reset-ids (current conversation only)", "error");
					return;
				}
				// Never change identity between the headers and body of an active turn.
				if (!ctx.isIdle() || ctx.hasPendingMessages()) {
					ctx.ui.notify("client-mimic: wait for the current turn and queued messages to finish before resetting IDs.", "warning");
					return;
				}
				if (ctx.sessionManager.getSessionId() !== identity.piSessionKey) {
					ctx.ui.notify("client-mimic: session changed; run /reload before resetting IDs.", "error");
					return;
				}
				const next = rotateIdentityState(identity);
				const staged: CodexIdentityStore = { byPiSession: {} };
				persistIdentityState(staged, next);
				try {
					saveIdentityStore(staged, undefined, { onlyKey: next.piSessionKey, strict: true });
				} catch (err) {
					ctx.ui.notify(`client-mimic: IDs unchanged; could not save: ${err instanceof Error ? err.message : String(err)}`, "error");
					return;
				}
				identity = next;
				identityStore.byPiSession[next.piSessionKey] = recordFromState(next);
				ctx.ui.notify([
					"client-mimic: current conversation identities reset and saved. Effective on the next request.",
					"Pi session ID/history, other conversations and machine identity files are unchanged.",
					"Old parent/window links cleared; gateway prompt cache may be cold.",
					identitySummary(),
				].join("\n"), "info");
				return;
			}

			if (sub === "on" || sub === "enable") {
				cfg = saveConfig({ enabled: true });
				maybeRegisterWrappers(ctx);
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
				maybeRegisterWrappers(ctx);
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
				maybeRegisterWrappers(ctx);
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
						const path = rest.slice(2).join(" ").trim() || `extensions/client-mimic/prompts/${key}.md`;
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
						"/mimic use <profile>     activate codex | codex-lite | claude-code | off",
						"/mimic ids               show current session/thread/window/device IDs",
						"/mimic reset-ids         replace all managed IDs for this conversation (keeps history)",
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

	function identitySummary(): string {
		return [
			`pi_session_id (storage key): ${identity.piSessionKey}`,
			`codex session_id: ${identity.sessionId}`,
			`thread_id: ${identity.threadId}`,
			`parent_thread_id: ${identity.parentThreadId ?? "(none)"}`,
			`window_id: ${identity.windowId}`,
			`first_window_id: ${identity.firstWindowId}`,
			`previous_window_id: ${identity.previousWindowId ?? "(none)"}`,
			`window_number: ${identity.windowNumber}`,
			`turn_id: ${identity.turnId}`,
			`installation_id: ${identity.installationId}`,
			`claude session_id: ${identity.claudeSessionId}`,
			`device_id: ${identity.deviceId}`,
		].join("\n");
	}

	function showProfile(ctx: ExtensionContext, key: string) {
		const profile = cfg.profiles[key.toLowerCase()];
		if (!profile) {
			ctx.ui.notify(`Unknown profile "${key}". Available: ${Object.keys(cfg.profiles).join(", ")}`, "error");
			return;
		}
		const tctx = templateCtx(profile);
		const lines: string[] = [`${key} — ${profile.label} v${profile.version}`];
		if (profile.npmPackage) lines.push(`npm: ${profile.npmPackage}`);
		lines.push("headers:");
		const headers: Record<string, string | null | undefined> = {};
		rewriteHeaders(headers, profile, tctx, true);
		for (const [name, value] of Object.entries(headers)) {
			lines.push(`  ${name}: ${value ?? "(deleted)"}`);
		}
		if (profile.stripHeaders.length) lines.push(`strip: ${profile.stripHeaders.join(", ")}`);
		const bodyKeys = Object.keys(profile.bodyPatch);
		if (bodyKeys.length) lines.push(`bodyPatch: ${JSON.stringify(profile.bodyPatch)}`);
		lines.push(`ensureMetadataUserId: ${profile.ensureMetadataUserId}`);
		lines.push(`prependBillingSystem: ${profile.prependBillingSystem}`);
		lines.push(`ensureCodexIdentity: ${profile.ensureCodexIdentity}`);
		lines.push(`codexResponsesLite: ${profile.codexResponsesLite}`);
		lines.push(`resolved session_id: ${headerSessionId(profile)}`, identitySummary());
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
