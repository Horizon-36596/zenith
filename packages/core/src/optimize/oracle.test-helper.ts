import type { Field, Robot } from "@horizon36596/zenith-schema";
import { footprintAt } from "../footprint.js";
import { obstacleShadows } from "../geometry/obstacle.js";
import { robotHeightIn } from "../kinematics.js";

/**
 * A brute-force oracle for the optimizer's clearance rules, for the tests of the hard final check
 * (issue #301). It is written apart from `clearance.ts` and `geometry/sat.ts` on purpose, so that a
 * mistake in the code under test is not repeated here:
 *
 * - It does not hull, grow boxes, or bound a rotation. It walks the motion in small steps, 0.1 in
 *   of travel and 0.0175 rad of turn at a time, and measures the real footprint polygons at every
 *   step.
 * - Distance between two convex polygons is the smallest vertex-to-edge distance when they do not
 *   overlap, and an overlap is found by edges crossing or a vertex strictly inside. Nothing reads
 *   `polygonBoxClearance`.
 *
 * What it shares with the code under test is only the data: `footprintAt` for the robot's polygons
 * and `obstacleShadows` for what a structure is to a robot of this height. It enforces the same
 * rule as the specs: structures by the margin with the end exemption of section 4.3, walls with the
 * slack `check()` gives them, keep-outs that apply in auto with no margin.
 *
 * A pass here means the motion, followed densely, never breaks the rule. The final check is
 * conservative, so it may fail what the oracle passes, and must never pass what the oracle fails.
 *
 * Pure (CLAUDE.md rule 1), though it is only used by tests.
 */

/** The spacing of the oracle's poses along the travel, in inches. */
export const ORACLE_SPACING_IN = 0.1;

/** The largest turn between two oracle poses, in radians. */
export const ORACLE_ROTATION_STEP_RAD = 0.0175;

/** Float slack in the oracle's comparisons, in inches. */
const SLACK_IN = 1e-6;

/** How far outside the field a corner may sit, in inches: the slack `check()` gives the walls. */
const WALL_SLACK_IN = 0.05;

interface Point {
  xIn: number;
  yIn: number;
}

/** A pose on a track of motion. */
export interface OraclePose {
  xIn: number;
  yIn: number;
  headingRad: number;
}

type Polygon = readonly Point[];

const TWO_PI = Math.PI * 2;

/** The turn from `from` to `to` the short way, in (-pi, pi]. */
function shortTurn(from: number, to: number): number {
  let delta = (to - from) % TWO_PI;
  if (delta > Math.PI) delta -= TWO_PI;
  if (delta <= -Math.PI) delta += TWO_PI;
  return delta;
}

/**
 * The poses between each pair of consecutive poses of `track`, close enough that no step travels
 * more than `ORACLE_SPACING_IN` or turns more than `ORACLE_ROTATION_STEP_RAD`. The position is
 * linear between two poses and the heading turns the short way. The track itself is given dense
 * enough that this is the path: a plan sampled every 0.1 in, or the sim's ticks.
 */
export function denseTrack(track: readonly OraclePose[]): OraclePose[] {
  const out: OraclePose[] = [];
  for (const [index, pose] of track.entries()) {
    out.push(pose);
    const next = track[index + 1];
    if (next === undefined) continue;
    const travel = Math.hypot(next.xIn - pose.xIn, next.yIn - pose.yIn);
    const turn = shortTurn(pose.headingRad, next.headingRad);
    const steps = Math.max(1, Math.ceil(travel / ORACLE_SPACING_IN), Math.ceil(Math.abs(turn) / ORACLE_ROTATION_STEP_RAD));
    for (let k = 1; k < steps; k += 1) {
      const f = k / steps;
      out.push({
        xIn: pose.xIn + (next.xIn - pose.xIn) * f,
        yIn: pose.yIn + (next.yIn - pose.yIn) * f,
        headingRad: pose.headingRad + turn * f,
      });
    }
  }
  return out;
}

const cross = (o: Point, a: Point, b: Point): number => (a.xIn - o.xIn) * (b.yIn - o.yIn) - (a.yIn - o.yIn) * (b.xIn - o.xIn);

