/**
 * The snap rules for dragging on the field canvas (site/docs/editor.md:
 * "snap to waypoints, to the wall (footprint touching), to the legal-approach band for the ledger's
 * current target, to 15 degree headings").
 *
 * The rules, in the order they are applied to a dragged position. Only one of the first three can
 * win, because they all decide the same two numbers:
 *
 *  1. **Waypoint.** If a named pose from `waypoints.json` is within `WAYPOINT_SNAP_PX` of the
 *     pointer, the position becomes that waypoint's position exactly. Heading is left alone: a user
 *     dragging an endpoint is moving it, not re-aiming it. Nearest waypoint wins a tie.
 *  2. **Grid.** Otherwise the position rounds to `GRID_IN` on each axis independently, unless the
 *     quantising snaps are off (Alt held, `modifiers.ts`). Alt is the "leave my number alone" key and
 *     suppresses this rule and rule 4, and nothing else.
 *  3. **Wall contact.** Then, per axis, if the robot footprint's bounding box at that pose sits
 *     within `WALL_SNAP_IN` of a field wall (on either side of it), the pose shifts along that axis
 *     until the footprint is exactly flush with the wall. The footprint is the **union of the body
 *     and every mouth box**, the same polygons the PERIMETER check sweeps (`core` `checkGeometry`),
 *     so a wall-snapped pose never yields a PERIMETER finding (v1 read the body only and left a mouth
 *     hanging past the wall). The caller supplies the box at a pose, taken at the headings the robot
 *     will really have there; those can depend on the position (a tangent heading turns as its
 *     endpoint moves), so the shift is re-solved until the box is flush. While the point itself is
 *     on the field, a footprint pushed any distance into a wall is also pulled back to flush, so a
 *     drag into a wall rests against it. A point placed off the field altogether is left where it
 *     is: that is deliberate, and it is a `PERIMETER` finding, not something the canvas hides.
 *  4. **Heading.** A dragged heading rounds to `HEADING_SNAP_DEG`, unless Alt is held.
 *
 * With snapping off (the toggle, flipped while Ctrl is held) every rule is off and the pointer is the
 * value. Snapping never moves anything after the pointer is released (UI_GUIDE section 8.8).
 *
 * Pure: the caller supplies the footprint bounds, so nothing here needs a robot or the DOM.
 */
import { degToRad, radToDeg, wrapAngle, type Box2, type Pose } from "@horizon36596/zenith-core";

export const WAYPOINT_SNAP_PX = 6;
export const WALL_SNAP_IN = 1;
export const GRID_IN = 0.5;
export const HEADING_SNAP_DEG = 15;
/** Shift's heading constraint: 45 degree steps, whatever the snap toggle says. */
export const HEADING_COARSE_DEG = 45;

export type SnapKind = "none" | "waypoint" | "grid" | "wall";

export interface SnapWaypoint {
  name: string;
  xIn: number;
  yIn: number;
}

/** A wall the footprint was snapped flush to, for the snap-feedback line. */
export interface SnapWall {
  axis: "x" | "y";
  atIn: number;
}

export interface SnapContext {
  /** Whether any rule runs: the toolbar's snap toggle, inverted while Ctrl is held. */
  enabled: boolean;
  /** Alt suppresses the quantising rules (grid and heading increments) and nothing else. */
  altHeld: boolean;
  pxPerIn: number;
  waypoints: readonly SnapWaypoint[];
  /** The field perimeter, from `core.fieldBounds`. */
  bounds: Box2;
  /**
   * The axis-aligned bounds of the whole robot footprint at a pose: body and every mouth, at every
   * heading the robot will have there (`footprintBounds.ts`). Returning null skips rule 3, which is
   * what a Bezier control point wants: it is a shape parameter, not a place the robot ever is, so it
   * has no footprint to rest against a wall.
   */
  footprintBounds: (pose: Pose) => Box2 | null;
  /**
   * The body's bounds alone, so the readout can say "wall (mouth)" when a mouth rather than the
   * body is what touches the wall. Optional: without it the label never names a mouth.
   */
  bodyBounds?: (pose: Pose) => Box2 | null;
}

