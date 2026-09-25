/**
 * The footprint the wall snap rests against, made the same thing the PERIMETER check tests.
 *
 * v1 folded only `footprintAt(...).bodyIn` into the snap's box and dropped `mouthsIn`, while
 * `core.check` sweeps `[footprintIn, ...mouthsIn]`, so a robot whose intake stuck out past its body
 * snapped "flush" and then left the field by the intake's protrusion. Two things make the snap
 * footprint-true here:
 *
 * 1. The box is the union of the body and every mouth (`footprintBoundsIn`).
 * 2. It is taken at the heading the robot will really have at that point, which is the step's
 *    heading mode evaluated on the geometry with the dragged point in its new place, not the
 *    authored pose's `headingRad` (a tangent path's end heading turns as its endpoint moves).
 *    Where the point is also the start of the next step, that step's start heading counts too.
 *
 * Pure: plain functions of the plan, the robot and a position.
 */
import {
  footprintAt,
  footprintBoundsIn,
  headingFunction,
  makePath,
  type Box2,
  type PlanStep,
  type Pose,
  type Vec2,
} from "@horizon36596/zenith-core";
import type { Robot } from "@horizon36596/zenith-schema";
import type { PointTarget } from "./types.js";

/** The axis-aligned box around a set of polygons. */
export function polygonsBounds(polygons: readonly (readonly Vec2[])[]): Box2 {
  let minXIn = Infinity;
  let maxXIn = -Infinity;
  let minYIn = Infinity;
  let maxYIn = -Infinity;
  for (const polygon of polygons) {
    for (const corner of polygon) {
      if (corner.xIn < minXIn) minXIn = corner.xIn;
      if (corner.xIn > maxXIn) maxXIn = corner.xIn;
      if (corner.yIn < minYIn) minYIn = corner.yIn;
      if (corner.yIn > maxYIn) maxYIn = corner.yIn;
    }
  }
  return { minXIn, maxXIn, minYIn, maxYIn };
}

export const unionBounds = (boxes: readonly Box2[]): Box2 => ({
  minXIn: Math.min(...boxes.map((box) => box.minXIn)),
  maxXIn: Math.max(...boxes.map((box) => box.maxXIn)),
  minYIn: Math.min(...boxes.map((box) => box.minYIn)),
  maxYIn: Math.max(...boxes.map((box) => box.maxYIn)),
});

/**
 * The bounds of the body and every mouth at a pose, which is core's `footprintBoundsIn`: the exact
 * polygons `footprintPolygons` hands the PERIMETER check. Re-exported so the canvas has one import.
 */
export { footprintBoundsIn };

/** The body alone, so the readout can tell a mouth-driven wall snap apart. */
export const bodyBoundsIn = (
  pose: Pose,
  robot: Robot,
  which: "startIn" | "expandedIn" = "expandedIn",
): Box2 => polygonsBounds([footprintAt(pose, robot, which).bodyIn]);

const near = (a: Vec2, b: Vec2): boolean => Math.hypot(a.xIn - b.xIn, a.yIn - b.yIn) < 1e-6;

/**
 * A step's control polygons with one endpoint moved, keeping a chained neighbour segment attached
 * and, when `carry` is set, moving the handles the endpoint owns by the same delta, exactly as the
 * drag itself does (`bezier.ts` `carriedHandles`). Carrying matters here: a cubic's end tangent is
 * `to - lastControl`, which a carried drag leaves unchanged and a bare endpoint move would not.
 */