/** The polygon's signed area, positive when it runs counter-clockwise. */
function signedArea(polygon: Polygon): number {
  let area = 0;
  for (const [i, a] of polygon.entries()) {
    const b = polygon[(i + 1) % polygon.length] as Point;
    area += a.xIn * b.yIn - b.xIn * a.yIn;
  }
  return area / 2;
}

/** The polygon counter-clockwise, so the same inside test works for every shape. */
const counterClockwise = (polygon: Polygon): Polygon => (signedArea(polygon) >= 0 ? polygon : [...polygon].reverse());

/** True when `p` is strictly inside the counter-clockwise convex polygon, by more than the slack. */
function strictlyInside(p: Point, polygon: Polygon): boolean {
  return polygon.every((a, i) => {
    const b = polygon[(i + 1) % polygon.length] as Point;
    const length = Math.hypot(b.xIn - a.xIn, b.yIn - a.yIn);
    return length === 0 || cross(a, b, p) / length > SLACK_IN;
  });
}

/** True when the segments cross at a point interior to both, not merely touching. */
function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const d1 = cross(a, b, c);
  const d2 = cross(a, b, d);
  const d3 = cross(c, d, a);
  const d4 = cross(c, d, b);
  return ((d1 > SLACK_IN && d2 < -SLACK_IN) || (d1 < -SLACK_IN && d2 > SLACK_IN)) &&
    ((d3 > SLACK_IN && d4 < -SLACK_IN) || (d3 < -SLACK_IN && d4 > SLACK_IN));
}

/** The distance from `p` to the segment `a`-`b`. */
function pointSegmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.xIn - a.xIn;
  const dy = b.yIn - a.yIn;
  const lengthSquared = dx * dx + dy * dy;
  const f = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((p.xIn - a.xIn) * dx + (p.yIn - a.yIn) * dy) / lengthSquared));
  return Math.hypot(p.xIn - (a.xIn + dx * f), p.yIn - (a.yIn + dy * f));
}

/** Whether the interiors of two convex polygons overlap. */
function overlaps(a: Polygon, b: Polygon): boolean {
  if (a.some((p) => strictlyInside(p, b)) || b.some((p) => strictlyInside(p, a))) return true;
  for (const [i, a0] of a.entries()) {
    const a1 = a[(i + 1) % a.length] as Point;
    for (const [j, b0] of b.entries()) {
      if (segmentsCross(a0, a1, b0, b[(j + 1) % b.length] as Point)) return true;
    }
  }
  // Two equal shapes lie on each other without any vertex strictly inside the other.
  const centre = (polygon: Polygon): Point => ({
    xIn: polygon.reduce((sum, p) => sum + p.xIn, 0) / polygon.length,
    yIn: polygon.reduce((sum, p) => sum + p.yIn, 0) / polygon.length,
  });
  return strictlyInside(centre(a), b) || strictlyInside(centre(b), a);
}

/**
 * The signed gap between two convex polygons: the smallest distance between their outlines when
 * they are apart, and -1 when their interiors overlap (how deep is not needed here, only that it is).
 */
function gap(a: Polygon, b: Polygon): number {
  const left = counterClockwise(a);
  const right = counterClockwise(b);
  if (overlaps(left, right)) return -1;
  let nearest = Infinity;
  for (const p of left) {
    for (const [j, b0] of right.entries()) nearest = Math.min(nearest, pointSegmentDistance(p, b0, right[(j + 1) % right.length] as Point));
  }
  for (const p of right) {
    for (const [i, a0] of left.entries()) nearest = Math.min(nearest, pointSegmentDistance(p, a0, left[(i + 1) % left.length] as Point));
  }
  return nearest;
}

const rectangle = (minX: number, maxX: number, minY: number, maxY: number): Polygon => [
  { xIn: minX, yIn: minY },
  { xIn: maxX, yIn: minY },
  { xIn: maxX, yIn: maxY },
  { xIn: minX, yIn: maxY },
];

/** What the oracle found wrong, for a failing test to print. */
export interface OracleViolation {
  kind: "structure" | "wall" | "keepOut";
  id: string | null;
  /** The index of the dense pose where it happens. */
  index: number;
  pose: OraclePose;
  /** The gap that was found and the one that was required, in inches (walls: how far outside, and 0). */
  foundIn: number;
  requiredIn: number;
}

