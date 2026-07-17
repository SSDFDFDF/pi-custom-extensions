/**
 * QQ Bot Gateway WebSocket: Hello → Identify → Heartbeat → Dispatch.
 *
 * Intents: GROUP_AND_C2C_EVENT = 1 << 25 (private chat + group @ events).
 */

export const INTENT_GROUP_AND_C2C = 1 << 25;

export type GatewayDispatchHandler = (event: {
  t: string;
  d: unknown;
  s: number | null;
}) => void | Promise<void>;

export interface QqbotGatewayOptions {
  /** Resolve fresh `QQBot <token>` each connect / resume. */
  getAuthorization: () => Promise<string>;
  /** wss://…/websocket from GET /gateway */
  getUrl: () => Promise<string>;
  intents?: number;
  /** shard [id, total]; solo bot uses [0,1] */
  shard?: [number, number];
  onDispatch: GatewayDispatchHandler;
  onState?: (state: "connecting" | "ready" | "reconnecting" | "closed", detail?: string) => void;
  log?: (message: string) => void;
}

interface HelloPayload {
  heartbeat_interval: number;
}

interface ReadyPayload {
  session_id?: string;
  user?: { id?: string; username?: string };
}

/**
 * Minimal resilient gateway client for a single shard.
 */
export class QqbotGateway {
  private readonly options: QqbotGatewayOptions;
  private ws?: WebSocket;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private heartbeatInterval = 45_000;
  private lastSeq: number | null = null;
  private sessionId?: string;
  private stopped = false;
  private reconnectAttempt = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;

  constructor(options: QqbotGatewayOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect(false);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.clearHeartbeat();
    const ws = this.ws;
    this.ws = undefined;
    if (ws) {
      try {
        ws.close(1000, "client stop");
      } catch {
        // ignore
      }
    }
    this.options.onState?.("closed", "stopped");
  }

  private async connect(resume: boolean): Promise<void> {
    if (this.stopped) return;
    this.options.onState?.("connecting", resume ? "resume" : "identify");
    this.clearHeartbeat();

    let url: string;
    try {
      url = await this.options.getUrl();
    } catch (error) {
      this.scheduleReconnect(`gateway url: ${errorMessage(error)}`);
      return;
    }

    let auth: string;
    try {
      auth = await this.options.getAuthorization();
    } catch (error) {
      this.scheduleReconnect(`auth: ${errorMessage(error)}`);
      return;
    }

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.log("ws open");
    });

    ws.addEventListener("message", (ev) => {
      void this.onMessage(String(ev.data), auth, resume);
    });

    ws.addEventListener("error", () => {
      this.log("ws error");
    });

    ws.addEventListener("close", (ev) => {
      this.clearHeartbeat();
      if (this.ws === ws) this.ws = undefined;
      if (this.stopped) return;
      this.scheduleReconnect(`close ${ev.code} ${ev.reason || ""}`.trim());
    });
  }

  private async onMessage(
    raw: string,
    auth: string,
    wantResume: boolean,
  ): Promise<void> {
    let payload: {
      op: number;
      d?: unknown;
      s?: number | null;
      t?: string | null;
    };
    try {
      payload = JSON.parse(raw) as typeof payload;
    } catch {
      return;
    }

    if (typeof payload.s === "number") {
      this.lastSeq = payload.s;
    }

    switch (payload.op) {
      case 10: {
        // Hello
        const hello = payload.d as HelloPayload;
        this.heartbeatInterval = hello?.heartbeat_interval ?? 45_000;
        if (wantResume && this.sessionId && this.lastSeq !== null) {
          this.send({
            op: 6,
            d: {
              token: auth,
              session_id: this.sessionId,
              seq: this.lastSeq,
            },
          });
        } else {
          this.send({
            op: 2,
            d: {
              token: auth,
              intents: this.options.intents ?? INTENT_GROUP_AND_C2C,
              shard: this.options.shard ?? [0, 1],
            },
          });
        }
        this.startHeartbeat();
        break;
      }
      case 11:
        // Heartbeat ACK
        break;
      case 7:
        // Reconnect
        this.log("server requested reconnect");
        try {
          this.ws?.close(4000, "reconnect");
        } catch {
          // ignore
        }
        break;
      case 9:
        // Invalid session
        this.sessionId = undefined;
        this.lastSeq = null;
        this.log("invalid session — re-identify");
        try {
          this.ws?.close(4000, "invalid session");
        } catch {
          // ignore
        }
        break;
      case 0: {
        const t = payload.t ?? "";
        const d = payload.d;
        if (t === "READY") {
          const ready = d as ReadyPayload;
          this.sessionId = ready?.session_id;
          this.reconnectAttempt = 0;
          const name = ready?.user?.username ?? ready?.user?.id ?? "bot";
          this.options.onState?.("ready", name);
          this.log(`READY session=${this.sessionId ?? "?"} bot=${name}`);
        } else if (t === "RESUMED") {
          this.reconnectAttempt = 0;
          this.options.onState?.("ready", "resumed");
          this.log("RESUMED");
        }
        if (t) {
          try {
            await this.options.onDispatch({
              t,
              d,
              s: typeof payload.s === "number" ? payload.s : null,
            });
          } catch (error) {
            this.log(`dispatch ${t} error: ${errorMessage(error)}`);
          }
        }
        break;
      }
      default:
        break;
    }
  }

  private send(payload: unknown): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(payload));
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({ op: 1, d: this.lastSeq });
    }, this.heartbeatInterval);
    // unref so process can exit if needed
    this.heartbeatTimer.unref?.();
    // immediate heartbeat after identify is recommended by some bots
    this.send({ op: 1, d: this.lastSeq });
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped) return;
    this.options.onState?.("reconnecting", reason);
    this.reconnectAttempt += 1;
    const delay = Math.min(
      30_000,
      1000 * 2 ** Math.min(this.reconnectAttempt, 5),
    );
    this.log(`reconnect in ${delay}ms (${reason})`);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect(Boolean(this.sessionId));
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private log(message: string): void {
    this.options.log?.(message);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
