/**
 * session-error-clean — Pi extension
 *
 * Unifies:
 * 1. Session file cleaning + live context reload (`ctx.switchSession()`):
 *    - Removes persisted error entries (`stopReason: "error"`) and relinks parentIds
 *    - Strips persisted Responses reasoning signatures (`thinkingSignature`, `|fc_*`, `msg_*`, `responseId`)
 *      while preserving visible thinking summaries and tool call/result pairing
 * 2. Outbound Responses `before_provider_request` reasoning compatibility guard:
 *    - Strips historical `reasoning` items, `encrypted_content`, and old item `id`s from `payload.input`
 *    - Preserves `payload.include` (`["reasoning.encrypted_content"]`) required by Codex/CPA gateways
 */

import { basename } from "node:path";
import { cleanSessionFile, findSessionFiles, type CleanFilter, type RemovedError } from "./clean.ts";
import { compilePattern, formatConfigSummary, loadConfig, saveConfig, sessionsRoot } from "./config.ts";
import { RESPONSES_APIS, sanitizeResponsesPayload } from "./sanitize.ts";

const STATUS_KEY = "clean-errors";
const STATUS_VISIBLE_MS = 6_000;

type NotifyLevel = "info" | "warning" | "error";

interface UiLike {
	notify?: (message: string, level?: NotifyLevel) => void;
	setStatus?: (key: string | undefined, text: string | undefined) => void;
}

interface SessionManagerLike {
	getSessionFile(): string | undefined;
}

interface CommandContextLike {
	hasUI: boolean;
	mode?: string;
	model?: { api: string };
	ui: UiLike;
	sessionManager: SessionManagerLike;
	/** Present on ExtensionCommandContext in TUI/RPC; absent on event contexts. */
	switchSession?: (
		sessionPath: string,
		options?: { withSession?: (ctx: CommandContextLike) => Promise<void> },
	) => Promise<{ cancelled: boolean }>;
}

interface ExtensionApiLike {
	on(event: string, handler: (event: any, ctx: CommandContextLike) => any): void;
	registerFlag?: (
		name: string,
		options: { type: "boolean" | "string"; default?: boolean | string; description?: string },
	) => void;
	getFlag?: (name: string) => unknown;
	registerCommand(
		name: string,
		options: {
			description: string;
			showInMenu?: boolean;
			handler: (args: string, ctx: CommandContextLike) => Promise<void> | void;
		},
	): void;
}

function errorEntryWord(n: number): string {
	return `${n} error ${n === 1 ? "entry" : "entries"}`;
}

function summarizeRemoved(removed: RemovedError[], maxLines = 5): string {
	if (removed.length === 0) return "";
	const lines = removed.slice(0, maxLines).map((r) => `  - ${r.preview}`);
	if (removed.length > maxLines) lines.push(`  - … and ${removed.length - maxLines} more`);
	return lines.join("\n");
}

interface CleanOutcome {
	file: string;
	planTotal: number;
	removed: RemovedError[];
	reasoningCleaned: number;
	signaturesRemoved: number;
	itemIdsRemoved: number;
	rewritten: boolean;
	backupFile?: string;
	bytesBefore: number;
	bytesAfter: number;
}

function cleanFile(file: string, filter: CleanFilter, opts: { backup: boolean; dryRun?: boolean }): CleanOutcome {
	const result = cleanSessionFile(file, filter, { backup: opts.backup, dryRun: opts.dryRun });
	return {
		file,
		planTotal: result.plan.total,
		removed: result.plan.removed,
		reasoningCleaned: result.plan.reasoningCleaned,
		signaturesRemoved: result.plan.signaturesRemoved,
		itemIdsRemoved: result.plan.itemIdsRemoved,
		rewritten: result.rewritten,
		backupFile: result.backupFile,
		bytesBefore: result.bytesBefore,
		bytesAfter: result.bytesAfter,
	};
}

