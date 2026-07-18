/** Status line and widget helpers for pi-bte. */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	countByStatus,
	formatTaskLine,
	getActiveBoard,
	statusMark,
	tasksInScope,
	type BteConfig,
	type BteState,
	type Task,
} from "./types.ts";

export function refreshUi(ctx: ExtensionContext, state: BteState, config: BteConfig): void {
	if (!ctx.hasUI || !config.showWidget) {
		ctx.ui.setStatus("bte", undefined);
		ctx.ui.setWidget("bte", undefined);
		return;
	}

	const theme = ctx.ui.theme;
	const tasks = tasksInScope(state);
	const counts = countByStatus(tasks);
	const total = tasks.length;
	const active = getActiveBoard(state);
	const boardCount = state.boards.length;

	if (total > 0 || boardCount > 0) {
		const color =
			counts.in_progress > 0
				? "accent"
				: total > 0 && counts.completed + counts.cancelled === total
					? "success"
					: "muted";
		const boardBit = active
			? theme.fg("muted", ` ${active.id}`)
			: boardCount > 0
				? theme.fg("dim", " —")
				: "";
		ctx.ui.setStatus(
			"bte",
			theme.fg(color, "◈") +
				boardBit +
				theme.fg("muted", ` ${counts.completed}/${total || 0}`) +
				(counts.in_progress ? theme.fg("accent", ` ~${counts.in_progress}`) : "") +
				(boardCount > 1 ? theme.fg("dim", ` [${boardCount}b]`) : ""),
		);

		const lines: string[] = [];
		if (active) {
			lines.push(
				theme.fg("muted", "board: ") +
					theme.fg("accent", active.id) +
					" " +
					theme.fg("text", active.title),
			);
		} else if (boardCount > 0) {
			lines.push(theme.fg("dim", "board: standalone"));
		}

		const shown = tasks.slice(0, config.widgetMaxTasks);
		for (const task of shown) {
			const mark = statusMark(task.status);
			const title = widgetTitle(task);
			const idBit = theme.fg("dim", task.id) + " ";
			if (task.status === "completed") {
				lines.push(
					theme.fg("success", mark) +
						" " +
						idBit +
						theme.fg("muted", theme.strikethrough(title)),
				);
			} else if (task.status === "in_progress") {
				lines.push(
					theme.fg("accent", mark) + " " + idBit + theme.fg("text", title),
				);
			} else if (task.status === "cancelled") {
				lines.push(theme.fg("dim", mark) + " " + idBit + theme.fg("dim", title));
			} else {
				lines.push(theme.fg("muted", mark) + " " + idBit + theme.fg("text", title));
			}
		}
		if (total > config.widgetMaxTasks) {
			lines.push(theme.fg("dim", `… ${total - config.widgetMaxTasks} more`));
		}

		if (lines.length === 0) {
			ctx.ui.setWidget("bte", undefined);
		} else {
			ctx.ui.setWidget("bte", lines);
		}
		return;
	}

	ctx.ui.setStatus("bte", undefined);
	ctx.ui.setWidget("bte", undefined);
}

function widgetTitle(task: Task): string {
	if (task.status === "in_progress" && task.activeForm) return task.activeForm;
	return task.subject;
}

export function formatStatusText(state: BteState): string {
	const active = getActiveBoard(state);
	const scoped = tasksInScope(state);
	const counts = countByStatus(scoped);
	const lines = [
		`boards: ${state.boards.length}` +
			(active ? ` active=${active.id} (${active.title})` : " active=(none)"),
		`tasks in scope: ${scoped.length} (done=${counts.completed} active=${counts.in_progress} pending=${counts.pending} cancelled=${counts.cancelled}) total=${state.tasks.length}`,
	];
	const note = active ? active.note : state.note;
	if (note) lines.push(`note: ${note}`);

	if (state.boards.length) {
		lines.push("");
		lines.push("Boards:");
		for (const b of state.boards) {
			const n = state.tasks.filter((t) => t.boardId === b.id).length;
			const mark = b.id === state.activeBoardId ? "*" : " ";
			lines.push(`${mark} ${b.id}: ${b.title} (${n} tasks)`);
		}
	}

	if (active?.doc) {
		lines.push(
			`doc: ${active.doc.title ?? "(untitled)"} (${active.doc.body.length} chars)`,
		);
	}

	if (scoped.length) {
		lines.push("");
		lines.push(active ? `Tasks (${active.id}):` : "Standalone tasks:");
		for (const task of scoped) {
			lines.push(
				formatTaskLine(task, {
					includeId: true,
					includeDeps: true,
					includeActiveForm: true,
				}),
			);
		}
	}
	return lines.join("\n");
}
