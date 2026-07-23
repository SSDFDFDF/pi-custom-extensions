import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerApplyPatchTool } from "./apply-patch.js";
import { registerShellTool } from "./shell.js";
import { loadConfig, saveConfig, type CompressMode } from "./config.js";

const DISABLED_TOOLS = new Set(["bash", "grep", "find", "ls", "edit"]);

function configureActiveTools(pi: ExtensionAPI) {
  const active = pi.getActiveTools().filter((name) => !DISABLED_TOOLS.has(name));
  pi.setActiveTools([...new Set([...active, "read", "write", "shell", "apply_patch"])]);
}

const COMPRESS_MODES: CompressMode[] = ["off", "safe", "aggressive"];

function statusLines(pi: ExtensionAPI): string[] {
  configureActiveTools(pi);
  const active = pi.getActiveTools();
  const hidden = pi
    .getAllTools()
    .map((tool) => tool.name)
    .filter((name) => !active.includes(name));
  const { compress } = loadConfig();
  return [
    "kun-tools",
    `Active core tools: ${["read", "write", "shell", "apply_patch"].filter((name) => active.includes(name)).join(", ") || "none"}`,
    `Disabled overlapping tools: ${hidden.filter((name) => DISABLED_TOOLS.has(name)).join(", ") || "none"}`,
    `Compress: mode=${compress.mode} minBytes=${compress.minBytes} commandFilters=${compress.commandFilters}`,
  ];
}

const COMPRESS_USAGE =
  "Usage: /kun-tools compress <off|safe|aggressive|status|min <bytes>|filters <on|off>>";

/** Strict nonnegative decimal integer (no hex/exponent/decimal). */
function parseMinBytes(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function handleCompress(args: string[]): string {
  const [sub, value, ...rest] = args;
  if (!sub || sub === "status") {
    if (sub === "status" && (value !== undefined || rest.length > 0)) return COMPRESS_USAGE;
    const { compress } = loadConfig();
    return `Compress: mode=${compress.mode} minBytes=${compress.minBytes} commandFilters=${compress.commandFilters}`;
  }
  if (COMPRESS_MODES.includes(sub as CompressMode)) {
    if (value !== undefined || rest.length > 0) return COMPRESS_USAGE;
    const { compress } = saveConfig({ compress: { mode: sub as CompressMode } });
    return `Compress mode set: ${compress.mode}`;
  }
  if (sub === "min") {
    if (rest.length > 0) return "Usage: /kun-tools compress min <bytes>";
    const parsed = parseMinBytes(value);
    if (parsed === undefined) return "Usage: /kun-tools compress min <bytes>";
    const { compress } = saveConfig({ compress: { minBytes: parsed } });
    return `Compress minBytes set: ${compress.minBytes}`;
  }
  if (sub === "filters") {
    if (rest.length > 0) return "Usage: /kun-tools compress filters <on|off>";
    const on = value === "on";
    const off = value === "off";
    if (!on && !off) return "Usage: /kun-tools compress filters <on|off>";
    const { compress } = saveConfig({ compress: { commandFilters: on } });
    return `Compress commandFilters set: ${compress.commandFilters}`;
  }
  return COMPRESS_USAGE;
}

export default function kunTools(pi: ExtensionAPI) {
  registerShellTool(pi);
  registerApplyPatchTool(pi);

  pi.on("session_start", () => {
    configureActiveTools(pi);
  });

  pi.on("before_agent_start", () => {
    configureActiveTools(pi);
  });

  pi.registerCommand("kun-tools", {
    description: "Show kun-tools config, or manage compression: /kun-tools compress <off|safe|aggressive|min N|filters on|off>",
    handler: async (_args, ctx) => {
      const args = (_args ?? "").trim().split(/\s+/).filter(Boolean);
      if (args.length === 0 || args[0] === "status") {
        if (args.length > 1) {
          ctx.ui.notify(`Usage: /kun-tools [status] | /kun-tools compress ...`, "info");
          return;
        }
        ctx.ui.notify(statusLines(pi).join("\n"), "info");
        return;
      }
      if (args[0] === "compress") {
        ctx.ui.notify(handleCompress(args.slice(1)), "info");
        return;
      }
      ctx.ui.notify(`Unknown subcommand: ${args[0]}. Usage: /kun-tools [status] | /kun-tools compress ...`, "info");
    },
  });
}

export { configureActiveTools, DISABLED_TOOLS, handleCompress };
