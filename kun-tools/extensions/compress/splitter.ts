/**
 * Splits a byte/char stream into logical lines. Handles `\n` terminators and
 * collapses `\r` cursor-overwrites within a line to the final visible segment
 * (progress bars emit `a\rb\rc` and only `c` is visible). Deterministic; holds
 * at most one partial line.
 */
export class LineSplitter {
  private buffer = "";
  /** Number of logical lines whose `\r` overwrites were collapsed away. */
  hits = 0;

  push(text: string): string[] {
    this.buffer += text;
    const lines: string[] = [];
    let index = this.buffer.indexOf("\n");
    while (index !== -1) {
      lines.push(this.collapse(this.buffer.slice(0, index)));
      this.buffer = this.buffer.slice(index + 1);
      index = this.buffer.indexOf("\n");
    }
    return lines;
  }

  flush(): string[] {
    if (this.buffer.length === 0) return [];
    const line = this.collapse(this.buffer);
    this.buffer = "";
    return [line];
  }

  /** Collapse one segment, counting a hit when it actually changed content. */
  private collapse(segment: string): string {
    const collapsed = collapseCarriageReturns(segment);
    if (collapsed !== segment) this.hits += 1;
    return collapsed;
  }
}

export function collapseCarriageReturns(segment: string): string {
  if (!segment.includes("\r")) return segment;
  const parts = segment.split("\r");
  let last = parts[parts.length - 1];
  // A trailing `\r` (e.g. "text\r") leaves an empty final segment; the visible
  // content is the segment before it.
  if (last === "" && parts.length > 1) last = parts[parts.length - 2];
  return last;
}
