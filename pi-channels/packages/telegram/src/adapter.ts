/**
 * Telegram ChannelAdapter — solo DM, media ingest, progress drafts,
 * compat HTML finals with reply anchors, serial transport + retry.
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";

import type {
  AdapterStatus,
  AttachmentKind,
  ChannelAdapter,
  ChannelAttachment,
  ChannelEvent,
  ChannelTarget,
  DeliveryFence,
  DeliveryResult,
  OutboundIntent,
  ProfileId,
  RenderPolicy,
  TransportOwner,
} from "../../core/src/index.ts";
import {
  DEFAULT_RENDER_POLICY,
  normalizeRenderPolicy,
} from "../../core/src/index.ts";

import { markdownToTelegramHtml } from "./render-html.ts";
import { TelegramTransport } from "./transport.ts";

const FILE_MAX_BYTES = 50 * 1024 * 1024;

export interface TelegramAdapterOptions {
  profileId?: ProfileId;
  botToken: string;
  allowedUserId?: number | string;
  render?: Partial<RenderPolicy>;
  lastUpdateId?: number;
  onPaired?: (userId: number) => void | Promise<void>;
  onOffset?: (lastUpdateId: number) => void | Promise<void>;
}

interface TelegramUser {
  id: number;
  first_name?: string;
  username?: string;
  is_bot?: boolean;
}

interface TelegramPhotoSize {
  file_id: string;
  file_size?: number;
  width?: number;
  height?: number;
}

interface TelegramFileRef {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

interface TelegramMessage {
  message_id: number;
  text?: string;
  caption?: string;
  chat: { id: number; type: string };
  from?: TelegramUser;
  message_thread_id?: number;
  photo?: TelegramPhotoSize[];
  document?: TelegramFileRef;
  video?: TelegramFileRef;
  audio?: TelegramFileRef;
  voice?: TelegramFileRef;
  animation?: TelegramFileRef;
  reply_to_message?: { message_id: number; text?: string; caption?: string };
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export class TelegramChannelAdapter implements ChannelAdapter {
  readonly channelId = "telegram";
  private readonly profileId: ProfileId;
  private readonly transport: TelegramTransport;
  private allowedUserId?: string;
  private readonly render: RenderPolicy;
  private lastUpdateId: number;
  private owner?: TransportOwner;
  private pollAbort?: AbortController;
  private state: AdapterStatus["state"] = "disconnected";
  private detail?: string;
  private botUsername?: string;
  private readonly onPaired?: TelegramAdapterOptions["onPaired"];
  private readonly onOffset?: TelegramAdapterOptions["onOffset"];
  private offsetDirty = 0;
  private progressMessages = new Map<string, number>();
  private tempDir?: string;

  constructor(options: TelegramAdapterOptions) {
    this.profileId = options.profileId ?? "default";
    this.transport = new TelegramTransport({
      botToken: options.botToken,
      networkFamily: "ipv4-fallback",
      serialize: true,
      maxRetries: 3,
    });
    this.allowedUserId =
      options.allowedUserId !== undefined
        ? String(options.allowedUserId)
        : undefined;
    this.render = normalizeRenderPolicy(
      options.render ?? DEFAULT_RENDER_POLICY,
    );
    this.lastUpdateId = options.lastUpdateId ?? 0;
    this.onPaired = options.onPaired;
    this.onOffset = options.onOffset;
  }

  status(profileId?: ProfileId): AdapterStatus {
    if (profileId && profileId !== this.profileId) {
      return {
        channelId: this.channelId,
        profileId,
        state: "disconnected",
        detail: "unknown profile",
      };
    }
    return {
      channelId: this.channelId,
      profileId: this.profileId,
      state: this.state,
      detail: this.detail,
      pairedOperatorId: this.allowedUserId,
    };
  }

  async connect(profileId: ProfileId, owner: TransportOwner): Promise<void> {
    if (profileId !== this.profileId) {
      throw new Error(`telegram adapter only hosts profile ${this.profileId}`);
    }
    this.owner = owner;
    this.tempDir = owner.tempDir;
    await mkdir(owner.tempDir, { recursive: true });
    this.state = "connecting";
    const me = (await this.api("getMe")) as { username?: string };
    if (me?.username) this.botUsername = me.username;
    if (this.lastUpdateId <= 0) {
      const catchup = (await this.api("getUpdates", {
        offset: -1,
        timeout: 0,
      })) as TelegramUpdate[];
      for (const update of catchup ?? []) {
        this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
      }
    }
    this.state = "connected";
    this.detail = this.botUsername ? `@${this.botUsername}` : "bot connected";
    this.pollAbort = new AbortController();
    void this.pollLoop(this.pollAbort.signal);
  }

  async disconnect(profileId: ProfileId): Promise<void> {
    if (profileId !== this.profileId) return;
    this.pollAbort?.abort();
    this.pollAbort = undefined;
    this.owner = undefined;
    this.state = "disconnected";
    this.detail = "disconnected";
    if (this.onOffset && this.lastUpdateId > 0) {
      await this.onOffset(this.lastUpdateId);
    }
  }

  async deliver(
    intent: OutboundIntent,
    _fence: DeliveryFence,
  ): Promise<DeliveryResult> {
    try {
      if (intent.kind === "typing") {
        if (intent.active) {
          await this.api("sendChatAction", {
            chat_id: this.chatIdOf(intent.target),
            action: "typing",
            ...this.threadParams(intent.target),
          });
        }
        return { ok: true };
      }

      if (intent.kind === "progress") {
        return await this.upsertProgress(
          intent.target,
          intent.text,
          intent.slot ?? "run",
        );
      }

      if (intent.kind === "progress_clear") {
        return await this.clearProgress(intent.target, intent.slot ?? "run");
      }

      if (intent.kind === "notice" || intent.kind === "preview") {
        const text =
          intent.kind === "notice" ? intent.text : intent.text.slice(0, 500);
        await this.sendPlain(intent.target, text);
        return { ok: true };
      }

      if (intent.kind === "final") {
        await this.clearProgress(intent.target, "run");
        const replyParams = this.replyParameters(intent.replyTo?.raw);
        if (this.render.finalFormat === "plain") {
          await this.sendPlain(intent.target, intent.text, replyParams);
          return { ok: true };
        }
        const chunks = markdownToTelegramHtml(intent.text, {
          sanitize: this.render.sanitizeMarkdown,
          neutralizeMath: this.render.neutralizeMath,
        });
        if (chunks.length === 0) {
          await this.sendPlain(intent.target, intent.text.slice(0, 4000), replyParams);
          return { ok: true };
        }
        for (const [index, chunk] of chunks.entries()) {
          await this.api("sendMessage", {
            chat_id: this.chatIdOf(intent.target),
            text: chunk,
            parse_mode: "HTML",
            ...this.threadParams(intent.target),
            // only first chunk carries reply header
            ...(index === 0 ? replyParams : {}),
          });
        }
        return { ok: true };
      }

      if (intent.kind === "attach") {
        const replyParams = this.replyParameters(intent.replyTo?.raw);
        const ids: string[] = [];
        for (const [index, file] of intent.files.entries()) {
          const sentId = await this.sendLocalFile(
            intent.target,
            file.path,
            {
              fileName: file.fileName,
              mimeType: file.mimeType,
              caption: file.caption,
              // reply only on first file to avoid header spam
              extra: index === 0 ? replyParams : {},
            },
          );
          if (sentId) ids.push(sentId);
        }
        return { ok: true, nativeMessageIds: ids };
      }

      return { ok: false, reason: "unsupported intent" };
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
        retryable: true,
      };
    }
  }

  private replyParameters(raw: unknown): Record<string, unknown> {
    const messageId = extractMessageId(raw);
    if (messageId === undefined) return {};
    return {
      reply_parameters: {
        message_id: messageId,
        allow_sending_without_reply: true,
      },
    };
  }

  private async sendLocalFile(
    target: ChannelTarget,
    filePath: string,
    options: {
      fileName?: string;
      mimeType?: string;
      caption?: string;
      extra?: Record<string, unknown>;
    },
  ): Promise<string | undefined> {
    const info = await stat(filePath);
    if (!info.isFile()) {
      throw new Error(`not a file: ${filePath}`);
    }
    if (info.size > FILE_MAX_BYTES) {
      throw new Error(`file too large (>${FILE_MAX_BYTES}): ${filePath}`);
    }
    const fileName = options.fileName ?? basename(filePath);
    const mime =
      options.mimeType ??
      guessMime(fileName, isImagePath(fileName) ? "image" : "document");
    const asPhoto = isImagePath(fileName) || mime?.startsWith("image/");
    const method = asPhoto ? "sendPhoto" : "sendDocument";
    const field = asPhoto ? "photo" : "document";

    const form = new FormData();
    form.set("chat_id", String(this.chatIdOf(target)));
    const threadId = target.address.threadId;
    if (typeof threadId === "number") {
      form.set("message_thread_id", String(threadId));
    }
    if (options.caption) {
      form.set("caption", options.caption.slice(0, 1024));
    }
    // reply_parameters as JSON string for multipart
    const reply = options.extra?.reply_parameters;
    if (reply) {
      form.set("reply_parameters", JSON.stringify(reply));
    }

    const bytes = await readFile(filePath);
    const blob = new Blob([bytes], {
      type: mime ?? "application/octet-stream",
    });
    form.set(field, blob, fileName);

    const sent = (await this.transport.callMultipart(method, form)) as {
      message_id?: number;
    };
    return typeof sent?.message_id === "number"
      ? String(sent.message_id)
      : undefined;
  }

  private progressKey(target: ChannelTarget, slot: string): string {
    const chatId = this.chatIdOf(target);
    const thread =
      typeof target.address.threadId === "number"
        ? `:t${target.address.threadId}`
        : "";
    return `${chatId}${thread}:${slot}`;
  }

  private async upsertProgress(
    target: ChannelTarget,
    text: string,
    slot: string,
  ): Promise<DeliveryResult> {
    const key = this.progressKey(target, slot);
    const body = text.slice(0, 3500) || "Working…";
    const existing = this.progressMessages.get(key);
    const chatId = this.chatIdOf(target);
    const thread = this.threadParams(target);

    if (existing !== undefined) {
      try {
        await this.api("editMessageText", {
          chat_id: chatId,
          message_id: existing,
          text: body,
        });
        return { ok: true, nativeMessageIds: [String(existing)] };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (/message is not modified/i.test(msg)) {
          return { ok: true, nativeMessageIds: [String(existing)] };
        }
        this.progressMessages.delete(key);
      }
    }

    const sent = (await this.api("sendMessage", {
      chat_id: chatId,
      text: body,
      ...thread,
      link_preview_options: { is_disabled: true },
    })) as { message_id?: number };
    if (typeof sent?.message_id === "number") {
      this.progressMessages.set(key, sent.message_id);
      return { ok: true, nativeMessageIds: [String(sent.message_id)] };
    }
    return { ok: false, reason: "progress send missing message_id" };
  }

  private async clearProgress(
    target: ChannelTarget,
    slot: string,
  ): Promise<DeliveryResult> {
    const key = this.progressKey(target, slot);
    const messageId = this.progressMessages.get(key);
    this.progressMessages.delete(key);
    if (messageId === undefined) return { ok: true };
    try {
      await this.api("deleteMessage", {
        chat_id: this.chatIdOf(target),
        message_id: messageId,
      });
    } catch {
      // already gone
    }
    return { ok: true, nativeMessageIds: [String(messageId)] };
  }

  private chatIdOf(target: ChannelTarget): number {
    const chatId = target.address.chatId;
    if (typeof chatId !== "number") {
      throw new Error("telegram target missing numeric chatId");
    }
    return chatId;
  }

  private threadParams(target: ChannelTarget): Record<string, number> {
    const threadId = target.address.threadId;
    return typeof threadId === "number"
      ? { message_thread_id: threadId }
      : {};
  }

  private async sendPlain(
    target: ChannelTarget,
    text: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await this.api("sendMessage", {
      chat_id: this.chatIdOf(target),
      text: text.slice(0, 4000),
      ...this.threadParams(target),
      ...extra,
    });
  }

  private async api(
    method: string,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    return this.transport.call(method, body);
  }

  private async pollLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const updates = (await this.api("getUpdates", {
          offset: this.lastUpdateId + 1,
          timeout: 25,
          allowed_updates: ["message"],
        })) as TelegramUpdate[];
        for (const update of updates ?? []) {
          this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
          this.offsetDirty += 1;
          await this.ingest(update);
        }
        if (this.offsetDirty >= 5 && this.onOffset) {
          this.offsetDirty = 0;
          await this.onOffset(this.lastUpdateId);
        }
      } catch (error) {
        if (signal.aborted) return;
        this.state = "error";
        this.detail = error instanceof Error ? error.message : String(error);
        await sleep(2000);
        if (!signal.aborted) this.state = "connected";
      }
    }
  }

  private async ingest(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (!message?.from || !this.owner) return;
    if (message.from.is_bot) return;

    const senderId = String(message.from.id);
    if (this.allowedUserId && senderId !== this.allowedUserId) {
      return;
    }
    if (!this.allowedUserId) {
      this.allowedUserId = senderId;
      this.detail = `paired ${senderId}`;
      await this.onPaired?.(message.from.id);
    }

    const target: ChannelTarget = {
      channelId: "telegram",
      profileId: this.profileId,
      address: {
        chatId: message.chat.id,
        ...(typeof message.message_thread_id === "number"
          ? { threadId: message.message_thread_id }
          : {}),
      },
    };

    const text = (message.text ?? message.caption ?? "").trim();
    const attachments = await this.collectAttachments(message);
    const command = text.match(/^\/([a-zA-Z0-9_]+)(?:@\w+)?(?:\s+(.*))?$/s);

    const base = {
      eventId: `${update.update_id}`,
      target,
      sender: {
        id: senderId,
        displayName: message.from.first_name,
        username: message.from.username,
        isOwnerCandidate: true,
      },
      createdAt: Date.now(),
      rawRef: { messageId: message.message_id },
      ...(message.reply_to_message
        ? {
            replyTo: {
              raw: { messageId: message.reply_to_message.message_id },
              textPreview:
                message.reply_to_message.text ??
                message.reply_to_message.caption,
            },
          }
        : {}),
    };

    let event: ChannelEvent;

    if (command && attachments.length === 0) {
      const name = (command[1] ?? "").toLowerCase();
      const args = (command[2] ?? "").trim();
      if (
        name === "abort" ||
        name === "stop" ||
        name === "next" ||
        name === "continue" ||
        name === "compact"
      ) {
        event = { type: "control", name, ...base };
      } else if (name === "start") {
        await this.sendPlain(
          target,
          "pi-channels online. Send a prompt, image, or file; /abort /stop /next /continue supported.",
        );
        return;
      } else {
        event = { type: "command", name, args, text, ...base };
      }
    } else {
      event = {
        type: "message",
        text: text || undefined,
        ...(attachments.length > 0 ? { attachments } : {}),
        ...base,
      };
    }

    // empty text with no attachments — ignore
    if (
      event.type === "message" &&
      !event.text &&
      !(event.attachments && event.attachments.length > 0)
    ) {
      return;
    }

    await this.owner.onEvent(event);
  }

  private async collectAttachments(
    message: TelegramMessage,
  ): Promise<ChannelAttachment[]> {
    const out: ChannelAttachment[] = [];
    const push = async (
      kind: AttachmentKind,
      fileId: string,
      fileName?: string,
      mimeType?: string,
      fileSize?: number,
    ) => {
      if (fileSize && fileSize > FILE_MAX_BYTES) {
        out.push({
          kind,
          remoteId: fileId,
          fileName,
          mimeType,
          byteSize: fileSize,
        });
        return;
      }
      try {
        const downloaded = await this.downloadToTemp(
          fileId,
          fileName,
          mimeType,
          kind,
        );
        out.push(downloaded);
      } catch (error) {
        out.push({
          kind,
          remoteId: fileId,
          fileName,
          mimeType,
          byteSize: fileSize,
        });
        // keep going; core will show remote-only note via missing path handling
        void error;
      }
    };

    if (message.photo?.length) {
      const best = message.photo[message.photo.length - 1]!;
      await push(
        "image",
        best.file_id,
        `photo-${message.message_id}.jpg`,
        "image/jpeg",
        best.file_size,
      );
    }
    if (message.document) {
      await push(
        "document",
        message.document.file_id,
        message.document.file_name,
        message.document.mime_type,
        message.document.file_size,
      );
    }
    if (message.video) {
      await push(
        "video",
        message.video.file_id,
        message.video.file_name ?? `video-${message.message_id}.mp4`,
        message.video.mime_type ?? "video/mp4",
        message.video.file_size,
      );
    }
    if (message.audio) {
      await push(
        "audio",
        message.audio.file_id,
        message.audio.file_name,
        message.audio.mime_type,
        message.audio.file_size,
      );
    }
    if (message.voice) {
      await push(
        "voice",
        message.voice.file_id,
        `voice-${message.message_id}.ogg`,
        message.voice.mime_type ?? "audio/ogg",
        message.voice.file_size,
      );
    }
    if (message.animation) {
      await push(
        "video",
        message.animation.file_id,
        message.animation.file_name ?? `anim-${message.message_id}.mp4`,
        message.animation.mime_type,
        message.animation.file_size,
      );
    }
    return out;
  }

  private async downloadToTemp(
    fileId: string,
    fileName: string | undefined,
    mimeType: string | undefined,
    kind: AttachmentKind,
  ): Promise<ChannelAttachment> {
    const dir = this.tempDir ?? join("/tmp", "pi-channels-telegram");
    await mkdir(dir, { recursive: true });
    const meta = (await this.api("getFile", { file_id: fileId })) as {
      file_path?: string;
      file_size?: number;
    };
    if (!meta.file_path) {
      throw new Error("getFile missing file_path");
    }
    if (meta.file_size && meta.file_size > FILE_MAX_BYTES) {
      throw new Error("file too large");
    }
    const bytes = await this.transport.downloadFile(meta.file_path);
    const safeName = sanitizeFileName(
      fileName ?? meta.file_path.split("/").pop() ?? `${kind}-${randomUUID()}`,
    );
    const path = join(dir, `${Date.now()}-${safeName}`);
    await writeFile(path, bytes);
    return {
      kind,
      path,
      fileName: safeName,
      mimeType: mimeType ?? guessMime(safeName, kind),
      byteSize: bytes.byteLength,
      remoteId: fileId,
    };
  }
}

function extractMessageId(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (raw && typeof raw === "object" && "messageId" in raw) {
    const value = (raw as { messageId?: unknown }).messageId;
    if (typeof value === "number") return value;
  }
  if (raw && typeof raw === "object" && "message_id" in raw) {
    const value = (raw as { message_id?: unknown }).message_id;
    if (typeof value === "number") return value;
  }
  return undefined;
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^\w.\-()+@]+/g, "_").slice(0, 120) || "file.bin";
}

function isImagePath(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(name);
}

function guessMime(name: string, kind: AttachmentKind): string | undefined {
  const lower = name.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".ogg") || lower.endsWith(".opus")) return "audio/ogg";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (kind === "image") return "image/jpeg";
  if (kind === "voice") return "audio/ogg";
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createTelegramAdapter(
  options: TelegramAdapterOptions,
): TelegramChannelAdapter {
  return new TelegramChannelAdapter(options);
}
