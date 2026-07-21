import assert from "node:assert/strict";
import test from "node:test";
import { AnsiReducer, stripAnsi } from "../extensions/compress/ansi.js";
import { ProgressReducer, isProgressLine } from "../extensions/compress/progress.js";
import { DedupReducer } from "../extensions/compress/dedup.js";
import { CommandFilterReducer, detectTool } from "../extensions/compress/filters.js";
import { isImportant } from "../extensions/compress/importance.js";
import { LineSplitter, collapseCarriageReturns } from "../extensions/compress/splitter.js";
import {
  buildReducerChain,
  forcesStructuredOutput,
  looksBinary,
  looksLikeJson,
  type LineReducer,
} from "../extensions/compress/index.js";
import type { CompressConfig } from "../extensions/config.js";

function runChain(chain: LineReducer[], lines: string[]): string[] {
  const out: string[] = [];
  const feed = (input: string[]) => {
    let current = input;
    for (const reducer of chain) {
      const next: string[] = [];
      for (const value of current) next.push(...reducer.push(value));
      current = next;
    }
    out.push(...current);
  };
  for (const line of lines) feed([line]);
  // Drain: flush each reducer through the remaining chain (dedup drains last).
  for (let i = 0; i < chain.length; i += 1) {
    let lines2 = chain[i].flush();
    for (let j = i + 1; j < chain.length; j += 1) {
      const next: string[] = [];
      for (const value of lines2) next.push(...chain[j].push(value));
      lines2 = next;
    }
    out.push(...lines2);
  }
  return out;
}

const SAFE: CompressConfig = { mode: "safe", minBytes: 0, commandFilters: true };
const AGGRESSIVE: CompressConfig = { mode: "aggressive", minBytes: 0, commandFilters: true };

test("stripAnsi removes SGR color and bare control chars", () => {
  assert.equal(stripAnsi("\u001b[31mred\u001b[0m"), "red");
  assert.equal(stripAnsi("plain"), "plain");
  assert.equal(stripAnsi("tab\there"), "tab\there");
});

test("AnsiReducer counts hits only when it changes a line", () => {
  const r = new AnsiReducer();
  assert.deepEqual(r.push("\u001b[32mok\u001b[0m"), ["ok"]);
  assert.deepEqual(r.push("plain"), ["plain"]);
  assert.equal(r.hits, 1);
});

test("isProgressLine matches bars, percents, spinners; not real content", () => {
  assert.equal(isProgressLine("=========>            45%"), true);
  assert.equal(isProgressLine("  75%"), true);
  assert.equal(isProgressLine("[====>   ] 50%"), true);
  assert.equal(isProgressLine("Compiling module foo"), false);
  assert.equal(isProgressLine("error: build failed"), false);
});

test("ProgressReducer keeps important lines even if progress-shaped", () => {
  const r = new ProgressReducer();
  assert.deepEqual(r.push("  50%"), []);
  assert.deepEqual(r.push("error 99% broken"), ["error 99% broken"]);
});

test("DedupReducer collapses consecutive duplicates and blank runs", () => {
  const r = new DedupReducer();
  const out: string[] = [];
  for (const line of ["a", "a", "a", "b", "", "", "c"]) out.push(...r.push(line));
  out.push(...r.flush());
  assert.deepEqual(out, ["a  (×3)", "b", "", "c"]);
});

test("isImportant flags errors, paths, test results, CJK", () => {
  assert.equal(isImportant("Error: something broke"), true);
  assert.equal(isImportant("src/foo.ts:42:7 bad"), true);
  assert.equal(isImportant("3 failing"), true);
  assert.equal(isImportant("编译失败"), true);
  assert.equal(isImportant("just a normal line"), false);
});

test("detectTool skips env prefixes and paths", () => {
  assert.equal(detectTool("npm install"), "npm");
  assert.equal(detectTool("FOO=1 BAR=2 pnpm i"), "pnpm");
  assert.equal(detectTool("/usr/bin/pip install x"), "pip");
});

