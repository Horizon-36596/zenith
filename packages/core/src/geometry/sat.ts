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
  /** How deep the overlap is on its shallowest separating axis, in inches; 0 when apart. */
  penetrationIn: number;
}

/**
 * Separating-axis test between a convex polygon (the robot's rotated footprint or a mouth box) and
 * an axis-aligned box (an obstacle). site/docs/checks-and-findings.md asks for
 * the deepest penetration, which is the smallest overlap over the candidate axes.
 */
export function polygonOverlapsBox(polygon: readonly Vec2[], box: Box2): OverlapResult {
  const worldAxes: Vec2[] = [
    { xIn: 1, yIn: 0 },
    { xIn: 0, yIn: 1 },
  ];
  const corners = boxCorners(box);
  let smallest = Infinity;
  for (const axis of [...axesOf(polygon), ...worldAxes]) {
    const a = project(polygon, axis);
    const b = project(corners, axis);
    const overlap = Math.min(a.max, b.max) - Math.max(a.min, b.min);
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
