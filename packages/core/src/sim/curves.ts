/**
 * Pedro Pathing v3's two curve kinds, as the follower sees them: `paths/curves/Line.java` and
 * `paths/curves/bezier/BezierCurve.java` in core-3.0.0-20260828.185437-17. The closest-point search
 * is Pedro's own (a coarse grid, then Newton on the squared distance), because where the follower
 * thinks it is on the path decides everything it does next, and a better search would be a
 * different follower.
 *
 * Written for speed, since the follower calls these several times a tick: the Bezier is kept in
 * power-basis coefficients (Pedro caches the same product of its characteristic matrix and control
 * points) and evaluated by Horner's rule.
 */

export interface XY {
  x: number;
  y: number;
}

/** The chords the arc-length table is built from. Pedro subdivides adaptively to 1e-5 in. */
const LENGTH_TABLE_STEPS = 256;

/** `PathBuilder.SAMPLES_PER_SEGMENT`: the runtime's own segment lengths, which markers use. */
export const RUNTIME_LENGTH_SAMPLES = 64;

/** Newton iterations in `BezierCurve.closestT` (`SEARCH_LIMIT`). */
const SEARCH_LIMIT = 10;

/** The grid `BezierCurve.closestT` starts from, before its initial guess is added. */
const SEARCH_GRID = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];

const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);

export interface SimCurve {
  readonly start: XY;
  readonly end: XY;
  /** Pedro's `length()`. */
  readonly lengthIn: number;
  /** The length `PathBuilder.arcLengthIn` gives the runtime, by 64 chords. */
  readonly runtimeLengthIn: number;
  get(t: number): XY;
  derivative(t: number): XY;
  /** Unit tangent. Pedro throws on a zero derivative; this falls back to the chord. */
  tangent(t: number): XY;
  closestT(x: number, y: number, initialGuess: number): number;
  remainingDistance(t: number): number;
}

/** Binomial coefficient, as `Utils.binomial`. */
function binomial(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  const kk = Math.min(k, n - k);
  let result = 1;
  for (let i = 1; i <= kk; i += 1) result = (result * (n - (kk - i))) / i;
  return result;
}

function unit(dx: number, dy: number, fallback: XY): XY {
  const length = Math.hypot(dx, dy);
  if (length * length < 1e-9) return fallback;
  return { x: dx / length, y: dy / length };
}

export function makeLine(start: XY, end: XY): SimCurve {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthIn = Math.hypot(dx, dy);
  const lengthSquared = dx * dx + dy * dy;
  const tangentVector = lengthIn === 0 ? { x: 1, y: 0 } : { x: dx / lengthIn, y: dy / lengthIn };
  return {
    start,
    end,
    lengthIn,
    runtimeLengthIn: lengthIn,
    get: (t) => ({ x: start.x + dx * t, y: start.y + dy * t }),
    derivative: () => ({ x: dx, y: dy }),
    tangent: () => tangentVector,
    closestT: (x, y) =>
      lengthSquared === 0 ? 0 : clamp01((dx * (x - start.x) + dy * (y - start.y)) / lengthSquared),
    remainingDistance: (t) => (1 - t) * lengthIn,
  };
}

