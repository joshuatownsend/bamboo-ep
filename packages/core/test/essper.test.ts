import { describe, expect, it } from "vitest";
import {
  applyDecisionPatch,
  buildEpPlan,
  rankTemplates,
  scoreTemplate,
  submissionFor,
  type EpTemplate,
  type EpUserCertification,
} from "../src/essper.js";
import type { ManifestEntry } from "../src/manifest.js";

/**
 * Real entries from the LC-CFRS catalogue, chosen because they are the ones
 * that can be confused with each other.
 */
const CATALOGUE: EpTemplate[] = [
  { id: "t-metro-100", name: "100 - Metrorail System Basics", abbreviation: null },
  {
    id: "t-metro-200",
    name: "200 - Scene Safety Procedures at Metrorail Incidents",
    abbreviation: null,
  },
  { id: "t-metro-evac", name: "Evacuation of Metrorail Cars and Stations", abbreviation: null },
  { id: "t-tr-1", name: "Introduction to Technical Rescue Module I", abbreviation: null },
  { id: "t-tr-2", name: "Introduction to Technical Rescue Module II", abbreviation: null },
  { id: "t-cpr", name: "CPR", abbreviation: null },
  { id: "t-cpr-hcp", name: "HealthCare Provider CPR", abbreviation: null },
  { id: "t-forklift", name: "Forklift Telehandler (OSHA/LCCFRS)", abbreviation: null },
];

function entry(over: Partial<ManifestEntry> = {}): ManifestEntry {
  return {
    key: "training:1",
    recordId: "1",
    source: "training",
    name: "[TS] Metro 100 - Metrorail System Basics",
    nameSource: "trainingType",
    category: null,
    completed: "2018-04-15",
    expires: null,
    expiresDerived: false,
    instructor: "Washington Metropolitan Area Transit Authority",
    certificationNumber: null,
    notes: null,
    file: {
      bambooFileId: "9",
      savedAs: "[TS] Metro 100 - Metrorail System Basics - 2018-04-15.pdf",
      originalFileName: "metro100.pdf",
      categoryName: "Training Docs",
      bytes: 110202,
      sha256: "abc",
      contentType: "application/pdf",
      matchedBy: "heuristic",
      matchScore: 0.9,
    },
    verification: null,
    ...over,
  } as ManifestEntry;
}

const noExisting: EpUserCertification[] = [];

describe("scoring a record against EP's catalogue", () => {
  it("confidently matches a record that differs only by BambooHR's own labelling", () => {
    // "[TS] Metro 100 - Metrorail System Basics" against EP's "100 - Metrorail
    // System Basics". The source tag is stripped; the stray "Metro" is a real
    // extra word and costs a little, which is the honest answer rather than a
    // perfect score.
    const match = scoreTemplate("[TS] Metro 100 - Metrorail System Basics", CATALOGUE[0]!);
    expect(match.confidence).toBe("high");
    expect(match.score).toBeGreaterThan(0.95);
  });

  it("still matches when the record omits EP's catalogue number", () => {
    const match = scoreTemplate("Metrorail System Basics", CATALOGUE[0]!);
    expect(match.confidence).toBe("high");
  });

  it("scores a vaguer catalogue entry well below the specific one", () => {
    // EP holds both "CPR" and "HealthCare Provider CPR". Every word of the
    // bare "CPR" appears in the specific record, so coverage in that one
    // direction is perfect - filing the member under the vaguer certification
    // they did not take is a quiet form of the wrong answer.
    const specific = scoreTemplate("HealthCare Provider CPR", CATALOGUE[6]!);
    const vague = scoreTemplate("HealthCare Provider CPR", CATALOGUE[5]!);
    expect(specific.score).toBe(1);
    expect(vague.confidence).toBe("low");
  });

  /**
   * The pair the whole design is afraid of. These two share every meaningful
   * word - "Metrorail", "Scene", "Safety" aside - and differ only in a leading
   * catalogue number. A token comparison alone ranks them almost equally.
   */
  it("refuses a template whose catalogue number contradicts the record", () => {
    const match = scoreTemplate("[TS] Metro 200 - Scene Safety Procedures", CATALOGUE[0]!);
    expect(match.score).toBe(0);
    expect(match.reasons.join(" ")).toMatch(/numbers disagree/i);
  });

  it("keeps Module I and Module II apart", () => {
    const one = scoreTemplate("[SWP] Intro to Technical Rescue Module 1", CATALOGUE[3]!);
    const two = scoreTemplate("[SWP] Intro to Technical Rescue Module 1", CATALOGUE[4]!);
    expect(one.score).toBeGreaterThan(0);
    expect(two.score).toBe(0);
  });

  it("ranks the more specific CPR entry above the bare one when the record is specific", () => {
    const ranked = rankTemplates("HealthCare Provider CPR", CATALOGUE);
    expect(ranked[0]!.template.id).toBe("t-cpr-hcp");
  });
});

