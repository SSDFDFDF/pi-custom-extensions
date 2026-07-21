import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "../extensions/config.js";

function withTempConfig(fn: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "kun-tools-config-"));
  const path = join(dir, "kun-tools.config.json");
  const prev = process.env.KUN_TOOLS_CONFIG;
  process.env.KUN_TOOLS_CONFIG = path;
  try {
    fn(path);
  } finally {
    if (prev === undefined) delete process.env.KUN_TOOLS_CONFIG;
    else process.env.KUN_TOOLS_CONFIG = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("loadConfig returns defaults when file is missing", () => {
  withTempConfig(() => {
    assert.deepEqual(loadConfig(), DEFAULT_CONFIG);
  });
});

test("loadConfig merges partial file over defaults", () => {
  withTempConfig((path) => {
    writeFileSync(path, JSON.stringify({ compress: { mode: "safe" } }));
    const cfg = loadConfig();
    assert.equal(cfg.compress.mode, "safe");
    assert.equal(cfg.compress.minBytes, DEFAULT_CONFIG.compress.minBytes);
  });
});

test("loadConfig coerces invalid values back to defaults", () => {
  withTempConfig((path) => {
    writeFileSync(path, JSON.stringify({ compress: { mode: "bogus", minBytes: -1 } }));
    const cfg = loadConfig();
    assert.equal(cfg.compress.mode, "off");
    assert.equal(cfg.compress.minBytes, DEFAULT_CONFIG.compress.minBytes);
  });
});

test("saveConfig persists a patch and reloads it", () => {
  withTempConfig(() => {
    saveConfig({ compress: { mode: "aggressive", minBytes: 8192 } });
    const cfg = loadConfig();
    assert.equal(cfg.compress.mode, "aggressive");
    assert.equal(cfg.compress.minBytes, 8192);
    assert.equal(cfg.compress.commandFilters, DEFAULT_CONFIG.compress.commandFilters);
  });
});

test("corrupt JSON falls back to defaults", () => {
  withTempConfig((path) => {
    writeFileSync(path, "{ not valid json");
    assert.deepEqual(loadConfig(), DEFAULT_CONFIG);
  });
});

test("saveConfig leaves no temp files behind", () => {
  withTempConfig((path) => {
    saveConfig({ compress: { mode: "safe" } });
    const dir = dirname(path);
    const leftover = readdirSync(dir).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftover, []);
  });
});

test("saveConfig always produces parseable JSON (atomic replace)", () => {
  withTempConfig((path) => {
    saveConfig({ compress: { mode: "aggressive", minBytes: 4096 } });
    const raw = readFileSync(path, "utf8");
    assert.doesNotThrow(() => JSON.parse(raw));
    assert.equal(JSON.parse(raw).compress.mode, "aggressive");
  });
});

test("concurrent saveConfig writes keep the file well-formed", () => {
  withTempConfig((path) => {
    for (let i = 0; i < 20; i += 1) {
      saveConfig({ compress: { minBytes: i * 128 } });
      const raw = readFileSync(path, "utf8");
      assert.doesNotThrow(() => JSON.parse(raw));
    }
    assert.equal(loadConfig().compress.minBytes, 19 * 128);
  });
});
