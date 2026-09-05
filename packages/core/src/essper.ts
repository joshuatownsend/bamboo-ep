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
 * settle on its own. Held for one run only - see `EpDecisions`.
 *
 * The two fields are answers to two independent questions, and a record can
 * need both, so a caller updating one must preserve the other.
 */
export interface EpDecision {
  /**
   * What to do with the record. Absent means the member has not said.
   *
   * Separate from `expiry` because a record can need both: a certification the
   * matcher could not place, whose expiry was also calculated, needs a
   * template AND an expiry. Sharing one slot meant answering the second
   * question erased the answer to the first.
   */
  handling?:
    | { kind: "template"; templateId: string }
    | { kind: "skip"; note?: string }
    | { kind: "request" };

  /**
   * The expiry to submit for a record whose expiry Part 1 calculated rather
   * than read. `expires: null` means the member is asserting the certification
   * does not expire, which is what Essential Personnel stores a blank as.
   */
  expiry?: { expires: string | null };
}

/**
 * A change to ONE of the two answers a record can carry.
 *
 * `null` for a field clears just that field; an absent field is left alone.
 * The distinction matters: "the member took back their template choice" and
 * "this update is not about the template" are different instructions.
 */
export interface EpDecisionPatch {
  handling?: EpDecision["handling"] | null;
  expiry?: EpDecision["expiry"] | null;
}

/**
 * Apply one patch to a record's answer, returning what to store - or `null`
 * when nothing is left to remember.
 *
 * Lives here rather than in the screen because it is what keeps `EpDecision`'s
 * two fields independent, which is the whole reason they are two fields. The
 * screen used to replace the object wholesale, so answering the second
 * question erased the first: a record needing both a template and an expiry
 * bounced between the two buckets forever and could never be made ready.
 */
export function applyDecisionPatch(
  existing: EpDecision | undefined,
  patch: EpDecisionPatch,
): EpDecision | null {
  const merged: EpDecision = { ...existing };

  // Only `null` clears. `undefined` means "this update is not about that
  // field" - the same as leaving it out - because an optional field is
  // routinely undefined by accident, and reading that as "erase the member's
  // answer" makes a typo destructive.
  if (patch.handling !== undefined) {
    if (patch.handling === null) delete merged.handling;
    else merged.handling = patch.handling;
  }
  if (patch.expiry !== undefined) {
    // `{ expires: null }` is the member asserting the certification does not
    // expire. That is an answer, not the absence of one, and must not be
    // mistaken for a clear - which is why only `null` itself clears.
    if (patch.expiry === null) delete merged.expiry;
    else merged.expiry = patch.expiry;
  }

  // An empty decision and no decision mean the same thing; keeping one would
  // make "has the member answered?" two questions instead of one.
  return merged.handling || merged.expiry ? merged : null;
}

/**
 * Keyed by `ManifestEntry.key`, and held for one run only.
 *
 * Nothing here is written to disk, which settles a question review raised
 * twice: an answer given about a record BambooHR gave no id to is keyed by
 * that record's POSITION in the response, and would name a different
 * certification on the next run. Since the member answers while looking at the
 * list and submits once, there is nothing to gain by remembering. If that ever
 * changes, only keys passing `isStableKey` may be saved.
 */
export type EpDecisions = Readonly<Record<string, EpDecision>>;

export type EpOutcome =
  | "ready"
  | "alreadyInEp"
  | "importedByTargetSolutions"
  | "needsTriage"
  | "expiryNotStated"
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
  /**
   * The expiry the member settled, for a record whose expiry was calculated.
   *
   * Carried here rather than passed to `submissionFor` separately, so the
   * value that was checked is the value that gets sent.
   */
  expiry: { expires: string | null } | null;
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

/**
 * Score a record against one template.
 *
 * EP exposes some entries under an abbreviation as well as a name, and the
 * two can be quite different - a record reading "CPR" shares no word with an
 * expanded catalogue name, so comparing the name alone dropped the right
 * template out of the candidate list entirely. Both spellings are tried and
 * the better one stands, since either is a legitimate way to name the same
 * certification.
 */
export function scoreTemplate(recordName: string, template: EpTemplate): EpTemplateMatch {
  const spellings = [template.name, template.abbreviation]
    .map((value) => value?.trim())
    .filter((value): value is string => !!value);
  const unique = [...new Set(spellings)];

  const scored = (unique.length > 0 ? unique : [template.name.trim()]).map((spelling) =>
    scoreAgainst(recordName, template, spelling),
  );
  return scored.reduce((best, match) => (match.score > best.score ? match : best));
}