describe("building the upload plan", () => {
  it("proposes an upload when the match is unambiguous and EP lacks it", () => {
    const plan = buildEpPlan({ entries: [entry()], templates: CATALOGUE, existing: noExisting });
    expect(plan.items[0]!.outcome).toBe("ready");
    expect(plan.items[0]!.template!.id).toBe("t-metro-100");
  });

  it("does not propose anything when two templates score alike", () => {
    // A record naming neither number matches both Metrorail entries about
    // equally. Picking the first would be a coin toss presented as a decision.
    const plan = buildEpPlan({
      entries: [entry({ name: "Metrorail" })],
      templates: CATALOGUE,
      existing: noExisting,
    });
    expect(plan.items[0]!.outcome).toBe("needsTriage");
    expect(plan.items[0]!.template).toBeNull();
  });

  it("skips a certification EP already holds", () => {
    const plan = buildEpPlan({
      entries: [entry()],
      templates: CATALOGUE,
      existing: [
        {
          id: "u1",
          templateId: "t-metro-100",
          completed: "2018-04-15",
          expires: null,
          institution: null,
          documentUrl: null,
          importedFrom: null,
        },
      ],
    });
    expect(plan.items[0]!.outcome).toBe("alreadyInEp");
  });

  /**
   * The General Order is explicit that Vector/Target Solutions imports must not
   * be re-uploaded, and says so as a rule about their ORIGIN rather than their
   * name - which is why the plan reads `importedFrom` rather than guessing.
   */
  it("names Target Solutions as the reason when the row was imported", () => {
    const plan = buildEpPlan({
      entries: [entry()],
      templates: CATALOGUE,
      existing: [
        {
          id: "u1",
          templateId: "t-metro-100",
          completed: "2018-04-15",
          expires: null,
          institution: "Imported from Target Solutions",
          documentUrl: null,
          importedFrom: "targetSolutions",
        },
      ],
    });
    expect(plan.items[0]!.outcome).toBe("importedByTargetSolutions");
    expect(plan.items[0]!.explanation).toMatch(/not to re-upload/i);
  });

  it("cannot upload a record with no certificate, and says what may be sent instead", () => {
    const plan = buildEpPlan({
      entries: [entry({ file: null })],
      templates: CATALOGUE,
      existing: noExisting,
    });
    expect(plan.items[0]!.outcome).toBe("noFile");
    expect(plan.items[0]!.explanation).toMatch(/full official transcript/i);
    expect(plan.items[0]!.explanation).toMatch(/partial transcripts are not accepted/i);
  });
});

