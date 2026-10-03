import { test } from "node:test";
import assert from "node:assert/strict";
import { applyClaudeCodeBodyPatch, type ClaudeCodeWrapOptions } from "./claude-cc-body-fix.ts";
import { createClaudeCodeStreamSimpleWrapper, type WrapperOptions } from "./provider-wrap.ts";
import { DEFAULT_PROFILES } from "./config.ts";

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

test("wrapper snapshots identity per call, sees resets on the next call, and passes through when off", async () => {
	const optionsFor = (sessionId: string): WrapperOptions => ({
		...baseOpts,
		sessionId,
		deviceId: `device-${sessionId}`,
		forceIdentity: true,
		profile: DEFAULT_PROFILES["claude-code"],
		templateContext: { version: baseOpts.version, sessionId, uuid: () => "random" },
	});
	let active: WrapperOptions | null = optionsFor("old-session");
	const calls: any[] = [];
	const delegate = ((_model: unknown, _context: unknown, options: unknown) => {
		calls.push(options);
		return options;
	}) as any;
	const wrapper = createClaudeCodeStreamSimpleWrapper(() => active, delegate);
	const originalOptions = {
		headers: { "user-agent": "pi", "Anthropic-Beta": "existing-beta" },
		onPayload: async (payload: any) => ({ ...payload, preserved: true, metadata: { user_id: "stale" } }),
	};
	wrapper({}, {}, originalOptions);
	active = optionsFor("new-session");
	wrapper({}, {}, originalOptions);
	assert.equal(calls[0].headers["X-Claude-Code-Session-Id"], "old-session");
	assert.equal(calls[1].headers["X-Claude-Code-Session-Id"], "new-session");
	assert.equal(calls[1].headers["user-agent"], null);
	assert.equal(calls[1].headers["Anthropic-Beta"], null);
	assert.ok(calls[1].headers["anthropic-beta"].startsWith("existing-beta,"));
	for (const [index, sessionId] of ["old-session", "new-session"].entries()) {
		const payload = await calls[index].onPayload({}, {});
		assert.equal(payload.preserved, true);
		assert.equal(JSON.parse(payload.metadata.user_id).session_id, sessionId);
		assert.equal(JSON.parse(payload.metadata.user_id).device_id, `device-${sessionId}`);
	}
	// Compaction has no pre-existing onPayload and must still receive fresh IDs.
	wrapper({}, {}, {});
	const compact = await calls[2].onPayload({}, {});
	assert.equal(JSON.parse(compact.metadata.user_id).session_id, "new-session");
	assert.equal(compact.thinking.type, "adaptive");
	active = null;
	wrapper({}, {}, originalOptions);
	assert.equal(calls[3], originalOptions);
	assert.deepEqual(originalOptions.headers, { "user-agent": "pi", "Anthropic-Beta": "existing-beta" });
});
