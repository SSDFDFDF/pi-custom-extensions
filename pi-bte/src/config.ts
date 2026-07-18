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
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<BteConfig> & {
			widgetMaxTasks?: unknown;
		};
		return {
			injectContext:
				typeof raw.injectContext === "boolean"
					? raw.injectContext
					: DEFAULT_CONFIG.injectContext,
			showWidget:
				typeof raw.showWidget === "boolean"
					? raw.showWidget
					: DEFAULT_CONFIG.showWidget,
		};
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

export function saveConfig(config: BteConfig): void {
	const path = configPath();
	mkdirSync(dirname(path), { recursive: true });
	// Drop unknown legacy keys (e.g. widgetMaxTasks) on write.
	writeFileSync(
		path,
		`${JSON.stringify(
			{
				injectContext: config.injectContext,
				showWidget: config.showWidget,
			},
			null,
			2,
		)}\n`,
	);
}