describe("decisions the member has already made", () => {
  it("never re-asks about something marked as not tracked by LC-CFRS", () => {
    // Volunteer Recruit School is the real case: AVFRD runs it, LC-CFRS does
    // not track it, and it will never be an EP category.
    const vrs = entry({ key: "training:vrs", name: "Volunteer Recruit School" });
    const plan = buildEpPlan({
      entries: [vrs],
      templates: CATALOGUE,
      existing: noExisting,
      decisions: { "training:vrs": { handling: { kind: "skip" } } },
    });
    expect(plan.items[0]!.outcome).toBe("skipped");
    expect(plan.catalogueRequests).toEqual([]);
  });

  it("collects requested names for the email the General Order asks for", () => {
    const plan = buildEpPlan({
      entries: [entry({ key: "training:vrs", name: "Volunteer Recruit School" })],
      templates: CATALOGUE,
      existing: noExisting,
      decisions: { "training:vrs": { handling: { kind: "request" } } },
    });
    expect(plan.catalogueRequests).toEqual(["Volunteer Recruit School"]);
  });

  it("honours a template the member picked by hand over the matcher's opinion", () => {
    const plan = buildEpPlan({
      entries: [entry({ name: "Something the matcher cannot place" })],
      templates: CATALOGUE,
      existing: noExisting,
      decisions: { "training:1": { handling: { kind: "template", templateId: "t-forklift" } } },
    });
    expect(plan.items[0]!.outcome).toBe("ready");
    expect(plan.items[0]!.template!.id).toBe("t-forklift");
  });

  it("falls back to triage when a remembered template no longer exists", () => {
    // Catalogue entries can be renamed or removed by EP administrators. A
    // decision pointing at a template that is gone must not silently become
    // "no template" on an upload that still goes ahead.
    const plan = buildEpPlan({
      entries: [entry()],
      templates: CATALOGUE,
      existing: noExisting,
      decisions: { "training:1": { handling: { kind: "template", templateId: "t-deleted" } } },
    });
    expect(plan.items[0]!.outcome).toBe("needsTriage");
  });
});

describe("renewals are not duplicates", () => {
  /**
   * Certifications expire and are retaken. Reported by review: an older CPR
   * row in EP made the member's renewed one look like a duplicate, leaving the
   * system of record showing an expired credential.
   */
  it("uploads a record completed later than the one EP holds", () => {
    const plan = buildEpPlan({
      entries: [entry({ completed: "2024-06-01" })],
      templates: CATALOGUE,
      existing: [
        {
          id: "u1",
          templateId: "t-metro-100",
          completed: "2018-04-15",
          expires: null,
          institution: null,
          documentUrl: null,
          importedFrom: null,
        },
      ],
    });
    expect(plan.items[0]!.outcome).toBe("ready");
    expect(plan.items[0]!.explanation).toMatch(/renews the 2018-04-15 record/i);
  });

  it("compares against the newest row when EP holds several", () => {
    const row = (id: string, completed: string) => ({
      id,
      templateId: "t-metro-100",
      completed,
      expires: null,
      institution: null,
      documentUrl: null,
      importedFrom: null,
    });
    const plan = buildEpPlan({
      entries: [entry({ completed: "2020-01-01" })],
      templates: CATALOGUE,
      // The 2022 sitting is the current one; checking against the 2018 row
      // would call this stale record a renewal and upload it.
      existing: [row("u1", "2018-04-15"), row("u2", "2022-09-09")],
    });
    expect(plan.items[0]!.outcome).toBe("alreadyInEp");
  });

  it("does not invent a renewal when either date is unknown", () => {
    const plan = buildEpPlan({
      entries: [entry({ completed: null })],
      templates: CATALOGUE,
      existing: [
        {
          id: "u1",
          templateId: "t-metro-100",
          completed: null,
          expires: null,
          institution: null,
          documentUrl: null,
          importedFrom: null,
        },
      ],
    });
    expect(plan.items[0]!.outcome).toBe("alreadyInEp");
  });
});

describe("decisions keyed by a row's position", () => {
  /**
   * A certifications row with no id is keyed by where it sat in BambooHR's
   * response. Reorder the rows and the same key names a different
   * certification - so a remembered "skip" could silently drop a credential
   * the member never skipped. Part 1 has the same guard.
   */
  it("ignores a remembered skip on a positional key", () => {
    const plan = buildEpPlan({
      entries: [entry({ key: "certifications:row-0" })],
      templates: CATALOGUE,
      existing: noExisting,
      decisions: { "certifications:row-0": { handling: { kind: "skip" } } },
    });
    expect(plan.items[0]!.outcome).not.toBe("skipped");
  });

  it("ignores a remembered template on a positional key", () => {
    const plan = buildEpPlan({
      entries: [entry({ key: "certifications:row-3", name: "Unplaceable name" })],
      templates: CATALOGUE,
      existing: noExisting,
      decisions: { "certifications:row-3": { handling: { kind: "template", templateId: "t-forklift" } } },
    });
    expect(plan.items[0]!.template).toBeNull();
  });

  it("still honours a decision on a real certifications id", () => {
    const plan = buildEpPlan({
      entries: [entry({ key: "certifications:8821" })],
      templates: CATALOGUE,
      existing: noExisting,
      decisions: { "certifications:8821": { handling: { kind: "skip" } } },
    });
    expect(plan.items[0]!.outcome).toBe("skipped");
  });
});

