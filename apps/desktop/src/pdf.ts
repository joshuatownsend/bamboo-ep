import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import type { Manifest } from "@bamboo-ep/core";

/**
 * The printable training summary.
 *
 * Records with no certificate file still have to reach Essential Personnel -
 * a BambooHR training record is evidence in its own right. This sheet lists
 * every record, marks which ones have a file in the folder, and flags derived
 * expiry dates so a reviewer never mistakes a computed date for a recorded one.
 */

export const SUMMARY_PDF_FILENAME = "Training Summary.pdf";

export function buildSummaryPdf(manifest: Manifest): Uint8Array {
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });

  doc.setFontSize(16);
  doc.text("Training and Certification Summary", 40, 44);

  doc.setFontSize(10);
  doc.setTextColor(90);
  const generated = formatDateTime(manifest.generatedAt);
  doc.text(
    `BambooHR company "${manifest.source.subdomain}" · employee ${manifest.source.employeeId} · generated ${generated}`,
    40,
    62,
  );
  doc.text(
    `${manifest.summary.totalRecords} records · ${manifest.summary.withFile} with a certificate file · ` +
      `${manifest.summary.withoutFile} without`,
    40,
    76,
  );
  doc.setTextColor(0);

  autoTable(doc, {
    startY: 96,
    head: [["Certification", "Completed", "Expires", "Instructor", "Cert. No.", "Certificate file"]],
    body: manifest.entries.map((entry) => [
      entry.name,
      entry.completed ?? "—",
      formatExpiry(entry.expires, entry.expiresDerived),
      entry.instructor ?? "—",
      entry.certificationNumber ?? "—",
      entry.file?.savedAs ?? "No file on record",
    ]),
    styles: { fontSize: 9, cellPadding: 5, overflow: "linebreak" },
    headStyles: { fillColor: [45, 55, 72], textColor: 255 },
    // Grey out the rows a reviewer will need to follow up on.
    didParseCell: (data) => {
      if (data.section !== "body") return;
      const entry = manifest.entries[data.row.index];
      if (entry && !entry.file) data.cell.styles.textColor = [120, 120, 120];
    },
    columnStyles: { 0: { cellWidth: 200 }, 5: { cellWidth: 190 } },
  });

  if (manifest.warnings.length > 0) {
    const y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 24;
    doc.setFontSize(11);
    doc.text("Notes", 40, y);
    doc.setFontSize(9);
    doc.setTextColor(110);
    manifest.warnings.slice(0, 8).forEach((warning, i) => {
      doc.text(`• ${warning}`, 40, y + 16 + i * 13, { maxWidth: 740 });
    });
  }

  return new Uint8Array(doc.output("arraybuffer"));
}

function formatExpiry(expires: string | null, derived: boolean): string {
  if (!expires) return "—";
  // A derived date is a calculation, not something BambooHR recorded.
  return derived ? `${expires} (estimated)` : expires;
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}
