/**
 * Agent system-prompt snippet for current board/task state.
 */

import {
	type BteState,
	formatTaskList,
	getActiveBoard,
	tasksInScope,
} from "./types.ts";

export function renderAgentContext(state: BteState): string {
	const lines: string[] = [];
	const active = getActiveBoard(state);
	const scoped = tasksInScope(state);
	const standalone = state.tasks.filter((t) => !t.boardId);

	if (state.boards.length === 0 && state.tasks.length === 0) return "";

	lines.push("[TASK BOARD]");
	lines.push(
		"task actions: create/update/replace all use items[]. create=append, update=patch by id (omitted kept), replace=full scope snapshot (omitted deleted). Prefer update for progress. One in_progress per board (or standalone).",
	);

	if (state.boards.length > 0) {
		const bits = state.boards.map((b) => {
			const n = state.tasks.filter((t) => t.boardId === b.id).length;
			const done = state.tasks.filter(
				(t) => t.boardId === b.id && t.status === "completed",
			).length;
			const star = b.id === state.activeBoardId ? "*" : "";
			return `${star}${b.id} ${b.title} (${done}/${n})`;
		});
		lines.push(`Boards: ${bits.join("; ")}`);
		lines.push(
			active ? `Active: ${active.id} ${active.title}` : "Active: (standalone)",
		);
		const other = state.tasks.filter(
			(t) => t.boardId && t.boardId !== state.activeBoardId,
		).length;
		if (other > 0 || standalone.length > 0) {
			lines.push(
				`Other scopes not expanded — task list boardId="*" (${other} in other boards, ${standalone.length} standalone).`,
			);
		}
		const foreign = state.tasks.filter(
			(t) =>
				t.status === "in_progress" &&
				(t.boardId
					? t.boardId !== state.activeBoardId
					: Boolean(state.activeBoardId)),
		);
		if (foreign.length) {
			lines.push(
				`Active outside current scope: ${foreign
					.map((t) => (t.boardId ? `${t.id}@${t.boardId}` : `${t.id}@standalone`))
					.join(", ")}`,
			);
		}
	}

	if (scoped.length > 0) {
		lines.push(
			formatTaskList(scoped, {
				includeId: true,
				includeDeps: true,
				includeActiveForm: true,
			}),
		);
	}

	if (active && standalone.length > 0 && standalone.length <= 5) {
		lines.push(`Standalone: ${standalone.map((t) => t.subject).join("; ")}`);
	} else if (active && standalone.length > 5) {
		lines.push(`(+${standalone.length} standalone)`);
	}

	if (active?.doc?.body) {
		const body = active.doc.body;
		const snippet =
			body.length > 4000 ? `${body.slice(0, 4000)}\n…(truncated)` : body;
		lines.push("");
		lines.push(`Doc${active.doc.title ? ` (${active.doc.title})` : ""}:`);
		lines.push(snippet);
	}

	// Active board uses board.note only; standalone scope uses state.note.
	const note = active ? active.note : state.note;
	if (note) lines.push(`Note: ${note}`);

	return lines.join("\n");
}
