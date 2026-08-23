import { describe, expect, it } from "vitest";
import { BambooClient } from "../src/bamboo.js";
import { BambooHttp } from "../src/http.js";
import type { FetchLike, FetchLikeResponse } from "../src/http.js";

const credentials = { subdomain: "acme", apiKey: "key-123" };

function json(status: number, body: unknown): FetchLikeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

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

function clientFor(fetchImpl: FetchLike): BambooClient {
  return new BambooClient(
    new BambooHttp(fetchImpl, "https://acme.bamboohr.com/api/v1", credentials),
  );
}

describe("getSelf", () => {
  it("asks for the caller's name alongside their id, in one request", async () => {
    const fetchImpl = stubFetch([
      json(200, {
        id: "116",
        firstName: "Joshua",
        lastName: "Townsend",
        displayName: "Joshua Townsend",
      }),
    ]);

    const result = await clientFor(fetchImpl).getSelf();

    expect(result.employeeId).toBe("116");
    expect(result.identity?.displayName).toBe("Joshua Townsend");
    expect(fetchImpl.calls).toHaveLength(1);
    expect(fetchImpl.calls[0]).toContain("fields=");
  });

  // This lookup gates every other request in the app. Losing the person check
  // is survivable; failing to connect at all is not.
  it("still connects when the tenant rejects the fields parameter", async () => {
    const fetchImpl = stubFetch([json(400, { error: "bad fields" }), json(200, { id: "116" })]);

    const result = await clientFor(fetchImpl).getSelf();

    expect(result.employeeId).toBe("116");
    expect(result.identity).toBeNull();
    expect(fetchImpl.calls).toHaveLength(2);
  });

  it("reports no identity rather than a hollow one when no name comes back", async () => {
    const result = await clientFor(stubFetch([json(200, { id: "116" })])).getSelf();
    expect(result.identity).toBeNull();
  });

  it("fails loudly when there is no employee id, since nothing else can work", async () => {
    await expect(clientFor(stubFetch([json(200, {})])).getSelf()).rejects.toThrow(
      /did not return an employee id/,
    );
  });
});
