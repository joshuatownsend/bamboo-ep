/**
 * Essential Personnel: matching a certification record to EP's catalogue, and
 * deciding what may be uploaded.
 *
 * EP is LC-CFRS's system of record, and a member writes to it directly - a
 * submission goes straight to Active with no approval step in between
 * (verified 23 August 2026). Nothing here uploads anything; this module only
 * decides what SHOULD be uploaded and hands the decision to a human. That
 * split exists because the review screen is the only check between a bad match
 * and a wrong credential in the county's records.
 *
 * See `docs/part-2-plan.md` for the General Order this is written against.
 */

import type { ManifestEntry } from "./manifest.js";
import { isStableKey } from "./items.js";
import { tokenOverlap, tokenize, compareNumbers } from "./matching.js";

/** One entry in EP's certification catalogue, from `/template/certification/all`. */
export interface EpTemplate {
  id: string;
  name: string;
  abbreviation: string | null;
}

/**
 * A certification already on the member's EP profile.
 *
 * EP's own field names do not mean what they say, and the mapping is recorded
 * here rather than in a comment somewhere far from the code that relies on it:
 * `year` holds a full completion DATE, and `school` holds what the UI labels
 * "Institution Name". Reading `year` as a year would silently corrupt every
 * date this tool touches.
 */
export interface EpUserCertification {
  id: string;
  templateId: string;
  /** Completion date, ISO `YYYY-MM-DD`. EP calls this field `year`. */
  completed: string | null;
  expires: string | null;
  /** EP calls this `school`; the form labels it "Institution Name". */
  institution: string | null;
  /** Present once a certificate file is attached. */
  documentUrl: string | null;
  /**
   * `"targetSolutions"` when the row arrived through the Vector/Target
   * Solutions integration rather than from a person. The General Order says
   * those must not be re-uploaded, and this is a far better signal for that
   * than matching on names.
   */
  importedFrom: string | null;
}

export type EpMatchConfidence = "high" | "medium" | "low";

export interface EpTemplateMatch {
  template: EpTemplate;
  score: number;
  confidence: EpMatchConfidence;
  /** Plain-language why, shown to the member making the decision. */
  reasons: string[];
}

/**
 * What the member decided about a record whose fate the matcher could not
 * settle on its own. Remembered between runs.
 */
export type EpDecision =
  | { kind: "template"; templateId: string }
  | { kind: "skip"; note?: string }
  | { kind: "request" };

/** Keyed by `ManifestEntry.key`. */
export type EpDecisions = Readonly<Record<string, EpDecision>>;

export type EpOutcome =
  | "ready"
  | "alreadyInEp"
  | "importedByTargetSolutions"
  | "needsTriage"
  | "duplicateInPlan"
  | "noCompletionDate"
  | "skipped"
  | "requested"
  | "noFile";

export interface EpPlanItem {
  entry: ManifestEntry;
  outcome: EpOutcome;
  /** The chosen template, once there is one. */
  template: EpTemplate | null;
  /** Ranked alternatives, so the member can correct a bad pick. */
  candidates: EpTemplateMatch[];
  /** Set when the record is already present, so the UI can say which row. */
  existing: EpUserCertification | null;
  /** Why this landed where it did, in words a member can act on. */
  explanation: string;
}

export interface EpPlan {
  items: EpPlanItem[];
  /** Names to send to the training captain, per the General Order. */
  catalogueRequests: string[];
}

/**
 * Confirming a template must be *much* safer than confirming a file pairing in
 * Part 1. There, a wrong guess mislabels a file in a folder the member is
 * looking at. Here it writes a credential the member does not hold into the
 * county's system of record, live, with no approval step to catch it.
 */
const AUTO_CONFIRM_SCORE = 0.85;
const TRIAGE_FLOOR = 0.45;

/** How many alternatives are worth showing. Beyond this it is a list, not a choice. */
const MAX_CANDIDATES = 5;

/**
 * BambooHR prefixes its records with the system that supplied them - `[SWP]`,
 * `[TS]`, `[LA]` - and EP has no equivalent. Left in place they are pure noise
 * that drags every score down by the same amount, which is worse than useless:
 * it compresses the gap between a good match and a bad one.
 */
function withoutSourcePrefix(name: string): string {
  return name.replace(/^\s*\[[A-Za-z0-9]{1,6}\]\s*/, "").trim();
}

