import type { TrainingItem } from "./types.js";

/**
 * The manifest is the contract between Part 1 (this app) and Part 2 (the
 * Essential Personnel uploader).
 *
 * Part 2 must read this file rather than scanning the folder and re-deriving
 * meaning from filenames. Filenames are for humans and are user-configurable;
 * the manifest is the machine-readable truth about what each file is, which
 * record it came from, and whether a record exists with no file at all.
 */

export const MANIFEST_VERSION = 1;
export const MANIFEST_FILENAME = "manifest.json";

export interface Manifest {
  manifestVersion: number;
  generatedAt: string;
  app: { name: string; version: string };
  source: {
    provider: "bamboohr";
    subdomain: string;
    employeeId: string;
    /** Which base-URL form answered, recorded for support diagnostics. */
    endpointStyle: string;
  };
  /** The filename template in force when this folder was produced. */
  filenameTemplate: string;
  entries: ManifestEntry[];
  /**
   * Files saved from the profile that no record claimed. Recorded so the
   * folder stays self-describing: Part 2 must never have to infer that a file
   * on disk exists by scanning the directory.
   */
  orphanFiles: OrphanFile[];
  summary: {
    totalRecords: number;
    withFile: number;
    withoutFile: number;
    filesWithoutRecord: number;
  };
  /** Non-fatal problems worth showing before an upload is attempted. */
  warnings: string[];
}

export interface ManifestEntry {
  /** Stable key of the training item: `${source}:${id}`. */
  key: string;
  recordId: string;
  source: "training" | "certifications";
  name: string;
  /** How the name was resolved, so Part 2 can flag low-quality names. */
  nameSource: TrainingItem["nameSource"];
  category: string | null;
  completed: string | null;
  expires: string | null;
  /** True when `expires` was computed rather than read from BambooHR. */
  expiresDerived: boolean;
  instructor: string | null;
  certificationNumber: string | null;
  notes: string | null;
  file: ManifestFile | null;
}

export interface ManifestFile {
  /** BambooHR's own file id, for re-fetching without re-matching. */
  bambooFileId: string;
  /** Filename as written into this folder. Relative to the manifest. */
  savedAs: string;
  originalFileName: string | null;
  categoryName: string;
  bytes: number;
  sha256: string;
  contentType: string | null;
  /** How the file was paired to the record. */
  matchedBy: "user" | "heuristic";
  matchScore: number;
}

/** Files present on the profile that no record claimed. */
export interface OrphanFile {
  bambooFileId: string;
  /** Filename as written into this folder, or null if it was not saved. */
  savedAs: string | null;
  originalFileName: string | null;
  categoryName: string;
  bytes: number | null;
  sha256: string | null;
}

export function buildManifest(args: {
  appVersion: string;
  generatedAt: string;
  subdomain: string;
  employeeId: string;
  endpointStyle: string;
  filenameTemplate: string;
  entries: ManifestEntry[];
  orphanFiles: OrphanFile[];
  orphanFileCount: number;
  warnings?: string[];
}): Manifest {
  const withFile = args.entries.filter((e) => e.file != null).length;
  return {
    manifestVersion: MANIFEST_VERSION,
    generatedAt: args.generatedAt,
    app: { name: "bamboo-ep", version: args.appVersion },
    source: {
      provider: "bamboohr",
      subdomain: args.subdomain,
      employeeId: args.employeeId,
      endpointStyle: args.endpointStyle,
    },
    filenameTemplate: args.filenameTemplate,
    entries: args.entries,
    orphanFiles: args.orphanFiles,
    summary: {
      totalRecords: args.entries.length,
      withFile,
      withoutFile: args.entries.length - withFile,
      filesWithoutRecord: args.orphanFileCount,
    },
    warnings: args.warnings ?? [],
  };
}

export function serializeManifest(manifest: Manifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * Validate a manifest read back from disk. Part 2 should call this before
 * trusting a folder, since the user may have edited or partially copied it.
 */
export function parseManifest(text: string): { manifest: Manifest } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { error: `Not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (parsed == null || typeof parsed !== "object") {
    return { error: "Manifest is not an object." };
  }
  const candidate = parsed as Partial<Manifest>;
  if (typeof candidate.manifestVersion !== "number") {
    return { error: "Manifest is missing manifestVersion." };
  }
  if (candidate.manifestVersion > MANIFEST_VERSION) {
    return {
      error:
        `Manifest version ${candidate.manifestVersion} is newer than this app ` +
        `understands (${MANIFEST_VERSION}). Update the app.`,
    };
  }
  if (!Array.isArray(candidate.entries)) {
    return { error: "Manifest is missing an entries array." };
  }
  return { manifest: candidate as Manifest };
}

/**
 * SHA-256 via Web Crypto, which is present in Node 18+ and in the Tauri
 * webview - so `core` needs no Node-only crypto import and stays portable.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const view = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", view);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
