import { add, rotate, type Vec2 } from "./vec.js";

/** An axis-aligned box in the field frame: obstacles, zones and the field perimeter are these. */
export interface Box2 {
  minXIn: number;
  maxXIn: number;
  minYIn: number;
  maxYIn: number;
}

/** A rectangle carried by the robot: centre, size and the heading it is rotated to. */
export interface Rect {
  centreIn: Vec2;
  lengthIn: number;
  widthIn: number;
  headingRad: number;
}

/** The four corners, counter-clockwise, of a rotated rectangle. */
export function rectCorners(rect: Rect): Vec2[] {
  const halfLength = rect.lengthIn / 2;
  const halfWidth = rect.widthIn / 2;
  const local: Vec2[] = [
    { xIn: halfLength, yIn: halfWidth },
    { xIn: -halfLength, yIn: halfWidth },
    { xIn: -halfLength, yIn: -halfWidth },
    { xIn: halfLength, yIn: -halfWidth },
  ];
  return local.map((corner) => add(rect.centreIn, rotate(corner, rect.headingRad)));
}

export const boxCorners = (box: Box2): Vec2[] => [
  { xIn: box.minXIn, yIn: box.minYIn },
  { xIn: box.maxXIn, yIn: box.minYIn },
  { xIn: box.maxXIn, yIn: box.maxYIn },
  { xIn: box.minXIn, yIn: box.maxYIn },
];

interface Interval {
  min: number;
  max: number;
}

function project(points: readonly Vec2[], axis: Vec2): Interval {
  let min = Infinity;
  let max = -Infinity;
  for (const point of points) {
    const value = point.xIn * axis.xIn + point.yIn * axis.yIn;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { min, max };
}

function axesOf(polygon: readonly Vec2[]): Vec2[] {
  const axes: Vec2[] = [];
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i] as Vec2;
    const b = polygon[(i + 1) % polygon.length] as Vec2;
    const edge = { xIn: b.xIn - a.xIn, yIn: b.yIn - a.yIn };
    const normalLength = Math.hypot(edge.xIn, edge.yIn);
    if (normalLength < 1e-12) continue;
    axes.push({ xIn: -edge.yIn / normalLength, yIn: edge.xIn / normalLength });
  }
  return axes;
}

export interface OverlapResult {
  overlaps: boolean;
  /**
   * How deep the overlap is, in inches; 0 when apart. It is the minimum translation distance: the
   * shortest distance one shape has to move, along one of the candidate axes, to stop overlapping
   * the other. On each axis that is the smaller of the two ways out, `a.max - b.min` and
   * `b.max - a.min`, and the depth is the smallest of those over the axes.
   *
   * It is not the length of the overlap on an axis, which can never be more than the thinner
   * shape: an 18 in robot straddling a 1 in bar overlaps it by 1 in on the bar's axis but has to
   * move 9.5 in to get off it (issue #152).
   */
  penetrationIn: number;
}

/** How far `a` has to move along an axis to stop overlapping `b`; 0 or less when they are apart on it. */
const depthOnAxis = (a: Interval, b: Interval): number => Math.min(a.max - b.min, b.max - a.min);

/**
 * Separating-axis test between a convex polygon (the robot's rotated footprint or a mouth box) and
 * an axis-aligned box (an obstacle). site/docs/checks-and-findings.md asks for
 * the deepest penetration, which is the minimum translation distance over the candidate axes.
 */
export function polygonOverlapsBox(polygon: readonly Vec2[], box: Box2): OverlapResult {
  const worldAxes: Vec2[] = [
    { xIn: 1, yIn: 0 },
    { xIn: 0, yIn: 1 },
  ];
  const corners = boxCorners(box);
  let smallest = Infinity;
  for (const axis of [...axesOf(polygon), ...worldAxes]) {
    const overlap = depthOnAxis(project(polygon, axis), project(corners, axis));
    if (overlap <= 0) return { overlaps: false, penetrationIn: 0 };
    if (overlap < smallest) smallest = overlap;
  }
  return { overlaps: true, penetrationIn: smallest };
}

