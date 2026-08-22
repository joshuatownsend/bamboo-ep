import { describe, expect, it } from "vitest";
import {
  DEFAULT_TEMPLATE,
  FilenameAllocator,
  buildFilename,
  extensionOf,
  renderTemplate,
  sanitizeStem,
  stemOf,
} from "../src/naming.js";

describe("sanitizeStem", () => {
  it("strips characters Windows forbids", () => {
    expect(sanitizeStem('CPR: Level 2 <adult>')).toBe("CPR Level 2 adult");
    expect(sanitizeStem("Hazmat/Ops")).toBe("Hazmat Ops");
    expect(sanitizeStem("Q1?Report*")).toBe("Q1 Report");
  });

  it("removes control characters", () => {
    expect(sanitizeStem("CPR\u0007 BLS")).toBe("CPR BLS");
    expect(sanitizeStem("Tab\tSeparated")).toBe("Tab Separated");
  });

  it("escapes Windows reserved device names, which are invalid even with an extension", () => {
    expect(sanitizeStem("CON")).toBe("_CON");
    expect(sanitizeStem("com1")).toBe("_com1");
    expect(sanitizeStem("LPT9")).toBe("_LPT9");
    // Not reserved: only the exact device names are.
    expect(sanitizeStem("CONTROL")).toBe("CONTROL");
    expect(sanitizeStem("COM10")).toBe("COM10");
  });

  it("drops trailing dots and spaces, which Windows silently strips", () => {
    expect(sanitizeStem("Bloodborne Pathogens...")).toBe("Bloodborne Pathogens");
    expect(sanitizeStem("Trailing   ")).toBe("Trailing");
  });

  it("never returns an empty stem", () => {
    expect(sanitizeStem("")).toBe("Untitled");
    expect(sanitizeStem("///")).toBe("Untitled");
    expect(sanitizeStem("   ")).toBe("Untitled");
  });

  it("truncates very long names without leaving a trailing dot", () => {
    const long = `${"A".repeat(200)}...`;
    const result = sanitizeStem(long);
    expect(result.length).toBeLessThanOrEqual(120);
    expect(result.endsWith(".")).toBe(false);
  });
});

describe("renderTemplate", () => {
  const base = {
    name: "CPR - BLS Provider",
    completed: "2025-06-01",
    expires: "2027-06-01",
    category: "Safety",
    original: "cpr_card",
  };

  it("renders the default template", () => {
    expect(renderTemplate(DEFAULT_TEMPLATE, base)).toBe("CPR - BLS Provider - 2025-06-01");
  });

  it("drops separators stranded by an empty token", () => {
    expect(renderTemplate(DEFAULT_TEMPLATE, { ...base, completed: null })).toBe(
      "CPR - BLS Provider",
    );
  });

  it("does not leave a leading separator when the first token is empty", () => {
    expect(renderTemplate("{completed} - {name}", { ...base, completed: null })).toBe(
      "CPR - BLS Provider",
    );
  });

  it("leaves unknown tokens untouched rather than blanking them", () => {
    expect(renderTemplate("{name} {bogus}", base)).toBe("CPR - BLS Provider {bogus}");
  });

  it("supports every documented token", () => {
    expect(renderTemplate("{category}/{name}/{expires}/{original}", base)).toBe(
      "Safety/CPR - BLS Provider/2027-06-01/cpr_card",
    );
  });
});

describe("extensionOf / stemOf", () => {
  it("reads a normal extension", () => {
    expect(extensionOf("cert.PDF")).toBe(".pdf");
    expect(stemOf("cert.PDF")).toBe("cert");
  });

  it("ignores a dot that is not an extension", () => {
    expect(extensionOf("version 2.1 of the policy")).toBe("");
    expect(stemOf("version 2.1 of the policy")).toBe("version 2.1 of the policy");
  });

  it("handles missing and dotfile inputs", () => {
    expect(extensionOf(null)).toBe("");
    expect(extensionOf("noextension")).toBe("");
    expect(extensionOf(".gitignore")).toBe("");
    expect(extensionOf("trailingdot.")).toBe("");
  });
});

describe("FilenameAllocator", () => {
  it("suffixes collisions rather than overwriting", () => {
    const alloc = new FilenameAllocator();
    expect(alloc.allocate("CPR", ".pdf")).toBe("CPR.pdf");
    expect(alloc.allocate("CPR", ".pdf")).toBe("CPR (2).pdf");
    expect(alloc.allocate("CPR", ".pdf")).toBe("CPR (3).pdf");
  });

  it("treats names case-insensitively, matching Windows and macOS filesystems", () => {
    const alloc = new FilenameAllocator();
    expect(alloc.allocate("CPR", ".pdf")).toBe("CPR.pdf");
    expect(alloc.allocate("cpr", ".pdf")).toBe("cpr (2).pdf");
  });

  it("respects names reserved up front", () => {
    const alloc = new FilenameAllocator(["manifest.json"]);
    expect(alloc.allocate("manifest", ".json")).toBe("manifest (2).json");
  });

  it("normalises an extension given without a dot", () => {
    expect(new FilenameAllocator().allocate("CPR", "pdf")).toBe("CPR.pdf");
  });
});

describe("buildFilename", () => {
  it("takes the extension from the original file, not the template", () => {
    const name = buildFilename({
      template: DEFAULT_TEMPLATE,
      values: {
        name: "Bloodborne Pathogens",
        completed: "2024-03-11",
        expires: null,
        category: null,
        original: "bbp",
      },
      originalFileName: "bbp_scan.PDF",
      allocator: new FilenameAllocator(),
    });
    expect(name).toBe("Bloodborne Pathogens - 2024-03-11.pdf");
  });

  it("falls back to the certification name when the template renders empty", () => {
    const name = buildFilename({
      template: "{completed}",
      values: {
        name: "Fire Safety",
        completed: null,
        expires: null,
        category: null,
        original: null,
      },
      originalFileName: "x.pdf",
      allocator: new FilenameAllocator(),
    });
    expect(name).toBe("Fire Safety.pdf");
  });
});
