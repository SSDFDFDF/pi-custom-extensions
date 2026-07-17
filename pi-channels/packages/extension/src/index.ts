/**
 * pi-channels — Pi extension (greenfield multi-channel companion).
 *
 * Config: ~/.pi/agent/channels.json only.
 * Commands: /channel-connect | /channel-disconnect | /channel-status | /channel-setup
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  acquireChannelLock,
  ChannelRuntime,
  extractLatestAssistantText,
  formatLockHolder,
  guessMimeFromName,
  heartbeatChannelLock,
  loadChannelsFile,
  releaseChannelLock,
  resolveAgentDir,
  resolveTelegramProfile,
  saveChannelsFile,
  updateTelegramAllowedUserId,
  updateTelegramLastUpdateId,
  type LocalFile,
  type PiPromptContent,
} from "../../core/src/index.ts";
import { createTelegramAdapter } from "../../telegram/src/index.ts";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { basename, isAbsolute, join, resolve } from "node:path";
import { access, readFile, stat } from "node:fs/promises";

const STATUS_KEY = "channels";

type ThemeLike = {
  fg(token: string, text: string): string;
};

type SessionCtx = {
  isIdle(): boolean;
  hasPendingMessages(): boolean;
  abort(): void;
  ui: {
    setStatus(key: string, text: string | undefined): void;
    theme?: ThemeLike;
  };
};

/** Color token via theme.fg — always call as method so Theme keeps `this`. */
function colorize(
  theme: ThemeLike | undefined,
  token: string,
  text: string,
): string {
  if (!theme || typeof theme.fg !== "function") return text;
  try {
    return theme.fg(token, text);
  } catch {
    return text;
  }
}

/**
 * Compact footer: `chan:tg` with colored channel id.
 * e.g. chan:tg | chan:tg 2 | chan:tg!
 */
function formatStatusLine(
  connected: boolean,
  runtime: ChannelRuntime | undefined,
  theme?: ThemeLike,
): string | undefined {
  if (!connected || !runtime) return undefined;
  const snap = runtime.snapshot();
  const adapter = snap.adapters.find((item) => item.channelId === "telegram");
  const depth = snap.queued + (snap.activeTurn ? 1 : 0);

  const prefix = colorize(theme, "muted", "chan:");
  if (adapter?.state === "error") {
    return `${prefix}${colorize(theme, "error", "tg!")}`;
  }
  if (adapter?.state === "connecting") {
    return `${prefix}${colorize(theme, "warning", "tg…")}`;
  }
  const channel = colorize(theme, "success", "tg");
  return depth > 0
    ? `${prefix}${channel} ${colorize(theme, "dim", String(depth))}`
    : `${prefix}${channel}`;
}

const LOCK_CHANNEL = "telegram";
const LOCK_PROFILE = "default";
const HEARTBEAT_MS = 15_000;

