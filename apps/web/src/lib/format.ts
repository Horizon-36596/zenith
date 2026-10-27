/**
 * Number formatting for the UI. Files are inches, radians and seconds (CLAUDE.md rule 3); the UI
 * shows inches and seconds as written and degrees instead of radians, converting at this boundary.
 */
import { radToDeg, degToRad } from "@horizon36596/zenith-core";

/** Inches, two decimals, so a 28 px row never reflows as a value updates. */
export const inches = (value: number): string => value.toFixed(2);

/**
 * Degrees, one decimal, wrapped into (-180, 180] after rounding, so a value just past -180 that rounds
 * to it reads `180.0` as the Inspector's heading does (issue #498), and never `-0.0`.
 */
export function degrees(radians: number): string {
  const deg = radToDeg(radians);
  let tenths = Math.round((((((deg + 180) % 360) + 360) % 360) - 180) * 10);
  if (tenths <= -1800) tenths += 3600;
  if (tenths === 0) tenths = 0;
  return (tenths / 10).toFixed(1);
}

export const seconds = (value: number): string => value.toFixed(2);

export const toDegrees = radToDeg;
export const toRadians = degToRad;

/** A duration for a bar label or a total: `2.41 s`, or an em dash when nothing is known. */
export const durationOrDash = (value: number | null | undefined): string =>
  value === null || value === undefined ? "—" : `${seconds(value)}`;

/**
 * A count with its noun, singular for exactly one: `1 auto`, `3 autos`, `0 autos`. Pass `many` for a
 * noun whose plural is not the singular with an s.
 */
export const countOf = (count: number, one: string, many = `${one}s`): string =>
  `${String(count)} ${count === 1 ? one : many}`;

/** Parses a number typed into an input, returning null rather than NaN. */
export function parseNumber(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed === "-" || trimmed === "." || trimmed === "-.") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** The narrowest a step's rename field gets, in `ch`, so even a one-letter name has room to type. */
export const RENAME_FIELD_MIN_CH = 10;

/**
 * How wide a rename field must be, in `ch`, to show `text` whole: its length plus room for the
 * caret, never under `RENAME_FIELD_MIN_CH`. The field still stops at the row's edge and scrolls.
 */
export const renameFieldCh = (text: string): number => Math.max(RENAME_FIELD_MIN_CH, text.length + 2);