export interface SnapResult {
  pose: Pose;
  kind: SnapKind;
  /** Set when rule 1 fired, so the readout can name what was snapped to. */
  waypoint?: string;
  /** Set when rule 3 fired, so the live layer can draw the wall it snapped against. */
  walls?: SnapWall[];
  /** Set when rule 3 fired because a mouth, not the body, is what reaches the wall. */
  mouth?: boolean;
}

const round = (value: number, step: number): number => Math.round(value / step) * step;

/** Rule 1: the nearest waypoint inside the pixel tolerance, or null. */
function nearestWaypoint(pose: Pose, context: SnapContext): SnapWaypoint | null {
  const toleranceIn = WAYPOINT_SNAP_PX / Math.max(context.pxPerIn, 1e-6);
  let best: SnapWaypoint | null = null;
  let bestIn = toleranceIn;
  for (const waypoint of context.waypoints) {
    const distanceIn = Math.hypot(waypoint.xIn - pose.xIn, waypoint.yIn - pose.yIn);
    if (distanceIn <= bestIn) {
      best = waypoint;
      bestIn = distanceIn;
    }
  }
  return best;
}

type Side = "minX" | "maxX" | "minY" | "maxY";

/** The signed distance the box must move along its axis to sit flush against one wall. */
function residual(box: Box2, bounds: Box2, side: Side): number {
  switch (side) {
    case "minX":
      return bounds.minXIn - box.minXIn;
    case "maxX":
      return bounds.maxXIn - box.maxXIn;
    case "minY":
      return bounds.minYIn - box.minYIn;
    case "maxY":
      return bounds.maxYIn - box.maxYIn;
  }
}

function wallOf(bounds: Box2, side: Side): SnapWall {
  if (side === "minX") return { axis: "x", atIn: bounds.minXIn };
  if (side === "maxX") return { axis: "x", atIn: bounds.maxXIn };
  if (side === "minY") return { axis: "y", atIn: bounds.minYIn };
  return { axis: "y", atIn: bounds.maxYIn };
}

/**
 * Which walls the footprint is within tolerance of, at most one per axis. A footprint that has
 * crossed a wall by any amount, while the point itself is still on the field, counts as near it,
 * so dragging into a wall rests the robot flush against it instead of leaving part of it outside (a
 * PERIMETER error). A point placed off the field altogether is deliberate and is left alone, and
 * Ctrl turns the snap off when a point really must overlap a wall.
 */
function engagedSides(box: Box2, bounds: Box2, pose: Pose): Side[] {
  const sides: Side[] = [];
  const onField =
    pose.xIn >= bounds.minXIn && pose.xIn <= bounds.maxXIn && pose.yIn >= bounds.minYIn && pose.yIn <= bounds.maxYIn;
  if (!onField) {
    // Off the field: only the v1 rule, a wall within the tolerance either side.
    if (Math.abs(box.minXIn - bounds.minXIn) <= WALL_SNAP_IN) sides.push("minX");
    else if (Math.abs(bounds.maxXIn - box.maxXIn) <= WALL_SNAP_IN) sides.push("maxX");
    if (Math.abs(box.minYIn - bounds.minYIn) <= WALL_SNAP_IN) sides.push("minY");
    else if (Math.abs(bounds.maxYIn - box.maxYIn) <= WALL_SNAP_IN) sides.push("maxY");
    return sides;
  }
  const inside = {
    minX: box.minXIn - bounds.minXIn,
    maxX: bounds.maxXIn - box.maxXIn,
    minY: box.minYIn - bounds.minYIn,
    maxY: bounds.maxYIn - box.maxYIn,
  };
  // Where the box is past both walls of an axis (wider than the field), the nearer one wins.
  if (inside.minX <= WALL_SNAP_IN && inside.minX <= inside.maxX) sides.push("minX");
  else if (inside.maxX <= WALL_SNAP_IN) sides.push("maxX");
  if (inside.minY <= WALL_SNAP_IN && inside.minY <= inside.maxY) sides.push("minY");
  else if (inside.maxY <= WALL_SNAP_IN) sides.push("maxY");
  return sides;
}

