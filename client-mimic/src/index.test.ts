import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import clientMimic from "./index.ts";

test("codex-lite leaves non-Responses request bodies untouched", () => {
	const dir = mkdtempSync(join(tmpdir(), "client-mimic-lite-hook-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;

	try {
		writeFileSync(
			join(dir, "client-mimic.config.json"),
			`${JSON.stringify({ enabled: true, active: "codex-lite", systemPrompt: { mode: "off" } }, null, 2)}\n`,
		);

		const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
		const pi = {
			registerFlag() {},
			registerCommand() {},
			getFlag() {
				return undefined;
			},
			on(event: string, handler: (event: any, ctx: any) => unknown) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
		} as unknown as ExtensionAPI;

		clientMimic(pi);
		const rewrite = handlers.get("before_provider_request")?.[0];
		assert.ok(rewrite);

		const anthropicPayload = {
			model: "claude-opus-4-1",
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 1024,
		};
		assert.equal(rewrite({ payload: anthropicPayload }, {}), undefined);
		assert.deepEqual(anthropicPayload, {
			model: "claude-opus-4-1",
			messages: [{ role: "user", content: "hello" }],
			max_tokens: 1024,
		});

		const responsesResult = rewrite({ payload: { input: [], tools: [] } }, {}) as Record<string, unknown>;
		assert.equal(typeof responsesResult.prompt_cache_key, "string");
		assert.ok(responsesResult.client_metadata);
		assert.equal("tools" in responsesResult, false);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(dir, { recursive: true, force: true });
	}
});
