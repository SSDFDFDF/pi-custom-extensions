import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	PI_MAX_WIDGET_LINES,
	formatBoardHeaderPlain,
	formatWidgetMoreLine,
	planWidgetLayout,
	selectWidgetTasks,
	widgetTaskCapacity,
} from "../src/ui.ts";
import { emptyState } from "../src/types.ts";

function task(id, status, boardId) {
	return {
		id,
		subject: id,
		status,
		boardId,
		createdAt: 0,
		updatedAt: 0,
	};
}

function stateWith(boards, tasks, activeBoardId) {
	const s = emptyState(0);
	s.boards = boards.map((b) => ({
		id: b.id,
		title: b.title,
		createdAt: 0,
		updatedAt: 0,
	}));
	s.tasks = tasks;
	s.activeBoardId = activeBoardId;
	s.nextBoardSeq = boards.length + 1;
	s.nextTaskSeq = tasks.length + 1;
	return s;
}

describe("widget layout", () => {
	it("capacity is 10 minus header", () => {
		assert.equal(widgetTaskCapacity(false), 10);
		assert.equal(widgetTaskCapacity(true), 9);
	});

	it("no boards → no header", () => {
		const st = stateWith([], [task("t1", "pending")], undefined);
		const { headerPlain } = planWidgetLayout(st);
		assert.equal(headerPlain, undefined);
	});

	it("active board header; multi-board on one line", () => {
		const one = stateWith(
			[{ id: "b1", title: "Auth" }],
			[task("t1", "pending", "b1")],
			"b1",
		);
		assert.equal(formatBoardHeaderPlain(one), "board: b1 Auth");

		const multi = stateWith(
			[
				{ id: "b1", title: "Auth" },
				{ id: "b2", title: "UI" },
			],
			[task("t1", "pending", "b1")],
			"b1",
		);
		const h = formatBoardHeaderPlain(multi);
		assert.match(h, /board: b1 Auth/);
		assert.match(h, /\+1 board/);
	});

	it("fits → all tasks, normal order, no footer", () => {
		const tasks = [
			task("t1", "completed"),
			task("t2", "pending"),
			task("t3", "in_progress"),
		];
		const sel = selectWidgetTasks(tasks, 10);
		assert.deepEqual(
			sel.shown.map((t) => t.id),
			["t1", "t2", "t3"],
		);
		assert.equal(sel.hidden.length, 0);
	});

	it("over → squeeze finished first; open keep order", () => {
		const tasks = [
			task("t1", "completed"),
			task("t2", "pending"),
			task("t3", "in_progress"),
			task("t4", "completed"),
			task("t5", "pending"),
		];
		const sel = selectWidgetTasks(tasks, 4);
		assert.deepEqual(
			sel.shown.map((t) => t.id),
			["t2", "t3", "t5"],
		);
		assert.ok(sel.hidden.every((t) => t.status === "completed"));
	});

	it("finished fill keeps large ids", () => {
		const tasks = [
			task("t1", "completed"),
			task("t2", "completed"),
			task("t3", "pending"),
			task("t4", "completed"),
			task("t5", "completed"),
		];
		const sel = selectWidgetTasks(tasks, 4);
		assert.deepEqual(
			sel.shown.map((t) => t.id),
			["t3", "t4", "t5"],
		);
		assert.deepEqual(
			sel.hidden.map((t) => t.id),
			["t1", "t2"],
		);
	});

	it("open overflow drops tail", () => {
		const tasks = [
			task("t1", "pending"),
			task("t2", "in_progress"),
			task("t3", "pending"),
			task("t4", "pending"),
			task("t5", "completed"),
		];
		const sel = selectWidgetTasks(tasks, 3);
		assert.deepEqual(
			sel.shown.map((t) => t.id),
			["t1", "t2"],
		);
	});

	it("footer says not shown, not more", () => {
		const sel = selectWidgetTasks(
			[
				task("t1", "pending"),
				task("t2", "completed"),
				task("t3", "completed"),
			],
			2,
		);
		const line = formatWidgetMoreLine(sel);
		assert.match(line, /not shown/i);
		assert.doesNotMatch(line, /\bmore\b/i);
	});

	it("plan with board + many tasks stays within Pi budget", () => {
		const tasks = Array.from({ length: 15 }, (_, i) =>
			task(`t${i + 1}`, i < 4 ? "pending" : "completed", "b1"),
		);
		const st = stateWith([{ id: "b1", title: "Work" }], tasks, "b1");
		const { headerPlain, selection } = planWidgetLayout(st);
		assert.ok(headerPlain);
		const lines =
			1 + selection.shown.length + (selection.hidden.length > 0 ? 1 : 0);
		assert.ok(lines <= PI_MAX_WIDGET_LINES);
		assert.ok(selection.shown.some((t) => t.id === "t1"));
	});
});