/** How many times the flush shift is re-solved when the box moves with the position. */
const WALL_ITERATIONS = 8;
const FLUSH_EPSILON_IN = 1e-6;

/**
 * Rule 3: the pose moved so the footprint sits flush against every wall it is near. The box can
 * change as the pose moves (a tangent heading turns with its endpoint), so the shift is solved,
 * applied and re-checked until the residual is below a micro-inch.
 */
function wallSnap(
  pose: Pose,
  context: SnapContext,
): { pose: Pose; walls: SnapWall[]; mouth: boolean } | null {
  const first = context.footprintBounds(pose);
  if (first === null) return null;
  const sides = engagedSides(first, context.bounds, pose);
  if (sides.length === 0) return null;

  let current = pose;
  let box = first;
  for (let iteration = 0; iteration < WALL_ITERATIONS; iteration += 1) {
    let dxIn = 0;
    let dyIn = 0;
    for (const side of sides) {
      const shift = residual(box, context.bounds, side);
      if (side === "minX" || side === "maxX") dxIn = shift;
      else dyIn = shift;
    }
    if (Math.abs(dxIn) < FLUSH_EPSILON_IN && Math.abs(dyIn) < FLUSH_EPSILON_IN) break;
    current = { ...current, xIn: current.xIn + dxIn, yIn: current.yIn + dyIn };
    const next = context.footprintBounds(current);
    if (next === null) break;
    box = next;
  }

  let mouth = false;
  const body = context.bodyBounds?.(current) ?? null;
  if (body !== null) {
    for (const side of sides) {
      // The union reaches further than the body on this side, so a mouth is what is touching.
      const bodyGap = residual(body, context.bounds, side);
      const unionGap = residual(box, context.bounds, side);
      if (Math.abs(bodyGap - unionGap) > 1e-3) mouth = true;
    }
  }
  return { pose: current, walls: sides.map((side) => wallOf(context.bounds, side)), mouth };
}

export function snapPose(pose: Pose, context: SnapContext): SnapResult {
  if (!context.enabled) return { pose, kind: "none" };

  const waypoint = nearestWaypoint(pose, context);
  if (waypoint !== null) {
    return {
      pose: { xIn: waypoint.xIn, yIn: waypoint.yIn, headingRad: pose.headingRad },
      kind: "waypoint",
      waypoint: waypoint.name,
    };
  }

  const gridded: Pose = context.altHeld
    ? pose
    : { xIn: round(pose.xIn, GRID_IN), yIn: round(pose.yIn, GRID_IN), headingRad: pose.headingRad };

  const wall = wallSnap(gridded, context);
  if (wall !== null) {
    const result: SnapResult = { pose: wall.pose, kind: "wall", walls: wall.walls };
    if (wall.mouth) result.mouth = true;
    return result;
  }

  return { pose: gridded, kind: context.altHeld ? "none" : "grid" };
}

export interface HeadingSnapResult {
  headingRad: number;
  snapped: boolean;
}

export const quantiseHeading = (headingRad: number, stepDeg: number): number =>
  wrapAngle(degToRad(round(radToDeg(headingRad), stepDeg)));

export function snapHeading(headingRad: number, context: SnapContext): HeadingSnapResult {
  if (!context.enabled || context.altHeld) return { headingRad: wrapAngle(headingRad), snapped: false };
  return { headingRad: quantiseHeading(headingRad, HEADING_SNAP_DEG), snapped: true };
}

/** The words the drag bubble and the corner readout use for what a position snap did. */
export function snapLabel(result: SnapResult | null): string | null {
  if (result === null) return null;
  switch (result.kind) {
    case "none":
      return null;
    case "waypoint":
      return `waypoint ${result.waypoint ?? ""}`.trim();
    case "grid":
      return `grid ${String(GRID_IN)} in`;
    case "wall":
      return result.mouth === true ? "wall (mouth)" : "wall";
  }
}
