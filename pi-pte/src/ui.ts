/** Status line and widget helpers for pi-pte. */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { countByStatus, type PteConfig, type PteState } from "./types.ts";

export function refreshUi(ctx: ExtensionContext, state: PteState, config: PteConfig): void {
	if (!ctx.hasUI || !config.showWidget) {
		ctx.ui.setStatus("pte", undefined);
		ctx.ui.setWidget("pte", undefined);
		return;
	}

	const theme = ctx.ui.theme;
	const counts = countByStatus(state.tasks);
	const total = state.tasks.length;

	if (total > 0) {
		const color =
			counts.in_progress > 0
				? "accent"
				: counts.completed + counts.cancelled === total
					? "success"
					: "muted";
		ctx.ui.setStatus(
			"pte",
			theme.fg(color, "◈") +
				theme.fg("muted", ` ${counts.completed}/${total}`) +
				(counts.in_progress ? theme.fg("accent", ` ~${counts.in_progress}`) : ""),
		);

		const lines = state.tasks.slice(0, config.widgetMaxTasks).map((task) => {
			if (task.status === "completed") {
				return theme.fg("success", "☑ ") + theme.fg("muted", theme.strikethrough(task.subject));
			}
			if (task.status === "in_progress") {
				return theme.fg("accent", "► ") + theme.fg("text", task.activeForm || task.subject);
			}
			if (task.status === "cancelled") return theme.fg("dim", `– ${task.subject}`);
			return theme.fg("muted", "☐ ") + theme.fg("text", task.subject);
		});
		if (total > config.widgetMaxTasks) {
			lines.push(theme.fg("dim", `… ${total - config.widgetMaxTasks} more`));
		}
		ctx.ui.setWidget("pte", lines);
		return;
	}

	ctx.ui.setStatus("pte", undefined);
	ctx.ui.setWidget("pte", undefined);
}

export function formatStatusText(state: PteState): string {
	const counts = countByStatus(state.tasks);
	const lines = [
		`tasks: ${state.tasks.length} (done=${counts.completed} active=${counts.in_progress} pending=${counts.pending} cancelled=${counts.cancelled})`,
	];
	if (state.planDoc) {
		lines.push(`plan_doc: ${state.planDoc.title ?? "(untitled)"} (${state.planDoc.body.length} chars)`);
	}
	if (state.tasks.length) {
		lines.push("");
		for (const task of state.tasks) {
			const mark =
				task.status === "completed"
					? "[x]"
					: task.status === "in_progress"
						? "[~]"
						: task.status === "cancelled"
							? "[-]"
							: "[ ]";
			lines.push(`${mark} ${task.id} ${task.subject}`);
		}
	}
	if (state.lastExplanation) {
		lines.push("");
		lines.push(`note: ${state.lastExplanation}`);
	}
	return lines.join("\n");
}