function scoreAgainst(
  recordName: string,
  template: EpTemplate,
  catalogue: string,
): EpTemplateMatch {
  const reasons: string[] = [];
  const record = withoutSourcePrefix(recordName);

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
  const catalogueRequests: string[] = [];

  // Settled first, for every record, before anything is compared. Which
  // certification a record IS has to be known before which of several records
  // is the current one can be asked.
  const resolved = input.entries.map((entry) => {
    // A certifications row with no id of its own is keyed by where it sat in
    // BambooHR's response. Reorder the rows and that key names a different
    // certification - so honouring a remembered decision under it could skip a
    // credential the member never skipped, or file one under the template that
    // previously occupied the slot. Part 1 learned this the hard way; the rule
    // is shared rather than restated.
    // Every decision is honoured, positional keys included.
    //
    // `isStableKey` guards REMEMBERING an answer across runs: a key like
    // `certifications:row-3` names whatever drifted into that slot, so a saved
    // answer could silently skip a credential the member never skipped. That
    // hazard is entirely cross-run. These decisions are held in memory for one
    // run, made against the very manifest this plan is built from, and the
    // screen holding them unmounts when the member leaves - so within one plan
    // build `row-3` names exactly one entry. Applying the guard here instead
    // meant a member could pick a template, request a category or skip a row
    // without an id, and watch nothing happen.
    //
    // The rule still stands at the boundary it was written for: see
    // `EpDecisions`. Nothing may be written to disk unless its key passes
    // `isStableKey`.
    const decision = decisions[entry.key];
    const handling = decision?.handling;
    const candidates = rankTemplates(entry.name, input.templates);

    if (handling?.kind === "skip") {
      return settled(entry, candidates, "skipped", null, "You marked this as not tracked by LC-CFRS.");
    }

    if (handling?.kind === "request") {
      // Without the tag: this list becomes an email to the training captain
      // naming certifications to add, and "[TS] " is BambooHR's own bookkeeping
      // - meaningless to the reader, and enough to make one certification look
      // like two.
      const requested = withoutSourcePrefix(entry.name);
      if (!catalogueRequests.includes(requested)) catalogueRequests.push(requested);
      return settled(entry, candidates, "requested", null, "Queued to request as a new EP category.");
    }

    const chosen =
      handling?.kind === "template"
        ? (byTemplateId.get(handling.templateId) ?? null)
        : bestAutomatic(candidates);

    if (!chosen) {
      return settled(
        entry,
        candidates,
        "needsTriage",
        null,
        candidates.length > 0
          ? "No confident match. Pick one below, request it as a new category, or mark it as not tracked."
          : "Nothing in EP's catalogue resembles this. Request it, or mark it as not tracked.",
      );
    }

    return { entry, candidates, chosen, outcome: null as EpOutcome | null, explanation: "" };
  });

  // Which record is the current sitting of each certification.
  //
  // BambooHR concatenates the certifications table and the training list, so
  // one real certification often appears in both. This is decided ONCE, for
  // every competing record at the same time, using the same measure of
  // currency that EP's own rows are ranked by. Deciding it pairwise as records
  // streamed past was how a stale row kept winning: each comparison was
  // locally reasonable and the set as a whole was not.
  const currentFor = new Map<string, number>();
  resolved.forEach((row, index) => {
    if (!row.chosen || row.outcome) return;
    const held = currentFor.get(row.chosen.id);
    // Strictly better, so the order records arrive in does not change the
    // answer.
    if (held === undefined || compareEntries(row.entry, resolved[held]!.entry) > 0) {
      currentFor.set(row.chosen.id, index);
    }
  });

  const items: EpPlanItem[] = resolved.map((row, index) => {
    if (!row.chosen || row.outcome) {
      return item(row.entry, row.outcome ?? "needsTriage", null, row.candidates, null, row.explanation);
    }

    const current = currentFor.get(row.chosen.id);
    if (current !== index) {
      // Superseded by another BambooHR record for the same certification. Note
      // that this applies even when the current one turns out to have no file:
      // uploading the older certificate would put a stale document on the
      // profile as though it were the credential in force.
      const winner = resolved[current!]!.entry;
      return item(
        row.entry,
        "duplicateInPlan",
        row.chosen,
        row.candidates,
        null,
        `Superseded by "${winner.name}", completed ${winner.completed ?? "an unknown date"}.`,
      );
    }

    // "Already there" is a statement about the catalogue entry, so it is only
    // meaningful once a template is settled.
    const already = newestFor(input.existing, row.chosen.id);
    const settledExpiry = decisions[row.entry.key]?.expiry ?? null;

    // An unconfirmed calculated expiry can leave "already held" undecidable.
    //
    // `sittingOfEntry` discards a derived expiry - rightly, since this app's
    // arithmetic is not evidence - so a record whose calculated expiry runs
    // past EP's ranked as no newer and was reported as already on the profile.
    // Only `expiryNotStated` rows offer the confirm buttons, so the member
    // could never supply the date that would have made it a renewal: the
    // outcome foreclosed the question whose answer decides the outcome.
    //
    // So the already-held verdict is withheld while confirming could overturn
    // it, and the record carries on to the expiry question below. Below, not
    // here, because a record with no file or no completion date cannot be
    // submitted whatever its expiry - asking first would be noise in place of
    // the answer the member can actually act on.
    //
    // Judged at its best case: if EP's row covers this sitting even taking
    // BambooHR's calculated date at face value, nothing is in question, and a
    // member re-running after an upload is not interrogated about a record
    // already safely filed.
    const confirmingCouldOverturnIt =
      row.entry.expiresDerived &&
      row.entry.expires !== null &&
      settledExpiry === null &&
      (!already || isRenewalOf(row.entry, already, { expires: row.entry.expires }));

    if (already && !confirmingCouldOverturnIt && !isRenewalOf(row.entry, already, settledExpiry)) {
      return item(
        row.entry,
        already.importedFrom ? "importedByTargetSolutions" : "alreadyInEp",
        row.chosen,
        row.candidates,
        already,
        already.importedFrom
          ? `Already in EP, imported from ${already.importedFrom}. The General Order says not to re-upload these.`
          : "Already on your EP profile.",
        // The member's expiry answer travels with the row even though this
        // outcome does not submit anything. Answering "does not expire" is
        // what lands a record here, and the screen renders its Change control
        // from `item.expiry` - so dropping it here left the answer stored,
        // unshown, and impossible to take back.
        settledExpiry,
      );
    }

    // EP requires a completion date, so there is nothing to submit without one
    // - and the date is not this tool's to invent for the system of record.
    // Triage would be the wrong home for it: none of its three answers fixes a
    // missing date. The record has to be corrected in BambooHR first.
    if (!row.entry.completed) {
      return item(
        row.entry,
        "noCompletionDate",
        row.chosen,
        row.candidates,
        already,
        "This record has no completion date, and Essential Personnel requires one. " +
          "Add the date in BambooHR and run the export again.",
      );
    }

    if (!row.entry.file) {
      // The General Order permits a full official transcript here, and
      // explicitly refuses partial transcripts or single pages. That is an
      // errand for a person, not something to attempt.
      return item(
        row.entry,
        "noFile",
        row.chosen,
        row.candidates,
        already,
        "No certificate file was found for this record. A full official transcript may be " +
          "submitted instead - partial transcripts are not accepted.",
      );
    }

    // Part 1 calculates an expiry from the training type's renewal frequency
    // when BambooHR states none. Neither way of submitting one is safe:
    //
    //   - Sending the date writes this app's arithmetic into the system of
    //     record as though an issuer had stated it.
    //   - Sending nothing is WORSE. Essential Personnel reads a blank expiry
    //     as "never expires", so a renewable credential would be recorded as
    //     permanently valid.
    //
    // So the record is held, and the member settles it. The mechanism for
    // them to answer belongs with the review screen that will ask the
    // question - designing it here, with nothing to design it against, is
    // what this outcome deliberately defers.
    // Reached either because EP holds nothing for this certification, or
    // because the already-held verdict above was withheld pending this answer.
    if (row.entry.expiresDerived && row.entry.expires && !settledExpiry) {
      return item(
        row.entry,
        "expiryNotStated",
        row.chosen,
        row.candidates,
        already,
        `BambooHR does not record an expiry for this. ${row.entry.expires} is calculated ` +
          "from the renewal frequency, so it needs confirming before it can be submitted - " +
          "Essential Personnel treats a blank expiry as never expiring.",
      );
    }

    return item(
      row.entry,
      "ready",
      row.chosen,
      row.candidates,
      already,
      already
        ? `Renews the ${already.completed} record already in EP. ` +
          reasonFor(row.chosen, row.candidates)
        : reasonFor(row.chosen, row.candidates),
      settledExpiry,
    );
  });

  return { items, catalogueRequests };
}

