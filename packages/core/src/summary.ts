import type { Manifest, ManifestEntry } from "./manifest.js";

/**
 * The summary export.
 *
 * Records with no certificate file still have to reach Essential Personnel -
 * a BambooHR training record is itself evidence, even without a scan attached.
 * The CSV covers every record, marking clearly which ones have a file in the
 * folder and which are record-only.
 */

export const SUMMARY_CSV_FILENAME = "Training Summary.csv";

const COLUMNS = [
  "Certification",
  "Source",
  "Completed",
  "Expires",
  "Expiry Derived",
  "Category",
  "Instructor",
  "Certification Number",
  "Certificate File",
  "Notes",
] as const;

export function buildSummaryCsv(manifest: Manifest): string {
  const rows = manifest.entries.map(toRow);
  return [COLUMNS, ...rows].map(toCsvLine).join("\r\n") + "\r\n";
}

function toRow(entry: ManifestEntry): string[] {
  return [
    entry.name,
    entry.source === "certifications" ? "Certifications table" : "Training record",
    entry.completed ?? "",
    entry.expires ?? "",
    entry.expiresDerived ? "yes" : "",
    entry.category ?? "",
    entry.instructor ?? "",
    entry.certificationNumber ?? "",
    entry.file?.savedAs ?? "No file on record",
    entry.notes ?? "",
  ];
}

function toCsvLine(values: readonly string[]): string {
  return values.map(escapeCsv).join(",");
}

/**
 * RFC 4180 quoting. The leading-character guard is a spreadsheet-injection
 * defence: a cell starting with =, +, - or @ is executed as a formula when the
 * file is opened in Excel, and these values come from a remote system.
 */
function escapeCsv(value: string): string {
  const normalized = value.replace(/\r\n|\r|\n/g, " ").trim();
  const guarded = /^[=+\-@\t]/.test(normalized) ? `'${normalized}` : normalized;
  return /[",]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}
