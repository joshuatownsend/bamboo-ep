import type { EmployeeIdentity } from "./types.js";

/**
 * Reading a person's name off a certificate and deciding whether it is the
 * same person.
 *
 * This is harder than it looks, and the real data proves it: BambooHR holds
 * "Joshua Townsend" while the certificate itself is printed "TOWNSEND JOSHUA
 * RUSSELL". Same person, no substring in common in that order, different
 * casing, an extra middle name, and reversed order. A string comparison would
 * report every certificate as belonging to someone else, and a check that
 * always cries wolf gets switched off.
 */

/** The best single name to show a human. Null when nothing was returned. */
export function displayNameOf(identity: EmployeeIdentity | null): string | null {
  if (!identity) return null;
  if (identity.displayName) return identity.displayName;
  const joined = [identity.firstName, identity.lastName].filter(Boolean).join(" ");
  return joined || identity.preferredName || null;
}

/**
 * Every name part BambooHR knows for this person, lower-cased and stripped of
 * punctuation. Order is deliberately discarded - certificates print names in
 * whatever order the issuing body prefers.
 */
export function nameParts(identity: EmployeeIdentity | null): Set<string> {
  if (!identity) return new Set();
  const words = [
    identity.firstName,
    identity.lastName,
    identity.displayName,
    identity.preferredName,
  ]
    .filter((v): v is string => Boolean(v))
    .flatMap(splitName);
  return new Set(words);
}

/**
 * Suffixes and honorifics are not identity. "Joshua Townsend Jr" and "Joshua
 * Townsend" are as likely to be the same person as not, and treating the
 * suffix as a distinguishing word would push an otherwise perfect match below
 * the threshold.
 */
const NAME_NOISE = new Set([
  "jr", "sr", "ii", "iii", "iv", "mr", "mrs", "ms", "dr", "prof",
  "emt", "rn", "lpn", "md", "phd", "nrp", "ff",
]);

export function splitName(value: string): string[] {
  return value
    .toLowerCase()
    .normalize("NFKD")
    // Combining accents are dropped so "José" and "Jose" compare equal; a
    // certificate printer that cannot render them is common enough to matter.
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z\s'-]+/g, " ")
    .split(/[\s'-]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 1 && !NAME_NOISE.has(part));
}

/**
 * Is this the same name word, allowing for the short form?
 *
 * From a live run: BambooHR held "Josh Townsend" while every certificate was
 * printed "TOWNSEND JOSHUA RUSSELL". Comparing whole words exactly matched
 * only the surname, one shared word is deliberately ruled ambiguous, and so
 * the person check returned "inconclusive" for every single certificate - the
 * check was on, and silently answering nothing.
 *
 * A prefix is the shape most short forms take (Josh/Joshua, Ben/Benjamin,
 * Chris/Christopher). Three characters is the floor: shorter, and unrelated
 * names start colliding. It does not catch every nickname - Bill/William,
 * Peggy/Margaret - and it is not meant to; those simply stay inconclusive,
 * which is the honest answer rather than a wrong one.
 */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 3 && long.startsWith(short);
}

/**
 * Group the known words into one entry per actual name component.
 *
 * Two spellings that would satisfy `sameWord` are the same component, so
 * "joshua" and "josh" collapse into one and cannot be counted twice.
 */
function componentsOf(known: ReadonlySet<string>): string[][] {
  const components: string[][] = [];
  for (const word of known) {
    const existing = components.find((component) =>
      component.some((alias) => sameWord(alias, word)),
    );
    if (existing) existing.push(word);
    else components.push([word]);
  }
  return components;
}

export type PersonMatch = "same" | "different" | "unknown";

/**
 * Compare a name printed on a document against the employee's own.
 *
 * Confirming requires the SURNAME plus at least one given name. Counting any
 * two matching components was not a test of identity at all: "Mary Ann Smith"
 * and "Mary Ann Jones" share two components and are different people, and a
 * confirming verdict on that is a colleague's certificate cleared as the
 * employee's own.
 *
 * Everything short of that is "unknown" rather than an accusation. Only a name
 * sharing NOTHING is called different - a surname changes with marriage, a
 * certificate may print given names alone, and being wrong in that direction
 * costs a warning the user dismisses, while being wrong the other way lets the
 * wrong person's document through silently.
 */
export function comparePersonName(
  printed: string | null,
  identity: EmployeeIdentity | null,
): PersonMatch {
  const known = nameParts(identity);
  if (!printed || known.size === 0) return "unknown";

  const found = new Set(splitName(printed));
  if (found.size === 0) return "unknown";

  const matches = (word: string) => [...found].some((f) => sameWord(f, word));

  // Compared in distinct name COMPONENTS, not in matched strings. BambooHR
  // supplies the same name several ways - firstName "Joshua" and
  // preferredName "Josh" - and those are one component in two spellings, which
  // must not count as two pieces of evidence.
  const surname = new Set(identity?.lastName ? splitName(identity.lastName) : []);
  const shared = componentsOf(known).filter((component) => component.some(matches));

  if (surname.size > 0) {
    const surnameAgrees = [...surname].some(matches);
    const givenNameAgrees = shared.some(
      (component) => !component.some((alias) => surname.has(alias)),
    );
    if (surnameAgrees && givenNameAgrees) return "same";
    // A shared given name with a conflicting surname is the "Mary Ann Jones"
    // case; a shared surname alone is two colleagues named Townsend. Both are
    // ambiguous, neither is proof of anyone.
    return shared.length > 0 ? "unknown" : "different";
  }

  // No surname on file. Two agreeing components is the best test available,
  // and it is weaker than the one above - which is itself a reason the probe
  // screen reports when BambooHR returned no name.
  if (shared.length >= 2) return "same";
  return shared.length === 1 ? "unknown" : "different";
}
