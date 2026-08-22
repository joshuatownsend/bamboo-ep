import { describe, expect, it } from "vitest";
import { buildMatchPlan, scorePair, tokenize, tokenOverlap } from "../src/matching.js";
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
