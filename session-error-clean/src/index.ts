/**
 * session-error-clean — Pi extension
 *
 * Removes persisted error entries (assistant messages with stopReason "error",
 * e.g. 503 retries) from pi session files. pi sessions are append-only JSONL
 * trees with no API to delete entries, so cleaning rewrites the JSONL directly
 * (relinking parentId chains) and — for the current session — reloads it into
 * the running agent via ctx.switchSession().
 *
 * - `/clean-errors`                clean + reload the CURRENT session
 * - `/clean-errors dry`            preview counts for the current session
 * - `/clean-errors <id-or-prefix>` clean another session file by id prefix
 * - `/clean-errors pattern <re>`   default regex filter on errorMessage ('' = all)
 * - `/clean-errors auto on|off`    auto-clean on session_start (file-only)
 * - `/clean-errors status|help`    config summary / usage
 *
 * Config: ~/.pi/agent/session-error-clean.config.json
 */

import { basename } from "node:path";
import { cleanSessionFile, findSessionFiles, type CleanFilter, type RemovedError } from "./clean.ts";
import { compilePattern, formatConfigSummary, loadConfig, saveConfig, sessionsRoot } from "./config.ts";

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
	ui: UiLike;
	sessionManager: SessionManagerLike;
	/** Present on ExtensionCommandContext in TUI/RPC; absent on event contexts. */
	switchSession?: (
		sessionPath: string,
		options?: { withSession?: (ctx: CommandContextLike) => Promise<void> },
	) => Promise<{ cancelled: boolean }>;
}

interface ExtensionApiLike {
	on(event: "session_start", handler: (event: unknown, ctx: CommandContextLike) => void): void;
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
		rewritten: result.rewritten,
		backupFile: result.backupFile,
		bytesBefore: result.bytesBefore,
		bytesAfter: result.bytesAfter,
	};
}

