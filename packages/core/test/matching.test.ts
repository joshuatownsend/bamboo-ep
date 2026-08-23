import { describe, expect, it } from "vitest";
import {
  buildMatchPlan,
  compareNumbers,
  scorePair,
  tokenize,
  tokenOverlap,
} from "../src/matching.js";
import type { EmployeeFile, TrainingItem } from "../src/types.js";

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

function file(partial: Partial<EmployeeFile> & { id: string; name: string }): EmployeeFile {
  return {
    originalFileName: null,
    categoryId: "1",
    categoryName: "Training Docs",
    size: null,
    dateCreated: null,
    ...partial,
  };
}

describe("tokenize", () => {
  it("drops domain stop words that carry no identifying signal", () => {
    expect([...tokenize("CPR Certification Certificate")]).toEqual(["cpr"]);
  });

  it("splits on punctuation and underscores", () => {
    expect([...tokenize("bloodborne_pathogens-2024.pdf")]).toEqual([
      "bloodborne",
      "pathogens",
      "2024",
    ]);
  });
});

describe("tokenize: level and module numbers", () => {
  // Regression: single-character tokens were dropped, so "Module 1" and
  // "Module 2" tokenized identically and were assigned arbitrarily. Two real
  // certificates were swapped in a live run because of this.
  it("keeps single digits, which are often the only distinguishing token", () => {
    expect([...tokenize("Intro to Technical Rescue Module 1")]).toContain("1");
    expect([...tokenize("Intro to Technical Rescue Module 2")]).toContain("2");
  });

  it("still drops single letters, which carry no signal", () => {
    expect([...tokenize("Fire X Safety")]).not.toContain("x");
  });

  it("normalises roman numerals so II matches 2", () => {
    expect([...tokenize("Firefighter II")]).toContain("2");
    expect([...tokenize("Fire Officer IV")]).toContain("4");
  });
});

describe("scorePair: number conflicts", () => {
  const modules = (n: number) =>
    item({ key: `training:${n}`, name: `Intro to Technical Rescue Module ${n}` });
  const moduleFile = (n: number) =>
    file({
      id: `${n}`,
      name: `Introduction to Technical Rescue Module ${n}`,
      originalFileName: `jtownsend_Introduction-to-Technical-Rescue-Module-${n}_2016.pdf`,
    });

  it("scores the matching module far above the mismatched one", () => {
    const right = scorePair(modules(1), moduleFile(1));
    const wrong = scorePair(modules(1), moduleFile(2));
    expect(right.score).toBeGreaterThan(wrong.score);
    expect(wrong.reasons.join(" ")).toMatch(/Numbers disagree/);
  });

  it("matches a roman-numeral certification to its digit-spelled file", () => {
    const result = scorePair(
      item({ key: "training:1", name: "Firefighter II (NFPA-1001)" }),
      file({
        id: "9",
        name: "Firefighter 2",
        originalFileName: "jtownsend_Firefighter-2-NFPA-1001-_2016.pdf",
      }),
    );
    expect(result.reasons.join(" ")).toMatch(/Numbers agree/);
    expect(result.confidence).not.toBe("low");
  });

  it("separates Fire Officer 2 from a Fire Officer IV certificate", () => {
    const wrong = scorePair(
      item({ key: "training:1", name: "Fire Officer 2" }),
      file({ id: "9", name: "fire officer IV certificate" }),
    );
    expect(wrong.reasons.join(" ")).toMatch(/Numbers disagree/);
  });

  it("stays quiet when only one side carries a number", () => {
    const result = scorePair(
      item({ key: "training:1", name: "Bloodborne Pathogens" }),
      file({ id: "9", name: "bloodborne pathogens 2024" }),
    );
    expect(result.reasons.join(" ")).not.toMatch(/Numbers disagree/);
  });
});

