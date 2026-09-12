import { test } from "node:test";
import assert from "node:assert/strict";
import { applyClaudeCodeBodyPatch, type ClaudeCodeWrapOptions } from "./claude-cc-body-fix.ts";

const baseOpts: ClaudeCodeWrapOptions = {
	deviceId: "dev-123",
	sessionId: "sess-abc",
	ensureMetadataUserId: true,
	prependBillingSystem: true,
	version: "2.1.198",
	enforceThinkingIdentity: true,
};

test("injects output_config when thinking is disabled (compaction with thinkingLevel=off)", () => {
	// Simulate what buildParams produces when thinkingEnabled=false and
	// model.thinkingLevelMap.off !== null: a disabled thinking block, no
	// output_config. This is the exact compaction failure shape.
	const params = {
		model: "claude-opus-5-thinking",
		messages: [],
		max_tokens: 8192,
		stream: true,
		system: [{ type: "text", text: "Summarize the conversation." }],
		thinking: { type: "disabled" },
	};
	const out = applyClaudeCodeBodyPatch(params, baseOpts);
	assert.ok(out, "should return a patched object");
	assert.equal((out as { thinking: { type: string } }).thinking.type, "adaptive");
	assert.deepEqual((out as { output_config: unknown }).output_config, { effort: "high" });
	// metadata.user_id should be set
	assert.match(
		(out as { metadata: { user_id: string } }).metadata.user_id,
		/"device_id":"dev-123"/,
	);
});

test("injects both thinking and output_config when neither present", () => {
	const params = {
		model: "claude-opus-5-thinking",
		messages: [],
		max_tokens: 8192,
		stream: true,
	};
	const out = applyClaudeCodeBodyPatch(params, baseOpts);
	assert.ok(out);
	assert.equal((out as { thinking: { type: string } }).thinking.type, "adaptive");
	assert.deepEqual((out as { output_config: unknown }).output_config, { effort: "high" });
});

test("does not overwrite existing output_config", () => {
	const params = {
		model: "claude-opus-5-thinking",
		messages: [],
		max_tokens: 8192,
		stream: true,
		thinking: { type: "adaptive", display: "summarized" },
		output_config: { effort: "max" },
	};
	const out = applyClaudeCodeBodyPatch(params, baseOpts);
	// out may be undefined if nothing else changed, but thinking+output_config
	// must be untouched. metadata/billing will change it though.
	if (out) {
		assert.deepEqual((out as { output_config: unknown }).output_config, { effort: "max" });
		assert.deepEqual((out as { thinking: unknown }).thinking, {
			type: "adaptive",
			display: "summarized",
		});
	} else {
		// nothing changed — fine, but then originals are intact by definition
		assert.deepEqual(params.output_config, { effort: "max" });
	}
});

test("prepends billing system block only once", () => {
	const params = {
		model: "claude-opus-5-thinking",
		messages: [],
		max_tokens: 8192,
		stream: true,
		system: "You are helpful.",
		thinking: { type: "adaptive", display: "summarized" },
		output_config: { effort: "high" },
	};
	const first = applyClaudeCodeBodyPatch(params, baseOpts);
	assert.ok(first);
	const sys = (first as { system: unknown }).system;
	assert.ok(Array.isArray(sys), "system should become an array");
	// First block is the billing header
	assert.match(
		(sys as Array<{ text: string }>)[0].text,
		/x-anthropic-billing-header: cc_version=2\.1\.198/,
	);
	// Running again on the patched result should be a no-op for billing
	const second = applyClaudeCodeBodyPatch(first as Record<string, unknown>, baseOpts);
	// metadata is already set, billing already present, thinking+output_config present
	// → should return undefined (no changes)
	assert.equal(second, undefined);
});

test("leaves payload unchanged when disabled flags are all off", () => {
	const opts: ClaudeCodeWrapOptions = {
		...baseOpts,
		ensureMetadataUserId: false,
		prependBillingSystem: false,
		enforceThinkingIdentity: false,
	};
	const params = {
		model: "claude-opus-5-thinking",
		messages: [],
		max_tokens: 8192,
		stream: true,
		thinking: { type: "disabled" },
	};
	const out = applyClaudeCodeBodyPatch(params, opts);
	assert.equal(out, undefined);
});

test("preserves existing metadata.user_id", () => {
	const params = {
		model: "claude-opus-5-thinking",
		messages: [],
		max_tokens: 8192,
		stream: true,
		metadata: { user_id: '{"device_id":"existing","account_uuid":"","session_id":"s"}' },
		thinking: { type: "adaptive" },
		output_config: { effort: "high" },
	};
	const out = applyClaudeCodeBodyPatch(params, baseOpts);
	// user_id should not be overwritten; but billing may still prepend → may change
	if (out) {
		assert.equal(
			(out as { metadata: { user_id: string } }).metadata.user_id,
			params.metadata.user_id,
		);
	}
});
