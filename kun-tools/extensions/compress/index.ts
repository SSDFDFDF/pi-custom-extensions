import { AnsiReducer } from "./ansi.js";
import { CommandFilterReducer } from "./filters.js";
import { DedupReducer } from "./dedup.js";
import { ProgressReducer } from "./progress.js";
import type { CompressConfig } from "../config.js";
import type { LineReducer } from "./types.js";

export type { LineReducer, ReductionStats } from "./types.js";
export { approxTokens } from "./tokens.js";

const JSON_FLAG_PATTERN = /(?:^|\s)(?:--json|-o\s*json|--format(?:=|\s+)json|--output(?:=|\s+)json)\b/i;

/** Commands that explicitly request structured output must not be line-mangled. */
export function forcesStructuredOutput(command: string): boolean {
  return JSON_FLAG_PATTERN.test(command);
}

/**
 * First non-empty content looks like a JSON document. Requires not just a
 * `{`/`[` opener but a plausible following token, so log lines like `[INFO]`
 * or `[WARN] ...` are not misclassified as JSON and wrongly skip compression.
 */
export function looksLikeJson(sample: string): boolean {
  const trimmed = sample.replace(/^\uFEFF/, "").trimStart();
  const head = trimmed[0];
  if (head !== "{" && head !== "[") return false;
  // Next non-whitespace char after the opener.
  const rest = trimmed.slice(1).trimStart();
  if (rest.length === 0) return true; // opener with nothing yet — still could be JSON
  const next = rest[0];
  if (head === "{") {
    // Object: expect a string key or an empty object.
    return next === '"' || next === "}";
  }
  // Array: expect a JSON value start or an empty array.
  return (
    next === '"' ||
    next === "{" ||
    next === "[" ||
    next === "]" ||
    next === "-" ||
    (next >= "0" && next <= "9") ||
    next === "t" ||
    next === "f" ||
    next === "n"
  );
}

/** NUL byte in the first chunk => treat as binary, never compress. */
export function looksBinary(sample: string): boolean {
  return sample.includes("\u0000");
}

/**
 * Build the ordered reducer chain for a mode. `off` returns an empty chain
 * (caller passes text through untouched). Order: ansi -> progress -> dedup,
 * plus command filters when aggressive + commandFilters.
 */
export function buildReducerChain(command: string, cfg: CompressConfig): LineReducer[] {
  if (cfg.mode === "off") return [];
  const chain: LineReducer[] = [new AnsiReducer(), new ProgressReducer(), new DedupReducer()];
  if (cfg.mode === "aggressive" && cfg.commandFilters) {
    // Command filters run before dedup so collapsed noise never reaches dedup.
    chain.splice(2, 0, new CommandFilterReducer(command));
  }
  return chain;
}
