import { comparePersonName } from "./identity.js";
import { numericTokens, tokenOverlap } from "./matching.js";
import type { EmployeeIdentity, TrainingItem } from "./types.js";

/**
 * Checking a certificate against the record it was paired with.
 *
 * The split here is deliberate and is the whole design. A vision model is
 * asked only "what does this document say?" - a question about pixels, which
 * is the one thing it is better at than this code. The far more consequential
 * question, "is this the right pairing?", is answered HERE, in ordinary
 * deterministic code that can be unit-tested, costs nothing to run, and
 * reaches the same verdict twice.
 *
 * That split buys something else too. Because the comparison uses the same
 * tokeniser as the matcher, a contradiction can name the record the document
 * ACTUALLY belongs to, rather than only raising doubt about the current one.
 */

/** What the model is asked to read off the page. Every field may be absent. */
export interface ExtractedCertificate {
  certificationName: string | null;
  /** ISO `YYYY-MM-DD`. The date the certification was earned or issued. */
  issuedDate: string | null;
  expirationDate: string | null;
  /** The name of the person the certificate was issued to. */
  personName: string | null;
  documentType: DocumentType;
  /** False when the page is too poor a scan to read with any confidence. */
  legible: boolean;
}

export type DocumentType = "certificate" | "card" | "transcript" | "other" | "unreadable";

const DOCUMENT_TYPES: readonly DocumentType[] = [
  "certificate",
  "card",
  "transcript",
  "other",
  "unreadable",
];

export type Verdict = "confirms" | "contradicts" | "inconclusive";

export interface VerificationVerdicts {
  /** Does the document's title agree with the record's certification name? */
  name: Verdict;
  /** Do the dates on the page agree with the record's dates? */
  date: Verdict;
  /** Is this the right person? `contradicts` means someone else's document. */
  person: Verdict;
}

/**
 * A completed check, as recorded in the manifest.
 *
 * `bambooFileId` is on here for a reason that is easy to miss: a verification
 * is about a PAIR, not a record. A user who verifies a row and then repoints
 * it at a different file must not ship the old verdict, so the id is carried
 * and re-checked before the verification is written out.
 */
export interface Verification {
  provider: string;
  model: string;
  verifiedAt: string;
  bambooFileId: string;
  extracted: ExtractedCertificate | null;
  verdicts: VerificationVerdicts;
  /**
   * The record this document appears to belong to instead. Set only when the
   * name contradicts AND another record is a clear better fit.
   */
  suggestedItemKey: string | null;
  /** Set when the check could not be completed. Never a silent failure. */
  error: string | null;
}

// --- The prompt ---------------------------------------------------------------

/**
 * Kept in `core` rather than in the UI so it is versioned with the parser that
 * has to cope with its output, and so it can be asserted on in tests.
 *
 * It says "null" more than it says anything else. A model asked to read a
 * blurry scan will confabulate a plausible certification name if the prompt
 * lets it, and a confident wrong answer here is worse than no answer: it would
 * contradict a correct pairing and send the user to "fix" something that was
 * never broken.
 */
export const EXTRACTION_PROMPT = `You are reading a scanned training certificate.

Report ONLY what is printed on this page. Do not infer, complete, or correct
anything. If a field is not legible or not present, return null for it - a null
is always better than a guess.

Fields:
- certificationName: the title of the certification or course, as printed.
- issuedDate: the date it was earned, completed, or issued (YYYY-MM-DD).
- expirationDate: the expiry or renewal date if one is printed (YYYY-MM-DD).
- personName: the name of the person it was issued to, exactly as printed.
- documentType: one of certificate, card, transcript, other, unreadable.
- legible: false if the scan is too poor to read with confidence.

If a date shows only a month and year, use the first day of that month.
Return a single JSON object with exactly these six keys and nothing else.`;

