/**
 * OpenClaw-style single-slot progress draft helper.
 * Builds compact multi-line status text; does not talk to channels.
 */

import {
  DEFAULT_PROGRESS_POLICY,
  type ChannelTarget,
  type ProgressPolicy,
} from "./types.ts";

export function normalizeProgressPolicy(
  partial?: Partial<ProgressPolicy>,
): ProgressPolicy {
  const base = { ...DEFAULT_PROGRESS_POLICY };
  if (!partial) return base;
  if (partial.mode === "off" || partial.mode === "progress") {
    base.mode = partial.mode;
  }
  if (typeof partial.startDelayMs === "number" && partial.startDelayMs >= 0) {
    base.startDelayMs = partial.startDelayMs;
  }
  if (typeof partial.maxLines === "number" && partial.maxLines > 0) {
    base.maxLines = Math.floor(partial.maxLines);
  }
  if (typeof partial.maxLineChars === "number" && partial.maxLineChars > 20) {
    base.maxLineChars = Math.floor(partial.maxLineChars);
  }
  if (
    typeof partial.minEditIntervalMs === "number" &&
    partial.minEditIntervalMs >= 0
  ) {
    base.minEditIntervalMs = partial.minEditIntervalMs;
  }
  return base;
}

export function targetKey(target: ChannelTarget): string {
  const thread =
    typeof target.address.threadId === "number"
      ? `:t${target.address.threadId}`
      : "";
  const chat =
    target.address.chatId !== undefined
      ? String(target.address.chatId)
      : JSON.stringify(target.address);
  return `${target.channelId}/${target.profileId}/${chat}${thread}`;
}

export function truncateProgressLine(line: string, maxChars: number): string {
  const cleaned = line.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxChars) return cleaned;
  if (maxChars <= 3) return cleaned.slice(0, maxChars);
  const head = Math.ceil((maxChars - 1) * 0.55);
  const tail = maxChars - 1 - head;
  return `${cleaned.slice(0, head)}…${cleaned.slice(-tail)}`;
}

/** Map tool name + args into a short public line (no secrets/raw dumps). */
export function formatToolProgressLine(
  toolName: string,
  args: unknown,
  maxChars: number,
): string {
  const icon = toolIcon(toolName);
  const detail = toolDetail(toolName, args);
  const line = detail ? `${icon} ${toolName}: ${detail}` : `${icon} ${toolName}`;
  return truncateProgressLine(line, maxChars);
}

function toolIcon(name: string): string {
  switch (name) {
    case "bash":
      return "🛠️";
    case "read":
      return "📖";
    case "write":
    case "edit":
      return "✍️";
    case "grep":
    case "find":
      return "🔎";
    case "ls":
      return "📁";
    case "web_search":
    case "fetch_content":
      return "🌐";
    default:
      return "🔧";
  }
}

function toolDetail(toolName: string, args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  const pick = (...keys: string[]): string => {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) {
        return shortenPathish(value.trim());
      }
    }
    return "";
  };

  if (toolName === "bash") {
    return pick("command", "cmd") || "";
  }
  if (toolName === "read" || toolName === "write" || toolName === "edit") {
    return pick("path", "file", "filePath") || "";
  }
  if (toolName === "grep" || toolName === "find") {
    const pattern = pick("pattern", "query", "glob");
    const path = pick("path", "directory", "cwd");
    return [pattern, path].filter(Boolean).join(" @ ");
  }
  if (toolName === "ls") {
    return pick("path", "directory") || ".";
  }
  if (toolName === "web_search") {
    return pick("query", "queries") || "";
  }
  // generic: first short string field
  for (const value of Object.values(record)) {
    if (typeof value === "string" && value.trim() && value.length < 80) {
      return shortenPathish(value.trim());
    }
  }
  return "";
}

function shortenPathish(value: string): string {
  if (value.length <= 60) return value;
  return `…${value.slice(-57)}`;
}

export interface ProgressDraftState {
  target: ChannelTarget;
  lines: string[];
  label: string;
  createdAt: number;
  lastEditAt: number;
  materialized: boolean;
  /** Channel run token; flushes abort if the run is replaced. */
  runToken?: string;
}

export function createProgressDraftState(
  target: ChannelTarget,
  label = "Working…",
  runToken?: string,
): ProgressDraftState {
  return {
    target,
    lines: [],
    label,
    createdAt: Date.now(),
    lastEditAt: 0,
    materialized: false,
    runToken,
  };
}

export function pushProgressLine(
  state: ProgressDraftState,
  line: string,
  policy: ProgressPolicy,
): ProgressDraftState {
  const nextLine = truncateProgressLine(line, policy.maxLineChars);
  if (!nextLine) return state;
  // de-dupe consecutive identical lines
  if (state.lines[state.lines.length - 1] === nextLine) return state;
  const lines = [...state.lines, nextLine];
  while (lines.length > policy.maxLines) lines.shift();
  return { ...state, lines };
}

/** Render draft body for channel send/edit. */
export function renderProgressDraftText(state: ProgressDraftState): string {
  if (state.lines.length === 0) return state.label;
  // label stays on top briefly; once we have lines, show lines only (less noise)
  if (state.lines.length >= 2) return state.lines.join("\n");
  return `${state.label}\n${state.lines.join("\n")}`;
}

export function shouldThrottleEdit(
  state: ProgressDraftState,
  policy: ProgressPolicy,
  now = Date.now(),
): boolean {
  if (!state.materialized) return false;
  return now - state.lastEditAt < policy.minEditIntervalMs;
}
