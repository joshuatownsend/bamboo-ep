import { addMonths, cleanDate, cleanString, idToString } from "./normalize.js";
import type {
  TrainingItem,
  WireCertificationRow,
  WireTrainingRecord,
  WireTrainingType,
} from "./types.js";

/**
 * Turning raw API rows into named, dated training items.
 *
 * The central problem: a training record contains a numeric `type` and nothing
 * else identifying. The name lives on /training/type, which a regular
 * employee's key may not be allowed to read. So naming falls through a chain,
 * and every item records WHICH link in the chain produced its name - the UI
 * shows that, so a user can see at a glance when a name is a fallback rather
 * than the real certification title.
 */

export interface BuildItemsInput {
  records: WireTrainingRecord[];
  types: Map<string, WireTrainingType>;
  certifications: WireCertificationRow[];
}

/**
 * The stand-in id for a certifications row that carries none of its own.
 *
 * `WireCertificationRow.id` is optional, and a row without one can only be
 * identified by where it sat in the response. That is a position, not an
 * identity: insert a row above it and the same key now names a different
 * certification.
 */
/**
 * Both spellings of "we had to invent this id".
 *
 * The certifications table and the training list each fall back to a position
 * when a row carries no id, and they spell it differently. Only the first was
 * being treated as positional, so a training record with no id was trusted as
 * a stable identity - the exact hazard the check exists to catch, hiding
 * behind a second name for the same thing.
 *
 * Both are listed rather than unified into one prefix: the strings appear in
 * manifests already written, and renaming them would quietly invalidate every
 * decision a member has saved.
 */
const POSITIONAL_ID_PREFIXES = ["row-", "record-"] as const;

function positionalId(index: number): string {
  return `row-${index}`;
}

function positionalRecordId(index: number): string {
  return `record-${index}`;
}

/**
 * Can this item's key be relied on across separate runs?
 *
 * Only stable keys may be remembered as user-confirmed pairings. A positional
 * key looks exactly like a real one, and a confirmed pairing bypasses scoring
 * entirely - so a reordered response would hand a saved certificate to
 * whichever certification had drifted into that slot, at full confidence and
 * with no signal that anything had changed. That is precisely the silent
 * relabelling this whole app exists to prevent.
 */
export function hasStableIdentity(item: TrainingItem): boolean {
  return isStableKey(`${item.source}:${item.id}`);
}

/**
 * The same test, against a manifest entry's `key` rather than a live item.
 *
 * Part 2 reads decisions back from a manifest written on an earlier run, and
 * has no `TrainingItem` to hand - only `${source}:${id}`. Sharing the rule
 * matters more than the convenience: two copies of "is this key trustworthy"
 * is exactly how one of them ends up not being updated.
 */
export function isStableKey(key: string): boolean {
  const separator = key.indexOf(":");
  if (separator < 0) return false;
  // Tested against the id whatever the source. A real BambooHR id is numeric,
  // so nothing legitimate begins with either prefix - and tying the check to
  // one source is how the training-record spelling was missed.
  const id = key.slice(separator + 1);
  return !POSITIONAL_ID_PREFIXES.some((prefix) => id.startsWith(prefix));
}

export function buildTrainingItems(input: BuildItemsInput): TrainingItem[] {
  return [
    ...input.certifications.map((row, index) => fromCertification(row, index)),
    ...input.records.map((record, index) => fromRecord(record, index, input.types)),
  ];
}

/**
 * The certifications table is the better source when populated: it carries a
 * real title and a real expiration date, with no lookup required.
 */
function fromCertification(row: WireCertificationRow, index: number): TrainingItem {
  const id = idToString(row.id) ?? positionalId(index);
  const title = cleanString(row.title);
  return {
    key: `certifications:${id}`,
    id,
    source: "certifications",
    name: title ?? "Untitled certification",
    nameSource: title ? "certification-title" : "placeholder",
    category: null,
    completed: cleanDate(row.completionDate),
    expires: cleanDate(row.expirationDate),
    expiresDerived: false,
    instructor: null,
    certificationNumber: cleanString(row.certificationNumber),
    notes: cleanString(row.notes),
  };
}

function fromRecord(
  record: WireTrainingRecord,
  index: number,
  types: Map<string, WireTrainingType>,
): TrainingItem {
  const id = idToString(record.id) ?? positionalRecordId(index);
  const typeId = idToString(record.type);
  const type = typeId ? types.get(typeId) : undefined;
  const typeName = cleanString(type?.name);
  const completed = cleanDate(record.completed);

  return {
    key: `training:${id}`,
    id,
    source: "training",
    // When /training/type was refused, `types` is empty and we fall back to a
    // placeholder that at least keeps the type id visible for cross-reference.
    name: typeName ?? (typeId ? `Training ${typeId}` : "Untitled training"),
    nameSource: typeName ? "training-type" : "placeholder",
    category: categoryName(type),
    completed,
    ...deriveExpiry(completed, type),
    instructor: cleanString(record.instructor),
    certificationNumber: null,
    notes: cleanString(record.notes),
  };
}

/** `category` is an object when set and an empty array when unset. */
function categoryName(type: WireTrainingType | undefined): string | null {
  const category = type?.category;
  if (!category || Array.isArray(category)) return null;
  return cleanString(category.name);
}

/**
 * Training records have no expiration field. When the type is renewable and
 * declares a frequency in months, expiry is derivable - flagged as derived so
 * the UI never presents a computed date as authoritative.
 */
function deriveExpiry(
  completed: string | null,
  type: WireTrainingType | undefined,
): { expires: string | null; expiresDerived: boolean } {
  if (!completed || !type?.renewable) return { expires: null, expiresDerived: false };
  const frequency = type.frequency;
  if (typeof frequency !== "number" || !Number.isFinite(frequency) || frequency <= 0) {
    return { expires: null, expiresDerived: false };
  }
  const expires = addMonths(completed, frequency);
  return expires ? { expires, expiresDerived: true } : { expires: null, expiresDerived: false };
}

/**
 * Upgrade an item's name using the file matched to it, when the item only ever
 * had a placeholder. A real filename beats "Training 12" for a human reviewer.
 */
export function applyFileNameFallback(
  item: TrainingItem,
  fileStem: string | null,
): TrainingItem {
  if (item.nameSource !== "placeholder" || !fileStem) return item;
  return { ...item, name: fileStem, nameSource: "file-name" };
}
