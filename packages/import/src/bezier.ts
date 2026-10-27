import { MAX_BEZIER_CONTROL_POINTS } from "@horizon36596/zenith-schema";

/** A point in field-frame inches. */
export interface Point {
  xIn: number;
  yIn: number;
}

/**
 * How far a replacement curve may stray from the curve it replaces, in inches. It is a tenth of the
 * half inch allowed between an import and the planner's own path, so rounding on save
 * and this approximation together stay well inside it.
 */
export const APPROXIMATION_TOLERANCE_IN = 0.05;

/** The point at parameter u of the Bézier with control polygon `points` (de Casteljau). */
export function bezierPoint(points: readonly Point[], u: number): Point {
  let current = points.slice();
  while (current.length > 1) {
    const next: Point[] = [];
    for (let i = 0; i + 1 < current.length; i += 1) {
      const a = current[i] as Point;
      const b = current[i + 1] as Point;
      next.push({ xIn: a.xIn + (b.xIn - a.xIn) * u, yIn: a.yIn + (b.yIn - a.yIn) * u });
    }
    current = next;
  }
  return current[0] as Point;
}

/** The derivative with respect to u, in inches per unit of u. */
export function bezierDerivative(points: readonly Point[], u: number): Point {
  const degree = points.length - 1;
  if (degree < 1) return { xIn: 0, yIn: 0 };
  const differences: Point[] = [];
  for (let i = 0; i < degree; i += 1) {
    const a = points[i] as Point;
    const b = points[i + 1] as Point;
    differences.push({ xIn: (b.xIn - a.xIn) * degree, yIn: (b.yIn - a.yIn) * degree });
  }
  return bezierPoint(differences, u);
}

/**
 * The same curve as control polygons of at most `maxControls` interior points each.
 *
 * A polygon that already fits is returned as it is, so the result is exact. A higher degree cannot be
 * written exactly with fewer control points, so it is cut into equal stretches of u and each is
 * replaced by the cubic with the same end points and the same end derivatives (a cubic Hermite
 * piece), doubling the number of pieces until every one is within `toleranceIn` of the original at
 * every sample. The distance is measured between points at the same parameter, which bounds the
 * distance between the two curves from above.
 */
export function reduceDegree(
  points: readonly Point[],
  maxControls: number = MAX_BEZIER_CONTROL_POINTS,
  toleranceIn: number = APPROXIMATION_TOLERANCE_IN,
): { polygons: Point[][]; maxErrorIn: number } {
  if (points.length - 2 <= maxControls) return { polygons: [points.slice()], maxErrorIn: 0 };
  let best: { polygons: Point[][]; maxErrorIn: number } | null = null;
  for (let pieces = 1; pieces <= 256; pieces *= 2) {
    const polygons: Point[][] = [];
    let maxErrorIn = 0;
    for (let k = 0; k < pieces; k += 1) {
      const u0 = k / pieces;
      const u1 = (k + 1) / pieces;
      const span = u1 - u0;
      const p0 = bezierPoint(points, u0);
      const p3 = bezierPoint(points, u1);
      const d0 = bezierDerivative(points, u0);
      const d3 = bezierDerivative(points, u1);
      const cubic: Point[] = [
        p0,
        { xIn: p0.xIn + (d0.xIn * span) / 3, yIn: p0.yIn + (d0.yIn * span) / 3 },
        { xIn: p3.xIn - (d3.xIn * span) / 3, yIn: p3.yIn - (d3.yIn * span) / 3 },
        p3,
      ];
      for (let i = 1; i < 16; i += 1) {
        const s = i / 16;
        const a = bezierPoint(cubic, s);
        const b = bezierPoint(points, u0 + s * span);
        maxErrorIn = Math.max(maxErrorIn, Math.hypot(a.xIn - b.xIn, a.yIn - b.yIn));
      }
      polygons.push(cubic);
    }
    best = { polygons, maxErrorIn };
    if (maxErrorIn <= toleranceIn) break;
  }
  return best as { polygons: Point[][]; maxErrorIn: number };
}

/**
 * The control polygon of the single Bézier that passes through every one of `through`, reached at
 * evenly spaced parameters, which is what Pedro's `BezierCurve.through` builds (ADR 0008 section 1):
 * solve the Bernstein matrix at u = i / (n - 1) for the control points.
 */
export function interpolateThrough(through: readonly Point[]): Point[] {
  const n = through.length;
  if (n <= 2) return through.slice();
  const degree = n - 1;
  const binomial = (k: number): number => {
    let value = 1;
    for (let i = 1; i <= k; i += 1) value = (value * (degree - k + i)) / i;
    return value;
  };
  // Rows are the n parameters, columns the n Bernstein basis polynomials.
  const matrix: number[][] = [];
  for (let i = 0; i < n; i += 1) {
    const u = i / degree;
    const row: number[] = [];
    for (let j = 0; j <= degree; j += 1) row.push(binomial(j) * u ** j * (1 - u) ** (degree - j));
    matrix.push(row);
  }
  const xs = solve(matrix, through.map((point) => point.xIn));
  const ys = solve(matrix, through.map((point) => point.yIn));
  return xs.map((xIn, i) => ({ xIn, yIn: ys[i] as number }));
}

/** Gaussian elimination with partial pivoting; the matrix is small (a handful of points). */
function solve(matrix: readonly number[][], rhs: readonly number[]): number[] {
  const n = rhs.length;
  const a = matrix.map((row, i) => [...row, rhs[i] as number]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs((a[row] as number[])[col] as number) > Math.abs((a[pivot] as number[])[col] as number)) pivot = row;
    }
    [a[col], a[pivot]] = [a[pivot] as number[], a[col] as number[]];
    const top = a[col] as number[];
    const lead = top[col] as number;
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const current = a[row] as number[];
      const factor = (current[col] as number) / lead;
      for (let k = col; k <= n; k += 1) current[k] = (current[k] as number) - factor * (top[k] as number);
    }
  }
  return a.map((row, i) => (row[n] as number) / (row[i] as number));
}