function formatOutcome(outcome: CleanOutcome, header: string, filter: CleanFilter = {}): string {
	const parts: string[] = [];
	if (filter.cleanErrors !== false) {
		parts.push(`removed ${errorEntryWord(outcome.removed.length)}`);
	}
	if (filter.cleanReasoning) {
		parts.push(
			`cleaned reasoning/IDs in ${outcome.reasoningCleaned} ${outcome.reasoningCleaned === 1 ? "message" : "messages"} (${outcome.signaturesRemoved} signatures, ${outcome.itemIdsRemoved} item IDs)`,
		);
	}
	const lines = [`${header}: ${parts.join(", ")} of ${outcome.planTotal} entries`];
	const touched = outcome.removed.length > 0 || outcome.reasoningCleaned > 0;
	if (touched) {
		const detail = summarizeRemoved(outcome.removed);
		if (detail) lines.push(detail);
		lines.push(
			outcome.rewritten
				? `rewritten: ${outcome.file} (${outcome.bytesBefore} → ${outcome.bytesAfter} bytes)`
				: "dry run — file not modified",
		);
		if (outcome.backupFile) lines.push(`backup: ${outcome.backupFile}`);
	}
	return lines.join("\n");
}

function reportOutcome(ctx: CommandContextLike, outcome: CleanOutcome, header: string, filter: CleanFilter = {}): void {
	if (ctx.hasUI && ctx.ui?.notify) ctx.ui.notify(formatOutcome(outcome, header, filter), "info");
	else process.stderr.write(`${formatOutcome(outcome, header, filter)}\n`);
}

