import type { Heading, HeadingRange, RangeHeading } from "@horizon36596/zenith-schema";
import { TURN_IN_PLACE_MAX_IN } from "../turnInPlace.js";
import { makeSimCurve, RUNTIME_LENGTH_SAMPLES, type SimCurve, type XY } from "./curves.js";

/**
 * A path step as the robot runtime hands it to Pedro: `PathBuilder.build` and `withHeading` in
 * `robot/auto-runtime` (the copy the biobuzz repository runs), then Pedro's own interpolators from
 * `paths/interpolator/Interpolator.java`. The follower advances segment by segment, the way
 * Pedro's `PathTracker` does, and each segment evaluates its heading at its own parametric t.
 */

const TWO_PI = Math.PI * 2;

/** `Angle.normalize`: into [0, 2pi). */
export function normalizeAngle(rad: number): number {
  const angle = rad % TWO_PI;
  return angle < 0 ? angle + TWO_PI : angle;
}

/** `Angle.normalizeSigned`: into [-pi, pi). */
export function normalizeSigned(rad: number): number {
  const angle = normalizeAngle(rad);
  return angle >= Math.PI ? angle - TWO_PI : angle;
}

/** `Angle.turnDirection(normalizedError)`: +1 counter-clockwise, -1 clockwise. */
export function turnDirection(error: number): number {
  return error >= 0 && error <= Math.PI ? 1 : -1;
}

/** `Vector2D.theta`: 0 for a zero vector. */
export const theta = (v: XY): number => (v.x * v.x + v.y * v.y < 1e-9 ? 0 : Math.atan2(v.y, v.x));

export interface SimSegment {
  readonly curve: SimCurve;
  /** The target heading at this segment's parametric t, in [0, 2pi) like Pedro's. */
  heading(t: number): number;
}

export interface SimPath {
  readonly segments: readonly SimSegment[];
  /** `PathBuilder.Built.segmentLengthsIn`: what the markers measure distance with. */
  readonly runtimeLengthsIn: readonly number[];
  readonly runtimeTotalIn: number;
  /** `PathTracker.endPose`: the last segment's end with its heading at t = 1. */
  readonly endPose: { x: number; y: number; heading: number };
  /** Segments dropped because they had no length, which Pedro's `Line` refuses. */
  readonly droppedSegments: number;
  /**
   * Where the runtime holds the robot instead of following, for a path no longer than
   * `TURN_IN_PLACE_MAX_IN`: `PedroPaths.Built.turn`, the end point with the step's end heading
   * (`turnHeading`), in [0, 2pi). Null for a path the follower drives.
   */
  readonly turn: { x: number; y: number; heading: number } | null;
}

/**
 * The heading a turn on the spot holds, as `PedroPaths.turnHeading` works it out without Pedro:
 * the step's heading mode at the end of its last segment. Tangent reads the last segment's end
 * direction (`P[n] - P[n-1]`, else its chord, else 0, as `Vector2D.theta` gives a zero vector);
 * Linear its `toRad`; Facing point the bearing from the end to the point; Piecewise its last range's
 * mode, a linear range turning the short way from its `fromRad`.
 */
