import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import type { CompressConfig } from "./config.js";
import {
  buildReducerChain,
  forcesStructuredOutput,
  looksBinary,
  looksLikeJson,
  type LineReducer,
  type ReductionStats,
} from "./compress/index.js";
import { LineSplitter } from "./compress/splitter.js";

const HEAD_LINES = Math.floor(DEFAULT_MAX_LINES / 5);
const TAIL_LINES = DEFAULT_MAX_LINES - HEAD_LINES - 5;
const HEAD_BYTES = Math.floor(DEFAULT_MAX_BYTES / 5);
const TAIL_BYTES = DEFAULT_MAX_BYTES - HEAD_BYTES - 128;

export interface CapturedOutput {
  content: string;
  truncation?: TruncationResult;
  fullOutputPath?: string;
  reduction?: ReductionStats;
}

export interface CaptureOptions {
  command: string;
  compress: CompressConfig;
}

function utf8Head(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, middle), "utf8") <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low);
}

function utf8Tail(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (Buffer.byteLength(text.slice(middle), "utf8") <= maxBytes) high = middle;
    else low = middle + 1;
  }
  return text.slice(low);
}

export class ShellOutputCapture {
  private readonly directoryPromise = mkdtemp(join(tmpdir(), "kun-tools-shell-"));
  private streamPromise?: Promise<ReturnType<typeof createWriteStream>>;
  private smallOutput = "";
  private oversized = false;
  private lineBuffer = "";
  private readonly headLines: string[] = [];
  private readonly tailLines: string[] = [];
  private totalBytes = 0;
  private totalLines = 0;

  // Reduction state (presented = possibly reduced; raw = always tee'd untouched).
  private readonly reduceEnabled: boolean;
  private readonly minBytes: number;
  private readonly splitter = new LineSplitter();
  private readonly chain: LineReducer[];
  private sawNul = false;
  private rawEndedWithNewline = false;
  private decided = false;
  private passthrough = false;
  private reductionActive = false;
  private holdBuffer = "";
  private holdBytes = 0;
  private rawBytes = 0;
  private rawLines = 0;
  private reducedBytes = 0;
  private reducedLines = 0;

  constructor(options?: CaptureOptions) {
    const cfg = options?.compress;
    const command = options?.command ?? "";
    this.minBytes = cfg?.minBytes ?? 0;
    if (cfg && cfg.mode !== "off" && !forcesStructuredOutput(command)) {
      this.chain = buildReducerChain(command, cfg);
      this.reduceEnabled = this.chain.length > 0;
    } else {
      this.chain = [];
      this.reduceEnabled = false;
    }
  }

  private async stream() {
    if (!this.streamPromise) {
      this.streamPromise = this.directoryPromise.then((directory) =>
        createWriteStream(join(directory, "output.log"), { encoding: "utf8" }),
      );
    }
    return this.streamPromise;
  }

  private recordLine(line: string) {
    this.totalLines += 1;
    if (this.headLines.length < HEAD_LINES) this.headLines.push(line);
    this.tailLines.push(line);
    if (this.tailLines.length > TAIL_LINES) this.tailLines.shift();
  }

  private recordForTruncation(chunk: string) {
    let text = this.lineBuffer + chunk;
    let newlineIndex = text.indexOf("\n");
    while (newlineIndex !== -1) {
      this.recordLine(text.slice(0, newlineIndex + 1));
      text = text.slice(newlineIndex + 1);
      newlineIndex = text.indexOf("\n");
    }
    this.lineBuffer = text;
  }

  /** Feed one chunk of presented (already-reduced or raw) text into accounting. */
  private accountText(text: string) {
    if (!text) return;
    this.totalBytes += Buffer.byteLength(text, "utf8");
    const nextSmallOutput = this.oversized ? undefined : this.smallOutput + text;
    if (
      nextSmallOutput !== undefined &&
      this.totalBytes <= DEFAULT_MAX_BYTES &&
      (nextSmallOutput.match(/\n/g)?.length ?? 0) <= DEFAULT_MAX_LINES
    ) {
      this.smallOutput = nextSmallOutput;
      return;
    }
    if (!this.oversized) {
      this.oversized = true;
      this.recordForTruncation(this.smallOutput);
      this.smallOutput = "";
    }
    this.recordForTruncation(text);
  }

