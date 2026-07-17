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
  resolveQqbotProfile,
  resolveTelegramProfile,
  saveChannelsFile,
  updateQqbotAllowedOpenId,
  updateTelegramAllowedUserId,
  updateTelegramLastUpdateId,
  type LocalFile,
  type PiPromptContent,
} from "../../core/src/index.ts";
import { createTelegramAdapter } from "../../telegram/src/index.ts";
import { createQqbotAdapter } from "../../qqbot/src/index.ts";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { basename, isAbsolute, join, resolve } from "node:path";
import { access, readFile, stat } from "node:fs/promises";

const STATUS_KEY = "channels";

type ConnectedChannel = "telegram" | "qqbot";

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
 * Compact footer: `chan:tg` / `chan:qq` with colored channel id.
 * e.g. chan:tg | chan:qq 2 | chan:tg!
 */
function formatStatusLine(
  connected: ConnectedChannel | undefined,
  runtime: ChannelRuntime | undefined,
  theme?: ThemeLike,
): string | undefined {
  if (!connected || !runtime) return undefined;
  const snap = runtime.snapshot();
  const adapter = snap.adapters.find((item) => item.channelId === connected);
  const depth = snap.queued + (snap.activeTurn ? 1 : 0);
  const short = connected === "telegram" ? "tg" : "qq";

  const prefix = colorize(theme, "muted", "chan:");
  if (adapter?.state === "error") {
    return `${prefix}${colorize(theme, "error", `${short}!`)}`;
  }
  if (adapter?.state === "connecting") {
    return `${prefix}${colorize(theme, "warning", `${short}…`)}`;
  }
  const channel = colorize(theme, "success", short);
  return depth > 0
    ? `${prefix}${channel} ${colorize(theme, "dim", String(depth))}`
    : `${prefix}${channel}`;
}

const LOCK_PROFILE = "default";
const HEARTBEAT_MS = 15_000;

