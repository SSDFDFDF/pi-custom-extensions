import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type CompressMode = "off" | "safe" | "aggressive";

export interface CompressConfig {
  mode: CompressMode;
  minBytes: number;
  commandFilters: boolean;
}

export interface KunToolsConfig {
  compress: CompressConfig;
}

export const DEFAULT_CONFIG: KunToolsConfig = {
  compress: { mode: "off", minBytes: 2048, commandFilters: true },
};

export function configPath(): string {
  const override = process.env.KUN_TOOLS_CONFIG?.trim();
  if (override) return override;
  return join(homedir(), ".pi", "agent", "kun-tools.config.json");
}

function coerceMode(value: unknown): CompressMode {
  return value === "safe" || value === "aggressive" || value === "off"
    ? value
    : DEFAULT_CONFIG.compress.mode;
}

function coerceMinBytes(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : DEFAULT_CONFIG.compress.minBytes;
}

function coerceBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function loadConfig(): KunToolsConfig {
  try {
    const raw = readFileSync(configPath(), "utf8");
    const parsed = JSON.parse(raw) as { compress?: Partial<CompressConfig> };
    const compress = parsed.compress ?? {};
    return {
      compress: {
        mode: coerceMode(compress.mode),
        minBytes: coerceMinBytes(compress.minBytes),
        commandFilters: coerceBool(compress.commandFilters, DEFAULT_CONFIG.compress.commandFilters),
      },
    };
  } catch {
    return { compress: { ...DEFAULT_CONFIG.compress } };
  }
}

export function saveConfig(patch: { compress?: Partial<CompressConfig> }): KunToolsConfig {
  const current = loadConfig();
  const merged: KunToolsConfig = {
    compress: { ...current.compress, ...(patch.compress ?? {}) },
  };
  merged.compress.mode = coerceMode(merged.compress.mode);
  merged.compress.minBytes = coerceMinBytes(merged.compress.minBytes);
  merged.compress.commandFilters = coerceBool(
    merged.compress.commandFilters,
    DEFAULT_CONFIG.compress.commandFilters,
  );
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  // Atomic replace: write a uniquely named temp file in the same directory,
  // then rename over the destination so a crash never leaves partial JSON.
  const tmp = join(dirname(path), `.kun-tools.config.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best-effort cleanup; surface the original write error
    }
    throw error;
  }
  return merged;
}
