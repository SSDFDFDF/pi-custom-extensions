import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { ShellOutputCapture } from "../extensions/output.js";
import type { CompressConfig } from "../extensions/config.js";

const OFF: CompressConfig = { mode: "off", minBytes: 0, commandFilters: true };
const SAFE: CompressConfig = { mode: "safe", minBytes: 0, commandFilters: true };

async function run(text: string, compress: CompressConfig, command = "run") {
  const capture = new ShellOutputCapture({ command, compress });
  await capture.append(text);
  return capture.finish();
}

async function runChunks(chunks: Array<string | Buffer>, compress: CompressConfig, command = "run") {
  const capture = new ShellOutputCapture({ command, compress });
  for (const chunk of chunks) await capture.append(chunk);
  return capture.finish();
}

test("mode off passes output through byte-for-byte", async () => {
  const input = "line one\nline two\nline three\n";
  const out = await run(input, OFF);
  assert.equal(out.content, input);
  assert.equal(out.reduction, undefined);
});

test("safe mode reduces noisy output and keeps errors", async () => {
  const noisy = [
    "\u001b[32mBuilding...\u001b[0m",
    "Progress 10%",
    "Progress 20%",
    "Progress 100%",
    "same line",
    "same line",
    "same line",
    "Error: something broke at src/app.ts:42:7",
    "",
    "",
    "",
    "done",
  ].join("\n") + "\n";
  const out = await run(noisy, SAFE);
  assert.ok(out.content.includes("Error: something broke at src/app.ts:42:7"));
  assert.ok(!out.content.includes("\u001b["));
  assert.ok(out.reduction);
  assert.equal(out.reduction?.passthrough, false);
  assert.ok(out.reduction!.outBytes < out.reduction!.rawBytes);
});

test("JSON output is passed through untouched even in safe mode", async () => {
  const json = '{"items":[1,2,3],"ok":true}\n';
  const out = await run(json, SAFE, "gh api repos --json name");
  assert.equal(out.content, json);
});

test("binary output (NUL) is passed through untouched", async () => {
  const bin = "abc\u0000def\n";
  const out = await run(bin, SAFE);
  assert.equal(out.content, bin);
});

test("small output under minBytes passes through", async () => {
  const cfg: CompressConfig = { mode: "safe", minBytes: 4096, commandFilters: true };
  const input = "\u001b[32mhi\u001b[0m\ntiny\n";
  const out = await run(input, cfg);
  assert.equal(out.content, input);
  assert.equal(out.reduction, undefined);
});

test("exit accounting unaffected: content is the only reduced surface", async () => {
  const input = "a\na\na\nb\n";
  const off = await run(input, OFF);
  const safe = await run(input, SAFE);
  assert.equal(off.content, input);
  assert.ok(safe.content.includes("(×3)"));
});

test("JSON split across a whitespace-only first chunk is passed through", async () => {
  const out = await runChunks([" \n", '{"items":[1,2,3],"ok":true}\n'], SAFE);
  assert.equal(out.content, ' \n{"items":[1,2,3],"ok":true}\n');
  assert.equal(out.reduction, undefined);
});

test("single-chunk JSON without --json flag is passed through", async () => {
  const json = '[1,2,3]\n';
  const out = await run(json, SAFE);
  assert.equal(out.content, json);
  assert.equal(out.reduction, undefined);
});

test("NUL in a later chunk still forces binary passthrough", async () => {
  // minBytes holds both chunks in the decision window so the late NUL is seen
  // before any reducer runs.
  const cfg: CompressConfig = { mode: "safe", minBytes: 4096, commandFilters: true };
  const out = await runChunks(["plain text line\n", "more\u0000data\n"], cfg);
  assert.equal(out.content, "plain text line\nmore\u0000data\n");
  assert.equal(out.reduction, undefined);
});

test("non-UTF-8 bytes are tee'd to the artifact byte-for-byte", async () => {
  const bytes = Buffer.from([0x61, 0xff, 0x00, 0x0a]);
  const capture = new ShellOutputCapture({ command: "run", compress: SAFE });
  await capture.append(bytes);
  const out = await capture.finish();
  assert.ok(out.fullOutputPath);
  const raw = readFileSync(out.fullOutputPath!);
  assert.deepEqual(raw, bytes);
});

test("reduction does not add a trailing newline to unterminated output", async () => {
  const out = await run("plain text", SAFE);
  assert.equal(out.content, "plain text");
});

test("bare-CR output keeps a recoverable artifact (no silent data loss)", async () => {
  // `printf 'a\rb\rc'` has no newline and no reducer hit, but the splitter
  // collapses it to `c`. The byte-faithful artifact must survive.
  const raw = "a\rb\rc";
  const capture = new ShellOutputCapture({ command: "run", compress: SAFE });
  await capture.append(raw);
  const out = await capture.finish();
  assert.equal(out.content, "c");
  assert.ok(out.fullOutputPath, "artifact must be retained when CR collapse alters content");
  assert.equal(readFileSync(out.fullOutputPath!, "utf8"), raw);
});

test("reduction preserves an existing trailing newline", async () => {
  const out = await run("\u001b[32mcolored\u001b[0m\nplain\n", SAFE);
  assert.ok(out.content.endsWith("\n"));
  assert.ok(!out.content.includes("\u001b["));
});

test("CRLF line endings are normalized to \\n by reduction", async () => {
  const out = await run("\u001b[32ma\u001b[0m\r\nb\r\n", SAFE);
  assert.equal(out.content, "a\nb\n");
});

test("unterminated final line survives a split across chunks", async () => {
  const out = await runChunks(["\u001b[32mfirst\u001b[0m\nlast pa", "rtial"], SAFE);
  assert.equal(out.content, "first\nlast partial");
});