/**
 * How much each name says about the other, combined into one score.
 *
 * Coverage in one direction alone is not a match. EP's catalogue holds both
 * "CPR" and "HealthCare Provider CPR", and a record reading "HealthCare
 * Provider CPR" contains every word of the bare "CPR" - so one-directional
 * coverage scores the generic entry a perfect 1 and ranks it alongside the
 * specific one. Filing a record under a vaguer certification than the member
 * actually holds is a quiet form of the wrong answer.
 *
 * The catalogue direction is weighted the heavier of the two, because a
 * record legitimately carries words the catalogue never will - BambooHR's
 * source tags, a provider's name, a course code local to one department.
 */
const CATALOGUE_WEIGHT = 2;

function combinedCoverage(catalogueCoverage: number, recordCoverage: number): number {
  if (catalogueCoverage === 0 || recordCoverage === 0) return 0;
  const b2 = CATALOGUE_WEIGHT * CATALOGUE_WEIGHT;
  return ((1 + b2) * catalogueCoverage * recordCoverage) / (b2 * catalogueCoverage + recordCoverage);
}

export function scoreTemplate(recordName: string, template: EpTemplate): EpTemplateMatch {
  const reasons: string[] = [];
  const record = withoutSourcePrefix(recordName);
  const catalogue = template.name.trim();

  const numbers = compareNumbers(catalogue, [record]);
  if (numbers.verdict === "conflict") {
    // "Module I" against "Module II", or "100 -" against "200 -". Two
    // certifications that differ only by number are exactly the pair a token
    // comparison scores highest and a human would never confuse.
    return {
      template,
      score: 0,
      confidence: "low",
      reasons: [
        `Numbers disagree: EP says ${numbers.certOnly.join(", ")}, ` +
          `the record says ${numbers.fileOnly.join(", ")}`,
      ],
    };
  }

  const catalogueSide = tokenOverlap(catalogue, record);
  const recordSide = tokenOverlap(record, catalogue);
  let score = combinedCoverage(catalogueSide.ratio, recordSide.ratio);

  if (catalogueSide.missing.length === 0 && catalogueSide.shared.length > 0) {
    reasons.push(
      recordSide.missing.length === 0
        ? `Every word of "${catalogue}" appears in the record name`
        : `Every word of "${catalogue}" appears in the record, which also says ` +
          `"${recordSide.missing.slice(0, 3).join('", "')}"`,
    );
  } else if (catalogueSide.shared.length > 0) {
    reasons.push(
      `Shares "${catalogueSide.shared.slice(0, 3).join('", "')}" but not ` +
        `"${catalogueSide.missing.slice(0, 3).join('", "')}"`,
    );
  }

  if (numbers.verdict === "agree" && numbers.shared.length > 0) {
    // A shared catalogue number is strong evidence - EP's numbering is its own
    // and a BambooHR record repeating it did not do so by chance.
    score = Math.min(1, score + 0.15);
    reasons.push(`Both say ${numbers.shared.join(", ")}`);
  }

  // An exact name, once the bracketed source tag is discounted, is as good as
  // this gets - but only when there is something left to compare. Names made
  // entirely of stop words ("Training", "Certification") both normalise to
  // nothing, and treating two nothings as identical awards a perfect score to
  // a pair that shares no word at all.
  const normalised = normalisedName(record);
  if (normalised !== "" && normalised === normalisedName(catalogue)) {
    score = 1;
    reasons.length = 0;
    reasons.push("Names are identical");
  }

  return { template, score, confidence: confidenceOf(score), reasons };
}

function normalisedName(value: string): string {
  return [...tokenize(value)].sort().join(" ");
}

function confidenceOf(score: number): EpMatchConfidence {
  if (score >= AUTO_CONFIRM_SCORE) return "high";
  return score >= TRIAGE_FLOOR ? "medium" : "low";
}

export function rankTemplates(
  recordName: string,
  templates: readonly EpTemplate[],
): EpTemplateMatch[] {
  return templates
    .map((template) => scoreTemplate(recordName, template))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES);
}

export interface BuildEpPlanInput {
  entries: readonly ManifestEntry[];
  templates: readonly EpTemplate[];
  /** What EP already holds for this member. */
  existing: readonly EpUserCertification[];
  decisions?: EpDecisions;
}