export default function sessionErrorClean(pi: ExtensionApiLike) {
	let statusTimer: NodeJS.Timeout | undefined;
	let compatEnabled = true;
	let compatRequests = 0;

	const flashStatus = (ctx: CommandContextLike, text: string) => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		ctx.ui.setStatus?.(STATUS_KEY, text);
		if (statusTimer) clearTimeout(statusTimer);
		statusTimer = setTimeout(() => {
			statusTimer = undefined;
			ctx.ui.setStatus?.(STATUS_KEY, undefined);
		}, STATUS_VISIBLE_MS);
	};

	const resolveFilter = (cleanErrors = true, cleanReasoning = true): CleanFilter => ({
		pattern: compilePattern(loadConfig().pattern),
		cleanErrors,
		cleanReasoning,
	});

	pi.on("session_start", (_event, ctx) => {
		compatRequests = 0;
		const cfg = loadConfig();
		if (!cfg.autoClean) return;
		const file = ctx.sessionManager.getSessionFile();
		if (!file) return;
		try {
			const outcome = cleanFile(file, resolveFilter(true, true), { backup: cfg.backup });
			if ((outcome.removed.length > 0 || outcome.reasoningCleaned > 0) && outcome.rewritten) {
				flashStatus(
					ctx,
					`cleaned ${errorEntryWord(outcome.removed.length)}, ${outcome.reasoningCleaned} reasoning msgs — /clean-errors to reload live context`,
				);
			}
		} catch (err) {
			ctx.ui.notify?.(
				`session-error-clean auto-clean failed: ${err instanceof Error ? err.message : String(err)}`,
				"warning",
			);
		}
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!compatEnabled || !ctx?.model || !RESPONSES_APIS.has(ctx.model.api)) return;
		const payload = sanitizeResponsesPayload(event.payload);
		if (payload === undefined) return;
		compatRequests++;
		return payload;
	});

	const formatCompatStatus = (ctx: CommandContextLike): string => {
		const applicable = ctx?.model && RESPONSES_APIS.has(ctx.model.api);
		return (
			`compat: ${compatEnabled ? "ON" : "OFF"}; ` +
			`当前 API ${applicable ? "适用" : "不适用"}; 已处理 ${compatRequests} 次请求。`
		);
	};

	const runCleanCommand = async (rawArgs: string, ctx: CommandContextLike, defaultMode: "all" | "reasoning" = "all") => {
		const cfg = loadConfig();
		const args = (rawArgs ?? "").trim();
		const [cmd, ...rest] = args.split(/\s+/);
		const sub = (cmd ?? "").toLowerCase();
		const restJoined = rest.join(" ").trim();
		const notify = (msg: string, level: NotifyLevel = "info") => {
			if (ctx.hasUI && ctx.ui?.notify) ctx.ui.notify(msg, level);
			else process.stderr.write(`${msg}\n`);
		};

		if (sub === "help") {
			notify(
				[
					"Clean persisted error entries and/or encrypted reasoning signatures from session files.",
					"/clean-errors                        clean error entries + reasoning signatures & reload (default)",
					"/clean-errors reasoning [dry|<id>]   strip encrypted reasoning signatures & fc_* item IDs + reload",
					"/clean-errors errors [dry|<id>]      remove only error entries (stopReason=error) + reload",
					"/clean-errors compat [on|off|status] toggle outbound Responses reasoning sanitizer",
					"/clean-errors dry [reasoning|errors] preview what would be cleaned (no write)",
					"/clean-errors <id-prefix>            clean another session file (no live reload)",
					"/clean-errors pattern <re>           default filter on errorMessage, e.g. 503 ('' = all)",
					"/clean-errors auto on|off            auto-clean file on session_start",
					"/clean-errors status                 show config + compat status",
				].join("\n"),
				"info",
			);
			return;
		}

		if (sub === "status" || sub === "show") {
			notify(`${formatConfigSummary(cfg)}\n${formatCompatStatus(ctx)}`, "info");
			return;
		}

		if (sub === "compat") {
			const action = (rest[0] ?? "status").toLowerCase();
			if (!["on", "off", "status"].includes(action)) {
				notify("Usage: /clean-errors compat [on|off|status]", "error");
				return;
			}
			if (action !== "status") compatEnabled = action === "on";
			notify(formatCompatStatus(ctx), "info");
			return;
		}

		if (sub === "auto") {
			const a = restJoined.toLowerCase();
			if (!a) {
				notify(`autoClean=${cfg.autoClean ? "on" : "off"}`, "info");
				return;
			}
			if (a !== "on" && a !== "off") {
				notify("Usage: /clean-errors auto <on|off>", "error");
				return;
			}
			const next = saveConfig({ autoClean: a === "on" });
			notify(
				`session-error-clean autoClean=${next.autoClean ? "on" : "off"}${
					next.autoClean ? " (file-level; /clean-errors also reloads live context)" : ""
				}`,
				"info",
			);
			return;
		}

		if (sub === "pattern") {
			if (!restJoined) {
				notify(`pattern: ${cfg.pattern || "(all error entries)"}`, "info");
				return;
			}
			try {
				compilePattern(restJoined);
			} catch (e) {
				notify(`Invalid regex: ${e instanceof Error ? e.message : String(e)}`, "error");
				return;
			}
			const next = saveConfig({ pattern: restJoined });
			notify(`session-error-clean pattern=${next.pattern || "(all error entries)"}`, "info");
			return;
		}

		let activeFilter: CleanFilter = resolveFilter(defaultMode !== "reasoning", true);
		let targetArg = sub;
		let isDryRun = false;

		if (sub === "reasoning" || sub === "errors" || sub === "all" || sub === "clean") {
			const mode = sub === "clean" ? defaultMode : sub;
			activeFilter = resolveFilter(mode !== "reasoning", mode !== "errors");
			const nextToken = (rest[0] ?? "").toLowerCase();
			if (nextToken === "dry") {
				isDryRun = true;
				targetArg = (rest[1] ?? "").toLowerCase();
			} else {
				targetArg = nextToken;
			}
		} else if (sub === "dry") {
			isDryRun = true;
			const nextToken = (rest[0] ?? "").toLowerCase();
			if (nextToken === "reasoning" || nextToken === "errors" || nextToken === "all") {
				activeFilter = resolveFilter(nextToken !== "reasoning", nextToken !== "errors");
				targetArg = (rest[1] ?? "").toLowerCase();
			} else {
				targetArg = nextToken;
			}
		}

		if (isDryRun) {
			const file = ctx.sessionManager.getSessionFile();
			if (!file) {
				notify("No session file (sessions disabled)", "error");
				return;
			}
			try {
				reportOutcome(
					ctx,
					cleanFile(file, activeFilter, { backup: cfg.backup, dryRun: true }),
					"DRY RUN",
					activeFilter,
				);
			} catch (e) {
				notify(`Clean failed: ${e instanceof Error ? e.message : String(e)}`, "error");
			}
			return;
		}

		// Remaining forms select a file: no args / "current" (the default), an
		// id/prefix looked up under the sessions root, or an absolute path.
		let file: string | undefined;
		if (targetArg === "" || targetArg === "current") {
			file = ctx.sessionManager.getSessionFile();
			if (!file) {
				notify("No session file (sessions disabled)", "error");
				return;
			}
		} else if (targetArg.startsWith("/") || targetArg.startsWith("~")) {
			file = targetArg;
		} else if (!targetArg.includes("/") && !targetArg.includes("\\")) {
			const matches = findSessionFiles(sessionsRoot(), targetArg);
			if (matches.length === 0) {
				notify(`No session file matching "${targetArg}" under ${sessionsRoot()}`, "error");
				return;
			}
			if (matches.length > 1) {
				notify(
					`Ambiguous id "${targetArg}" matches ${matches.length} files:\n${matches.map((m) => `  - ${basename(m)}`).join("\n")}`,
					"error",
				);
				return;
			}
			file = matches[0];
		}

		if (!file) {
			notify(`Unknown subcommand: ${sub}. Try /clean-errors help`, "error");
			return;
		}

		// Current-session path: rewrite the file, then reload it into the live
		// agent so the in-memory context drops the errors/signatures too.
		const currentFile = ctx.sessionManager.getSessionFile();
		const isCurrent = currentFile !== undefined && file === currentFile;
		try {
			const outcome = cleanFile(file, activeFilter, { backup: cfg.backup });
			const header = isCurrent ? "Current session" : `Session ${basename(file)}`;

			const didCleanCurrent =
				isCurrent && outcome.rewritten && (outcome.removed.length > 0 || outcome.reasoningCleaned > 0);
			const willReload = didCleanCurrent && !!ctx.switchSession;
			if (!willReload) reportOutcome(ctx, outcome, header, activeFilter);
			if (!didCleanCurrent) return;

			if (ctx.switchSession) {
				const outcomeReport = formatOutcome(outcome, header, activeFilter);
				const { cancelled } = await ctx.switchSession(file, {
					withSession: async (freshCtx) => {
						freshCtx.ui.notify?.(
							`${outcomeReport}\nSession reloaded from cleaned file — live context is now clean.`,
							"info",
						);
					},
				});
				if (cancelled) {
					notify(
						`${outcomeReport}\nSession reload cancelled; file was cleaned but live context still holds old entries.`,
						"warning",
					);
				}
			} else {
				notify("File cleaned; start a new context (e.g. resume the session) to drop them live.", "warning");
			}
		} catch (e) {
			notify(`Clean failed: ${e instanceof Error ? e.message : String(e)}`, "error");
		}
	};

	pi.registerCommand("clean-errors", {
		description:
			"Clean session errors & encrypted reasoning signatures and reload (clean-errors [reasoning|errors|compat|dry|<id-prefix>|pattern|auto|status|help])",
		showInMenu: false,
		handler: (rawArgs, ctx) => runCleanCommand(rawArgs, ctx, "all"),
	});
}
