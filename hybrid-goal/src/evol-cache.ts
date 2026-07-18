/**
 * Bounded cleanup for hybrid-goal /goal-evol cache directories.
 * Pure filesystem helpers — no Pi runtime imports.
 */

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** Keep a bounded evol cache so repeated check/apply cannot grow forever. */
export const MAX_EVOL_SNAPSHOT_DIRS = 3;
export const MAX_EVOL_REPORT_FILES = 10;
export const MAX_EVOL_BACKUP_DIRS = 5;

/**
 * Prune evol cache directories to fixed caps.
 * - upstream-snapshots: keep newest MAX_EVOL_SNAPSHOT_DIRS (+ any keepSnapshotNames)
 * - reports: keep newest MAX_EVOL_REPORT_FILES (never touch latest-report.*)
 * - backups: keep newest MAX_EVOL_BACKUP_DIRS
 * - repos/: kept (shallow clones reused for speed)
 */
export function pruneEvolCache(
	cacheDir: string,
	options?: { keepSnapshotNames?: Set<string> },
): { removed: string[] } {
	const removed: string[] = [];
	if (!existsSync(cacheDir)) return { removed };

	const snapshotsDir = join(cacheDir, "upstream-snapshots");
	if (existsSync(snapshotsDir)) {
		removed.push(
			...pruneOldestChildren(snapshotsDir, MAX_EVOL_SNAPSHOT_DIRS, {
				keepNames: options?.keepSnapshotNames,
				directoriesOnly: true,
			}),
		);
	}

	const reportsDir = join(cacheDir, "reports");
	if (existsSync(reportsDir)) {
		removed.push(
			...pruneOldestChildren(reportsDir, MAX_EVOL_REPORT_FILES, {
				nameFilter: (name) => name.startsWith("evol-") && name.endsWith(".json"),
			}),
		);
	}

	const backupsDir = join(cacheDir, "backups");
	if (existsSync(backupsDir)) {
		removed.push(
			...pruneOldestChildren(backupsDir, MAX_EVOL_BACKUP_DIRS, {
				directoriesOnly: true,
			}),
		);
	}

	return { removed };
}

export function pruneOldestChildren(
	parentDir: string,
	keep: number,
	options?: {
		keepNames?: Set<string>;
		directoriesOnly?: boolean;
		nameFilter?: (name: string) => boolean;
	},
): string[] {
	const removed: string[] = [];
	let entries: string[];
	try {
		entries = readdirSync(parentDir);
	} catch {
		return removed;
	}

	const scored: Array<{ name: string; path: string; mtime: number }> = [];
	for (const name of entries) {
		if (options?.nameFilter && !options.nameFilter(name)) continue;
		if (options?.keepNames?.has(name)) continue;
		const full = join(parentDir, name);
		let st;
		try {
			st = statSync(full);
		} catch {
			continue;
		}
		if (options?.directoriesOnly && !st.isDirectory()) continue;
		if (!options?.directoriesOnly && st.isDirectory()) continue;
		scored.push({ name, path: full, mtime: st.mtimeMs });
	}

	scored.sort((a, b) => b.mtime - a.mtime);
	const drop = scored.slice(Math.max(0, keep));
	for (const item of drop) {
		try {
			rmSync(item.path, { recursive: true, force: true });
			removed.push(item.path);
		} catch {
			/* best-effort */
		}
	}
	return removed;
}
