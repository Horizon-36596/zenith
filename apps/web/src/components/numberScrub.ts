/**
 * A press-and-drag across a `NumberField` (`fields.tsx`) that scrubs its value (issue #145). It is
 * kept apart from the component, and free of the DOM, so the rules can be tested on their own:
 *
 * - A press becomes a scrub only once the pointer has moved `SCRUB_DEAD_ZONE_PX` sideways. One that
 *   never does is a click, which the field turns into focus with its text selected.
 * - The scrub is measured from the edge of the dead zone it left by, so the value does not jump by
 *   the dead zone when it starts.
 * - Every value it writes is rounded to the decimals the field shows. A pixel is a quarter of a step,
 *   so without that an 8 px drag on Holds at start (step 1, no decimals) wrote 5.25 pieces under a
 *   field that showed 5, and a Speed fraction kept 0.3625 under 0.36 in the file and the code. At the
 *   point it started from, the value is the one from the press, exactly as it was.
 * - The whole scrub is one store transaction, so it is one undo step. It closes without the tour's
 *   "pointDragged" signal, because the tour's first stop asks for a drag on the field, not this.
 * - `cancel` (Esc) puts the value from the press back and leaves no undo step.
 */
import { beginTransaction, cancelTransaction, endTransaction } from "../state/store";
import { clampToRange, roundToDigits, steppedValue, type NumberRange } from "./numberStep";

/** How far the pointer moves sideways before a press on a number field is a scrub, not a click. */
export const SCRUB_DEAD_ZONE_PX = 3;

/** How many pixels of scrub move a number field by one step, unless the field sets its own. */
export const SCRUB_PX_PER_STEP = 4;

/**
 * The pixels of scrub per step for a field: its own `scrubPxPerStep` when it sets one, one degree
 * per pixel for an angle (unit °, whose arrow-key step is 5°), and `SCRUB_PX_PER_STEP` otherwise.
 */
export function scrubPxPerStepFor(unit: string | undefined, step: number, own?: number): number {
  if (own !== undefined) return own;
  return unit === "°" ? step : SCRUB_PX_PER_STEP;
}

export interface ScrubSpec {
  /** Where the press began, in client pixels. */
  x: number;
  /** The value the scrub moves from: the field's value, or its `emptyStart` while it is empty. */
  from: number;
  /** True when the field was empty at the press. */
  fromEmpty: boolean;
  /** How far one step moves the value. */
  step: number;
  /** How many pixels of scrub make one step (`scrubPxPerStepFor`). */
  pxPerStep: number;
  /** How many decimals the field shows. Every value the scrub writes is rounded to it. */
  digits: number;
  range: NumberRange;
  /** True when the field can be emptied, so a scrub that began on it empty can empty it again. */
  nullable: boolean;
  /** Writes a value to the field, or null to empty it. */
  write: (value: number | null) => void;
}

export interface Scrub {
  /** True once the pointer has left the dead zone. */
  readonly started: boolean;
  /**
   * The pointer at `x`, with Shift's 4 or Alt's 0.25 as `factor`. Returns true for the move that
   * leaves the dead zone and so starts the scrub, which is when the field captures the pointer.
   */
  move(x: number, factor?: number): boolean;
  /** The press ends. Returns true when it was a scrub and false when it was a click. */
  finish(): boolean;
  /** Esc: puts the value from the press back and ends the scrub with no undo step. */
  cancel(): void;
}

export function startScrub(spec: ScrubSpec): Scrub {
  const start = spec.fromEmpty ? null : spec.from;
  let origin = spec.x;
  let started = false;
  let done = false;
  // The value last written, so a frame that lands on it again writes nothing.
  let last: number | null = start;

  const write = (value: number | null): void => {
    last = value;
    spec.write(value);
  };

  return {
    get started() {
      return started;
    },
    move(x, factor = 1) {
      if (done) return false;
      let startedNow = false;
      if (!started) {
        const dx = x - origin;
        if (Math.abs(dx) < SCRUB_DEAD_ZONE_PX) return false;
        started = true;
        startedNow = true;
        origin += Math.sign(dx) * SCRUB_DEAD_ZONE_PX;
        beginTransaction();
      }
      const delta = ((x - origin) / spec.pxPerStep) * spec.step * factor;
      const stepped = steppedValue(spec.from, delta, spec.range, spec.fromEmpty);
      // Rounded to the field's decimals and held to the range again, for a range end with more
      // decimals than the field shows. Where the scrub started it is the value from the press as it
      // was, so a heading of 3.1416 rad, which shows 180.0°, is not rewritten as π before it moves.
      const next =
        stepped === null || delta === 0 ? stepped : clampToRange(roundToDigits(stepped, spec.digits), spec.range);
      if (next !== null) {
        if (next !== last) write(next);
      } else if (spec.nullable && last !== null) {
        // A scrub that began on the empty field and is back below its floor: empty it again, once.
        write(null);
      }
      return startedNow;
    },
    finish() {
      if (!done) {
        done = true;
        if (started) endTransaction({ tourSignal: false });
      }
      return started;
    },
    cancel() {
      if (done) return;
      done = true;
      if (!started) return;
      // Written back first for a field that keeps its value outside the auto, such as robot.json;
      // the cancelled transaction then puts the auto and its redo stack back exactly.
      if (last !== start && (start !== null || spec.nullable)) write(start);
      cancelTransaction();
    },
  };
}