export function buildEpPlan(input: BuildEpPlanInput): EpPlan {
  const decisions = input.decisions ?? {};
  const byTemplateId = new Map(input.templates.map((t) => [t.id, t]));
  const items: EpPlanItem[] = [];
  const catalogueRequests: string[] = [];
  /**
   * Templates this plan has already decided to upload, and where.
   *
   * The EP snapshot says what was there before this run; it cannot say what
   * this run has queued. BambooHR concatenates the certifications table and
   * the training list, so one real certification often appears in both - and
   * without this, each copy checks the same untouched snapshot, finds nothing,
   * and both are uploaded.
   */
  const queued = new Map<string, number>();

  for (const entry of input.entries) {
    // A certifications row with no id of its own is keyed by where it sat in
    // BambooHR's response. Reorder the rows and that key names a different
    // certification - so honouring a remembered decision under it could skip a
    // credential the member never skipped, or file one under the template that
    // previously occupied the slot. Part 1 learned this the hard way; the rule
    // is shared rather than restated.
    const decision = isStableKey(entry.key) ? decisions[entry.key] : undefined;
    const candidates = rankTemplates(entry.name, input.templates);

    if (decision?.kind === "skip") {
      items.push(
        item(entry, "skipped", null, candidates, null, "You marked this as not tracked by LC-CFRS."),
      );
      continue;
    }

    if (decision?.kind === "request") {
      // Without the tag: this list becomes an email to the training captain
      // naming certifications to add, and "[TS] " is BambooHR's own bookkeeping
      // - meaningless to the reader, and enough to make one certification look
      // like two.
      const requested = withoutSourcePrefix(entry.name);
      if (!catalogueRequests.includes(requested)) catalogueRequests.push(requested);
      items.push(
        item(entry, "requested", null, candidates, null, "Queued to request as a new EP category."),
      );
      continue;
    }

    const chosen =
      decision?.kind === "template"
        ? (byTemplateId.get(decision.templateId) ?? null)
        : bestAutomatic(candidates);

    if (!chosen) {
      items.push(
        item(
          entry,
          "needsTriage",
          null,
          candidates,
          null,
          candidates.length > 0
            ? "No confident match. Pick one below, request it as a new category, or mark it as not tracked."
            : "Nothing in EP's catalogue resembles this. Request it, or mark it as not tracked.",
        ),
      );
      continue;
    }

    // Dedupe AFTER a template is settled: "already there" is a statement about
    // the catalogue entry, and asking it of an unmatched record is meaningless.
    //
    // The newest row wins the comparison. EP can hold several rows for one
    // certification - a member recertifies - and checking against an older one
    // would call a genuine renewal a duplicate.
    const already = newestFor(input.existing, chosen.id);
    if (already && !isRenewalOf(entry, already)) {
      const outcome = already.importedFrom ? "importedByTargetSolutions" : "alreadyInEp";
      items.push(
        item(
          entry,
          outcome,
          chosen,
          candidates,
          already,
          already.importedFrom
            ? `Already in EP, imported from ${already.importedFrom}. The General Order says not to re-upload these.`
            : "Already on your EP profile.",
        ),
      );
      continue;
    }

    // EP requires a completion date, so there is nothing to submit without one
    // - and the date is not this tool's to invent for the system of record.
    // Triage would be the wrong place for it: none of the three answers there
    // (pick a template, request one, mark it out of scope) fixes a missing
    // date. The record has to be corrected in BambooHR first.
    if (!entry.completed) {
      items.push(
        item(
          entry,
          "noCompletionDate",
          chosen,
          candidates,
          already,
          "This record has no completion date, and Essential Personnel requires one. " +
            "Add the date in BambooHR and run the export again.",
        ),
      );
      continue;
    }

    if (!entry.file) {
      // The General Order permits a full official transcript here, and
      // explicitly refuses partial transcripts or single pages. That is an
      // errand for a person, not something to attempt.
      items.push(
        item(
          entry,
          "noFile",
          chosen,
          candidates,
          null,
          "No certificate file was found for this record. A full official transcript may be submitted instead - partial transcripts are not accepted.",
        ),
      );
      continue;
    }

    const previous = queued.get(chosen.id);
    if (previous !== undefined) {
      // Two records for one certification. The later sitting is the one worth
      // having in the system of record; the other is the same credential
      // recorded twice in BambooHR, and uploading both would put two copies on
      // the profile.
      const earlier = items[previous]!;
      const supersedes = (entry.completed ?? "") > (earlier.entry.completed ?? "");
      const loser = supersedes ? earlier : null;
      if (loser) {
        items[previous] = {
          ...earlier,
          outcome: "duplicateInPlan",
          explanation:
            `Also recorded as "${entry.name}", completed ${entry.completed}, ` +
            "which is the one being uploaded.",
        };
      } else {
        items.push(
          item(
            entry,
            "duplicateInPlan",
            chosen,
            candidates,
            already,
            `Already covered by "${earlier.entry.name}", completed ` +
              `${earlier.entry.completed}, which is the one being uploaded.`,
          ),
        );
        continue;
      }
    }

    queued.set(chosen.id, items.length);
    items.push(
      item(
        entry,
        "ready",
        chosen,
        candidates,
        already,
        already
          ? `Renews the ${already.completed} record already in EP. ` +
            reasonFor(chosen, candidates)
          : reasonFor(chosen, candidates),
      ),
    );
  }

  return { items, catalogueRequests };
}