describe("buildMatchPlan: real-world module swap", () => {
  it("does not swap two modules that differ only by number", () => {
    const items = [
      item({ key: "training:1", name: "Intro to Technical Rescue Module 1" }),
      item({ key: "training:2", name: "Intro to Technical Rescue Module 2" }),
    ];
    const files = [
      file({
        id: "100",
        name: "Introduction to Technical Rescue Module 1",
        originalFileName: "Introduction-to-Technical-Rescue-Module-1_2016.pdf",
      }),
      file({
        id: "200",
        name: "Introduction to Technical Rescue Module 2",
        originalFileName: "Introduction-to-Technical-Rescue-Module-2_2016.pdf",
      }),
    ];

    const pairs = Object.fromEntries(
      buildMatchPlan(items, files).matches.map((m) => [m.itemKey, m.fileId]),
    );
    expect(pairs["training:1"]).toBe("100");
    expect(pairs["training:2"]).toBe("200");
  });
});

describe("tokenOverlap", () => {
  it("measures against the certification, not the file, so noisy filenames are not penalised", () => {
    const result = tokenOverlap(
      "Bloodborne Pathogens",
      "scan of my bloodborne pathogens training from work.pdf",
    );
    expect(result.ratio).toBe(1);
  });

  it("returns zero when nothing meaningful is shared", () => {
    expect(tokenOverlap("CPR", "offer letter.pdf").ratio).toBe(0);
  });
});

describe("scorePair", () => {
  it("scores a strong name match in a certificate category highly", () => {
    const result = scorePair(
      item({ key: "training:1", name: "Bloodborne Pathogens", completed: "2024-03-11" }),
      file({
        id: "9",
        name: "Bloodborne Pathogens",
        originalFileName: "bbp.pdf",
        categoryName: "Certifications",
        dateCreated: "2024-03-15",
      }),
    );

    expect(result.confidence).toBe("high");
  });

  it("penalises categories that rarely hold certificates", () => {
    const payroll = scorePair(
      item({ key: "training:1", name: "Bloodborne Pathogens" }),
      file({ id: "9", name: "Bloodborne Pathogens", categoryName: "Payroll" }),
    );
    const training = scorePair(
      item({ key: "training:1", name: "Bloodborne Pathogens" }),
      file({ id: "9", name: "Bloodborne Pathogens", categoryName: "Training Docs" }),
    );

    expect(payroll.score).toBeLessThan(training.score);
  });

  it("never returns a score outside 0..1", () => {
    const result = scorePair(
      item({ key: "training:1", name: "CPR" }),
      file({ id: "9", name: "unrelated", categoryName: "Payroll" }),
    );
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });
});

describe("buildMatchPlan", () => {
  const items = [
    item({ key: "training:1", name: "Bloodborne Pathogens", completed: "2024-03-11" }),
    item({ key: "training:2", name: "CPR BLS Provider", completed: "2025-06-01" }),
  ];
  const files = [
    file({ id: "100", name: "Bloodborne Pathogens", originalFileName: "bbp.pdf" }),
    file({ id: "200", name: "CPR BLS card", originalFileName: "cpr.pdf" }),
  ];

  it("pairs each record with its best file", () => {
    const plan = buildMatchPlan(items, files);
    const pairs = Object.fromEntries(plan.matches.map((m) => [m.itemKey, m.fileId]));

    expect(pairs["training:1"]).toBe("100");
    expect(pairs["training:2"]).toBe("200");
    expect(plan.unmatchedItemKeys).toEqual([]);
    expect(plan.unmatchedFileIds).toEqual([]);
  });

  it("never assigns one file to two records", () => {
    const plan = buildMatchPlan(
      [items[0]!, item({ key: "training:3", name: "Bloodborne Pathogens Refresher" })],
      [files[0]!],
    );
    expect(plan.matches).toHaveLength(1);
    expect(plan.unmatchedItemKeys).toHaveLength(1);
  });

  it("reports records with no candidate file, which still belong in the summary", () => {
    const plan = buildMatchPlan(
      [item({ key: "training:9", name: "Incident Command" })],
      [file({ id: "500", name: "tax form", categoryName: "Payroll" })],
    );

    expect(plan.matches).toEqual([]);
    expect(plan.unmatchedItemKeys).toEqual(["training:9"]);
    expect(plan.unmatchedFileIds).toEqual(["500"]);
  });

  it("honours a previously confirmed mapping over its own scoring", () => {
    // Deliberately contradicts the heuristic: the user knows better.
    const plan = buildMatchPlan(items, files, {
      confirmed: { "100": "training:2" },
    });

    const forced = plan.matches.find((m) => m.fileId === "100");
    expect(forced?.itemKey).toBe("training:2");
    expect(forced?.score).toBe(1);
    // The other record cannot now take file 100.
    expect(plan.matches.find((m) => m.itemKey === "training:1")?.fileId).not.toBe("100");
  });
});

