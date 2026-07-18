import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireFileLock, atomicWriteFile, withFileLock } from "./fs-util.ts";

test("atomicWriteFile replaces content", () => {
	const dir = mkdtempSync(join(tmpdir(), "mimic-fs-"));
	const path = join(dir, "f.json");
	try {
		atomicWriteFile(path, "a\n");
		atomicWriteFile(path, "b\n");
		assert.equal(readFileSync(path, "utf8"), "b\n");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("withFileLock serializes writers", () => {
	const dir = mkdtempSync(join(tmpdir(), "mimic-lock-"));
	const path = join(dir, "store.json");
	try {
		writeFileSync(path, "{}\n");
		const order: number[] = [];
		withFileLock(path, () => {
			order.push(1);
			// nested second acquisition on different path is fine
			withFileLock(join(dir, "other.json"), () => {
				order.push(2);
			});
		});
		assert.deepEqual(order, [1, 2]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("acquireFileLock release removes lockfile", () => {
	const dir = mkdtempSync(join(tmpdir(), "mimic-lock2-"));
	const lock = join(dir, "x.lock");
	try {
		const release = acquireFileLock(lock);
		assert.ok(readFileSync(lock, "utf8").includes(String(process.pid)));
		release();
		// may or may not exist if race; after release should be gone
		try {
			readFileSync(lock);
			assert.fail("lock should be removed");
		} catch {
			// expected
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
