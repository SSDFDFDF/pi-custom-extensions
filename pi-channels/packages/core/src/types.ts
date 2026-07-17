/**
 * Channel-agnostic contracts for pi-channels.
 * Core must not import channel adapters.
 */

export type ChannelId = string;
export type ProfileId = string;
export type InstanceId = string;
export type SessionGen = number;
export type Generation = string;
export type TurnId = string;
export type EventId = string;

/** Opaque adapter-native address; core does not interpret keys. */
export type ChannelAddress = Record<string, unknown>;

export interface ChannelTarget {
  channelId: ChannelId;
  profileId: ProfileId;
  address: ChannelAddress;
  label?: string;
}

export interface ChannelSender {
  id: string;
  displayName?: string;
  username?: string;
  /** Adapter believes this sender may be the paired operator */
  isOwnerCandidate?: boolean;
}

export type AttachmentKind =
  | "image"
  | "audio"
  | "voice"
  | "video"
  | "document"
  | "other";

export interface ChannelAttachment {
  kind: AttachmentKind;
  path?: string;
  mimeType?: string;
  fileName?: string;
  byteSize?: number;
  /** Adapter-native file id if not yet downloaded */
  remoteId?: string;
}

export interface ChannelReplyRef {
  /** Adapter correlation token (message id, etc.) */
  raw: unknown;
  textPreview?: string;
}

export interface ChannelMessageBase {
  eventId: EventId;
  target: ChannelTarget;
  sender: ChannelSender;
  createdAt: number;
  replyTo?: ChannelReplyRef;
  /** Opaque adapter handle for later deliver(reply) */
  rawRef?: unknown;
}

export interface ChannelTextMessage extends ChannelMessageBase {
  type: "message";
  text?: string;
  attachments?: ChannelAttachment[];
}

export interface ChannelCommandEvent extends ChannelMessageBase {
  type: "command";
  name: string;
  args: string;
  text?: string;
}

export interface ChannelActionEvent extends ChannelMessageBase {
  type: "action";
  actionId: string;
  payload?: string;
}

export interface ChannelControlEvent extends ChannelMessageBase {
  type: "control";
  name: "abort" | "stop" | "next" | "continue" | "compact";
}

export type ChannelEvent =
  | ChannelTextMessage
  | ChannelCommandEvent
  | ChannelActionEvent
  | ChannelControlEvent;

export type QueueLane = "control" | "priority" | "default";

export type PiPromptContent =
  | { type: "text"; text: string }
  | { type: "image"; path: string; mimeType?: string };

export interface ChannelTurn {
  turnId: TurnId;
  lane: QueueLane;
  target: ChannelTarget;
  sourceEventIds: EventId[];
  content: PiPromptContent[];
  createdAt: number;
  transportStamp: Generation;
  sessionGen: SessionGen;
  /** Reply anchor for the outbound final (e.g. triggering Telegram message). */
  replyTo?: ChannelReplyRef;
}

export interface OutboundAction {
  id: string;
  label: string;
  /** Prompt enqueued when pressed, if no custom handler */
  prompt?: string;
  payload?: string;
}

export interface LocalFile {
  path: string;
  fileName?: string;
  mimeType?: string;
  caption?: string;
}

export type OutboundIntent =
  | {
      kind: "typing";
      target: ChannelTarget;
      active: boolean;
    }
  | {
      kind: "preview";
      target: ChannelTarget;
      text: string;
      format: "markdown";
    }
  | {
      kind: "final";
      target: ChannelTarget;
      text: string;
      format: "markdown";
      replyTo?: ChannelReplyRef;
      actions?: OutboundAction[];
      attachments?: LocalFile[];
    }
  | {
      kind: "notice";
      target: ChannelTarget;
      text: string;
      level: "info" | "warn" | "error";
    }
  /** Single-slot live status draft (OpenClaw-style): send once, then edit. */
  | {
      kind: "progress";
      target: ChannelTarget;
      text: string;
      /** logical slot; adapters keep one message per target+slot */
      slot?: string;
    }
  /** Delete the progress draft for this target/slot. */
  | {
      kind: "progress_clear";
      target: ChannelTarget;
      slot?: string;
    }
  /** Outbound files (photo/document) to the channel target. */
  | {
      kind: "attach";
      target: ChannelTarget;
      files: LocalFile[];
      replyTo?: ChannelReplyRef;
    };

/** Channel progress-draft policy (tool/status live line). */
export interface ProgressPolicy {
  /** off = typing only; progress = one editable status draft */
  mode: "off" | "progress";
  /** Wait this long after agent_start before creating a draft (skip flash). */
  startDelayMs: number;
  /** Max progress lines kept in the draft body. */
  maxLines: number;
  /** Max characters per line. */
  maxLineChars: number;
  /** Min ms between progress edits (throttle). */
  minEditIntervalMs: number;
}

export const DEFAULT_PROGRESS_POLICY: ProgressPolicy = {
  mode: "progress",
  startDelayMs: 2500,
  maxLines: 5,
  maxLineChars: 100,
  minEditIntervalMs: 400,
};

export interface DeliveryFence {
  instanceId: InstanceId;
  sessionGen: SessionGen;
  transportStamp: Generation;
}

export type DeliveryResult =
  | { ok: true; nativeMessageIds?: string[] }
  | { ok: false; reason: string; retryable?: boolean; commitUnknown?: boolean };

export type RenderFinalFormat = "native" | "compat" | "plain";

export interface RenderPolicy {
  finalFormat: RenderFinalFormat;
  sanitizeMarkdown: boolean;
  neutralizeMath: boolean;
  draftPreviews: boolean;
}

export interface AdapterStatus {
  channelId: ChannelId;
  profileId: ProfileId;
  state: "disconnected" | "connecting" | "connected" | "error";
  detail?: string;
  pairedOperatorId?: string;
}

export interface TransportOwner {
  instanceId: InstanceId;
  /** Called by adapter for each normalized inbound event */
  onEvent: (event: ChannelEvent) => void | Promise<void>;
  /** Shared agent temp root for downloads */
  tempDir: string;
}

export interface ChannelAdapter {
  readonly channelId: ChannelId;
  connect(
    profileId: ProfileId,
    owner: TransportOwner,
  ): Promise<void>;
  disconnect(profileId: ProfileId): Promise<void>;
  deliver(
    intent: OutboundIntent,
    fence: DeliveryFence,
  ): Promise<DeliveryResult>;
  status(profileId?: ProfileId): AdapterStatus | AdapterStatus[];
}

export interface ChannelRuntimeSnapshot {
  instanceId: InstanceId;
  sessionGen: SessionGen;
  activeTurn?: ChannelTurn;
  queued: number;
  adapters: AdapterStatus[];
}
