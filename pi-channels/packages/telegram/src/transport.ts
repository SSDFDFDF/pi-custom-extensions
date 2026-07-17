/**
 * Telegram Bot API transport: serial send queue, retries, IPv4 fallback.
 */

import { request as requestHttps } from "node:https";
import { Agent as HttpsAgent } from "node:https";

export const TELEGRAM_API_BASE = "https://api.telegram.org";

export type NetworkFamily = "auto" | "ipv4" | "ipv4-fallback";

export interface TelegramTransportOptions {
  botToken: string;
  apiBase?: string;
  networkFamily?: NetworkFamily;
  maxRetries?: number;
  /** Serialize all API calls through one chain (avoids progress/final races). */
  serialize?: boolean;
}

export interface TelegramApiResult {
  ok: boolean;
  description?: string;
  result?: unknown;
  error_code?: number;
  parameters?: { retry_after?: number };
}

const ipv4Agent = new HttpsAgent({ family: 4, keepAlive: true });

export class TelegramTransport {
  private readonly botToken: string;
  private readonly apiBase: string;
  private readonly networkFamily: NetworkFamily;
  private readonly maxRetries: number;
  private readonly serialize: boolean;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: TelegramTransportOptions) {
    this.botToken = options.botToken;
    this.apiBase = options.apiBase ?? TELEGRAM_API_BASE;
    this.networkFamily = options.networkFamily ?? "ipv4-fallback";
    this.maxRetries = options.maxRetries ?? 3;
    this.serialize = options.serialize !== false;
  }

  async call(
    method: string,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    const run = () => this.callWithRetry(method, body);
    return this.enqueue(run);
  }

  /** Multipart upload (sendPhoto / sendDocument). */
  async callMultipart(method: string, form: FormData): Promise<unknown> {
    const run = () => this.callMultipartWithRetry(method, form);
    return this.enqueue(run);
  }

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    if (!this.serialize) return run();
    const next = this.chain.then(run, run);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async downloadFile(
    filePath: string,
    preferIpv4 = false,
  ): Promise<Uint8Array> {
    const url = `${this.apiBase}/file/bot${this.botToken}/${filePath}`;
    return this.fetchBytes(url, preferIpv4);
  }

  private async callWithRetry(
    method: string,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.callOnce(method, body, attempt > 0);
      } catch (error) {
        lastError = error;
        const retryAfter = getRetryAfterMs(error);
        const retryable = isRetryableError(error);
        if (!retryable || attempt === this.maxRetries) break;
        const backoff = retryAfter ?? 400 * 2 ** attempt + Math.random() * 100;
        await sleep(backoff);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(String(lastError));
  }

  private async callOnce(
    method: string,
    body: Record<string, unknown> | undefined,
    preferIpv4: boolean,
  ): Promise<unknown> {
    const url = `${this.apiBase}/bot${this.botToken}/${method}`;
    const payload = body ? JSON.stringify(body) : undefined;

    const tryNative = async (): Promise<unknown> => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
      });
      return parseTelegramJson(await response.json());
    };

    const tryIpv4 = async (): Promise<unknown> => {
      const raw = await httpsJsonPost(url, payload, ipv4Agent);
      return parseTelegramJson(raw);
    };

    return this.withFamily(tryNative, tryIpv4, preferIpv4);
  }

  private async callMultipartWithRetry(
    method: string,
    form: FormData,
  ): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        // FormData can only be consumed once — rebuild is caller's job if needed.
        // We only retry transport errors before body is fully sent in practice.
        return await this.callMultipartOnce(method, form, attempt > 0);
      } catch (error) {
        lastError = error;
        const retryAfter = getRetryAfterMs(error);
        if (!isRetryableError(error) || attempt === this.maxRetries) break;
        // Cannot safely retry multipart after partial send with same FormData
        // in all runtimes; only retry clearly pre-send transport failures.
        if (!isTransportError(error) && !retryAfter) break;
        await sleep(retryAfter ?? 400 * 2 ** attempt);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(String(lastError));
  }

  private async callMultipartOnce(
    method: string,
    form: FormData,
    preferIpv4: boolean,
  ): Promise<unknown> {
    const url = `${this.apiBase}/bot${this.botToken}/${method}`;
    const tryNative = async () => {
      const response = await fetch(url, { method: "POST", body: form });
      return parseTelegramJson(await response.json());
    };
    // IPv4 multipart via undici/fetch is complex; for fallback rebuild is skip-
    // ped and we rely on native fetch with family preference via retry native only.
    if (preferIpv4 && this.networkFamily === "ipv4") {
      // Node fetch doesn't take agent; still use native path.
      return tryNative();
    }
    try {
      return await tryNative();
    } catch (error) {
      if (this.networkFamily === "ipv4-fallback" && isTransportError(error)) {
        // second attempt native (DNS may flip); true ipv4 multipart needs undici Agent
        return tryNative();
      }
      throw error;
    }
  }

  private async withFamily(
    tryNative: () => Promise<unknown>,
    tryIpv4: () => Promise<unknown>,
    preferIpv4: boolean,
  ): Promise<unknown> {
    if (this.networkFamily === "ipv4") {
      return tryIpv4();
    }

    if (this.networkFamily === "auto" || !preferIpv4) {
      try {
        return await tryNative();
      } catch (error) {
        if (
          this.networkFamily === "ipv4-fallback" &&
          isTransportError(error)
        ) {
          return tryIpv4();
        }
        throw error;
      }
    }

    try {
      return await tryIpv4();
    } catch {
      return tryNative();
    }
  }

  private async fetchBytes(
    url: string,
    preferIpv4: boolean,
  ): Promise<Uint8Array> {
    const tryNative = async () => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`download failed: HTTP ${response.status}`);
      }
      return new Uint8Array(await response.arrayBuffer());
    };
    const tryIpv4 = async () => httpsGetBytes(url, ipv4Agent);

    if (this.networkFamily === "ipv4") return tryIpv4();
    try {
      if (preferIpv4) return await tryIpv4();
      return await tryNative();
    } catch (error) {
      if (this.networkFamily === "ipv4-fallback" && isTransportError(error)) {
        return tryIpv4();
      }
      throw error;
    }
  }
}

