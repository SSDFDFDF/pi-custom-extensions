import { isImportant } from "./importance.js";
import type { LineReducer } from "./types.js";

// Whole-line progress indicators produced by installers, downloaders, builders.
const PROGRESS_PATTERNS: RegExp[] = [
  /^\s*[\u2500-\u25ff\u2591-\u2593#=>.\-]{3,}\s*\d{1,3}%?\s*$/, // bar + percent
  /^\s*\d{1,3}%\s*(?:[|\/\-\\]|\.{2,}|complete|done)?\s*$/i, // lone percent
  /^\s*[|\/\-\\]\s*$/, // spinner frame
  /\b\d+(?:\.\d+)?\s*(?:[kKmMgG]i?[bB])\/s\b/, // transfer rate lines
  /^\s*\[[\s=>#.\-]*\]\s*\d*%?\s*$/, // [====>   ] style
  /^\s*(?:downloading|fetching|resolving|extracting|building)\b.*\d{1,3}%/i,
  /^\s*eta[:\s]/i,
];

export function isProgressLine(line: string): boolean {
  return PROGRESS_PATTERNS.some((pattern) => pattern.test(line));
}

/** Stage 2: drop progress / spinner lines unless important. */
export class ProgressReducer implements LineReducer {
  readonly name = "progress";
  hits = 0;

  push(line: string): string[] {
    if (!isImportant(line) && isProgressLine(line)) {
      this.hits += 1;
      return [];
    }
    return [line];
  }

  flush(): string[] {
    return [];
  }
}
