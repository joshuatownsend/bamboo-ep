import type { BambooClient } from "./bamboo.js";
import { applyFileNameFallback, buildTrainingItems } from "./items.js";
import type { Match, MatchPlan } from "./matching.js";
import { buildMatchPlan } from "./matching.js";
import type { ConfirmedMappings } from "./matching.js";
import {
  buildManifest,
  sha256Hex,
  serializeManifest,
  MANIFEST_FILENAME,
} from "./manifest.js";
import type { Manifest, ManifestEntry, OrphanFile } from "./manifest.js";
import { DEFAULT_TEMPLATE, FilenameAllocator, buildFilename, stemOf } from "./naming.js";
import { buildSummaryCsv, SUMMARY_CSV_FILENAME } from "./summary.js";
import type { Connection, EmployeeFile, TrainingItem } from "./types.js";
import { isTroubling } from "./verify.js";
import type { Verification } from "./verify.js";

/**
 * The two-phase pull.
 *
 * Phase 1 (`gatherWorkspace`) reads everything and proposes file-to-record
 * matches, writing nothing. Phase 2 (`executePull`) runs only after the user
 * has reviewed those matches. The split exists because the matching is
 * heuristic - writing files before a human has looked at the pairings would
 * produce confidently mislabelled certificates, which is worse than producing
 * none.
 */

export interface Workspace {
  items: TrainingItem[];
  files: EmployeeFile[];
  plan: MatchPlan;
  /** Raised when a data source was refused or empty; surfaced before download. */
  warnings: string[];
}

export async function gatherWorkspace(
  client: BambooClient,
  connection: Connection,
  options: { confirmed?: ConfirmedMappings } = {},
): Promise<Workspace> {
  const warnings: string[] = [];

  // Every source is optional. A refusal on one must not sink the whole pull,
  // so each is caught and downgraded to a warning.
  const [records, types, certifications, files] = await Promise.all([
    softly(() => client.listTrainingRecords(connection.employeeId), [], warnings,
      "Training records could not be read"),
    softly(() => client.listTrainingTypes(), new Map(), warnings,
      "Training names could not be read, so some records will use fallback names"),
    softly(() => client.listCertifications(connection.employeeId), [], warnings,
      "The certifications table could not be read"),
    softly(() => client.listFiles(connection.employeeId), [], warnings,
      "Certificate files could not be listed"),
  ]);

  const items = buildTrainingItems({ records, types, certifications });
  const plan = buildMatchPlan(items, files, options.confirmed ? { confirmed: options.confirmed } : {});

  return { items, files, plan, warnings };
}

async function softly<T>(
  run: () => Promise<T>,
  fallback: T,
  warnings: string[],
  message: string,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    warnings.push(`${message}: ${err instanceof Error ? err.message : String(err)}`);
    return fallback;
  }
}

/** What the user decided in the review screen. */
export interface PullDecisions {
  /** fileId -> itemKey. Replaces the proposed plan entirely. */
  confirmed: ConfirmedMappings;
  /** Item keys the user chose to exclude from this export. */
  excludedItemKeys?: readonly string[];
  /** Also save files that matched no record, under their own names. */
  includeOrphanFiles?: boolean;
  /**
   * Document checks the user ran during review, keyed by item key.
   *
   * A verification is about a PAIR, so each one names the file it examined and
   * is discarded if the row now points somewhere else. Without that, verifying
   * a row and then repointing it would ship a verdict about a document nobody
   * looked at.
   */
  verifications?: Readonly<Record<string, Verification>>;
}

export interface PullOptions {
  client: BambooClient;
  connection: Connection;
  workspace: Workspace;
  decisions: PullDecisions;
  filenameTemplate?: string;
  /**
   * Extra names the caller will write into the same folder afterwards. They
   * are claimed up front so a certificate can never be allocated a name that
   * is later overwritten - the printable summary is written by the UI layer,
   * so core cannot know its filename without being told.
   */
  reservedFilenames?: readonly string[];
  appVersion: string;
  /** Injected so `core` never imports a filesystem. */
  writeFile: (filename: string, bytes: Uint8Array) => Promise<void>;
  /** Injected for deterministic tests. */
  now?: () => Date;
  concurrency?: number;
  onProgress?: (progress: PullProgress) => void;
  signal?: AbortSignal;
}

export interface PullProgress {
  completed: number;
  total: number;
  currentLabel: string;
}

export interface PullResult {
  manifest: Manifest;
  filesWritten: string[];
  failures: Array<{ fileId: string; label: string; message: string }>;
}