export function turnHeading(
  polygons: readonly (readonly XY[])[],
  heading: Heading | undefined,
  fallbackRad: number,
): number {
  const last = polygons[polygons.length - 1] ?? [];
  const end = last[last.length - 1] ?? { x: 0, y: 0 };
  const before = last[last.length - 2] ?? end;
  const first = last[0] ?? end;
  const direction =
    Math.hypot(end.x - before.x, end.y - before.y) > 1e-9
      ? { x: end.x - before.x, y: end.y - before.y }
      : { x: end.x - first.x, y: end.y - first.y };
  const tangentRad = theta(direction);
  const of = (mode: RangeHeading): number => {
    switch (mode.mode) {
      case "tangent":
        return normalizeAngle(tangentRad);
      case "tangentReversed":
        return normalizeAngle(tangentRad + Math.PI);
      case "constant":
        return normalizeAngle(mode.headingRad);
      case "linear":
        return normalizeAngle(mode.toRad);
      case "facePoint":
        return normalizeAngle(theta({ x: mode.xIn - end.x, y: mode.yIn - end.y }));
    }
  };
  if (heading === undefined) return normalizeAngle(fallbackRad);
  if (heading.mode !== "piecewise") return of(heading);
  const range = heading.ranges[heading.ranges.length - 1];
  if (range === undefined) return normalizeAngle(fallbackRad);
  const inner = range.heading;
  if (inner.mode === "linear") return normalizeAngle(inner.fromRad + normalizeSigned(inner.toRad - inner.fromRad));
  return of(inner);
}

/** Where one segment starts and ends along its step, as fractions of the runtime's length. */
export interface SegmentFractions {
  readonly startFraction: number;
  readonly endFraction: number;
}

/**
 * Each segment's share of the step, as the runtime measures it: `PathBuilder.Built.segmentLengthsIn`
 * (64 chords on a Bezier, the exact length of a line) over their sum. The runtime shares a `linear`
 * sweep out by these, and turns a `piecewise` range's ends into segment t with them.
 */
export function runtimeSegmentFractions(curves: readonly SimCurve[]): SegmentFractions[] {
  const total = curves.reduce((sum, curve) => sum + curve.runtimeLengthIn, 0);
  let travelled = 0;
  return curves.map((curve) => {
    const startFraction = total === 0 ? 0 : travelled / total;
    travelled += curve.runtimeLengthIn;
    const endFraction = total === 0 ? 1 : travelled / total;
    return { startFraction, endFraction };
  });
}

/**
 * One segment's heading, exactly as `PathBuilder.withHeading` attaches it and Pedro evaluates it, as
 * a function of the segment's own parametric t. `heading.ts` reads `linear` and `piecewise` from here
 * on any path with a Bezier in it (OPT-01, owner ruling 2026-10-08), so the plan, the estimator and
 * the ideal playback turn the robot where the runtime does.
 *
 * Where the robot's heading differs from what a file might be read to say, recorded in the ADR:
 *
 * - `linear`: the runtime splits the authored sweep by arc length and hands each piece to
 *   `Path.linear(from, to)`, but Pedro's `Interpolator.linear` takes the short way from `from` to
 *   `to` (`Angle.error`), so a piece over half a turn reverses. It is also linear in the segment's
 *   parametric t, not in arc length.
 * - `facePoint`: the runtime passes only the point, so `offsetRad` is dropped.
 * - `piecewise`: see `piecewiseSegmentPieces`.
 */
export function segmentHeading(
  heading: Heading | undefined,
  curve: SimCurve,
  startFraction: number,
  endFraction: number,
  fallbackRad: number,
): (t: number) => number {
  if (heading === undefined) {
    const fixed = normalizeAngle(fallbackRad);
    return () => fixed;
  }
  switch (heading.mode) {
    case "tangent":
      return (t) => normalizeAngle(theta(curve.tangent(t)));
    case "tangentReversed":
      return (t) => normalizeAngle(theta(curve.tangent(t)) + Math.PI);
    case "constant": {
      const fixed = normalizeAngle(heading.headingRad);
      return () => fixed;
    }
    case "linear": {
      const sweep = heading.toRad - heading.fromRad;
      const from = normalizeAngle(heading.fromRad + sweep * startFraction);
      const to = normalizeAngle(heading.fromRad + sweep * endFraction);
      const delta = normalizeSigned(to - from);
      return (t) => normalizeAngle(from + delta * t);
    }
    case "facePoint": {
      const px = heading.xIn;
      const py = heading.yIn;
      return (t) => {
        const at = curve.get(t);
        return normalizeAngle(theta({ x: px - at.x, y: py - at.y }));
      };
    }
    case "piecewise":
      return piecewiseSegmentHeading(heading.ranges, curve, startFraction, endFraction, fallbackRad);
  }
}

