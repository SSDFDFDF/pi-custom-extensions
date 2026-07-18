import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { pruneEvolCache, MAX_EVOL_BACKUP_DIRS, MAX_EVOL_REPORT_FILES, MAX_EVOL_SNAPSHOT_DIRS } =
	await import(pathToFileURL(join(root, "src/evol-cache.ts")).href);

function touchDir(parent, name) {
	const path = join(parent, name);
	mkdirSync(path, { recursive: true });
	writeFileSync(join(path, "marker"), name);
	return path;
}

function touchFile(parent, name) {
	const path = join(parent, name);
	writeFileSync(path, name);
	return path;
}

test("pruneEvolCache keeps newest snapshots/reports/backups within caps", async () => {
	const cacheDir = mkdtempSync(join(tmpdir(), "hybrid-goal-evol-cache-"));
	const snaps = join(cacheDir, "upstream-snapshots");
	const reports = join(cacheDir, "reports");
	const backups = join(cacheDir, "backups");
	mkdirSync(snaps, { recursive: true });
	mkdirSync(reports, { recursive: true });
	mkdirSync(backups, { recursive: true });

	// Create more than the caps, with staggered mtimes.
	for (let i = 0; i < MAX_EVOL_SNAPSHOT_DIRS + 3; i++) {
		touchDir(snaps, `snap-${i}`);
		await sleep(5);
	}
	// Protected current snapshot should survive even if older than some.
	touchDir(snaps, "keep-me");
	await sleep(5);
	for (let i = 0; i < MAX_EVOL_REPORT_FILES + 4; i++) {
		touchFile(reports, `evol-${String(i).padStart(2, "0")}.json`);
		await sleep(5);
	}
	// latest-report lives outside reports/ and must never be touched by prune of reports/
	writeFileSync(join(cacheDir, "latest-report.json"), "{}");
	writeFileSync(join(cacheDir, "latest-report.md"), "ok");
	for (let i = 0; i < MAX_EVOL_BACKUP_DIRS + 2; i++) {
		touchDir(backups, `backup-${i}`);
		await sleep(5);
	}

	const result = pruneEvolCache(cacheDir, {
		keepSnapshotNames: new Set(["keep-me"]),
	});
	assert.ok(result.removed.length > 0);

	const snapNames = readdirSync(snaps);
	assert.ok(snapNames.includes("keep-me"));
	// keep-me + up to MAX newest others
	assert.ok(snapNames.length <= MAX_EVOL_SNAPSHOT_DIRS + 1);

	const reportNames = readdirSync(reports).filter((n) => n.endsWith(".json"));
	assert.equal(reportNames.length, MAX_EVOL_REPORT_FILES);
	assert.ok(readdirSync(cacheDir).includes("latest-report.json"));
	assert.ok(readdirSync(cacheDir).includes("latest-report.md"));

	const backupNames = readdirSync(backups);
	assert.equal(backupNames.length, MAX_EVOL_BACKUP_DIRS);
});
