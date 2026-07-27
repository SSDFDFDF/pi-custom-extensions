import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import kunTools, { handleCompress } from "../extensions/index.js";

function withTempConfig(fn: () => void) {
  const dir = mkdtempSync(join(tmpdir(), "kun-tools-index-"));
  const prev = process.env.KUN_TOOLS_CONFIG;
  process.env.KUN_TOOLS_CONFIG = join(dir, "kun-tools.config.json");
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.KUN_TOOLS_CONFIG;
    else process.env.KUN_TOOLS_CONFIG = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("activates the compact local tool surface and preserves unrelated tools", () => {
  const registered: string[] = [];
  const handlers = new Map<string, Array<(...args: never[]) => unknown>>();
  let active = ["read", "bash", "edit", "write", "grep", "find", "ls", "subagent", "web_search", "hypa_shell"];

  const pi = {
    registerTool(tool: { name: string }) {
      registered.push(tool.name);
    },
    registerCommand() {},
    on(event: string, handler: (...args: never[]) => unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    getActiveTools() {
      return [...active];
    },
    setActiveTools(names: string[]) {
      active = [...names];
    },
  } as unknown as ExtensionAPI;

  kunTools(pi);
  for (const handler of handlers.get("session_start") ?? []) handler();

  assert.deepEqual(registered, ["shell", "apply_patch"]);
  assert.deepEqual(active, ["read", "edit", "write", "subagent", "web_search", "hypa_shell", "shell", "apply_patch"]);
});

test("handleCompress sets valid modes", () => {
  withTempConfig(() => {
    assert.equal(handleCompress(["safe"]), "Compress mode set: safe");
    assert.equal(handleCompress(["aggressive"]), "Compress mode set: aggressive");
    assert.equal(handleCompress(["off"]), "Compress mode set: off");
  });
});

test("handleCompress rejects extra args after a mode", () => {
  withTempConfig(() => {
    assert.ok(handleCompress(["safe", "extra"]).startsWith("Usage:"));
  });
});

test("handleCompress min accepts only nonnegative decimal integers", () => {
  withTempConfig(() => {
    assert.equal(handleCompress(["min", "2048"]), "Compress minBytes set: 2048");
    assert.equal(handleCompress(["min", "0"]), "Compress minBytes set: 0");
    assert.ok(handleCompress(["min", "-1"]).startsWith("Usage:"));
    assert.ok(handleCompress(["min", "1.5"]).startsWith("Usage:"));
    assert.ok(handleCompress(["min", "0x10"]).startsWith("Usage:"));
    assert.ok(handleCompress(["min", "1e3"]).startsWith("Usage:"));
    assert.ok(handleCompress(["min"]).startsWith("Usage:"));
    assert.ok(handleCompress(["min", "10", "extra"]).startsWith("Usage:"));
  });
});

test("handleCompress filters requires an exact on|off token", () => {
  withTempConfig(() => {
    assert.equal(handleCompress(["filters", "on"]), "Compress commandFilters set: true");
    assert.equal(handleCompress(["filters", "off"]), "Compress commandFilters set: false");
    assert.ok(handleCompress(["filters", "true"]).startsWith("Usage:"));
    assert.ok(handleCompress(["filters"]).startsWith("Usage:"));
    assert.ok(handleCompress(["filters", "on", "extra"]).startsWith("Usage:"));
  });
});

test("handleCompress rejects unknown subcommands", () => {
  withTempConfig(() => {
    assert.ok(handleCompress(["bogus"]).startsWith("Usage:"));
  });
});

test("handleCompress status ignores no args but rejects extras", () => {
  withTempConfig(() => {
    assert.ok(handleCompress(["status"]).startsWith("Compress:"));
    assert.ok(handleCompress(["status", "extra"]).startsWith("Usage:"));
  });
});