  /** Push one logical line through the full reducer chain. */
  private pushThroughChain(line: string): string[] {
    let current = [line];
    for (const reducer of this.chain) {
      const next: string[] = [];
      for (const value of current) next.push(...reducer.push(value));
      current = next;
    }
    return current;
  }

  private emitReduced(line: string) {
    const withNewline = `${line}\n`;
    this.reducedBytes += Buffer.byteLength(withNewline, "utf8");
    this.reducedLines += 1;
    this.accountText(withNewline);
  }

  private runLines(lines: string[]) {
    for (const line of lines) {
      for (const out of this.pushThroughChain(line)) this.emitReduced(out);
    }
  }

  private reduceInto(text: string) {
    this.runLines(this.splitter.push(text));
  }

  /** Drain splitter tail then flush every reducer in order (dedup drains last). */
  private drainChain() {
    this.runLines(this.splitter.flush());
    for (let i = 0; i < this.chain.length; i += 1) {
      let lines = this.chain[i].flush();
      for (let j = i + 1; j < this.chain.length; j += 1) {
        const next: string[] = [];
        for (const value of lines) next.push(...this.chain[j].push(value));
        lines = next;
      }
      for (const line of lines) this.emitReduced(line);
    }
  }

  private ingest(text: string) {
    if (!this.reduceEnabled) {
      this.accountText(text);
      return;
    }
    if (this.decided) {
      if (this.passthrough) this.accountText(text);
      else this.reduceInto(text);
      return;
    }

    this.holdBuffer += text;
    this.holdBytes += Buffer.byteLength(text, "utf8");

    // Binary anywhere in the held prefix => pass everything through untouched.
    if (this.sawNul || looksBinary(this.holdBuffer)) {
      this.decidePassthrough();
      return;
    }

    // Classify JSON only once a non-whitespace byte is available, so the
    // decision never depends on how chunks split across whitespace/BOM.
    const trimmed = this.holdBuffer.replace(/^\uFEFF/, "").trimStart();
    if (trimmed.length === 0) return;
    if (looksLikeJson(this.holdBuffer)) {
      this.decidePassthrough();
      return;
    }

    if (this.holdBytes >= this.minBytes) {
      this.decided = true;
      this.reductionActive = true;
      const held = this.holdBuffer;
      this.holdBuffer = "";
      this.reduceInto(held);
    }
  }

  private decidePassthrough() {
    this.decided = true;
    this.passthrough = true;
    const held = this.holdBuffer;
    this.holdBuffer = "";
    this.accountText(held);
  }

  /**
   * Reduction re-emits each logical line with a trailing `\n`. When the raw
   * stream did not end with a newline, drop the one synthetic terminator so a
   * command like `printf foo` is presented as `foo`, not `foo\n`.
   */
  private stripReducedTail(content: string): string {
    if (this.reductionActive && !this.rawEndedWithNewline && content.endsWith("\n")) {
      return content.slice(0, -1);
    }
    return content;
  }

  async append(chunk: string | Buffer) {
    const isBuffer = Buffer.isBuffer(chunk);
    const byteLen = isBuffer ? chunk.length : Buffer.byteLength(chunk, "utf8");
    if (byteLen === 0) return;
    const text = isBuffer ? chunk.toString("utf8") : chunk;

    const stream = await this.stream();
    // Tee the ORIGINAL bytes so the artifact stays byte-for-byte faithful,
    // even for non-UTF-8 / binary output.
    if (!stream.write(chunk)) await once(stream, "drain");

    this.rawBytes += byteLen;
    this.rawLines += text.match(/\n/g)?.length ?? 0;
    if (text.length > 0) this.rawEndedWithNewline = text.endsWith("\n");
    if (!this.sawNul && (isBuffer ? chunk.includes(0) : text.includes("\u0000"))) {
      this.sawNul = true;
    }
    this.ingest(text);
  }

