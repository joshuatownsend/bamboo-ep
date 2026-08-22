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
