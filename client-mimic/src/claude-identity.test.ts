/**
 * Run: node --loader /tmp/client-mimic-test-loader.mjs --test src/claude-identity.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	CLAUDE_CODE_CORE_BETAS,
	createDeviceId,
	isUuidV4,
	uuidV4,
} from "./claude-identity.ts";

test("uuidV4 is version 4", () => {
	const id = uuidV4();
	assert.equal(isUuidV4(id), true);
	assert.equal(id[14], "4");
});

test("createDeviceId generates 64 lowercase hex chars", () => {
	const a = createDeviceId();
	const b = createDeviceId();
	assert.match(a, /^[0-9a-f]{64}$/);
	assert.match(b, /^[0-9a-f]{64}$/);
	assert.notEqual(a, b);
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
