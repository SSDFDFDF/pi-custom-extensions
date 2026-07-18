import assert from "node:assert/strict";
import test from "node:test";
import {
	assistantUsageTokens,
	cumulativeAssistantTokens,
	cumulativeGoalBillableTokens,
	currentTokenTotal,
	goalBillableUsageTokens,
	updateGoalUsage,
} from "../src/accounting.ts";

function branchFromUsages(usages) {
	return usages.map((usage) => ({
		type: "message",
		message: { role: "assistant", usage },
	}));
}

test("goalBillableUsageTokens counts non-cached input + output only", () => {
	assert.equal(
		goalBillableUsageTokens({
			input: 1000,
			output: 50,
			cacheRead: 800,
			cacheWrite: 0,
			totalTokens: 1850,
		}),
		250,
	);
	assert.equal(
		goalBillableUsageTokens({
			input: 100,
			output: 20,
			cacheRead: 500,
			cacheWrite: 0,
		}),
		20,
	);
	assert.equal(goalBillableUsageTokens(null), 0);
	assert.equal(goalBillableUsageTokens({}), 0);
	assert.equal(
		goalBillableUsageTokens({ totalTokens: 9999, input: 0, output: 0, cacheRead: 0 }),
		0,
		"billable ignores totalTokens-only usage",
	);
});

test("assistantUsageTokens still prefers totalTokens / full sum", () => {
	assert.equal(
		assistantUsageTokens({
			input: 1000,
			output: 50,
			cacheRead: 800,
			cacheWrite: 0,
			totalTokens: 1850,
		}),
		1850,
	);
	assert.equal(
		assistantUsageTokens({
			input: 10,
			output: 5,
			cacheRead: 3,
			cacheWrite: 2,
		}),
		20,
	);
});

test("currentTokenTotal uses goal-billable cumulative tokens", () => {
	const branch = branchFromUsages([
		{ input: 1000, output: 10, cacheRead: 900, cacheWrite: 0, totalTokens: 1910 },
		{ input: 200, output: 30, cacheRead: 50, cacheWrite: 0, totalTokens: 280 },
	]);
	assert.equal(cumulativeAssistantTokens(branch), 1910 + 280);
	assert.equal(cumulativeGoalBillableTokens(branch), 110 + 180);
	assert.equal(currentTokenTotal({ sessionManager: { getBranch: () => branch } }), 290);
});

test("updateGoalUsage is monotonic across compact (no budget refill)", () => {
	const goal = {
		status: "active",
		baselineTokens: 0,
		lastAccountedBillable: 0,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		updatedAt: 0,
	};

	// Growth: 100 billable
	let branch = branchFromUsages([
		{ input: 80, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 100 },
	]);
	updateGoalUsage(goal, { sessionManager: { getBranch: () => branch } }, false);
	assert.equal(goal.tokensUsed, 100);
	assert.equal(goal.lastAccountedBillable, 100);

	// More growth: +50
	branch = branchFromUsages([
		{ input: 80, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 100 },
		{ input: 40, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 50 },
	]);
	updateGoalUsage(goal, { sessionManager: { getBranch: () => branch } }, false);
	assert.equal(goal.tokensUsed, 150);
	assert.equal(goal.lastAccountedBillable, 150);

	// Compact shrinks branch to 30 billable — tokensUsed must NOT drop
	branch = branchFromUsages([
		{ input: 20, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 30 },
	]);
	updateGoalUsage(goal, { sessionManager: { getBranch: () => branch } }, false);
	assert.equal(goal.tokensUsed, 150, "compact must not refill budget");
	assert.equal(goal.lastAccountedBillable, 30);

	// Post-compact new spend +20
	branch = branchFromUsages([
		{ input: 20, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 30 },
		{ input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20 },
	]);
	updateGoalUsage(goal, { sessionManager: { getBranch: () => branch } }, false);
	assert.equal(goal.tokensUsed, 170);
	assert.equal(goal.lastAccountedBillable, 50);
});

test("legacy goals without lastAccountedBillable reconstruct watermark", () => {
	const goal = {
		status: "active",
		baselineTokens: 100,
		// no lastAccountedBillable
		tokensUsed: 50,
		timeUsedSeconds: 0,
		updatedAt: 0,
	};
	// Live branch still at baseline+used = 150 billable
	const branch = branchFromUsages([
		{ input: 140, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 150 },
	]);
	updateGoalUsage(goal, { sessionManager: { getBranch: () => branch } }, false);
	// watermark reconstructed to 150; total 150 → no double-count
	assert.equal(goal.tokensUsed, 50);
	assert.equal(goal.lastAccountedBillable, 150);
});

test("baseline larger than total yields zero growth and keeps spend", () => {
	const goal = {
		status: "active",
		baselineTokens: 200,
		lastAccountedBillable: 200,
		tokensUsed: 40,
		timeUsedSeconds: 0,
		updatedAt: 0,
	};
	const branch = branchFromUsages([
		{ input: 50, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 60 },
	]);
	updateGoalUsage(goal, { sessionManager: { getBranch: () => branch } }, false);
	assert.equal(goal.tokensUsed, 40);
	assert.equal(goal.lastAccountedBillable, 60);
});
