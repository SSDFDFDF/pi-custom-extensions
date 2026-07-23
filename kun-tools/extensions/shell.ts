import { access, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  createLocalBashOperations,
  type AgentToolUpdateCallback,
  type ExtensionAPI,
  type ExtensionContext,
  keyHint,
  truncateToVisualLines,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { ShellOutputCapture } from "./output.js";
import { loadConfig } from "./config.js";
import { approxTokens, type ReductionStats } from "./compress/index.js";

export const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_TIMEOUT_MS = 30 * 60 * 1000;

export const shellSchema = Type.Object({
  command: Type.String({ description: "Shell script to execute." }),
  workdir: Type.Optional(
    Type.String({ description: "Working directory. Defaults to the current project directory." }),
  ),
  timeoutMs: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_TIMEOUT_MS,
      description: `Maximum runtime in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS}.`,
    }),
  ),
});

export type ShellInput = Static<typeof shellSchema>;

export interface ShellDetails {
  command: string;
  workdir: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  truncated?: boolean;
  fullOutputPath?: string;
  reduction?: ReductionStats;
}

function normalizePath(input: string): string {
  const unprefixed = input.startsWith("@") ? input.slice(1) : input;
  if (unprefixed === "~") return homedir();
  if (unprefixed.startsWith("~/")) return resolve(homedir(), unprefixed.slice(2));
  return unprefixed;
}

function allowOutsideWorkdir(): boolean {
  const value = process.env.KUN_ALLOW_OUTSIDE_WORKDIR?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function isInsideRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export async function resolveWorkdir(input: string | undefined, cwd: string): Promise<string> {
  const projectRoot = await realpath(cwd).catch(async () => {
    await access(cwd);
    return resolve(cwd);
  });

  const raw = normalizePath(input?.trim() || projectRoot);
  const directory = isAbsolute(raw) ? raw : resolve(projectRoot, raw);
  if (directory.includes("\0")) throw new Error("workdir contains a NUL byte");
  await access(directory);
  if (!(await stat(directory)).isDirectory()) {
    throw new Error(`workdir is not a directory: ${directory}`);
  }

  const resolvedDir = await realpath(directory);
  if (!allowOutsideWorkdir() && !isInsideRoot(projectRoot, resolvedDir)) {
    throw new Error(
      `workdir escapes the project root: ${directory} (set KUN_ALLOW_OUTSIDE_WORKDIR=1 to allow)`,
    );
  }
  return resolvedDir;
}

function parseTimeout(timeoutMs: number | undefined): number {
  const value = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    throw new Error(`timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}`);
  }
  return value;
}

/** Stable footer for models and hooks. */
export function formatShellFooter(
  details: Pick<ShellDetails, "exitCode" | "durationMs" | "timedOut" | "truncated" | "fullOutputPath" | "reduction">,
): string {
  const lines = [
    "---",
    `exit: ${details.exitCode ?? "unknown"}`,
    `duration_ms: ${details.durationMs}`,
    `timed_out: ${details.timedOut ? "true" : "false"}`,
    `truncated: ${details.truncated ? "true" : "false"}`,
  ];
  const reducedLine = formatReducedLine(details.reduction);
  if (reducedLine) lines.push(reducedLine);
  if (details.fullOutputPath) lines.push(`full_output: ${details.fullOutputPath}`);
  return lines.join("\n");
}