function settled(
  entry: ManifestEntry,
  candidates: EpTemplateMatch[],
  outcome: EpOutcome,
  chosen: EpTemplate | null,
  explanation: string,
) {
  return { entry, candidates, chosen, outcome, explanation };
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
  expiry: { expires: string | null } | null = null,
): EpPlanItem {
  return { entry, outcome, template, candidates, existing, explanation, expiry };
}

/**
 * One sitting of a certification, reduced to what decides how current it is.
 */
interface Sitting {
  completed: string | null;
  /** Only a date an issuer stated. See `sittingOfEntry`. */
  expires: string | null;
}

/**
 * The single measure this file ranks everything by: Essential Personnel's own
 * rows, BambooHR's records, and two BambooHR records competing with each
 * other. Five review rounds found the same class of mistake in three separate
 * comparisons - each locally reasonable, none agreeing with the others - which
 * is what a rule implemented three times buys you.
 *
 * Completion date first, then expiry. Successive extensions of one licence all
 * carry the SAME completion date, so completion alone leaves them tied and
 * keeps whichever happened to come first, possibly the one that expired years
 * ago. Comparing the pair in that order also refuses the inverse: an older
 * record that runs longer is not more current than a later sitting, because
 * completion decides before expiry is ever reached.
 *
 * Compared field by field rather than as one joined string. The joined version
 * was shorter and quietly wrong - the separator sorted above digits, so a
 * record with no expiry outranked one that had a real expiry, and a test
 * caught it only because an unrelated key was appended later.
 */
