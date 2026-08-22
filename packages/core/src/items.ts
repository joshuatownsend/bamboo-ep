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
  const id = idToString(row.id) ?? `row-${index}`;
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
  const id = idToString(record.id) ?? `record-${index}`;
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
