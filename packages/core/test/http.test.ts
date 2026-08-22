import { describe, expect, it, vi } from "vitest";
import {
  BambooApiError,
  BambooHttp,
  authHeader,
  buildBaseUrl,
  redactUrl,
  retryAfterMs,
} from "../src/http.js";
import type { FetchLike, FetchLikeResponse } from "../src/http.js";

const credentials = { subdomain: "acme", apiKey: "key-123" };

function response(init: {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}): FetchLikeResponse {
  const headers = new Map(
    Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: init.status >= 200 && init.status < 300,
    status: init.status,
    headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
    text: async () => init.body ?? "",
    arrayBuffer: async () => new TextEncoder().encode(init.body ?? "").buffer as ArrayBuffer,
  };
}

/** Returns the queued responses in order, recording every call. */
function stubFetch(queue: FetchLikeResponse[]): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(url);
    const next = queue.shift();
    if (!next) throw new Error("unexpected extra request");
    return next;
  }) as FetchLike & { calls: string[] };
  impl.calls = calls;
  return impl;
}

const noSleep = async () => {};

describe("buildBaseUrl", () => {
  it("builds both endpoint forms", () => {
    expect(buildBaseUrl("acme", "modern")).toBe("https://acme.bamboohr.com/api/v1");
    expect(buildBaseUrl("acme", "legacy")).toBe(
      "https://api.bamboohr.com/api/gateway.php/acme/v1",
    );
  });

  it("tolerates a user pasting a full URL instead of a subdomain", () => {
    expect(buildBaseUrl("https://acme.bamboohr.com/home", "modern")).toBe(
      "https://acme.bamboohr.com/api/v1",
    );
  });
});

describe("authHeader", () => {
  it("uses the API key as username with the literal password 'x'", () => {
    expect(authHeader("key-123")).toBe(`Basic ${Buffer.from("key-123:x").toString("base64")}`);
  });
});

describe("retryAfterMs", () => {
  it("parses delta-seconds", () => {
    expect(retryAfterMs("2")).toBe(2000);
  });

  it("parses an HTTP date", () => {
    const future = new Date(Date.now() + 5000).toUTCString();
    expect(retryAfterMs(future)).toBeGreaterThan(3000);
  });

  it("caps absurd values and rejects nonsense", () => {
    expect(retryAfterMs("999999")).toBe(60_000);
    expect(retryAfterMs("soon")).toBeNull();
    expect(retryAfterMs(null)).toBeNull();
  });
});

describe("BambooHttp retry behaviour", () => {
  it("retries a 503 and honours Retry-After", async () => {
    const fetchImpl = stubFetch([
      response({ status: 503, headers: { "retry-after": "1" } }),
      response({ status: 200, body: '{"id":"42"}' }),
    ]);
    const sleep = vi.fn(async () => {});
    const http = new BambooHttp(fetchImpl, buildBaseUrl("acme", "modern"), credentials);

    const result = await http.getJson<{ id: string }>("/employees/0", { sleep });

    expect(result.id).toBe("42");
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it("does NOT retry a 429 - it means the employee-seat limit, not throttling", async () => {
    const fetchImpl = stubFetch([response({ status: 429 })]);
    const http = new BambooHttp(fetchImpl, buildBaseUrl("acme", "modern"), credentials);

    await expect(http.getJson("/employees/0", { sleep: noSleep })).rejects.toThrow(
      BambooApiError,
    );
    expect(fetchImpl.calls).toHaveLength(1);
  });

  it("does not retry a 403", async () => {
    const fetchImpl = stubFetch([response({ status: 403 })]);
    const http = new BambooHttp(fetchImpl, buildBaseUrl("acme", "modern"), credentials);

    await expect(http.getJson("/training/type", { sleep: noSleep })).rejects.toMatchObject({
      status: 403,
      isAuth: true,
    });
    expect(fetchImpl.calls).toHaveLength(1);
  });

  it("gives up after the configured number of retries", async () => {
    const fetchImpl = stubFetch([
      response({ status: 503 }),
      response({ status: 503 }),
      response({ status: 503 }),
    ]);
    const http = new BambooHttp(fetchImpl, buildBaseUrl("acme", "modern"), credentials);

    await expect(
      http.getJson("/employees/0", { retries: 2, sleep: noSleep }),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetchImpl.calls).toHaveLength(3);
  });

  it("surfaces the X-BambooHR-Error-Message header in the error", async () => {
    const fetchImpl = stubFetch([
      response({ status: 403, headers: { "x-bamboohr-error-message": "API access disabled" } }),
    ]);
    const http = new BambooHttp(fetchImpl, buildBaseUrl("acme", "modern"), credentials);

    await expect(http.getJson("/employees/0", { sleep: noSleep })).rejects.toMatchObject({
      bambooMessage: "API access disabled",
    });
  });

  it("explains an XML response rather than reporting a JSON parse failure", async () => {
    const fetchImpl = stubFetch([
      response({ status: 200, body: "<?xml version='1.0'?><employee/>" }),
    ]);
    const http = new BambooHttp(fetchImpl, buildBaseUrl("acme", "modern"), credentials);

    await expect(http.getJson("/employees/0", { sleep: noSleep })).rejects.toThrow(
      /Expected JSON/,
    );
  });

  it("sends Accept and Authorization on every request", async () => {
    let seen: Record<string, string> | undefined;
    const fetchImpl: FetchLike = async (_url, init) => {
      seen = init?.headers;
      return response({ status: 200, body: "{}" });
    };
    const http = new BambooHttp(fetchImpl, buildBaseUrl("acme", "modern"), credentials);
    await http.getJson("/employees/0");

    expect(seen?.["Accept"]).toBe("application/json");
    expect(seen?.["Authorization"]).toBe(authHeader("key-123"));
  });

  it("builds query strings and drops undefined values", async () => {
    const fetchImpl = stubFetch([response({ status: 200, body: "{}" })]);
    const http = new BambooHttp(fetchImpl, buildBaseUrl("acme", "modern"), credentials);
    await http.getJson("/training/record/employee/1", {
      query: { type: "12", other: undefined },
    });

    expect(fetchImpl.calls[0]).toBe(
      "https://acme.bamboohr.com/api/v1/training/record/employee/1?type=12",
    );
  });
});

describe("redactUrl", () => {
  it("hides credential-looking query parameters", () => {
    expect(redactUrl("https://x/api?apiKey=secret&page=1")).toBe(
      "https://x/api?apiKey=<redacted>&page=1",
    );
  });
});
