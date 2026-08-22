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

export type PersonMatch = "same" | "different" | "unknown";

/**
 * Compare a name printed on a document against the employee's own.
 *
 * The rule is: a shared SURNAME-strength word plus one more shared word means
 * the same person; any shared word at all with nothing contradicting is not
 * enough to convict but not enough to acquit either. Only a name that shares
 * nothing is called different - being wrong in that direction merely produces
 * a warning the user can dismiss, while being wrong the other way would let a
 * colleague's certificate through silently.
 */
export function comparePersonName(
  printed: string | null,
  identity: EmployeeIdentity | null,
): PersonMatch {
  const known = nameParts(identity);
  if (!printed || known.size === 0) return "unknown";

  const found = new Set(splitName(printed));
  if (found.size === 0) return "unknown";

  const shared = [...found].filter((word) => known.has(word));
  if (shared.length >= 2) return "same";

  // A single shared word is genuinely ambiguous: two colleagues named Smith
  // share a surname, and two named Joshua share a first name. Neither the
  // accusation nor the clearance is safe on that evidence.
  // An initial-only rendering ("J TOWNSEND") reduces to the surname alone,
  // which lands here rather than below - correctly, since it is ambiguous and
  // not evidence of anyone else.
  if (shared.length === 1) return "unknown";

  return "different";
}
