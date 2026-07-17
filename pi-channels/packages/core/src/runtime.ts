/**
 * ChannelRuntime — adapters + queue + Pi ports.
 *
 * P0 ownership: a channel-owned agent run is identified by runToken bound at
 * dispatch time and claimed on agent_start. Local TUI runs have no token and
 * never receive progress/final delivery to channels.
 */

import { randomUUID } from "node:crypto";

import {
  abortKeepQueue,
  beginDispatch,
  clearActiveTurn,
  createChannelQueueState,
  enqueueTurn,
  markTurnRunning,
  queueLength,
  stopClearQueue,
  type ChannelQueueState,
} from "./queue.ts";
import {
  createProgressDraftState,
  formatToolProgressLine,
  normalizeProgressPolicy,
  pushProgressLine,
  renderProgressDraftText,
  shouldThrottleEdit,
  targetKey,
  type ProgressDraftState,
} from "./progress.ts";
import { isMultimodalImageAttachment } from "./media.ts";
import type {
  ChannelAdapter,
  ChannelEvent,
  ChannelRuntimeSnapshot,
  ChannelTarget,
  ChannelTurn,
  DeliveryFence,
  Generation,
  InstanceId,
  LocalFile,
  OutboundIntent,
  PiPromptContent,
  ProfileId,
  ProgressPolicy,
  QueueLane,
  SessionGen,
} from "./types.ts";

export interface PiChannelPorts {
  isIdle(): boolean;
  hasPendingMessages?: () => boolean;
  sendUserMessage(
    content: PiPromptContent[],
    options?: { deliverAs?: "steer" | "followUp" },
  ): Promise<void> | void;
  abortActive?: () => void;
  log?: (message: string) => void;
}

export interface ChannelRuntimeOptions {
  instanceId: InstanceId;
  ports: PiChannelPorts;
  transportStamp?: Generation;
  progress?: Partial<ProgressPolicy>;
}

/** Channel turn currently tied to the Pi agent loop (or awaiting agent_start). */
interface ChannelRunBinding {
  token: string;
  turn: ChannelTurn;
  phase: "awaiting_agent" | "running";
  /** Files queued via channel_attach during this run; sent after final text. */
  outboundFiles: LocalFile[];
}

export class ChannelRuntime {
  readonly instanceId: InstanceId;
  private sessionGen: SessionGen = 0;
  private transportStamp: Generation;
  private queue: ChannelQueueState = createChannelQueueState();
  private adapters = new Map<string, ChannelAdapter>();
  private ports: PiChannelPorts;
  private lastTarget?: ChannelTarget;

  /** Bound channel-owned agent run; undefined = local/TUI-only work. */
  private channelRun?: ChannelRunBinding;

  private readonly progressPolicy: ProgressPolicy;
  private progressDraft?: ProgressDraftState;
  private progressStartTimer?: ReturnType<typeof setTimeout>;
  private progressFlushTimer?: ReturnType<typeof setTimeout>;
  /** Bumped on every clear; async flushes abort if stale. */
  private progressEpoch = 0;
  /** Final text held from agent_end until agent_settled (avoids retry races). */
  private pendingFinal?: {
    token: string;
    turn: ChannelTurn;
    text: string;
  };

  constructor(options: ChannelRuntimeOptions) {
    this.instanceId = options.instanceId;
    this.ports = options.ports;
    this.transportStamp = options.transportStamp ?? `gen:${randomUUID()}`;
    this.progressPolicy = normalizeProgressPolicy(options.progress);
  }

