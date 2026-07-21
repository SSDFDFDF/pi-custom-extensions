export interface LineReducer {
  readonly name: string;
  /** Feed one logical line (without trailing newline). Returns 0..n output lines. */
  push(line: string): string[];
  /** Drain any buffered state at end of stream. Returns 0..n output lines. */
  flush(): string[];
  /** Number of input lines this reducer removed or collapsed away. */
  readonly hits: number;
}

export interface ReductionStats {
  rawBytes: number;
  rawLines: number;
  outBytes: number;
  outLines: number;
  approxTokensBefore: number;
  approxTokensAfter: number;
  stages: string[];
  passthrough: boolean;
}
