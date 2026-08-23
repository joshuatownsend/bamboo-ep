import { describe, expect, it, vi } from "vitest";
import { executePull, gatherWorkspace, runPool } from "../src/pull.js";
import type { Workspace } from "../src/pull.js";
import { buildMatchPlan } from "../src/matching.js";
import { MANIFEST_FILENAME, parseManifest } from "../src/manifest.js";
import { SUMMARY_CSV_FILENAME } from "../src/summary.js";
import type { BambooClient } from "../src/bamboo.js";
import type { Connection, EmployeeFile, TrainingItem } from "../src/types.js";

const connection: Connection = {
  credentials: { subdomain: "acme", apiKey: "k" },
  baseUrl: "https://acme.bamboohr.com/api/v1",
  style: "modern",
  employeeId: "123",
  employee: {
    firstName: "Joshua",
    lastName: "Townsend",
    displayName: "Joshua Townsend",
    preferredName: null,
  },
};

function item(partial: Partial<TrainingItem> & { key: string; name: string }): TrainingItem {
  return {
    id: partial.key.split(":")[1] ?? partial.key,
    source: "training",
    nameSource: "training-type",
    category: null,
    completed: null,
    expires: null,
    expiresDerived: false,
    instructor: null,
    certificationNumber: null,
    notes: null,
    ...partial,
  };
}

function file(partial: Partial<EmployeeFile> & { id: string; name: string }): EmployeeFile {
  return {
    originalFileName: `${partial.name}.pdf`,
    categoryId: "1",
    categoryName: "Training Docs",
    size: null,
    dateCreated: null,
    ...partial,
  };
}

/** In-memory filesystem so the pull can be asserted without touching disk. */
function memoryFs() {
  const written = new Map<string, Uint8Array>();
  return {
    written,
    writeFile: async (name: string, bytes: Uint8Array) => {
      written.set(name, bytes);
    },
  };
}

/** Stub client returning fixed bytes, optionally failing for specific ids. */
function stubClient(options: { failIds?: string[] } = {}): BambooClient {
  return {
    downloadFile: async (_employeeId: string, fileId: string) => {
      if (options.failIds?.includes(fileId)) {
        throw new Error("BambooHR 500 for file " + fileId);
      }
      return {
        bytes: new TextEncoder().encode(`pdf-bytes-${fileId}`),
        contentType: "application/pdf",
        filename: null,
      };
    },
  } as unknown as BambooClient;
}

function workspaceOf(items: TrainingItem[], files: EmployeeFile[]): Workspace {
  return { items, files, plan: buildMatchPlan(items, files), warnings: [] };
}

function readManifest(fs: ReturnType<typeof memoryFs>) {
  const raw = fs.written.get(MANIFEST_FILENAME);
  expect(raw).toBeDefined();
  const result = parseManifest(new TextDecoder().decode(raw!));
  if ("error" in result) throw new Error(result.error);
  return result.manifest;
}

const baseOptions = {
  connection,
  appVersion: "0.1.0",
  now: () => new Date("2026-01-15T00:00:00Z"),
};

