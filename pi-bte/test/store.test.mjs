import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BteStore, renderAgentContext } from "../src/store.ts";
import { parseBoardRef, parseListScope } from "../src/types.ts";

describe("BteStore", () => {
	it("standalone tasks work without any board", () => {
		const store = new BteStore();
		const a = store.createTask({ subject: "One" });
		const b = store.createTask({ subject: "Two", status: "in_progress" });
		assert.equal(a.ok && b.ok, true);
		assert.equal(a.task.boardId, undefined);
		assert.equal(store.listTasks().length, 2);
		assert.equal(store.listBoards().length, 0);
	});

	it("boards and tasks are independent; optional boardId links", () => {
		const store = new BteStore();
		const b = store.createBoard({ title: "Auth" });
		assert.equal(b.ok, true);
		const linked = store.createTask({ subject: "Login", boardId: b.board.id });
		const alone = store.createTask({ subject: "Misc", boardId: null });
		assert.equal(linked.ok && alone.ok, true);
		assert.equal(linked.task.boardId, b.board.id);
		assert.equal(alone.task.boardId, undefined);
		assert.equal(store.listTasks(b.board.id).length, 1);
		assert.equal(store.listTasks(null).length, 1);
		assert.equal(store.listTasks("*").length, 2);
	});

	it("createTask defaults to active board when set", () => {
		const store = new BteStore();
		const b = store.createBoard({ title: "Work" });
		assert.equal(b.ok, true);
		const t = store.createTask({ subject: "Step" });
		assert.equal(t.ok, true);
		assert.equal(t.task.boardId, b.board.id);
	});

	it("replaceChecklist rewrites only the scoped checklist", () => {
		const store = new BteStore();
		const auth = store.createBoard({ title: "Auth", activate: true });
		const ui = store.createBoard({ title: "UI", activate: false });
		assert.equal(auth.ok && ui.ok, true);
		store.replaceChecklist(
			[
				{ step: "Login", status: "completed" },
				{ step: "Tokens", status: "pending" },
			],
			"auth work",
			auth.board.id,
		);
		store.replaceChecklist(
			[{ step: "Layout", status: "in_progress" }],
			undefined,
			ui.board.id,
		);
		assert.equal(store.listTasks(auth.board.id).length, 2);
		assert.equal(store.listTasks(ui.board.id).length, 1);
	});

	it("replaceChecklist rejects empty list and multiple in_progress", () => {
		const store = new BteStore();
		assert.equal(store.replaceChecklist([]).ok, false);
		assert.equal(
			store.replaceChecklist([
				{ step: "A", status: "in_progress" },
				{ step: "B", status: "in_progress" },
			]).ok,
			false,
		);
	});

	it("replaceChecklist preserves ids and reports removedCount", () => {
		const store = new BteStore();
		const first = store.replaceChecklist([
			{ step: "Map auth", status: "completed" },
			{ step: "Add tokens", status: "pending" },
		]);
		assert.equal(first.ok, true);
		const id0 = first.tasks[0].id;
		const renamed = store.replaceChecklist([
			{ id: id0, step: "Mapped auth", status: "completed" },
			{ step: "Only this", status: "pending" },
		]);
		assert.equal(renamed.ok, true);
		assert.equal(renamed.tasks[0].id, id0);
		assert.equal(renamed.removedCount, 1);
	});

	it("each board allows its own in_progress", () => {
		const store = new BteStore();
		const a = store.createBoard({ title: "A" });
		const b = store.createBoard({ title: "B", activate: false });
		assert.equal(
			store.createTask({
				subject: "A1",
				boardId: a.board.id,
				status: "in_progress",
			}).ok,
			true,
		);
		assert.equal(
			store.createTask({
				subject: "B1",
				boardId: b.board.id,
				status: "in_progress",
			}).ok,
			true,
		);
		assert.equal(
			store.createTask({
				subject: "A2",
				boardId: a.board.id,
				status: "in_progress",
			}).ok,
			false,
		);
	});

	it("delete board detaches by default; can delete tasks", () => {
		const store = new BteStore();
		const b = store.createBoard({ title: "Temp" });
		const t = store.createTask({ subject: "Keep", boardId: b.board.id });
		store.deleteBoard(b.board.id);
		assert.equal(store.getTask(t.task.id).boardId, undefined);

		const b2 = store.createBoard({ title: "Temp2" });
		const t2 = store.createTask({ subject: "Drop", boardId: b2.board.id });
		store.deleteBoard(b2.board.id, { deleteTasks: true });
		assert.equal(store.getTask(t2.task.id), undefined);
	});

	it("switch board changes active scope", () => {
		const store = new BteStore();
		const a = store.createBoard({ title: "A" });
		const b = store.createBoard({ title: "B", activate: false });
		store.createTask({ subject: "InA", boardId: a.board.id });
		store.createTask({ subject: "InB", boardId: b.board.id });
		assert.equal(store.listTasks()[0].subject, "InA");
		store.switchBoard(b.board.id);
		assert.equal(store.listTasks()[0].subject, "InB");
		store.switchBoard(null);
		assert.equal(store.listTasks().length, 0);
		assert.equal(store.listTasks("*").length, 2);
	});

	it("can force standalone checklist while a board is active", () => {
		const store = new BteStore();
		store.createBoard({ title: "A" });
		store.createTask({ subject: "InBoard" });
		const alone = store.replaceChecklist(
			[{ step: "Solo", status: "pending" }],
			"note",
			null,
		);
		assert.equal(alone.ok, true);
		assert.equal(alone.scopeBoardId, undefined);
		assert.equal(store.listTasks(null)[0].subject, "Solo");
		assert.equal(store.getState().note, "note");
		assert.equal(store.listTasks().length, 1);
	});

	it("clearTasks rejects unknown board; keeps ids monotonic", () => {
		const store = new BteStore();
		const first = store.createTask({ subject: "X" });
		assert.equal(store.clearTasks({ scope: "b99" }).ok, false);
		const cleared = store.clearTasks({ scope: "*" });
		assert.equal(cleared.ok, true);
		assert.equal(cleared.removed, 1);
		const second = store.createTask({ subject: "Y" });
		assert.equal(second.task.id, "t2");
		assert.ok(first.ok);
	});

	it("deps unlink to undefined; getTask isolates mutation", () => {
		const store = new BteStore();
		const a = store.createTask({ subject: "A" });
		const b = store.createTask({ subject: "B", blockedBy: [a.task.id] });
		assert.equal(b.ok, true);
		store.updateTask({ taskId: a.task.id, status: "deleted" });
		assert.equal(store.getTask(b.task.id).blockedBy, undefined);
		const listed = store.listTasks();
		listed[0].subject = "hack";
		assert.notEqual(store.listTasks()[0].subject, "hack");
	});

	it("moving in_progress into busy scope is rejected", () => {
		const store = new BteStore();
		const a = store.createBoard({ title: "A" });
		const b = store.createBoard({ title: "B", activate: false });
		store.createTask({
			subject: "Busy",
			boardId: a.board.id,
			status: "in_progress",
		});
		const mover = store.createTask({
			subject: "Mover",
			boardId: b.board.id,
			status: "in_progress",
		});
		const moved = store.updateTask({
			taskId: mover.task.id,
			boardId: a.board.id,
		});
		assert.equal(moved.ok, false);
	});

	it("boardDetails full vs scoped; reconstruct keeps all scopes", () => {
		const store = new BteStore();
		const a = store.createBoard({ title: "A" });
		const b = store.createBoard({ title: "B", activate: false });
		store.createTask({ subject: "InA", boardId: a.board.id });
		store.createTask({ subject: "InB", boardId: b.board.id });
		store.createTask({ subject: "Solo", boardId: null });
		const details = store.boardDetails({ kind: "task", action: "list" });
		assert.equal(details.tasks.length, 3);
		assert.equal(details.scopedTasks.length, 1);

		const restored = new BteStore();
		restored.reconstructFromSession({
			sessionManager: {
				getBranch: () => [
					{
						type: "message",
						message: {
							role: "toolResult",
							toolName: "task",
							details,
						},
					},
				],
			},
		});
		assert.equal(restored.listTasks("*").length, 3);
	});

	it("persist skips identical snapshots; reset allows rewrite", () => {
		const store = new BteStore();
		let writes = 0;
		store.setPersist(() => {
			writes += 1;
		});
		store.createTask({ subject: "One" });
		assert.equal(writes, 1);
		store.createTask({ subject: "Two" });
		assert.equal(writes, 2);
		store.resetRuntimeCaches();
		store.createBoard({ title: "P" });
		assert.equal(writes, 3);
	});

	it("getState returns a clone (mutations do not leak)", () => {
		const store = new BteStore();
		store.createTask({ subject: "Live" });
		const snap = store.getState();
		snap.tasks[0].subject = "Hacked";
		assert.equal(store.listTasks()[0].subject, "Live");
	});

	it("standalone note does not bleed into active board explanation", () => {
		const store = new BteStore();
		store.replaceChecklist([{ step: "Solo", status: "pending" }], "solo-note", null);
		store.createBoard({ title: "Auth" });
		// Board is active; board has no note — must not show solo-note.
		const details = store.boardDetails();
		assert.equal(details.explanation, undefined);
		const ctx = renderAgentContext(store.getState());
		assert.doesNotMatch(ctx, /solo-note/);
		// Standalone scope still keeps the note in state.
		assert.equal(store.getState().note, "solo-note");
	});

	it("createTask rejects list-only board tokens", () => {
		const store = new BteStore();
		const bad = store.createTask({ subject: "X", boardId: "*" });
		assert.equal(bad.ok, false);
		assert.match(bad.error, /list\/clear/i);
	});
});

