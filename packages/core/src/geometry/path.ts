import { makeCurve, type Curve } from "./curve.js";
import type { Vec2 } from "./vec.js";

/**
 * A path step's geometry: a sequence of continuous segments re-parameterised by arc length to a
 * single t in [0, 1], so markers and headings mean the same thing the runtime sees
 * (site/docs/paths-explained.md).
 */
export interface PathGeometry {
  readonly curves: readonly Curve[];
  readonly lengthIn: number;
  /** Arc length at the start of each curve, plus the total as the last entry. */
  readonly breaks: readonly number[];
  pointAtDistance(sIn: number): Vec2;
  tangentAtDistance(sIn: number): Vec2;
  pointAt(t: number): Vec2;
  tangentAt(t: number): Vec2;
  /** Arc length at t. */
  distanceAt(t: number): number;
  /** t at an arc length from the start. */
  tAtDistance(sIn: number): number;
}

export const SAMPLE_SPACING_IN = 2;

export function makePath(segments: readonly (readonly Vec2[])[]): PathGeometry {
  if (segments.length === 0) throw new Error("A path needs at least one segment.");
  const curves = segments.map((points) => makeCurve(points));
  const breaks: number[] = [0];
  for (const curve of curves) breaks.push((breaks[breaks.length - 1] as number) + curve.lengthIn);
  const lengthIn = breaks[breaks.length - 1] as number;

  const locate = (sIn: number): { curve: Curve; u: number } => {
    const clamped = sIn <= 0 ? 0 : sIn >= lengthIn ? lengthIn : sIn;
    let index = 0;
    while (index + 1 < curves.length && (breaks[index + 1] as number) < clamped) index += 1;
    const curve = curves[index] as Curve;
    return { curve, u: curve.uAtLength(clamped - (breaks[index] as number)) };
  };

  const pointAtDistance = (sIn: number): Vec2 => {
    const { curve, u } = locate(sIn);
    return curve.pointAt(u);
  };
  const tangentAtDistance = (sIn: number): Vec2 => {
    const { curve, u } = locate(sIn);
    return curve.derivativeAt(u);
  };
  const distanceAt = (t: number): number => (t <= 0 ? 0 : t >= 1 ? lengthIn : t * lengthIn);
  const tAtDistance = (sIn: number): number =>
    lengthIn === 0 ? 0 : sIn <= 0 ? 0 : sIn >= lengthIn ? 1 : sIn / lengthIn;

  return {
    curves,
    lengthIn,
    breaks,
    pointAtDistance,
    tangentAtDistance,
    pointAt: (t) => pointAtDistance(distanceAt(t)),
    tangentAt: (t) => tangentAtDistance(distanceAt(t)),
    distanceAt,
    tAtDistance,
  };
}

/**
 * Sample distances along the path: every `spacingIn` inches, plus both endpoints and every segment
 * boundary, sorted and de-duplicated. The check sampler and the footprint sweep share this.
 */
export function sampleDistances(
  path: PathGeometry,
  spacingIn: number = SAMPLE_SPACING_IN,
): number[] {
  const distances: number[] = [0];
  for (let s = spacingIn; s < path.lengthIn; s += spacingIn) distances.push(s);
  for (const at of path.breaks) distances.push(at);
  distances.push(path.lengthIn);
  distances.sort((a, b) => a - b);
  const unique: number[] = [];
  for (const value of distances) {
    const previous = unique[unique.length - 1];
    if (previous === undefined || value - previous > 1e-9) unique.push(value);
  }
  return unique;
}