describe("executePull", () => {
  it("downloads a confirmed pair and names it from the template", async () => {
    const items = [item({ key: "training:1", name: "CPR BLS", completed: "2025-06-01" })];
    const files = [file({ id: "100", name: "cpr" })];
    const fs = memoryFs();

    const result = await executePull({
      ...baseOptions,
      client: stubClient(),
      workspace: workspaceOf(items, files),
      decisions: { confirmed: { "100": "training:1" } },
      writeFile: fs.writeFile,
    });

    expect(result.filesWritten).toEqual(["CPR BLS - 2025-06-01.pdf"]);
    expect(fs.written.has("CPR BLS - 2025-06-01.pdf")).toBe(true);
    expect(result.failures).toEqual([]);

    const manifest = readManifest(fs);
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0]?.file).toMatchObject({
      bambooFileId: "100",
      savedAs: "CPR BLS - 2025-06-01.pdf",
      contentType: "application/pdf",
    });
    expect(manifest.entries[0]?.file?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.summary).toMatchObject({ totalRecords: 1, withFile: 1, withoutFile: 0 });
  });

  it("keeps records that have no file, since a record is itself evidence", async () => {
    const items = [
      item({ key: "training:1", name: "CPR BLS", completed: "2025-06-01" }),
      item({ key: "training:2", name: "Incident Command" }),
    ];
    const files = [file({ id: "100", name: "cpr" })];
    const fs = memoryFs();

    await executePull({
      ...baseOptions,
      client: stubClient(),
      workspace: workspaceOf(items, files),
      decisions: { confirmed: { "100": "training:1" } },
      writeFile: fs.writeFile,
    });

    const manifest = readManifest(fs);
    expect(manifest.entries).toHaveLength(2);
    const orphanRecord = manifest.entries.find((e) => e.key === "training:2");
    expect(orphanRecord?.file).toBeNull();
    expect(manifest.summary.withoutFile).toBe(1);
  });

  it("records a failed download as a failure but keeps the record in the manifest", async () => {
    const items = [item({ key: "training:1", name: "CPR BLS" })];
    const files = [file({ id: "100", name: "cpr" })];
    const fs = memoryFs();

    const result = await executePull({
      ...baseOptions,
      client: stubClient({ failIds: ["100"] }),
      workspace: workspaceOf(items, files),
      decisions: { confirmed: { "100": "training:1" } },
      writeFile: fs.writeFile,
    });

    expect(result.failures).toHaveLength(1);
    expect(result.filesWritten).toEqual([]);

    const manifest = readManifest(fs);
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0]?.file).toBeNull();
    expect(manifest.warnings.join(" ")).toContain("CPR BLS");
  });

  it("always writes the manifest and the summary, even with nothing to download", async () => {
    const fs = memoryFs();
    await executePull({
      ...baseOptions,
      client: stubClient(),
      workspace: workspaceOf([], []),
      decisions: { confirmed: {} },
      writeFile: fs.writeFile,
    });

    expect(fs.written.has(MANIFEST_FILENAME)).toBe(true);
    expect(fs.written.has(SUMMARY_CSV_FILENAME)).toBe(true);
  });

  it("saves orphan files AND records them in the manifest", async () => {
    const items = [item({ key: "training:1", name: "CPR BLS" })];
    const files = [file({ id: "100", name: "cpr" }), file({ id: "200", name: "mystery scan" })];
    const fs = memoryFs();

    const result = await executePull({
      ...baseOptions,
      client: stubClient(),
      workspace: workspaceOf(items, files),
      decisions: { confirmed: { "100": "training:1" }, includeOrphanFiles: true },
      writeFile: fs.writeFile,
    });

    expect(result.filesWritten).toContain("mystery scan.pdf");

    // The folder must be self-describing: Part 2 reads only the manifest.
    const manifest = readManifest(fs);
    expect(manifest.orphanFiles).toHaveLength(1);
    expect(manifest.orphanFiles[0]).toMatchObject({
      bambooFileId: "200",
      savedAs: "mystery scan.pdf",
    });
    expect(manifest.summary.filesWithoutRecord).toBe(1);
  });

  it("omits orphan files from disk when not requested, but still counts them", async () => {
    const items = [item({ key: "training:1", name: "CPR BLS" })];
    const files = [file({ id: "100", name: "cpr" }), file({ id: "200", name: "mystery" })];
    const fs = memoryFs();

    const result = await executePull({
      ...baseOptions,
      client: stubClient(),
      workspace: workspaceOf(items, files),
      decisions: { confirmed: { "100": "training:1" } },
      writeFile: fs.writeFile,
    });

    expect(result.filesWritten).toEqual(["CPR BLS.pdf"]);
    const manifest = readManifest(fs);
    expect(manifest.orphanFiles).toEqual([]);
    expect(manifest.summary.filesWithoutRecord).toBe(1);
  });

  it("labels a pairing the scorer never proposed as user-made, not heuristic", async () => {
    // Nothing links this record to a payroll document: no name overlap, and a
    // category that scores negatively. The scorer proposes nothing, so this
    // pairing can only have come from the user in the review screen.
    const items = [item({ key: "training:9", name: "Incident Command" })];
    const files = [file({ id: "100", name: "tax form", categoryName: "Payroll" })];
    const fs = memoryFs();

    const workspace = workspaceOf(items, files);
    expect(workspace.plan.matches).toEqual([]);

    await executePull({
      ...baseOptions,
      client: stubClient(),
      workspace,
      decisions: { confirmed: { "100": "training:9" } },
      writeFile: fs.writeFile,
    });

    expect(readManifest(fs).entries[0]?.file?.matchedBy).toBe("user");
  });

  it("never allocates a name the caller reserved for its own output", async () => {
    // A certification literally named "Training Summary" would otherwise be
    // written as Training Summary.pdf and then clobbered by the summary sheet.
    const items = [item({ key: "training:1", name: "Training Summary" })];
    const files = [file({ id: "100", name: "Training Summary" })];
    const fs = memoryFs();

    const result = await executePull({
      ...baseOptions,
      client: stubClient(),
      workspace: workspaceOf(items, files),
      decisions: { confirmed: { "100": "training:1" } },
      reservedFilenames: ["Training Summary.pdf"],
      writeFile: fs.writeFile,
    });

    expect(result.filesWritten).toEqual(["Training Summary (2).pdf"]);
  });

  it("excludes items the user deselected", async () => {
    const items = [
      item({ key: "training:1", name: "CPR BLS" }),
      item({ key: "training:2", name: "Fire Safety" }),
    ];
    const fs = memoryFs();

    await executePull({
      ...baseOptions,
      client: stubClient(),
      workspace: workspaceOf(items, []),
      decisions: { confirmed: {}, excludedItemKeys: ["training:2"] },
      writeFile: fs.writeFile,
    });

    const manifest = readManifest(fs);
    expect(manifest.entries.map((e) => e.key)).toEqual(["training:1"]);
  });

  it("gives colliding certifications distinct filenames", async () => {
    const items = [
      item({ key: "training:1", name: "CPR BLS" }),
      item({ key: "training:2", name: "CPR BLS" }),
    ];
    const files = [file({ id: "100", name: "a" }), file({ id: "200", name: "b" })];
    const fs = memoryFs();

    const result = await executePull({
      ...baseOptions,
      client: stubClient(),
      workspace: workspaceOf(items, files),
      decisions: { confirmed: { "100": "training:1", "200": "training:2" } },
      writeFile: fs.writeFile,
    });

    expect(new Set(result.filesWritten).size).toBe(2);
    expect(result.filesWritten).toContain("CPR BLS.pdf");
    expect(result.filesWritten).toContain("CPR BLS (2).pdf");
  });

  it("reports progress as downloads complete", async () => {
    const onProgress = vi.fn();
    const items = [item({ key: "training:1", name: "CPR BLS" })];
    const files = [file({ id: "100", name: "cpr" })];

    await executePull({
      ...baseOptions,
      client: stubClient(),
      workspace: workspaceOf(items, files),
      decisions: { confirmed: { "100": "training:1" } },
      writeFile: memoryFs().writeFile,
      onProgress,
    });

    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ completed: 1, total: 1, currentLabel: "CPR BLS" }),
    );
  });
});