function movedPolygons(step: PlanStep, target: PointTarget, positionIn: Vec2, carry: boolean): Vec2[][] | null {
  const segments = step.segments;
  if (segments === undefined || segments.length === 0) return null;
  const polygons = segments.map((segment) => segment.pointsIn.map((point) => ({ ...point })));
  const index = target.segmentIndex;
  const polygon = polygons[index];
  if (polygon === undefined || target.pointKind === "control") return null;
  const shift = (points: Vec2[], at: number, dxIn: number, dyIn: number): void => {
    const point = points[at] as Vec2;
    points[at] = { xIn: point.xIn + dxIn, yIn: point.yIn + dyIn };
  };
  const owns = (points: Vec2[]): boolean => carry && points.length - 2 >= 2;

  if (target.pointKind === "from") {
    const old = polygon[0] as Vec2;
    const dxIn = positionIn.xIn - old.xIn;
    const dyIn = positionIn.yIn - old.yIn;
    polygon[0] = { ...positionIn };
    if (owns(polygon)) shift(polygon, 1, dxIn, dyIn);
    const previous = polygons[index - 1];
    if (previous !== undefined && near(previous[previous.length - 1] as Vec2, old)) {
      previous[previous.length - 1] = { ...positionIn };
      if (owns(previous)) shift(previous, previous.length - 2, dxIn, dyIn);
    }
  } else {
    const old = polygon[polygon.length - 1] as Vec2;
    const dxIn = positionIn.xIn - old.xIn;
    const dyIn = positionIn.yIn - old.yIn;
    polygon[polygon.length - 1] = { ...positionIn };
    if (owns(polygon)) shift(polygon, polygon.length - 2, dxIn, dyIn);
    const next = polygons[index + 1];
    if (next !== undefined && near(next[0] as Vec2, old)) {
      next[0] = { ...positionIn };
      if (owns(next)) shift(next, 1, dxIn, dyIn);
    }
  }
  return polygons;
}

/** Every heading a path step's mode gives at arc-length t, either side of a segment boundary. */
function headingsOf(step: PlanStep, polygons: Vec2[][], t: number): number[] {
  const authored = step.step.kind === "path" ? step.step.heading : undefined;
  if (authored === undefined) return [step.startPose.headingRad];
  const geometry = makePath(polygons);
  const at = headingFunction(authored, geometry);
  const out = [at(t)];
  // A corner between two segments has a different tangent on each side of it.
  if (t > 0) out.push(at(Math.max(0, t - 1e-6)));
  if (t < 1) out.push(at(Math.min(1, t + 1e-6)));
  return out;
}

function boundaryT(polygons: Vec2[][], target: PointTarget): number {
  const geometry = makePath(polygons);
  if (geometry.lengthIn <= 0) return 0;
  const index = target.pointKind === "from" ? target.segmentIndex : target.segmentIndex + 1;
  return (geometry.breaks[index] ?? geometry.lengthIn) / geometry.lengthIn;
}

/**
 * The headings the robot will have at a dragged endpoint once it is at `positionIn`: this step's,
 * and the next path step's start heading when that step starts here. Null for a point with no
 * footprint (a control point), or a step with no geometry.
 */
export function headingsAtDraggedPoint(
  steps: readonly PlanStep[],
  stepId: string,
  target: PointTarget,
  positionIn: Vec2,
): number[] | null {
  const index = steps.findIndex((step) => step.id === stepId);
  const step = steps[index];
  if (step === undefined || target.pointKind === "control") return null;
  const polygons = movedPolygons(step, target, positionIn, true);
  if (polygons === null) return null;
  const headings = headingsOf(step, polygons, boundaryT(polygons, target));

  const segments = step.segments ?? [];
  const isEnd = target.pointKind === "to" && target.segmentIndex === segments.length - 1;
  if (isEnd) {
    const lastPoints = segments[segments.length - 1]?.pointsIn;
    const oldEnd = lastPoints?.[lastPoints.length - 1];
    const next = steps
      .slice(index + 1)
      .find((candidate) => candidate.segments !== undefined && candidate.segments.length > 0);
    const nextStart = next?.segments?.[0]?.pointsIn[0];
    if (next !== undefined && oldEnd !== undefined && nextStart !== undefined && near(nextStart, oldEnd)) {
      const moved = movedPolygons(next, { segmentIndex: 0, pointKind: "from" }, positionIn, false);
      if (moved !== null) headings.push(...headingsOf(next, moved, 0));
    }
  }
  return headings;
}

/**
 * The footprint box the wall snap uses for a dragged endpoint: the union over every heading the
 * robot will have there. Falls back to the pose's own heading when the plan cannot say.
 */
export function draggedFootprintBounds(
  steps: readonly PlanStep[],
  robot: Robot,
  stepId: string,
  target: PointTarget,
  pose: Pose,
  which: "body" | "all" = "all",
): Box2 | null {
  if (target.pointKind === "control") return null;
  const headings = headingsAtDraggedPoint(steps, stepId, target, pose) ?? [pose.headingRad];
  const boxOf = which === "all" ? footprintBoundsIn : bodyBoundsIn;
  return unionBounds(headings.map((headingRad) => boxOf({ xIn: pose.xIn, yIn: pose.yIn, headingRad }, robot)));
}
