import type { LineReducer } from "./types.js";

/**
 * Stage 3: collapse consecutive duplicate lines into `<line>  (×N)` and
 * collapse runs of blank lines to a single blank. Deterministic; holds at most
 * one pending line plus its count.
 */
export class DedupReducer implements LineReducer {
  readonly name = "dedup";
  hits = 0;

  private pending?: string;
  private count = 0;
  private lastEmittedBlank = false;

  private isBlank(line: string): boolean {
    return line.trim() === "";
  }

  private emitPending(): string[] {
    if (this.pending === undefined) return [];
    const line = this.pending;
    const count = this.count;
    this.pending = undefined;
    this.count = 0;
    if (count <= 1) {
      this.lastEmittedBlank = false;
      return [line];
    }
    this.hits += count - 1;
    this.lastEmittedBlank = false;
    return [`${line}  (×${count})`];
  }

  push(line: string): string[] {
    if (this.isBlank(line)) {
      const flushed = this.emitPending();
      if (this.lastEmittedBlank) {
        this.hits += 1;
        return flushed;
      }
      this.lastEmittedBlank = true;
      return [...flushed, ""];
    }

    if (this.pending === undefined) {
      this.pending = line;
      this.count = 1;
      return [];
    }
    if (line === this.pending) {
      this.count += 1;
      return [];
    }
    const flushed = this.emitPending();
    this.pending = line;
    this.count = 1;
    return flushed;
  }

  flush(): string[] {
    return this.emitPending();
  }
}