export default function piChannels(pi: ExtensionAPI) {
  const agentDir = resolveAgentDir();
  let runtime: ChannelRuntime | undefined;
  let telegramConnected = false;
  let latestCtx: SessionCtx | undefined;
  let lockHeld = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  const stopHeartbeat = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
  };

  const startHeartbeat = (instanceId: string) => {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      void heartbeatChannelLock({
        agentDir,
        channelId: LOCK_CHANNEL,
        profileId: LOCK_PROFILE,
        instanceId,
      }).then((ok) => {
        if (!ok && telegramConnected) {
          // Lost lock (stolen/force) — drop poll to avoid split-brain.
          void (async () => {
            try {
              await runtime?.getAdapter("telegram")?.disconnect("default");
            } catch {
              // ignore
            }
            telegramConnected = false;
            lockHeld = false;
            stopHeartbeat();
            refreshStatus();
            console.error(
              "[pi-channels] lost connect lock; disconnected telegram poll",
            );
          })();
        }
      });
    }, HEARTBEAT_MS);
    heartbeatTimer.unref?.();
  };

  const releaseLockSafe = async (instanceId: string | undefined) => {
    stopHeartbeat();
    if (!lockHeld || !instanceId) {
      lockHeld = false;
      return;
    }
    try {
      await releaseChannelLock({
        agentDir,
        channelId: LOCK_CHANNEL,
        profileId: LOCK_PROFILE,
        instanceId,
      });
    } catch {
      // ignore
    }
    lockHeld = false;
  };

  const refreshStatus = (ctx: SessionCtx | undefined = latestCtx) => {
    if (!ctx?.ui?.setStatus) return;
    ctx.ui.setStatus(
      STATUS_KEY,
      formatStatusLine(telegramConnected, runtime, ctx.ui.theme),
    );
  };

  const ports = {
    isIdle: () => latestCtx?.isIdle() ?? true,
    hasPendingMessages: () => latestCtx?.hasPendingMessages() ?? false,
    sendUserMessage: async (
      content: PiPromptContent[],
      options?: { deliverAs?: "steer" | "followUp" },
    ) => {
      const payload = await toPiContent(content);
      pi.sendUserMessage(payload, {
        deliverAs: options?.deliverAs ?? "followUp",
      });
      refreshStatus();
    },
    abortActive: () => {
      latestCtx?.abort();
      refreshStatus();
    },
    log: (message: string) => {
      console.error(`[pi-channels] ${message}`);
    },
  };

  const bindCtx = (_event: unknown, ctx: SessionCtx) => {
    latestCtx = ctx;
    refreshStatus(ctx);
  };

  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx;
    const { profile } = await resolveTelegramProfile("default", agentDir);
    runtime = new ChannelRuntime({
      instanceId: `pi-${process.pid}-${randomUUID().slice(0, 8)}`,
      ports,
      progress: profile.progress,
    });
    refreshStatus(ctx);
  });

  pi.on("session_shutdown", async () => {
    const instanceId = runtime?.instanceId;
    if (runtime) {
      try {
        await runtime.shutdown();
      } catch {
        // ignore
      }
      if (telegramConnected) {
        try {
          await runtime.getAdapter("telegram")?.disconnect("default");
        } catch {
          // ignore
        }
      }
    }
    await releaseLockSafe(instanceId);
    latestCtx?.ui.setStatus(STATUS_KEY, undefined);
    telegramConnected = false;
    runtime = undefined;
    latestCtx = undefined;
  });

  pi.on("agent_start", (event, ctx) => {
    bindCtx(event, ctx);
    runtime?.onAgentStart();
    refreshStatus(ctx);
  });

  pi.on("agent_end", async (event, ctx) => {
    bindCtx(event, ctx);
    if (!runtime) return;
    // Buffer final text only; send on settled (retry-safe).
    const text = extractLatestAssistantText(event.messages ?? []);
    await runtime.onAgentEnd(text || undefined);
    refreshStatus(ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    bindCtx(_event, ctx);
    // Clear progress + deliver final + drain queue (P0).
    await runtime?.onAgentSettled();
    refreshStatus(ctx);
  });

  // OpenClaw-style tool progress lines on the single draft slot
  pi.on("tool_execution_start", async (event, ctx) => {
    bindCtx(event, ctx);
    await runtime?.onToolStart(event.toolName, event.args);
    refreshStatus(ctx);
  });

  // Keep idle signal + status fresh on common hooks
  pi.on("turn_start", bindCtx);
  pi.on("turn_end", bindCtx);

  pi.registerTool({
    name: "channel_attach",
    label: "Channel Attach",
    description:
      "Send one or more local files to the active channel (Telegram). " +
      "During a channel-originated turn files are queued and delivered after the final reply; " +
      "otherwise they go to the last channel target. Images are sent as photos; other files as documents.",
    parameters: Type.Object({
      paths: Type.Array(Type.String(), {
        description: "Absolute or cwd-relative file paths to send",
        minItems: 1,
      }),
      caption: Type.Optional(
        Type.String({
          description: "Optional caption applied to the first file",
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { paths: string[]; caption?: string },
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: { cwd: string },
    ) {
      if (!runtime) {
        return toolError("pi-channels runtime not started");
      }
      if (signal?.aborted) {
        return toolError("aborted");
      }
      try {
        const files: LocalFile[] = [];
        for (const [index, raw] of params.paths.entries()) {
          const path = resolvePath(raw, ctx.cwd);
          await access(path);
          const info = await stat(path);
          if (!info.isFile()) {
            return toolError(`not a file: ${path}`);
          }
          files.push({
            path,
            fileName: basename(path),
            mimeType: guessMimeFromName(basename(path)),
            ...(index === 0 && params.caption
              ? { caption: params.caption }
              : {}),
          });
        }
        const result = await runtime.attachFiles(files);
        const target = runtime.getActiveChannelTarget();
        return {
          content: [
            {
              type: "text" as const,
              text: `channel_attach ${result.mode}: ${result.count} file(s)${
                target
                  ? ` → ${target.channelId}/${JSON.stringify(target.address)}`
                  : ""
              }`,
            },
          ],
          details: { ...result, paths: files.map((file) => file.path) },
        };
      } catch (error) {
        return toolError(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  });

  pi.registerCommand("channel-status", {
    description: "pi-channels runtime + adapter status",
    handler: async (_args, ctx) => {
      if (!runtime) {
        ctx.ui.notify("pi-channels: no runtime (session not started)", "error");
        return;
      }
      const snap = runtime.snapshot();
      ctx.ui.notify(
        [
          "pi-channels",
          `instance: ${snap.instanceId}`,
          `sessionGen: ${snap.sessionGen}`,
          `queue: ${runtime.describeQueue()}`,
          `config: ${join(agentDir, "channels.json")}`,
          ...snap.adapters.map(
            (a) =>
              `- ${a.channelId}/${a.profileId}: ${a.state}${a.detail ? ` (${a.detail})` : ""}`,
          ),
          telegramConnected ? "telegram: connected" : "telegram: not connected",
          lockHeld ? "lock: held" : "lock: not held",
        ].join("\n"),
        "info",
      );
    },
  });

  pi.registerCommand("channel-setup", {
    description: "Save telegram bot token into channels.json",
    handler: async (args, ctx) => {
      const token = args.trim().split(/\s+/)[0];
      if (!token || !token.includes(":")) {
        ctx.ui.notify(
          "usage: /channel-setup <botToken>\nwrites channels.telegram.profiles.default.botToken",
          "error",
        );
        return;
      }
      const file = await loadChannelsFile(agentDir);
      const profiles = {
        ...(file.channels?.telegram?.profiles ?? {}),
      };
      profiles.default = {
        ...(profiles.default ?? {}),
        enabled: true,
        botToken: token,
        render: profiles.default?.render ?? {
          finalFormat: "compat",
          sanitizeMarkdown: true,
          neutralizeMath: true,
          draftPreviews: false,
        },
      };
      const path = await saveChannelsFile(
        {
          ...file,
          defaultChannel: file.defaultChannel ?? "telegram",
          proactivePush: file.proactivePush ?? true,
          channels: {
            ...file.channels,
            telegram: { profiles },
          },
        },
        agentDir,
      );
      ctx.ui.notify(`saved bot token → ${path}`, "info");
    },
  });

  pi.registerCommand("channel-connect", {
    description:
      "Connect telegram (default profile). Optional: force — steal lock from another session",
    handler: async (args, ctx) => {
      if (!runtime) {
        ctx.ui.notify("pi-channels: runtime not started", "error");
        return;
      }
      latestCtx = ctx;
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const channel = (tokens[0] || "telegram").toLowerCase();
      const force =
        tokens.includes("force") ||
        tokens.includes("--force") ||
        tokens.includes("-f");
      if (channel !== "telegram" && channel !== "force" && channel !== "--force" && channel !== "-f") {
        ctx.ui.notify(`only telegram in phase1 (got ${channel})`, "error");
        return;
      }
      if (telegramConnected) {
        ctx.ui.notify("telegram already connected in this session", "info");
        return;
      }

      const { profile, path } = await resolveTelegramProfile(
        "default",
        agentDir,
      );
      if (!profile.botToken) {
        ctx.ui.notify(
          `no botToken in ${path}\nrun: /channel-setup <token>`,
          "error",
        );
        return;
      }

      const sessionHint =
        typeof pi.getSessionName === "function"
          ? pi.getSessionName()
          : undefined;

      const lock = await acquireChannelLock({
        agentDir,
        channelId: LOCK_CHANNEL,
        profileId: LOCK_PROFILE,
        instanceId: runtime.instanceId,
        sessionHint: sessionHint || runtime.instanceId.slice(0, 16),
        botToken: profile.botToken,
        force,
      });

      if (!lock.ok) {
        ctx.ui.notify(
          [
            "telegram connect blocked: another session holds the poll lock",
            formatLockHolder(lock.holder),
            `lock file: ${lock.path}`,
            lock.holderAlive && !lock.holderStale
              ? "In the other session run: /channel-disconnect"
              : "Holder looks dead/stale — retry or use: /channel-connect force",
            "Steal only if sure: /channel-connect force",
          ].join("\n"),
          "error",
        );
        return;
      }

      lockHeld = true;

      try {
        const adapter = createTelegramAdapter({
          botToken: profile.botToken,
          allowedUserId: profile.allowedUserId,
          lastUpdateId: profile.lastUpdateId,
          render: profile.render,
          onPaired: async (userId) => {
            await updateTelegramAllowedUserId(userId, "default", agentDir);
          },
          onOffset: async (lastUpdateId) => {
            await updateTelegramLastUpdateId(lastUpdateId, "default", agentDir);
          },
        });
        runtime.registerAdapter(adapter);
        await adapter.connect("default", {
          instanceId: runtime.instanceId,
          tempDir: join(agentDir, "tmp", "channels", "telegram"),
          onEvent: async (event) => {
            await runtime?.handleEvent(event);
            refreshStatus();
          },
        });
        telegramConnected = true;
        startHeartbeat(runtime.instanceId);
        refreshStatus(ctx);
        ctx.ui.notify(
          [
            "telegram connected (pi-channels)",
            `config: ${path}`,
            `lock: ${lock.path}`,
            force ? "lock: forced acquire" : "lock: acquired",
            `render: ${profile.render?.finalFormat ?? "compat"}`,
            profile.allowedUserId
              ? `owner: ${profile.allowedUserId}`
              : "owner: first DM pairs",
          ].join("\n"),
          "info",
        );
      } catch (error) {
        await releaseLockSafe(runtime.instanceId);
        telegramConnected = false;
        ctx.ui.notify(
          `connect failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });

  pi.registerCommand("channel-disconnect", {
    description: "Disconnect telegram adapter and release poll lock",
    handler: async (_args, ctx) => {
      if (!runtime) {
        ctx.ui.notify("pi-channels: runtime not started", "error");
        return;
      }
      const instanceId = runtime.instanceId;
      try {
        await runtime.getAdapter("telegram")?.disconnect("default");
      } catch {
        // ignore
      }
      telegramConnected = false;
      await releaseLockSafe(instanceId);
      refreshStatus(ctx);
      ctx.ui.notify("telegram disconnected (lock released)", "info");
    },
  });
}

async function toPiContent(
  content: PiPromptContent[],
): Promise<
  string | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>
> {
  const hasImage = content.some((block) => block.type === "image");
  if (!hasImage) {
    return content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("\n");
  }

  const parts: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  > = [];
  for (const block of content) {
    if (block.type === "text") {
      parts.push({ type: "text", text: block.text });
      continue;
    }
    try {
      const buf = await readFile(block.path);
      parts.push({
        type: "image",
        data: buf.toString("base64"),
        mimeType:
          block.mimeType ??
          guessMimeFromName(block.path) ??
          "image/png",
      });
    } catch {
      parts.push({ type: "text", text: `[image missing: ${block.path}]` });
    }
  }
  return parts;
}

function resolvePath(raw: string, cwd: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("empty path");
  return isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
}

function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    details: { error: message },
    isError: true,
  };
}
