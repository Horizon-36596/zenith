import { integrate } from "./quadrature.js";
import { length, type Vec2 } from "./vec.js";

/**
 * One segment: a Bezier of degree `points.length - 1`, so a line is degree 1 and a curve with one
 * control point is degree 2 (site/docs/paths-explained.md). Parameterised
 * by u in [0, 1].
 */
export interface Curve {
  readonly points: readonly Vec2[];
  readonly degree: number;
  readonly lengthIn: number;
  pointAt(u: number): Vec2;
  derivativeAt(u: number): Vec2;
  /** Arc length from 0 to u. */
  lengthAt(u: number): number;
  /** The u at a given arc length from the start, clamped to [0, 1]. */
  uAtLength(sIn: number): number;
}

/** The order of the Gauss-Legendre rule: 64 samples per segment, per the spec. */
export const QUADRATURE_ORDER = 64;

/** How finely the arc-length table divides a segment for the s -> u inverse. */
const TABLE_STEPS = 64;

const clamp01 = (u: number): number => (u < 0 ? 0 : u > 1 ? 1 : u);

function deCasteljau(points: readonly Vec2[], u: number): Vec2 {
  let current = points.slice();
  while (current.length > 1) {
    const next: Vec2[] = [];
    for (let i = 0; i + 1 < current.length; i += 1) {
      const a = current[i] as Vec2;
      const b = current[i + 1] as Vec2;
      next.push({ xIn: a.xIn + (b.xIn - a.xIn) * u, yIn: a.yIn + (b.yIn - a.yIn) * u });
    }
    current = next;
  }
  return current[0] as Vec2;
}

/** Builds a curve from its control polygon: the endpoints first and last, controls between. */
export function makeCurve(points: readonly Vec2[]): Curve {
  if (points.length < 2) throw new Error("A curve needs at least two points.");
  const degree = points.length - 1;

  // The derivative of a degree-n Bezier is a degree-(n-1) Bezier over the scaled differences.
  const derivativePoints: Vec2[] = [];
  for (let i = 0; i < degree; i += 1) {
    const a = points[i] as Vec2;
    const b = points[i + 1] as Vec2;
    derivativePoints.push({ xIn: (b.xIn - a.xIn) * degree, yIn: (b.yIn - a.yIn) * degree });
  }

  const pointAt = (u: number): Vec2 => deCasteljau(points, clamp01(u));
  const derivativeAt = (u: number): Vec2 => deCasteljau(derivativePoints, clamp01(u));
  const speed = (u: number): number => length(derivativeAt(u));

  // Cumulative arc length at TABLE_STEPS + 1 values of u, each interval integrated with the
  // 64-point rule. The table's last entry is the segment length.
  const table: number[] = [0];
  for (let i = 0; i < TABLE_STEPS; i += 1) {
    const a = i / TABLE_STEPS;
    const b = (i + 1) / TABLE_STEPS;
    table.push((table[i] as number) + integrate(speed, a, b, QUADRATURE_ORDER));
  }
  const lengthIn = table[TABLE_STEPS] as number;

  const lengthAt = (u: number): number => {
    const clamped = clamp01(u);
    const scaled = clamped * TABLE_STEPS;
    const index = Math.min(Math.floor(scaled), TABLE_STEPS - 1);
    const a = table[index] as number;
    const b = table[index + 1] as number;
    return a + (b - a) * (scaled - index);
  };

  const uAtLength = (sIn: number): number => {
    if (sIn <= 0 || lengthIn === 0) return 0;
    if (sIn >= lengthIn) return 1;
    let low = 0;
    let high = TABLE_STEPS;
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if ((table[middle] as number) <= sIn) low = middle;
      else high = middle;
    }
    const a = table[low] as number;
    const b = table[low + 1] as number;
    const within = b === a ? 0 : (sIn - a) / (b - a);
    return (low + within) / TABLE_STEPS;
  };

  return { points, degree, lengthIn, pointAt, derivativeAt, lengthAt, uAtLength };
}

/** Arc length of a curve between two parameters, by the 64-point rule directly. */
export function arcLength(curve: Curve, u0 = 0, u1 = 1): number {
  return integrate((u) => length(curve.derivativeAt(u)), u0, u1, QUADRATURE_ORDER);
}
