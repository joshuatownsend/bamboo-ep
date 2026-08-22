import { describe, expect, it } from "vitest";
import { addMonths, cleanDate, cleanNumber, idToString, toArray } from "../src/normalize.js";

describe("toArray", () => {
  it("handles the object-map shape BambooHR returns when data exists", () => {
    expect(toArray({ "12": { id: 12 }, "13": { id: 13 } })).toEqual([{ id: 12 }, { id: 13 }]);
  });

  it("handles the empty ARRAY BambooHR returns when nothing exists", () => {
    expect(toArray([])).toEqual([]);
  });

  it("handles a populated array", () => {
    expect(toArray([{ id: 1 }])).toEqual([{ id: 1 }]);
  });

  it("handles null and undefined", () => {
    expect(toArray(null)).toEqual([]);
    expect(toArray(undefined)).toEqual([]);
  });
});

describe("idToString", () => {
  it("normalises numbers and strings, rejecting empties", () => {
    expect(idToString(12)).toBe("12");
    expect(idToString("12")).toBe("12");
    expect(idToString("")).toBeNull();
    expect(idToString(null)).toBeNull();
  });
});

describe("cleanDate", () => {
  it("accepts dates and timestamps, returning a plain date", () => {
    expect(cleanDate("2025-06-01")).toBe("2025-06-01");
    expect(cleanDate("2011-06-28 16:50:52")).toBe("2011-06-28");
  });

  it("rejects the zero-date sentinel BambooHR uses for 'unset'", () => {
    expect(cleanDate("0000-00-00")).toBeNull();
    expect(cleanDate("2025-00-01")).toBeNull();
  });

  it("rejects junk", () => {
    expect(cleanDate("")).toBeNull();
    expect(cleanDate("soon")).toBeNull();
    expect(cleanDate(null)).toBeNull();
  });
});

describe("cleanNumber", () => {
  it("parses numeric strings, which BambooHR uses for sizes", () => {
    expect(cleanNumber("23552")).toBe(23552);
    expect(cleanNumber(42)).toBe(42);
    expect(cleanNumber("")).toBeNull();
    expect(cleanNumber(null)).toBeNull();
  });
});

describe("addMonths", () => {
  it("derives a renewal date", () => {
    expect(addMonths("2025-06-01", 24)).toBe("2027-06-01");
  });

  it("clamps to the last day when the target month is shorter", () => {
    expect(addMonths("2025-01-31", 1)).toBe("2025-02-28");
    expect(addMonths("2024-01-31", 1)).toBe("2024-02-29");
  });

  it("rolls across year boundaries", () => {
    expect(addMonths("2025-11-15", 3)).toBe("2026-02-15");
    expect(addMonths("2025-12-31", 12)).toBe("2026-12-31");
  });

  it("returns null for unusable input", () => {
    expect(addMonths("", 12)).toBeNull();
    expect(addMonths("0000-00-00", 12)).toBeNull();
  });
});