/**
 * The segment t at which the runtime's chord table reaches `fraction` of the segment's length:
 * `PathBuilder.parameterAt`, 64 chords, linear inside a chord. Exact for a line.
 */
export function parameterAtFraction(curve: SimCurve, fraction: number): number {
  if (fraction <= 0) return 0;
  if (fraction >= 1) return 1;
  const cumulative: number[] = [0];
  let previous = curve.get(0);
  for (let index = 1; index <= RUNTIME_LENGTH_SAMPLES; index += 1) {
    const point = curve.get(index / RUNTIME_LENGTH_SAMPLES);
    cumulative.push((cumulative[index - 1] as number) + Math.hypot(point.x - previous.x, point.y - previous.y));
    previous = point;
  }
  const total = cumulative[RUNTIME_LENGTH_SAMPLES] as number;
  if (total <= 0) return fraction;
  const target = fraction * total;
  for (let index = 1; index <= RUNTIME_LENGTH_SAMPLES; index += 1) {
    const upper = cumulative[index] as number;
    if (upper >= target) {
      const lower = cumulative[index - 1] as number;
      const within = upper === lower ? 0 : (target - lower) / (upper - lower);
      return (index - 1 + within) / RUNTIME_LENGTH_SAMPLES;
    }
  }
  return 1;
}

/** One range of a `piecewise` heading as it lands on one segment. */
export interface PiecewiseSegmentPiece {
  /** Where the piece ends, in the segment's own t; the last piece ends at 1. */
  readonly endT: number;
  /** The range of the heading this piece is cut from, in file order. */
  readonly rangeIndex: number;
  /** The heading at the segment's t, in [0, 2pi) like Pedro's. */
  evaluate(t: number): number;
}

/**
 * A `piecewise` heading on one segment, the way `PathBuilder.piecewiseFor` builds it: the ranges
 * that cross this segment are clipped to it, their ends are turned from the step's arc-length
 * fractions into this segment's own t through the chord table, and Pedro's `PiecewiseInterpolator`
 * picks the first piece whose end is at or past t (`pieceAt`). A `linear` range turns the short way
 * between its headings at the two clipped ends, linear in the segment's t; every other mode is
 * Pedro's own. Empty only when no range reaches the segment, which `rangeProblem` refuses.
 */
export function piecewiseSegmentPieces(
  ranges: readonly HeadingRange[],
  curve: SimCurve,
  startFraction: number,
  endFraction: number,
  fallbackRad: number,
): PiecewiseSegmentPiece[] {
  const span = endFraction - startFraction;
  const pieces: { endT: number; rangeIndex: number; evaluate: (t: number) => number }[] = [];
  let previousT = 0;
  for (const [rangeIndex, range] of ranges.entries()) {
    const from = Math.max(range.startT, startFraction);
    const to = Math.min(range.endT, endFraction);
    if (to <= from && !(span <= 0 && range === ranges[ranges.length - 1])) continue;
    const localFrom = span <= 0 ? 0 : parameterAtFraction(curve, (from - startFraction) / span);
    const localTo = span <= 0 ? 1 : parameterAtFraction(curve, (to - startFraction) / span);
    if (localTo <= previousT) continue;
    pieces.push({
      endT: localTo,
      rangeIndex,
      evaluate: rangeSegmentHeading(range, curve, from, to, localFrom, localTo, fallbackRad),
    });
    previousT = localTo;
  }
  const last = pieces[pieces.length - 1];
  if (last !== undefined) last.endT = 1;
  return pieces;
}

/** The piece that owns a segment's t: the first whose end is at or past it, as Pedro picks one. */
export function pieceAt(pieces: readonly PiecewiseSegmentPiece[], t: number): PiecewiseSegmentPiece | undefined {
  return pieces.find((candidate) => t <= candidate.endT) ?? pieces[pieces.length - 1];
}

