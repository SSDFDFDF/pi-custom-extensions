/**
 * Run: node --experimental-strip-types --test src/claude-identity.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	CLAUDE_CODE_CORE_BETAS,
	hashDeviceId,
	isUuidV4,
	loadOrCreateDeviceId,
	resolveClaudeSessionId,
	uuidV4,
} from "./claude-identity.ts";

test("uuidV4 is version 4", () => {
	const id = uuidV4();
	assert.equal(isUuidV4(id), true);
	assert.equal(id[14], "4");
});

test("resolveClaudeSessionId keeps pi v4", () => {
	const v4 = uuidV4();
	assert.equal(resolveClaudeSessionId(v4), v4);
});

test("resolveClaudeSessionId maps pi v7 stably", () => {
	const dir = mkdtempSync(join(tmpdir(), "mimic-claude-"));
	const prev = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		const piV7 = "019f7285-cf6f-7428-947e-9ebb00085b55";
		const a = resolveClaudeSessionId(piV7);
		const b = resolveClaudeSessionId(piV7);
		assert.equal(isUuidV4(a), true);
		assert.equal(a, b);
		assert.notEqual(a, piV7);
	} finally {
		if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prev;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("device_id is 64 hex and persisted", () => {
	const dir = mkdtempSync(join(tmpdir(), "mimic-dev-"));
	const path = join(dir, "client-mimic.device_id");
	try {
		const a = loadOrCreateDeviceId(path);
		const b = loadOrCreateDeviceId(path);
		assert.equal(/^[0-9a-f]{64}$/.test(a), true);
		assert.equal(a, b);
		assert.equal(readFileSync(path, "utf8").trim(), a);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("hashDeviceId is deterministic", () => {
	assert.equal(hashDeviceId("seed"), hashDeviceId("seed"));
	assert.equal(hashDeviceId("seed").length, 64);
});

test("core betas include identity flags from telemetry", () => {
	for (const flag of [
		"claude-code-20250219",
		"interleaved-thinking-2025-05-14",
		"context-management-2025-06-27",
		"prompt-caching-scope-2026-01-05",
		"mid-conversation-system-2026-04-07",
		"effort-2025-11-24",
	]) {
		assert.ok(CLAUDE_CODE_CORE_BETAS.includes(flag), flag);
	}
});
