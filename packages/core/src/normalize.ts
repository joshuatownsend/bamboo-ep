import type { BambooCollection, WireId } from "./types.js";

/**
 * BambooHR list endpoints return an object keyed by record id when there is
 * data, but a bare empty array when there is not. Several endpoints also
 * occasionally return a populated array. Every caller funnels through here so
 * that inconsistency is handled exactly once.
 */
export function toArray<T>(collection: BambooCollection<T> | null | undefined): T[] {
  if (collection == null) return [];
  if (Array.isArray(collection)) return collection;
  if (typeof collection !== "object") return [];
  return Object.values(collection).filter((v): v is T => v != null);
}

/** Ids arrive as strings on read and numbers on write; normalise to string. */
export function idToString(id: WireId | null | undefined): string | null {
  if (id == null) return null;
  const s = String(id).trim();
  return s === "" ? null : s;
}

/** Trim to a non-empty string, or null. Collapses BambooHR's "" and null. */
export function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Parse a numeric field that may arrive as a string, or as "" / null. */
export function cleanNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  // Number("") is 0, which would turn "size unknown" into "0 bytes".
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/**
 * BambooHR dates are `YYYY-MM-DD` for date fields and `YYYY-MM-DD HH:MM:SS`
 * for timestamps. Normalise both to `YYYY-MM-DD`, rejecting the `0000-00-00`
 * sentinel it uses for "unset".
 */
export function cleanDate(value: unknown): string | null {
  const s = cleanString(value);
  if (!s) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!match) return null;
  const [, y, m, d] = match;
  if (y === "0000" || m === "00" || d === "00") return null;
  return `${y}-${m}-${d}`;
}

/**
 * Add a whole number of months to a `YYYY-MM-DD` date, clamping the day when
 * the target month is shorter (31 Jan + 1 month => 28/29 Feb, not 3 Mar).
 * Used to derive a training's expiry from `completed` + type `frequency`.
 */
export function addMonths(date: string, months: number): string | null {
  const clean = cleanDate(date);
  if (!clean || !Number.isFinite(months)) return null;
  const [y, m, d] = clean.split("-").map(Number) as [number, number, number];

  const zeroBased = m - 1 + months;
  const targetYear = y + Math.floor(zeroBased / 12);
  const targetMonth = ((zeroBased % 12) + 12) % 12;

  const daysInTarget = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const day = Math.min(d, daysInTarget);

  const pad = (n: number) => String(n).padStart(2, "0");
  return `${targetYear}-${pad(targetMonth + 1)}-${pad(day)}`;
}