describe("the catalogue request list", () => {
  it("drops BambooHR's source tag, which means nothing to the reader", () => {
    const plan = buildEpPlan({
      entries: [entry({ key: "training:vrs", name: "[SWP] Volunteer Recruit School" })],
      templates: CATALOGUE,
      existing: noExisting,
      decisions: { "training:vrs": { handling: { kind: "request" } } },
    });
    expect(plan.catalogueRequests).toEqual(["Volunteer Recruit School"]);
  });

  it("names a certification once even when two records ask for it", () => {
    const plan = buildEpPlan({
      entries: [
        entry({ key: "training:a", name: "[SWP] Volunteer Recruit School" }),
        entry({ key: "training:b", name: "Volunteer Recruit School" }),
      ],
      templates: CATALOGUE,
      existing: noExisting,
      decisions: {
        "training:a": { handling: { kind: "request" } },
        "training:b": { handling: { kind: "request" } },
      },
    });
    expect(plan.catalogueRequests).toEqual(["Volunteer Recruit School"]);
  });
});

describe("what a submission carries", () => {
  it("sends the record's own dates", () => {
    const plan = buildEpPlan({ entries: [entry()], templates: CATALOGUE, existing: noExisting });
    expect(submissionFor(plan.items[0]!)!).toMatchObject({
      templateId: "t-metro-100",
      completed: "2018-04-15",
      expires: null,
    });
  });

  /**
   * EP labels this field "Institution Name" and BambooHR's instructor is a
   * person - "Jane Smith" is not the body that issued a certification. What
   * belongs here is still open in the plan document, and writing a name into
   * the system of record while it is open would answer the question wrongly.
   */
  it("does not pass an instructor off as the institution", () => {
    const plan = buildEpPlan({
      entries: [entry({ instructor: "Jane Smith" })],
      templates: CATALOGUE,
      existing: noExisting,
    });
    expect(submissionFor(plan.items[0]!)!.institution).toBeNull();
  });

  /**
   * Part 1 calculates an expiry from the renewal frequency when BambooHR
   * states none. Sending that date would launder this app's arithmetic into
   * the system of record - but sending nothing is worse, because EP reads a
   * blank as "never expires" and would mark a renewable credential
   * permanently valid. Neither is the tool's call, so the record is held.
   */
  it("holds a record whose expiry this app calculated", () => {
    const plan = buildEpPlan({
      entries: [entry({ expires: "2030-01-01", expiresDerived: true })],
      templates: CATALOGUE,
      existing: noExisting,
    });
    expect(plan.items[0]!.outcome).toBe("expiryNotStated");
    expect(plan.items[0]!.explanation).toMatch(/never expiring/i);
    expect(submissionFor(plan.items[0]!)).toBeNull();
  });

  it("refuses to submit one even if it reaches here marked ready", () => {
    // The planner holds these, but this function decides what is actually
    // sent, and "never expires" is not a value to arrive at by omission.
    const plan = buildEpPlan({ entries: [entry()], templates: CATALOGUE, existing: noExisting });
    const ready = plan.items[0]!;
    expect(
      submissionFor({
        ...ready,
        entry: { ...ready.entry, expires: "2030-01-01", expiresDerived: true },
      }),
    ).toBeNull();
  });

  it("reports a missing certificate before an unconfirmed expiry", () => {
    // A record with no certificate cannot be uploaded whatever its expiry, and
    // the transcript is the actionable answer.
    const plan = buildEpPlan({
      entries: [entry({ file: null, expires: "2030-01-01", expiresDerived: true })],
      templates: CATALOGUE,
      existing: noExisting,
    });
    expect(plan.items[0]!.outcome).toBe("noFile");
  });

  it("refuses to build a submission for anything not ready", () => {
    const plan = buildEpPlan({
      entries: [entry({ file: null })],
      templates: CATALOGUE,
      existing: noExisting,
    });
    expect(submissionFor(plan.items[0]!)).toBeNull();
  });
});

