import { describe, expect, it } from "vitest";
import { applyFileNameFallback, buildTrainingItems } from "../src/items.js";
import type { WireTrainingType } from "../src/types.js";

const cprType: WireTrainingType = {
  id: 12,
  name: "CPR - BLS Provider",
  renewable: true,
  frequency: 24,
  category: { id: 3, name: "Safety" },
};

describe("buildTrainingItems", () => {
  it("resolves the certification name by joining record.type to the type catalogue", () => {
    const [item] = buildTrainingItems({
      records: [{ id: 1234, type: "12", completed: "2025-06-01", instructor: "Jane Smith" }],
      types: new Map([["12", cprType]]),
      certifications: [],
    });

    expect(item).toMatchObject({
      name: "CPR - BLS Provider",
      nameSource: "training-type",
      category: "Safety",
      completed: "2025-06-01",
      instructor: "Jane Smith",
    });
  });

  it("derives an expiry from the renewal frequency and flags it as derived", () => {
    const [item] = buildTrainingItems({
      records: [{ id: 1, type: 12, completed: "2025-06-01" }],
      types: new Map([["12", cprType]]),
      certifications: [],
    });

    expect(item?.expires).toBe("2027-06-01");
    expect(item?.expiresDerived).toBe(true);
  });

  it("does not invent an expiry for a non-renewable training", () => {
    const [item] = buildTrainingItems({
      records: [{ id: 1, type: 12, completed: "2025-06-01" }],
      types: new Map([["12", { ...cprType, renewable: false }]]),
      certifications: [],
    });

    expect(item?.expires).toBeNull();
    expect(item?.expiresDerived).toBe(false);
  });

  it("degrades to a placeholder when /training/type was refused (403)", () => {
    // An empty type map is exactly what a 403 on /training/type produces.
    const [item] = buildTrainingItems({
      records: [{ id: 1, type: "12", completed: "2025-06-01" }],
      types: new Map(),
      certifications: [],
    });

    expect(item?.name).toBe("Training 12");
    expect(item?.nameSource).toBe("placeholder");
    expect(item?.category).toBeNull();
  });

  it("prefers the certifications table, which carries a real title and expiry", () => {
    const [item] = buildTrainingItems({
      records: [],
      types: new Map(),
      certifications: [
        {
          id: 7,
          title: "EMT-Basic",
          completionDate: "2024-03-11",
          expirationDate: "2027-03-31",
          certificationNumber: "E-99",
        },
      ],
    });

    expect(item).toMatchObject({
      source: "certifications",
      name: "EMT-Basic",
      nameSource: "certification-title",
      expires: "2027-03-31",
      expiresDerived: false,
      certificationNumber: "E-99",
    });
  });

  it("treats an empty-array category as unset, which is how BambooHR encodes it", () => {
    const [item] = buildTrainingItems({
      records: [{ id: 1, type: 12, completed: "2025-06-01" }],
      types: new Map([["12", { ...cprType, category: [] }]]),
      certifications: [],
    });

    expect(item?.category).toBeNull();
  });
});

describe("applyFileNameFallback", () => {
  it("upgrades a placeholder name using the matched file's name", () => {
    const [item] = buildTrainingItems({
      records: [{ id: 1, type: "12", completed: "2025-06-01" }],
      types: new Map(),
      certifications: [],
    });

    const upgraded = applyFileNameFallback(item!, "CPR Card 2025");
    expect(upgraded.name).toBe("CPR Card 2025");
    expect(upgraded.nameSource).toBe("file-name");
  });

  it("never overwrites a real certification name", () => {
    const [item] = buildTrainingItems({
      records: [{ id: 1, type: "12", completed: "2025-06-01" }],
      types: new Map([["12", cprType]]),
      certifications: [],
    });

    expect(applyFileNameFallback(item!, "scan001").name).toBe("CPR - BLS Provider");
  });
});
