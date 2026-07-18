import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { DEFAULT_CONFIG, type BteConfig } from "./types.ts";

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? ".", ".pi", "agent");
}

function configPath(): string {
	return join(agentDir(), "pi-bte.config.json");
}

export function loadConfig(): BteConfig {
	const path = configPath();
	if (!existsSync(path)) return { ...DEFAULT_CONFIG };
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<BteConfig>;
		return {
			injectContext:
				typeof raw.injectContext === "boolean"
					? raw.injectContext
					: DEFAULT_CONFIG.injectContext,
			showWidget:
				typeof raw.showWidget === "boolean"
					? raw.showWidget
					: DEFAULT_CONFIG.showWidget,
			widgetMaxTasks:
				typeof raw.widgetMaxTasks === "number" && Number.isFinite(raw.widgetMaxTasks) && raw.widgetMaxTasks > 0
					? Math.floor(raw.widgetMaxTasks)
					: DEFAULT_CONFIG.widgetMaxTasks,
		};
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

export function saveConfig(config: BteConfig): void {
	const path = configPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}