describe("records Essential Personnel could not accept", () => {
  /**
   * EP requires a completion date. Marking such a record ready would present
   * it as submit-ready right up to the moment the create was rejected - and
   * the date is not this tool's to invent for the system of record.
   */
  it("does not offer a record with no completion date", () => {
    const plan = buildEpPlan({
      entries: [entry({ completed: null })],
      templates: CATALOGUE,
      existing: noExisting,
    });
    expect(plan.items[0]!.outcome).toBe("noCompletionDate");
    expect(plan.items[0]!.explanation).toMatch(/add the date in bamboohr/i);
    expect(submissionFor(plan.items[0]!)).toBeNull();
  });
});

describe("one certification recorded twice in BambooHR", () => {
  /**
   * BambooHR concatenates the certifications table and the training list, so
   * the same real certification often appears in both. The EP snapshot says
   * what was there before this run and cannot say what this run has queued -
   * so without checking, each copy finds nothing, and both are uploaded.
   */
  it("uploads the certification once, not once per record", () => {
    const plan = buildEpPlan({
      entries: [
        entry({ key: "training:1", completed: "2018-04-15" }),
        entry({ key: "certifications:9", completed: "2018-04-15" }),
      ],
      templates: CATALOGUE,
      existing: noExisting,
    });
    expect(plan.items.map((i) => i.outcome)).toEqual(["ready", "duplicateInPlan"]);
  });

  it("keeps the later sitting when the two records disagree on the date", () => {
    const plan = buildEpPlan({
      entries: [
        entry({ key: "training:1", completed: "2018-04-15" }),
        entry({ key: "certifications:9", completed: "2024-06-01" }),
      ],
      templates: CATALOGUE,
      existing: noExisting,
    });
    // The earlier record is the one demoted, even though it came first.
    expect(plan.items.map((i) => i.outcome)).toEqual(["duplicateInPlan", "ready"]);
    expect(submissionFor(plan.items[1]!)!.completed).toBe("2024-06-01");
  });
});

describe("names with nothing left to compare", () => {
  /**
   * "Training" and "Certification" both normalise to nothing once stop words
   * are dropped. Treating two empty results as identical awarded a perfect
   * score to a pair sharing no word at all.
   */
  it("does not call two empty normalisations a perfect match", () => {
    const generic: EpTemplate = { id: "t-generic", name: "Certification", abbreviation: null };
    const match = scoreTemplate("Training", generic);
    expect(match.score).toBeLessThan(1);
    expect(match.confidence).not.toBe("high");
  });
});

describe("renewals that only move the expiry", () => {
  const held = (over: Partial<EpUserCertification> = {}): EpUserCertification => ({
    id: "u1",
    templateId: "t-metro-100",
    completed: "2018-04-15",
    expires: "2024-04-15",
    institution: null,
    documentUrl: null,
    importedFrom: null,
    ...over,
  });

  /**
   * Some credentials are renewed without the completion date moving: a licence
   * keeps its original issue date and gains a later expiry. Comparing only
   * completion dates called that a duplicate and left the expired copy
   * standing as the current one.
   */
  it("uploads a record whose expiry runs past the one EP holds", () => {
    const plan = buildEpPlan({
      entries: [entry({ completed: "2018-04-15", expires: "2027-04-15" })],
      templates: CATALOGUE,
      existing: [held()],
    });
    expect(plan.items[0]!.outcome).toBe("ready");
  });

  /**
   * Part 1 computes an expiry from the training type's renewal frequency when
   * BambooHR states none. Treating that as proof of a renewal would upload a
   * duplicate on the strength of this app's own arithmetic.
   */
  it("does not treat a derived expiry as evidence of a renewal", () => {
    const plan = buildEpPlan({
      entries: [
        entry({ completed: "2018-04-15", expires: "2027-04-15", expiresDerived: true }),
      ],
      templates: CATALOGUE,
      existing: [held()],
    });
    expect(plan.items[0]!.outcome).toBe("alreadyInEp");
  });
});

