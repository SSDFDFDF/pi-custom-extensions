import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderAgentContext } from "../src/agent-context.ts";
import { BteStore } from "../src/store.ts";
import { parseBoardRef, parseListScope } from "../src/types.ts";

describe("BteStore", () => {
	it("standalone tasks work without any board", () => {
		const store = new BteStore();
		const r = store.createTasks({
			items: [
				{ subject: "One" },
				{ subject: "Two", status: "in_progress" },
			],
		});
		assert.equal(r.ok, true);
		assert.equal(r.tasks[0].boardId, undefined);
		assert.equal(store.listTasks().length, 2);
		assert.equal(store.listBoards().length, 0);
	});

	it("boards and tasks are independent; optional boardId links", () => {
		const store = new BteStore();
		const b = store.createBoard({ title: "Auth" });
		assert.equal(b.ok, true);
		const linked = store.createTasks({
			items: [{ subject: "Login" }],
			boardId: b.board.id,
		});
		const alone = store.createTasks({
			items: [{ subject: "Misc" }],
			boardId: null,
		});
		assert.equal(linked.ok && alone.ok, true);
		assert.equal(linked.tasks[0].boardId, b.board.id);
		assert.equal(alone.tasks[0].boardId, undefined);
		assert.equal(store.listTasks(b.board.id).length, 1);
		assert.equal(store.listTasks(null).length, 1);
		assert.equal(store.listTasks("*").length, 2);
	});

	it("createTasks defaults to active board when set", () => {
		const store = new BteStore();
		const b = store.createBoard({ title: "Work" });
		assert.equal(b.ok, true);
		const t = store.createTasks({ items: [{ subject: "Step" }] });
		assert.equal(t.ok, true);
		assert.equal(t.tasks[0].boardId, b.board.id);
	});

	it("each board allows its own in_progress", () => {
		const store = new BteStore();
		const a = store.createBoard({ title: "A" });
		const b = store.createBoard({ title: "B", activate: false });
		assert.equal(
			store.createTasks({
				items: [{ subject: "A1", status: "in_progress" }],
				boardId: a.board.id,
			}).ok,
			true,
		);
		assert.equal(
			store.createTasks({
				items: [{ subject: "B1", status: "in_progress" }],
				boardId: b.board.id,
			}).ok,
			true,
		);
		assert.equal(
			store.createTasks({
				items: [{ subject: "A2", status: "in_progress" }],
				boardId: a.board.id,
			}).ok,
			false,
		);
	});

	it("delete board detaches by default; can delete tasks", () => {
		const store = new BteStore();
		const b = store.createBoard({ title: "Temp" });
		const t = store.createTasks({
			items: [{ subject: "Keep" }],
			boardId: b.board.id,
		});
		store.deleteBoard(b.board.id);
		assert.equal(store.getTask(t.tasks[0].id).boardId, undefined);

		const b2 = store.createBoard({ title: "Temp2" });
		const t2 = store.createTasks({
			items: [{ subject: "Drop" }],
			boardId: b2.board.id,
		});
		store.deleteBoard(b2.board.id, { deleteTasks: true });
		assert.equal(store.getTask(t2.tasks[0].id), undefined);
	});

	it("switch board changes active scope", () => {
		const store = new BteStore();
		const a = store.createBoard({ title: "A" });
		const b = store.createBoard({ title: "B", activate: false });
		store.createTasks({ items: [{ subject: "InA" }], boardId: a.board.id });
		store.createTasks({ items: [{ subject: "InB" }], boardId: b.board.id });
		assert.equal(store.listTasks()[0].subject, "InA");
		store.switchBoard(b.board.id);
		assert.equal(store.listTasks()[0].subject, "InB");
		store.switchBoard(null);
		assert.equal(store.listTasks().length, 0);
		assert.equal(store.listTasks("*").length, 2);
	});

	it("clearTasks rejects unknown board; keeps ids monotonic", () => {
		const store = new BteStore();
		const first = store.createTasks({ items: [{ subject: "X" }] });
		assert.equal(store.clearTasks({ scope: "b99" }).ok, false);
		const cleared = store.clearTasks({ scope: "*" });
		assert.equal(cleared.ok, true);
		assert.equal(cleared.removed, 1);
		const second = store.createTasks({ items: [{ subject: "Y" }] });
		assert.equal(second.tasks[0].id, "t2");
		assert.ok(first.ok);
	});

	it("deps unlink to undefined; getTask isolates mutation", () => {
		const store = new BteStore();
		const a = store.createTasks({ items: [{ subject: "A" }] });
		const b = store.createTasks({
			items: [{ subject: "B", blockedBy: [a.tasks[0].id] }],
		});
		assert.equal(b.ok, true);
		store.updateTasks({
			items: [{ taskId: a.tasks[0].id, status: "deleted" }],
		});
		assert.equal(store.getTask(b.tasks[0].id).blockedBy, undefined);
		const listed = store.listTasks();
		listed[0].subject = "hack";
		assert.notEqual(store.listTasks()[0].subject, "hack");
	});

	it("moving in_progress into busy scope is rejected", () => {
		const store = new BteStore();
		const a = store.createBoard({ title: "A" });
		const b = store.createBoard({ title: "B", activate: false });
		store.createTasks({
			items: [{ subject: "Busy", status: "in_progress" }],
			boardId: a.board.id,
		});
		const mover = store.createTasks({
			items: [{ subject: "Mover", status: "in_progress" }],
			boardId: b.board.id,
		});
		const moved = store.updateTasks({
			items: [{ taskId: mover.tasks[0].id, boardId: a.board.id }],
		});
		assert.equal(moved.ok, false);
	});

	it("boardDetails full vs scoped; reconstruct keeps all scopes", () => {
		const store = new BteStore();
		const a = store.createBoard({ title: "A" });
		const b = store.createBoard({ title: "B", activate: false });
		store.createTasks({ items: [{ subject: "InA" }], boardId: a.board.id });
		store.createTasks({ items: [{ subject: "InB" }], boardId: b.board.id });
		store.createTasks({ items: [{ subject: "Solo" }], boardId: null });
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
		store.createTasks({ items: [{ subject: "One" }] });
		assert.equal(writes, 1);
		store.createTasks({ items: [{ subject: "Two" }] });
		assert.equal(writes, 2);
		store.resetRuntimeCaches();
		store.createBoard({ title: "P" });
		assert.equal(writes, 3);
	});

	it("getState returns a clone (mutations do not leak)", () => {
		const store = new BteStore();
		store.createTasks({ items: [{ subject: "Live" }] });
		const snap = store.getState();
		snap.tasks[0].subject = "Hacked";
		assert.equal(store.listTasks()[0].subject, "Live");
	});

	it("updateTasks status=deleted removes the task", () => {
		const store = new BteStore();
		const c = store.createTasks({
			items: [{ subject: "A" }, { subject: "B" }],
		});
		const [a, b] = c.tasks;
		const r = store.updateTasks({ items: [{ taskId: a.id, status: "deleted" }] });
		assert.equal(r.ok, true);
		assert.equal(store.getTask(a.id), undefined);
		assert.equal(store.getTask(b.id).subject, "B");
		assert.equal(store.listTasks().length, 1);
	});

	it("clearTasks wipes the active scope only", () => {
		const store = new BteStore();
		const a = store.createBoard({ title: "A" });
		const b = store.createBoard({ title: "B", activate: false });
		store.createTasks({ items: [{ subject: "InA" }], boardId: a.board.id });
		store.createTasks({ items: [{ subject: "InB" }], boardId: b.board.id });
		const r = store.clearTasks({ scope: a.board.id });
		assert.equal(r.ok, true);
		assert.equal(r.removed, 1);
		assert.equal(store.listTasks(a.board.id).length, 0);
		assert.equal(store.listTasks(b.board.id).length, 1);
	});

	it("createTasks rejects list-only board tokens", () => {
		const store = new BteStore();
		const bad = store.createTasks({ items: [{ subject: "X" }], boardId: "*" });
		assert.equal(bad.ok, false);
		assert.match(bad.error, /list\/clear/i);
	});

	it("createTasks batch append keeps existing tasks", () => {
		const store = new BteStore();
		store.createTasks({ items: [{ subject: "Keep" }] });
		const more = store.createTasks({
			items: [{ subject: "A" }, { subject: "B" }],
		});
		assert.equal(more.ok, true);
		assert.equal(store.listTasks().length, 3);
	});

	it("updateTasks can patch multiple and is all-or-nothing", () => {
		const store = new BteStore();
		const created = store.createTasks({
			items: [{ subject: "A" }, { subject: "B" }, { subject: "C" }],
		});
		const [a, b, c] = created.tasks;
		const ok = store.updateTasks({
			items: [
				{ taskId: a.id, status: "completed" },
				{ taskId: b.id, status: "in_progress" },
			],
		});
		assert.equal(ok.ok, true);
		assert.equal(store.getTask(a.id).status, "completed");
		assert.equal(store.getTask(b.id).status, "in_progress");
		assert.equal(store.getTask(c.id).status, "pending");

		const bad = store.updateTasks({
			items: [
				{ taskId: a.id, status: "pending" },
				{ taskId: "t999", status: "completed" },
			],
		});
		assert.equal(bad.ok, false);
		// first item not applied
		assert.equal(store.getTask(a.id).status, "completed");
	});

	it("createTasks rejects empty items", () => {
		const store = new BteStore();
		assert.equal(store.createTasks({ items: [] }).ok, false);
	});

	it("createTasks rejects two in_progress in one batch", () => {
		const store = new BteStore();
		const bad = store.createTasks({
			items: [
				{ subject: "A", status: "in_progress" },
				{ subject: "B", status: "in_progress" },
			],
		});
		assert.equal(bad.ok, false);
		assert.equal(store.listTasks().length, 0);
	});

	it("createTasks rejects unknown dependency", () => {
		const store = new BteStore();
		const bad = store.createTasks({
			items: [{ subject: "B", blockedBy: ["t99"] }],
		});
		assert.equal(bad.ok, false);
	});

	it("updateTasks rejects two in_progress in same scope", () => {
		const store = new BteStore();
		const c = store.createTasks({
			items: [{ subject: "A" }, { subject: "B" }],
		});
		const bad = store.updateTasks({
			items: [
				{ taskId: c.tasks[0].id, status: "in_progress" },
				{ taskId: c.tasks[1].id, status: "in_progress" },
			],
		});
		assert.equal(bad.ok, false);
		assert.equal(store.getTask(c.tasks[0].id).status, "pending");
		assert.equal(store.getTask(c.tasks[1].id).status, "pending");
	});

});

describe("renderAgentContext", () => {
	it("task-first copy in agent context", () => {
		const store = new BteStore();
		store.createTasks({ items: [{ subject: "Only", status: "pending" }] });
		const ctx = renderAgentContext(store.getState());
		assert.match(ctx, /items\[\]/i);
	});

	it("flags in_progress outside active board", () => {
		const store = new BteStore();
		const a = store.createBoard({ title: "Auth" });
		const b = store.createBoard({ title: "UI", activate: false });
		store.createTasks({
			items: [{ subject: "UI work", status: "in_progress" }],
			boardId: b.board.id,
		});
		store.createTasks({
			items: [{ subject: "Auth todo" }],
			boardId: a.board.id,
		});
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
