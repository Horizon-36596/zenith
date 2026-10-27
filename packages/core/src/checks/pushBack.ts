import {
  FORMAT_VERSIONS,
  SCHEMA_ID,
  type Auto,
  type Field,
  type PoseSource,
  type Robot,
  type Step,
  type Waypoints,
} from "@horizon36596/zenith-schema";
import { continuityGaps } from "../continuity.js";
import { applyFix } from "../fix.js";
import type { ObstacleShadow } from "../geometry/obstacle.js";
import { convexPolygonsOverlap, polygonOutsideBox, type Box2 } from "../geometry/sat.js";
import type { Pose, Vec2 } from "../geometry/vec.js";
import { flattenSteps, plan } from "../plan.js";
import { resolve, type ResolvedSegment } from "../resolve.js";
import { robotClearanceIn as robotClearanceInOf } from "../kinematics.js";
import type { Finding, Fix, Plan, PlanSample, PlanStep } from "../types.js";

/**
 * How far past touching the push-back fix leaves the robot, in inches: clear of canonical form's
 * rounding (a thousandth of an inch) and of floating-point error, so the pose it writes re-checks
 * clean, and far below anything a person can measure on the field.
 */
export const PUSH_BACK_CLEARANCE_IN = 0.1;

/** What a footprint finding ran into: the field wall (PERIMETER) or one obstacle (STRUCTURE). */
export type PushTarget = { kind: "wall" } | { kind: "obstacle"; shadow: ObstacleShadow; name: string };

/** What the push-back re-check needs from the check that calls it. */
export interface PushContext {
  auto: Auto;
  startPose: Pose;
  /** The plan's top-level steps, which the re-check reads the auto's waypoint poses from. */
  steps: readonly PlanStep[];
  robot: Robot;
  field: Field;
  /** The field perimeter as a box. */
  bounds: Box2;
  /**
   * The shadows STRUCTURE tests (`obstacleShadows`): the plan shape of every solid obstacle's part
   * below the robot's top.
   */
  shadows: readonly ObstacleShadow[];
  /** How far outside the field a corner may sit before PERIMETER fires. */
  perimeterToleranceIn: number;
  /**
   * Every finding of a plan, checked without the fixes that plan the auto again, so a fix can
   * compare the auto it would write with the auto as it is (Move to approach). Absent, a fix judges
   * the moved auto by what it runs into alone.
   */
  findingsOf?: (planned: Plan) => Finding[];
  /** The auto's own findings as `findingsOf` would give them, when the check has them already. */
  findingsBefore?: readonly Finding[];
}

const WALL = "wall";

/** The axis-aligned box around a polygon. */
export function boxAround(polygon: readonly Vec2[]): Box2 {
  let minXIn = Infinity;
  let maxXIn = -Infinity;
  let minYIn = Infinity;
  let maxYIn = -Infinity;
  for (const corner of polygon) {
    minXIn = Math.min(minXIn, corner.xIn);
    maxXIn = Math.max(maxXIn, corner.xIn);
    minYIn = Math.min(minYIn, corner.yIn);
    maxYIn = Math.max(maxYIn, corner.yIn);
  }
  return { minXIn, maxXIn, minYIn, maxYIn };
}

/** Whether two boxes share any point; when they do not, nothing inside them can overlap. */
export const boxesOverlap = (a: Box2, b: Box2): boolean =>
  a.minXIn <= b.maxXIn && b.minXIn <= a.maxXIn && a.minYIn <= b.maxYIn && b.minYIn <= a.maxYIn;

/** The wall (as `"wall"`) and the ids of the obstacles any of these samples' polygons run into. */
function contacts(samples: readonly PlanSample[], context: PushContext): Set<string> {
  const hit = new Set<string>();
  for (const sample of samples) {
    for (const polygon of [sample.footprintIn, ...sample.mouthsIn]) {
      if (polygonOutsideBox(polygon, context.bounds).worstIn > context.perimeterToleranceIn) hit.add(WALL);
      const box = boxAround(polygon);
      for (const shadow of context.shadows) {
        // The boxes first: most polygons are nowhere near most obstacles, and the separating-axis
        // test is the cost of a re-check.
        if (hit.has(shadow.obstacle.id) || !boxesOverlap(box, shadow.boxIn)) continue;
        if (convexPolygonsOverlap(polygon, shadow.polygonIn).overlaps) hit.add(shadow.obstacle.id);
      }
    }
  }
  return hit;
}

/** The axis-aligned box around every polygon of one sample, body and mouths. */
function sampleBox(sample: PlanSample): Box2 {
  const corners = [sample.footprintIn, ...sample.mouthsIn].flat();
  return {
    minXIn: Math.min(...corners.map((corner) => corner.xIn)),
    maxXIn: Math.max(...corners.map((corner) => corner.xIn)),
    minYIn: Math.min(...corners.map((corner) => corner.yIn)),
    maxYIn: Math.max(...corners.map((corner) => corner.yIn)),
  };
}