export async function executePull(options: PullOptions): Promise<PullResult> {
  const {
    connection,
    workspace,
    decisions,
    appVersion,
    writeFile,
    now = () => new Date(),
    concurrency = 4,
  } = options;
  const template = options.filenameTemplate ?? DEFAULT_TEMPLATE;

  const excluded = new Set(decisions.excludedItemKeys ?? []);
  const itemsByKey = new Map(workspace.items.map((i) => [i.key, i]));
  const filesById = new Map(workspace.files.map((f) => [f.id, f]));

  // The user's decisions are authoritative; the proposed plan is only used to
  // carry match scores through for the manifest's audit trail.
  const scoreByPair = new Map(
    workspace.plan.matches.map((m: Match) => [`${m.fileId}:${m.itemKey}`, m]),
  );

  // Confirmations are keyed by file id, but they are WALKED in record order.
  // Filenames are allocated in this order, and two records can render the same
  // name, so whoever is walked first takes the unsuffixed one. Object key order
  // for numeric-looking keys is numeric, which has nothing to do with the order
  // the review screen displays - so the row promised "CPR.pdf" could quietly be
  // handed "CPR (2).pdf" while another record took the plain name.
  const fileIdByItemKey = new Map(
    Object.entries(decisions.confirmed).map(([fileId, itemKey]) => [itemKey, fileId]),
  );

  const pairs: Array<{ item: TrainingItem; file: EmployeeFile; matched: Match | undefined }> = [];
  for (const item of workspace.items) {
    const fileId = fileIdByItemKey.get(item.key);
    if (fileId === undefined || excluded.has(item.key)) continue;
    const file = filesById.get(fileId);
    if (!file) continue;
    pairs.push({ item, file, matched: scoreByPair.get(`${fileId}:${item.key}`) });
  }

  const pairedFileIds = new Set(pairs.map((p) => p.file.id));

  /**
   * A verdict is only carried into the manifest if the row still points at the
   * file that was examined. Repointing a row after verifying it must lose the
   * verdict, not relabel it.
   */
  const verificationFor = (itemKey: string, fileId: string): Verification | null => {
    const found = decisions.verifications?.[itemKey];
    return found && found.bambooFileId === fileId ? found : null;
  };

  const allocator = new FilenameAllocator([
    MANIFEST_FILENAME,
    SUMMARY_CSV_FILENAME,
    ...(options.reservedFilenames ?? []),
  ]);
  const failures: PullResult["failures"] = [];
  const filesWritten: string[] = [];
  const entriesByKey = new Map<string, ManifestEntry>();
  const orphanRecords: OrphanFile[] = [];

  // Allocate filenames up front, single-threaded, so concurrent downloads can
  // never race to claim the same name.
  const jobs = pairs.map(({ item, file, matched }) => {
    const named = applyFileNameFallback(item, stemOf(file.originalFileName ?? file.name));
    const filename = buildFilename({
      template,
      values: {
        name: named.name,
        completed: named.completed,
        expires: named.expires,
        category: named.category ?? file.categoryName,
        original: stemOf(file.originalFileName ?? file.name),
      },
      originalFileName: file.originalFileName ?? file.name,
      allocator,
    });
    return { item: named, file, matched, filename };
  });

  const orphanJobs = decisions.includeOrphanFiles
    ? workspace.files
        .filter((f) => !pairedFileIds.has(f.id))
        .map((file) => ({
          file,
          filename: allocator.allocate(
            stemOf(file.originalFileName ?? file.name) ?? file.name,
            extensionFrom(file),
          ),
        }))
    : [];

  const total = jobs.length + orphanJobs.length;
  let completed = 0;
  const report = (label: string) =>
    options.onProgress?.({ completed, total, currentLabel: label });

  const download = async (fileId: string, filename: string, label: string) => {
    options.signal?.throwIfAborted();
    const result = await options.client.downloadFile(connection.employeeId, fileId);
    await writeFile(filename, result.bytes);
    completed++;
    report(label);
    return result;
  };

  await runPool(jobs, concurrency, async (job) => {
    try {
      const res = await download(job.file.id, job.filename, job.item.name);
      filesWritten.push(job.filename);
      entriesByKey.set(job.item.key, {
        ...toEntry(job.item, verificationFor(job.item.key, job.file.id)),
        file: {
          bambooFileId: job.file.id,
          savedAs: job.filename,
          originalFileName: job.file.originalFileName,
          categoryName: job.file.categoryName,
          bytes: res.bytes.byteLength,
          sha256: await sha256Hex(res.bytes),
          contentType: res.contentType,
          // No proposal for this pair means the user created it by hand in
          // the review screen - the most user-driven case there is.
          matchedBy:
            job.matched === undefined || job.matched.confirmedByUser ? "user" : "heuristic",
          matchScore: job.matched?.score ?? 1,
        },
      });
    } catch (err) {
      completed++;
      failures.push({
        fileId: job.file.id,
        label: job.item.name,
        message: err instanceof Error ? err.message : String(err),
      });
      // A failed download still leaves a record worth reporting. The check is
      // dropped with it: a verdict about a file that is not in the folder
      // would be a claim Part 2 could not act on.
      entriesByKey.set(job.item.key, toEntry(job.item));
    }
  });

  await runPool(orphanJobs, concurrency, async (job) => {
    try {
      const res = await download(job.file.id, job.filename, job.file.name);
      filesWritten.push(job.filename);
      orphanRecords.push({
        bambooFileId: job.file.id,
        savedAs: job.filename,
        originalFileName: job.file.originalFileName,
        categoryName: job.file.categoryName,
        bytes: res.bytes.byteLength,
        sha256: await sha256Hex(res.bytes),
      });
    } catch (err) {
      failures.push({
        fileId: job.file.id,
        label: job.file.name,
        message: err instanceof Error ? err.message : String(err),
      });
      // Still recorded, with savedAs null, so the gap is visible to Part 2
      // rather than silently absent.
      orphanRecords.push({
        bambooFileId: job.file.id,
        savedAs: null,
        originalFileName: job.file.originalFileName,
        categoryName: job.file.categoryName,
        bytes: null,
        sha256: null,
      });
    }
  });

  // Records with no file are still exported - a BambooHR record is evidence
  // in its own right, and the reviewer needs to see the gaps.
  for (const item of workspace.items) {
    if (excluded.has(item.key) || entriesByKey.has(item.key)) continue;
    entriesByKey.set(item.key, toEntry(item));
  }

  const entries = workspace.items
    .map((i) => entriesByKey.get(i.key))
    .filter((e): e is ManifestEntry => e != null);

  // A contradicted check is raised as a warning rather than blocking the
  // pull. The decision on this was explicit: a document check is evidence, not
  // an authority, and a check that can stop an export would be switched off
  // the first time it was wrong. The record still has to reach the manifest -
  // it is the reviewer, not this app, who decides what to do about it.
  const verificationWarnings = entries
    .filter((e) => e.verification != null && isTroubling(e.verification))
    .map((e) => describeContradiction(e, itemsByKey));

  const warnings = [
    ...workspace.warnings,
    ...failures.map((f) => `${f.label}: ${f.message}`),
    ...verificationWarnings,
  ];

  // The summaries are part of what this export produced, so they belong in
  // `outputs` alongside the certificates. The manifest names itself too: a
  // later run must be able to recognise it as ours.
  const outputs = [...filesWritten, SUMMARY_CSV_FILENAME, MANIFEST_FILENAME];

  const manifest = buildManifest({
    appVersion,
    generatedAt: now().toISOString(),
    subdomain: connection.credentials.subdomain,
    employeeId: connection.employeeId,
    endpointStyle: connection.style,
    filenameTemplate: template,
    entries,
    orphanFiles: orphanRecords,
    orphanFileCount: workspace.files.filter((f) => !pairedFileIds.has(f.id)).length,
    outputs,
    warnings,
  });

  await writeFile(SUMMARY_CSV_FILENAME, encodeUtf8(buildSummaryCsv(manifest)));
  await writeFile(MANIFEST_FILENAME, encodeUtf8(serializeManifest(manifest)));

  return { manifest, filesWritten, failures };
}

