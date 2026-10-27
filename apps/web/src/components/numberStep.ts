/**
 * Where an arrow press or a drag takes a `NumberField` (`fields.tsx`). It is kept apart from the
 * component so the rule for an empty field can be tested on its own.
 */

/** The values a number field accepts; either end may be open. */
export interface NumberRange {
  min?: number;
  max?: number;
}

/** Holds a value to the field's range. */
export function clampToRange(value: number, { min, max }: NumberRange): number {
  const low = min === undefined ? value : Math.max(min, value);
  return max === undefined ? low : Math.min(max, low);
}

/**
 * `value` rounded to `digits` decimals, which is all a field that shows `digits` decimals can show.
 * A half rounds away from zero, as `toFixed` shows it, so a scrub to the left mirrors one to the
 * right, and a result of zero is 0, never -0.
 */
export function roundToDigits(value: number, digits: number): number {
  const scale = 10 ** digits;
  const rounded = (Math.sign(value) * Math.round(Math.abs(value) * scale)) / scale;
  return rounded === 0 ? 0 : rounded;
}

/**
 * The value a move of `delta` from `start` gives, held to the field's range, or null when the move
 * leaves the field empty. `start` is the field's value, or its `emptyStart` while it is empty, and
 * `startedEmpty` says the move began on an empty field.
 *
 * An empty start below the range, as a Timeout's 0 sits below its 0.01 s floor, is not a value the
 * field can hold. A move from it that lands below the floor therefore leaves the field empty rather
 * than writing the floor: held to the floor, ArrowDown on a Timeout that shows "none" wrote 0.01 s
 * and cut the step short after 10 ms. The same rule puts the field back to empty when a drag that
 * began on it goes right and then back past where it started. An empty start inside the range is a
 * value the field can hold, so a move from an empty Speed's 0.80 default is clamped like any other:
 * ArrowDown gives 0.75, and a long drag to the left stops at the floor.
 */
export function steppedValue(
  start: number,
  delta: number,
  range: NumberRange,
  startedEmpty: boolean,
): number | null {
  const next = start + delta;
  const { min } = range;
  if (startedEmpty && min !== undefined && start < min && next < min) return null;
  return clampToRange(next, range);
}

/**
 * Where an arrow press takes the field: `steppedValue`, rounded to the field's `digits` and held to
 * its range again, as a drag's value is (`numberScrub.ts`). Without the rounding three Up presses
 * from a speed of 0.30 wrote 0.44999999999999996 to the file while the field showed 0.45 (issue #314).
 */
export function arrowValue(
  start: number,
  delta: number,
  range: NumberRange,
  startedEmpty: boolean,
  digits: number,
): number | null {
  const stepped = steppedValue(start, delta, range, startedEmpty);
  return stepped === null ? null : clampToRange(roundToDigits(stepped, digits), range);
}

/**
 * Whether a commit of the field's text, on Enter or a blur, writes anything. Only text the user
 * typed since the last commit does, and only when it differs from what the field showed. A field
 * shows its value rounded to its decimals, so writing back untouched text would replace the stored
 * number with that rounding: Enter on a heading of 1.3 rad shown as 74° wrote 1.2915 rad, and on an
 * x of -40.25 shown as -40.3 wrote -40.3, each as a new undo step and keeping the number's label
 * (issue #245). `shown` is the text the field shows for its current value.
 */
export function commitWrites(raw: string, shown: string, typed: boolean): boolean {
  return typed && raw.trim() !== shown;
}

/**
 * Where an arrow press starts from: the number typed into the field and not yet committed when
 * there is one, otherwise the field's value, or its `emptyStart` while it is empty. Stepping from the
 * stored value while the field showed typed text wrote a number the field never showed, and the blur
 * that followed wrote the typed text over it as a second undo step. `typed` is the parsed text, or
 * null when nothing that changes the value was typed (or the text is not a number). Null when there
 * is nowhere to start: an empty field with no `emptyStart`.
 */
export function arrowStart(
  value: number | null,
  emptyStart: number | undefined,
  typed: number | null,
): { from: number; startedEmpty: boolean } | null {
  if (typed !== null) return { from: typed, startedEmpty: false };
  const from = value ?? emptyStart;
  return from === undefined ? null : { from, startedEmpty: value === null };
}

/** Whether `value` lies inside the field's range, both ends included. */
export const inRange = (value: number, { min, max }: NumberRange): boolean =>
  (min === undefined || value >= min) && (max === undefined || value <= max);

/** A range end as the field would show it, without the zeros its decimals pad it with: 30, 0.1. */
const endText = (value: number, digits: number): string => String(Number(value.toFixed(digits)));

/**
 * The field's range in words, with its unit: `1 to 100%`, `0.1 in/s or more`, `30 s or less`, or
 * null for a field open at both ends. The degree sign and `%` sit tight against the number, as the
 * field shows them; other units keep their space (UI_GUIDE section 9.5).
 */
export function rangeWords({ min, max }: NumberRange, unit: string | undefined, digits: number): string | null {
  const tight = unit === "°" || unit === "%";
  const withUnit = (value: number): string =>
    unit === undefined || unit === "" ? endText(value, digits) : `${endText(value, digits)}${tight ? "" : " "}${unit}`;
  if (min !== undefined && max !== undefined) return `${endText(min, digits)} to ${withUnit(max)}`;
  if (min !== undefined) return `${withUnit(min)} or more`;
  if (max !== undefined) return `${withUnit(max)} or less`;
  return null;
}

/**
 * What the status line says when a number field refuses what was typed (issue #502): the field's
 * range, `Speed runs 1 to 100%.`, or, for text that is not a number, `Speed takes a number from 1
 * to 100%.` The field keeps the value it had; it never writes the nearest end in silence.
 */
export function refusedNumberLine(
  label: string,
  range: NumberRange,
  unit: string | undefined,
  digits: number,
  notANumber: boolean,
): string {
  const words = rangeWords(range, unit, digits);
  if (notANumber) {
    if (words === null) return `${label} takes a number.`;
    return range.min !== undefined && range.max !== undefined ? `${label} takes a number from ${words}.` : `${label} takes a number, ${words}.`;
  }
  if (words === null) return `${label} takes a number.`;
  return range.min !== undefined && range.max !== undefined ? `${label} runs ${words}.` : `${label} takes ${words}.`;
}

/** The sentence a number field's tooltip ends with, naming its range: `Runs 1 to 100%.`, or null. */
export function rangeHint(range: NumberRange, unit: string | undefined, digits: number): string | null {
  const words = rangeWords(range, unit, digits);
  if (words === null) return null;
  return range.min !== undefined && range.max !== undefined ? `Runs ${words}.` : `Takes ${words}.`;
}
