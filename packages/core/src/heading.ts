import type { Heading, HeadingRange, RangeHeading } from "@horizon36596/zenith-schema";
import { wrapAngle } from "./geometry/angle.js";
import type { PathGeometry } from "./geometry/path.js";
import { makeSimCurve, type SimCurve } from "./sim/curves.js";
import {
  pieceAt,
  piecewiseSegmentPieces,
  runtimeSegmentFractions,
  segmentHeading,
  type SegmentFractions,
} from "./sim/pedroPath.js";

/**
 * A path with a Bezier in it, as the runtime sees it: each segment as Pedro's curve, and each
 * segment's share of the step by the runtime's own lengths (`sim/pedroPath.ts`).
 */
interface RuntimeSegments {
  readonly curves: readonly SimCurve[];
  readonly fractions: readonly SegmentFractions[];
}

const runtimeCache = new WeakMap<PathGeometry, RuntimeSegments | null>();

/**
 * The runtime's segments for a path with at least one Bezier, or null for a path of lines only.
 *
 * The runtime turns `linear` and the linear ranges of `piecewise` linearly in each segment's own
 * parametric t (OPT-01, owner ruling 2026-10-08). On a line that parameter is the arc-length fraction
 * exactly, so a path of lines keeps the arc-length arithmetic below and does not move by even a
 * rounding error; on a Bezier the two differ, and the heading is read from the runtime's mapping.
 */
function runtimeSegments(path: PathGeometry): RuntimeSegments | null {
  const cached = runtimeCache.get(path);
  if (cached !== undefined) return cached;
  let found: RuntimeSegments | null = null;
  if (path.curves.some((curve) => curve.degree >= 2)) {
    const curves = path.curves.map((curve) => makeSimCurve(curve.points.map((point) => ({ x: point.xIn, y: point.yIn }))));
    found = { curves, fractions: runtimeSegmentFractions(curves) };
  }
  runtimeCache.set(path, found);
  return found;
}

/** How a heading function places a `linear` turn along a Bezier. */
export interface HeadingOptions {
  /**
   * `"runtime"`, the default, is what the robot does: linear in each segment's own parametric t
   * (OPT-01). `"arcLength"` is linear in the step's arc length, which is how the Pedro Visualizer
   * draws a heading and how this function read every heading before OPT-01; nothing that plans,
   * estimates or plays an auto back uses it. On a path of lines the two are the same.
   */
  along?: "runtime" | "arcLength";
}

const segmentsFor = (path: PathGeometry, options: HeadingOptions): RuntimeSegments | null =>
  options.along === "arcLength" ? null : runtimeSegments(path);

/** Reads a per-segment heading, in each segment's own parametric t, at the step's t. */
function bySegment(path: PathGeometry, perSegment: (index: number, u: number, t: number) => number): (t: number) => number {
  return (t) => {
    const at = path.segmentAt(path.distanceAt(t));
    return wrapAngle(perSegment(at.index, at.u, t));
  };
}

/** The direction of travel at t, wrapped to (-pi, pi]. */
export function tangentHeading(path: PathGeometry, t: number): number {
  let tangent = path.tangentAt(t);
  if (Math.hypot(tangent.xIn, tangent.yIn) < 1e-9) {
    // A cusp or a repeated control point: look a little way along the path instead. The sample is
    // not negated at the far end, because `tangentAt` is the derivative with respect to u and so
    // already points the way the robot is travelling wherever it is taken.
    const nudged = t < 0.5 ? Math.min(t + 1e-4, 1) : Math.max(t - 1e-4, 0);
    tangent = path.tangentAt(nudged);
  }
  return wrapAngle(Math.atan2(tangent.yIn, tangent.xIn));
}

type LinearHeading = Extract<Heading, { mode: "linear" }>;

/**
 * How far past half a turn a piece may ask before HEADING calls it reversed. Canonical form rounds
 * radians to four decimals, so the half turn the editor writes, 3.1416, is a hair over pi; either
 * way round is the same half turn to the person who wrote it, and the robot's choice is drawn.
 */
export const HALF_TURN_TOLERANCE_RAD = 1e-3;

/** Pedro's `Angle.normalizeSigned`: [-pi, pi), so an exact half turn goes clockwise, as it does on the robot. */
export const pedroSigned = (rad: number): number => {
  const wrapped = wrapAngle(rad);
  return wrapped === Math.PI ? -Math.PI : wrapped;
};