/** Human-readable savings line; only emitted when reduction saved meaningful bytes. */
export function formatReducedLine(reduction: ReductionStats | undefined): string | undefined {
  if (!reduction || reduction.passthrough || reduction.stages.length === 0) return undefined;
  const { rawBytes, outBytes } = reduction;
  if (rawBytes <= 0 || outBytes >= rawBytes) return undefined;
  const savedPct = Math.round((1 - outBytes / rawBytes) * 100);
  if (savedPct < 5) return undefined;
  const before = approxTokens(rawBytes);
  const after = approxTokens(outBytes);
  return `reduced: ${formatBytes(rawBytes)}→${formatBytes(outBytes)} (-${savedPct}%, ~${before}→~${after} tok) [${reduction.stages.join(",")}]`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export async function executeShell(
  input: ShellInput,
  signal: AbortSignal | undefined,
  ctx: Pick<ExtensionContext, "cwd">,
  onUpdate?: AgentToolUpdateCallback<unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: ShellDetails }> {
  if (!input.command.trim()) throw new Error("command must not be empty");

  const workdir = await resolveWorkdir(input.workdir, ctx.cwd);
  const timeoutMs = parseTimeout(input.timeoutMs);
  const config = loadConfig();
  const output = new ShellOutputCapture({ command: input.command, compress: config.compress });
  const startedAt = Date.now();
  let timedOut = false;
  let exitCode: number | null = null;
  let executionError: unknown;
  let outputWrites = Promise.resolve();

  const operations = createLocalBashOperations();
  try {
    const result = await operations.exec(input.command, workdir, {
      signal,
      timeout: timeoutMs / 1000,
      onData: (data) => {
        outputWrites = outputWrites.then(async () => {
          await output.append(data);
          onUpdate?.({ content: [{ type: "text", text: "Running shell command..." }], details: undefined });
        });
      },
    });
    exitCode = result.exitCode;
  } catch (error) {
    executionError = error;
    if (error instanceof Error && error.message.startsWith("timeout:")) {
      timedOut = true;
    } else if (signal?.aborted || (error instanceof Error && error.message === "aborted")) {
      throw new Error("Shell command aborted");
    }
  }

  await outputWrites;
  const captured = await output.finish();
  const durationMs = Date.now() - startedAt;
  const details: ShellDetails = {
    command: input.command,
    workdir,
    exitCode,
    durationMs,
    timedOut,
    truncated: captured.truncation?.truncated,
    fullOutputPath: captured.fullOutputPath,
    reduction: captured.reduction,
  };

  let text = captured.content || "(no output)";
  text += `\n\n${formatShellFooter(details)}`;
  if (executionError && !timedOut) {
    text += `\nerror: ${executionError instanceof Error ? executionError.message : String(executionError)}`;
  }

  return { content: [{ type: "text", text }], details };
}

/**
 * Preview line budget when a shell result row is collapsed. Built-in bash uses 5;
 * shell keeps more tail because build/test output carries its verdict near the end.
 */
const SHELL_PREVIEW_LINES = 20;

/** Extract the plain-text output from a tool result's content blocks. */
function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
}

export function registerShellTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "shell",
    label: "shell",
    description:
      "Run one coherent shell task in workdir. Use for rg/find/ls, git, tests, builds, and command-line workflows. Output is capped at 50KB/2000 lines; full truncated output is saved.",
    promptSnippet: "Run shell commands for exploration and execution",
    promptGuidelines: [
      "Use shell for one coherent objective; chain related commands with && when failure should stop the chain.",
      "Prefer filtered output (rg, test name filters, tail of failures). Avoid cat of large logs or source files.",
      "Use read for known file content, write for new files or complete rewrites, and apply_patch for precise source edits.",
    ],
    parameters: shellSchema,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      return executeShell(params, signal, ctx, onUpdate);
    },
    renderCall(args, theme, context) {
      const command = typeof args?.command === "string" ? args.command : "...";
      const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      text.setText(theme.fg("toolTitle", theme.bold(`$ ${command}`)));
      return text;
    },
    renderResult(result, options, theme, context) {
      const component =
        context.lastComponent instanceof Container ? context.lastComponent : new Container();
      component.clear();

      const output = resultText(result).trimEnd();
      if (output) {
        const styled = output
          .split("\n")
          .map((line) => theme.fg(context.isError ? "error" : "toolOutput", line))
          .join("\n");
        if (options.expanded) {
          component.addChild(new Text(`\n${styled}`, 0, 0));
        } else {
          let cachedWidth: number | undefined;
          let cachedLines: string[] | undefined;
          let cachedSkipped = 0;
          component.addChild({
            render: (width: number) => {
              if (cachedLines === undefined || cachedWidth !== width) {
                const preview = truncateToVisualLines(styled, SHELL_PREVIEW_LINES, width);
                cachedLines = preview.visualLines;
                cachedSkipped = preview.skippedCount;
                cachedWidth = width;
              }
              if (cachedSkipped > 0) {
                const hint =
                  theme.fg("muted", `... (${cachedSkipped} earlier lines, `) +
                  keyHint("app.tools.expand", "to expand") +
                  theme.fg("muted", ")");
                return ["", truncateToWidth(hint, width, "..."), ...(cachedLines ?? [])];
              }
              return ["", ...(cachedLines ?? [])];
            },
            invalidate: () => {
              cachedWidth = undefined;
              cachedLines = undefined;
              cachedSkipped = 0;
            },
          });
        }
      }
      component.invalidate();
      return component;
    },
  });
}
