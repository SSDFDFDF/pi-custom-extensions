import { isImportant } from "./importance.js";
import type { LineReducer } from "./types.js";

/** First token of the command, lowercased (handles env prefixes minimally). */
export function detectTool(command: string): string {
  const tokens = command.trim().split(/\s+/);
  let index = 0;
  while (index < tokens.length && tokens[index].includes("=")) index += 1;
  return (tokens[index] ?? "").split("/").pop()?.toLowerCase() ?? "";
}

// Command-aware noise: known non-signal lines per tool family. Aggressive only.
const TOOL_NOISE: Record<string, RegExp[]> = {
  npm: [/^npm warn /i, /^npm notice/i, /^\s*added \d+ packages?/i, /^\s*audited \d+ packages?/i, /found \d+ vulnerabilities/i],
  pnpm: [/^\s*Progress: /i, /^Packages: /i, /^\s*\+\d+\s*$/, /reused \d+, downloaded \d+/i],
  yarn: [/^success /i, /^info /i, /Done in \d/i],
  pip: [/^\s*Requirement already satisfied/i, /^\s*Using cached /i, /^\s*Downloading /i],
  docker: [/^\s*[0-9a-f]{12}: (?:Already exists|Pulling fs layer|Waiting|Verifying Checksum|Download complete|Pull complete)\s*$/i],
  go: [/^go: downloading /i],
  cargo: [/^\s*Compiling /i, /^\s*Downloading /i, /^\s*Downloaded /i],
};

/** Stage 4 (aggressive): drop known per-tool noise lines unless important. */
export class CommandFilterReducer implements LineReducer {
  readonly name = "filters";
  hits = 0;
  private readonly patterns: RegExp[];

  constructor(command: string) {
    this.patterns = TOOL_NOISE[detectTool(command)] ?? [];
  }

  push(line: string): string[] {
    if (this.patterns.length === 0) return [line];
    if (!isImportant(line) && this.patterns.some((pattern) => pattern.test(line))) {
      this.hits += 1;
      return [];
    }
    return [line];
  }

  flush(): string[] {
    return [];
  }
}
