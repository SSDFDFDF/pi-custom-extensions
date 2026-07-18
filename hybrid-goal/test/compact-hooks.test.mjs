import assert from "node:assert/strict";
import test from "node:test";
import {
	isOverTokenBudget,
	planAfterCompactAction,
	shouldCancelCompactionForGoal,
	shouldDeferContinuationForContext,
	shouldGiveUpAutoCompactRetries,
} from "../src/compact-policy.ts";

test("compact policy matrix", () => {
	// cancel compact
	assert.equal(shouldCancelCompactionForGoal("active", true), false);
	assert.equal(shouldCancelCompactionForGoal("budget_limited", false), false);
	assert.equal(shouldCancelCompactionForGoal("budget_limited", true), true);

	// after compact
	assert.equal(
		planAfterCompactAction({ status: "active", overBudget: true, wasPiRetry: false }),
		"budget_stop",
	);
	assert.equal(
		planAfterCompactAction({ status: "active", overBudget: false, wasPiRetry: true }),
		"pi_retry",
	);
	assert.equal(
		planAfterCompactAction({ status: "active", overBudget: false, wasPiRetry: false }),
		"continue",
	);
	assert.equal(
		planAfterCompactAction({ status: "paused", overBudget: false, wasPiRetry: false }),
		"refresh_only",
	);

	// budget
	assert.equal(isOverTokenBudget(10, 10), true);
	assert.equal(isOverTokenBudget(9, 10), false);
	assert.equal(isOverTokenBudget(1, undefined), false);

	// defer continue
	assert.equal(shouldDeferContinuationForContext({ percent: 95, thresholdPercent: 95 }), true);
	assert.equal(shouldDeferContinuationForContext({ percent: 94, thresholdPercent: 95 }), false);
	assert.equal(shouldDeferContinuationForContext({ percent: null, thresholdPercent: 95 }), false);
	assert.equal(shouldDeferContinuationForContext({ percent: 99, thresholdPercent: 0 }), false);

	// compact fail give-up
	assert.equal(shouldGiveUpAutoCompactRetries(1), false);
	assert.equal(shouldGiveUpAutoCompactRetries(2), true);
});
