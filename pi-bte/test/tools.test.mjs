import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BteStore } from "../src/store.ts";
import { registerTools } from "../src/tools.ts";

function captureTools() {
	const tools = new Map();
	const pi = {
		registerTool(def) {
			tools.set(def.name, def);
		},
	};
	const store = new BteStore();
	registerTools(pi, store, () => {});
	return { tools, store };
}

function theme() {
	return {
		fg: (_c, t) => String(t),
		bold: (t) => String(t),
	};
}

describe("registerTools", () => {
	it("registers board, task, board_doc only", () => {
		const { tools } = captureTools();
		assert.deepEqual([...tools.keys()].sort(), ["board", "board_doc", "task"]);
	});

	it("task-first naming; items[] create/update", () => {
		const { tools } = captureTools();
		assert.match(tools.get("task").promptSnippet, /items\[\]/i);
		assert.match(tools.get("board").promptSnippet, /advanced|Optional/i);
		assert.match(tools.get("task").description, /update/i);
		assert.match(tools.get("task").description, /items\[\]/i);
		assert.doesNotMatch(tools.get("task").description, /replace/i);
	});

	it("board switch requires boardId; empty clears", async () => {
		const { tools, store } = captureTools();
		const missing = await tools.get("board").execute("1", { action: "switch" });
		assert.equal(missing.isError, true);
		await tools.get("board").execute("2", { action: "create", title: "A" });
		assert.ok(store.getState().activeBoardId);
		const cleared = await tools.get("board").execute("3", {
			action: "switch",
			boardId: "",
		});
		assert.equal(cleared.isError, undefined);
		assert.equal(store.getState().activeBoardId, undefined);
	});

	it("task-only happy path with batch create/update", async () => {
		const { tools, store } = captureTools();
		const created = await tools.get("task").execute("1", {
			action: "create",
			items: [{ subject: "Step one" }, { subject: "Step two" }],
		});
		assert.match(created.content[0].text, /Created 2/);
		const ids = [...created.content[0].text.matchAll(/(t\d+)/g)].map((m) => m[1]);
		const idA = ids[0];
		const idB = ids[1];
		await tools.get("task").execute("2", {
			action: "update",
			items: [
				{ taskId: idA, status: "completed" },
				{ taskId: idB, status: "in_progress" },
			],
		});
		assert.equal(store.getTask(idA).status, "completed");
		assert.equal(store.getTask(idB).status, "in_progress");
	});

	it("update status=deleted removes a task via the tool", async () => {
		const { tools, store } = captureTools();
		const created = await tools.get("task").execute("1", {
			action: "create",
			items: [{ subject: "Keep" }, { subject: "Drop" }],
		});
		const ids = [...created.content[0].text.matchAll(/(t\d+)/g)].map((m) => m[1]);
		const res = await tools.get("task").execute("2", {
			action: "update",
			items: [{ taskId: ids[1], status: "deleted" }],
		});
		assert.equal(res.isError, undefined);
		assert.equal(store.listTasks("*").length, 1);
		assert.equal(store.listTasks("*")[0].subject, "Keep");
	});

	it("clear wipes scope via the tool", async () => {
		const { tools, store } = captureTools();
		await tools.get("task").execute("1", {
			action: "create",
			items: [{ subject: "A" }, { subject: "B" }],
		});
		const res = await tools.get("task").execute("2", { action: "clear" });
		assert.equal(res.isError, undefined);
		assert.match(res.content[0].text, /Cleared 2/);
		assert.equal(store.listTasks("*").length, 0);
	});

	it("task clear unknown board errors", async () => {
		const { tools } = captureTools();
		const result = await tools.get("task").execute("1", {
			action: "clear",
			boardId: "b99",
		});
		assert.equal(result.isError, true);
	});

	it("task create boardId=* explains list/clear only", async () => {
		const { tools } = captureTools();
		const result = await tools.get("task").execute("1", {
			action: "create",
			items: [{ subject: "Nope" }],
			boardId: "*",
		});
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /list\/clear/i);
	});

	it("task list details.scopedTasks match listed scope", async () => {
		const { tools, store } = captureTools();
		const a = store.createBoard({ title: "A" });
		const b = store.createBoard({ title: "B", activate: false });
		store.createTasks({ items: [{ subject: "InA" }], boardId: a.board.id });
		store.createTasks({ items: [{ subject: "InB" }], boardId: b.board.id });
		const listed = await tools.get("task").execute("1", {
			action: "list",
			boardId: b.board.id,
		});
		assert.equal(listed.details.scopedTasks.length, 1);
		assert.equal(listed.details.scopedTasks[0].subject, "InB");
		assert.equal(listed.details.focusBoardId, b.board.id);
		// Full board still present for reconstruction.
		assert.equal(listed.details.tasks.length, 2);
	});

	it("board_doc get unknown board is error", async () => {
		const { tools } = captureTools();
		const result = await tools.get("board_doc").execute("1", {
			action: "get",
			boardId: "b99",
		});
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /not found/i);
	});

	it("get accepts taskIds array", async () => {
		const { tools, store } = captureTools();
		const c = store.createTasks({
			items: [{ subject: "A" }, { subject: "B" }],
		});
		const result = await tools.get("task").execute("1", {
			action: "get",
			taskIds: [c.tasks[0].id, c.tasks[1].id],
		});
		assert.equal(result.isError, undefined);
		const parsed = JSON.parse(result.content[0].text);
		assert.equal(parsed.length, 2);
	});

	it("create with taskId-shaped items errors helpfully", async () => {
		const { tools } = captureTools();
		const result = await tools.get("task").execute("1", {
			action: "create",
			items: [{ taskId: "t1", status: "completed" }],
		});
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /action=update|taskId/i);
	});

	it("update with subject-only items points to create", async () => {
		const { tools } = captureTools();
		const result = await tools.get("task").execute("1", {
			action: "update",
			items: [{ subject: "New step", status: "pending" }],
		});
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /action=create|taskId/i);
	});

	it("get missing task id is error", async () => {
		const { tools, store } = captureTools();
		store.createTasks({ items: [{ subject: "A" }] });
		const result = await tools.get("task").execute("1", {
			action: "get",
			taskIds: ["t1", "t99"],
		});
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /t99/);
	});

	it("failed create does not leave tasks", async () => {
		const { tools, store } = captureTools();
		const result = await tools.get("task").execute("1", {
			action: "create",
			items: [
				{ subject: "A", status: "in_progress" },
				{ subject: "B", status: "in_progress" },
			],
		});
		assert.equal(result.isError, true);
		assert.equal(store.listTasks("*").length, 0);
	});

	it("task items schema is not Type.Any", () => {
		const { tools } = captureTools();
		const schema = tools.get("task").parameters;
		const items = schema?.properties?.items ?? schema?.items;
		// TypeBox stores as object; ensure description mentions create/update shapes.
		const raw = JSON.stringify(schema);
		assert.match(raw, /subject|taskId/);
		assert.doesNotMatch(raw, /"type":"any"|Type\.Any/);
		void items;
	});
});
