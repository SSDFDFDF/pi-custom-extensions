import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PteStore } from "../src/store.ts";

describe("PteStore", () => {
	it("updatePlan rejects multiple in_progress", () => {
		const store = new PteStore();
		const result = store.updatePlan([
			{ step: "A", status: "in_progress" },
			{ step: "B", status: "in_progress" },
		]);
		assert.equal(result.ok, false);
		assert.match(result.error, /in_progress/i);
	});

	it("updatePlan replaces checklist and preserves subject ids", () => {
		const store = new PteStore();
		const first = store.updatePlan([
			{ step: "Map auth", status: "completed" },
			{ step: "Add tokens", status: "pending" },
		]);
		assert.equal(first.ok, true);
		const id0 = first.tasks[0].id;
		const second = store.updatePlan([
			{ step: "Map auth", status: "completed" },
			{ step: "Add tokens", status: "in_progress" },
			{ step: "Tests", status: "pending" },
		]);
		assert.equal(second.ok, true);
		assert.equal(second.tasks[0].id, id0);
		assert.equal(second.tasks.length, 3);
	});

	it("createTask allocates sequential ids", () => {
		const store = new PteStore();
		const a = store.createTask({ subject: "One" });
		const b = store.createTask({ subject: "Two" });
		assert.equal(a.ok, true);
		assert.equal(b.ok, true);
		assert.equal(a.task.id, "t1");
		assert.equal(b.task.id, "t2");
	});

	it("createTask enforces single in_progress", () => {
		const store = new PteStore();
		assert.equal(store.createTask({ subject: "A", status: "in_progress" }).ok, true);
		const r = store.createTask({ subject: "B", status: "in_progress" });
		assert.equal(r.ok, false);
	});

	it("updateTask can delete and unlinks deps", () => {
		const store = new PteStore();
		const a = store.createTask({ subject: "A" });
		const b = store.createTask({
			subject: "B",
			blockedBy: [a.task.id],
		});
		assert.equal(a.ok && b.ok, true);
		const del = store.updateTask({ taskId: a.task.id, status: "deleted" });
		assert.equal(del.ok, true);
		assert.equal(store.getTask(a.task.id), undefined);
		const remaining = store.getTask(b.task.id);
		assert.ok(remaining);
		assert.equal((remaining.blockedBy ?? []).includes(a.task.id), false);
	});

	it("rejected update is atomic", () => {
		const store = new PteStore();
		const active = store.createTask({ subject: "Active", status: "in_progress" });
		const pending = store.createTask({ subject: "Original" });
		assert.equal(active.ok && pending.ok, true);
		const result = store.updateTask({
			taskId: pending.task.id,
			subject: "Must not leak",
			status: "in_progress",
		});
		assert.equal(result.ok, false);
		assert.equal(store.getTask(pending.task.id).subject, "Original");
	});

	it("full replace prunes dependencies to omitted tasks", () => {
		const store = new PteStore();
		const first = store.createTask({ subject: "First" });
		const second = store.createTask({ subject: "Second", blockedBy: [first.task.id] });
		assert.equal(first.ok && second.ok, true);
		const result = store.updatePlan([{ step: "Second", status: "pending" }]);
		assert.equal(result.ok, true);
		assert.deepEqual(result.tasks[0].blockedBy, undefined);
	});

	it("duplicate subjects preserve ids by occurrence", () => {
		const store = new PteStore();
		const first = store.updatePlan([
			{ step: "Same", status: "pending" },
			{ step: "Same", status: "pending" },
		]);
		assert.equal(first.ok, true);
		const ids = first.tasks.map((task) => task.id);
		const second = store.updatePlan([
			{ step: "Same", status: "completed" },
			{ step: "Same", status: "in_progress" },
		]);
		assert.equal(second.ok, true);
		assert.deepEqual(second.tasks.map((task) => task.id), ids);
	});

	it("reconstruction normalizes malformed sequence and honors newest snapshot", () => {
		const store = new PteStore();
		const oldTask = {
			id: "t9",
			subject: "Old",
			status: "pending",
			createdAt: 1,
			updatedAt: 1,
		};
		const newTask = { ...oldTask, id: "t12", subject: "New" };
		store.reconstructFromSession({
			sessionManager: {
				getBranch: () => [
					{
						type: "custom",
						customType: "pte-state",
						data: { tasks: [oldTask], nextTaskSeq: Infinity },
					},
					{
						type: "message",
						message: {
							role: "toolResult",
							toolName: "task",
							details: { kind: "task", tasks: [newTask], nextTaskSeq: Number.NaN },
						},
					},
				],
			},
		});
		assert.equal(store.listTasks()[0].subject, "New");
		assert.equal(store.getState().nextTaskSeq, 13);
		const created = store.createTask({ subject: "After restore" });
		assert.equal(created.ok, true);
		assert.equal(created.task.id, "t13");
	});

	it("rejects dangling and self dependencies", () => {
		const store = new PteStore();
		const missing = store.createTask({ subject: "Bad", blockedBy: ["t99"] });
		assert.equal(missing.ok, false);
		const task = store.createTask({ subject: "Good" });
		assert.equal(task.ok, true);
		const self = store.updateTask({ taskId: task.task.id, addBlocks: [task.task.id] });
		assert.equal(self.ok, false);
		assert.deepEqual(store.getTask(task.task.id).blocks, undefined);
	});

	it("reconstruction clears plan docs explicitly and repairs multiple active tasks", () => {
		const store = new PteStore();
		const task = (id, subject) => ({
			id,
			subject,
			status: "in_progress",
			blocks: [id, "t99"],
			blockedBy: [id, "t99"],
			createdAt: 1,
			updatedAt: 1,
		});
		store.reconstructFromSession({
			sessionManager: {
				getBranch: () => [
					{
						type: "custom",
						customType: "pte-state",
						data: {
							tasks: [task("t1", "One")],
							nextTaskSeq: 2,
							planDoc: { title: "Old", body: "stale", updatedAt: 1 },
						},
					},
					{
						type: "message",
						message: {
							role: "toolResult",
							toolName: "plan_doc",
							details: {
								kind: "plan_doc",
								action: "clear",
								tasks: [task("t1", "One"), task("t2", "Two")],
								nextTaskSeq: 3,
								planDocCleared: true,
							},
						},
					},
				],
			},
		});
		assert.equal(store.getState().planDoc, undefined);
		assert.deepEqual(
			store.listTasks().map((item) => item.status),
			["in_progress", "pending"],
		);
		for (const item of store.listTasks()) {
			assert.equal(item.blocks, undefined);
			assert.equal(item.blockedBy, undefined);
		}
	});

	it("persist skips identical consecutive snapshots", () => {
		const store = new PteStore();
		let writes = 0;
		store.setPersist(() => {
			writes += 1;
		});
		store.createTask({ subject: "One" });
		assert.equal(writes, 1);
		// Force another persist path with no logical board change by re-setting plan doc undefined.
		store.setPlanDoc(undefined);
		assert.equal(writes, 1);
		store.createTask({ subject: "Two" });
		assert.equal(writes, 2);
	});

	it("resetRuntimeCaches allows the next identical board to persist again", () => {
		const store = new PteStore();
		let writes = 0;
		store.setPersist(() => {
			writes += 1;
		});
		store.createTask({ subject: "One" });
		assert.equal(writes, 1);
		store.resetRuntimeCaches();
		store.setPlanDoc(undefined);
		assert.equal(writes, 2);
	});

	it("clearTasks keeps ids monotonic", () => {
		const store = new PteStore();
		const first = store.createTask({ subject: "X" });
		assert.equal(first.ok, true);
		store.clearTasks();
		assert.equal(store.listTasks().length, 0);
		const second = store.createTask({ subject: "Y" });
		assert.equal(second.ok, true);
		assert.equal(second.task.id, "t2");
	});
});
