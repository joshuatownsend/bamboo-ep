import { describe, expect, it } from "vitest";
import { EpApiError, EpClient, type EpFetch } from "../src/essper-client.js";

function stub(responses: Array<{ status?: number; body: string }>): {
  fetchImpl: EpFetch;
  calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }>;
} {
  const calls: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body: unknown;
  }> = [];
  const queue = [...responses];
  const fetchImpl: EpFetch = async (url, init) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: init?.headers ?? {},
      body: init?.body,
    });
    const next = queue.shift() ?? { status: 500, body: "" };
    const status = next.status ?? 200;
    return { ok: status >= 200 && status < 300, status, text: async () => next.body };
  };
  return { fetchImpl, calls };
}

const BASE = "https://lccfrs.essper.com/api";
const KEY = "app-key";

describe("reading the catalogue", () => {
  it("returns templates and carries the app key", async () => {
    const { fetchImpl, calls } = stub([
      {
        body: JSON.stringify({
          templates: [{ _id: "t1", name: "100 - Metrorail System Basics", abbreviation: "M100" }],
        }),
      },
    ]);
    const templates = await new EpClient(fetchImpl, BASE, KEY).listTemplates();

    expect(templates).toEqual([
      { id: "t1", name: "100 - Metrorail System Basics", abbreviation: "M100" },
    ]);
    expect(calls[0]!.headers["X-ES-KEY"]).toBe(KEY);
  });

  it("drops a template with no id, which could never be submitted", async () => {
    const { fetchImpl } = stub([
      { body: JSON.stringify({ templates: [{ name: "Nameless" }, { _id: "t2", name: "CPR" }] }) },
    ]);
    const templates = await new EpClient(fetchImpl, BASE, KEY).listTemplates();
    expect(templates.map((t) => t.id)).toEqual(["t2"]);
  });
});

describe("reading what EP already holds", () => {
  it("flattens a populated template and normalises the misleading field names", async () => {
    const { fetchImpl } = stub([
      {
        body: JSON.stringify({
          total: 1,
          data: [
            {
              _id: "u1",
              certificationTemplateId: { _id: "t1", name: "100 - Metrorail System Basics" },
              // EP calls the completion date "year", and returns it as a full
              // timestamp here but as YYYY-MM-DD elsewhere.
              year: "2018-04-15T00:00:00.000Z",
              expires: null,
              school: "Washington Metropolitan Area Transit Authority",
              documentUrl: "https://lccfrs.essper.com/file/abc.pdf",
              apiSource: { source: "targetSolutions" },
            },
          ],
        }),
      },
    ]);
    const rows = await new EpClient(fetchImpl, BASE, KEY).listCertifications("me");

    expect(rows[0]).toEqual({
      id: "u1",
      templateId: "t1",
      completed: "2018-04-15",
      expires: null,
      institution: "Washington Metropolitan Area Transit Authority",
      documentUrl: "https://lccfrs.essper.com/file/abc.pdf",
      importedFrom: "targetSolutions",
    });
  });

  it("accepts a bare template id as well as a populated one", async () => {
    const { fetchImpl } = stub([
      { body: JSON.stringify({ total: 1, data: [{ _id: "u1", certificationTemplateId: "t9" }] }) },
    ]);
    const rows = await new EpClient(fetchImpl, BASE, KEY).listCertifications("me");
    expect(rows[0]!.templateId).toBe("t9");
  });

  /**
   * The duplicate check is the only thing standing between a member and a
   * second copy of every certification they already hold. A truncated list
   * makes present records look missing, so a short page is an error rather
   * than something to work with.
   */
  it("refuses a partial list rather than under-reporting duplicates", async () => {
    const { fetchImpl } = stub([
      { body: JSON.stringify({ total: 900, data: [{ _id: "u1", certificationTemplateId: "t1" }] }) },
    ]);
    await expect(new EpClient(fetchImpl, BASE, KEY).listCertifications("me")).rejects.toThrow(
      /upload them twice/i,
    );
  });
});

describe("when the session is not what it seems", () => {
  it("says to sign in again on a 401", async () => {
    const { fetchImpl } = stub([{ status: 401, body: "" }]);
    await expect(new EpClient(fetchImpl, BASE, KEY).listTemplates()).rejects.toThrow(/sign in/i);
  });

  /**
   * The failure that matters most: a signed-out session is served the login
   * page with HTTP 200. Parsing that as data would produce an empty catalogue
   * and an empty list of existing certifications - which reads as "nothing is
   * in EP yet", the most dangerous wrong answer available.
   */
  it("treats an HTML body on a 200 as an expired session, not as empty data", async () => {
    const { fetchImpl } = stub([{ status: 200, body: "<!doctype html><html>Log in</html>" }]);
    await expect(new EpClient(fetchImpl, BASE, KEY).listTemplates()).rejects.toThrow(
      /session has probably expired/i,
    );
  });
});

