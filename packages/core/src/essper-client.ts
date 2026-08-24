/**
 * Talking to Essential Personnel's own application API.
 *
 * This is EP's internal API - the one their web app calls - not the external
 * `/external/api/v0`, which exists but has no scope for certifications and
 * issues organization-wide administrator credentials this tool must never
 * hold. See `docs/part-2-plan.md`.
 *
 * Consequences of that choice, which the design has to respect:
 *
 * - **Authentication is the member's own browser session.** LC-CFRS mandates
 *   Active Directory SSO as the only authorized login, so there is no
 *   credential to store and none is stored. Requests must be issued from a
 *   context that already carries the session, which is why `fetch` is injected
 *   rather than imported.
 * - **It is undocumented and can change.** Every response is read defensively
 *   and every field this app depends on is named in one place - here - so a
 *   change breaks loudly in one file rather than quietly in ten.
 */

import type { EpTemplate, EpUserCertification } from "./essper.js";

/** The response shape needed from an injected `fetch`. */
export interface EpFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type EpFetch = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    /** A string body for JSON, or a multipart body the caller has assembled. */
    body?: unknown;
  },
) => Promise<EpFetchResponse>;

export class EpApiError extends Error {
  readonly status: number;
  readonly path: string;

  constructor(args: { status: number; path: string; message: string }) {
    super(args.message);
    this.name = "EpApiError";
    this.status = args.status;
    this.path = args.path;
  }
}

/** A file to attach, already read from disk. */
export interface EpUpload {
  filename: string;
  bytes: Uint8Array;
  contentType: string;
}

/**
 * The body EP's create endpoint accepts, transcribed from the validation
 * schema in its own application bundle rather than guessed.
 *
 * The field names do not describe their contents and are left exactly as EP
 * spells them, because renaming them here would put a translation layer
 * between this app and the only documentation that exists - EP's own code.
 */
export interface EpCreateBody {
  userId: string;
  certificationTemplateId: string;
  /** The form labels this "Institution Name". */
  school?: string;
  /** A full completion DATE, despite the name. */
  year: string;
  /** `YYYY-MM-DD`, or null for "never expires". */
  expires: string | null;
  /** The URL returned by `uploadFile`, not the file itself. */
  documentUrl?: string;
}

export class EpClient {
  /**
   * @param baseUrl e.g. `https://lccfrs.essper.com/api`
   * @param appKey  the tenant's public `X-ES-KEY`, served openly in
   *                `/config.js`. It identifies the application, and is not a
   *                secret and not a substitute for the session.
   */
  constructor(
    private readonly fetchImpl: EpFetch,
    private readonly baseUrl: string,
    private readonly appKey: string,
  ) {}

  /** EP's certification catalogue: the fixed vocabulary a record must match. */
  async listTemplates(): Promise<EpTemplate[]> {
    const body = await this.getJson<{ templates?: unknown }>("/template/certification/all");
    if (!Array.isArray(body.templates)) {
      // An empty catalogue would send every record to triage with "nothing in
      // EP resembles this", which is a confident answer to a question that was
      // never actually asked.
      throw new EpApiError({
        status: 200,
        path: "/template/certification/all",
        message:
          "Essential Personnel returned an unfamiliar answer when asked for its list of " +
          "certifications.",
      });
    }
    if (body.templates.length === 0) {
      // Structurally valid and still wrong. LC-CFRS's catalogue holds hundreds
      // of entries, so an empty one means a permission or API change rather
      // than an organisation that tracks no certifications - and it would send
      // every record to triage reporting that nothing in EP resembles it.
      throw new EpApiError({
        status: 200,
        path: "/template/certification/all",
        message:
          "Essential Personnel returned no certifications at all. Refusing to continue, " +
          "because every record would be reported as having no match.",
      });
    }
    const rows = body.templates;
    return rows.map((row) => {
      const record = asRecord(row);
      const id = stringOf(record?.["_id"]);
      const name = stringOf(record?.["name"]);
      if (!id || !name) {
        // Dropping the row was the earlier behaviour, and it hid the case that
        // matters: if a schema change affects every row, the catalogue comes
        // back empty and every record is told that nothing in Essential
        // Personnel resembles it - a confident answer, produced by having
        // nothing to compare against.
        throw new EpApiError({
          status: 200,
          path: "/template/certification/all",
          message:
            "Essential Personnel's list of certifications contains an entry this app " +
            "cannot read. Refusing to continue, because matching against an incomplete " +
            "list would report certifications as missing when they are not.",
        });
      }
      return { id, name, abbreviation: stringOf(record?.["abbreviation"]) };
    });
  }