function compareSittings(a: Sitting, b: Sitting): number {
  const byCompleted = compareDays(a.completed, b.completed);
  return byCompleted !== 0 ? byCompleted : compareDays(a.expires, b.expires);
}

/** An unknown date is never more current than a stated one. */
function compareDays(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  return a < b ? -1 : 1;
}

function sittingOf(row: EpUserCertification): Sitting {
  return { completed: row.completed, expires: row.expires };
}

/**
 * A derived expiry is Part 1's arithmetic, not a date an issuer stated, and it
 * is left out entirely. Counting it would let this app's own guess decide
 * which of two real records is the current one.
 */
function sittingOfEntry(entry: ManifestEntry): Sitting {
  return {
    completed: entry.completed,
    expires: entry.expiresDerived ? null : entry.expires,
  };
}

/**
 * How two BambooHR records for one certification are ranked against each other.
 *
 * Currency first, then whether the record actually has a certificate. The
 * second key only ever breaks a tie - a file can never make a stale record
 * beat a current one - but when two records describe the very same sitting, as
 * the certifications table and the training list routinely do, only one of
 * them was given the file during the export. Preferring the empty one reports
 * "no certificate found" while the certificate sits on the record beside it.
 *
 * Deliberately not part of `compareSittings`, which also compares against
 * Essential Personnel's rows. Those carry no such flag, so including it there
 * would make every record with a file look newer than what EP already holds.
 */
function compareEntries(a: ManifestEntry, b: ManifestEntry): number {
  const bySitting = compareSittings(sittingOfEntry(a), sittingOfEntry(b));
  if (bySitting !== 0) return bySitting;
  return Number(!!a.file) - Number(!!b.file);
}

/** The most current EP row for a template, if there is one. */
function newestFor(
  existing: readonly EpUserCertification[],
  templateId: string,
): EpUserCertification | null {
  const rows = existing.filter((row) => row.templateId === templateId);
  if (rows.length === 0) return null;
  return rows.reduce((newest, row) =>
    compareSittings(sittingOf(row), sittingOf(newest)) > 0 ? row : newest,
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
function isRenewalOf(
  entry: ManifestEntry,
  existing: EpUserCertification,
  /**
   * A confirmed expiry stops being a calculation and becomes the member's
   * word, so it counts here. Without it, confirming a later expiry changed
   * nothing: the record was still reported as already held.
   */
  settled: { expires: string | null } | null = null,
): boolean {
  // Both completion dates must be known. Without them there is no evidence of
  // a renewal, and inventing one uploads a second copy of something already
  // present.
  if (!entry.completed || !existing.completed) return false;
  // A confirmed "does not expire" is left as unknown rather than read as the
  // furthest-off date. It may well be the more current answer, but uploading
  // over something EP already holds on the strength of an ABSENCE is the wrong
  // way round; the completion-date comparison still catches a real renewal.
  const sitting = settled
    ? { completed: entry.completed, expires: settled.expires }
    : sittingOfEntry(entry);
  return compareSittings(sitting, sittingOf(existing)) > 0;
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
  // Checked here as well as in the planner, because this function decides what
  // is actually sent and "never expires" is not a value to arrive at by
  // omission.
  if (item.entry.expiresDerived && item.entry.expires && !item.expiry) return null;
  return {
    templateId: item.template.id,
    completed: item.entry.completed,
    // A calculated expiry only reaches here once the member has settled it, so
    // the date is either theirs or BambooHR's own.
    expires: item.entry.expiresDerived ? (item.expiry?.expires ?? null) : item.entry.expires,
    // Deliberately not `entry.instructor`. Essential Personnel labels this
    // field "Institution Name", and BambooHR's instructor is a person - "Jane
    // Smith" is not the body that issued a certification. What belongs here is
    // still an open question in docs/part-2-plan.md, and writing a name into
    // the system of record while it is open would answer it wrongly.
    institution: null,
    savedAs: item.entry.file.savedAs,
  };
}
