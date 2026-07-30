import assert from "node:assert/strict";
import { test } from "node:test";
import {
	clampConstantDelayMs,
	formatDelay,
	MAX_CONSTANT_DELAY_MS,
	MAX_EXPONENT,
	MIN_CONSTANT_DELAY_MS,
	parseConstantDelayMs,
	planConstantRetry,
} from "../src/retry-patch.ts";

/** Reproduces Pi's own formula from AgentSession._prepareRetry. */
function piDelay(retryAttemptAfterIncrement, baseDelayMs) {
	return baseDelayMs * 2 ** (retryAttemptAfterIncrement - 1);
}

test("scaled base delay makes Pi's formula land on the constant target", () => {
	const target = 5_000;
	let retryAttempt = 0;
	let cumulative = 0;

	for (let i = 1; i <= 40; i++) {
		const plan = planConstantRetry(retryAttempt, cumulative, 1_000_000, target);
		assert.equal(plan.exhausted, false);
		assert.equal(plan.cumulative, i, `attempt ${i} cumulative`);

		if (plan.resetRetryAttempt) retryAttempt = 0;
		retryAttempt++; // Pi increments before computing the delay.
		assert.equal(piDelay(retryAttempt, plan.scaledBaseDelayMs), target, `attempt ${i} delay`);
		cumulative = plan.cumulative;
	}
});

test("exponent rewind keeps the delay exact past MAX_EXPONENT", () => {
	const target = 5_000;
	// Walk in at the rewind boundary instead of looping 1000 times.
	const plan = planConstantRetry(MAX_EXPONENT, 1_234, 1_000_000, target);
	assert.equal(plan.exhausted, false);
	assert.equal(plan.resetRetryAttempt, true);
	assert.equal(plan.exponent, 0);
	assert.equal(plan.cumulative, 1_235, "cumulative survives the rewind");
	assert.equal(piDelay(1, plan.scaledBaseDelayMs), target);
});

test("just below the rewind boundary stays exact and finite", () => {
	const target = 3_600_000;
	const plan = planConstantRetry(MAX_EXPONENT - 1, 10, 1_000_000, target);
	assert.equal(plan.resetRetryAttempt, false);
	assert.equal(plan.exponent, MAX_EXPONENT - 1);
	assert.ok(Number.isFinite(plan.scaledBaseDelayMs));
	assert.ok(plan.scaledBaseDelayMs > 0, "no underflow to zero");
	assert.equal(piDelay(MAX_EXPONENT, plan.scaledBaseDelayMs), target);
});

test("retryAttempt 0 restarts the cumulative counter", () => {
	// Pi zeroes _retryAttempt after a successful turn; the next failure is attempt 1.
	const plan = planConstantRetry(0, 7, 10, 2_000);
	assert.equal(plan.cumulative, 1);
	assert.equal(plan.exhausted, false);
});

test("budget is enforced on the cumulative count, not Pi's counter", () => {
	const maxRetries = 3;
	let retryAttempt = 0;
	let cumulative = 0;

	for (let i = 1; i <= maxRetries; i++) {
		const plan = planConstantRetry(retryAttempt, cumulative, maxRetries, 1_000);
		assert.equal(plan.exhausted, false, `attempt ${i} allowed`);
		cumulative = plan.cumulative;
		retryAttempt++;
	}

	const exhausted = planConstantRetry(retryAttempt, cumulative, maxRetries, 1_000);
	assert.equal(exhausted.exhausted, true);
	assert.equal(exhausted.cumulative, maxRetries, "does not count the refused attempt");
});

test("maxRetries 0 refuses immediately", () => {
	const plan = planConstantRetry(0, 0, 0, 1_000);
	assert.equal(plan.exhausted, true);
	assert.equal(plan.cumulative, 0);
});

test("clampConstantDelayMs bounds and floors", () => {
	assert.equal(clampConstantDelayMs(0), MIN_CONSTANT_DELAY_MS);
	assert.equal(clampConstantDelayMs(-5), MIN_CONSTANT_DELAY_MS);
	assert.equal(clampConstantDelayMs(1_500.9), 1_500);
	assert.equal(clampConstantDelayMs(999_999_999), MAX_CONSTANT_DELAY_MS);
	assert.equal(clampConstantDelayMs(Number.NaN), MIN_CONSTANT_DELAY_MS);
	assert.equal(clampConstantDelayMs(Number.POSITIVE_INFINITY), MIN_CONSTANT_DELAY_MS);
});

test("parseConstantDelayMs accepts ms/s/m and off forms", () => {
	assert.equal(parseConstantDelayMs("5000"), 5000);
	assert.equal(parseConstantDelayMs("5s"), 5000);
	assert.equal(parseConstantDelayMs("1500ms"), 1500);
	assert.equal(parseConstantDelayMs("2m"), 120_000);
	assert.equal(parseConstantDelayMs("1.5s"), 1500);
	assert.equal(parseConstantDelayMs("off"), 0);
	assert.equal(parseConstantDelayMs("OFF"), 0);
	assert.equal(parseConstantDelayMs("0"), 0);
	assert.equal(parseConstantDelayMs("false"), 0);
	assert.equal(parseConstantDelayMs(""), undefined);
	assert.equal(parseConstantDelayMs("abc"), undefined);
	assert.equal(parseConstantDelayMs("5h"), undefined);
});

test("formatDelay is readable", () => {
	assert.equal(formatDelay(500), "500ms");
	assert.equal(formatDelay(1_500), "1500ms");
	assert.equal(formatDelay(5_000), "5s");
	assert.equal(formatDelay(120_000), "2m");
});
