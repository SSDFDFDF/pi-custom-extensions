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
	it("registers board, checklist, task, board_doc only", () => {
		const { tools } = captureTools();
		assert.deepEqual(
			[...tools.keys()].sort(),
			["board", "board_doc", "checklist", "task"],
		);
	});

	it("task-first naming; checklist stresses full replace", () => {
		const { tools } = captureTools();
		assert.match(tools.get("task").promptSnippet, /Primary/i);
		assert.match(tools.get("board").promptSnippet, /advanced|Optional/i);
		assert.match(tools.get("checklist").label, /Replace Checklist/i);
		assert.match(tools.get("checklist").promptSnippet, /FULL REPLACE/i);
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

	it("checklist empty items rejected", async () => {
		const { tools, store } = captureTools();
		await tools.get("task").execute("1", { action: "create", subject: "Keep" });
		const wiped = await tools.get("checklist").execute("2", { items: [] });
		assert.equal(wiped.isError, true);
		assert.equal(store.listTasks("*").length, 1);
	});

	it("checklist on non-active board sets focusTasks", async () => {
		const { tools, store } = captureTools();
		await tools.get("board").execute("1", { action: "create", title: "Auth" });
		await tools.get("board").execute("2", {
			action: "create",
			title: "UI",
			activate: false,
		});
		const authId = store.getState().activeBoardId;
		const uiId = store.listBoards().find((b) => b.id !== authId)?.id;
		await tools.get("checklist").execute("3", {
			boardId: authId,
			items: [
				{ step: "Auth A", status: "pending" },
				{ step: "Auth B", status: "pending" },
			],
		});
		const written = await tools.get("checklist").execute("4", {
			boardId: uiId,
			items: [{ step: "UI only", status: "in_progress" }],
		});
		assert.equal(written.details.focusBoardId, uiId);
		assert.deepEqual(
			written.details.focusTasks.map((t) => t.subject),
			["UI only"],
		);
		const rendered = tools.get("checklist").renderResult(
			written,
			{ expanded: true },
			theme(),
		);
		assert.match(String(rendered.text ?? rendered), /UI only/);
		assert.doesNotMatch(String(rendered.text ?? rendered), /Auth A/);
	});

	it("checklist standalone alias while board active", async () => {
		const { tools, store } = captureTools();
		await tools.get("board").execute("1", { action: "create", title: "P" });
		await tools.get("task").execute("2", {
			action: "create",
			subject: "InBoard",
		});
		const written = await tools.get("checklist").execute("3", {
			boardId: "standalone",
			explanation: "solo",
			items: [{ step: "Loose only", status: "pending" }],
		});
		assert.equal(written.isError, undefined);
		assert.equal(written.details.focusBoardId, null);
		assert.equal(store.listTasks(null)[0].subject, "Loose only");
		assert.equal(store.getState().note, "solo");
	});

	it("task-only happy path", async () => {
		const { tools, store } = captureTools();
		const a = await tools.get("task").execute("1", {
			action: "create",
			subject: "Step one",
		});
		const b = await tools.get("task").execute("2", {
			action: "create",
			subject: "Step two",
		});
		const idA = a.content[0].text.match(/Created (t\d+)/)?.[1];
		const idB = b.content[0].text.match(/Created (t\d+)/)?.[1];
		await tools.get("task").execute("3", {
			action: "update",
			taskId: idA,
			status: "completed",
		});
		await tools.get("task").execute("4", {
			action: "update",
			taskId: idB,
			status: "in_progress",
		});
		assert.equal(store.getTask(idA).status, "completed");
		assert.equal(store.getTask(idB).status, "in_progress");
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
			subject: "Nope",
			boardId: "*",
		});
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /list\/clear/i);
	});

	it("task list details.scopedTasks match listed scope", async () => {
		const { tools, store } = captureTools();
		const a = store.createBoard({ title: "A" });
		const b = store.createBoard({ title: "B", activate: false });
		store.createTask({ subject: "InA", boardId: a.board.id });
		store.createTask({ subject: "InB", boardId: b.board.id });
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

	it("checklist boardId=* explains list/clear only", async () => {
		const { tools, store } = captureTools();
		store.createTask({ subject: "Keep" });
		const result = await tools.get("checklist").execute("1", {
			boardId: "*",
			items: [{ step: "Nope", status: "pending" }],
		});
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /list\/clear/i);
		assert.equal(store.listTasks("*").length, 1);
	});
});