describe("buildMatchPlan: positional keys are not identity", () => {
  // A certifications row may carry no id of its own, in which case its key is
  // built from where it sat in the response. Remembering a decision against
  // that key means the decision follows the SLOT, not the certification: add a
  // row above it and a saved certificate is handed to a different record, at
  // full confidence, with nothing on screen suggesting anything moved.
  it("rescores a confirmed pairing whose key came from a row position", () => {
    const items = [
      item({ key: "certifications:row-0", name: "CPR" }),
      item({ key: "certifications:row-1", name: "Bloodborne Pathogens" }),
    ].map((i) => ({ ...i, source: "certifications" as const, id: i.key.split(":")[1]! }));

    const files = [file({ id: "100", name: "bloodborne pathogens" })];
    const plan = buildMatchPlan(items, files, {
      confirmed: { "100": "certifications:row-0" },
    });

    // Not inherited as a confirmed pairing...
    expect(plan.matches.some((m) => m.confirmedByUser)).toBe(false);
    // ...and the scorer gives the file to the record that actually matches.
    expect(plan.matches.find((m) => m.fileId === "100")?.itemKey).toBe(
      "certifications:row-1",
    );
  });

  it("still honours a confirmed pairing when the row has a real id", () => {
    const items = [
      { ...item({ key: "certifications:88", name: "CPR" }), source: "certifications" as const, id: "88" },
    ];
    const plan = buildMatchPlan(items, [file({ id: "100", name: "unrelated" })], {
      confirmed: { "100": "certifications:88" },
    });

    expect(plan.matches[0]?.confirmedByUser).toBe(true);
  });
});

describe("compareNumbers", () => {
  // A shared standard number used to mask a conflicting level, so the wrong
  // rung of a certification ladder scored as agreement.
  it("does not let a shared standard number excuse a different level", () => {
    const result = compareNumbers("Firefighter II (NFPA 1001)", ["Firefighter III (NFPA 1001)"]);
    expect(result.verdict).toBe("conflict");
  });

  // The other direction matters just as much: requiring every certification
  // number to appear would reject a correct file for omitting the standard.
  it("accepts a filename that simply leaves the standard number off", () => {
    const result = compareNumbers("NFPA 1001 Firefighter I", ["Firefighter-1.pdf"]);
    expect(result.verdict).toBe("agree");
  });

  it("stays silent when only one side carries a number at all", () => {
    expect(compareNumbers("Bloodborne Pathogens", ["bbp-2024.pdf"]).verdict).toBe("silent");
  });

  it("ignores a browser's duplicate-download suffix", () => {
    expect(compareNumbers("Fire Officer 2", ["Fire Officer 2 (1).pdf"]).verdict).toBe("agree");
  });
});

describe("scorePair: a number conflict is disqualifying", () => {
  // A penalty could always be outpaid by enough shared words: six matching
  // tokens plus one wrong module number still cleared the proposal threshold.
  it("scores a conflicting pair at zero rather than merely penalising it", () => {
    const result = scorePair(
      item({ key: "training:1", name: "Intro to Advanced Technical Rescue Module 1" }),
      file({
        id: "9",
        name: "Introduction to Advanced Technical Rescue Module 2",
        originalFileName: "Introduction-to-Advanced-Technical-Rescue-Module-2.pdf",
        categoryName: "Certifications",
      }),
    );

    expect(result.score).toBe(0);
    expect(result.confidence).toBe("low");
  });

  it("leaves the record unmatched rather than proposing the conflicting file", () => {
    const plan = buildMatchPlan(
      [item({ key: "training:1", name: "Fire Officer 2" })],
      [file({ id: "9", name: "Fire Officer 3 certificate", categoryName: "Certifications" })],
    );

    expect(plan.matches).toEqual([]);
    expect(plan.unmatchedItemKeys).toEqual(["training:1"]);
  });
});
