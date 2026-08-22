import { stemOf } from "./naming.js";
import type { EmployeeFile, TrainingItem } from "./types.js";

/**
 * Matching certificate files to training records.
 *
 * BambooHR documents NO relationship between an employee file and a training
 * record. There is no shared id, no back-reference, nothing. So this is a
 * heuristic and is treated as one: it proposes pairings with a confidence
 * band, and the UI requires the user to confirm them before anything is
 * written to disk. The scoring exists to make that review fast, not to be
 * trusted unattended.
 */

/** Category names that usually hold certificates, scored by how strong a hint they are. */
const CATEGORY_HINTS: ReadonlyArray<{ pattern: RegExp; weight: number }> = [
  { pattern: /certificat/i, weight: 0.25 },
  { pattern: /training/i, weight: 0.2 },
  { pattern: /licen[sc]e/i, weight: 0.2 },
  { pattern: /credential|qualification/i, weight: 0.15 },
  { pattern: /medical|payroll|tax|offer|handbook|onboard|review/i, weight: -0.3 },
];

/** Words too common in this domain to carry any identifying signal. */
const STOP_WORDS = new Set([
  "certificate", "certification", "cert", "training", "course", "record",
  "completion", "completed", "card", "copy", "scan", "final", "signed",
  "the", "of", "and", "for", "a", "an", "my",
]);

export type MatchConfidence = "high" | "medium" | "low";

export interface Match {
  itemKey: string;
  fileId: string;
  score: number;
  confidence: MatchConfidence;
  /**
   * True when this pairing came from the user rather than the scorer. Kept as
   * a flag rather than inferred from `reasons`, so display text can change
   * without altering behaviour.
   */
  confirmedByUser: boolean;
  /** Short phrases explaining the score, shown in the review UI. */
  reasons: string[];
}

export interface MatchPlan {
  matches: Match[];
  unmatchedItemKeys: string[];
  unmatchedFileIds: string[];
}

/** A user-confirmed mapping from a previous run: fileId to itemKey. */
export type ConfirmedMappings = Readonly<Record<string, string>>;

export interface MatchOptions {
  /** Pairings the user already confirmed; these bypass scoring entirely. */
  confirmed?: ConfirmedMappings;
  /** Minimum score to propose a pairing at all. */
  threshold?: number;
}

const DEFAULT_THRESHOLD = 0.2;