/** One segment's share of a `linear` heading, the way the robot runtime hands it to Pedro. */
export interface LinearHeadingPiece {
  /** Where the piece starts and ends along the step, as arc-length fractions. */
  startT: number;
  endT: number;
  /** The headings the runtime passes to Pedro's `Path.linear(from, to)` for this segment. */
  fromRad: number;
  toRad: number;
  /** The turn the robot actually makes over the piece: the short way from `fromRad` to `toRad`. */
  turnRad: number;
  /**
   * True when the piece asks for more than half a turn (past `HALF_TURN_TOLERANCE_RAD`), so the
   * robot turns the other way round from the one the file wrote.
   */
  reversed: boolean;
}

/**
 * The pieces of a `linear` heading, one per segment, cut exactly as
 * `robot/auto-runtime/PathBuilder.withHeading` cuts them: the sweep `toRad - fromRad` the file wrote
 * is shared out by arc length, and each segment gets `Path.linear(from, to)` over its share. Pedro's
 * `Interpolator.linear` then turns the short way, so a share of
 * more than half a turn goes the other way round on the robot. A deliberate 270 degree sweep split
 * over two segments of equal length therefore does turn 270 degrees, and the same sweep on one
 * segment turns 90 degrees the other way.
 *
 * On a path with a Bezier the shares are by the runtime's own segment lengths
 * (`runtimeSegmentFractions`), so `fromRad` and `toRad` are the numbers the runtime passes Pedro.
 */
export function linearHeadingPieces(
  heading: LinearHeading,
  path: PathGeometry,
  options: HeadingOptions = {},
): LinearHeadingPiece[] {
  const sweep = heading.toRad - heading.fromRad;
  const total = path.lengthIn;
  const runtime = segmentsFor(path, options);
  const pieces: LinearHeadingPiece[] = [];
  for (let index = 0; index + 1 < path.breaks.length; index += 1) {
    const startT = total === 0 ? 0 : (path.breaks[index] as number) / total;
    const endT = total === 0 ? 1 : (path.breaks[index + 1] as number) / total;
    const share = runtime?.fractions[index];
    const fromRad = heading.fromRad + sweep * (share === undefined ? startT : share.startFraction);
    const toRad = heading.fromRad + sweep * (share === undefined ? endT : share.endFraction);
    const turnRad = pedroSigned(toRad - fromRad);
    const reversed = Math.abs(toRad - fromRad) > Math.PI + HALF_TURN_TOLERANCE_RAD;
    pieces.push({ startT, endT, fromRad, toRad, turnRad, reversed });
  }
  return pieces;
}

/**
 * h(t) for a heading mode (site/docs/file-format.md, Heading modes). Always wrapped to (-pi, pi].
 *
 * `linear` turns the way the robot turns: each segment's share of the sweep the short way round
 * (`linearHeadingPieces`), because that is what Pedro does with the numbers the runtime gives it,
 * and the preview must show what the robot does. A share of more than half a turn is what the
 * HEADING warning points out. `tangent` and `facePoint` interpolate nothing: they read the geometry
 * at t.
 *
 * On a path with a Bezier, `linear` and the linear ranges of `piecewise` are the runtime's: linear in
 * each segment's own parametric t, not in arc length, and a piecewise range starts and ends where the
 * runtime's chord table puts it (`sim/pedroPath.ts`, OPT-01). The plan sweeps the footprint, the
 * estimator caps the speed and the ideal playback turns the robot all at those headings.
 */
export function headingFunction(heading: Heading, path: PathGeometry, options: HeadingOptions = {}): (t: number) => number {
  switch (heading.mode) {
    case "piecewise": {
      const ranges = heading.ranges;
      const inner = ranges.map((range) => rangeHeadingFunction(range, path));
      const byArcLength = (t: number): number => (inner[rangeIndexAt(ranges, t)] as (t: number) => number)(t);
      const runtime = segmentsFor(path, options);
      if (runtime === null) return byArcLength;
      const perSegment = runtime.curves.map((curve, index) => {
        const share = runtime.fractions[index] as SegmentFractions;
        return piecewiseSegmentPieces(ranges, curve, share.startFraction, share.endFraction, 0);
      });
      return bySegment(path, (index, u, t) => {
        const piece = pieceAt(perSegment[index] ?? [], u);
        if (piece === undefined) return byArcLength(t);
        // Only the linear ranges move: every other mode reads the geometry at the point, as before.
        const range = ranges[piece.rangeIndex] as HeadingRange;
        return range.heading.mode === "linear" ? piece.evaluate(u) : (inner[piece.rangeIndex] as (t: number) => number)(t);
      });
    }
    case "tangent":
      return (t) => tangentHeading(path, t);
    case "tangentReversed":
      return (t) => wrapAngle(tangentHeading(path, t) + Math.PI);
    case "constant":
      return () => wrapAngle(heading.headingRad);
    case "linear": {
      const runtime = segmentsFor(path, options);
      if (runtime !== null) {
        const perSegment = runtime.curves.map((curve, index) => {
          const share = runtime.fractions[index] as SegmentFractions;
          return segmentHeading(heading, curve, share.startFraction, share.endFraction, 0);
        });
        return bySegment(path, (index, u) => (perSegment[index] as (u: number) => number)(u));
      }
      const pieces = linearHeadingPieces(heading, path, options);
      return (t) => {
        const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
        const piece =
          pieces.find((candidate) => clamped <= candidate.endT) ?? (pieces[pieces.length - 1] as LinearHeadingPiece);
        const span = piece.endT - piece.startT;
        const local = span <= 0 ? 1 : (clamped - piece.startT) / span;
        return wrapAngle(piece.fromRad + piece.turnRad * local);
      };
    }
    case "facePoint":
      return (t) => {
        const point = path.pointAt(t);
        const bearing = Math.atan2(heading.yIn - point.yIn, heading.xIn - point.xIn);
        return wrapAngle(bearing + (heading.offsetRad ?? 0));
      };
  }
}