/**
 * The moves that would take the robot's box at the end `clearanceIn` clear of what it ran into,
 * smallest first: back inside every wall it crosses, or out of the obstacle by each of its four sides. Measured on
 * the box around the footprint, which is clear whenever the box is, so a rotated robot is pushed a
 * little further than it strictly needs.
 */
function candidateMoves(box: Box2, target: PushTarget, bounds: Box2, clearanceIn: number): Vec2[] {
  const c = clearanceIn;
  if (target.kind === "wall") {
    const inward = (over: number): number => (over > 0 ? over + c : 0);
    return [
      {
        xIn: inward(bounds.minXIn - box.minXIn) - inward(box.maxXIn - bounds.maxXIn),
        yIn: inward(bounds.minYIn - box.minYIn) - inward(box.maxYIn - bounds.maxYIn),
      },
    ];
  }
  // The box around the shadow: the obstacle itself for a box, and a conservative box around a
  // strut's slanted band, so a push off a strut can go a little further than it strictly needs.
  const o = target.shadow.boxIn;
  const moves: Vec2[] = [
    { xIn: o.minXIn - box.maxXIn - c, yIn: 0 },
    { xIn: o.maxXIn - box.minXIn + c, yIn: 0 },
    { xIn: 0, yIn: o.minYIn - box.maxYIn - c },
    { xIn: 0, yIn: o.maxYIn - box.minYIn + c },
  ];
  return moves.sort((a, b) => Math.hypot(a.xIn, a.yIn) - Math.hypot(b.xIn, b.yIn));
}

/** Inches as canonical form writes them, to three decimals, so the re-check sees what the file keeps. */
export const threeDecimals = (inches: number): number => Math.round(inches * 1000) / 1000;

/**
 * The waypoints the plan resolved, read back off its paths: every `ref` a segment or the start
 * names, at the pose it resolved to. Planning the fixed auto again needs a waypoints file and the
 * check has only the plan; these are exactly the poses that plan used.
 */
function resolvedWaypoints(context: PushContext): Waypoints {
  const named: Waypoints["waypoints"] = {};
  const keep = (source: PoseSource, pose: Pose): void => {
    if (source !== "current" && "ref" in source && named[source.ref] === undefined) {
      named[source.ref] = { xIn: pose.xIn, yIn: pose.yIn, headingRad: pose.headingRad };
    }
  };
  keep(context.auto.start.pose, context.startPose);
  for (const step of flattenSteps(context.steps)) {
    if (step.step.kind !== "path" || step.segments === undefined) continue;
    for (const [index, written] of step.step.segments.entries()) {
      const resolved = step.segments[index];
      if (resolved === undefined) continue;
      keep(written.from, resolved.fromPose);
      keep(written.to, resolved.toPose);
    }
  }
  return { $schema: SCHEMA_ID.waypoints, formatVersion: FORMAT_VERSIONS.waypoints, waypoints: named };
}

/** What the re-check compares: what each step runs into, in document order, and every CONTINUITY gap. */
interface Recheck {
  contacts: Set<string>[];
  gaps: Set<string>;
}

/**
 * The whole auto planned again from its file, so a moved end carries through to the steps after
 * it: a later path that starts from `"current"` starts at the new end, and one written to start at
 * an inline pose of its own is measured against it.
 */
const planAgain = (auto: Auto, waypoints: Waypoints, context: PushContext): Plan =>
  plan(resolve(auto, waypoints, context.robot), context.robot, context.field);

/**
 * What `planned` runs into, step by step from the flattened step `fromIndex` on, and its CONTINUITY
 * gaps. A fix moves the end of that step, which changes nothing the robot does before it, so the
 * steps before it are left empty in both the baseline and the moved auto rather than tested twice.
 */
function recheck(planned: Plan, context: PushContext, fromIndex: number): Recheck {
  const gaps = continuityGaps(planned.steps, planned.startPose).map(
    (gap) => `${gap.stepId}|${gap.where}|${String(gap.segmentIndex ?? -1)}`,
  );
  return {
    contacts: flattenSteps(planned.steps).map((step, at) => (at < fromIndex ? new Set<string>() : contacts(step.samples, context))),
    gaps: new Set(gaps),
  };
}

/** The auto as written, planned and checked once, which every moved end is compared against. */
export interface RecheckBaseline {
  waypoints: Waypoints;
  planned: Plan;
  /** The flattened step whose end the fix moves: what it and the steps after it run into is compared. */
  fromIndex: number;
  before: Recheck;
}

