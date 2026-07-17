/**
 * QQ Bot OpenAPI v2 transport: access_token cache, serial HTTP, retries.
 *
 * Auth: POST https://bots.qq.com/app/getAppAccessToken
 * API:  https://api.sgroup.qq.com  (sandbox: https://sandbox.api.sgroup.qq.com)
 */

export const QQBOT_TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
export const QQBOT_API_BASE = "https://api.sgroup.qq.com";
export const QQBOT_SANDBOX_API_BASE = "https://sandbox.api.sgroup.qq.com";

export interface QqbotTransportOptions {
  appId: string;
  clientSecret: string;
  apiBase?: string;
  sandbox?: boolean;
  maxRetries?: number;
  serialize?: boolean;
}

interface TokenCache {
  accessToken: string;
  /** epoch ms when token should be refreshed */
  expiresAt: number;
}

export class QqbotTransport {
  private readonly appId: string;
  private readonly clientSecret: string;
  readonly apiBase: string;
  private readonly maxRetries: number;
  private readonly serialize: boolean;
  private token?: TokenCache;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(options: QqbotTransportOptions) {
    this.appId = options.appId;
    this.clientSecret = options.clientSecret;
    this.apiBase =
      options.apiBase ??
      (options.sandbox ? QQBOT_SANDBOX_API_BASE : QQBOT_API_BASE);
    this.maxRetries = options.maxRetries ?? 3;
    this.serialize = options.serialize !== false;
  }

  /** Authorization header value for Gateway Identify / HTTP. */
  async authHeader(): Promise<string> {
    const token = await this.getAccessToken();
    return `QQBot ${token}`;
  }

  async getAccessToken(force = false): Promise<string> {
    const now = Date.now();
    if (
      !force &&
      this.token &&
      this.token.expiresAt > now + 60_000
    ) {
      return this.token.accessToken;
    }

    const response = await fetch(QQBOT_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        appId: this.appId,
        clientSecret: this.clientSecret,
      }),
    });
    const json = (await response.json()) as {
      access_token?: string;
      expires_in?: number | string;
      message?: string;
      code?: number;
    };
    if (!json.access_token) {
      throw new Error(
        `qqbot token failed: ${json.message ?? JSON.stringify(json)}`,
      );
    }
    const expiresIn = Number(json.expires_in ?? 7200);
    this.token = {
      accessToken: json.access_token,
      // refresh 2 min early
      expiresAt: Date.now() + Math.max(60, expiresIn - 120) * 1000,
    };
    return this.token.accessToken;
  }

  async call(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    const run = () => this.callWithRetry(method, path, body);
    return this.enqueue(run);
  }

  async getGatewayUrl(): Promise<string> {
    const result = (await this.call("GET", "/gateway")) as { url?: string };
    if (!result?.url) {
      throw new Error("qqbot /gateway missing url");
    }
    return result.url;
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

  private async callWithRetry(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.callOnce(method, path, body, attempt > 0);
      } catch (error) {
        lastError = error;
        if (!isRetryableError(error) || attempt === this.maxRetries) break;
        // force token refresh on 401-ish
        if (isAuthError(error)) {
          this.token = undefined;
        }
        const retryAfter = getRetryAfterMs(error);
        await sleep(retryAfter ?? 400 * 2 ** attempt + Math.random() * 100);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(String(lastError));
  }

  private async callOnce(
    method: string,
    path: string,
    body: Record<string, unknown> | undefined,
    forceToken: boolean,
  ): Promise<unknown> {
    const token = await this.getAccessToken(forceToken);
    const url = path.startsWith("http")
      ? path
      : `${this.apiBase}${path.startsWith("/") ? path : `/${path}`}`;
    const response = await fetch(url, {
      method,
      headers: {
        authorization: `QQBot ${token}`,
        "content-type": "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await response.text();
    let json: unknown = undefined;
    if (text) {
      try {
        json = JSON.parse(text) as unknown;
      } catch {
        if (!response.ok) {
          throw httpError(response.status, text.slice(0, 200));
        }
        return text;
      }
    }

    if (!response.ok) {
      const errObj = json as {
        message?: string;
        msg?: string;
        code?: number;
        err_code?: number;
      } | null;
      const msg =
        errObj?.message ??
        errObj?.msg ??
        (typeof json === "string" ? json : text.slice(0, 200));
      const code = errObj?.code ?? errObj?.err_code ?? response.status;
      throw apiError(code, msg, response.status);
    }

    // Some endpoints wrap { code, data }; pass through
    return json;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpError(status: number, body: string): Error {
  const err = new Error(`qqbot HTTP ${status}: ${body}`) as Error & {
    status?: number;
    errorCode?: number;
  };
  err.status = status;
  err.errorCode = status;
  return err;
}

function apiError(code: number, message: string, status: number): Error {
  const err = new Error(`qqbot ${code}: ${message}`) as Error & {
    status?: number;
    errorCode?: number;
  };
  err.status = status;
  err.errorCode = code;
  return err;
}

function getRetryAfterMs(error: unknown): number | undefined {
  if (error && typeof error === "object" && "retryAfter" in error) {
    const value = (error as { retryAfter?: number }).retryAfter;
    if (typeof value === "number") return value;
  }
  return undefined;
}

function isAuthError(error: unknown): boolean {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status?: number }).status;
    if (status === 401 || status === 11244 || status === 11243) return true;
  }
  const msg = error instanceof Error ? error.message : String(error);
  return /unauthorized|token|access_token|401/i.test(msg);
}

function isRetryableError(error: unknown): boolean {
  if (isAuthError(error)) return true;
  if (error && typeof error === "object" && "errorCode" in error) {
    const code = (error as { errorCode?: number }).errorCode;
    if (code === 429 || code === 500 || code === 502 || code === 503) return true;
    // QQ rate limit
    if (code === 22009) return true;
  }
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status?: number }).status;
    if (status === 429 || status === 500 || status === 502 || status === 503) {
      return true;
    }
  }
  const msg = error instanceof Error ? error.message : String(error);
  return /timeout|ECONNRESET|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|429|Too Many|Bad Gateway|unavailable|fetch failed/i.test(
    msg,
  );
}
