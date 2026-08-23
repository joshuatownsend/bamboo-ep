import { BambooApiError, BambooHttp } from "./http.js";
import {
  cleanDate,
  cleanNumber,
  cleanString,
  idToString,
  toArray,
} from "./normalize.js";
import type {
  BambooCollection,
  EmployeeFile,
  EmployeeIdentity,
  WireSelfEmployee,
  WireCertificationRow,
  WireEmployeeFile,
  WireFileCategory,
  WireTrainingRecord,
  WireTrainingType,
} from "./types.js";

/**
 * Thin wrappers over the five BambooHR endpoints this app needs.
 *
 * Each method returns normalised data and translates BambooHR's "absence"
 * signals into empty results rather than exceptions - a 404 on a training
 * record means the employee has no training, not that something broke. Only
 * genuine failures (auth, throttling, malformed responses) throw.
 */
export class BambooClient {
  constructor(private readonly http: BambooHttp) {}

  /**
   * `GET /employees/0` - the id `0` is documented to mean "the authenticated
   * caller". With no `fields` param the response is just `{"id":"123"}`.
   *
   * `0` is only sanctioned on this endpoint, so we resolve the real numeric id
   * once here and use it everywhere else.
   */
  async getSelfEmployeeId(): Promise<string> {
    return (await this.getSelf()).employeeId;
  }

  /**
   * The same self lookup, asking for the caller's name as well as their id.
   *
   * The name is what makes "is this certificate even this person's?" an
   * answerable question - a file named after the right certification can still
   * belong to a colleague, and no amount of filename scoring can tell.
   *
   * The `fields` parameter is dropped and the call repeated bare if it is
   * rejected. This lookup gates every other request in the app, so a tenant
   * that dislikes the parameter must still be able to connect and download;
   * only the person check is lost.
   */
  async getSelf(): Promise<{ employeeId: string; identity: EmployeeIdentity | null }> {
    let res: WireSelfEmployee | null = null;
    let identityAsked = true;
    try {
      res = await this.http.getJson<WireSelfEmployee>("/employees/0", {
        query: { fields: "firstName,lastName,displayName,preferredName" },
      });
    } catch (err) {
      if (!(err instanceof BambooApiError)) throw err;
      identityAsked = false;
      res = await this.http.getJson<WireSelfEmployee>("/employees/0");
    }

    const employeeId = idToString(res?.id);
    if (!employeeId) {
      throw new Error(
        "BambooHR did not return an employee id for the authenticated user. " +
          "The API key may not be linked to an employee record.",
      );
    }

    const identity: EmployeeIdentity = {
      firstName: cleanString(res?.firstName),
      lastName: cleanString(res?.lastName),
      displayName: cleanString(res?.displayName),
      preferredName: cleanString(res?.preferredName),
    };
    const hasAnyName = Object.values(identity).some((v) => v != null);
    return {
      employeeId,
      identity: identityAsked && hasAnyName ? identity : null,
    };
  }

  /** `GET /training/record/employee/{id}`. 404 means "no records". */
  async listTrainingRecords(employeeId: string): Promise<WireTrainingRecord[]> {
    try {
      const res = await this.http.getJson<BambooCollection<WireTrainingRecord>>(
        `/training/record/employee/${encodeURIComponent(employeeId)}`,
      );
      return toArray(res);
    } catch (err) {
      if (err instanceof BambooApiError && err.status === 404) return [];
      throw err;
    }
  }

  /**
   * `GET /training/type` - the ONLY source of human-readable training names.
   * Docs require "access to training settings", so a regular employee's key
   * may get 403 here even though their own records read fine. Callers must
   * handle an empty map by falling back down the naming chain.
   */
  async listTrainingTypes(): Promise<Map<string, WireTrainingType>> {
    const res =
      await this.http.getJson<BambooCollection<WireTrainingType>>("/training/type");
    const map = new Map<string, WireTrainingType>();
    for (const type of toArray(res)) {
      const id = idToString(type?.id);
      if (id) map.set(id, type);
    }
    return map;
  }

  /**
   * `GET /employees/{id}/tables/employeeCertifications` - often a better
   * source than Training, because it carries a real title AND a real
   * expiration date with no type-id join.
   */
  async listCertifications(employeeId: string): Promise<WireCertificationRow[]> {
    try {
      const res = await this.http.getJson<BambooCollection<WireCertificationRow>>(
        `/employees/${encodeURIComponent(employeeId)}/tables/employeeCertifications`,
      );
      return toArray(res);
    } catch (err) {
      if (err instanceof BambooApiError && err.status === 404) return [];
      throw err;
    }
  }

  /**
   * `GET /employees/{id}/files/view` - flattened from categories into a list.
   * A 404 here means no file categories are visible to this user, which is a
   * normal permission outcome rather than an error.
   */
  async listFiles(employeeId: string): Promise<EmployeeFile[]> {
    let res: unknown;
    try {
      res = await this.http.getJson<unknown>(
        `/employees/${encodeURIComponent(employeeId)}/files/view`,
      );
    } catch (err) {
      if (err instanceof BambooApiError && err.status === 404) return [];
      throw err;
    }
    return flattenFileCategories(res);
  }

  /**
   * `GET /employees/{id}/files/{fileId}` - binary download. The response
   * carries `Content-Disposition` with BambooHR's own filename, which is the
   * most reliable place to read the true file extension from.
   */
  async downloadFile(
    employeeId: string,
    fileId: string,
  ): Promise<{ bytes: Uint8Array; contentType: string | null; filename: string | null }> {
    const { bytes, contentType, disposition } = await this.http.getBinary(
      `/employees/${encodeURIComponent(employeeId)}/files/${encodeURIComponent(fileId)}`,
    );
    return { bytes, contentType, filename: filenameFromDisposition(disposition) };
  }
}

/**
 * The files listing nests files inside categories. Categories with no files
 * appear as bare entries, so `files` is optional throughout.
 */
export function flattenFileCategories(res: unknown): EmployeeFile[] {
  const categories = extractCategories(res);
  const out: EmployeeFile[] = [];

  for (const category of categories) {
    const categoryId = idToString(category?.id) ?? "";
    const categoryName = cleanString(category?.name) ?? "Uncategorised";
    for (const file of toArray<WireEmployeeFile>(category?.files ?? [])) {
      const id = idToString(file?.id);
      if (!id) continue;
      out.push({
        id,
        name: cleanString(file.name) ?? "Untitled",
        originalFileName: cleanString(file.originalFileName),
        categoryId,
        categoryName,
        size: cleanNumber(file.size),
        dateCreated: cleanDate(file.dateCreated),
      });
    }
  }
  return out;
}

/**
 * The listing has been observed in three shapes: a bare array of categories,
 * an object keyed by category id, and an envelope with a `categories` key.
 * Accept all three rather than betting on one.
 */
function extractCategories(res: unknown): WireFileCategory[] {
  if (res == null || typeof res !== "object") return [];
  const envelope = res as { categories?: BambooCollection<WireFileCategory> };
  if (envelope.categories != null) return toArray(envelope.categories);
  return toArray(res as BambooCollection<WireFileCategory>);
}

/** Pull a filename out of a `Content-Disposition` header, if present. */
export function filenameFromDisposition(disposition: string | null): string | null {
  if (!disposition) return null;

  // RFC 5987 form takes precedence: filename*=UTF-8''name%20here.pdf
  const extended = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(disposition);
  if (extended?.[1]) {
    try {
      return decodeURIComponent(extended[1].trim());
    } catch {
      return extended[1].trim();
    }
  }

  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(disposition);
  return plain?.[1] ? plain[1].trim() : null;
}