/** True when the point is inside the box, edges included. */
export const pointInBox = (point: Vec2, box: Box2): boolean =>
  point.xIn >= box.minXIn &&
  point.xIn <= box.maxXIn &&
  point.yIn >= box.minYIn &&
  point.yIn <= box.maxYIn;

export interface OutsideResult {
  outside: boolean;
  /** The furthest any corner is outside the box, in inches. */
  worstIn: number;
  worstPointIn: Vec2 | null;
}

/** How far a polygon pokes out of a box. The PERIMETER check reads `worstIn`. */
export function polygonOutsideBox(polygon: readonly Vec2[], box: Box2): OutsideResult {
  let worstIn = 0;
  let worstPointIn: Vec2 | null = null;
  for (const point of polygon) {
    const out = Math.max(
      box.minXIn - point.xIn,
      point.xIn - box.maxXIn,
      box.minYIn - point.yIn,
      point.yIn - box.maxYIn,
    );
    if (out > worstIn) {
      worstIn = out;
      worstPointIn = point;
    }
  }
  return { outside: worstPointIn !== null, worstIn, worstPointIn };
}

/**
 * Separating-axis test between two convex polygons, such as two robots' rotated footprints. The
 * candidate axes are the edge normals of both, which is exact for convex shapes; the depth is the
 * minimum translation distance over those axes, in inches, as in `polygonOverlapsBox`.
 */
export function convexPolygonsOverlap(a: readonly Vec2[], b: readonly Vec2[]): OverlapResult {
  let smallest = Infinity;
  for (const axis of [...axesOf(a), ...axesOf(b)]) {
    const overlap = depthOnAxis(project(a, axis), project(b, axis));
    if (overlap <= 0) return { overlaps: false, penetrationIn: 0 };
    if (overlap < smallest) smallest = overlap;
  }
  return { overlaps: true, penetrationIn: smallest === Infinity ? 0 : smallest };
}

/**
 * The most the shapes are separated by along any one candidate axis, which is the signed gap: how
 * far apart they are when positive, and minus how far one has to move to stop overlapping the
 * other when negative. It is the larger of the per-axis gaps, so it is the negation of the
 * smallest `depthOnAxis`, and it is positive exactly when `polygonOverlapsBox` and
 * `convexPolygonsOverlap` say the shapes are apart.
 */
function signedGap(axes: readonly Vec2[], a: readonly Vec2[], b: readonly Vec2[]): number {
  let gap = -Infinity;
  for (const axis of axes) {
    const separation = -depthOnAxis(project(a, axis), project(b, axis));
    if (separation > gap) gap = separation;
  }
  return gap === -Infinity ? 0 : gap;
}

/**
 * The signed clearance between a convex polygon and an axis-aligned box, in inches: positive when
 * they are apart, 0 when they touch, and minus the penetration depth when they overlap. Its sign
 * always agrees with `polygonOverlapsBox` (it overlaps exactly when this is negative), and when
 * they overlap its magnitude is that function's `penetrationIn`.
 *
 * Apart, it is the separating-axis gap, the largest separation over the polygon's edge normals and
 * the world axes. That never exceeds the true Euclidean distance (the two are equal whenever the
 * closest features are face to face) so a clearance of at least `d` guarantees the shapes are at
 * least `d` apart, and the gap is conservative for a corner-to-corner approach.
 */
export function polygonBoxClearance(polygon: readonly Vec2[], box: Box2): number {
  return signedGap([...axesOf(polygon), { xIn: 1, yIn: 0 }, { xIn: 0, yIn: 1 }], polygon, boxCorners(box));
}

/**
 * The signed clearance between two convex polygons, defined as `polygonBoxClearance` is, over the
 * edge normals of both. It is how a strut's slanted shadow is tested, since that is not a box.
 */
export function convexPolygonClearance(a: readonly Vec2[], b: readonly Vec2[]): number {
  return signedGap([...axesOf(a), ...axesOf(b)], a, b);
}

/**
 * The box grown by `byIn` on every side. A negative `byIn` shrinks it; the caller keeps it from
 * shrinking past nothing.
 */
export const inflateBox = (box: Box2, byIn: number): Box2 => ({
  minXIn: box.minXIn - byIn,
  maxXIn: box.maxXIn + byIn,
  minYIn: box.minYIn - byIn,
  maxYIn: box.maxYIn + byIn,
});