test("CommandFilterReducer drops npm noise but keeps important", () => {
  const r = new CommandFilterReducer("npm install");
  // Genuine noise is dropped.
  assert.deepEqual(r.push("added 42 packages"), []);
  assert.deepEqual(r.push("audited 100 packages"), []);
  // Warnings are signal: importance guard keeps them even though npm-shaped.
  assert.deepEqual(r.push("npm warn deprecated foo"), ["npm warn deprecated foo"]);
  assert.deepEqual(r.push("real output line"), ["real output line"]);
});

test("collapseCarriageReturns keeps final visible segment", () => {
  assert.equal(collapseCarriageReturns("a\rb\rc"), "c");
  assert.equal(collapseCarriageReturns("done\r"), "done");
  assert.equal(collapseCarriageReturns("plain"), "plain");
});

test("LineSplitter splits on newline and holds partial line", () => {
  const s = new LineSplitter();
  assert.deepEqual(s.push("one\ntwo\nthr"), ["one", "two"]);
  assert.deepEqual(s.push("ee\n"), ["three"]);
  assert.deepEqual(s.flush(), []);
});

test("forcesStructuredOutput detects json flags", () => {
  assert.equal(forcesStructuredOutput("kubectl get pods -o json"), true);
  assert.equal(forcesStructuredOutput("npm ls --json"), true);
  assert.equal(forcesStructuredOutput("git status"), false);
});

test("looksLikeJson and looksBinary detect structured / binary", () => {
  assert.equal(looksLikeJson('{"a":1}'), true);
  assert.equal(looksLikeJson("  [1,2,3]"), true);
  assert.equal(looksLikeJson("plain text"), false);
  assert.equal(looksBinary("has\u0000nul"), true);
  assert.equal(looksBinary("clean"), false);
});

test("looksLikeJson does not misclassify bracketed log lines", () => {
  // Real JSON of both shapes.
  assert.equal(looksLikeJson('{"a":1}'), true);
  assert.equal(looksLikeJson("  [1,2,3]"), true);
  assert.equal(looksLikeJson("[]"), true);
  assert.equal(looksLikeJson("{}"), true);
  assert.equal(looksLikeJson('["x"]'), true);
  assert.equal(looksLikeJson("[-1]"), true);
  assert.equal(looksLikeJson("[true]"), true);
  // Common log prefixes must NOT be treated as JSON (they should compress).
  assert.equal(looksLikeJson("[INFO] starting up"), false);
  assert.equal(looksLikeJson("[WARN] disk almost full"), false);
  assert.equal(looksLikeJson("[ERROR] boom"), false);
  assert.equal(looksLikeJson("{ config loaded }"), false);
});

test("buildReducerChain: off empty, safe 3, aggressive 4", () => {
  assert.equal(buildReducerChain("npm i", { ...SAFE, mode: "off" }).length, 0);
  assert.deepEqual(
    buildReducerChain("npm i", SAFE).map((r) => r.name),
    ["ansi", "progress", "dedup"],
  );
  assert.deepEqual(
    buildReducerChain("npm i", AGGRESSIVE).map((r) => r.name),
    ["ansi", "progress", "filters", "dedup"],
  );
});

test("safe chain denoises but preserves errors", () => {
  const chain = buildReducerChain("npm install", SAFE);
  const input = [
    "\u001b[32minstalling\u001b[0m",
    "  10%",
    "  20%",
    "dup",
    "dup",
    "error: ENOENT missing file",
  ];
  const out = runChain(chain, input);
  assert.ok(out.includes("error: ENOENT missing file"));
  assert.ok(!out.some((l) => l.trim() === "10%"));
  assert.ok(out.some((l) => l.startsWith("dup")));
  assert.ok(!out.includes("\u001b[32minstalling\u001b[0m"));
});

test("safe chain is idempotent on its own output", () => {
  const input = [
    "\u001b[31mx\u001b[0m",
    "  50%",
    "same",
    "same",
    "",
    "",
    "tail",
  ];
  const once = runChain(buildReducerChain("build", SAFE), input);
  const twice = runChain(buildReducerChain("build", SAFE), once);
  assert.deepEqual(twice, once);
});
