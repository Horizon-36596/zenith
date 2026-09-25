import type { Heading, HeadingRange, RangeHeading } from "@horizon36596/zenith-schema";

/**
 * Pure edits on a `piecewise` heading's ranges (site/docs/file-format.md, "Piecewise heading"): turn a
 * heading into ranges, split a range at a t, move the boundary between two ranges, delete a range and
 * change one range's mode. The inspector and the canvas both call these, and every one keeps the
 * ranges covering 0 to 1 in order with no gap and no overlap, so an edit can never produce the
 * HEADING_RANGES error; only a hand-edited file can.
 *
 * t is the step's arc-length fraction, as everywhere else in a heading.
 */

type Piecewise = Extract<Heading, { mode: "piecewise" }>;

/** The narrowest range an edit may leave, as a fraction of the path. */
export const MIN_RANGE_T = 0.02;

/** Keeps t readable in the file: boundaries land on four decimals. */
const roundT = (t: number): number => Math.round(t * 10000) / 10000;

/** The heading a range holds at `t`, for a mode that does not need the geometry, else null. */
function fixedHeadingAt(range: HeadingRange, t: number): number | null {
  const inner = range.heading;
  if (inner.mode === "constant") return inner.headingRad;
  if (inner.mode === "linear") {
    const span = range.endT - range.startT;
    const local = span <= 0 ? 1 : (t - range.startT) / span;
    return inner.fromRad + (inner.toRad - inner.fromRad) * local;
  }
  return null;
}

/**
 * The same heading as one range from 0 to 1, or the heading itself when it is piecewise already.
 * A step with no heading starts as one tangent range, the editor's default mode.
 */
export function toPiecewise(heading: Heading | undefined): Piecewise {
  if (heading?.mode === "piecewise") return heading;
  const inner: RangeHeading = heading ?? { mode: "tangent" };
  return { mode: "piecewise", ranges: [{ startT: 0, endT: 1, heading: inner }] };
}

/** The range that holds `t` strictly inside it, or -1 when t is on a boundary or outside 0..1. */
export function rangeContaining(heading: Piecewise, t: number): number {
  return heading.ranges.findIndex((range) => t > range.startT && t < range.endT);
}

/**
 * Splits the range that holds `t` into two at `t`. Both halves keep the range's mode; a `linear`
 * range is cut at the heading it passes through at `t`, so the robot turns exactly as before until
 * either half is changed. Returns the heading unchanged when either half would be narrower than
 * `MIN_RANGE_T`.
 */
export function splitRange(heading: Piecewise, t: number): Piecewise {
  const at = roundT(t);
  const index = rangeContaining(heading, at);
  if (index < 0) return heading;
  const range = heading.ranges[index] as HeadingRange;
  if (at - range.startT < MIN_RANGE_T || range.endT - at < MIN_RANGE_T) return heading;
  let left: RangeHeading = range.heading;
  let right: RangeHeading = range.heading;
  if (range.heading.mode === "linear") {
    const middle = fixedHeadingAt(range, at) as number;
    left = { mode: "linear", fromRad: range.heading.fromRad, toRad: middle };
    right = { mode: "linear", fromRad: middle, toRad: range.heading.toRad };
  }
  const ranges = [
    ...heading.ranges.slice(0, index),
    { startT: range.startT, endT: at, heading: left },
    { startT: at, endT: range.endT, heading: right },
    ...heading.ranges.slice(index + 1),
  ];
  return { mode: "piecewise", ranges };
}

/**
 * Moves the boundary between range `index` and range `index + 1` to `t`, clamped so neither range
 * gets narrower than `MIN_RANGE_T`. The two ranges keep their modes and values.
 */
export function moveBoundary(heading: Piecewise, index: number, t: number): Piecewise {
  const before = heading.ranges[index];
  const after = heading.ranges[index + 1];
  if (before === undefined || after === undefined) return heading;
  const lower = before.startT + MIN_RANGE_T;
  const upper = after.endT - MIN_RANGE_T;
  if (lower > upper) return heading;
  const at = roundT(Math.min(upper, Math.max(lower, t)));
  const ranges = heading.ranges.map((range, position) => {
    if (position === index) return { ...range, endT: at };
    if (position === index + 1) return { ...range, startT: at };
    return range;
  });
  return { mode: "piecewise", ranges };
}

/**
 * Deletes range `index`; the range before it grows to cover the gap, or the one after it when it is
 * the first. The last range cannot be deleted: a piecewise heading needs one.
 */
export function deleteRange(heading: Piecewise, index: number): Piecewise {
  if (heading.ranges.length <= 1) return heading;
  const removed = heading.ranges[index];
  if (removed === undefined) return heading;
  const ranges = heading.ranges.slice();
  ranges.splice(index, 1);
  if (index === 0) {
    const next = ranges[0] as HeadingRange;
    ranges[0] = { ...next, startT: removed.startT };
  } else {
    const previous = ranges[index - 1] as HeadingRange;
    ranges[index - 1] = { ...previous, endT: removed.endT };
  }
  return { mode: "piecewise", ranges };
}

/** Replaces range `index`'s own heading, keeping where it starts and ends. */
export function setRangeHeading(heading: Piecewise, index: number, inner: RangeHeading): Piecewise {
  if (heading.ranges[index] === undefined) return heading;
  return {
    mode: "piecewise",
    ranges: heading.ranges.map((range, position) => (position === index ? { ...range, heading: inner } : range)),
  };
}

/**
 * A heading of `mode` for a range, carrying over the angle the range already holds where the new
 * mode has one: a linear range starts where the old range started and ends where it ended.
 */
export function rangeHeadingForMode(mode: RangeHeading["mode"], range: HeadingRange): RangeHeading {
  const start = fixedHeadingAt(range, range.startT) ?? 0;
  const end = fixedHeadingAt(range, range.endT) ?? start;
  switch (mode) {
    case "constant":
      return { mode: "constant", headingRad: start };
    case "linear":
      return { mode: "linear", fromRad: start, toRad: end };
    case "facePoint":
      return range.heading.mode === "facePoint" ? range.heading : { mode: "facePoint", xIn: 0, yIn: 0 };
    default:
      return { mode };
  }
}