/** The baseline a fix that moves the end of flattened step `fromIndex` is re-checked against: the auto as the plan has it now. */
export function recheckBaseline(context: PushContext, fromIndex: number): RecheckBaseline {
  const waypoints = resolvedWaypoints(context);
  const planned = planAgain(context.auto, waypoints, context);
  return { waypoints, planned, fromIndex, before: recheck(planned, context, fromIndex) };
}

/** The auto with `fix` applied, planned again against the baseline's waypoints. */
export const planWithFix = (fix: Fix, context: PushContext, baseline: RecheckBaseline): Plan =>
  planAgain(applyFix(context.auto, fix), baseline.waypoints, context);

/**
 * The auto with `fix` applied, planned again: whether it is clean of what the fix is for and of
 * anything new. It is clean when no step runs into anything it did not already, and no step is left
 * starting away from where the robot is. With `clears`, the step at that index of the flattened
 * steps must also no longer run into that contact (`"wall"` or an obstacle id), or, without a
 * `key`, into any obstacle at all (the wall it may still touch where it already did, as a path
 * that starts against it and turns does). `planned` is the fixed auto's plan when the caller has it
 * already (`planWithFix`), so it is not planned twice.
 */
export function rechecksClean(
  fix: Fix,
  context: PushContext,
  baseline: RecheckBaseline,
  clears?: { index: number; key?: string },
  planned: Plan = planWithFix(fix, context, baseline),
): boolean {
  const after = recheck(planned, context, baseline.fromIndex);
  const { before } = baseline;
  if (clears !== undefined) {
    const hit = after.contacts[clears.index];
    if (hit === undefined || (clears.key === undefined ? [...hit].some((contact) => contact !== WALL) : hit.has(clears.key))) return false;
  }
  const runsIntoMore = after.contacts.some((hit, at) => [...hit].some((contact) => before.contacts[at]?.has(contact) !== true));
  const opensGap = [...after.gaps].some((gap) => !before.gaps.has(gap));
  return !runsIntoMore && !opensGap;
}

/**
 * The push-back fix for a PERIMETER or STRUCTURE finding whose worst sample is `sample` (issue
 * #186), or null. It is offered only when all of these hold:
 *
 * - the worst sample is where the path ends, so moving that one point is what clears it;
 * - that end is an inline pose, since a waypoint end would move every path that names it;
 * - the moved auto re-checks clean: planned again with the end moved, the step no longer runs into
 *   what the finding is about, no step runs into anything it did not already, and no step is left
 *   starting away from where the robot is. A later path written to start at the old end as an
 *   inline pose of its own would be, so the fix is not offered then; one that starts from
 *   `"current"` follows the end.
 *
 * Off an obstacle, the end is pushed first to a tenth of an inch past the robot's clearance
 * (`footprint.clearanceIn`), so the moved end does not raise CLEARANCE at once; when that spot does
 * not re-check clean, to a tenth of an inch clear. Off the wall, which CLEARANCE does not count, it
 * is pushed a tenth of an inch inside.
 *
 * A path's start is left alone: the robot arrives there from the step before, so moving it would
 * open a jump, and a robot turning against the wall at its start has "Turn while driving".
 */
export function pushBackFix(step: PlanStep, sample: PlanSample, target: PushTarget, context: PushContext): Fix | null {
  const written: Step = step.step;
  if (written.kind !== "path" || step.segments === undefined || step.segments.length === 0) return null;
  if (sample !== step.samples[step.samples.length - 1]) return null;
  const lastWritten = written.segments[written.segments.length - 1];
  if (lastWritten === undefined || lastWritten.to === "current" || "ref" in lastWritten.to) return null;
  const end = (step.segments[step.segments.length - 1] as ResolvedSegment).toPose;

  const index = flattenSteps(context.steps).indexOf(step);
  if (index < 0) return null;
  const key = target.kind === "wall" ? WALL : target.shadow.obstacle.id;
  const baseline = recheckBaseline(context, index);
  const robotClearanceIn = target.kind === "wall" ? 0 : robotClearanceInOf(context.robot);
  const clearances = robotClearanceIn > 0 ? [robotClearanceIn + PUSH_BACK_CLEARANCE_IN, PUSH_BACK_CLEARANCE_IN] : [PUSH_BACK_CLEARANCE_IN];
  for (const clearanceIn of clearances) {
    for (const move of candidateMoves(sampleBox(sample), target, context.bounds, clearanceIn)) {
      if (move.xIn === 0 && move.yIn === 0) continue;
      const endIn = { xIn: threeDecimals(end.xIn + move.xIn), yIn: threeDecimals(end.yIn + move.yIn) };
      const fix: Fix = {
        kind: "pushBack",
        stepId: step.id,
        label: target.kind === "wall" ? "Push the end back from the wall" : `Push the end clear of ${target.name}`,
        params: target.kind === "wall" ? endIn : { ...endIn, clearOf: target.name },
      };
      if (rechecksClean(fix, context, baseline, { index, key })) return fix;
    }
  }
  return null;
}
