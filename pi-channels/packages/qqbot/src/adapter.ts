/**
 * QQ Bot ChannelAdapter — C2C (and optional group @) companion.
 *
 * Design notes (QQ platform limits):
 * - Prefer passive replies (msg_id) for finals; proactive is heavily limited.
 * - progress / typing → no-op by default (each reply burns passive quota).
 * - Solo operator pair via allowedOpenId (first C2C if unset).
 */

import { mkdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import type {
  AdapterStatus,
  ChannelAdapter,
  ChannelAttachment,
  ChannelEvent,
  ChannelTarget,
  DeliveryFence,
  DeliveryResult,
  LocalFile,
  OutboundIntent,
  ProfileId,
  RenderPolicy,
  TransportOwner,
} from "../../core/src/index.ts";
import {
  DEFAULT_RENDER_POLICY,
  guessMimeFromName,
  normalizeRenderPolicy,
} from "../../core/src/index.ts";

import { INTENT_GROUP_AND_C2C, QqbotGateway } from "./gateway.ts";
import {
  classifyFileType,
  collectInboundAttachments,
  FILE_MAX_BYTES,
  readLocalFileBase64,
  type UploadMediaResult,
} from "./media.ts";
import { QqbotTransport } from "./transport.ts";
import {
  containsFaceMarkup,
  faceFromSlash,
  formatFriendlyNotice,
  formatProgressFaceText,
  preserveFaceContent,
} from "./faces.ts";
import {
  toQqbotMarkdownContent,
  toQqbotPlainText,
  usesQqbotMarkdown,
} from "./render.ts";

export interface QqbotAdapterOptions {
  profileId?: ProfileId;
  appId: string;
  clientSecret: string;
  /** Paired operator openid; first inbound C2C pairs if missing. */
  allowedOpenId?: string;
  /** When true, also accept GROUP_AT_MESSAGE_CREATE (require @). */
  enableGroup?: boolean;
  sandbox?: boolean;
  apiBase?: string;
  render?: Partial<RenderPolicy>;
  onPaired?: (openid: string) => void | Promise<void>;
  log?: (message: string) => void;
}

interface C2CMessage {
  id?: string;
  content?: string;
  timestamp?: string;
  author?: { user_openid?: string; id?: string };
  attachments?: Array<{
    url?: string;
    content_type?: string;
    filename?: string;
    size?: number;
  }>;
}

interface GroupAtMessage {
  id?: string;
  content?: string;
  timestamp?: string;
  author?: { member_openid?: string; id?: string };
  group_openid?: string;
  attachments?: C2CMessage["attachments"];
}

export class QqbotChannelAdapter implements ChannelAdapter {
  readonly channelId = "qqbot";
  private readonly profileId: ProfileId;
  private readonly transport: QqbotTransport;
  private allowedOpenId?: string;
  private readonly enableGroup: boolean;
  private readonly render: RenderPolicy;
  private readonly onPaired?: QqbotAdapterOptions["onPaired"];
  private readonly logFn?: QqbotAdapterOptions["log"];
  private owner?: TransportOwner;
  private gateway?: QqbotGateway;
  private tempDir?: string;
  private state: AdapterStatus["state"] = "disconnected";
  private detail?: string;
  private botLabel?: string;
  /** msg_seq per source msg_id to allow multi-chunk replies */
  private replySeq = new Map<string, number>();
  /** Last inbound msg_id per peer (openid or groupOpenid) for passive notices. */
  private lastMsgIdByPeer = new Map<string, string>();
  /**
   * Single-slot progress draft (QQ has no editMessageText).
   * Strategy: send once on first progress; ignore updates; delete on clear/final.
   * Avoids burning passive reply quota (C2C ~4–5 replies per user msg).
   */
  private progressMessages = new Map<
    string,
    { messageId: string; scene: string; openid?: string; groupOpenid?: string }
  >();

  constructor(options: QqbotAdapterOptions) {
    this.profileId = options.profileId ?? "default";
    this.transport = new QqbotTransport({
      appId: options.appId,
      clientSecret: options.clientSecret,
      sandbox: options.sandbox,
      apiBase: options.apiBase,
      serialize: true,
      maxRetries: 3,
    });
    this.allowedOpenId = options.allowedOpenId?.trim() || undefined;
    this.enableGroup = options.enableGroup === true;
    this.render = normalizeRenderPolicy(
      options.render ?? {
        ...DEFAULT_RENDER_POLICY,
        finalFormat: "plain",
        sanitizeMarkdown: true,
        neutralizeMath: true,
        draftPreviews: false,
      },
    );
    this.onPaired = options.onPaired;
    this.logFn = options.log;
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
      pairedOperatorId: this.allowedOpenId,
    };
  }

  async connect(profileId: ProfileId, owner: TransportOwner): Promise<void> {
    if (profileId !== this.profileId) {
      throw new Error(`qqbot adapter only hosts profile ${this.profileId}`);
    }
    this.owner = owner;
    this.tempDir = owner.tempDir;
    await mkdir(owner.tempDir, { recursive: true });
    this.state = "connecting";
    this.detail = "fetching token…";

    // Validate credentials early
    await this.transport.getAccessToken();

    this.gateway = new QqbotGateway({
      getAuthorization: () => this.transport.authHeader(),
      getUrl: () => this.transport.getGatewayUrl(),
      intents: INTENT_GROUP_AND_C2C,
      onDispatch: (event) => this.onDispatch(event),
      onState: (state, detail) => {
        if (state === "ready") {
          this.state = "connected";
          this.botLabel = detail;
          this.detail = detail
            ? `ws ready (${detail})`
            : "ws ready";
        } else if (state === "connecting") {
          this.state = "connecting";
          this.detail = detail ?? "connecting";
        } else if (state === "reconnecting") {
          this.state = "connecting";
          this.detail = `reconnecting: ${detail ?? ""}`;
        } else if (state === "closed") {
          this.state = "disconnected";
          this.detail = detail ?? "closed";
        }
      },
      log: (message) => this.log(`gw ${message}`),
    });

    await this.gateway.start();
    // start() returns after first connect attempt is launched; READY is async.
    // Give a short wait for READY so /channel-connect surfaces errors faster.
    await waitFor(
      () => this.state === "connected" || this.state === "error",
      12_000,
    ).catch(() => undefined);

    if (this.state !== "connected") {
      // still connecting is ok — gateway will keep retrying
      if (this.state === "disconnected") {
        this.state = "connecting";
        this.detail = this.detail ?? "waiting for READY";
      }
    }
  }

  async disconnect(profileId: ProfileId): Promise<void> {
    if (profileId !== this.profileId) return;
    await this.gateway?.stop();
    this.gateway = undefined;
    this.owner = undefined;
    this.progressMessages.clear();
    this.state = "disconnected";
    this.detail = "disconnected";
  }

  async deliver(
    intent: OutboundIntent,
    _fence: DeliveryFence,
  ): Promise<DeliveryResult> {
    try {
      if (intent.kind === "typing") {
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
      if (intent.kind === "preview") {
        return { ok: true };
      }

      if (intent.kind === "notice") {
        return await this.sendText(intent.target, intent.text, {
          replyTo: undefined,
          soft: true,
        });
      }

      if (intent.kind === "final") {
        // Keep progress bubble in chat (no recall) — just drop local slot state.
        this.forgetProgress(intent.target, "run");
        return await this.sendText(intent.target, intent.text, {
          replyTo: intent.replyTo?.raw,
        });
      }

      if (intent.kind === "attach") {
        return await this.sendAttachments(
          intent.target,
          intent.files,
          intent.replyTo?.raw,
        );
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

  private peerKey(target: ChannelTarget): string {
    const scene = String(target.address.scene ?? "c2c");
    if (scene === "group") {
      return `g:${String(target.address.groupOpenid ?? "")}`;
    }
    return `u:${String(target.address.openid ?? "")}`;
  }

  private progressKey(target: ChannelTarget, slot: string): string {
    return `${this.peerKey(target)}:${slot}`;
  }

  /**
   * QQ cannot edit text messages in place (unlike Telegram editMessageText).
   * Send a single status message once; later progress intents are no-ops.
   */
  private async upsertProgress(
    target: ChannelTarget,
    text: string,
    slot: string,
  ): Promise<DeliveryResult> {
    const key = this.progressKey(target, slot);
    if (this.progressMessages.has(key)) {
      // Already have a bubble — do not resend (saves passive quota).
      return {
        ok: true,
        nativeMessageIds: [this.progressMessages.get(key)!.messageId],
      };
    }

    // Literal classic slash code — do not expandSlashFaces / preserveFaceContent.
    // Body is exactly: `/fendou 正在执行中`
    const body = formatProgressFaceText(text);
    const scene = String(target.address.scene ?? "c2c");
    let msgId = this.lastMsgIdByPeer.get(this.peerKey(target));
    const path =
      scene === "group"
        ? `/v2/groups/${encodeURIComponent(String(target.address.groupOpenid ?? ""))}/messages`
        : `/v2/users/${encodeURIComponent(String(target.address.openid ?? ""))}/messages`;

    if (scene === "group" && !target.address.groupOpenid) {
      return { ok: false, reason: "qqbot progress: missing groupOpenid" };
    }
    if (scene !== "group" && !target.address.openid) {
      return { ok: false, reason: "qqbot progress: missing openid" };
    }

    const payload: Record<string, unknown> = {
      msg_type: 0,
      content: body,
    };
    if (msgId) {
      payload.msg_id = msgId;
      payload.msg_seq = this.nextSeq(msgId);
    }

    try {
      const sent = (await this.transport.call("POST", path, payload)) as {
        id?: string;
      };
      if (!sent?.id) {
        return { ok: false, reason: "progress send missing id" };
      }
      this.progressMessages.set(key, {
        messageId: String(sent.id),
        scene,
        openid:
          scene === "c2c" ? String(target.address.openid ?? "") : undefined,
        groupOpenid:
          scene === "group"
            ? String(target.address.groupOpenid ?? "")
            : undefined,
      });
      return { ok: true, nativeMessageIds: [String(sent.id)] };
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
        retryable: true,
      };
    }
  }

  /** Drop local progress slot without recalling the message in QQ. */
  private forgetProgress(target: ChannelTarget, slot: string): void {
    this.progressMessages.delete(this.progressKey(target, slot));
  }

  private async clearProgress(
    target: ChannelTarget,
    slot: string,
  ): Promise<DeliveryResult> {
    // User preference: leave "🔄 正在执行中" in the chat; do not DELETE/recall.
    const key = this.progressKey(target, slot);
    const entry = this.progressMessages.get(key);
    this.progressMessages.delete(key);
    return entry
      ? { ok: true, nativeMessageIds: [entry.messageId] }
      : { ok: true };
  }

  private async sendText(
    target: ChannelTarget,
    text: string,
    options: { replyTo?: unknown; soft?: boolean },
  ): Promise<DeliveryResult> {
    const scene = String(target.address.scene ?? "c2c");
    // System faces only work in plain content (msg_type 0), not markdown.
    // If the model/user already put <faceType=…> / <emoji:N> in the body,
    // pass them through as-is and force plain.
    // Expand /fendou-style codes + face tags (C2C → Unicode).
    const expanded = preserveFaceContent(text);
    const changedByFaces = expanded !== (text ?? "").replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
    const hasFaceTags = containsFaceMarkup(text);
    // If we expanded faces, stay on plain so unicode isn't mangled by MD path.
    const preferMarkdown =
      usesQqbotMarkdown(this.render) && !hasFaceTags && !changedByFaces;
    const bodyText = preferMarkdown
      ? toQqbotMarkdownContent(expanded, this.render)
      : hasFaceTags || changedByFaces
        ? expanded
        : toQqbotPlainText(expanded, this.render);
    if (!bodyText.trim()) {
      return { ok: true };
    }

    // QQ has practical size limits; chunk conservatively.
    // Avoid splitting inside a face tag when possible (chunkText is newline-aware).
    const chunks = chunkText(bodyText, 1800);
    let msgId = extractMsgId(options.replyTo);
    if (!msgId) {
      // Prefer last inbound id so control/notice stays in passive window.
      msgId = this.lastMsgIdByPeer.get(this.peerKey(target));
    }
    const ids: string[] = [];

    for (const chunk of chunks) {
      const sent = await this.sendOneChunk(target, scene, chunk, {
        msgId,
        preferMarkdown,
        // Face chunks must stay plain even if preferMarkdown was true for other parts
        forcePlain: hasFaces || containsFaceMarkup(chunk),
      });
      if (sent.id) ids.push(sent.id);
    }

    return { ok: true, nativeMessageIds: ids };
  }

  private async sendOneChunk(
    target: ChannelTarget,
    scene: string,
    chunk: string,
    options: {
      msgId?: string;
      preferMarkdown: boolean;
      forcePlain?: boolean;
    },
  ): Promise<{ id?: string }> {
    const path =
      scene === "group"
        ? (() => {
            const groupOpenid = String(target.address.groupOpenid ?? "");
            if (!groupOpenid) {
              throw new Error("qqbot group target missing groupOpenid");
            }
            return `/v2/groups/${encodeURIComponent(groupOpenid)}/messages`;
          })()
        : (() => {
            const openid = String(target.address.openid ?? "");
            if (!openid) {
              throw new Error("qqbot c2c target missing openid");
            }
            return `/v2/users/${encodeURIComponent(openid)}/messages`;
          })();

    const attachPassive = (payload: Record<string, unknown>) => {
      if (options.msgId) {
        payload.msg_id = options.msgId;
        payload.msg_seq = this.nextSeq(options.msgId);
      }
    };

    const useMarkdown = options.preferMarkdown && !options.forcePlain;

    if (useMarkdown) {
      const mdPayload: Record<string, unknown> = {
        msg_type: 2,
        markdown: { content: chunk },
      };
      attachPassive(mdPayload);
      try {
        const result = (await this.transport.call(
          "POST",
          path,
          mdPayload,
        )) as { id?: string };
        return { id: result?.id ? String(result.id) : undefined };
      } catch (error) {
        // Fall back to plain text so answers still deliver if MD is rejected.
        this.log(
          `markdown send failed, fallback plain: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Plain path: keep face tags; only strip MD noise when we fell back from markdown.
    const plainContent =
      options.forcePlain || containsFaceMarkup(chunk)
        ? preserveFaceContent(chunk)
        : options.preferMarkdown
          ? toQqbotPlainText(chunk, {
              sanitizeMarkdown: true,
              neutralizeMath: this.render.neutralizeMath,
            })
          : chunk;

    const plainPayload: Record<string, unknown> = {
      msg_type: 0,
      content: plainContent,
    };
    attachPassive(plainPayload);
    const result = (await this.transport.call("POST", path, plainPayload)) as {
      id?: string;
    };
    return { id: result?.id ? String(result.id) : undefined };
  }

  private nextSeq(msgId: string): number {
    const next = (this.replySeq.get(msgId) ?? 0) + 1;
    this.replySeq.set(msgId, next);
    // prevent unbounded growth
    if (this.replySeq.size > 200) {
      const first = this.replySeq.keys().next().value;
      if (first !== undefined) this.replySeq.delete(first);
    }
    return next;
  }

  private async onDispatch(event: {
    t: string;
    d: unknown;
    s: number | null;
  }): Promise<void> {
    if (!this.owner) return;

    if (event.t === "C2C_MESSAGE_CREATE") {
      await this.ingestC2C(event.d as C2CMessage);
      return;
    }
    if (event.t === "GROUP_AT_MESSAGE_CREATE" && this.enableGroup) {
      await this.ingestGroupAt(event.d as GroupAtMessage);
      return;
    }
  }

  private async ingestC2C(message: C2CMessage): Promise<void> {
    const openid =
      message.author?.user_openid ??
      message.author?.id ??
      "";
    if (!openid) return;

    if (this.allowedOpenId && openid !== this.allowedOpenId) {
      this.log(`ignore c2c from unpaired ${openid}`);
      return;
    }
    if (!this.allowedOpenId) {
      this.allowedOpenId = openid;
      this.detail = `paired ${openid}`;
      await this.onPaired?.(openid);
    }

    if (message.id) {
      this.lastMsgIdByPeer.set(`u:${openid}`, message.id);
    }

    const text = stripBotMentions((message.content ?? "").trim());
    const target: ChannelTarget = {
      channelId: "qqbot",
      profileId: this.profileId,
      address: {
        scene: "c2c",
        openid,
      },
      label: `qq:${openid.slice(0, 8)}`,
    };

    const attachments = await this.collectAttachments(message.attachments);

    await this.emitInbound({
      target,
      senderId: openid,
      text,
      msgId: message.id,
      createdAt: parseTs(message.timestamp),
      attachments,
    });
  }

  private async ingestGroupAt(message: GroupAtMessage): Promise<void> {
    const memberOpenid =
      message.author?.member_openid ?? message.author?.id ?? "";
    const groupOpenid = message.group_openid ?? "";
    if (!memberOpenid || !groupOpenid) return;

    // Optional: restrict group senders to same paired operator
    if (this.allowedOpenId && memberOpenid !== this.allowedOpenId) {
      this.log(`ignore group msg from ${memberOpenid}`);
      return;
    }

    if (message.id) {
      this.lastMsgIdByPeer.set(`g:${groupOpenid}`, message.id);
    }

    const text = stripBotMentions((message.content ?? "").trim());
    const target: ChannelTarget = {
      channelId: "qqbot",
      profileId: this.profileId,
      address: {
        scene: "group",
        openid: memberOpenid,
        groupOpenid,
      },
      label: `qqg:${groupOpenid.slice(0, 8)}`,
    };

    const attachments = await this.collectAttachments(message.attachments);

    await this.emitInbound({
      target,
      senderId: memberOpenid,
      text,
      msgId: message.id,
      createdAt: parseTs(message.timestamp),
      attachments,
    });
  }

  private async collectAttachments(
    raw: C2CMessage["attachments"],
  ): Promise<ChannelAttachment[]> {
    const dir = this.tempDir ?? join("/tmp", "pi-channels-qqbot");
    return collectInboundAttachments(raw, dir, (message) => this.log(message));
  }

  private async sendAttachments(
    target: ChannelTarget,
    files: LocalFile[],
    replyTo?: unknown,
  ): Promise<DeliveryResult> {
    if (!files.length) return { ok: true };

    let msgId = extractMsgId(replyTo);
    if (!msgId) {
      msgId = this.lastMsgIdByPeer.get(this.peerKey(target));
    }

    const ids: string[] = [];
    const failures: string[] = [];

    // Optional first-file caption as a short text before media
    const firstCaption = files[0]?.caption?.trim();
    if (firstCaption) {
      const captionResult = await this.sendText(target, firstCaption, {
        replyTo,
      });
      if (captionResult.ok && captionResult.nativeMessageIds) {
        ids.push(...captionResult.nativeMessageIds);
      }
    }

    for (const file of files) {
      try {
        const sentId = await this.uploadAndSendFile(target, file, msgId);
        if (sentId) ids.push(sentId);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        failures.push(`${file.fileName ?? basename(file.path)}: ${reason}`);
        this.log(`attach failed: ${reason}`);
      }
    }

    if (ids.length === 0 && failures.length > 0) {
      // Fallback note so user sees something in-channel
      const note = await this.sendText(
        target,
        `[attach failed]\n${failures.join("\n")}`,
        { replyTo, soft: true },
      );
      if (note.ok) return note;
      return { ok: false, reason: failures.join("; "), retryable: true };
    }

    if (failures.length > 0) {
      await this.sendText(
        target,
        `[attach partial]\n${failures.join("\n")}`,
        { replyTo, soft: true },
      );
    }

    return { ok: true, nativeMessageIds: ids };
  }

  private async uploadAndSendFile(
    target: ChannelTarget,
    file: LocalFile,
    msgId?: string,
  ): Promise<string | undefined> {
    const info = await stat(file.path);
    if (!info.isFile()) {
      throw new Error(`not a file: ${file.path}`);
    }
    if (info.size > FILE_MAX_BYTES) {
      throw new Error(`file too large (>${FILE_MAX_BYTES}): ${file.path}`);
    }

    const fileName = file.fileName ?? basename(file.path);
    const mime =
      file.mimeType ?? guessMimeFromName(fileName) ?? "application/octet-stream";
    const fileType = classifyFileType(fileName, mime);
    const { base64 } = await readLocalFileBase64(file.path);

    const scene = String(target.address.scene ?? "c2c");
    const uploadPath =
      scene === "group"
        ? `/v2/groups/${encodeURIComponent(String(target.address.groupOpenid ?? ""))}/files`
        : `/v2/users/${encodeURIComponent(String(target.address.openid ?? ""))}/files`;

    if (scene === "group" && !target.address.groupOpenid) {
      throw new Error("qqbot group target missing groupOpenid");
    }
    if (scene !== "group" && !target.address.openid) {
      throw new Error("qqbot c2c target missing openid");
    }

    const uploaded = (await this.transport.call("POST", uploadPath, {
      file_type: fileType,
      // Official schema marks url required; empty + file_data is accepted by platform for local bytes.
      url: "",
      file_data: base64,
      srv_send_msg: false,
    })) as UploadMediaResult;

    const fileInfo = uploaded?.file_info;
    if (!fileInfo) {
      throw new Error(
        `upload missing file_info: ${JSON.stringify(uploaded).slice(0, 200)}`,
      );
    }

    const seq = msgId ? this.nextSeq(msgId) : undefined;
    const payload: Record<string, unknown> = {
      msg_type: 7,
      media: { file_info: fileInfo },
    };
    if (msgId) {
      payload.msg_id = msgId;
      if (seq !== undefined) payload.msg_seq = seq;
    }

    const sendPath =
      scene === "group"
        ? `/v2/groups/${encodeURIComponent(String(target.address.groupOpenid))}/messages`
        : `/v2/users/${encodeURIComponent(String(target.address.openid))}/messages`;

    const sent = (await this.transport.call("POST", sendPath, payload)) as {
      id?: string;
    };
    return typeof sent?.id === "string" ? sent.id : undefined;
  }

  private async emitInbound(input: {
    target: ChannelTarget;
    senderId: string;
    text: string;
    msgId?: string;
    createdAt: number;
    attachments?: ChannelAttachment[];
  }): Promise<void> {
    if (!this.owner) return;
    const text = input.text;
    const attachments = input.attachments ?? [];
    if (!text && attachments.length === 0) return;

    const base = {
      eventId: input.msgId ?? `${input.createdAt}-${input.senderId}`,
      target: input.target,
      sender: {
        id: input.senderId,
        isOwnerCandidate: true,
      },
      createdAt: input.createdAt,
      rawRef: input.msgId ? { msgId: input.msgId } : undefined,
      ...(input.msgId
        ? {
            replyTo: {
              raw: { msgId: input.msgId },
              textPreview: (text || "[media]").slice(0, 80),
            },
          }
        : {}),
    };

    // Media-only or text+media always go as message (not slash-command).
    if (attachments.length > 0) {
      const event: ChannelEvent = {
        type: "message",
        text: text || undefined,
        attachments,
        ...base,
      };
      await this.owner.onEvent(event);
      return;
    }

    const command = text.match(/^\/([a-zA-Z0-9_-]+)(?:\s+(.*))?$/s);
    let event: ChannelEvent;

    if (command) {
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
      } else if (name === "start" || name === "help") {
        // Plain text so face embeds render (markdown path may strip them).
        await this.deliver(
          {
            kind: "notice",
            target: input.target,
            text: formatFriendlyNotice(
              "pi-channels 在线啦。发文字/图片/文件即可；支持 /abort /stop /next /continue；表情试 /fendou",
              "ok",
            ),
            level: "info",
          },
          {
            instanceId: this.owner.instanceId,
            sessionGen: 0,
            transportStamp: "qqbot",
          },
        );
        return;
      } else if (faceFromSlash(name)) {
        // Fun face slash: /fendou /smile /spin …
        const face = faceFromSlash(name)!;
        const extra = args ? ` ${args}` : "";
        await this.deliver(
          {
            kind: "notice",
            target: input.target,
            text: `${face}${extra}`,
            level: "info",
          },
          {
            instanceId: this.owner.instanceId,
            sessionGen: 0,
            transportStamp: "qqbot",
          },
        );
        return;
      } else {
        event = { type: "command", name, args, text, ...base };
      }
    } else {
      event = { type: "message", text, ...base };
    }

    await this.owner.onEvent(event);
  }

  private log(message: string): void {
    this.logFn?.(message);
  }
}

function extractMsgId(raw: unknown): string | undefined {
  if (!raw) return undefined;
  if (typeof raw === "string" && raw) return raw;
  if (raw && typeof raw === "object") {
    const obj = raw as { msgId?: unknown; msg_id?: unknown; id?: unknown };
    if (typeof obj.msgId === "string") return obj.msgId;
    if (typeof obj.msg_id === "string") return obj.msg_id;
    if (typeof obj.id === "string") return obj.id;
  }
  return undefined;
}

function stripBotMentions(text: string): string {
  // QQ often prefixes <@!botid> or similar
  return text
    .replace(/<@!?\d+>/g, "")
    .replace(/@\S+\s*/g, (m) => (m.length < 24 ? "" : m))
    .trim();
}

function parseTs(value?: string): number {
  if (!value) return Date.now();
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : Date.now();
}

function chunkText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    if (rest.length <= max) {
      chunks.push(rest);
      break;
    }
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  return chunks;
}

function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (pred()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("timeout"));
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  });
}

export function createQqbotAdapter(
  options: QqbotAdapterOptions,
): QqbotChannelAdapter {
  return new QqbotChannelAdapter(options);
}