describe("uploading", () => {
  it("sends the file to /file/new and returns the stored URL", async () => {
    const { fetchImpl, calls } = stub([
      { body: JSON.stringify({ file: "https://lccfrs.essper.com/file/hash.pdf" }) },
    ]);
    const client = new EpClient(fetchImpl, BASE, KEY);
    const url = await client.uploadFile(
      { filename: "cert.pdf", bytes: new Uint8Array([1, 2]), contentType: "application/pdf" },
      (file) => ({ marker: file.filename }),
    );

    expect(url).toBe("https://lccfrs.essper.com/file/hash.pdf");
    expect(calls[0]!.url).toBe(`${BASE}/file/new`);
    // A multipart body sets its own boundary; naming the content type without
    // one produces a request the server cannot parse.
    expect(calls[0]!.headers["Content-Type"]).toBeUndefined();
  });

  it("fails loudly when EP accepts the file but names no URL", async () => {
    const { fetchImpl } = stub([{ body: JSON.stringify({}) }]);
    const client = new EpClient(fetchImpl, BASE, KEY);
    await expect(
      client.uploadFile(
        { filename: "c.pdf", bytes: new Uint8Array(), contentType: "application/pdf" },
        () => ({}),
      ),
    ).rejects.toThrow(EpApiError);
  });
});

describe("creating the record", () => {
  it("posts EP's own field names verbatim", async () => {
    const { fetchImpl, calls } = stub([{ body: JSON.stringify({ data: { _id: "new-id" } }) }]);
    const id = await new EpClient(fetchImpl, BASE, KEY).createCertification({
      userId: "me",
      certificationTemplateId: "t1",
      school: "WMATA",
      year: "2018-04-15",
      expires: null,
      documentUrl: "https://lccfrs.essper.com/file/hash.pdf",
    });

    expect(id).toBe("new-id");
    expect(calls[0]!.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.body))).toEqual({
      userId: "me",
      certificationTemplateId: "t1",
      school: "WMATA",
      year: "2018-04-15",
      expires: null,
      documentUrl: "https://lccfrs.essper.com/file/hash.pdf",
    });
  });
  it("refuses to report success when EP confirms no id", async () => {
    // An empty id would be indistinguishable from success, and the caller
    // would tell the member a certification was uploaded on the strength of a
    // response that never said one was created.
    const { fetchImpl } = stub([{ body: JSON.stringify({ ok: true }) }]);
    await expect(
      new EpClient(fetchImpl, BASE, KEY).createCertification({
        userId: "me",
        certificationTemplateId: "t1",
        year: "2018-04-15",
        expires: null,
      }),
    ).rejects.toThrow(/did not confirm/i);
  });
});

describe("failing closed on an answer we do not recognise", () => {
  /**
   * The list of existing certifications is the only evidence that something is
   * already on the member's profile. An empty or half-read one does not read
   * as "something went wrong" downstream - it reads as "the member holds
   * nothing", and the tool then offers to upload their whole record again.
   */
  it("refuses a certification list that is not a list", async () => {
    const { fetchImpl } = stub([{ body: JSON.stringify({ data: { nope: true }, total: 3 }) }]);
    await expect(new EpClient(fetchImpl, BASE, KEY).listCertifications("me")).rejects.toThrow(
      /unfamiliar answer/i,
    );
  });

  it("refuses a certification row that does not say which certification it is", async () => {
    const { fetchImpl } = stub([
      { body: JSON.stringify({ total: 1, data: [{ _id: "u1", year: "2020-01-01" }] }) },
    ]);
    await expect(new EpClient(fetchImpl, BASE, KEY).listCertifications("me")).rejects.toThrow(
      /does not name which certification/i,
    );
  });

  it("refuses a catalogue that is not a list", async () => {
    // An empty catalogue would send every record to triage saying nothing in
    // EP resembles it - a confident answer to a question never really asked.
    const { fetchImpl } = stub([{ body: JSON.stringify({ templates: null }) }]);
    await expect(new EpClient(fetchImpl, BASE, KEY).listTemplates()).rejects.toThrow(
      /unfamiliar answer/i,
    );
  });
});