describe("gatherWorkspace", () => {
  it("downgrades a refused source to a warning instead of failing the whole pull", async () => {
    const client = {
      listTrainingRecords: async () => [{ id: 1, type: "12", completed: "2025-06-01" }],
      // This is the documented 403 risk: names become unavailable.
      listTrainingTypes: async () => {
        throw new Error("BambooHR 403");
      },
      listCertifications: async () => [],
      listFiles: async () => [],
    } as unknown as BambooClient;

    const workspace = await gatherWorkspace(client, connection);

    expect(workspace.items).toHaveLength(1);
    expect(workspace.items[0]?.name).toBe("Training 12");
    expect(workspace.items[0]?.nameSource).toBe("placeholder");
    expect(workspace.warnings.join(" ")).toContain("Training names could not be read");
  });
});

describe("runPool", () => {
  it("never exceeds the concurrency limit", async () => {
    let active = 0;
    let peak = 0;
    await runPool(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 1));
      active--;
    });
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("processes every item", async () => {
    const seen: number[] = [];
    await runPool([1, 2, 3, 4, 5], 2, async (n) => {
      seen.push(n);
    });
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("handles an empty list without hanging", async () => {
    await expect(runPool([], 4, async () => {})).resolves.toBeUndefined();
  });
});

describe("executePull: what the export produced", () => {
  // Ownership of a file is recorded, never inferred. A later run consults this
  // to decide what it may replace, and guessing in that direction destroys the
  // user's own files - so the record has to name exactly what was written.
  it("records every file it wrote, including the summary and itself", async () => {
    const items = [item({ key: "training:1", name: "CPR BLS", completed: "2025-06-01" })];
    const files = [file({ id: "100", name: "cpr" })];
    const fs = memoryFs();

    await executePull({
      ...baseOptions,
      client: stubClient(),
      workspace: workspaceOf(items, files),
      decisions: { confirmed: { "100": "training:1" } },
      writeFile: fs.writeFile,
    });

    const manifest = readManifest(fs);
    expect(manifest.outputs).toContain("CPR BLS - 2025-06-01.pdf");
    expect(manifest.outputs).toContain(SUMMARY_CSV_FILENAME);
    expect(manifest.outputs).toContain(MANIFEST_FILENAME);
  });

  it("does not claim a certificate whose download failed", async () => {
    const items = [item({ key: "training:1", name: "CPR BLS", completed: "2025-06-01" })];
    const files = [file({ id: "100", name: "cpr" })];
    const fs = memoryFs();

    await executePull({
      ...baseOptions,
      client: stubClient({ failIds: ["100"] }),
      workspace: workspaceOf(items, files),
      decisions: { confirmed: { "100": "training:1" } },
      writeFile: fs.writeFile,
    });

    expect(readManifest(fs).outputs).not.toContain("CPR BLS - 2025-06-01.pdf");
  });
});

describe("executePull: filename collisions", () => {
  // The review screen allocates in record order. Confirmations are keyed by
  // file id, and walking THOSE gave numeric-key order - so the row promised
  // the plain name could be handed the suffixed one, and vice versa. The two
  // must agree, because the preview is a promise about what gets written.
  it("allocates collision suffixes in record order, not file-id order", async () => {
    const items = [
      item({ key: "training:1", name: "CPR", completed: "2025-06-01" }),
      item({ key: "training:2", name: "CPR", completed: "2025-06-01" }),
    ];
    // Deliberately reversed: the first record's file sorts second by id.
    const files = [file({ id: "900", name: "a" }), file({ id: "100", name: "b" })];
    const fs = memoryFs();

    await executePull({
      ...baseOptions,
      client: stubClient(),
      workspace: workspaceOf(items, files),
      decisions: { confirmed: { "900": "training:1", "100": "training:2" } },
      writeFile: fs.writeFile,
    });

    const manifest = readManifest(fs);
    const savedAs = (key: string) =>
      manifest.entries.find((e) => e.key === key)?.file?.savedAs;

    expect(savedAs("training:1")).toBe("CPR - 2025-06-01.pdf");
    expect(savedAs("training:2")).toBe("CPR - 2025-06-01 (2).pdf");
  });
});

describe("executePull: document checks in the manifest", () => {
  const verification = (bambooFileId: string, name: "confirms" | "contradicts") => ({
    provider: "anthropic",
    model: "claude-opus-5",
    verifiedAt: "2026-01-15T00:00:00.000Z",
    bambooFileId,
    extracted: {
      certificationName: "CPR BLS",
      issuedDate: "2025-06-01",
      expirationDate: null,
      personName: "Joshua Townsend",
      documentType: "certificate" as const,
      legible: true,
    },
    verdicts: { name, date: "confirms" as const, person: "confirms" as const },
    suggestedItemKey: null,
    error: null,
  });

  const items = [item({ key: "training:1", name: "CPR BLS", completed: "2025-06-01" })];
  const files = [file({ id: "100", name: "cpr" }), file({ id: "200", name: "other" })];

  it("records the check alongside the file it examined", async () => {
    const fs = memoryFs();
    await executePull({
      ...baseOptions,
      client: stubClient(),
      workspace: workspaceOf(items, files),
      decisions: {
        confirmed: { "100": "training:1" },
        verifications: { "training:1": verification("100", "confirms") },
      },
      writeFile: fs.writeFile,
    });

    const manifest = readManifest(fs);
    expect(manifest.manifestVersion).toBe(2);
    expect(manifest.entries[0]?.verification?.bambooFileId).toBe("100");
    expect(manifest.summary.verified).toBe(1);
    expect(manifest.summary.contradicted).toBe(0);
  });

  // The pairing is what was checked. Repointing the row afterwards makes the
  // verdict a claim about a document nobody looked at.
  it("drops a check whose row was repointed at a different file", async () => {
    const fs = memoryFs();
    await executePull({
      ...baseOptions,
      client: stubClient(),
      workspace: workspaceOf(items, files),
      decisions: {
        confirmed: { "200": "training:1" },
        verifications: { "training:1": verification("100", "confirms") },
      },
      writeFile: fs.writeFile,
    });

    expect(readManifest(fs).entries[0]?.verification).toBeNull();
  });

  // A failed attempt is still recorded, but it is not a verified certificate.
  // Counting it as one let a manifest report everything verified when every
  // single request had failed - the worst possible signal for Part 2.
  it("counts a failed attempt as attempted, not as verified", async () => {
    const fs = memoryFs();
    const failed = {
      ...verification("100", "confirms"),
      extracted: null,
      error: "The AI provider returned 400: credit balance is too low",
    };

    await executePull({
      ...baseOptions,
      client: stubClient(),
      workspace: workspaceOf(items, files),
      decisions: {
        confirmed: { "100": "training:1" },
        verifications: { "training:1": failed },
      },
      writeFile: fs.writeFile,
    });

    const manifest = readManifest(fs);
    expect(manifest.summary.verified).toBe(0);
    expect(manifest.summary.verificationFailed).toBe(1);
    // Still present, so "we asked and could not tell" survives into Part 2.
    expect(manifest.entries[0]?.verification?.error).toMatch(/credit balance/);
  });

  // A well-formed answer saying the scan is unreadable carries no error, but
  // nothing was learned from it. Counting it as verified would tell Part 2 a
  // folder of illegible scans had all been checked and cleared.
  it("does not count an illegible scan as verified", async () => {
    const fs = memoryFs();
    const unreadable = {
      ...verification("100", "confirms"),
      extracted: {
        certificationName: null,
        issuedDate: null,
        expirationDate: null,
        personName: null,
        alsoMentioned: [],
        documentType: "unreadable" as const,
        legible: false,
      },
      verdicts: {
        name: "inconclusive" as const,
        date: "inconclusive" as const,
        person: "inconclusive" as const,
      },
    };

    await executePull({
      ...baseOptions,
      client: stubClient(),
      workspace: workspaceOf(items, files),
      decisions: {
        confirmed: { "100": "training:1" },
        verifications: { "training:1": unreadable },
      },
      writeFile: fs.writeFile,
    });

    const manifest = readManifest(fs);
    expect(manifest.summary.verified).toBe(0);
    // Still recorded: the attempt happened and its result is evidence.
    expect(manifest.entries[0]?.verification).not.toBeNull();
  });

  // Decision: a contradicted check warns, it never blocks. The certificate is
  // still downloaded and still reaches the manifest.
  it("warns about a contradiction without withholding the file", async () => {
    const fs = memoryFs();
    const result = await executePull({
      ...baseOptions,
      client: stubClient(),
      workspace: workspaceOf(items, files),
      decisions: {
        confirmed: { "100": "training:1" },
        verifications: { "training:1": verification("100", "contradicts") },
      },
      writeFile: fs.writeFile,
    });

    expect(result.filesWritten).toHaveLength(1);
    const manifest = readManifest(fs);
    expect(manifest.summary.contradicted).toBe(1);
    expect(manifest.warnings.join(" ")).toMatch(/CPR BLS: the saved certificate was checked/);
  });
});
