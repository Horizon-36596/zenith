/**
 * Number formatting for the UI. Files are inches, radians and seconds (CLAUDE.md rule 3); the UI
 * shows inches and seconds as written and degrees instead of radians, converting at this boundary.
 */
import { radToDeg, degToRad } from "@horizon36596/zenith-core";

/** Inches, two decimals, so a 28 px row never reflows as a value updates. */
export const inches = (value: number): string => value.toFixed(2);

/** Degrees, one decimal, wrapped into (-180, 180]. */
export function degrees(radians: number): string {
  const deg = radToDeg(radians);
  const wrapped = ((((deg + 180) % 360) + 360) % 360) - 180;
  return (wrapped === -180 ? 180 : wrapped).toFixed(1);
}

export const seconds = (value: number): string => value.toFixed(2);

export const toDegrees = radToDeg;
export const toRadians = degToRad;

/** A duration for a bar label or a total: `2.41 s`, or an em dash when nothing is known. */
export const durationOrDash = (value: number | null | undefined): string =>
  value === null || value === undefined ? "—" : `${seconds(value)}`;

/** Parses a number typed into an input, returning null rather than NaN. */
export function parseNumber(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed === "-" || trimmed === "." || trimmed === "-.") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}
