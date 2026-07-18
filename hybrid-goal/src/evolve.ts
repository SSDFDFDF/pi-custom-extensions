/**
 * /goal-evol — controlled self-evolution against upstream pi-goal + MiMo-Code.
 *
 * Design:
 * - Fetch/refresh shallow clones into a local cache.
 * - Diff latest upstream goal sources against this package.
 * - Produce an evolution plan + candidate patch notes under cache/reports.
 * - Never auto-overwrite live extension sources without explicit apply + confirmation.
 * - Optional auto-apply path rewrites only this package under ~/.pi/agent/extensions/hybrid-goal.
 */

import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
	cpSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HybridGoalConfig } from "./config.js";
import { resolveEvolCacheDir } from "./config.js";
import { pruneEvolCache } from "./evol-cache.js";

export interface UpstreamSnapshot {
	repo: "pi-goal" | "mimo";
	url: string;
	commit: string;
	fetchedAt: string;
	path: string;
}

export interface EvolFileDiff {
	path: string;
	status: "added" | "removed" | "changed" | "same";
	localHash?: string;
	upstreamHash?: string;
}

export interface EvolutionReport {
	generatedAt: string;
	packageRoot: string;
	piGoal?: UpstreamSnapshot;
	mimo?: UpstreamSnapshot;
	diffs: EvolFileDiff[];
	recommendations: string[];
	applyReady: boolean;
}

const PI_GOAL_SRC_MAP: Array<{ upstream: string; local: string }> = [
	{ upstream: "extensions/pi-goal/src/goal.ts", local: "src/goal-base.ts" },
	{ upstream: "extensions/pi-goal/src/accounting.ts", local: "src/accounting.ts" },
	{ upstream: "extensions/pi-goal/src/command.ts", local: "src/command.ts" },
	{ upstream: "extensions/pi-goal/src/persistence.ts", local: "src/persistence.ts" },
];

const MIMO_GOAL_PATHS = [
	"packages/opencode/src/session/goal.ts",
	"packages/opencode/src/session/prompt.ts",
];

