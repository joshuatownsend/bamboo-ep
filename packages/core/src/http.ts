import type { BaseUrlStyle, Credentials } from "./types.js";

/**
 * `fetch` is injected rather than imported so the same client runs in three
 * places: Node (undici) for tests and the probe CLI, and Tauri's plugin-http
 * inside the desktop app. BambooHR sends no CORS headers, so a browser `fetch`
 * can never talk to it directly - the injection point is what keeps `core`
 * free of that constraint.
 */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<FetchLikeResponse>;

export interface FetchLikeResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export function buildBaseUrl(subdomain: string, style: BaseUrlStyle): string {
  const sub = subdomain
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\.bamboohr\.com.*$/i, "");
  return style === "modern"
    ? `https://${sub}.bamboohr.com/api/v1`
    : `https://api.bamboohr.com/api/gateway.php/${sub}/v1`;
}

/** Basic auth with the API key as username and the literal "x" as password. */
export function authHeader(apiKey: string): string {
  const raw = `${apiKey}:x`;
  const b64 =
    typeof Buffer !== "undefined"
      ? Buffer.from(raw, "utf8").toString("base64")
      : btoa(raw);
  return `Basic ${b64}`;
}

export class BambooApiError extends Error {
  readonly status: number;
  /** Contents of the `X-BambooHR-Error-Message` header, when present. */
  readonly bambooMessage: string | null;
  readonly body: string;
  readonly url: string;

  constructor(args: {
    status: number;
    bambooMessage: string | null;
    body: string;
    url: string;
  }) {
    super(
      `BambooHR ${args.status} for ${redactUrl(args.url)}` +
        (args.bambooMessage ? `: ${args.bambooMessage}` : ""),
    );
    this.name = "BambooApiError";
    this.status = args.status;
    this.bambooMessage = args.bambooMessage;
    this.body = args.body;
    this.url = args.url;
  }

  /** 401/403 - bad key, insufficient permission, or API access switched off. */
  get isAuth(): boolean {
    return this.status === 401 || this.status === 403;
  }

  /**
   * BambooHR signals request throttling with 503, NOT 429. A 429 means the
   * account exceeded its employee-seat limit, which retrying cannot fix.
   */
  get isThrottle(): boolean {
    return this.status === 503;
  }
}

export interface RequestOptions {
  method?: string;
  /** Query string parameters; undefined values are dropped. */
  query?: Record<string, string | undefined>;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  /** Max retry attempts for throttling/transient failures. Default 3. */
  retries?: number;
  /** Injected for tests so backoff does not actually sleep. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class BambooHttp {
  constructor(
    private readonly fetchImpl: FetchLike,
    private readonly baseUrl: string,
    private readonly credentials: Credentials,
  ) {}

  get base(): string {
    return this.baseUrl;
  }

  /** GET returning parsed JSON. */
  async getJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const res = await this.request(path, options);
    const text = await res.text();
    if (!text.trim()) return null as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      // A JSON parse failure almost always means BambooHR served XML because
      // the Accept header did not survive, so say that rather than "bad JSON".
      throw new Error(
        `Expected JSON from ${redactUrl(this.url(path, options.query))} but got ` +
          `${text.slice(0, 80).replace(/\s+/g, " ")}`,
      );
    }
  }

  /**
   * GET returning raw bytes plus response headers, for file downloads.
   * `Content-Disposition` carries BambooHR's own filename for the file.
   */
  async getBinary(
    path: string,
    options: RequestOptions = {},
  ): Promise<{
    bytes: Uint8Array;
    contentType: string | null;
    disposition: string | null;
  }> {
    const res = await this.request(path, {
      ...options,
      headers: { Accept: "*/*", ...options.headers },
    });
    const buf = await res.arrayBuffer();
    return {
      bytes: new Uint8Array(buf),
      contentType: res.headers.get("content-type"),
      disposition: res.headers.get("content-disposition"),
    };
  }

  private url(path: string, query?: Record<string, string | undefined>): string {
    const suffix = path.startsWith("/") ? path : `/${path}`;
    const params = Object.entries(query ?? {}).filter(
      (e): e is [string, string] => e[1] !== undefined,
    );
    if (params.length === 0) return `${this.baseUrl}${suffix}`;
    const qs = params
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
    return `${this.baseUrl}${suffix}?${qs}`;
  }

  async request(
    path: string,
    options: RequestOptions = {},
  ): Promise<FetchLikeResponse> {
    const url = this.url(path, options.query);
    const maxAttempts = (options.retries ?? 3) + 1;
    const sleep = options.sleep ?? defaultSleep;

    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let res: FetchLikeResponse;
      try {
        res = await this.fetchImpl(url, {
          method: options.method ?? "GET",
          headers: {
            Accept: "application/json",
            Authorization: authHeader(this.credentials.apiKey),
            ...options.headers,
          },
          ...(options.body !== undefined ? { body: options.body } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        });
      } catch (err) {
        // Network-level failure: retry, since it is usually transient.
        lastError = err;
        if (attempt === maxAttempts - 1) throw err;
        await sleep(backoffMs(attempt));
        continue;
      }

      if (res.ok) return res;

      const bambooMessage = res.headers.get("x-bamboohr-error-message");
      const body = await safeText(res);
      const error = new BambooApiError({
        status: res.status,
        bambooMessage,
        body,
        url,
      });

      const retryable =
        res.status === 503 || res.status === 500 || res.status === 502;
      if (!retryable || attempt === maxAttempts - 1) throw error;

      // 503 may carry Retry-After (seconds, or an HTTP date). Honour it.
      const wait =
        retryAfterMs(res.headers.get("retry-after")) ?? backoffMs(attempt);
      lastError = error;
      await sleep(wait);
    }
    throw lastError instanceof Error ? lastError : new Error("Request failed");
  }
}

export function backoffMs(attempt: number): number {
  return Math.min(8000, 2 ** attempt * 500);
}

/** `Retry-After` is either delta-seconds or an HTTP date. Both are legal. */
export function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.min(seconds * 1000, 60_000);
  const when = Date.parse(header);
  if (Number.isNaN(when)) return null;
  return Math.max(0, Math.min(when - Date.now(), 60_000));
}

async function safeText(res: FetchLikeResponse): Promise<string> {
  try {
    return (await res.text()).slice(0, 2000);
  } catch {
    return "";
  }
}

/** Strip any credential-looking query params before an URL reaches a log. */
export function redactUrl(url: string): string {
  return url.replace(/([?&](?:key|apiKey|token)=)[^&]*/gi, "$1<redacted>");
}