describe("catalogue entries hidden behind an abbreviation", () => {
  /**
   * EP exposes some entries under an abbreviation as well as a name, and the
   * two can share no words at all. Comparing the name alone dropped the right
   * template out of the candidate list entirely.
   */
  it("matches a record against the abbreviation when the name does not", () => {
    const expanded: EpTemplate = {
      id: "t-abbrev",
      name: "Cardiopulmonary Resuscitation Provider Course",
      abbreviation: "CPR",
    };
    const match = scoreTemplate("CPR", expanded);
    expect(match.score).toBe(1);
    expect(match.confidence).toBe("high");
  });

  it("still uses the name when it is the better of the two", () => {
    const both: EpTemplate = {
      id: "t-both",
      name: "100 - Metrorail System Basics",
      abbreviation: "M100",
    };
    const match = scoreTemplate("[TS] Metro 100 - Metrorail System Basics", both);
    expect(match.confidence).toBe("high");
  });
});

describe("choosing which EP row to compare against", () => {
  /**
   * Successive extensions of one licence all carry the same completion date,
   * so comparing that alone leaves every row tied - and the comparison then
   * keeps whichever EP happened to return first, which may be the one that
   * expired years ago.
   */
  it("prefers the row that runs longest when completion dates tie", () => {
    const row = (id: string, expires: string): EpUserCertification => ({
      id,
      templateId: "t-metro-100",
      completed: "2018-04-15",
      expires,
      institution: null,
      documentUrl: null,
      importedFrom: null,
    });
    const plan = buildEpPlan({
      entries: [entry({ completed: "2018-04-15", expires: "2026-04-15" })],
      templates: CATALOGUE,
      // The stale row comes first. Comparing against it would call this record
      // a renewal and upload a credential EP already holds a current copy of.
      existing: [row("old", "2020-04-15"), row("current", "2028-04-15")],
    });
    expect(plan.items[0]!.outcome).toBe("alreadyInEp");
    expect(plan.items[0]!.existing!.id).toBe("current");
  });
});

describe("an older record that happens to run longer", () => {
  /**
   * A 2018 credential expiring in 2027 is not a renewal of a 2020
   * recertification expiring in 2025. The EP row is the later sitting, and
   * treating the older record as a renewal would upload a stale certificate
   * over a current one.
   */
  it("is not a renewal, however far its expiry reaches", () => {
    const plan = buildEpPlan({
      entries: [entry({ completed: "2018-04-15", expires: "2027-04-15" })],
      templates: CATALOGUE,
      existing: [
        {
          id: "u1",
          templateId: "t-metro-100",
          completed: "2020-06-01",
          expires: "2025-06-01",
          institution: null,
          documentUrl: null,
          importedFrom: null,
        },
      ],
    });
    expect(plan.items[0]!.outcome).toBe("alreadyInEp");
  });
});

