import { describe, expect, it } from "vitest";
import {
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
      decisions: { "training:vrs": { kind: "skip" } },
    });
    expect(plan.items[0]!.outcome).toBe("skipped");
    expect(plan.catalogueRequests).toEqual([]);
  });

  it("collects requested names for the email the General Order asks for", () => {
    const plan = buildEpPlan({
      entries: [entry({ key: "training:vrs", name: "Volunteer Recruit School" })],
      templates: CATALOGUE,
      existing: noExisting,
      decisions: { "training:vrs": { kind: "request" } },
    });
    expect(plan.catalogueRequests).toEqual(["Volunteer Recruit School"]);
  });

  it("honours a template the member picked by hand over the matcher's opinion", () => {
    const plan = buildEpPlan({
      entries: [entry({ name: "Something the matcher cannot place" })],
      templates: CATALOGUE,
      existing: noExisting,
      decisions: { "training:1": { kind: "template", templateId: "t-forklift" } },
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
      decisions: { "training:1": { kind: "template", templateId: "t-deleted" } },
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
      decisions: { "certifications:row-0": { kind: "skip" } },
    });
    expect(plan.items[0]!.outcome).not.toBe("skipped");
  });

  it("ignores a remembered template on a positional key", () => {
    const plan = buildEpPlan({
      entries: [entry({ key: "certifications:row-3", name: "Unplaceable name" })],
      templates: CATALOGUE,
      existing: noExisting,
      decisions: { "certifications:row-3": { kind: "template", templateId: "t-forklift" } },
    });
    expect(plan.items[0]!.template).toBeNull();
  });

  it("still honours a decision on a real certifications id", () => {
    const plan = buildEpPlan({
      entries: [entry({ key: "certifications:8821" })],
      templates: CATALOGUE,
      existing: noExisting,
      decisions: { "certifications:8821": { kind: "skip" } },
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
      decisions: { "training:vrs": { kind: "request" } },
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
        "training:a": { kind: "request" },
        "training:b": { kind: "request" },
      },
    });
    expect(plan.catalogueRequests).toEqual(["Volunteer Recruit School"]);
  });
});

describe("what a submission carries", () => {
  it("sends the record's own dates and institution", () => {
    const plan = buildEpPlan({ entries: [entry()], templates: CATALOGUE, existing: noExisting });
    const submission = submissionFor(plan.items[0]!)!;
    expect(submission).toMatchObject({
      templateId: "t-metro-100",
      completed: "2018-04-15",
      expires: null,
      institution: "Washington Metropolitan Area Transit Authority",
    });
  });

  /**
   * Part 1 derives an expiry from the training type's renewal frequency when
   * BambooHR does not state one. That is this app's arithmetic, not a fact an
   * issuer asserted, and writing it into the system of record would launder a
   * guess into a date someone later staffs against.
   */
  it("never sends a derived expiry", () => {
    const plan = buildEpPlan({
      entries: [entry({ expires: "2030-01-01", expiresDerived: true })],
      templates: CATALOGUE,
      existing: noExisting,
    });
    expect(submissionFor(plan.items[0]!)!.expires).toBeNull();
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