export function buildMatchPlan(
  items: TrainingItem[],
  files: EmployeeFile[],
  options: MatchOptions = {},
): MatchPlan {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const confirmed = options.confirmed ?? {};

  const itemsByKey = new Map(items.map((i) => [i.key, i]));
  const matches: Match[] = [];
  const usedFiles = new Set<string>();
  const usedItems = new Set<string>();

  // User-confirmed pairs win outright and are never re-scored.
  for (const [fileId, itemKey] of Object.entries(confirmed)) {
    if (!itemsByKey.has(itemKey)) continue;
    if (!files.some((f) => f.id === fileId)) continue;
    matches.push({
      itemKey,
      fileId,
      score: 1,
      confidence: "high",
      confirmedByUser: true,
      reasons: ["You confirmed this match previously"],
    });
    usedFiles.add(fileId);
    usedItems.add(itemKey);
  }

  // Score every remaining pair, then assign greedily best-first. Greedy is the
  // right trade here: an optimal assignment would be harder to explain in the
  // review UI, and the user is confirming each row anyway.
  const candidates: Match[] = [];
  for (const item of items) {
    if (usedItems.has(item.key)) continue;
    for (const file of files) {
      if (usedFiles.has(file.id)) continue;
      const scored = scorePair(item, file);
      if (scored.score >= threshold) candidates.push(scored);
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.fileId.localeCompare(b.fileId));

  for (const candidate of candidates) {
    if (usedItems.has(candidate.itemKey) || usedFiles.has(candidate.fileId)) continue;
    matches.push(candidate);
    usedItems.add(candidate.itemKey);
    usedFiles.add(candidate.fileId);
  }

  return {
    matches,
    unmatchedItemKeys: items.filter((i) => !usedItems.has(i.key)).map((i) => i.key),
    unmatchedFileIds: files.filter((f) => !usedFiles.has(f.id)).map((f) => f.id),
  };
}

export function scorePair(item: TrainingItem, file: EmployeeFile): Match {
  const reasons: string[] = [];
  let score = 0;

  const overlap = tokenOverlap(item.name, `${file.name} ${file.originalFileName ?? ""}`);
  if (overlap.ratio > 0) {
    // Name similarity is the strongest available signal, so it dominates.
    score += overlap.ratio * 0.7;
    reasons.push(`File name shares "${overlap.shared.slice(0, 3).join('", "')}"`);
  }

  for (const hint of CATEGORY_HINTS) {
    if (hint.pattern.test(file.categoryName)) {
      score += hint.weight;
      if (hint.weight > 0) reasons.push(`Filed under "${file.categoryName}"`);
      else reasons.push(`"${file.categoryName}" rarely holds certificates`);
      break;
    }
  }

  // A level or module number is the whole difference between two otherwise
  // identical certifications, so a conflict here is strong evidence against
  // the pairing - stronger than the word overlap is evidence for it.
  const certNumbers = numericTokens(item.name);
  // Per-field, not concatenated: the duplicate-suffix strip is anchored to the
  // end of a filename, which a concatenation would hide.
  const fileNumbers = new Set([
    ...numericTokens(file.name),
    ...numericTokens(file.originalFileName ?? ""),
  ]);
  if (certNumbers.size > 0 && fileNumbers.size > 0) {
    const shared = [...certNumbers].filter((n) => fileNumbers.has(n));
    if (shared.length > 0) {
      score += 0.15;
      reasons.push(`Numbers agree (${shared.slice(0, 2).join(", ")})`);
    } else {
      score -= 0.4;
      reasons.push(
        `Numbers disagree (${[...certNumbers].slice(0, 2).join(", ")} vs ` +
          `${[...fileNumbers].slice(0, 2).join(", ")})`,
      );
    }
  }

  const proximity = dateProximity(item.completed, file.dateCreated);
  if (proximity != null) {
    score += proximity.weight;
    if (proximity.weight > 0) reasons.push(proximity.reason);
  }

  const clamped = Math.max(0, Math.min(1, score));
  return {
    itemKey: item.key,
    fileId: file.id,
    score: clamped,
    confidence: clamped >= 0.7 ? "high" : clamped >= 0.4 ? "medium" : "low",
    confirmedByUser: false,
    reasons,
  };
}

/**
 * Proportion of the certification's meaningful words that appear in the file
 * name. Measured against the certification rather than the file so that a
 * long, noisy filename is not penalised for its extra words.
 */
export function tokenOverlap(
  certName: string,
  fileName: string,
): { ratio: number; shared: string[] } {
  const certTokens = tokenize(certName);
  if (certTokens.size === 0) return { ratio: 0, shared: [] };
  const fileTokens = tokenize(fileName);

  const shared = [...certTokens].filter((t) => fileTokens.has(t));
  return { ratio: shared.length / certTokens.size, shared };
}

/**
 * Roman numerals appear constantly in certification levels ("Firefighter II",
 * "Fire Officer IV") while the uploaded file spells the same level with a
 * digit. Normalising both to digits lets them match, and - more importantly -
 * lets a genuine MISmatch be detected.
 */
const ROMAN_NUMERALS: Readonly<Record<string, string>> = {
  i: "1", ii: "2", iii: "3", iv: "4", v: "5",
  vi: "6", vii: "7", viii: "8", ix: "9", x: "10",
};

export function tokenize(input: string): Set<string> {
  const stem = stemOf(input) ?? input;
  const tokens = stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t !== "")
    .map((t) => ROMAN_NUMERALS[t] ?? t)
    // Single characters carry no signal EXCEPT digits, which are often the
    // only thing distinguishing "Module 1" from "Module 2". Dropping them
    // made those two score identically and get assigned arbitrarily.
    .filter((t) => (t.length > 1 || /^[0-9]$/.test(t)) && !STOP_WORDS.has(t));
  return new Set(tokens);
}

/**
 * The numeric tokens that identify a certification: levels, module numbers,
 * and standard numbers such as NFPA 1001.
 *
 * Years are excluded because they date the document rather than identify the
 * certification, and a browser's " (1)" duplicate-download suffix is stripped
 * for the same reason - both produced false conflicts against real files.
 */
export function numericTokens(input: string): Set<string> {
  const cleaned = input.replace(/\s\(\d+\)(?=\.[a-z0-9]+$|$)/i, "");
  return new Set(
    [...tokenize(cleaned)].filter((t) => /^[0-9]+$/.test(t) && !isYear(t)),
  );
}

function isYear(token: string): boolean {
  return /^(19|20)\d{2}$/.test(token);
}

/**
 * Files are usually uploaded around the time the training was completed, so
 * closeness in time is corroborating evidence - but weak evidence, since a
 * batch upload of ten old certificates on one day would score them all alike.
 */
function dateProximity(
  completed: string | null,
  uploaded: string | null,
): { weight: number; reason: string } | null {
  if (!completed || !uploaded) return null;
  const a = Date.parse(completed);
  const b = Date.parse(uploaded);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;

  const days = Math.abs(a - b) / 86_400_000;
  if (days <= 14) return { weight: 0.2, reason: "Uploaded within 2 weeks of completion" };
  if (days <= 90) return { weight: 0.1, reason: "Uploaded within 3 months of completion" };
  if (days > 730) return { weight: -0.1, reason: "Uploaded years apart" };
  return { weight: 0, reason: "" };
}