  registerAdapter(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.channelId, adapter);
  }

  getAdapter(channelId: string): ChannelAdapter | undefined {
    return this.adapters.get(channelId);
  }

  bumpSession(): void {
    this.sessionGen += 1;
    this.queue = clearActiveTurn(this.queue);
    this.channelRun = undefined;
    this.pendingFinal = undefined;
    void this.clearProgressDraft();
  }

  /** Full teardown for session_shutdown. */
  async shutdown(): Promise<void> {
    this.channelRun = undefined;
    this.pendingFinal = undefined;
    this.queue = stopClearQueue(this.queue);
    await this.clearProgressDraft();
  }

  fence(): DeliveryFence {
    return {
      instanceId: this.instanceId,
      sessionGen: this.sessionGen,
      transportStamp: this.transportStamp,
    };
  }

  snapshot(): ChannelRuntimeSnapshot {
    const adapters = [...this.adapters.values()].flatMap((adapter) => {
      const status = adapter.status();
      return Array.isArray(status) ? status : [status];
    });
    return {
      instanceId: this.instanceId,
      sessionGen: this.sessionGen,
      activeTurn: this.queue.active ?? this.channelRun?.turn,
      queued: this.queue.items.length,
      adapters,
    };
  }

  isChannelOwnedRun(): boolean {
    return this.channelRun !== undefined;
  }

  async handleEvent(event: ChannelEvent): Promise<void> {
    if (event.type === "control") {
      await this.handleControl(event.name, event.target);
      return;
    }

    if (event.type === "command") {
      const text = withChannelPrefix(
        event.target.channelId,
        `/${event.name}${event.args ? ` ${event.args}` : ""}`,
      );
      await this.enqueuePrompt(event, [{ type: "text", text }], "default");
      return;
    }

    if (event.type === "action") {
      const body = event.payload
        ? `[action:${event.actionId}] ${event.payload}`
        : `[action:${event.actionId}]`;
      const text = withChannelPrefix(event.target.channelId, body);
      await this.enqueuePrompt(event, [{ type: "text", text }], "priority");
      return;
    }

    if (event.type === "message") {
      const content: PiPromptContent[] = [];
      if (event.text?.trim()) {
        content.push({
          type: "text",
          text: withChannelPrefix(event.target.channelId, event.text),
        });
      }
      for (const file of event.attachments ?? []) {
        // Photos and image/* documents both enter as multimodal images.
        if (file.path && isMultimodalImageAttachment(file)) {
          content.push({
            type: "image",
            path: file.path,
            mimeType: file.mimeType,
          });
        } else if (file.path) {
          content.push({
            type: "text",
            text: withChannelPrefix(
              event.target.channelId,
              `[attachment ${file.kind}] ${file.path}${file.fileName ? ` (${file.fileName})` : ""}`,
            ),
          });
        } else if (file.remoteId) {
          content.push({
            type: "text",
            text: withChannelPrefix(
              event.target.channelId,
              `[attachment ${file.kind} undownloaded remoteId=${file.remoteId}]`,
            ),
          });
        }
      }
      if (
        content.length > 0 &&
        content.every((block) => block.type !== "text")
      ) {
        content.unshift({
          type: "text",
          text: channelPrefix(event.target.channelId),
        });
      }
      if (content.length === 0) return;
      await this.enqueuePrompt(event, content, "default");
    }
  }

  private async handleControl(
    name: "abort" | "stop" | "next" | "continue" | "compact",
    target: ChannelTarget,
  ): Promise<void> {
    this.lastTarget = target;
    if (name === "stop") {
      this.ports.abortActive?.();
      this.queue = stopClearQueue(this.queue);
      this.channelRun = undefined;
      this.pendingFinal = undefined;
      await this.clearProgressDraft();
      await this.notice(target, "stopped (queue cleared)");
      return;
    }
    if (name === "abort") {
      this.ports.abortActive?.();
      this.queue = abortKeepQueue(this.queue);
      this.channelRun = undefined;
      this.pendingFinal = undefined;
      await this.clearProgressDraft();
      await this.notice(target, "aborted (queue kept)");
      await this.kickDispatch();
      return;
    }
    if (name === "next") {
      this.ports.abortActive?.();
      this.queue = clearActiveTurn(this.queue);
      this.channelRun = undefined;
      this.pendingFinal = undefined;
      await this.clearProgressDraft();
      await this.kickDispatch();
      return;
    }
    if (name === "continue") {
      const turn = this.makeTurn(
        target,
        [
          {
            type: "text",
            text: withChannelPrefix(target.channelId, "continue"),
          },
        ],
        "control",
        [],
      );
      this.queue = enqueueTurn(this.queue, turn);
      await this.kickDispatch();
      return;
    }
    await this.notice(
      target,
      "compact: use Pi /compact in the terminal for now",
    );
  }

  private async notice(target: ChannelTarget, text: string): Promise<void> {
    const adapter = this.adapters.get(target.channelId);
    if (!adapter) return;
    await adapter.deliver(
      { kind: "notice", target, text, level: "info" },
      this.fence(),
    );
  }

  private makeTurn(
    target: ChannelTarget,
    content: PiPromptContent[],
    lane: QueueLane,
    sourceEventIds: string[],
    replyTo?: ChannelTurn["replyTo"],
  ): ChannelTurn {
    return {
      turnId: randomUUID(),
      lane,
      target,
      sourceEventIds,
      content,
      createdAt: Date.now(),
      transportStamp: this.transportStamp,
      sessionGen: this.sessionGen,
      ...(replyTo ? { replyTo } : {}),
    };
  }

  private replyToFromEvent(
    event: ChannelEvent,
  ): ChannelTurn["replyTo"] | undefined {
    // Prefer explicit inbound reply chain; else anchor on the triggering message.
    if (event.replyTo) return event.replyTo;
    if (event.rawRef !== undefined) {
      return { raw: event.rawRef };
    }
    return undefined;
  }

  private async enqueuePrompt(
    event: ChannelEvent,
    content: PiPromptContent[],
    lane: QueueLane,
  ): Promise<void> {
    this.lastTarget = event.target;
    const turn = this.makeTurn(
      event.target,
      content,
      lane,
      [event.eventId],
      this.replyToFromEvent(event),
    );
    this.queue = enqueueTurn(this.queue, turn);
    void this.adapters.get(event.target.channelId)?.deliver(
      { kind: "typing", target: event.target, active: true },
      this.fence(),
    );
    await this.kickDispatch();
  }

  async kickDispatch(): Promise<void> {
    if (!this.ports.isIdle()) return;
    if (this.ports.hasPendingMessages?.()) return;
    if (this.queue.active || this.queue.pendingDispatch) return;
    if (this.channelRun || this.pendingFinal) return;

    const { state, turn } = beginDispatch(this.queue);
    this.queue = state;
    if (!turn) return;

    const token = randomUUID();
    this.channelRun = {
      token,
      turn,
      phase: "awaiting_agent",
      outboundFiles: [],
    };

    try {
      void this.adapters.get(turn.target.channelId)?.deliver(
        { kind: "typing", target: turn.target, active: true },
        this.fence(),
      );
      await this.ports.sendUserMessage(turn.content, {
        deliverAs: "followUp",
      });
      // agent_start may already have claimed the run (sync delivery).
      if (this.channelRun?.token === token && this.channelRun.phase === "awaiting_agent") {
        // still waiting for agent_start; keep binding
      }
    } catch (error) {
      if (this.channelRun?.token === token) this.channelRun = undefined;
      this.queue = clearActiveTurn(this.queue);
      this.ports.log?.(
        `dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.notice(
        turn.target,
        `dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Claim a pending channel dispatch, or ignore local/TUI agent starts.
   */
  onAgentStart(): void {
    const run = this.channelRun;
    if (!run) {
      // Local run — do not attach channel progress/final.
      return;
    }
    if (run.phase === "awaiting_agent") {
      this.channelRun = {
        token: run.token,
        turn: run.turn,
        phase: "running",
        outboundFiles: run.outboundFiles,
      };
      this.queue = markTurnRunning(this.queue);
      this.scheduleProgressDraft(run.token, run.turn.target);
      return;
    }
    // Already running: keep binding (multi-step agent loops share one turn).
  }

  /**
   * Buffer final text for channel-owned runs. Actual send happens on settled
   * so auto-retry/compaction does not leave orphan answers mid-loop.
   */
  async onAgentEnd(finalMarkdown: string | undefined): Promise<void> {
    const run = this.channelRun;
    if (!run) {
      // Local end — only try to drain channel queue when fully idle later.
      return;
    }

    const text = finalMarkdown?.trim() ?? "";
    if (text) {
      this.pendingFinal = {
        token: run.token,
        turn: run.turn,
        text,
      };
    }
    // Keep channelRun until settled so tools in retry still map to progress.
  }

  /**
   * After Pi will not auto-continue: clear progress, send final, release bind, drain.
   */
  async onAgentSettled(): Promise<void> {
    const run = this.channelRun;
    const pending = this.pendingFinal;

    // Only finalize if we still own the same run token.
    if (run) {
      const token = run.token;
      const turn = run.turn;
      this.channelRun = undefined;
      this.queue = clearActiveTurn(this.queue);

      await this.clearProgressDraft();

      const finalText =
        pending && pending.token === token ? pending.text : undefined;
      this.pendingFinal = undefined;

      const adapter = this.adapters.get(turn.target.channelId);
      if (adapter && finalText) {
        const result = await adapter.deliver(
          {
            kind: "final",
            target: turn.target,
            text: finalText,
            format: "markdown",
            ...(turn.replyTo ? { replyTo: turn.replyTo } : {}),
          },
          this.fence(),
        );
        if (!result.ok) {
          this.ports.log?.(`deliver failed: ${result.reason}`);
        }
      }

      // Outbound files queued during the turn (channel_attach).
      const files = run.outboundFiles;
      if (adapter && files.length > 0) {
        const attachResult = await adapter.deliver(
          {
            kind: "attach",
            target: turn.target,
            files,
            ...(turn.replyTo ? { replyTo: turn.replyTo } : {}),
          },
          this.fence(),
        );
        if (!attachResult.ok) {
          this.ports.log?.(`attach failed: ${attachResult.reason}`);
        }
      }
    } else if (pending) {
      // Stale pending without run — drop.
      this.pendingFinal = undefined;
    }

    await this.kickDispatch();
  }

  /**
   * Queue files for the active channel run (sent after final on settled),
   * or send immediately to lastTarget when no run is active.
   */
  async attachFiles(
    files: LocalFile[],
  ): Promise<{ mode: "queued" | "sent"; count: number }> {
    const normalized = files.filter((file) => file.path?.trim());
    if (normalized.length === 0) {
      throw new Error("channel_attach: no valid file paths");
    }

    const run = this.channelRun;
    if (run) {
      run.outboundFiles.push(...normalized);
      return { mode: "queued", count: normalized.length };
    }

    const target = this.lastTarget;
    if (!target) {
      throw new Error(
        "channel_attach: no active channel turn and no last target — connect and message from the channel first",
      );
    }
    const adapter = this.adapters.get(target.channelId);
    if (!adapter) {
      throw new Error(`channel_attach: no adapter for ${target.channelId}`);
    }
    const result = await adapter.deliver(
      { kind: "attach", target, files: normalized },
      this.fence(),
    );
    if (!result.ok) {
      throw new Error(`channel_attach failed: ${result.reason}`);
    }
    return { mode: "sent", count: normalized.length };
  }

  getActiveChannelTarget(): ChannelTarget | undefined {
    return this.channelRun?.turn.target ?? this.lastTarget;
  }

  /** Tool started — only for bound channel runs. */
  async onToolStart(toolName: string, args?: unknown): Promise<void> {
    if (this.progressPolicy.mode !== "progress") return;
    const run = this.channelRun;
    if (!run) return;

    const target = run.turn.target;
    const line = formatToolProgressLine(
      toolName,
      args,
      this.progressPolicy.maxLineChars,
    );

    if (
      !this.progressDraft ||
      this.progressDraft.runToken !== run.token ||
      targetKey(this.progressDraft.target) !== targetKey(target)
    ) {
      this.progressDraft = {
        ...createProgressDraftState(target),
        runToken: run.token,
      };
    }

    this.progressDraft = {
      ...pushProgressLine(this.progressDraft, line, this.progressPolicy),
      runToken: run.token,
    };

    // First paint may force-create; subsequent edits respect throttle.
    await this.flushProgressDraft({
      forceMaterialize: !this.progressDraft.materialized,
      runToken: run.token,
    });
  }

  private scheduleProgressDraft(runToken: string, target: ChannelTarget): void {
    if (this.progressPolicy.mode !== "progress") return;
    if (this.progressStartTimer) clearTimeout(this.progressStartTimer);

    if (!this.progressDraft || this.progressDraft.runToken !== runToken) {
      this.progressDraft = {
        ...createProgressDraftState(target),
        runToken,
      };
    }

    const epoch = this.progressEpoch;
    this.progressStartTimer = setTimeout(() => {
      this.progressStartTimer = undefined;
      if (this.progressEpoch !== epoch) return;
      if (this.channelRun?.token !== runToken) return;
      void this.flushProgressDraft({
        forceMaterialize: true,
        runToken,
      });
    }, this.progressPolicy.startDelayMs);
    this.progressStartTimer.unref?.();
  }

  private async flushProgressDraft(options?: {
    forceMaterialize?: boolean;
    runToken?: string;
  }): Promise<void> {
    const epoch = this.progressEpoch;
    const draft = this.progressDraft;
    if (!draft || this.progressPolicy.mode !== "progress") return;

    const runToken = options?.runToken ?? draft.runToken;
    if (runToken && this.channelRun?.token !== runToken) return;
    if (runToken && draft.runToken && draft.runToken !== runToken) return;

    if (!this.channelRun && !draft.materialized) return;

    const now = Date.now();
    const forceFirstPaint =
      options?.forceMaterialize === true && !draft.materialized;

    if (
      draft.materialized &&
      shouldThrottleEdit(draft, this.progressPolicy, now) &&
      !forceFirstPaint
    ) {
      // Coalesce: schedule one trailing flush (do not bypass throttle).
      if (!this.progressFlushTimer) {
        const wait = Math.max(
          50,
          this.progressPolicy.minEditIntervalMs - (now - draft.lastEditAt),
        );
        this.progressFlushTimer = setTimeout(() => {
          this.progressFlushTimer = undefined;
          void this.flushProgressDraft({ runToken: draft.runToken });
        }, wait);
        this.progressFlushTimer.unref?.();
      }
      return;
    }

    if (
      !draft.materialized &&
      !forceFirstPaint &&
      !options?.forceMaterialize &&
      draft.lines.length === 0 &&
      now - draft.createdAt < this.progressPolicy.startDelayMs
    ) {
      return;
    }

    const adapter = this.adapters.get(draft.target.channelId);
    if (!adapter) return;
    const text = renderProgressDraftText(draft);
    const result = await adapter.deliver(
      { kind: "progress", target: draft.target, text, slot: "run" },
      this.fence(),
    );

    // Abort if cleared/replaced while awaiting network.
    if (this.progressEpoch !== epoch) return;
    if (runToken && this.channelRun?.token !== runToken) return;
    if (this.progressDraft?.runToken && runToken && this.progressDraft.runToken !== runToken) {
      return;
    }

    if (result.ok && this.progressDraft) {
      this.progressDraft = {
        ...this.progressDraft,
        materialized: true,
        lastEditAt: Date.now(),
      };
    } else if (!result.ok) {
      this.ports.log?.(`progress deliver failed: ${result.reason}`);
    }
  }

  async clearProgressDraft(): Promise<void> {
    this.progressEpoch += 1;
    if (this.progressStartTimer) {
      clearTimeout(this.progressStartTimer);
      this.progressStartTimer = undefined;
    }
    if (this.progressFlushTimer) {
      clearTimeout(this.progressFlushTimer);
      this.progressFlushTimer = undefined;
    }
    const draft = this.progressDraft;
    this.progressDraft = undefined;
    if (!draft?.materialized) return;
    const adapter = this.adapters.get(draft.target.channelId);
    if (!adapter) return;
    await adapter.deliver(
      { kind: "progress_clear", target: draft.target, slot: "run" },
      this.fence(),
    );
  }

  async deliver(intent: OutboundIntent): Promise<void> {
    const adapter = this.adapters.get(intent.target.channelId);
    if (!adapter) {
      throw new Error(`no adapter for channel ${intent.target.channelId}`);
    }
    await adapter.deliver(intent, this.fence());
  }

  describeQueue(): string {
    const run = this.channelRun
      ? `${this.channelRun.phase}:${this.channelRun.token.slice(0, 8)}`
      : "none";
    return `active=${this.queue.active?.turnId ?? "none"} queued=${this.queue.items.length} total=${queueLength(this.queue)} run=${run}`;
  }
}

export function profileKey(channelId: string, profileId: ProfileId): string {
  return `${channelId}:${profileId}`;
}

export function channelShortId(channelId: string): string {
  if (channelId === "telegram") return "tg";
  return channelId.length <= 6 ? channelId : channelId.slice(0, 6);
}

export function channelPrefix(channelId: string): string {
  return `[ch:${channelShortId(channelId)}]`;
}

export function withChannelPrefix(channelId: string, body: string): string {
  const prefix = channelPrefix(channelId);
  const text = body.trimStart();
  if (!text) return prefix;
  if (text.startsWith(prefix)) return text;
  return `${prefix}\n${text}`;
}
