import type { Heading, HeadingRange, RangeHeading } from "@horizon36596/zenith-schema";
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
}

/**
 * One segment's heading, exactly as `PathBuilder.withHeading` attaches it and Pedro evaluates it.
 *
 * Two places where that differs from `packages/core/src/heading.ts`, both recorded in the ADR:
 *
 * - `linear`: the runtime splits the authored sweep by arc length and hands each piece to
 *   `Path.linear(from, to)`, but Pedro's `Interpolator.linear` takes the short way from `from` to
 *   `to` (`Angle.error`), so a piece over half a turn reverses. It is also linear in the segment's
 *   parametric t, not in arc length.
 * - `facePoint`: the runtime passes only the point, so `offsetRad` is dropped.
 * - `piecewise`: see `piecewiseSegmentHeading`.
 */
function segmentHeading(
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

/**
 * A `piecewise` heading on one segment, the way `PathBuilder.piecewiseFor` builds it: the ranges
 * that cross this segment are clipped to it, their ends are turned from the step's arc-length
 * fractions into this segment's own t through the chord table, and Pedro's `PiecewiseInterpolator`
 * picks the first range whose end is at or past t. A `linear` range turns the short way between its
 * headings at the two clipped ends, linear in the segment's t; every other mode is Pedro's own.
 */
function piecewiseSegmentHeading(
  ranges: readonly HeadingRange[],
  curve: SimCurve,
  startFraction: number,
  endFraction: number,
  fallbackRad: number,
): (t: number) => number {
  const span = endFraction - startFraction;
  const pieces: { endT: number; evaluate: (t: number) => number }[] = [];
  let previousT = 0;
  for (const range of ranges) {
    const from = Math.max(range.startT, startFraction);
    const to = Math.min(range.endT, endFraction);
    if (to <= from && !(span <= 0 && range === ranges[ranges.length - 1])) continue;
    const localFrom = span <= 0 ? 0 : parameterAtFraction(curve, (from - startFraction) / span);
    const localTo = span <= 0 ? 1 : parameterAtFraction(curve, (to - startFraction) / span);
    if (localTo <= previousT) continue;
    pieces.push({ endT: localTo, evaluate: rangeSegmentHeading(range, curve, from, to, localFrom, localTo, fallbackRad) });
    previousT = localTo;
  }
  if (pieces.length === 0) {
    const fixed = normalizeAngle(fallbackRad);
    return () => fixed;
  }
  (pieces[pieces.length - 1] as { endT: number }).endT = 1;
  return (t) => {
    const piece = pieces.find((candidate) => t <= candidate.endT) ?? (pieces[pieces.length - 1] as (typeof pieces)[number]);
    return piece.evaluate(t);
  };
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

  let travelled = 0;
  const segments: SimSegment[] = curves.map((curve, index) => {
    const startFraction = total === 0 ? 0 : travelled / total;
    travelled += lengths[index] as number;
    const endFraction = total === 0 ? 1 : travelled / total;
    return {
      curve,
      heading: segmentHeading(heading, curve, startFraction, endFraction, fallbackHeadingRad),
    };
  });

  const last = segments[segments.length - 1];
  const lastPolygon = polygons[polygons.length - 1];
  const endPoint = last?.curve.end ?? lastPolygon?.[lastPolygon.length - 1] ?? { x: 0, y: 0 };
  return {
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