function parseTelegramJson(raw: unknown): unknown {
  const json = raw as TelegramApiResult;
  if (!json || typeof json !== "object") {
    throw new Error("invalid telegram response");
  }
  if (!json.ok) {
    const err = new Error(json.description ?? "telegram api failed") as Error & {
      errorCode?: number;
      retryAfter?: number;
    };
    err.errorCode = json.error_code;
    if (typeof json.parameters?.retry_after === "number") {
      err.retryAfter = json.parameters.retry_after * 1000;
    }
    throw err;
  }
  return json.result;
}

function getRetryAfterMs(error: unknown): number | undefined {
  if (error && typeof error === "object" && "retryAfter" in error) {
    const value = (error as { retryAfter?: number }).retryAfter;
    if (typeof value === "number") return value;
  }
  return undefined;
}

function isRetryableError(error: unknown): boolean {
  if (isTransportError(error)) return true;
  if (error && typeof error === "object" && "errorCode" in error) {
    const code = (error as { errorCode?: number }).errorCode;
    return code === 429 || code === 500 || code === 502 || code === 503;
  }
  const msg = error instanceof Error ? error.message : String(error);
  return /timeout|ECONNRESET|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|429|Too Many|Bad Gateway|unavailable/i.test(
    msg,
  );
}

function isTransportError(error: unknown): boolean {
  if (!error) return false;
  const msg = error instanceof Error ? error.message : String(error);
  const cause =
    error instanceof Error && "cause" in error
      ? String((error as { cause?: unknown }).cause)
      : "";
  return /fetch failed|ETIMEDOUT|ENETUNREACH|ECONNRESET|EAI_AGAIN|socket|network|Timeout/i.test(
    `${msg} ${cause}`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpsJsonPost(
  url: string,
  body: string | undefined,
  agent: HttpsAgent,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = requestHttps(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || 443,
        path: `${target.pathname}${target.search}`,
        method: "POST",
        agent,
        headers: {
          "content-type": "application/json",
          ...(body
            ? { "content-length": Buffer.byteLength(body) }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk as Buffer));
        res.on("end", () => {
          try {
            const text = Buffer.concat(chunks).toString("utf8");
            resolve(JSON.parse(text) as unknown);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(60_000, () => {
      req.destroy(new Error("telegram https timeout"));
    });
    if (body) req.write(body);
    req.end();
  });
}

function httpsGetBytes(url: string, agent: HttpsAgent): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = requestHttps(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || 443,
        path: `${target.pathname}${target.search}`,
        method: "GET",
        agent,
      },
      (res) => {
        if ((res.statusCode ?? 500) >= 400) {
          reject(new Error(`download failed: HTTP ${res.statusCode}`));
          res.resume();
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk as Buffer));
        res.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
      },
    );
    req.on("error", reject);
    req.setTimeout(120_000, () => {
      req.destroy(new Error("telegram download timeout"));
    });
    req.end();
  });
}
