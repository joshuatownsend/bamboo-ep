import { describe, expect, it } from "vitest";
import { comparePersonName, displayNameOf, nameParts, splitName } from "../src/identity.js";
import type { EmployeeIdentity } from "../src/types.js";

/**
 * The fixture is the real shape of the problem: BambooHR holds "Joshua
 * Townsend"; the certificates are printed "TOWNSEND JOSHUA RUSSELL".
 */
const me: EmployeeIdentity = {
  firstName: "Joshua",
  lastName: "Townsend",
  displayName: "Joshua Townsend",
  preferredName: "Josh",
};

describe("displayNameOf", () => {
  it("prefers the display name the company configured", () => {
    expect(displayNameOf(me)).toBe("Joshua Townsend");
  });

  it("falls back to first plus last when there is no display name", () => {
    expect(displayNameOf({ ...me, displayName: null })).toBe("Joshua Townsend");
  });

  it("returns null rather than an empty string when nothing is known", () => {
    expect(displayNameOf(null)).toBeNull();
    expect(
      displayNameOf({
        firstName: null,
        lastName: null,
        displayName: null,
        preferredName: null,
      }),
    ).toBeNull();
  });
});

describe("splitName", () => {
  it("drops suffixes and credentials, which are not identity", () => {
    expect(splitName("Joshua Townsend Jr, EMT")).toEqual(["joshua", "townsend"]);
  });

  it("drops single initials, which cannot distinguish anyone", () => {
    expect(splitName("J R Townsend")).toEqual(["townsend"]);
  });

  it("strips accents so a certificate printer that cannot render them still matches", () => {
    expect(splitName("José Núñez")).toEqual(["jose", "nunez"]);
  });

  it("splits hyphenated surnames into both halves", () => {
    expect(splitName("Ana Garcia-Lopez")).toEqual(["ana", "garcia", "lopez"]);
  });
});

describe("nameParts", () => {
  it("collects every spelling the company holds, order discarded", () => {
    expect(nameParts(me)).toEqual(new Set(["joshua", "townsend", "josh"]));
  });
});

describe("comparePersonName", () => {
  it("matches a reversed, upper-cased name with an extra middle name", () => {
    expect(comparePersonName("TOWNSEND JOSHUA RUSSELL", me)).toBe("same");
  });

  it("matches the preferred name a certificate might use instead", () => {
    expect(comparePersonName("Josh Townsend", me)).toBe("same");
  });

  // From a live run: BambooHR held "Josh Townsend" while every certificate was
  // printed "TOWNSEND JOSHUA RUSSELL", so only the surname matched and the
  // person check answered "inconclusive" for every certificate in the export.
  it("matches a short first name against the full one on the certificate", () => {
    const shortForm = { ...me, firstName: "Josh", displayName: "Josh Townsend" };
    expect(comparePersonName("TOWNSEND JOSHUA RUSSELL", shortForm)).toBe("same");
  });

  it("does not let two spellings of one first name stand in for a surname", () => {
    const shortForm = { ...me, firstName: "Josh", displayName: "Josh Townsend" };
    expect(comparePersonName("JOSH JOSHUA DELGADO", shortForm)).toBe("unknown");
  });

  // BambooHR supplies the same name twice - firstName "Joshua",
  // preferredName "Josh" - and those are one component in two spellings.
  // Counting them separately let "Joshua Smith" match both and reach the
  // threshold without the surname ever appearing, clearing a colleague's
  // certificate as the employee's own.
  it("does not let two spellings of one first name clear a stranger", () => {
    const both = {
      firstName: "Joshua",
      lastName: "Townsend",
      displayName: "Joshua Townsend",
      preferredName: "Josh",
    };
    expect(comparePersonName("Joshua Smith", both)).toBe("unknown");
    // The real employee still matches, on first name plus surname.
    expect(comparePersonName("TOWNSEND JOSHUA RUSSELL", both)).toBe("same");
  });

  // "Any two components" was never a test of identity: these two people share
  // both given names and are plainly different, and a confirming verdict on
  // that is a colleague's certificate cleared as the employee's own.
  it("refuses to confirm when the surname conflicts", () => {
    const mary = {
      firstName: "Mary",
      lastName: "Smith",
      displayName: "Mary Ann Smith",
      preferredName: null,
    };
    expect(comparePersonName("Mary Ann Jones", mary)).toBe("unknown");
    expect(comparePersonName("Mary Ann Smith", mary)).toBe("same");
  });

  // A surname alone is two colleagues; a surname plus a given name is a person.
  it("needs a given name as well as the surname", () => {
    expect(comparePersonName("Townsend", me)).toBe("unknown");
    expect(comparePersonName("Joshua Townsend", me)).toBe("same");
  });

  it("keeps unrelated short names apart", () => {
    expect(comparePersonName("Mark Delgado", { ...me, firstName: "Maria" })).toBe(
      "different",
    );
  });

  it("calls an unrelated name different", () => {
    expect(comparePersonName("Maria Delgado", me)).toBe("different");
  });

  // Deliberately NOT "different": two colleagues share a surname, and a
  // warning that fires on that would be dismissed out of hand.
  it("stays unknown when only the surname is shared", () => {
    expect(comparePersonName("Rebecca Townsend", me)).toBe("unknown");
  });

  it("stays unknown when the document name could not be read", () => {
    expect(comparePersonName(null, me)).toBe("unknown");
  });

  it("stays unknown when BambooHR gave us no name to compare against", () => {
    expect(comparePersonName("TOWNSEND JOSHUA RUSSELL", null)).toBe("unknown");
  });
});