/** A Bezier of any degree from its control polygon, start and end included. */
export function makeBezier(points: readonly XY[]): SimCurve {
  const n = points.length - 1;
  // Power-basis coefficients: B(u) = sum_j c_j u^j with
  // c_j = C(n, j) * sum_{i <= j} (-1)^(j - i) C(j, i) P_i.
  const cx = new Float64Array(n + 1);
  const cy = new Float64Array(n + 1);
  for (let j = 0; j <= n; j += 1) {
    let sx = 0;
    let sy = 0;
    for (let i = 0; i <= j; i += 1) {
      const sign = (j - i) % 2 === 0 ? 1 : -1;
      const weight = sign * binomial(j, i);
      const point = points[i] as XY;
      sx += weight * point.x;
      sy += weight * point.y;
    }
    const scale = binomial(n, j);
    cx[j] = scale * sx;
    cy[j] = scale * sy;
  }
  const dcx = new Float64Array(Math.max(n, 1));
  const dcy = new Float64Array(Math.max(n, 1));
  for (let j = 1; j <= n; j += 1) {
    dcx[j - 1] = j * (cx[j] as number);
    dcy[j - 1] = j * (cy[j] as number);
  }
  const ddcx = new Float64Array(Math.max(n - 1, 1));
  const ddcy = new Float64Array(Math.max(n - 1, 1));
  for (let j = 2; j <= n; j += 1) {
    ddcx[j - 2] = j * (j - 1) * (cx[j] as number);
    ddcy[j - 2] = j * (j - 1) * (cy[j] as number);
  }

  const horner = (c: Float64Array, degree: number, u: number): number => {
    let value = c[degree] as number;
    for (let j = degree - 1; j >= 0; j -= 1) value = value * u + (c[j] as number);
    return value;
  };
  const px = (u: number): number => horner(cx, n, u);
  const py = (u: number): number => horner(cy, n, u);
  const dx = (u: number): number => horner(dcx, n - 1, u);
  const dy = (u: number): number => horner(dcy, n - 1, u);
  const ddx = (u: number): number => (n < 2 ? 0 : horner(ddcx, n - 2, u));
  const ddy = (u: number): number => (n < 2 ? 0 : horner(ddcy, n - 2, u));

  const start = points[0] as XY;
  const end = points[n] as XY;
  const chord = unit(end.x - start.x, end.y - start.y, { x: 1, y: 0 });

  // Cumulative chord length at LENGTH_TABLE_STEPS + 1 values of t, the stand-in for Pedro's
  // adaptive completion map.
  const table = new Float64Array(LENGTH_TABLE_STEPS + 1);
  let previousX = start.x;
  let previousY = start.y;
  for (let i = 1; i <= LENGTH_TABLE_STEPS; i += 1) {
    const u = i / LENGTH_TABLE_STEPS;
    const x = px(u);
    const y = py(u);
    table[i] = (table[i - 1] as number) + Math.hypot(x - previousX, y - previousY);
    previousX = x;
    previousY = y;
  }
  const lengthIn = table[LENGTH_TABLE_STEPS] as number;

  let runtimeLengthIn = 0;
  previousX = start.x;
  previousY = start.y;
  for (let i = 1; i <= RUNTIME_LENGTH_SAMPLES; i += 1) {
    const u = i / RUNTIME_LENGTH_SAMPLES;
    const x = px(u);
    const y = py(u);
    runtimeLengthIn += Math.hypot(x - previousX, y - previousY);
    previousX = x;
    previousY = y;
  }

  const lengthAt = (t: number): number => {
    const scaled = clamp01(t) * LENGTH_TABLE_STEPS;
    const index = Math.min(Math.floor(scaled), LENGTH_TABLE_STEPS - 1);
    const a = table[index] as number;
    const b = table[index + 1] as number;
    return a + (b - a) * (scaled - index);
  };

  const closestT = (x: number, y: number, initialGuess: number): number => {
    let best = 1e18;
    let guess = 0;
    for (let i = 0; i <= SEARCH_GRID.length; i += 1) {
      const t = i < SEARCH_GRID.length ? (SEARCH_GRID[i] as number) : initialGuess;
      const ex = px(t) - x;
      const ey = py(t) - y;
      const d = ex * ex + ey * ey;
      if (d < best) {
        best = d;
        guess = t;
      }
    }
    for (let i = 0; i < SEARCH_LIMIT; i += 1) {
      const lastX = px(guess);
      const lastY = py(guess);
      const d1x = dx(guess);
      const d1y = dy(guess);
      const d2x = ddx(guess);
      const d2y = ddy(guess);
      const deltaX = lastX - x;
      const deltaY = lastY - y;
      const first = 2 * (deltaX * d1x + deltaY * d1y);
      const second = 2 * (deltaX * d2x + deltaY * d2y + d1x * d1x + d1y * d1y);
      guess = clamp01(guess - first / (second + 1e-9));
      if (Math.hypot(px(guess) - lastX, py(guess) - lastY) < 0.1) break;
    }
    return guess;
  };

  return {
    start,
    end,
    lengthIn,
    runtimeLengthIn,
    get: (t) => ({ x: px(t), y: py(t) }),
    derivative: (t) => ({ x: dx(t), y: dy(t) }),
    tangent: (t) => unit(dx(t), dy(t), chord),
    closestT,
    remainingDistance: (t) => (lengthIn === 0 ? 0 : (1 - lengthAt(t) / lengthIn) * lengthIn),
  };
}

/** A line for two points, a Bezier for three or more, the way `PathBuilder.geometry` chooses. */
export function makeSimCurve(points: readonly XY[]): SimCurve {
  if (points.length < 2) throw new Error("A segment needs at least two points.");
  if (points.length === 2) return makeLine(points[0] as XY, points[1] as XY);
  return makeBezier(points);
}
