import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ensureClaudeMetadata,
	hasLeadingBillingHeader,
	mergeBetaFlags,
	prependClaudeBillingSystem,
} from "./claude-body.ts";

test("ensureClaudeMetadata injects user_id once", () => {
	const payload: Record<string, unknown> = {};
	assert.equal(ensureClaudeMetadata(payload, "dev", "sess"), true);
	const meta = payload.metadata as { user_id: string };
	const parsed = JSON.parse(meta.user_id);
	assert.equal(parsed.device_id, "dev");
	assert.equal(parsed.session_id, "sess");
	assert.equal(parsed.account_uuid, "");
	assert.equal(ensureClaudeMetadata(payload, "other", "x"), false);
});

test("mergeBetaFlags unions without dupes", () => {
	assert.equal(
		mergeBetaFlags("a,b", "b,c"),
		"a,b,c",
	);
});

test("prependClaudeBillingSystem adds leading billing block", () => {
	const payload: Record<string, unknown> = { system: "hello" };
	assert.equal(prependClaudeBillingSystem(payload, "2.1.198"), true);
	const sys = payload.system as Array<{ type: string; text: string }>;
	assert.ok(sys[0].text.startsWith("x-anthropic-billing-header:"));
	assert.ok(sys[0].text.includes("cc_version=2.1.198"));
	assert.ok(sys[0].text.includes("cc_entrypoint=cli"));
	assert.ok(sys[1].text.includes("Claude Agent SDK"));
	// second call no-op
	assert.equal(prependClaudeBillingSystem(payload, "2.1.198"), false);
});

test("hasLeadingBillingHeader requires leading position", () => {
	assert.equal(hasLeadingBillingHeader("x-anthropic-billing-header: x"), true);
	assert.equal(hasLeadingBillingHeader("note: x-anthropic-billing-header: x"), false);
	assert.equal(
		hasLeadingBillingHeader([{ type: "text", text: "x-anthropic-billing-header: x" }]),
		true,
	);
});
