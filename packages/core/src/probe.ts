import { BambooClient } from "./bamboo.js";
import { BambooApiError, BambooHttp, buildBaseUrl } from "./http.js";
import type { FetchLike } from "./http.js";
import type { BaseUrlStyle, Connection, Credentials } from "./types.js";

/**
 * The capability probe.
 *
 * Three things about a given BambooHR account cannot be known from the
 * documentation, only by asking:
 *
 *   1. Whether this company answers on the modern host or the legacy gateway.
 *   2. Whether a regular employee's key may read /training/type, which is the
 *      only source of human-readable training names.
 *   3. Which of Training records, the certifications table, and Employee Files
 *      this particular company actually populates.
 *
 * Rather than assume, the app runs this on first connect and degrades based on
 * the result. Every failure is captured and explained rather than thrown, so
 * the UI can render a full matrix in one pass instead of stopping at the first
 * red row.
 */

export type ProbeStatus = "ok" | "empty" | "forbidden" | "unavailable" | "error";

export interface ProbeResult {
  id: ProbeId;
  label: string;
  status: ProbeStatus;
  /** Plain-language line rendered directly in the UI. */
  detail: string;
  /** Item count, where the probe returned a collection. */
  count?: number;
  httpStatus?: number;
}

export type ProbeId =
  | "connection"
  | "self"
  | "trainingRecords"
  | "trainingTypes"
  | "certifications"
  | "files";

export interface ProbeReport {
  connection: Connection | null;
  results: ProbeResult[];
  /** True when enough works to produce a useful download. */
  usable: boolean;
  /** Ordered, human-readable next steps when something is degraded. */
  advice: string[];
}

const STYLES: BaseUrlStyle[] = ["modern", "legacy"];

export async function runProbe(
  fetchImpl: FetchLike,
  credentials: Credentials,
): Promise<ProbeReport> {
  const results: ProbeResult[] = [];

  const connect = await resolveConnection(fetchImpl, credentials);
  results.push(connect.result);

  if (!connect.connection) {
    return { connection: null, results, usable: false, advice: connectionAdvice(connect.result) };
  }

  const { connection } = connect;
  const client = new BambooClient(
    new BambooHttp(fetchImpl, connection.baseUrl, credentials),
  );

  results.push({
    id: "self",
    label: "Your employee record",
    status: "ok",
    detail: `Resolved your BambooHR employee id (${connection.employeeId}).`,
  });

  const [records, types, certifications, files] = await Promise.all([
    probe("trainingRecords", "Training records", () =>
      client.listTrainingRecords(connection.employeeId),
    ),
    probe("trainingTypes", "Training names", async () => {
      const map = await client.listTrainingTypes();
      return [...map.values()];
    }),
    probe("certifications", "Certifications table", () =>
      client.listCertifications(connection.employeeId),
    ),
    probe("files", "Certificate files", () => client.listFiles(connection.employeeId)),
  ]);

  results.push(records, types, certifications, files);

  // Usable means: at least one source of records, and something to download or
  // report. Files alone are still usable - they can be saved under their own
  // names even with no matching record.
  const hasRecords = records.status === "ok" || certifications.status === "ok";
  const usable = hasRecords || files.status === "ok";

  return {
    connection,
    results,
    usable,
    advice: buildAdvice({ records, types, certifications, files, usable }),
  };
}

/**
 * Try the modern host first, then the legacy gateway. Current docs describe
 * only the modern form, but production integrations still use the gateway, so
 * neither can be assumed.
 */
async function resolveConnection(
  fetchImpl: FetchLike,
  credentials: Credentials,
): Promise<{ connection: Connection | null; result: ProbeResult }> {
  let lastError: unknown;

  for (const style of STYLES) {
    const baseUrl = buildBaseUrl(credentials.subdomain, style);
    try {
      const client = new BambooClient(new BambooHttp(fetchImpl, baseUrl, credentials));
      const employeeId = await client.getSelfEmployeeId();
      return {
        connection: { credentials, baseUrl, style, employeeId },
        result: {
          id: "connection",
          label: "Connection",
          status: "ok",
          detail: `Connected to ${baseUrl} (${style} endpoint).`,
        },
      };
    } catch (err) {
      lastError = err;
      // An auth failure is conclusive: the host answered and rejected the key,
      // so trying the other host form would only repeat the rejection.
      if (err instanceof BambooApiError && err.isAuth) break;
    }
  }

  return { connection: null, result: connectionFailure(lastError) };
}

