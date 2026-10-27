/**
 * Switching a marker's "At" unit keeps the number as it is, fitted to the new unit's range so a
 * switch never moves the marker far: a fraction is clamped to 0–1, a distance is never negative and
 * never longer than the path, when its length is known (W2-11 of the 0.1.2 sweep).
 */
export type MarkerUnit = "t" | "distanceIn" | "distanceFromEndIn";

export type MarkerAtValue = { t: number } | { distanceIn: number } | { distanceFromEndIn: number };

/**
 * The most a distance may be on a path `lengthIn` long, to the 0.01 in the At row shows (a 27 in
 * path the planner measures at 26.99999 in is 27.00), or undefined when the length is not known.
 */
export function markerMaxIn(lengthIn: number | null | undefined): number | undefined {
  if (lengthIn === null || lengthIn === undefined || !Number.isFinite(lengthIn)) return undefined;
  return Math.max(0, Math.round(lengthIn * 100) / 100);
}

/** The marker position that holds `value` in `unit`, fitted to that unit's range on a path `lengthIn` long. */
export function markerAtInUnit(unit: MarkerUnit, value: number, lengthIn?: number | null): MarkerAtValue {
  if (unit === "t") return { t: Math.min(1, Math.max(0, value)) };
  const max = markerMaxIn(lengthIn) ?? Number.POSITIVE_INFINITY;
  const distance = Math.min(max, Math.abs(value));
  return unit === "distanceIn" ? { distanceIn: distance } : { distanceFromEndIn: distance };
}