function sha256(content: string): string {
	return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function ensureDir(path: string) {
	mkdirSync(path, { recursive: true });
}

async function run(
	pi: ExtensionAPI,
	command: string,
	args: string[],
	options?: { cwd?: string; timeout?: number },
) {
	const result = await pi.exec(command, args, {
		cwd: options?.cwd,
		timeout: options?.timeout ?? 120_000,
	});
	return result;
}

async function ensureClone(
	pi: ExtensionAPI,
	cacheDir: string,
	name: string,
	url: string,
): Promise<UpstreamSnapshot> {
	const path = join(cacheDir, "repos", name);
	ensureDir(dirname(path));
	if (existsSync(join(path, ".git"))) {
		const fetch = await run(pi, "git", ["-C", path, "fetch", "--depth", "1", "origin", "HEAD"]);
		if (fetch.code !== 0) {
			// retry full reclone on fetch failure
			rmSync(path, { recursive: true, force: true });
		} else {
			await run(pi, "git", ["-C", path, "reset", "--hard", "FETCH_HEAD"]);
		}
	}
	if (!existsSync(join(path, ".git"))) {
		ensureDir(dirname(path));
		const clone = await run(pi, "git", [
			"clone",
			"--depth",
			"1",
			url,
			path,
		]);
		if (clone.code !== 0) {
			throw new Error(`git clone failed for ${url}: ${clone.stderr || clone.stdout}`);
		}
	}
	const rev = await run(pi, "git", ["-C", path, "rev-parse", "HEAD"]);
	if (rev.code !== 0) throw new Error(`git rev-parse failed in ${path}`);
	const commit = rev.stdout.trim();
	return {
		repo: name === "pi-extensions" ? "pi-goal" : "mimo",
		url,
		commit,
		fetchedAt: new Date().toISOString(),
		path,
	};
}

function readIfExists(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	return readFileSync(path, "utf8");
}

function collectDiffs(packageRoot: string, piSnap: UpstreamSnapshot): EvolFileDiff[] {
	const diffs: EvolFileDiff[] = [];
	for (const mapping of PI_GOAL_SRC_MAP) {
		const upPath = join(piSnap.path, mapping.upstream);
		const localPath = join(packageRoot, mapping.local);
		const up = readIfExists(upPath);
		const local = readIfExists(localPath);
		const upHash = up === undefined ? undefined : sha256(up);
		const localHash = local === undefined ? undefined : sha256(local);
		let status: EvolFileDiff["status"] = "same";
		if (up === undefined && local !== undefined) status = "removed";
		else if (up !== undefined && local === undefined) status = "added";
		else if (upHash !== localHash) status = "changed";
		diffs.push({
			path: mapping.local,
			status,
			localHash,
			upstreamHash: upHash,
		});
	}
	return diffs;
}

function buildRecommendations(
	diffs: EvolFileDiff[],
	mimoSnap: UpstreamSnapshot | undefined,
): string[] {
	const recs: string[] = [];
	const changed = diffs.filter((d) => d.status !== "same");
	if (changed.length === 0) {
		recs.push("pi-goal upstream sources match local base modules (or base snapshots).");
	} else {
		recs.push(
			`pi-goal upstream differs in ${changed.length} mapped file(s): ${changed
				.map((d) => `${d.path}(${d.status})`)
				.join(", ")}.`,
		);
		recs.push(
			"Review upstream delta carefully before apply. hybrid-goal keeps judge/evol layers outside goal-base.",
		);
	}
	if (mimoSnap) {
		const judgePresent = MIMO_GOAL_PATHS.every((p) => existsSync(join(mimoSnap.path, p)));
		recs.push(
			judgePresent
				? `MiMo goal sources present at ${mimoSnap.commit.slice(0, 12)} — re-check independent judge gate, MAX_GOAL_REACT, fail-open policy, and prompt wording.`
				: "MiMo goal source paths missing in clone; path layout may have changed — update MIMO_GOAL_PATHS.",
		);
		recs.push(
			"Preserve hybrid invariants on evol: independent judge on complete, maxReact hard cap, goal_id rotation, settled continuation, token budget wrap-up, /goal-evol safety gates.",
		);
	}
	recs.push("Apply never touches ~/.pi/agent/npm packages; only this hybrid-goal package tree.");
	recs.push("After apply: run /reload (or restart pi) so the new sources load.");
	return recs;
}

export async function runEvolutionCheck(
	pi: ExtensionAPI,
	packageRoot: string,
	config: HybridGoalConfig,
): Promise<EvolutionReport> {
	const cacheDir = resolveEvolCacheDir(packageRoot, config);
	ensureDir(cacheDir);
	ensureDir(join(cacheDir, "reports"));

	const piSnap = await ensureClone(pi, cacheDir, "pi-extensions", config.piGoalUpstream);
	const mimoSnap = await ensureClone(pi, cacheDir, "mimo-code", config.mimoUpstream);

	// Refresh goal-base snapshot for readable diffs without clobbering live hybrid layers.
	const baseDir = join(cacheDir, "upstream-snapshots", piSnap.commit.slice(0, 12));
	ensureDir(baseDir);
	for (const mapping of PI_GOAL_SRC_MAP) {
		const src = join(piSnap.path, mapping.upstream);
		if (!existsSync(src)) continue;
		const dest = join(baseDir, mapping.local);
		ensureDir(dirname(dest));
		cpSync(src, dest);
	}

	// Copy MiMo goal sources into report cache for offline review.
	const mimoDir = join(cacheDir, "upstream-snapshots", `mimo-${mimoSnap.commit.slice(0, 12)}`);
	ensureDir(mimoDir);
	for (const p of MIMO_GOAL_PATHS) {
		const src = join(mimoSnap.path, p);
		if (!existsSync(src)) continue;
		const dest = join(mimoDir, p);
		ensureDir(dirname(dest));
		cpSync(src, dest);
	}

	const diffs = collectDiffs(packageRoot, piSnap);
	const report: EvolutionReport = {
		generatedAt: new Date().toISOString(),
		packageRoot,
		piGoal: piSnap,
		mimo: mimoSnap,
		diffs,
		recommendations: buildRecommendations(diffs, mimoSnap),
		applyReady: diffs.some((d) => d.status !== "same"),
	};

	const reportPath = join(
		cacheDir,
		"reports",
		`evol-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
	);
	writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
	writeFileSync(join(cacheDir, "latest-report.json"), `${JSON.stringify(report, null, 2)}\n`);

	// Human-readable markdown plan
	const md = [
		`# hybrid-goal evolution report`,
		``,
		`Generated: ${report.generatedAt}`,
		``,
		`## Upstream`,
		`- pi-goal: ${piSnap.url} @ \`${piSnap.commit}\``,
		`- MiMo-Code: ${mimoSnap.url} @ \`${mimoSnap.commit}\``,
		``,
		`## Diffs (mapped pi-goal files)`,
		...diffs.map(
			(d) =>
				`- \`${d.path}\`: **${d.status}** (local=${d.localHash ?? "-"} upstream=${d.upstreamHash ?? "-"})`,
		),
		``,
		`## Recommendations`,
		...report.recommendations.map((r) => `- ${r}`),
		``,
		`## Next`,
		`- Review snapshots under \`${relative(packageRoot, join(cacheDir, "upstream-snapshots"))}\``,
		`- Apply carefully: \`/goal-evol apply\` (requires confirmation; rewrites base modules only)`,
		`- Then \`/reload\``,
		``,
	].join("\n");
	writeFileSync(join(cacheDir, "latest-report.md"), md);

	// Bounded cleanup after a successful check (keeps latest + recent history).
	pruneEvolCache(cacheDir, {
		keepSnapshotNames: new Set([
			piSnap.commit.slice(0, 12),
			`mimo-${mimoSnap.commit.slice(0, 12)}`,
		]),
	});

	return report;
}

export interface ApplyResult {
	ok: boolean;
	message: string;
	backedUpTo?: string;
	updated: string[];
}

/**
 * Apply upstream pi-goal base modules into this package.
 * Hybrid layers (index/judge/evolve/config/prompts) are never replaced from upstream.
 */
export async function applyEvolutionBase(
	pi: ExtensionAPI,
	packageRoot: string,
	config: HybridGoalConfig,
	options: { force?: boolean } = {},
): Promise<ApplyResult> {
	const cacheDir = resolveEvolCacheDir(packageRoot, config);
	const latestPath = join(cacheDir, "latest-report.json");
	if (!existsSync(latestPath)) {
		return {
			ok: false,
			message: "No evolution report. Run `/goal-evol check` first.",
			updated: [],
		};
	}
	const report = JSON.parse(readFileSync(latestPath, "utf8")) as EvolutionReport;
	if (!report.piGoal?.path || !existsSync(report.piGoal.path)) {
		return {
			ok: false,
			message: "Cached pi-goal clone missing. Re-run `/goal-evol check`.",
			updated: [],
		};
	}
	if (!report.applyReady && !options.force) {
		return {
			ok: false,
			message: "No upstream base changes to apply. Use `/goal-evol apply --force` to re-sync snapshots.",
			updated: [],
		};
	}

	const backupRoot = join(
		cacheDir,
		"backups",
		new Date().toISOString().replace(/[:.]/g, "-"),
	);
	ensureDir(backupRoot);
	const updated: string[] = [];

	// Protect hybrid-only files
	const hybridOnly = new Set([
		"src/index.ts",
		"src/judge.ts",
		"src/evolve.ts",
		"src/config.ts",
		"src/prompts.ts",
		"package.json",
	]);

	for (const mapping of PI_GOAL_SRC_MAP) {
		const src = join(report.piGoal.path, mapping.upstream);
		if (!existsSync(src)) continue;
		const dest = join(packageRoot, mapping.local);
		if (hybridOnly.has(mapping.local)) {
			continue;
		}
		if (existsSync(dest)) {
			const backupDest = join(backupRoot, mapping.local);
			ensureDir(dirname(backupDest));
			cpSync(dest, backupDest);
		}
		ensureDir(dirname(dest));
		cpSync(src, dest);
		updated.push(mapping.local);
	}

	writeFileSync(
		join(backupRoot, "MANIFEST.json"),
		`${JSON.stringify({ updated, fromCommit: report.piGoal.commit, at: new Date().toISOString() }, null, 2)}\n`,
	);

	const verify = verifyAppliedBase(packageRoot);
	if (!verify.ok) {
		// Roll base modules back so a bad upstream snapshot never becomes the live
		// runtime. Hybrid-only files were never written, so leave them alone.
		for (const relativePath of updated) {
			const dest = join(packageRoot, relativePath);
			const backup = join(backupRoot, relativePath);
			if (existsSync(backup)) {
				cpSync(backup, dest);
			}
		}
		return {
			ok: false,
			message: `Apply rolled back after post-verify failed. Backup: ${backupRoot}. ${verify.message}`,
			backedUpTo: backupRoot,
			updated: [],
		};
	}

	// Bound backups/reports/snapshots after a successful apply as well.
	const keepSnap = new Set<string>();
	if (report.piGoal?.commit) keepSnap.add(report.piGoal.commit.slice(0, 12));
	if (report.mimo?.commit) keepSnap.add(`mimo-${report.mimo.commit.slice(0, 12)}`);
	pruneEvolCache(cacheDir, {
		keepSnapshotNames: keepSnap.size ? keepSnap : undefined,
	});

	return {
		ok: true,
		message: `Applied ${updated.length} base file(s) from pi-goal@${report.piGoal.commit.slice(0, 12)}. Backup: ${backupRoot}. Post-verify: ${verify.message}. Hybrid layers (judge/evol/index/config/prompts) untouched. Run /reload.`,
		backedUpTo: backupRoot,
		updated,
	};
}

/**
 * Post-apply gate: run the package test suite so an upstream signature drift
 * cannot ship as a silent runtime break after /reload.
 */
function verifyAppliedBase(packageRoot: string): { ok: boolean; message: string } {
	const result = spawnSync("npm", ["test"], {
		cwd: packageRoot,
		encoding: "utf8",
		timeout: 120_000,
		env: process.env,
	});
	if (result.error) {
		return {
			ok: false,
			message: `could not run npm test: ${result.error.message}`,
		};
	}
	if (result.status === 0) {
		return { ok: true, message: "npm test passed" };
	}
	const tail = [result.stdout, result.stderr]
		.filter(Boolean)
		.join("\n")
		.split("\n")
		.slice(-20)
		.join("\n");
	return {
		ok: false,
		message: `npm test failed (exit ${result.status ?? "?"})${tail ? `:\n${tail}` : ""}`,
	};
}

export function formatReportSummary(report: EvolutionReport): string {
	const changed = report.diffs.filter((d) => d.status !== "same");
	return [
		`Evolution check @ ${report.generatedAt}`,
		`pi-goal: ${report.piGoal?.commit.slice(0, 12) ?? "?"} | MiMo: ${report.mimo?.commit.slice(0, 12) ?? "?"}`,
		`Base diffs: ${changed.length === 0 ? "none" : changed.map((d) => `${d.path}:${d.status}`).join(", ")}`,
		...report.recommendations.slice(0, 5).map((r) => `• ${r}`),
		`Report: cache/latest-report.md`,
	].join("\n");
}

export function listRecentReports(packageRoot: string, config: HybridGoalConfig, limit = 5): string[] {
	const dir = join(resolveEvolCacheDir(packageRoot, config), "reports");
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith(".json"))
		.map((f) => {
			const p = join(dir, f);
			return { f, mtime: statSync(p).mtimeMs };
		})
		.sort((a, b) => b.mtime - a.mtime)
		.slice(0, limit)
		.map((x) => x.f);
}
