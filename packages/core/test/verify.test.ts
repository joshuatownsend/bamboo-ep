import { describe, expect, it } from "vitest";
import {
  cleanIsoDate,
  compareExtraction,
  corePart,
  parseExtraction,
} from "../src/verify.js";
import type { ExtractedCertificate } from "../src/verify.js";
import type { EmployeeIdentity, TrainingItem } from "../src/types.js";

const me: EmployeeIdentity = {
  firstName: "Joshua",
  lastName: "Townsend",
  displayName: "Joshua Townsend",
  preferredName: null,
};

function item(partial: Partial<TrainingItem> & { key: string; name: string }): TrainingItem {
  return {
    id: partial.key,
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

function extracted(partial: Partial<ExtractedCertificate> = {}): ExtractedCertificate {
  return {
    certificationName: null,
    issuedDate: null,
    expirationDate: null,
    personName: null,
    documentType: "certificate",
    legible: true,
    ...partial,
  };
}

describe("parseExtraction", () => {
  it("reads a clean JSON response", () => {
    const result = parseExtraction(
      JSON.stringify({
        certificationName: "Bloodborne Pathogens",
        issuedDate: "2024-03-11",
        expirationDate: null,
        personName: "TOWNSEND JOSHUA RUSSELL",
        documentType: "certificate",
        legible: true,
      }),
    );
    expect("extracted" in result && result.extracted.certificationName).toBe(
      "Bloodborne Pathogens",
    );
  });

  // Models add fences and commentary whatever the prompt says, so the parser
  // must find the object rather than require the whole reply to be one.
  it("finds the object inside a fenced, chatty response", () => {
    const result = parseExtraction(
      'Here is what I read:\n```json\n{"certificationName":"CPR","issuedDate":null,' +
        '"expirationDate":null,"personName":null,"documentType":"card","legible":true}\n```\nHope that helps!',
    );
    expect("extracted" in result && result.extracted.certificationName).toBe("CPR");
  });

  it("treats the words models use for null as null", () => {
    const result = parseExtraction(
      '{"certificationName":"CPR","issuedDate":"N/A","expirationDate":"not visible",' +
        '"personName":"unknown","documentType":"card","legible":true}',
    );
    expect("extracted" in result && result.extracted.issuedDate).toBeNull();
    expect("extracted" in result && result.extracted.personName).toBeNull();
  });

  it("marks an unreadable document type as illegible however legible was set", () => {
    const result = parseExtraction(
      '{"certificationName":null,"issuedDate":null,"expirationDate":null,' +
        '"personName":null,"documentType":"unreadable","legible":true}',
    );
    expect("extracted" in result && result.extracted.legible).toBe(false);
  });

  // An empty object used to coerce into a perfectly well-formed extraction
  // with no error, which the manifest then counted as a VERIFIED certificate.
  // Silence has to be reported as silence.
  it("rejects an answer that omits the fields rather than inventing nulls", () => {
    const result = parseExtraction("{}");
    expect("error" in result && result.error).toMatch(/left out/);
  });

  it("rejects an answer whose fields are the wrong type", () => {
    const result = parseExtraction(
      '{"certificationName":42,"issuedDate":null,"expirationDate":null,' +
        '"personName":null,"documentType":"card","legible":true}',
    );
    expect("error" in result && result.error).toMatch(/wrong type/);
  });

  it("rejects an answer that does not say whether the page was legible", () => {
    const result = parseExtraction(
      '{"certificationName":"CPR","issuedDate":null,"expirationDate":null,' +
        '"personName":null,"documentType":"card","legible":"yes"}',
    );
    expect("error" in result && result.error).toMatch(/legible/);
  });

  it("explains itself rather than throwing when the model returned prose", () => {
    const result = parseExtraction("I'm sorry, I can't read that image.");
    expect("error" in result && result.error).toMatch(/did not return JSON/);
  });
});

describe("cleanIsoDate", () => {
  it("accepts a real calendar date", () => {
    expect(cleanIsoDate("2024-03-11")).toBe("2024-03-11");
  });

  // Coercing "2024" to a date would manufacture a precision the page does not
  // have, which the date comparison would then treat as evidence.
  it("rejects partial dates rather than inventing a day", () => {
    expect(cleanIsoDate("2024")).toBeNull();
    expect(cleanIsoDate("March 2024")).toBeNull();
  });

  it("rejects a date that does not exist", () => {
    expect(cleanIsoDate("2024-02-31")).toBeNull();
  });
});

describe("compareExtraction: the mislabels that actually happened", () => {
  const modules = [
    item({ key: "training:1", name: "Intro to Technical Rescue Module 1" }),
    item({ key: "training:2", name: "Intro to Technical Rescue Module 2" }),
  ];

  it("contradicts a module 1 record holding a module 2 certificate", () => {
    const result = compareExtraction({
      item: modules[0]!,
      extracted: extracted({
        certificationName: "Introduction to Technical Rescue Module 2",
      }),
      identity: me,
      allItems: modules,
    });

    expect(result.verdicts.name).toBe("contradicts");
  });

  // Flagging the wrong pairing is useful; naming the right one turns a puzzle
  // into a click, which is the whole reason comparison stays in local code.
  it("names the record the document actually belongs to", () => {
    const result = compareExtraction({
      item: modules[0]!,
      extracted: extracted({
        certificationName: "Introduction to Technical Rescue Module 2",
      }),
      identity: me,
      allItems: modules,
    });

    expect(result.suggestedItemKey).toBe("training:2");
  });

  // The verification had independently grown the matcher's partial-intersection
  // bug: a shared standard number cleared a conflicting level, so the check
  // meant to catch the mislabel confirmed it instead.
  it("does not clear a different level just because the standard number matches", () => {
    const result = compareExtraction({
      item: item({ key: "training:1", name: "Firefighter II (NFPA 1001)" }),
      extracted: extracted({ certificationName: "Firefighter III (NFPA 1001)" }),
      identity: me,
      allItems: [],
    });

    expect(result.verdicts.name).toBe("contradicts");
  });

  it("confirms a roman-numeral record against a digit-spelled certificate", () => {
    const result = compareExtraction({
      item: item({ key: "training:9", name: "Firefighter II (NFPA-1001)" }),
      extracted: extracted({ certificationName: "Firefighter 2 NFPA 1001" }),
      identity: me,
      allItems: [],
    });

    expect(result.verdicts.name).toBe("confirms");
  });
});

describe("compareExtraction: catalogue references", () => {
  // From a real run. BambooHR holds "Firefighter 1 (NFPA-1001)"; the page is a
  // commendation-style certificate reading "Firefighter I" with no standard
  // number anywhere on it. Counting nfpa and 1001 as required words made the
  // score 2 of 4 - under the threshold, reported as telling us nothing, for a
  // certificate that plainly matches.
  it("confirms a certificate that omits the standard number in the record name", () => {
    const result = compareExtraction({
      item: item({ key: "training:1", name: "Firefighter 1 (NFPA-1001)" }),
      extracted: extracted({
        certificationName: "Certificate of Commendation — Firefighter I",
      }),
      identity: me,
      allItems: [],
    });

    expect(result.verdicts.name).toBe("confirms");
  });

  it("handles the same qualifier written without brackets", () => {
    const result = compareExtraction({
      item: item({ key: "training:1", name: "Firefighter 1 - NFPA 1001" }),
      extracted: extracted({ certificationName: "Firefighter I" }),
      identity: me,
      allItems: [],
    });

    expect(result.verdicts.name).toBe("confirms");
  });

  // Demoted, not discarded: a conflicting level still has to be caught, and
  // the number check runs on the full name.
  it("still contradicts a different level despite the demoted qualifier", () => {
    const result = compareExtraction({
      item: item({ key: "training:1", name: "Firefighter 1 (NFPA-1001)" }),
      extracted: extracted({ certificationName: "Firefighter II" }),
      identity: me,
      allItems: [],
    });

    expect(result.verdicts.name).toBe("contradicts");
  });

  it("leaves a name that is only a qualifier alone", () => {
    expect(corePart("(NFPA-1001)")).toBe("(NFPA-1001)");
  });
});

describe("compareExtraction: the person check", () => {
  const cpr = item({ key: "training:1", name: "CPR BLS Provider" });

  it("confirms the employee's own name however the certificate spells it", () => {
    const result = compareExtraction({
      item: cpr,
      extracted: extracted({
        certificationName: "CPR BLS Provider",
        personName: "TOWNSEND JOSHUA RUSSELL",
      }),
      identity: me,
      allItems: [],
    });

    expect(result.verdicts.person).toBe("confirms");
  });

  // The gap decision #3 knowingly leaves open: this is exactly the case that a
  // high-confidence filename match would never have been checked for.
  it("contradicts a colleague's certificate even when the title is right", () => {
    const result = compareExtraction({
      item: cpr,
      extracted: extracted({
        certificationName: "CPR BLS Provider",
        personName: "Maria Delgado",
      }),
      identity: me,
      allItems: [],
    });

    expect(result.verdicts.name).toBe("confirms");
    expect(result.verdicts.person).toBe("contradicts");
  });

  it("says nothing about the person when BambooHR gave us no name", () => {
    const result = compareExtraction({
      item: cpr,
      extracted: extracted({ personName: "Maria Delgado" }),
      identity: null,
      allItems: [],
    });

    expect(result.verdicts.person).toBe("inconclusive");
  });
});

describe("compareExtraction: dates", () => {
  it("tolerates the gap between finishing a course and the certificate being dated", () => {
    const result = compareExtraction({
      item: item({ key: "training:1", name: "CPR", completed: "2024-03-11" }),
      extracted: extracted({ certificationName: "CPR", issuedDate: "2024-03-25" }),
      identity: me,
      allItems: [],
    });

    expect(result.verdicts.date).toBe("confirms");
  });

  it("contradicts a certificate from a different year's sitting", () => {
    const result = compareExtraction({
      item: item({ key: "training:1", name: "CPR", completed: "2024-03-11" }),
      extracted: extracted({ certificationName: "CPR", issuedDate: "2021-03-11" }),
      identity: me,
      allItems: [],
    });

    expect(result.verdicts.date).toBe("contradicts");
  });

  // A wallet card often prints only an expiry, with no issue date anywhere.
  it("falls back to the expiry when neither side has an issue date", () => {
    const result = compareExtraction({
      item: item({ key: "training:1", name: "CPR", expires: "2026-06-01" }),
      extracted: extracted({ certificationName: "CPR", expirationDate: "2026-06-01" }),
      identity: me,
      allItems: [],
    });

    expect(result.verdicts.date).toBe("confirms");
  });
});

describe("compareExtraction: an unreadable scan", () => {
  // Reporting "contradicts" here would blame the record for the scanner.
  it("returns inconclusive on every axis rather than blaming the record", () => {
    const result = compareExtraction({
      item: item({ key: "training:1", name: "CPR", completed: "2024-03-11" }),
      extracted: extracted({
        legible: false,
        certificationName: "smudge",
        personName: "Maria Delgado",
      }),
      identity: me,
      allItems: [],
    });

    expect(result.verdicts).toEqual({
      name: "inconclusive",
      date: "inconclusive",
      person: "inconclusive",
    });
    expect(result.suggestedItemKey).toBeNull();
  });
});
