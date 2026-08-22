/**
 * Types modelled on what the BambooHR API actually returns.
 *
 * Two recurring quirks are encoded here deliberately:
 *  - Collection endpoints return an object keyed by record id, but an empty
 *    ARRAY when there is nothing to return. See `BambooCollection`.
 *  - Numeric ids come back as strings on read and numbers on write, so every
 *    id is typed as `string | number` at the wire boundary and normalised on
 *    the way in.
 */

/** Wire shape of any BambooHR "list" endpoint: keyed object, or `[]` when empty. */
export type BambooCollection<T> = Record<string, T> | T[];

export type WireId = string | number;

// --- Credentials & connection -------------------------------------------------

export interface Credentials {
  /** The text before `.bamboohr.com`, e.g. "avfrd". */
  subdomain: string;
  /** Personal API key. Basic auth username; password is the literal "x". */
  apiKey: string;
}

/**
 * Which base-URL form this company's account answers on. Current docs describe
 * `modern`; the legacy gateway form is what older integrations use in
 * production, so we detect rather than assume.
 */
export type BaseUrlStyle = "modern" | "legacy";

export interface Connection {
  credentials: Credentials;
  baseUrl: string;
  style: BaseUrlStyle;
  /** Real numeric employee id, resolved from `GET /employees/0`. */
  employeeId: string;
}

// --- Training ------------------------------------------------------------------

/** `GET /training/record/employee/{id}` — note: no name, no expiration, no file. */
export interface WireTrainingRecord {
  id: WireId;
  employeeId?: WireId;
  /** Training TYPE id. The human-readable name lives on /training/type. */
  type: WireId;
  completed: string | null;
  notes?: string | null;
  instructor?: string | null;
  credits?: string | null;
  hours?: string | null;
  cost?: string | null;
}

/** `GET /training/type` — requires access to training settings; may 403. */
export interface WireTrainingType {
  id: WireId;
  name: string;
  renewable?: boolean;
  /** Renewal interval in MONTHS; combine with `completed` to derive expiry. */
  frequency?: number | null;
  required?: boolean;
  description?: string | null;
  linkUrl?: string | null;
  /** Object when set, `[]` when unset. */
  category?: { id: WireId; name: string } | [] | null;
}

/** `GET /employees/{id}/tables/employeeCertifications` — has a real name AND expiry. */
export interface WireCertificationRow {
  id?: WireId;
  title?: string | null;
  completionDate?: string | null;
  expirationDate?: string | null;
  certificationNumber?: string | null;
  notes?: string | null;
}

// --- Files ---------------------------------------------------------------------

/** `GET /employees/{id}/files/view` with `Accept: application/json`. */
export interface WireFileCategory {
  id: WireId;
  name: string;
  files?: WireEmployeeFile[];
}

export interface WireEmployeeFile {
  id: WireId;
  name: string;
  originalFileName?: string | null;
  size?: number | string | null;
  dateCreated?: string | null;
  createdBy?: string | null;
  shareWithEmployee?: string | boolean | null;
}

// --- Normalised domain model ---------------------------------------------------

export type RecordSource = "training" | "certifications";

/** A training/certification the employee holds, after name resolution. */
export interface TrainingItem {
  /** Stable key: `${source}:${id}`. */
  key: string;
  id: string;
  source: RecordSource;
  /** Best available human-readable name. Never empty. */
  name: string;
  /** How `name` was obtained — surfaced in the UI so users can spot fallbacks. */
  nameSource: "certification-title" | "training-type" | "file-name" | "placeholder";
  category: string | null;
  completed: string | null;
  /** From the certifications table, or derived from type.frequency. */
  expires: string | null;
  expiresDerived: boolean;
  instructor: string | null;
  certificationNumber: string | null;
  notes: string | null;
}

/** An employee file, flattened out of its category. */
export interface EmployeeFile {
  id: string;
  name: string;
  originalFileName: string | null;
  categoryId: string;
  categoryName: string;
  size: number | null;
  dateCreated: string | null;
}
