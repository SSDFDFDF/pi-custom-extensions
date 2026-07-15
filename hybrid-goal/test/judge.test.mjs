import assert from "node:assert/strict";
import test from "node:test";

// Pure helpers mirrored from src/judge.ts / src/config.ts for Node test runner
// (Pi loads .ts via jiti; plain node --test does not resolve .ts .js imports).

function parseJudgeVerdictText(text) {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	const candidates = [trimmed];
	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
	if (fenced?.[1]) candidates.unshift(fenced[1].trim());
	const firstBrace = trimmed.indexOf("{");
	const lastBrace = trimmed.lastIndexOf("}");
	if (firstBrace >= 0 && lastBrace > firstBrace) {
		candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
	}
	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(candidate);
			if (typeof parsed.ok !== "boolean") continue;
			const reason =
				typeof parsed.reason === "string" && parsed.reason.trim()
					? parsed.reason.trim()
					: parsed.ok
						? "condition satisfied"
						: "condition not satisfied";
			return {
				ok: parsed.ok,
				impossible: parsed.impossible === true,
				reason: reason.slice(0, 4_000),
			};
		} catch {
			// next
		}
	}
	return undefined;
}

function shouldAllowCompletionOnJudgeError(verdict, policy) {
	if (!verdict.error) return verdict.ok;
	return policy === "fail-open";
}

function normalizeConfig(raw = {}) {
	const DEFAULT = {
		judgeEnabled: true,
		judgeFailPolicy: "fail-closed",
		judgeModel: "",
		maxReact: 12,
		maxContinuations: 0,
		neverBlock: false,
		judgeTranscriptChars: 120_000,
	};
	const base = { ...DEFAULT, ...raw };
	const maxReact = Number(base.maxReact);
	const maxContinuations = Number(base.maxContinuations);
	return {
		...base,
		judgeEnabled: base.judgeEnabled !== false,
		judgeFailPolicy: base.judgeFailPolicy === "fail-open" ? "fail-open" : "fail-closed",
		maxReact:
			Number.isFinite(maxReact) && maxReact >= 1
				? Math.min(Math.floor(maxReact), 100)
				: DEFAULT.maxReact,
		maxContinuations:
			Number.isFinite(maxContinuations) && maxContinuations >= 0
				? Math.min(Math.floor(maxContinuations), 100_000)
				: DEFAULT.maxContinuations,
		neverBlock: base.neverBlock === true,
	};
}

// Mirrors the block-vs-continue decision in goal.ts requestContinuation +
// judge gate. Returns "block" | "continue".
function continuationDecision(config, continuationCount) {
	if (config.neverBlock) return "continue";
	if (config.maxContinuations > 0 && continuationCount >= config.maxContinuations) {
		return "block";
	}
	return "continue";
}

function judgeRejectDecision(config, judgeRejectCount, impossible) {
	if (config.neverBlock) return "continue";
	if (impossible) return "block";
	if (judgeRejectCount >= config.maxReact) return "block";
	return "continue";
}

function parseModelRef(ref) {
	const trimmed = ref.trim();
	if (!trimmed) return undefined;
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash === trimmed.length - 1) return undefined;
	return { provider: trimmed.slice(0, slash), modelId: trimmed.slice(slash + 1) };
}

test("parseJudgeVerdictText accepts raw JSON", () => {
	const v = parseJudgeVerdictText('{"ok": true, "reason": "tests passed in transcript"}');
	assert.equal(v?.ok, true);
	assert.match(v?.reason ?? "", /tests passed/);
});

test("parseJudgeVerdictText accepts fenced JSON", () => {
	const v = parseJudgeVerdictText('```json\n{"ok": false, "reason": "no test output"}\n```');
	assert.equal(v?.ok, false);
	assert.match(v?.reason ?? "", /no test/);
});

test("parseJudgeVerdictText accepts impossible", () => {
	const v = parseJudgeVerdictText(
		'{"ok": false, "impossible": true, "reason": "requires private API key not available"}',
	);
	assert.equal(v?.ok, false);
	assert.equal(v?.impossible, true);
});

test("parseJudgeVerdictText rejects garbage", () => {
	assert.equal(parseJudgeVerdictText("not json"), undefined);
});

test("shouldAllowCompletionOnJudgeError respects policy", () => {
	const err = { ok: false, error: true, reason: "timeout" };
	assert.equal(shouldAllowCompletionOnJudgeError(err, "fail-open"), true);
	assert.equal(shouldAllowCompletionOnJudgeError(err, "fail-closed"), false);
	assert.equal(shouldAllowCompletionOnJudgeError({ ok: true, reason: "x" }, "fail-closed"), true);
	assert.equal(shouldAllowCompletionOnJudgeError({ ok: false, reason: "x" }, "fail-closed"), false);
});

test("normalizeConfig clamps maxReact and defaults", () => {
	const c = normalizeConfig({ maxReact: 0, judgeFailPolicy: "nope" });
	assert.equal(c.maxReact, 12);
	assert.equal(c.judgeFailPolicy, "fail-closed");
	assert.equal(c.judgeEnabled, true);
});

test("parseModelRef", () => {
	assert.deepEqual(parseModelRef("grok/grok-4.5"), { provider: "grok", modelId: "grok-4.5" });
	assert.equal(parseModelRef("noshift"), undefined);
});

test("normalizeConfig maxContinuations defaults to unlimited (0) and clamps", () => {
	assert.equal(normalizeConfig({}).maxContinuations, 0);
	assert.equal(normalizeConfig({ maxContinuations: 50 }).maxContinuations, 50);
	assert.equal(normalizeConfig({ maxContinuations: -5 }).maxContinuations, 0);
	assert.equal(normalizeConfig({ maxContinuations: 999_999 }).maxContinuations, 100_000);
});

test("normalizeConfig neverBlock is strict boolean", () => {
	assert.equal(normalizeConfig({}).neverBlock, false);
	assert.equal(normalizeConfig({ neverBlock: true }).neverBlock, true);
	assert.equal(normalizeConfig({ neverBlock: "yes" }).neverBlock, false);
});

test("continuationDecision: unlimited by default, capped when set, never blocks under neverBlock", () => {
	const unlimited = normalizeConfig({});
	assert.equal(continuationDecision(unlimited, 9999), "continue");
	const capped = normalizeConfig({ maxContinuations: 3 });
	assert.equal(continuationDecision(capped, 2), "continue");
	assert.equal(continuationDecision(capped, 3), "block");
	const nb = normalizeConfig({ maxContinuations: 3, neverBlock: true });
	assert.equal(continuationDecision(nb, 9999), "continue");
});

test("judgeRejectDecision: maxReact + impossible block, neverBlock overrides both", () => {
	const cfg = normalizeConfig({ maxReact: 3 });
	assert.equal(judgeRejectDecision(cfg, 1, false), "continue");
	assert.equal(judgeRejectDecision(cfg, 3, false), "block");
	assert.equal(judgeRejectDecision(cfg, 1, true), "block");
	const nb = normalizeConfig({ maxReact: 3, neverBlock: true });
	assert.equal(judgeRejectDecision(nb, 9999, true), "continue");
});