function piecewiseSegmentHeading(
  ranges: readonly HeadingRange[],
  curve: SimCurve,
  startFraction: number,
  endFraction: number,
  fallbackRad: number,
): (t: number) => number {
  const pieces = piecewiseSegmentPieces(ranges, curve, startFraction, endFraction, fallbackRad);
  if (pieces.length === 0) {
    const fixed = normalizeAngle(fallbackRad);
    return () => fixed;
  }
  return (t) => (pieceAt(pieces, t) as PiecewiseSegmentPiece).evaluate(t);
}

function rangeSegmentHeading(
  range: HeadingRange,
  curve: SimCurve,
  from: number,
  to: number,
  localFrom: number,
  localTo: number,
  fallbackRad: number,
): (t: number) => number {
  const inner: RangeHeading = range.heading;
  if (inner.mode !== "linear") return segmentHeading(inner, curve, 0, 1, fallbackRad);
  const rangeSpan = range.endT - range.startT;
  const turn = normalizeSigned(inner.toRad - inner.fromRad);
  const at = (fraction: number): number =>
    inner.fromRad + turn * (rangeSpan <= 0 ? 1 : (fraction - range.startT) / rangeSpan);
  const headFrom = normalizeAngle(at(from));
  const delta = at(to) - at(from);
  const localSpan = localTo - localFrom;
  return (t) => {
    const local = localSpan <= 0 ? 1 : Math.min(1, Math.max(0, (t - localFrom) / localSpan));
    return normalizeAngle(headFrom + delta * local);
  };
}

/**
 * Builds the followable path from each segment's control polygon (start, controls, end), in the
 * alliance frame the plan is in. `fallbackHeadingRad` is held when the step has no heading mode,
 * which `validate` refuses but the sim still has to drive.
 */
export function buildSimPath(
  polygons: readonly (readonly XY[])[],
  heading: Heading | undefined,
  fallbackHeadingRad: number,
): SimPath {
  const kept = polygons.filter((points) => {
    const first = points[0];
    const last = points[points.length - 1];
    if (first === undefined || last === undefined) return false;
    if (points.length > 2) return true;
    return Math.hypot(last.x - first.x, last.y - first.y) > 0;
  });
  const curves = kept.map((points) => makeSimCurve(points));
  const lengths = curves.map((curve) => curve.runtimeLengthIn);
  const total = lengths.reduce((sum, value) => sum + value, 0);

  const fractions = runtimeSegmentFractions(curves);
  const segments: SimSegment[] = curves.map((curve, index) => {
    const { startFraction, endFraction } = fractions[index] as SegmentFractions;
    return {
      curve,
      heading: segmentHeading(heading, curve, startFraction, endFraction, fallbackHeadingRad),
    };
  });

  const last = segments[segments.length - 1];
  const lastPolygon = polygons[polygons.length - 1];
  const endPoint = last?.curve.end ?? lastPolygon?.[lastPolygon.length - 1] ?? { x: 0, y: 0 };
  // The runtime measures every segment it was given, before it drops any, and holds instead of
  // following when the whole step is this short (`PedroPaths.build`).
  const turnEnd = lastPolygon?.[lastPolygon.length - 1];
  const turn =
    total <= TURN_IN_PLACE_MAX_IN && turnEnd !== undefined
      ? { x: turnEnd.x, y: turnEnd.y, heading: turnHeading(polygons, heading, fallbackHeadingRad) }
      : null;
  return {
    turn,
    segments,
    runtimeLengthsIn: lengths,
    runtimeTotalIn: total,
    endPose: {
      x: endPoint.x,
      y: endPoint.y,
      heading: last === undefined ? normalizeAngle(fallbackHeadingRad) : last.heading(1),
    },
    droppedSegments: polygons.length - kept.length,
  };
}