/**
 * The heading at arc-length fraction t of a step, for any mode: `headingFunction` for one sample.
 * Pure and cheap enough to call per frame; the ideal playback and the canvas both read it.
 */
export function headingAtT(heading: Heading, path: PathGeometry, t: number): number {
  return headingFunction(heading, path)(t);
}

/**
 * Which range of a `piecewise` heading owns t, the way Pedro's `PiecewiseInterpolator` picks one:
 * the first range whose end is at or past t (`ceilingEntry`), so a boundary belongs to the range it
 * ends. Past the last end, the last range. The ranges are taken in file order.
 */
export function rangeIndexAt(ranges: readonly HeadingRange[], t: number): number {
  for (let index = 0; index < ranges.length; index += 1) {
    if (t <= (ranges[index] as HeadingRange).endT + 1e-12) return index;
  }
  return Math.max(0, ranges.length - 1);
}

/**
 * h(t) inside one range, with t still the step's own. `linear` turns the short way from `fromRad`
 * at the range's start to `toRad` at its end, linear in arc length, which is what the runtime's range
 * interpolator does on a line; every other mode reads the whole path at t, exactly as it would
 * outside a range. On a path with a Bezier, `headingFunction` takes a linear range from the runtime's
 * per-segment mapping instead.
 */
export function rangeHeadingFunction(range: HeadingRange, path: PathGeometry): (t: number) => number {
  const heading: RangeHeading = range.heading;
  if (heading.mode !== "linear") return headingFunction(heading, path);
  const span = range.endT - range.startT;
  const turnRad = pedroSigned(heading.toRad - heading.fromRad);
  return (t) => {
    const local = span <= 0 ? 1 : Math.min(1, Math.max(0, (t - range.startT) / span));
    return wrapAngle(heading.fromRad + turnRad * local);
  };
}

/** How close two range ends must be to count as the same t. Canonical form keeps t exact. */
export const RANGE_T_TOLERANCE = 1e-6;

/**
 * What is wrong with a `piecewise` heading's ranges, in one sentence, or null when Pedro will take
 * them: they must start at 0, each start where the one before ended, each end after it starts, and
 * the last end at exactly 1 (`PiecewiseInterpolator.until` refuses a t that does not increase, and
 * `interpolate` refuses to run until the ranges reach 1).
 */
export function rangeProblem(ranges: readonly HeadingRange[]): string | null {
  if (ranges.length === 0) return "A piecewise heading needs at least one range.";
  const first = ranges[0] as HeadingRange;
  if (Math.abs(first.startT) > RANGE_T_TOLERANCE) {
    return `The first range starts at t ${String(first.startT)}; it must start at 0, or the robot has no heading before it.`;
  }
  for (const [index, range] of ranges.entries()) {
    const label = `Range ${String(index + 1)}`;
    if (range.endT <= range.startT + RANGE_T_TOLERANCE) {
      return `${label} ends at t ${String(range.endT)}, which is not after its start at ${String(range.startT)}.`;
    }
    const next = ranges[index + 1];
    if (next === undefined) continue;
    const gap = next.startT - range.endT;
    if (gap > RANGE_T_TOLERANCE) {
      return `${label} ends at t ${String(range.endT)} but range ${String(index + 2)} starts at ${String(next.startT)}, leaving a gap with no heading.`;
    }
    if (gap < -RANGE_T_TOLERANCE) {
      return `${label} ends at t ${String(range.endT)} but range ${String(index + 2)} starts earlier, at ${String(next.startT)}; ranges must not overlap.`;
    }
  }
  const last = ranges[ranges.length - 1] as HeadingRange;
  if (Math.abs(last.endT - 1) > RANGE_T_TOLERANCE) {
    return `The last range ends at t ${String(last.endT)}; it must end at 1, or the robot has no heading for the rest of the path.`;
  }
  return null;
}