describe("renderAgentContext", () => {
	it("task-first copy and standalone note", () => {
		const store = new BteStore();
		store.replaceChecklist([{ step: "Only", status: "pending" }], "hello");
		const ctx = renderAgentContext(store.getState());
		assert.match(ctx, /Prefer task/i);
		assert.match(ctx, /Note: hello/);
	});

	it("flags in_progress outside active board", () => {
		const store = new BteStore();
		const a = store.createBoard({ title: "Auth" });
		const b = store.createBoard({ title: "UI", activate: false });
		store.createTask({
			subject: "UI work",
			boardId: b.board.id,
			status: "in_progress",
		});
		store.createTask({ subject: "Auth todo", boardId: a.board.id });
		const ctx = renderAgentContext(store.getState());
		assert.match(ctx, /Active outside current scope/);
	});
});

describe("parsers", () => {
	it("parseBoardRef / parseListScope", () => {
		assert.equal(parseBoardRef(undefined), undefined);
		assert.equal(parseBoardRef(""), null);
		assert.equal(parseBoardRef("standalone"), null);
		assert.equal(parseBoardRef("b2"), "b2");
		assert.equal(parseListScope("*"), "*");
		assert.equal(parseListScope("all"), "*");
		assert.equal(parseListScope("none"), null);
	});
});