/** The most recently completed EP row for a template, if there is one. */
function newestFor(
  existing: readonly EpUserCertification[],
  templateId: string,
): EpUserCertification | null {
  const rows = existing.filter((row) => row.templateId === templateId);
  if (rows.length === 0) return null;
  return rows.reduce((newest, row) =>
    (row.completed ?? "") > (newest.completed ?? "") ? row : newest,
  );
}

/**
 * Is this record a later sitting of what EP already holds?
 *
 * Certifications expire and are retaken. Treating every row with the same
 * template as "already there" leaves the system of record showing an expired
 * credential while the member holds a current one - precisely what the General
 * Order exists to prevent.
 *
 * Both dates must be known: with no evidence of a renewal, assuming one would
 * upload a second copy of something already present.
 */
function isRenewalOf(entry: ManifestEntry, existing: EpUserCertification): boolean {
  if (!entry.completed || !existing.completed) return false;
  return entry.completed > existing.completed;
}

/**
 * Only a high-confidence match is proposed without being asked for, and only
 * when it is clearly ahead of the runner-up. Two catalogue entries scoring
 * alike means the name does not distinguish them, and picking the first is a
 * coin toss dressed up as a decision.
 */
function bestAutomatic(candidates: readonly EpTemplateMatch[]): EpTemplate | null {
  const [best, next] = candidates;
  if (!best || best.confidence !== "high") return null;
  if (next && best.score - next.score < 0.1) return null;
  return best.template;
}

function reasonFor(chosen: EpTemplate, candidates: readonly EpTemplateMatch[]): string {
  const match = candidates.find((c) => c.template.id === chosen.id);
  return match ? match.reasons.join(". ") : "Chosen by you.";
}

function item(
  entry: ManifestEntry,
  outcome: EpOutcome,
  template: EpTemplate | null,
  candidates: EpTemplateMatch[],
  existing: EpUserCertification | null,
  explanation: string,
): EpPlanItem {
  return { entry, outcome, template, candidates, existing, explanation };
}

/** What a single upload sends. Assembled here so the shape is testable. */
export interface EpSubmission {
  templateId: string;
  /**
   * EP stores this as `year`, despite it being a full date, and requires it.
   * Non-null by construction: a record without one never reaches "ready".
   */
  completed: string;
  expires: string | null;
  /** EP stores this as `school`. */
  institution: string | null;
  /** Filename in the export folder, relative to the manifest. */
  savedAs: string;
}

export function submissionFor(item: EpPlanItem): EpSubmission | null {
  // `completed` is checked again rather than assumed from the outcome: this
  // function builds what is actually sent, and EP rejects a create with no
  // date. A guard at the point of use costs nothing and does not depend on
  // the planner and the submitter agreeing forever.
  if (item.outcome !== "ready" || !item.template || !item.entry.file || !item.entry.completed) {
    return null;
  }
  return {
    templateId: item.template.id,
    completed: item.entry.completed,
    // A derived expiry is this app's arithmetic, not something an issuer
    // stated. Writing it into the system of record would launder a guess into
    // a fact, and EP treats a blank as "never" rather than "unknown".
    expires: item.entry.expiresDerived ? null : item.entry.expires,
    institution: item.entry.instructor,
    savedAs: item.entry.file.savedAs,
  };
}