function connectionFailure(err: unknown): ProbeResult {
  if (err instanceof BambooApiError) {
    const detail =
      err.status === 401
        ? "BambooHR rejected the API key. Check that it was copied in full."
        : err.status === 403
          ? "BambooHR accepted the request but refused access. API access may be " +
            "switched off for your account, or the key may have been disabled by " +
            "repeated failed attempts."
          : `BambooHR returned ${err.status}.`;
    return {
      id: "connection",
      label: "Connection",
      status: err.isAuth ? "forbidden" : "error",
      detail: err.bambooMessage ? `${detail} (${err.bambooMessage})` : detail,
      httpStatus: err.status,
    };
  }
  return {
    id: "connection",
    label: "Connection",
    status: "error",
    detail:
      "Could not reach BambooHR. Check the company subdomain and your network " +
      `connection. (${err instanceof Error ? err.message : String(err)})`,
  };
}

/** Run one probe, converting every outcome into a status rather than throwing. */
async function probe<T>(
  id: ProbeId,
  label: string,
  run: () => Promise<T[]>,
): Promise<ProbeResult> {
  try {
    const items = await run();
    return items.length > 0
      ? { id, label, status: "ok", detail: `Found ${items.length}.`, count: items.length }
      : {
          id,
          label,
          status: "empty",
          detail: "Reachable, but nothing is recorded here.",
          count: 0,
        };
  } catch (err) {
    if (err instanceof BambooApiError) {
      return {
        id,
        label,
        status: err.isAuth ? "forbidden" : "unavailable",
        detail: err.isAuth
          ? "Your BambooHR account does not have permission to read this."
          : `BambooHR returned ${err.status}.` +
            (err.bambooMessage ? ` (${err.bambooMessage})` : ""),
        httpStatus: err.status,
      };
    }
    return {
      id,
      label,
      status: "error",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function connectionAdvice(result: ProbeResult): string[] {
  if (result.status === "forbidden") {
    return [
      "Generate a fresh API key: log in to BambooHR, click your name in the " +
        "lower-left corner, then choose \"API Keys\".",
      "If \"API Keys\" does not appear in that menu, your account is not " +
        "permitted to create one - ask your BambooHR administrator to enable " +
        "API access for you.",
    ];
  }
  return [
    "Check the company subdomain. It is the part of your BambooHR web address " +
      "before \".bamboohr.com\".",
  ];
}

function buildAdvice(args: {
  records: ProbeResult;
  types: ProbeResult;
  certifications: ProbeResult;
  files: ProbeResult;
  usable: boolean;
}): string[] {
  const advice: string[] = [];

  if (args.types.status === "forbidden") {
    advice.push(
      "Your key cannot read the training catalogue, so training records have no " +
        "names attached. Certificate names will be taken from the certifications " +
        "table or from the original file names instead. Ask a BambooHR " +
        "administrator for access to training settings to improve this.",
    );
  }

  if (args.files.status === "forbidden" || args.files.status === "unavailable") {
    advice.push(
      "No document categories are visible to you, so there are no certificate " +
        "files to download. Records will still be exported to the summary. " +
        "Documents must be shared with the employee in BambooHR to be readable.",
    );
  } else if (args.files.status === "empty") {
    advice.push("No files are stored on your BambooHR profile yet.");
  }

  if (args.records.status !== "ok" && args.certifications.status === "ok") {
    advice.push("Using the certifications table as the source of your records.");
  }

  if (!args.usable) {
    advice.push(
      "Nothing could be read from this account. Confirm with your BambooHR " +
        "administrator that your key has permission to view your own profile.",
    );
  }

  return advice;
}