describe("choosing between two BambooHR records for one certification", () => {
  /**
   * Both findings from the tenth review round. They were separate symptoms of
   * one cause: "which record is current" existed in three implementations
   * that did not agree, and each was fixed in isolation. There is now one
   * comparator, and these two cases fall out of it rather than being handled.
   */
  it("prefers the longer expiry when the completion dates tie", () => {
    const plan = buildEpPlan({
      entries: [
        entry({ key: "training:1", completed: "2018-04-15", expires: "2024-04-15" }),
        entry({ key: "certifications:9", completed: "2018-04-15", expires: "2028-04-15" }),
      ],
      templates: CATALOGUE,
      existing: noExisting,
    });
    expect(plan.items.map((i) => i.outcome)).toEqual(["duplicateInPlan", "ready"]);
  });

  /**
   * A newer sitting with no certificate still supersedes an older one that has
   * a file. Uploading the older certificate would put a stale document on the
   * profile as though it were the credential in force - the newer sitting
   * needs a transcript, not the previous certificate.
   */
  it("lets a newer record with no file suppress an older one that has a file", () => {
    const plan = buildEpPlan({
      entries: [
        entry({ key: "training:1", completed: "2018-04-15" }),
        entry({ key: "certifications:9", completed: "2024-06-01", file: null }),
      ],
      templates: CATALOGUE,
      existing: noExisting,
    });
    expect(plan.items.map((i) => i.outcome)).toEqual(["duplicateInPlan", "noFile"]);
  });

  it("does not let a derived expiry decide which record wins", () => {
    const plan = buildEpPlan({
      entries: [
        entry({ key: "training:1", completed: "2018-04-15", expires: "2024-04-15" }),
        entry({
          key: "certifications:9",
          completed: "2018-04-15",
          expires: "2030-01-01",
          expiresDerived: true,
        }),
      ],
      templates: CATALOGUE,
      existing: noExisting,
    });
    // The derived date reaches further, and is this app's own arithmetic.
    expect(plan.items.map((i) => i.outcome)).toEqual(["ready", "duplicateInPlan"]);
  });

  it("gives the same answer whichever order the records arrive in", () => {
    const older = entry({ key: "training:1", completed: "2018-04-15" });
    const newer = entry({ key: "certifications:9", completed: "2024-06-01" });
    const forwards = buildEpPlan({
      entries: [older, newer],
      templates: CATALOGUE,
      existing: noExisting,
    });
    const backwards = buildEpPlan({
      entries: [newer, older],
      templates: CATALOGUE,
      existing: noExisting,
    });
    expect(forwards.items.find((i) => i.outcome === "ready")!.entry.key).toBe("certifications:9");
    expect(backwards.items.find((i) => i.outcome === "ready")!.entry.key).toBe("certifications:9");
  });
});

describe("two records for the same sitting, one of which has the certificate", () => {
  /**
   * Part 1 assigns a certificate to exactly one record. When the certifications
   * table and the training list describe the same sitting - same completion,
   * same expiry - preferring whichever came first reports "no certificate
   * found" while the certificate sits on the record beside it.
   */
  it("prefers the record that has the file when everything else ties", () => {
    const plan = buildEpPlan({
      entries: [
        entry({ key: "training:1", file: null }),
        entry({ key: "certifications:9" }),
      ],
      templates: CATALOGUE,
      existing: noExisting,
    });
    expect(plan.items.map((i) => i.outcome)).toEqual(["duplicateInPlan", "ready"]);
  });

  it("does not let a file make a stale record beat a current one", () => {
    const plan = buildEpPlan({
      entries: [
        entry({ key: "training:1", completed: "2018-04-15" }),
        entry({ key: "certifications:9", completed: "2024-06-01", file: null }),
      ],
      templates: CATALOGUE,
      existing: noExisting,
    });
    expect(plan.items.map((i) => i.outcome)).toEqual(["duplicateInPlan", "noFile"]);
  });

  /**
   * The comparison used to join its fields into one string, and the separator
   * sorted above digits - so a record with NO expiry outranked one that had a
   * real expiry. Comparing field by field is what removes that class.
   */
  it("ranks a stated expiry above no expiry at all", () => {
    const plan = buildEpPlan({
      entries: [
        entry({ key: "training:1", expires: null }),
        entry({ key: "certifications:9", expires: "2028-04-15" }),
      ],
      templates: CATALOGUE,
      existing: noExisting,
    });
    expect(plan.items.map((i) => i.outcome)).toEqual(["duplicateInPlan", "ready"]);
  });
});

