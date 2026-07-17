/**
 * channels.json — sole config surface for pi-channels.
 * No legacy telegram.json import path.
 */

import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import type { ProfileId, ProgressPolicy, RenderPolicy } from "./types.ts";
import { normalizeProgressPolicy } from "./progress.ts";

export interface TelegramProfileConfig {
  enabled?: boolean;
  botToken?: string;
  allowedUserId?: number | string;
  lastUpdateId?: number;
  render?: Partial<RenderPolicy>;
  /** OpenClaw-style single-slot tool/status draft */
  progress?: Partial<ProgressPolicy>;
}

export interface ChannelsFile {
  defaultChannel?: string;
  proactivePush?: boolean;
  channels?: {
    telegram?: {
      profiles?: Record<string, TelegramProfileConfig>;
    };
    [channelId: string]:
      | {
          profiles?: Record<string, Record<string, unknown>>;
        }
      | undefined;
  };
}

export const DEFAULT_RENDER_POLICY: RenderPolicy = {
  finalFormat: "compat",
  sanitizeMarkdown: true,
  neutralizeMath: true,
  draftPreviews: false,
};

export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.PI_CODING_AGENT_DIR?.trim();
  if (fromEnv) return fromEnv;
  return join(homedir(), ".pi", "agent");
}

export function channelsConfigPath(agentDir?: string): string {
  return join(agentDir ?? resolveAgentDir(), "channels.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function normalizeRenderPolicy(
  partial?: Partial<RenderPolicy>,
): RenderPolicy {
  const base = { ...DEFAULT_RENDER_POLICY };
  if (!partial) return base;
  if (
    partial.finalFormat === "native" ||
    partial.finalFormat === "compat" ||
    partial.finalFormat === "plain"
  ) {
    base.finalFormat = partial.finalFormat;
  }
  if (typeof partial.sanitizeMarkdown === "boolean") {
    base.sanitizeMarkdown = partial.sanitizeMarkdown;
  }
  if (typeof partial.neutralizeMath === "boolean") {
    base.neutralizeMath = partial.neutralizeMath;
  }
  if (typeof partial.draftPreviews === "boolean") {
    base.draftPreviews = partial.draftPreviews;
  }
  return base;
}

export async function loadChannelsFile(
  agentDir?: string,
): Promise<ChannelsFile> {
  const path = channelsConfigPath(agentDir);
  try {
    const text = await readFile(path, "utf8");
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? (parsed as ChannelsFile) : {};
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? (error as { code?: string }).code
        : undefined;
    if (code === "ENOENT") return {};
    throw error;
  }
}

export async function saveChannelsFile(
  file: ChannelsFile,
  agentDir?: string,
): Promise<string> {
  const path = channelsConfigPath(agentDir);
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const body = `${JSON.stringify(file, null, "\t")}\n`;
  await writeFile(temp, body, { encoding: "utf8", mode: 0o600 });
  await chmod(temp, 0o600).catch(() => undefined);
  await rename(temp, path);
  await chmod(path, 0o600).catch(() => undefined);
  return path;
}

export async function resolveTelegramProfile(
  profileId: ProfileId = "default",
  agentDir?: string,
): Promise<{ profile: TelegramProfileConfig; path: string }> {
  const path = channelsConfigPath(agentDir);
  const file = await loadChannelsFile(agentDir);
  const fromChannels = file.channels?.telegram?.profiles?.[profileId];
  if (!fromChannels) {
    return {
      profile: { enabled: false, render: normalizeRenderPolicy() },
      path,
    };
  }
  return {
    profile: {
      ...fromChannels,
      render: normalizeRenderPolicy(fromChannels.render),
      progress: normalizeProgressPolicy(fromChannels.progress),
    },
    path,
  };
}

/** Persist lastUpdateId for a telegram profile without clobbering other keys. */
export async function updateTelegramLastUpdateId(
  lastUpdateId: number,
  profileId: ProfileId = "default",
  agentDir?: string,
): Promise<void> {
  const file = await loadChannelsFile(agentDir);
  const profiles = {
    ...(file.channels?.telegram?.profiles ?? {}),
  };
  const current = profiles[profileId] ?? {};
  profiles[profileId] = { ...current, lastUpdateId };
  const next: ChannelsFile = {
    ...file,
    channels: {
      ...file.channels,
      telegram: {
        ...(file.channels?.telegram ?? {}),
        profiles,
      },
    },
  };
  await saveChannelsFile(next, agentDir);
}

/** Persist allowedUserId after first pairing. */
export async function updateTelegramAllowedUserId(
  allowedUserId: number | string,
  profileId: ProfileId = "default",
  agentDir?: string,
): Promise<void> {
  const file = await loadChannelsFile(agentDir);
  const profiles = {
    ...(file.channels?.telegram?.profiles ?? {}),
  };
  const current = profiles[profileId] ?? {};
  profiles[profileId] = { ...current, allowedUserId };
  const next: ChannelsFile = {
    ...file,
    channels: {
      ...file.channels,
      telegram: {
        ...(file.channels?.telegram ?? {}),
        profiles,
      },
    },
  };
  await saveChannelsFile(next, agentDir);
}