export default function piChannels(pi: ExtensionAPI) {
  const agentDir = resolveAgentDir();
  let runtime: ChannelRuntime | undefined;
  let connectedChannel: ConnectedChannel | undefined;
  let latestCtx: SessionCtx | undefined;
  let lockHeld = false;
  let lockChannelId: ConnectedChannel | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  const stopHeartbeat = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
  };

  const startHeartbeat = (instanceId: string, channelId: ConnectedChannel) => {
    stopHeartbeat();
    lockChannelId = channelId;
    lockHeld = true;
    heartbeatTimer = setInterval(() => {
      void heartbeatChannelLock({
        agentDir,
        channelId,
        profileId: LOCK_PROFILE,
        instanceId,
      }).then((ok) => {
        if (!ok && connectedChannel === channelId) {
          // Lost lock (stolen/force) — drop poll/gateway to avoid split-brain.
          void (async () => {
            try {
              await runtime?.getAdapter(channelId)?.disconnect("default");
            } catch {
              // ignore
            }
            connectedChannel = undefined;
            lockHeld = false;
            lockChannelId = undefined;
            stopHeartbeat();
            refreshStatus();
            console.error(
              `[pi-channels] lost connect lock; disconnected ${channelId}`,
            );
          })();
        }
      });
    }, HEARTBEAT_MS);
    heartbeatTimer.unref?.();
  };

  const releaseLockSafe = async (instanceId: string | undefined) => {
    stopHeartbeat();
    const channelId = lockChannelId;
    if (!lockHeld || !instanceId || !channelId) {
      lockHeld = false;
      lockChannelId = undefined;
      return;
    }
    try {
      await releaseChannelLock({
        agentDir,
        channelId,
        profileId: LOCK_PROFILE,
        instanceId,
      });
    } catch {
      // ignore
    }
    lockHeld = false;
    lockChannelId = undefined;
  };

  const refreshStatus = (ctx: SessionCtx | undefined = latestCtx) => {
    if (!ctx?.ui?.setStatus) return;
    ctx.ui.setStatus(
      STATUS_KEY,
      formatStatusLine(connectedChannel, runtime, ctx.ui.theme),
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
    // Progress policy: prefer whichever channel is configured; if both, union to progress when either wants it.
    const tg = await resolveTelegramProfile("default", agentDir);
    const qq = await resolveQqbotProfile("default", agentDir);
    const tgProg = tg.profile.progress;
    const qqProg = qq.profile.progress;
    const wantProgress =
      tgProg?.mode === "progress" || qqProg?.mode === "progress";
    const progress = {
      ...(tgProg ?? {}),
      ...(qqProg ?? {}),
      mode: (wantProgress ? "progress" : "off") as "progress" | "off",
      // QQ-friendly: don't thrash; adapter only materializes once anyway
      startDelayMs: Math.max(
        tgProg?.startDelayMs ?? 0,
        qqProg?.startDelayMs ?? 0,
        2500,
      ),
    };
    runtime = new ChannelRuntime({
      instanceId: `pi-${process.pid}-${randomUUID().slice(0, 8)}`,
      ports,
      progress,
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
      if (connectedChannel) {
        try {
          await runtime.getAdapter(connectedChannel)?.disconnect("default");
        } catch {
          // ignore
        }
      }
    }
    await releaseLockSafe(instanceId);
    latestCtx?.ui.setStatus(STATUS_KEY, undefined);
    connectedChannel = undefined;
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
      "Send one or more local files to the active channel (Telegram / QQ Bot). " +
      "During a channel-originated turn files are queued and delivered after the final reply; " +
      "otherwise they go to the last channel target. Telegram: photos/documents; QQ Bot: rich media upload (image/video/voice/file).",
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
          connectedChannel
            ? `active: ${connectedChannel}`
            : "active: none",
          lockHeld ? `lock: held (${lockChannelId ?? "?"})` : "lock: not held",
        ].join("\n"),
        "info",
      );
    },
  });

  pi.registerCommand("channel-setup", {
    description:
      "Save channel credentials. Telegram: /channel-setup <botToken> | QQ: /channel-setup qqbot <appId> <clientSecret>",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const head = (parts[0] ?? "").toLowerCase();

      // QQ Bot: /channel-setup qqbot <appId> <clientSecret> [sandbox]
      if (head === "qqbot" || head === "qq") {
        const appId = parts[1];
        const clientSecret = parts[2];
        const sandbox = parts.includes("sandbox");
        if (!appId || !clientSecret) {
          ctx.ui.notify(
            "usage: /channel-setup qqbot <appId> <clientSecret> [sandbox]\nwrites channels.qqbot.profiles.default",
            "error",
          );
          return;
        }
        const file = await loadChannelsFile(agentDir);
        const profiles = {
          ...(file.channels?.qqbot?.profiles ?? {}),
        };
        profiles.default = {
          ...(profiles.default ?? {}),
          enabled: true,
          appId,
          clientSecret,
          sandbox: sandbox || profiles.default?.sandbox,
          enableGroup: profiles.default?.enableGroup ?? false,
          render: profiles.default?.render ?? {
            finalFormat: "plain",
            sanitizeMarkdown: true,
            neutralizeMath: true,
            draftPreviews: false,
          },
          progress: profiles.default?.progress ?? {
            mode: "progress",
            startDelayMs: 2500,
            maxLines: 3,
            maxLineChars: 80,
            minEditIntervalMs: 2000,
          },
        };
        const path = await saveChannelsFile(
          {
            ...file,
            defaultChannel: file.defaultChannel ?? "qqbot",
            proactivePush: file.proactivePush ?? false,
            channels: {
              ...file.channels,
              qqbot: { profiles },
            },
          },
          agentDir,
        );
        ctx.ui.notify(
          `saved qqbot appId → ${path}${sandbox ? " (sandbox)" : ""}`,
          "info",
        );
        return;
      }

      // Telegram: /channel-setup <botToken>  or  /channel-setup telegram <botToken>
      const token =
        head === "telegram" || head === "tg" ? parts[1] : parts[0];
      if (!token || !token.includes(":")) {
        ctx.ui.notify(
          [
            "usage:",
            "  /channel-setup <telegramBotToken>",
            "  /channel-setup qqbot <appId> <clientSecret> [sandbox]",
          ].join("\n"),
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
      ctx.ui.notify(`saved telegram bot token → ${path}`, "info");
    },
  });

  pi.registerCommand("channel-connect", {
    description:
      "Connect channel: /channel-connect [telegram|qqbot] [force]",
    handler: async (args, ctx) => {
      if (!runtime) {
        ctx.ui.notify("pi-channels: runtime not started", "error");
        return;
      }
      latestCtx = ctx;
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const force =
        tokens.includes("force") ||
        tokens.includes("--force") ||
        tokens.includes("-f");
      const raw =
        tokens.find(
          (t) =>
            !["force", "--force", "-f"].includes(t.toLowerCase()),
        ) ?? "";
      let channel = raw.toLowerCase();
      if (!channel || channel === "default") {
        const file = await loadChannelsFile(agentDir);
        channel = (file.defaultChannel ?? "telegram").toLowerCase();
      }
      if (channel === "tg") channel = "telegram";
      if (channel === "qq") channel = "qqbot";

      if (channel !== "telegram" && channel !== "qqbot") {
        ctx.ui.notify(
          `unknown channel '${channel}'. use: telegram | qqbot`,
          "error",
        );
        return;
      }

      if (connectedChannel) {
        ctx.ui.notify(
          `${connectedChannel} already connected in this session (disconnect first)`,
          "info",
        );
        return;
      }

      if (channel === "telegram") {
        await connectTelegram({
          runtime,
          agentDir,
          pi,
          ctx,
          force,
          startHeartbeat,
          releaseLockSafe,
          markLockHeld: (channelId) => {
            lockHeld = true;
            lockChannelId = channelId;
          },
          setConnected: (v) => {
            connectedChannel = v;
          },
          refreshStatus,
        });
        return;
      }

      await connectQqbot({
        runtime,
        agentDir,
        pi,
        ctx,
        force,
        startHeartbeat,
        releaseLockSafe,
        markLockHeld: (channelId) => {
          lockHeld = true;
          lockChannelId = channelId;
        },
        setConnected: (v) => {
          connectedChannel = v;
        },
        refreshStatus,
      });
    },
  });

  pi.registerCommand("channel-disconnect", {
    description: "Disconnect active channel adapter and release lock",
    handler: async (_args, ctx) => {
      if (!runtime) {
        ctx.ui.notify("pi-channels: runtime not started", "error");
        return;
      }
      const instanceId = runtime.instanceId;
      const which = connectedChannel;
      if (which) {
        try {
          await runtime.getAdapter(which)?.disconnect("default");
        } catch {
          // ignore
        }
      }
      connectedChannel = undefined;
      await releaseLockSafe(instanceId);
      refreshStatus(ctx);
      ctx.ui.notify(
        which
          ? `${which} disconnected (lock released)`
          : "no channel connected (lock cleared)",
        "info",
      );
    },
  });
}