/** JSON Schema for endpoints that support structured output. */
export const EXTRACTION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "certificationName",
    "issuedDate",
    "expirationDate",
    "personName",
    "documentType",
    "legible",
  ],
  properties: {
    certificationName: { type: ["string", "null"] },
    issuedDate: { type: ["string", "null"] },
    expirationDate: { type: ["string", "null"] },
    personName: { type: ["string", "null"] },
    documentType: { type: "string", enum: DOCUMENT_TYPES },
    legible: { type: "boolean" },
  },
} as const;

// --- Parsing the model's answer ------------------------------------------------

/**
 * Turn whatever the model returned into an extraction, or an explanation.
 *
 * Models wrap JSON in prose and in ```json fences whatever the prompt says, so
 * the first balanced object in the text is used rather than requiring the
 * whole response to parse. Everything is then coerced field by field: a model
 * that returns `"none"` for a missing date must not put the string "none" in
 * the manifest.
 */
export function parseExtraction(
  text: string,
): { extracted: ExtractedCertificate } | { error: string } {
  const json = firstJsonObject(text);
  if (!json) {
    return { error: `The model did not return JSON: ${preview(text)}` };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    return {
      error: `The model's JSON could not be read: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "The model returned something other than a JSON object." };
  }

  const row = raw as Record<string, unknown>;
  const documentType = DOCUMENT_TYPES.includes(row.documentType as DocumentType)
    ? (row.documentType as DocumentType)
    : "other";

  return {
    extracted: {
      certificationName: cleanText(row.certificationName),
      issuedDate: cleanIsoDate(row.issuedDate),
      expirationDate: cleanIsoDate(row.expirationDate),
      personName: cleanText(row.personName),
      documentType,
      // Absent means "the model did not say it was illegible", which is the
      // ordinary case; only an explicit false marks a bad scan.
      legible: row.legible !== false && documentType !== "unreadable",
    },
  };
}

/** Scan for the first balanced `{...}`, ignoring braces inside strings. */
function firstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

function cleanText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Models reach for these when they mean null, whatever the prompt asked for.
  if (/^(null|none|n\/?a|unknown|not (visible|legible|present|found))$/i.test(trimmed)) {
    return null;
  }
  return trimmed;
}

/**
 * Accept only a real calendar date. A model that returns "2024" or "March
 * 2024" has not answered the question, and coercing it would manufacture a
 * precision the page does not have - which the date comparison would then
 * treat as evidence.
 */
export function cleanIsoDate(value: unknown): string | null {
  const text = cleanText(value);
  if (!text) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;

  const [, year, month, day] = match;
  const date = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  // Round-trip guards against "2024-02-31", which Date silently rolls forward.
  const roundTripped =
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() + 1 === Number(month) &&
    date.getUTCDate() === Number(day);
  return roundTripped ? text : null;
}

function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat || "(empty response)";
}

// --- The comparison ------------------------------------------------------------

export interface CompareInput {
  /** The record this file was paired with. */
  item: TrainingItem;
  extracted: ExtractedCertificate;
  /** The employee whose profile this is, for the person check. */
  identity: EmployeeIdentity | null;
  /** Every record in the export, so a contradiction can name a better fit. */
  allItems: readonly TrainingItem[];
}

export interface CompareResult {
  verdicts: VerificationVerdicts;
  suggestedItemKey: string | null;
}

/**
 * How much of the record's name must appear on the page before the document is
 * taken to confirm it. Certificates pad their titles with issuing-body names
 * and standard numbers, so an exact match is not on offer; two-thirds of the
 * record's own words is a strong signal without being unreachable.
 */
const NAME_CONFIRM_RATIO = 0.6;

/**
 * Dates drift legitimately: a course finishes on one day and the certificate
 * is dated when it was printed. A month of slack absorbs that; a year does
 * not, and a year's difference usually means a different sitting of the same
 * course - exactly the mistake worth catching.
 */
const DATE_TOLERANCE_DAYS = 31;

export function compareExtraction(input: CompareInput): CompareResult {
  const { item, extracted, identity, allItems } = input;

  // An illegible page is evidence of nothing. Reporting "contradicts" here
  // would blame the record for the scanner.
  if (!extracted.legible) {
    return {
      verdicts: { name: "inconclusive", date: "inconclusive", person: "inconclusive" },
      suggestedItemKey: null,
    };
  }

  const name = compareName(item, extracted.certificationName);
  const date = compareDates(item, extracted);
  const person = comparePerson(extracted.personName, identity);

  return {
    verdicts: { name, date, person },
    suggestedItemKey:
      name === "contradicts"
        ? betterFitFor(extracted.certificationName, item, allItems)
        : null,
  };
}

function compareName(item: TrainingItem, printed: string | null): Verdict {
  if (!printed) return "inconclusive";

  // A level or module number is the entire difference between two otherwise
  // identical certifications, so a conflict overrides word agreement - which
  // is precisely the failure the matcher itself was shipped with.
  const recordNumbers = numericTokens(item.name);
  const printedNumbers = numericTokens(printed);
  if (recordNumbers.size > 0 && printedNumbers.size > 0) {
    const shared = [...recordNumbers].filter((n) => printedNumbers.has(n));
    if (shared.length === 0) return "contradicts";
  }

  const { ratio } = tokenOverlap(item.name, printed);
  if (ratio >= NAME_CONFIRM_RATIO) return "confirms";
  if (ratio === 0) return "contradicts";
  return "inconclusive";
}

/**
 * The completion date is checked first because it is what the filename and the
 * export are built from. Expiry is the fallback: a wallet card often prints
 * only "expires", with no issue date anywhere on it.
 */
function compareDates(item: TrainingItem, extracted: ExtractedCertificate): Verdict {
  const issued = compareOneDate(item.completed, extracted.issuedDate);
  if (issued !== "inconclusive") return issued;
  return compareOneDate(item.expires, extracted.expirationDate);
}

function compareOneDate(recorded: string | null, printed: string | null): Verdict {
  if (!recorded || !printed) return "inconclusive";
  const a = Date.parse(recorded);
  const b = Date.parse(printed);
  if (Number.isNaN(a) || Number.isNaN(b)) return "inconclusive";
  const days = Math.abs(a - b) / 86_400_000;
  return days <= DATE_TOLERANCE_DAYS ? "confirms" : "contradicts";
}

function comparePerson(printed: string | null, identity: EmployeeIdentity | null): Verdict {
  switch (comparePersonName(printed, identity)) {
    case "same":
      return "confirms";
    case "different":
      return "contradicts";
    default:
      return "inconclusive";
  }
}

/**
 * When the page does not describe the record it was paired with, look for the
 * record it DOES describe. Naming the right answer is worth far more to the
 * user than flagging the wrong one, because it turns a puzzle into a click.
 */
function betterFitFor(
  printed: string | null,
  current: TrainingItem,
  allItems: readonly TrainingItem[],
): string | null {
  if (!printed) return null;

  let best: { key: string; ratio: number } | null = null;
  for (const candidate of allItems) {
    if (candidate.key === current.key) continue;
    const { ratio } = tokenOverlap(candidate.name, printed);
    if (ratio < NAME_CONFIRM_RATIO) continue;
    // Numbers must agree for a suggestion, not merely fail to conflict; this
    // is an assertion about the right answer, not a doubt about the current.
    const candidateNumbers = numericTokens(candidate.name);
    const printedNumbers = numericTokens(printed);
    if (candidateNumbers.size > 0 && printedNumbers.size > 0) {
      const shared = [...candidateNumbers].filter((n) => printedNumbers.has(n));
      if (shared.length === 0) continue;
    }
    if (!best || ratio > best.ratio) best = { key: candidate.key, ratio };
  }
  return best?.key ?? null;
}

/** True when a verdict set is worth interrupting the user over. */
export function isTroubling(verification: Verification): boolean {
  const { name, date, person } = verification.verdicts;
  return name === "contradicts" || date === "contradicts" || person === "contradicts";
}