  async finish(): Promise<CapturedOutput> {
    // Resolve any pending reduction decision at end of stream.
    if (this.reduceEnabled && !this.decided) {
      // Never crossed minBytes: treat as small, pass through untouched.
      this.passthrough = true;
      this.accountText(this.holdBuffer);
      this.holdBuffer = "";
    } else if (this.reduceEnabled && this.decided && !this.passthrough) {
      this.drainChain();
    }

    const stream = await this.stream();
    stream.end();
    await once(stream, "close");

    const directory = await this.directoryPromise;
    const fullOutputPath = join(directory, "output.log");

    const reduction: ReductionStats | undefined = this.reductionActive
      ? {
          rawBytes: this.rawBytes,
          rawLines: this.rawLines,
          outBytes: this.reducedBytes,
          outLines: this.reducedLines,
          approxTokensBefore: Math.ceil(this.rawBytes / 4),
          approxTokensAfter: Math.ceil(this.reducedBytes / 4),
          stages: this.chain.filter((reducer) => reducer.hits > 0).map((reducer) => reducer.name),
          passthrough: false,
        }
      : undefined;

    if (!this.oversized) {
      const content = this.stripReducedTail(this.smallOutput);
      // Keep the raw artifact when reduction happened so full output stays recoverable.
      if (reduction && reduction.stages.length > 0) {
        return { content, fullOutputPath, reduction };
      }
      // Binary passthrough is lossy in the presented text (UTF-8 decode), and
      // the splitter's CR/CRLF collapse rewrites content without a reducer hit
      // (e.g. `printf 'a\rb\rc'` -> `c`). In both cases keep the byte-faithful
      // artifact so nothing becomes unrecoverable.
      if (this.sawNul || this.splitter.hits > 0) {
        return { content, fullOutputPath };
      }
      await rm(directory, { recursive: true, force: true });
      return { content };
    }

    if (this.lineBuffer.length > 0) {
      this.recordLine(this.lineBuffer);
      this.lineBuffer = "";
    }

    const tailStartLine = Math.max(1, this.totalLines - this.tailLines.length + 1);
    const nonOverlappingTail =
      this.totalBytes > DEFAULT_MAX_BYTES
        ? this.tailLines
        : this.tailLines.slice(Math.max(0, this.headLines.length - tailStartLine + 1));
    const rawHead = this.headLines.join("");
    const rawTail = nonOverlappingTail.join("");
    const head = utf8Head(rawHead, HEAD_BYTES);
    const tail = utf8Tail(rawTail, TAIL_BYTES);
    const separator = head && tail ? "\n... output omitted ...\n" : "";
    const content = this.stripReducedTail(`${head}${separator}${tail}`);
    const outputBytes = Buffer.byteLength(content, "utf8");
    const outputLines = content.length === 0 ? 0 : content.split("\n").length;
    const truncation: TruncationResult = {
      content,
      truncated: true,
      truncatedBy: this.totalBytes > DEFAULT_MAX_BYTES ? "bytes" : "lines",
      totalLines: this.totalLines,
      totalBytes: this.totalBytes,
      outputLines,
      outputBytes,
      lastLinePartial: false,
      firstLineExceedsLimit: false,
      maxLines: DEFAULT_MAX_LINES,
      maxBytes: DEFAULT_MAX_BYTES,
    };

    return {
      content: `${content}\n\n[Output truncated: showing ${outputLines} of ${this.totalLines} lines (${formatSize(outputBytes)} of ${formatSize(this.totalBytes)}). Full output: ${fullOutputPath}]`,
      truncation,
      fullOutputPath,
      reduction,
    };
  }
}