export interface OracleResult {
  ok: boolean;
  /** The first thing that breaks a rule, or null. */
  violation: OracleViolation | null;
}

/**
 * Whether a motion keeps the rules of spec 16 section 4 for a robot on a field, followed densely.
 *
 * `track` is the sequence of poses the robot is driven through, in order, from one end to the other.
 * The structure rule per structure, over the dense poses with gaps `c`:
 *
 * - from the start, while `c` is below the margin, `c` is not below 0 and not below the pose
 *   before it (the end exemption, section 4.3);
 * - the same from the end, backwards;
 * - everywhere else `c` is at least the margin.
 *
 * Walls: every polygon corner within the field, to `check()`'s slack. Keep-outs that apply in auto:
 * no overlap.
 */
export function oracleClearance(track: readonly OraclePose[], robot: Robot, field: Field, marginIn: number): OracleResult {
  const dense = denseTrack(track);
  const polygonsAt = dense.map((pose) => {
    const footprint = footprintAt(pose, robot, "expandedIn");
    return [footprint.bodyIn, ...footprint.mouthsIn] as Polygon[];
  });

  const sizeX = field.sizeIn.xIn;
  const sizeY = field.sizeIn.yIn;
  const centred = field.frame.origin === "centre";
  const minX = centred ? -sizeX / 2 : 0;
  const maxX = centred ? sizeX / 2 : sizeX;
  const minY = centred ? -sizeY / 2 : 0;
  const maxY = centred ? sizeY / 2 : sizeY;
  for (const [index, polygons] of polygonsAt.entries()) {
    for (const polygon of polygons) {
      for (const p of polygon) {
        const outside = Math.max(minX - p.xIn, p.xIn - maxX, minY - p.yIn, p.yIn - maxY);
        if (outside > WALL_SLACK_IN) {
          return { ok: false, violation: { kind: "wall", id: null, index, pose: dense[index] as OraclePose, foundIn: outside, requiredIn: 0 } };
        }
      }
    }
  }

  for (const zone of (field.zones ?? []).filter((z) => z.appliesInAuto === true)) {
    const box = rectangle(zone.minXIn, zone.maxXIn, zone.minYIn, zone.maxYIn);
    for (const [index, polygons] of polygonsAt.entries()) {
      for (const polygon of polygons) {
        if (overlaps(counterClockwise(polygon), box)) {
          return { ok: false, violation: { kind: "keepOut", id: zone.id, index, pose: dense[index] as OraclePose, foundIn: -1, requiredIn: 0 } };
        }
      }
    }
  }

  for (const shadow of obstacleShadows(field.obstacles ?? [], robotHeightIn(robot))) {
    const gaps = polygonsAt.map((polygons) => Math.min(...polygons.map((polygon) => gap(polygon, shadow.polygonIn))));
    const fail = (index: number, requiredIn: number): OracleResult => ({
      ok: false,
      violation: { kind: "structure", id: shadow.obstacle.id, index, pose: dense[index] as OraclePose, foundIn: gaps[index] as number, requiredIn },
    });
    const n = gaps.length;
    const fromStart = new Array<number>(n).fill(-Infinity);
    for (let i = 0; i < n && (gaps[i] as number) < marginIn; i += 1) {
      fromStart[i] = i === 0 ? 0 : Math.max(0, Math.min(marginIn, gaps[i - 1] as number));
    }
    const fromEnd = new Array<number>(n).fill(-Infinity);
    for (let i = n - 1; i >= 0 && (gaps[i] as number) < marginIn; i -= 1) {
      fromEnd[i] = i === n - 1 ? 0 : Math.max(0, Math.min(marginIn, gaps[i + 1] as number));
    }
    for (let i = 0; i < n; i += 1) {
      const exempt = (fromStart[i] as number) > -Infinity || (fromEnd[i] as number) > -Infinity;
      const need = exempt ? Math.max(fromStart[i] as number, fromEnd[i] as number) : marginIn;
      if ((gaps[i] as number) < need - SLACK_IN) return fail(i, need);
    }
  }
  return { ok: true, violation: null };
}
