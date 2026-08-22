/**
 * Filename construction and cross-platform sanitisation.
 *
 * The output folder is meant to be handed to a human reviewer at Essential
 * Personnel, so filenames are the primary UI of this app. They must be
 * readable, must never collide silently, and must survive being copied onto a
 * Windows volume - which is the strictest of the three platforms by a wide
 * margin.
 */

export const NAME_TOKENS = [
  "name",
  "completed",
  "expires",
  "category",
  "original",
] as const;

export type NameToken = (typeof NAME_TOKENS)[number];

export const DEFAULT_TEMPLATE = "{name} - {completed}";

export interface TemplateValues {
  name: string;
  completed: string | null;
  expires: string | null;
  category: string | null;
  /** Original filename stem, without extension. */
  original: string | null;
}

/**
 * Windows forbids these device names regardless of extension: `CON.pdf` is
 * still invalid. The check is case-insensitive and applies to the stem only.
 */
const RESERVED_WINDOWS_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

/** Reserve headroom for the collision suffix and the extension. */
const MAX_STEM_LENGTH = 120;

/**
 * Render a template, dropping separators around tokens that resolve to
 * nothing. Without this, a record with no completion date renders as
 * "CPR - " and every such record collides with the next.
 */
export function renderTemplate(template: string, values: TemplateValues): string {
  const resolved = template.replace(
    /\{(\w+)\}/g,
    (whole, token: string) => {
      if (!isNameToken(token)) return whole;
      return values[token] ?? "";
    },
  );
  return collapseSeparators(resolved);
}

function isNameToken(token: string): token is NameToken {
  return (NAME_TOKENS as readonly string[]).includes(token);
}

/**
 * Tidy the debris left by empty tokens: repeated separators, and separators
 * stranded at either end.
 */
function collapseSeparators(input: string): string {
  return input
    .replace(/\s+/g, " ")
    .replace(/(\s*[-_,]\s*){2,}/g, " - ")
    .replace(/^[\s\-_,]+/, "")
    .replace(/[\s\-_,]+$/, "")
    .trim();
}

/**
 * Make a string safe as a filename stem on Windows, macOS and Linux.
 * Returns "Untitled" rather than "" so a name is never absent.
 */
export function sanitizeStem(input: string): string {
  let out = input
    // Reserved on Windows; "/" also breaks paths on POSIX.
    .replace(/[<>:"/\\|?*]/g, " ")
    // C0 control characters and DEL, illegal in filenames everywhere.
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Windows silently strips trailing dots and spaces, which would turn two
  // distinct names into one file. Remove them ourselves so collision
  // detection sees the same string the filesystem will.
  out = out.replace(/[. ]+$/, "");

  if (out.length > MAX_STEM_LENGTH) {
    out = out.slice(0, MAX_STEM_LENGTH).replace(/[. ]+$/, "").trim();
  }

  if (out === "") return "Untitled";

  // A reserved device name must be escaped even with an extension appended.
  if (RESERVED_WINDOWS_NAMES.has(out.toUpperCase())) return `_${out}`;

  return out;
}

/**
 * Extract a lowercase extension (including the dot) from a filename.
 * Prefers the BambooHR `originalFileName`, since that is the only place the
 * true file type is recorded.
 */
export function extensionOf(filename: string | null | undefined): string {
  if (!filename) return "";
  const base = filename.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  const ext = base.slice(dot).toLowerCase();
  // Guard against a "version 2.1 of policy" style name being read as ".1 of policy".
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : "";
}

/** Strip the extension from a filename, leaving the stem. */
export function stemOf(filename: string | null | undefined): string | null {
  if (!filename) return null;
  const base = filename.split(/[\\/]/).pop() ?? "";
  const ext = extensionOf(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  return stem.trim() === "" ? null : stem.trim();
}

/**
 * Tracks names already assigned within one output folder and appends
 * " (2)", " (3)" ... to keep them distinct. Comparison is case-insensitive
 * because Windows and macOS default to case-insensitive filesystems - on
 * those, "CPR.pdf" and "cpr.pdf" are the same file and one would overwrite
 * the other.
 */
export class FilenameAllocator {
  private readonly taken = new Set<string>();

  constructor(existing: Iterable<string> = []) {
    for (const name of existing) this.taken.add(name.toLowerCase());
  }

  allocate(stem: string, extension: string): string {
    const safeStem = sanitizeStem(stem);
    const ext = extension.startsWith(".") || extension === "" ? extension : `.${extension}`;

    let candidate = `${safeStem}${ext}`;
    let counter = 2;
    while (this.taken.has(candidate.toLowerCase())) {
      candidate = `${safeStem} (${counter})${ext}`;
      counter++;
    }
    this.taken.add(candidate.toLowerCase());
    return candidate;
  }

  has(name: string): boolean {
    return this.taken.has(name.toLowerCase());
  }
}

/** Convenience: template + values + source filename to a final safe filename. */
export function buildFilename(args: {
  template: string;
  values: TemplateValues;
  originalFileName: string | null;
  allocator: FilenameAllocator;
}): string {
  const rendered = renderTemplate(args.template, args.values);
  const stem = rendered.trim() === "" ? (args.values.name || "Untitled") : rendered;
  return args.allocator.allocate(stem, extensionOf(args.originalFileName));
}