function formatOutcome(outcome: CleanOutcome, header: string): string {
	const lines = [`${header}: removed ${errorEntryWord(outcome.removed.length)} of ${outcome.planTotal} entries`];
	if (outcome.removed.length > 0) {
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

function reportOutcome(ctx: CommandContextLike, outcome: CleanOutcome, header: string): void {
	ctx.ui.notify?.(formatOutcome(outcome, header), "info");
}

export default function sessionErrorClean(pi: ExtensionApiLike) {
	let statusTimer: NodeJS.Timeout | undefined;

	const flashStatus = (ctx: CommandContextLike, text: string) => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		ctx.ui.setStatus?.(STATUS_KEY, text);
		if (statusTimer) clearTimeout(statusTimer);
		statusTimer = setTimeout(() => {
			statusTimer = undefined;
			ctx.ui.setStatus?.(STATUS_KEY, undefined);
		}, STATUS_VISIBLE_MS);
	};

	const resolveFilter = (): CleanFilter => ({ pattern: compilePattern(loadConfig().pattern) });

	pi.on("session_start", (_event, ctx) => {
		const cfg = loadConfig();
		if (!cfg.autoClean) return;
		const file = ctx.sessionManager.getSessionFile();
		if (!file) return;
		try {
			const outcome = cleanFile(file, resolveFilter(), { backup: cfg.backup });
			if (outcome.removed.length > 0 && outcome.rewritten) {
				flashStatus(
					ctx,
					`cleaned ${errorEntryWord(outcome.removed.length)} — /clean-errors to also reload the live context`,
				);
			}
		} catch (err) {
			ctx.ui.notify?.(
				`session-error-clean auto-clean failed: ${err instanceof Error ? err.message : String(err)}`,
				"warning",
			);
		}
	});

	pi.registerCommand("clean-errors", {
		description:
			"Clean error entries from the current session and reload it (clean-errors [help|dry|<id-prefix>|pattern <re>|auto on|off|status])",
		showInMenu: false,
		handler: async (rawArgs, ctx) => {
			const cfg = loadConfig();
			const args = (rawArgs ?? "").trim();
			const [cmd, ...rest] = args.split(/\s+/);
			const sub = (cmd ?? "").toLowerCase();
			const restJoined = rest.join(" ").trim();

			if (sub === "help") {
				ctx.ui.notify?.(
					[
						"Remove persisted error entries (assistant stopReason=error) from session files.",
						"/clean-errors              clean current session file + reload live context (default)",
						"/clean-errors help         this help",
						"/clean-errors dry          preview what would be removed (no write)",
						"/clean-errors <id-prefix>  clean another session file (no live reload)",
						"/clean-errors pattern <re> default filter on errorMessage, e.g. 503 ('' = all)",
						"/clean-errors auto on|off  auto-clean file on session_start",
						"/clean-errors status       show config",
					].join("\n"),
					"info",
				);
				return;
			}

			if (sub === "status" || sub === "show") {
				ctx.ui.notify?.(formatConfigSummary(cfg), "info");
				return;
			}

			if (sub === "auto") {
				const a = restJoined.toLowerCase();
				if (!a) {
					ctx.ui.notify?.(`autoClean=${cfg.autoClean ? "on" : "off"}`, "info");
					return;
				}
				if (a !== "on" && a !== "off") {
					ctx.ui.notify?.("Usage: /clean-errors auto <on|off>", "error");
					return;
				}
				const next = saveConfig({ autoClean: a === "on" });
				ctx.ui.notify?.(
					`session-error-clean autoClean=${next.autoClean ? "on" : "off"}${
						next.autoClean ? " (file-level; /clean-errors also reloads live context)" : ""
					}`,
					"info",
				);
				return;
			}

			if (sub === "pattern") {
				if (!restJoined) {
					ctx.ui.notify?.(`pattern: ${cfg.pattern || "(all error entries)"}`, "info");
					return;
				}
				try {
					compilePattern(restJoined);
				} catch (e) {
					ctx.ui.notify?.(`Invalid regex: ${e instanceof Error ? e.message : String(e)}`, "error");
					return;
				}
				const next = saveConfig({ pattern: restJoined });
				ctx.ui.notify?.(`session-error-clean pattern=${next.pattern || "(all error entries)"}`, "info");
				return;
			}

			if (sub === "dry") {
				const file = ctx.sessionManager.getSessionFile();
				if (!file) {
					ctx.ui.notify?.("No session file (sessions disabled)", "error");
					return;
				}
				try {
					reportOutcome(ctx, cleanFile(file, resolveFilter(), { backup: cfg.backup, dryRun: true }), "DRY RUN");
				} catch (e) {
					ctx.ui.notify?.(`Clean failed: ${e instanceof Error ? e.message : String(e)}`, "error");
				}
				return;
			}

			// Remaining forms select a file: no args / "current" (the default), an
			// id/prefix looked up under the sessions root, or an absolute path.
			let file: string | undefined;
			if (sub === "" || sub === "current") {
				file = ctx.sessionManager.getSessionFile();
				if (!file) {
					ctx.ui.notify?.("No session file (sessions disabled)", "error");
					return;
				}
			} else if (sub.startsWith("/") || sub.startsWith("~")) {
				file = sub;
			} else if (!sub.includes("/") && !sub.includes("\\")) {
				const matches = findSessionFiles(sessionsRoot(), sub);
				if (matches.length === 0) {
					ctx.ui.notify?.(`No session file matching "${sub}" under ${sessionsRoot()}`, "error");
					return;
				}
				if (matches.length > 1) {
					ctx.ui.notify?.(
						`Ambiguous id "${sub}" matches ${matches.length} files:\n${matches.map((m) => `  - ${basename(m)}`).join("\n")}`,
						"error",
					);
					return;
				}
				file = matches[0];
			}

			if (!file) {
				ctx.ui.notify?.(`Unknown subcommand: ${sub}. Try /clean-errors help`, "error");
				return;
			}

			// Current-session path: rewrite the file, then reload it into the live
			// agent so the in-memory context drops the errors too.
			const currentFile = ctx.sessionManager.getSessionFile();
			const isCurrent = currentFile !== undefined && file === currentFile;
			try {
				const outcome = cleanFile(file, resolveFilter(), { backup: cfg.backup });
				const header = isCurrent ? "Current session" : `Session ${basename(file)}`;

				// The current session was actually rewritten with removals — the only
				// case where a live reload is meaningful.
				const didCleanCurrent = isCurrent && outcome.rewritten && outcome.removed.length > 0;
				// For a live reload we defer the outcome report into `withSession` so it
				// lands in the replacement session; a notify fired right before the
				// switch can be discarded by the replacement.
				const willReload = didCleanCurrent && !!ctx.switchSession;
				if (!willReload) reportOutcome(ctx, outcome, header);
				if (!didCleanCurrent) return;

				if (ctx.switchSession) {
					// switchSession replaces the running session and invalidates this
					// `ctx`. Post-switch UI work must run inside `withSession` with the
					// fresh context; using the captured `ctx` afterwards is a stale-ctx
					// error. If the switch is cancelled, `ctx` remains valid.
					const outcomeReport = formatOutcome(outcome, header);
					const { cancelled } = await ctx.switchSession(file, {
						withSession: async (freshCtx) => {
							freshCtx.ui.notify?.(
								`${outcomeReport}\nSession reloaded from cleaned file — live context is now error-free.`,
								"info",
							);
						},
					});
					if (cancelled) {
						ctx.ui.notify?.(
							`${outcomeReport}\nSession reload cancelled; file was cleaned but live context still holds the errors.`,
							"warning",
						);
					}
				} else {
					ctx.ui.notify?.("File cleaned; start a new context (e.g. resume the session) to drop them live.", "warning");
				}
			} catch (e) {
				ctx.ui.notify?.(`Clean failed: ${e instanceof Error ? e.message : String(e)}`, "error");
			}
		},
	});
}