  /**
   * What EP already holds for this member.
   *
   * `limit` is deliberately generous and the total is checked: silently
   * reading the first page would make the duplicate check under-report, and
   * an under-reported duplicate becomes a second copy of a credential.
   */
  async listCertifications(userId: string): Promise<EpUserCertification[]> {
    const path =
      `/user-certifications?userId=${encodeURIComponent(userId)}` +
      `&skip=0&limit=500&archived=false`;
    const body = await this.getJson<{ data?: unknown; total?: unknown }>(path);

    // Every failure below is treated as an error rather than as an empty list,
    // and the reason is the same in each case: this list is the ONLY evidence
    // that a certification is already on the member's profile. An empty or
    // half-read list does not read as "something went wrong" downstream - it
    // reads as "the member holds nothing", and the tool then offers to upload
    // their entire record a second time. Against an undocumented API expected
    // to change, that has to fail closed.
    if (!Array.isArray(body.data)) {
      throw new EpApiError({
        status: 200,
        path,
        message:
          "Essential Personnel returned an unfamiliar answer when asked which " +
          "certifications you already have. Refusing to continue, because carrying on " +
          "would offer to upload records you already hold.",
      });
    }
    const rows = body.data;

    // Falling back to `rows.length` manufactures the very number being
    // checked: a member with more certifications than one page holds would
    // have their first page declared complete, and everything beyond it
    // offered for upload again. Without a stated total there is nothing to
    // verify against, which is a reason to stop rather than to assume.
    if (typeof body.total !== "number" || !Number.isFinite(body.total)) {
      throw new EpApiError({
        status: 200,
        path,
        message:
          "Essential Personnel did not say how many certifications you have, so there " +
          "is no way to tell whether this list is complete. Refusing to continue, " +
          "because an incomplete list would offer to upload records you already hold.",
      });
    }
    const total = body.total;
    if (rows.length < total) {
      throw new EpApiError({
        status: 200,
        path,
        message:
          `Essential Personnel reports ${total} certifications but returned ${rows.length}. ` +
          "Refusing to continue, because a partial list would make records already " +
          "on your profile look missing and upload them twice.",
      });
    }

    return rows.map((row) => {
      const certification = toCertification(asRecord(row) ?? {});
      if (!certification.id) {
        throw new EpApiError({
          status: 200,
          path,
          message:
            "One of the certifications on your Essential Personnel profile has no " +
            "identifier. Refusing to continue, because it could not be pointed at if " +
            "anything needed checking.",
        });
      }
      if (!certification.templateId) {
        throw new EpApiError({
          status: 200,
          path,
          message:
            "One of the certifications on your Essential Personnel profile does not name " +
            "which certification it is. Refusing to continue, because it cannot be " +
            "compared against your records and might be uploaded again.",
        });
      }
      return certification;
    });
  }

  /**
   * Store a file and return the URL that identifies it.
   *
   * EP takes the certificate in a separate request from the record that cites
   * it - `documentUrl` on the create call is a string, not a file. That split
   * is worth knowing about: a successful upload followed by a failed create
   * leaves a stored file no record points at.
   */
  async uploadFile(file: EpUpload, buildBody: (file: EpUpload) => unknown): Promise<string> {
    const res = await this.fetchImpl(`${this.baseUrl}/file/new`, {
      method: "POST",
      // No Content-Type: a multipart body must set its own boundary, and
      // naming the type here without one produces a request the server cannot
      // parse.
      headers: { "X-ES-KEY": this.appKey },
      body: buildBody(file),
    });
    const body = await readJson<{ file?: unknown }>(res, "/file/new");
    const url = stringOf(body.file);
    if (!url) {
      throw new EpApiError({
        status: res.status,
        path: "/file/new",
        message: "Essential Personnel accepted the file but returned no URL for it.",
      });
    }
    return url;
  }

  /** Create the certification record. Live immediately - there is no approval step. */
  async createCertification(body: EpCreateBody): Promise<string> {
    const res = await this.fetchImpl(`${this.baseUrl}/user-certifications`, {
      method: "POST",
      headers: { "X-ES-KEY": this.appKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const created = await readJson<{ _id?: unknown; data?: unknown }>(
      res,
      "/user-certifications",
    );
    const record = asRecord(created["data"]) ?? created;
    const id = stringOf(record["_id"]);
    if (!id) {
      // An empty string here would be indistinguishable from success, and the
      // caller would go on to report a certification as uploaded on the
      // strength of a response that never confirmed one was created.
      throw new EpApiError({
        status: res.status,
        path: "/user-certifications",
        message:
          "Essential Personnel accepted the certification but did not confirm it was " +
          "created. Check your profile before submitting it again.",
      });
    }
    return id;
  }

  private async getJson<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: { "X-ES-KEY": this.appKey },
    });
    return readJson<T>(res, path);
  }
}

async function readJson<T>(res: EpFetchResponse, path: string): Promise<T> {
  const raw = await res.text().catch(() => "");
  if (!res.ok) {
    throw new EpApiError({
      status: res.status,
      path,
      message:
        res.status === 401 || res.status === 403
          ? "Essential Personnel did not accept the session. Sign in again in the Essential Personnel window."
          : `Essential Personnel refused the request (${res.status}). ${firstLine(raw)}`.trim(),
    });
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    // An HTML body on a 200 is how a signed-out session presents itself: the
    // login page, served with every appearance of success.
    throw new EpApiError({
      status: res.status,
      path,
      message:
        "Essential Personnel returned something that is not data. The session has " +
        "probably expired - sign in again in the Essential Personnel window.",
    });
  }
}

function firstLine(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

function toCertification(row: Record<string, unknown>): EpUserCertification {
  // `certificationTemplateId` arrives either as a bare id or as the whole
  // populated template, depending on the endpoint. Both mean the same thing.
  const template = asRecord(row["certificationTemplateId"]);
  const templateId = template ? stringOf(template["_id"]) : stringOf(row["certificationTemplateId"]);
  const source = asRecord(row["apiSource"]);

  return {
    id: stringOf(row["_id"]) ?? "",
    templateId: templateId ?? "",
    completed: isoDate(row["year"]),
    expires: isoDate(row["expires"]),
    institution: stringOf(row["school"]),
    documentUrl: stringOf(row["documentUrl"]),
    importedFrom: source ? stringOf(source["source"]) : null,
  };
}

/**
 * EP returns dates as full ISO timestamps in some places and `YYYY-MM-DD` in
 * others. Everything downstream compares dates as plain days, so both are
 * reduced to that rather than left for each caller to handle differently.
 */
function isoDate(value: unknown): string | null {
  const text = stringOf(value);
  if (!text) return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(text);
  return match ? match[1]! : null;
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
