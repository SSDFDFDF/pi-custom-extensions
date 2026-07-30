import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, initTheme } from "@earendil-works/pi-coding-agent";
import { executeShell, formatShellFooter, registerShellTool, resolveWorkdir } from "../extensions/shell.js";

// keyHint() reads the active theme; initialize once for render smoke tests.
initTheme();

/** Minimal theme stub: identity styling so assertions can match raw text. */
const themeStub = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as never;

/** Capture the inline shell tool definition via a mock registerTool. */
function captureShellTool() {
  let captured: any;
  registerShellTool({ registerTool: (tool: unknown) => { captured = tool; } } as never);
  return captured;
}

function renderContext(over: Record<string, unknown> = {}) {
  return {
    args: {},
    toolCallId: "t",
    invalidate: () => {},
    lastComponent: undefined,
    state: {},
    cwd: "/tmp",
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError: false,
    ...over,
  } as never;
}

async function run(command: string, root: string, timeoutMs?: number, workdir?: string) {
  return executeShell(
    { command, timeoutMs, workdir },
    undefined,
    { cwd: root } as Pick<ExtensionContext, "cwd">,
  );
}

test("executes a shell command and returns a structured footer", async () => {
  const root = await mkdtemp(join(tmpdir(), "kun-tools-shell-test-"));
  try {
    const result = await run("pwd", root);
    assert.equal(result.details.exitCode, 0);
    assert.equal(result.details.workdir, root);
    assert.match(result.content[0].text, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(result.content[0].text, /^---$/m);
    assert.match(result.content[0].text, /^exit: 0$/m);
    assert.match(result.content[0].text, /^duration_ms: \d+$/m);
    assert.match(result.content[0].text, /^timed_out: false$/m);
    assert.match(result.content[0].text, /^truncated: false$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("returns non-zero exit status with command output", async () => {
  const root = await mkdtemp(join(tmpdir(), "kun-tools-shell-test-"));
  try {
    const result = await run("printf 'failure\\n'; exit 7", root);
    assert.equal(result.details.exitCode, 7);
    assert.match(result.content[0].text, /failure/);
    assert.match(result.content[0].text, /^exit: 7$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("marks timed out commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "kun-tools-shell-test-"));
  try {
    const result = await run("sleep 1", root, 20);
    assert.equal(result.details.timedOut, true);
    assert.equal(result.details.exitCode, null);
    assert.match(result.content[0].text, /^timed_out: true$/m);
    assert.match(result.content[0].text, /^exit: unknown$/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("truncates large output and keeps a recoverable full log", async () => {
  const root = await mkdtemp(join(tmpdir(), "kun-tools-shell-test-"));
  try {
    const size = DEFAULT_MAX_BYTES + 4096;
    const result = await run(`node -e "process.stdout.write('START' + 'x'.repeat(${size}) + 'END')"`, root);
    assert.equal(result.details.truncated, true);
    assert.ok(result.details.fullOutputPath);
    assert.match(result.content[0].text, /START/);
    assert.match(result.content[0].text, /END/);
    assert.match(result.content[0].text, /Output truncated/);
    assert.match(result.content[0].text, /^truncated: true$/m);
    assert.match(result.content[0].text, new RegExp(`^full_output: ${result.details.fullOutputPath}$`, "m"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolves relative workdirs and rejects files", async () => {
  const root = await mkdtemp(join(tmpdir(), "kun-tools-shell-test-"));
  try {
    assert.equal(await resolveWorkdir(".", root), root);
    await writeFile(join(root, "file.txt"), "content");
    await assert.rejects(resolveWorkdir("file.txt", root), /not a directory/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects workdir outside the project root by default", async () => {
  const root = await mkdtemp(join(tmpdir(), "kun-tools-shell-test-"));
  const outside = await mkdtemp(join(tmpdir(), "kun-tools-shell-outside-"));
  const previous = process.env.KUN_ALLOW_OUTSIDE_WORKDIR;
  try {
    delete process.env.KUN_ALLOW_OUTSIDE_WORKDIR;
    await assert.rejects(resolveWorkdir(outside, root), /escapes the project root/);
    await assert.rejects(run("pwd", root, undefined, outside), /escapes the project root/);
  } finally {
    if (previous === undefined) delete process.env.KUN_ALLOW_OUTSIDE_WORKDIR;
    else process.env.KUN_ALLOW_OUTSIDE_WORKDIR = previous;
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("formatShellFooter is stable", () => {
  const footer = formatShellFooter({
    exitCode: 1,
    durationMs: 12,
    timedOut: false,
    truncated: true,
    fullOutputPath: "/tmp/out.log",
  });
  assert.equal(
    footer,
    ["---", "exit: 1", "duration_ms: 12", "timed_out: false", "truncated: true", "full_output: /tmp/out.log"].join("\n"),
  );
});

test("prompt guidance prefers shell while keeping overlapping built-ins as fallbacks", () => {
  const tool = captureShellTool();
  assert.ok(
    tool.promptGuidelines.some((guideline: string) =>
      guideline.includes("Prefer shell over bash, grep, find, and ls"),
    ),
  );
});

test("renderCall shows the command, not the full args JSON", () => {
  const tool = captureShellTool();
  const component = tool.renderCall({ command: "echo hi", timeoutMs: 5000 }, themeStub, renderContext());
  const lines = component.render(80);
  const text = lines.join("\n");
  assert.match(text, /\$ echo hi/);
  assert.ok(!text.includes("timeoutMs"));
  assert.ok(!text.includes("5000"));
});

test("renderResult collapses long output to a bounded preview with an expand hint", () => {
  const tool = captureShellTool();
  const body = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
  const result = { content: [{ type: "text", text: body }], details: {} };
  const component = tool.renderResult(result, { expanded: false, isPartial: false }, themeStub, renderContext());
  const lines = component.render(80);
  // Blank + hint + preview lines; must be far below the 200 input lines.
  assert.ok(lines.length <= 25, `collapsed render should be bounded, got ${lines.length}`);
  assert.ok(lines.some((l: string) => /earlier lines/.test(l)), "expects an expand hint");
  // The tail is preserved (most recent output stays visible).
  assert.ok(lines.some((l: string) => l.includes("line 199")));
});

test("renderResult expanded shows the full output", () => {
  const tool = captureShellTool();
  const body = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
  const result = { content: [{ type: "text", text: body }], details: {} };
  const component = tool.renderResult(result, { expanded: true, isPartial: false }, themeStub, renderContext({ expanded: true }));
  const lines = component.render(80);
  assert.ok(lines.some((l: string) => l.includes("line 0")));
  assert.ok(lines.some((l: string) => l.includes("line 199")));
  assert.ok(!lines.some((l: string) => /earlier lines/.test(l)));
});

test("renderResult with no output renders nothing extra", () => {
  const tool = captureShellTool();
  const result = { content: [{ type: "text", text: "" }], details: {} };
  const component = tool.renderResult(result, { expanded: false, isPartial: false }, themeStub, renderContext());
  const lines = component.render(80);
  assert.equal(lines.join("").trim(), "");
});