/**
 * The convex hull of a set of points, counter-clockwise, by Andrew's monotone chain. Collinear
 * points on the hull are dropped, and fewer than three distinct points give those points back.
 * The swept test hulls two consecutive footprints with it.
 */
export function convexHull(points: readonly Vec2[]): Vec2[] {
  const sorted = [...points].sort((p, q) => p.xIn - q.xIn || p.yIn - q.yIn);
  const unique = sorted.filter((p, i) => i === 0 || p.xIn !== (sorted[i - 1] as Vec2).xIn || p.yIn !== (sorted[i - 1] as Vec2).yIn);
  if (unique.length < 3) return unique;
  const cross = (o: Vec2, a: Vec2, b: Vec2): number =>
    (a.xIn - o.xIn) * (b.yIn - o.yIn) - (a.yIn - o.yIn) * (b.xIn - o.xIn);
  const chain = (input: readonly Vec2[]): Vec2[] => {
    const out: Vec2[] = [];
    for (const p of input) {
      while (out.length >= 2 && cross(out[out.length - 2] as Vec2, out[out.length - 1] as Vec2, p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...chain(unique), ...chain([...unique].reverse())];
}

/** The point of segment `a`-`b` closest to `point`. */
function closestOnSegment(point: Vec2, a: Vec2, b: Vec2): Vec2 {
  const dx = b.xIn - a.xIn;
  const dy = b.yIn - a.yIn;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < 1e-24) return a;
  const t = Math.max(0, Math.min(1, ((point.xIn - a.xIn) * dx + (point.yIn - a.yIn) * dy) / lengthSquared));
  return { xIn: a.xIn + t * dx, yIn: a.yIn + t * dy };
}

export interface GapResult {
  /** The shortest distance between the two polygons, in inches; 0 when they overlap or touch. */
  gapIn: number;
  /** The point of `a` nearest `b`. */
  pointOnA: Vec2;
  /** The point of `b` nearest `a`. */
  pointOnB: Vec2;
}

/**
 * The shortest distance between two convex polygons, for the CLEARANCE check. When they are apart,
 * the closest pair of points is a corner of one and a point on an edge of the other, so the least
 * corner-to-edge distance, taken both ways, is exact. When they overlap the gap is 0 and the two
 * points are the first corner of each, which no caller reads.
 */
export function convexPolygonsGap(a: readonly Vec2[], b: readonly Vec2[]): GapResult {
  const first = { pointOnA: a[0] ?? { xIn: 0, yIn: 0 }, pointOnB: b[0] ?? { xIn: 0, yIn: 0 } };
  if (a.length === 0 || b.length === 0) return { gapIn: Infinity, ...first };
  if (convexPolygonsOverlap(a, b).overlaps) return { gapIn: 0, ...first };
  let best: GapResult = { gapIn: Infinity, ...first };
  const consider = (corners: readonly Vec2[], edges: readonly Vec2[], cornersAreA: boolean): void => {
    for (const corner of corners) {
      for (let i = 0; i < edges.length; i += 1) {
        const onEdge = closestOnSegment(corner, edges[i] as Vec2, edges[(i + 1) % edges.length] as Vec2);
        const gapIn = Math.hypot(corner.xIn - onEdge.xIn, corner.yIn - onEdge.yIn);
        if (gapIn < best.gapIn) {
          best = cornersAreA ? { gapIn, pointOnA: corner, pointOnB: onEdge } : { gapIn, pointOnA: onEdge, pointOnB: corner };
        }
      }
    }
  };
  consider(a, b, true);
  consider(b, a, false);
  return best;
}

/** The distance between two axis-aligned boxes, in inches; 0 when they overlap. A lower bound on any gap inside them. */
export function boxGapIn(a: Box2, b: Box2): number {
  const dx = Math.max(0, a.minXIn - b.maxXIn, b.minXIn - a.maxXIn);
  const dy = Math.max(0, a.minYIn - b.maxYIn, b.minYIn - a.maxYIn);
  return Math.hypot(dx, dy);
}
