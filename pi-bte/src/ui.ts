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
	type TaskStatus,
} from "./types.ts";

/**
 * Pi caps each extension widget string[] at 10 lines
 * (`InteractiveMode.MAX_WIDGET_LINES`). Board + tasks + footer must fit.
 */
export const PI_MAX_WIDGET_LINES = 10;

export interface WidgetTaskSelection {
	shown: Task[];
	hidden: Task[];
	hiddenOpen: number;
	hiddenDone: number;
	hiddenCancelled: number;
}

function isFinished(status: TaskStatus): boolean {
	return status === "completed" || status === "cancelled";
}

function compareId(a: string, b: string): number {
	return a.localeCompare(b, undefined, { numeric: true });
}

function countHidden(hidden: Task[]): Pick<
	WidgetTaskSelection,
	"hiddenOpen" | "hiddenDone" | "hiddenCancelled"
> {
	let hiddenOpen = 0;
	let hiddenDone = 0;
	let hiddenCancelled = 0;
	for (const t of hidden) {
		if (t.status === "completed") hiddenDone += 1;
		else if (t.status === "cancelled") hiddenCancelled += 1;
		else hiddenOpen += 1;
	}
	return { hiddenOpen, hiddenDone, hiddenCancelled };
}

function truncateTitle(title: string, max: number): string {
	const t = title.trim();
	if (t.length <= max) return t;
	return max <= 1 ? "…" : `${t.slice(0, max - 1)}…`;
}

/**
 * One-line board chrome (0–1 of the 10 lines).
 * Multi-board: `board: b1 Title · +N boards` (never a second header line).
 */
export function formatBoardHeaderPlain(state: BteState): string | undefined {
	const active = getActiveBoard(state);
	const n = state.boards.length;

	if (active) {
		const others = n - 1;
		const title = truncateTitle(active.title, others > 0 ? 28 : 40);
		const base = `board: ${active.id} ${title}`;
		return others > 0
			? `${base} · +${others} board${others === 1 ? "" : "s"}`
			: base;
	}
	if (n > 0) {
		return n === 1
			? "board: standalone · 1 board"
			: `board: standalone · ${n} boards`;
	}
	return undefined;
}

/**
 * Task pick for a line budget (tasks + optional footer only).
 * - fits → show all, normal order
 * - over → keep open (order), squeeze finished (small ids first), then open tail
 */
export function selectWidgetTasks(
	tasks: Task[],
	capacity: number,
): WidgetTaskSelection {
	const ordered = [...tasks];
	if (capacity <= 0 || ordered.length === 0) {
		return { shown: [], hidden: ordered, ...countHidden(ordered) };
	}
	if (ordered.length <= capacity) {
		return {
			shown: ordered,
			hidden: [],
			hiddenOpen: 0,
			hiddenDone: 0,
			hiddenCancelled: 0,
		};
	}

	const slots = Math.max(0, capacity - 1);
	const open = ordered.filter((t) => !isFinished(t.status));
	const finished = ordered.filter((t) => isFinished(t.status));

	let shownIds: Set<string>;
	if (open.length <= slots) {
		const keepFinished = [...finished]
			.sort((a, b) => compareId(b.id, a.id))
			.slice(0, slots - open.length);
		shownIds = new Set([
			...open.map((t) => t.id),
			...keepFinished.map((t) => t.id),
		]);
	} else {
		shownIds = new Set(open.slice(0, slots).map((t) => t.id));
	}

	const shown = ordered.filter((t) => shownIds.has(t.id));
	const hidden = ordered.filter((t) => !shownIds.has(t.id));
	return { shown, hidden, ...countHidden(hidden) };
}

/** Lines left for tasks + footer after optional board header. */
export function widgetTaskCapacity(hasHeader: boolean): number {
	return Math.max(0, PI_MAX_WIDGET_LINES - (hasHeader ? 1 : 0));
}

/** Display-only hide footer (not “more work”). */
export function formatWidgetMoreLine(sel: WidgetTaskSelection): string {
	const n = sel.hidden.length;
	if (n <= 0) return "";

	if (sel.hiddenOpen === 0) {
		const bits: string[] = [];
		if (sel.hiddenDone > 0) bits.push(`${sel.hiddenDone} done`);
		if (sel.hiddenCancelled > 0) bits.push(`${sel.hiddenCancelled} cancelled`);
		return `… ${bits.join(" · ")} not shown`;
	}
	if (sel.hiddenOpen === n) {
		return `… ${sel.hiddenOpen} open not shown`;
	}
	const bits: string[] = [`${sel.hiddenOpen} open`];
	if (sel.hiddenDone > 0) bits.push(`${sel.hiddenDone} done`);
	if (sel.hiddenCancelled > 0) bits.push(`${sel.hiddenCancelled} cancelled`);
	return `… not shown: ${bits.join(" · ")}`;
}

/** Plan header + selection under Pi's budget. */
export function planWidgetLayout(
	state: BteState,
	tasks = tasksInScope(state),
): {
	headerPlain?: string;
	selection: WidgetTaskSelection;
} {
	const headerPlain = formatBoardHeaderPlain(state);
	const selection = selectWidgetTasks(
		tasks,
		widgetTaskCapacity(Boolean(headerPlain)),
	);
	return { headerPlain, selection };
}

function paintTaskLine(
	task: Task,
	theme: { fg: (c: string, t: string) => string; strikethrough: (t: string) => string },
): string {
	const mark = statusMark(task.status);
	const title =
		task.status === "in_progress" && task.activeForm
			? task.activeForm
			: task.subject;
	const idBit = theme.fg("dim", task.id) + " ";
	if (task.status === "completed") {
		return (
			theme.fg("success", mark) +
			" " +
			idBit +
			theme.fg("muted", theme.strikethrough(title))
		);
	}
	if (task.status === "in_progress") {
		return theme.fg("accent", mark) + " " + idBit + theme.fg("text", title);
	}
	if (task.status === "cancelled") {
		return theme.fg("dim", mark) + " " + idBit + theme.fg("dim", title);
	}
	return theme.fg("muted", mark) + " " + idBit + theme.fg("text", title);
}

export function refreshUi(
	ctx: ExtensionContext,
	state: BteState,
	config: BteConfig,
): void {
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

	if (total === 0 && boardCount === 0) {
		ctx.ui.setStatus("bte", undefined);
		ctx.ui.setWidget("bte", undefined);
		return;
	}

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

	const { headerPlain, selection } = planWidgetLayout(state, tasks);
	const lines: string[] = [];
	if (headerPlain) {
		lines.push(
			headerPlain.startsWith("board: standalone")
				? theme.fg("dim", headerPlain)
				: theme.fg("muted", headerPlain),
		);
	}
	for (const t of selection.shown) {
		lines.push(paintTaskLine(t, theme));
	}
	if (selection.hidden.length > 0) {
		lines.push(theme.fg("dim", formatWidgetMoreLine(selection)));
	}

	// Hard cap (should already fit).
	const capped = lines.slice(0, PI_MAX_WIDGET_LINES);
	ctx.ui.setWidget("bte", capped.length ? capped : undefined);
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