describe("keeping two answers about one record", () => {
  // Both review bots found the same defect here: the screen replaced the whole
  // decision, so a record needing a template AND an expiry confirmation could
  // never be made ready. Answering one question sent it back to the bucket for
  // the other, forever.
  const template = { kind: "template", templateId: "t-cpr" } as const;

  it("keeps the template when the expiry is answered, and the reverse", () => {
    const afterTemplate = applyDecisionPatch(undefined, { handling: template });
    const afterBoth = applyDecisionPatch(afterTemplate ?? undefined, {
      expiry: { expires: "2027-01-01" },
    });
    expect(afterBoth).toEqual({ handling: template, expiry: { expires: "2027-01-01" } });

    // And the other order: confirming the expiry first must survive the pick.
    const afterExpiry = applyDecisionPatch(undefined, { expiry: { expires: "2027-01-01" } });
    expect(applyDecisionPatch(afterExpiry ?? undefined, { handling: template })).toEqual({
      handling: template,
      expiry: { expires: "2027-01-01" },
    });
  });

  it("clears only the field it is told to clear", () => {
    const both = { handling: template, expiry: { expires: "2027-01-01" } };
    expect(applyDecisionPatch(both, { handling: null })).toEqual({
      expiry: { expires: "2027-01-01" },
    });
    expect(applyDecisionPatch(both, { expiry: null })).toEqual({ handling: template });
  });

  it("treats \"does not expire\" as an answer, not as clearing the field", () => {
    // `{ expires: null }` is the member asserting the certification never
    // expires. A truthiness test would read it as "no answer" and drop it.
    expect(applyDecisionPatch(undefined, { expiry: { expires: null } })).toEqual({
      expiry: { expires: null },
    });
  });

  it("forgets the record once nothing is left", () => {
    expect(applyDecisionPatch({ handling: template }, { handling: null })).toBeNull();
    expect(applyDecisionPatch(undefined, { handling: null })).toBeNull();
  });
});

describe("a confirmed expiry, once the member has settled it", () => {
  /** A record whose expiry Part 1 calculated rather than read. */
  function derived(over: Partial<ManifestEntry> = {}) {
    return entry({
      name: "CPR",
      completed: "2026-01-10",
      expires: "2028-01-10",
      expiresDerived: true,
      ...over,
    });
  }

  it("holds the record back until the member answers", () => {
    const plan = buildEpPlan({
      entries: [derived()],
      templates: CATALOGUE,
      existing: noExisting,
      decisions: {},
    });
    expect(plan.items[0]!.outcome).toBe("expiryNotStated");
    expect(submissionFor(plan.items[0]!)).toBeNull();
  });

  it("sends the date the member confirmed, not the one that was calculated", () => {
    const plan = buildEpPlan({
      entries: [derived()],
      templates: CATALOGUE,
      existing: noExisting,
      decisions: { "training:1": { expiry: { expires: "2027-06-30" } } },
    });
    expect(plan.items[0]!.outcome).toBe("ready");
    expect(submissionFor(plan.items[0]!)?.expires).toBe("2027-06-30");
  });

  it("sends a blank expiry when the member says it does not expire", () => {
    // EP stores a blank as "never expires", so this has to reach them as null
    // rather than as the date this app worked out.
    const plan = buildEpPlan({
      entries: [derived()],
      templates: CATALOGUE,
      existing: noExisting,
      decisions: { "training:1": { expiry: { expires: null } } },
    });
    expect(submissionFor(plan.items[0]!)?.expires).toBeNull();
  });

  it("counts a confirmed later expiry as a renewal of what EP already holds", () => {
    const held: EpUserCertification[] = [
      {
        id: "ep-1",
        templateId: "t-cpr",
        completed: "2026-01-10",
        expires: "2026-12-31",
        institution: null,
        documentUrl: null,
        importedFrom: null,
      },
    ];
    // Same sitting date, but the member's confirmed expiry runs later than the
    // one on record - a renewal, not a duplicate.
    const plan = buildEpPlan({
      entries: [derived()],
      templates: CATALOGUE,
      existing: held,
      decisions: { "training:1": { expiry: { expires: "2027-06-30" } } },
    });
    expect(plan.items[0]!.outcome).toBe("ready");
  });

  it("does not treat \"does not expire\" as newer than a dated record EP holds", () => {
    // Uploading over the county's record on the strength of an ABSENCE is the
    // wrong way round; only the completion date can settle this one.
    const held: EpUserCertification[] = [
      {
        id: "ep-1",
        templateId: "t-cpr",
        completed: "2026-01-10",
        expires: "2026-12-31",
        institution: null,
        documentUrl: null,
        importedFrom: null,
      },
    ];
    const plan = buildEpPlan({
      entries: [derived()],
      templates: CATALOGUE,
      existing: held,
      decisions: { "training:1": { expiry: { expires: null } } },
    });
    expect(plan.items[0]!.outcome).toBe("alreadyInEp");
  });
});