function toEntry(
  item: TrainingItem,
  verification: Verification | null = null,
): ManifestEntry {
  return {
    key: item.key,
    recordId: item.id,
    source: item.source,
    name: item.name,
    nameSource: item.nameSource,
    category: item.category,
    completed: item.completed,
    expires: item.expires,
    expiresDerived: item.expiresDerived,
    instructor: item.instructor,
    certificationNumber: item.certificationNumber,
    notes: item.notes,
    file: null,
    verification,
  };
}

function extensionFrom(file: EmployeeFile): string {
  const source = file.originalFileName ?? file.name;
  const dot = source.lastIndexOf(".");
  return dot > 0 ? source.slice(dot).toLowerCase() : "";
}

/** Bounded-concurrency worker pool; keeps BambooHR from throttling us. */
export async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const size = Math.max(1, Math.min(concurrency, queue.length));
  await Promise.all(
    Array.from({ length: size }, async () => {
      for (;;) {
        const next = queue.shift();
        if (next === undefined) return;
        await worker(next);
      }
    }),
  );
}

function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * Plain language, naming the record the document appears to belong to when
 * there is one. "Fire Officer 2 may be Fire Officer 3's certificate" is
 * actionable; "verification failed" is not.
 */
function describeContradiction(
  entry: ManifestEntry,
  itemsByKey: ReadonlyMap<string, TrainingItem>,
): string {
  const check = entry.verification;
  if (!check) return "";

  const problems: string[] = [];
  if (check.verdicts.person === "contradicts") {
    problems.push(
      `it appears to be issued to ${check.extracted?.personName ?? "someone else"}`,
    );
  }
  if (check.verdicts.name === "contradicts") {
    const suggestion = check.suggestedItemKey
      ? itemsByKey.get(check.suggestedItemKey)?.name
      : null;
    problems.push(
      suggestion
        ? `the page reads "${check.extracted?.certificationName ?? "?"}", which matches ${suggestion}`
        : `the page reads "${check.extracted?.certificationName ?? "?"}"`,
    );
  }
  if (check.verdicts.date === "contradicts") {
    problems.push(`the date on the page is ${check.extracted?.issuedDate ?? "different"}`);
  }

  return `${entry.name}: the saved certificate was checked and ${problems.join("; ")}.`;
}