type ConnectHelpers = {
  runtime: ChannelRuntime;
  agentDir: string;
  pi: ExtensionAPI;
  // Pi command ctx — notify is present on channel commands
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any;
  force: boolean;
  startHeartbeat: (instanceId: string, channelId: ConnectedChannel) => void;
  releaseLockSafe: (instanceId: string | undefined) => Promise<void>;
  markLockHeld: (channelId: ConnectedChannel) => void;
  setConnected: (channel: ConnectedChannel | undefined) => void;
  refreshStatus: (ctx?: SessionCtx) => void;
};

async function connectTelegram(h: ConnectHelpers): Promise<void> {
  const { runtime, agentDir, pi, ctx, force } = h;
  const { profile, path } = await resolveTelegramProfile("default", agentDir);
  if (!profile.botToken) {
    ctx.ui.notify(
      `no botToken in ${path}\nrun: /channel-setup <token>`,
      "error",
    );
    return;
  }

  const sessionHint =
    typeof pi.getSessionName === "function" ? pi.getSessionName() : undefined;

  const lock = await acquireChannelLock({
    agentDir,
    channelId: "telegram",
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
          : "Holder looks dead/stale — retry or use: /channel-connect telegram force",
        "Steal only if sure: /channel-connect telegram force",
      ].join("\n"),
      "error",
    );
    return;
  }

  h.markLockHeld("telegram");

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
        await runtime.handleEvent(event);
        h.refreshStatus();
      },
    });
    h.setConnected("telegram");
    h.startHeartbeat(runtime.instanceId, "telegram");
    h.refreshStatus(ctx);
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
    await h.releaseLockSafe(runtime.instanceId);
    h.setConnected(undefined);
    ctx.ui.notify(
      `connect failed: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
}

async function connectQqbot(h: ConnectHelpers): Promise<void> {
  const { runtime, agentDir, pi, ctx, force } = h;
  const { profile, path } = await resolveQqbotProfile("default", agentDir);
  if (!profile.appId || !profile.clientSecret) {
    ctx.ui.notify(
      `no qqbot appId/clientSecret in ${path}\nrun: /channel-setup qqbot <appId> <clientSecret>`,
      "error",
    );
    return;
  }

  const sessionHint =
    typeof pi.getSessionName === "function" ? pi.getSessionName() : undefined;

  const lock = await acquireChannelLock({
    agentDir,
    channelId: "qqbot",
    profileId: LOCK_PROFILE,
    instanceId: runtime.instanceId,
    sessionHint: sessionHint || runtime.instanceId.slice(0, 16),
    botToken: `${profile.appId}:${profile.clientSecret.slice(0, 8)}`,
    force,
  });

  if (!lock.ok) {
    ctx.ui.notify(
      [
        "qqbot connect blocked: another session holds the gateway lock",
        formatLockHolder(lock.holder),
        `lock file: ${lock.path}`,
        lock.holderAlive && !lock.holderStale
          ? "In the other session run: /channel-disconnect"
          : "Holder looks dead/stale — retry or use: /channel-connect qqbot force",
        "Steal only if sure: /channel-connect qqbot force",
      ].join("\n"),
      "error",
    );
    return;
  }

  h.markLockHeld("qqbot");

  try {
    const adapter = createQqbotAdapter({
      appId: profile.appId,
      clientSecret: profile.clientSecret,
      allowedOpenId: profile.allowedOpenId,
      enableGroup: profile.enableGroup === true,
      sandbox: profile.sandbox === true,
      apiBase: profile.apiBase,
      render: profile.render,
      onPaired: async (openid) => {
        await updateQqbotAllowedOpenId(openid, "default", agentDir);
      },
      log: (message) => {
        console.error(`[pi-channels:qqbot] ${message}`);
      },
    });
    runtime.registerAdapter(adapter);
    await adapter.connect("default", {
      instanceId: runtime.instanceId,
      tempDir: join(agentDir, "tmp", "channels", "qqbot"),
      onEvent: async (event) => {
        await runtime.handleEvent(event);
        h.refreshStatus();
      },
    });
    h.setConnected("qqbot");
    h.startHeartbeat(runtime.instanceId, "qqbot");
    h.refreshStatus(ctx);
    ctx.ui.notify(
      [
        "qqbot connected (pi-channels)",
        `config: ${path}`,
        `lock: ${lock.path}`,
        force ? "lock: forced acquire" : "lock: acquired",
        profile.sandbox ? "env: sandbox" : "env: production",
        profile.enableGroup ? "group: enabled" : "group: c2c only",
        `render: ${profile.render?.finalFormat ?? "plain"} (plain default; compat→markdown)`,
        profile.allowedOpenId
          ? `owner openid: ${profile.allowedOpenId}`
          : "owner: first C2C pairs",
        "note: progress drafts off; passive replies use msg_id",
      ].join("\n"),
      "info",
    );
  } catch (error) {
    await h.releaseLockSafe(runtime.instanceId);
    h.setConnected(undefined);
    ctx.ui.notify(
      `qqbot connect failed: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
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
