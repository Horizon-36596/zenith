/**
 * What one frame of a point drag writes, as a list of moves (site/docs/editor.md).
 *
 * One leader, the rest follow: the point under the pointer is the leader, it is the only one the
 * snap rules see, and every other moved point takes the leader's delta from where it was when the
 * press began (so nothing drifts over a long drag). The moves are, in order:
 *
 * 1. the leader, at its snapped pose, and the other end of the joint it sits on, at the same pose,
 *    both naming the waypoint the leader snapped onto, if it did, so the shell can make them follow
 *    it (issue #150);
 * 2. every other selected point, at its start plus the leader's delta, and the other end of its
 *    joint with it, unless that end is selected too and so moves by its own delta;
 * 3. the Bezier handles each moved endpoint carries (`bezier.ts`), at their start plus the delta;
 * 4. when the leader is a handle of a smooth node, and Shift is not held, the opposite handle,
 *    swung to stay collinear through the node.
 *
 * A joint is where one segment of a path ends and the next starts: two points in the file, one to
 * the editor (issue #146, core's `jointTwin`), so the path never tears there. A point is only ever
 * written once per frame: a handle that is itself selected moves as a selected point and is not
 * carried a second time, and a selection holding both ends of a joint moves it once.
 *
 * A Bezier handle is written with no heading: the runtime and Pedro ignore a control point's
 * heading, so one would only be noise in the file (N82).
 *
 * Also here: the heading drag's payload, which is a pose whose position is exactly the point's
 * position at the press, because a heading drag never moves a point (v1's bug, `App.tsx:160`), and
 * where an add-path or add-command click puts its point (`placeAddPoint`), which the preview under
 * the pointer and the click both use, so the click lands where the preview showed (issue #150).
 */
import { wrapAngle, type Pose, type Vec2 } from "@horizon36596/zenith-core";
import {
  bezierNodes,
  carriedHandles,
  effectiveNodeKind,
  mirroredOpposite,
  nodesOfHandle,
  type NodeKind,
} from "./bezier.js";
import {
  GRID_IN,
  HEADING_COARSE_DEG,
  HEADING_SNAP_DEG,
  quantiseHeading,
  snapHeading,
  snapLabel,
  snapPose,
  type SnapContext,
  type SnapResult,
} from "./snap.js";
import {
  constrainToAxis,
  constrainToRay,
  dominantAxis,
  pointOnRay,
  rayBearingLabel,
  type DragModifiers,
  type Ray,
  type RayPoint,
} from "./modifiers.js";
import type { MovedPose, PointTarget, PoseMove, SelectedPoint } from "./types.js";

export const pointKey = (stepId: string, target: PointTarget): string =>
  `${stepId}|${String(target.segmentIndex)}|${target.pointKind}|${String(target.pointKind === "control" ? (target.controlIndex ?? 0) : 0)}`;

/** One point's pose at the press. */
export interface StartPoint extends SelectedPoint {
  pose: Pose;
}

export interface PointDragInput {
  leader: StartPoint;
  /** Where the leader goes this frame, already snapped and constrained. */
  leaderPose: Pose;
  /** The other selected points, at the press. */
  followers: readonly StartPoint[];
  /** Each step's control polygons, at the press. */
  polygonsOf: (stepId: string) => readonly (readonly Vec2[])[] | null;
  nodeKinds: ReadonlyMap<string, NodeKind>;
  breakMirror: boolean;
  /**
   * The other end of the joint a point sits on, or null when it sits on none: core's `jointTwin`,
   * as the document stood at the press. Without it no point brings another along.
   */
  twinOf?: (stepId: string, target: PointTarget) => PointTarget | null;
  /** The waypoint the leader snapped onto this frame, when it did (issue #150). */
  leaderWaypoint?: string;
}

export function planPointDrag(input: PointDragInput): PoseMove[] {
  const { leader, leaderPose, followers } = input;
  const dxIn = leaderPose.xIn - leader.pose.xIn;
  const dyIn = leaderPose.yIn - leader.pose.yIn;
  const moves: PoseMove[] = [];
  const written = new Set<string>();
  const put = (stepId: string, target: PointTarget, pose: MovedPose, waypoint?: string): void => {
    const key = pointKey(stepId, target);
    if (written.has(key)) return;
    written.add(key);
    const move: PoseMove = { stepId, target, pose: target.pointKind === "control" ? { xIn: pose.xIn, yIn: pose.yIn } : pose };
    if (waypoint !== undefined) move.waypoint = waypoint;
    moves.push(move);
  };
  const selected = new Set([leader, ...followers].map((point) => pointKey(point.stepId, point.point)));
  const twinOf = (point: SelectedPoint): PointTarget | null => input.twinOf?.(point.stepId, point.point) ?? null;

  put(leader.stepId, leader.point, leaderPose, input.leaderWaypoint);
  const leaderTwin = twinOf(leader);
  if (leaderTwin !== null) put(leader.stepId, leaderTwin, leaderPose, input.leaderWaypoint);
  for (const follower of followers) {
    const pose = { ...follower.pose, xIn: follower.pose.xIn + dxIn, yIn: follower.pose.yIn + dyIn };
    put(follower.stepId, follower.point, pose);
    const twin = twinOf(follower);
    if (twin !== null && !selected.has(pointKey(follower.stepId, twin))) put(follower.stepId, twin, pose);
  }

  // Endpoints carry the handles they own.
  for (const moved of [leader, ...followers]) {
    if (moved.point.pointKind === "control") continue;
    const polygons = input.polygonsOf(moved.stepId);
    if (polygons === null) continue;
    for (const handle of carriedHandles(polygons, moved.point)) {
      put(moved.stepId, handle.target, { xIn: handle.pointIn.xIn + dxIn, yIn: handle.pointIn.yIn + dyIn });
    }
  }

  // A lone handle of a smooth node swings its opposite number.
  if (leader.point.pointKind === "control" && followers.length === 0 && !input.breakMirror) {
    const polygons = input.polygonsOf(leader.stepId);
    if (polygons !== null) {
      const nodes = bezierNodes(polygons);
      for (const { node, side } of nodesOfHandle(nodes, leader.point)) {
        if (effectiveNodeKind(input.nodeKinds, leader.stepId, node) !== "smooth") continue;
        const opposite = side === "incoming" ? node.outgoing : node.incoming;
        if (opposite === undefined) continue;
        const pointIn = mirroredOpposite(node.positionIn, leaderPose, opposite.pointIn);
        put(leader.stepId, opposite.target, { xIn: pointIn.xIn, yIn: pointIn.yIn });
      }
    }
  }
  return moves;
}

/**
 * The moves that make a node smooth: the outgoing handle swung to sit opposite the incoming one,
 * keeping its own length. Empty when the node lacks a handle on either side.
 */
export function smoothNodeMoves(
  stepId: string,
  polygons: readonly (readonly Vec2[])[],
  nodeIndex: number,
): PoseMove[] {
  const node = bezierNodes(polygons).find((candidate) => candidate.index === nodeIndex);
  if (node?.incoming === undefined || node.outgoing === undefined) return [];
  const pointIn = mirroredOpposite(node.positionIn, node.incoming.pointIn, node.outgoing.pointIn);
  return [{ stepId, target: node.outgoing.target, pose: { xIn: pointIn.xIn, yIn: pointIn.yIn } }];
}

export interface HeadingDragResult {
  headingRad: number;
  /** The full pose to write: the press-time position, untouched, with the new heading. */
  pose: Pose;
  /** What set the heading, for the bubble: "15°", "45° (Shift)" or null for free. */
  label: string | null;
}

/**
 * One frame of a heading-handle drag. The heading is the bearing from the anchor to the pointer,
 * turned in 45 degree steps with Shift (a constraint, so the snap toggle does not matter), else in
 * 15 degree steps when snapping is on and Alt is not held.
 */
export function headingDrag(
  anchor: Pose,
  pointerIn: Vec2,
  modifiers: DragModifiers,
  context: SnapContext,
): HeadingDragResult {
  const raw = wrapAngle(Math.atan2(pointerIn.yIn - anchor.yIn, pointerIn.xIn - anchor.xIn));
  let headingRad: number;
  let label: string | null;
  if (modifiers.coarseHeading) {
    headingRad = quantiseHeading(raw, HEADING_COARSE_DEG);
    label = `${String(HEADING_COARSE_DEG)}° (Shift)`;
  } else {
    const snapped = snapHeading(raw, { ...context, enabled: modifiers.snap, altHeld: !modifiers.quantise });
    headingRad = snapped.headingRad;
    label = snapped.snapped ? `${String(HEADING_SNAP_DEG)}°` : modifiers.snap ? "free (Alt)" : modifiers.inverted ? "snap off (Ctrl)" : null;
  }
  return { headingRad, pose: { ...anchor, headingRad }, label };
}

export interface LeaderResult {
  pose: Pose;
  snap: SnapResult;
  /** Everything acting on the position, for the drag bubble, e.g. "grid 0.5 in · axis x (Shift)". */
  label: string | null;
}

/** A wall can be reached along a ray only when the ray crosses it at least this steeply (about 17 degrees). */
const RAY_WALL_MIN_COMPONENT = 0.3;
const RAY_WALL_ITERATIONS = 8;

/**
 * The snap rules for a point held to a ray (Shift on a path end, `constrainToRay`), every one of
 * them moving the point along the ray and never off it:
 *
 * 1. a waypoint within the pixel tolerance of the point, which is on the ray, so one that lies
 *    within the tolerance of the ray; the point then becomes the waypoint, as a waypoint snap always
 *    does, up to the tolerance off the ray. One further from the ray than that is not looked at;
 * 2. the length, rounded to `GRID_IN` unless Alt is held, never below zero;
 * 3. the wall: the length that puts the footprint flush against the wall it is near, found by moving
 *    along the ray. A wall the ray runs nearly parallel to cannot be reached that way and is left.
 *
 * With snapping off the projection is the value.
 */
export function snapAlongRay(constrained: RayPoint, headingRad: number, modifiers: DragModifiers, context: SnapContext): SnapResult {
  const ray: Ray = { anchorIn: constrained.anchorIn, bearingRad: constrained.bearingRad };
  const at = (lengthIn: number): Pose => ({ ...pointOnRay(ray, lengthIn), headingRad });
  if (!modifiers.snap) return { pose: at(constrained.lengthIn), kind: "none", ray };

  const snapContext: SnapContext = { ...context, enabled: true, altHeld: true };
  const waypoint = snapPose(at(constrained.lengthIn), { ...snapContext, footprintBounds: () => null });
  if (waypoint.kind === "waypoint") return { ...waypoint, ray };

  let lengthIn = modifiers.quantise ? Math.max(0, Math.round(constrained.lengthIn / GRID_IN) * GRID_IN) : constrained.lengthIn;
  const wallContext: SnapContext = { ...snapContext, waypoints: [] };
  let wall: SnapResult | null = null;
  for (let iteration = 0; iteration < RAY_WALL_ITERATIONS; iteration += 1) {
    const here = at(lengthIn);
    const walled = snapPose(here, wallContext);
    if (walled.kind !== "wall") break;
    let step: number | null = null;
    for (const side of walled.walls ?? []) {
      const along = side.axis === "x" ? Math.cos(ray.bearingRad) : Math.sin(ray.bearingRad);
      if (Math.abs(along) < RAY_WALL_MIN_COMPONENT) continue;
      const shift = side.axis === "x" ? walled.pose.xIn - here.xIn : walled.pose.yIn - here.yIn;
      const candidate = shift / along;
      if (step === null || Math.abs(candidate) < Math.abs(step)) step = candidate;
    }
    if (step === null) break;
    wall = walled;
    const next = Math.max(0, lengthIn + step);
    if (Math.abs(next - lengthIn) < 1e-6) break;
    lengthIn = next;
  }
  if (wall !== null) {
    const result: SnapResult = { pose: at(lengthIn), kind: "wall", ray };
    if (wall.walls !== undefined) result.walls = wall.walls;
    if (wall.mouth === true) result.mouth = true;
    return result;
  }
  return { pose: at(lengthIn), kind: modifiers.quantise ? "grid" : "none", ray };
}

/**
 * The anchor of the ray Shift keeps a dragged path end to: the other end of its segment, or for a
 * node that joins two segments the start of the incoming one. Null for a control point, which keeps
 * the axis rule, and for a point whose segment is not in `polygons`.
 */
export function rayAnchorOf(polygons: readonly (readonly Vec2[])[], target: PointTarget): Vec2 | null {
  if (target.pointKind === "control") return null;
  const segment = target.pointKind === "to" || target.segmentIndex === 0 ? polygons[target.segmentIndex] : polygons[target.segmentIndex - 1];
  if (segment === undefined) return null;
  // A segment's own end is anchored on its start; the start of the first segment, on the end.
  const anchor = target.pointKind === "from" && target.segmentIndex === 0 ? segment[segment.length - 1] : segment[0];
  return anchor === undefined ? null : { xIn: anchor.xIn, yIn: anchor.yIn };
}

/** What Shift's ray says in the bubble and the corner readout, e.g. "line 45° · length (Shift)". */
export const rayConstraintLabel = (ray: Ray): string => `line ${rayBearingLabel(ray.bearingRad)} · length (Shift)`;

/** The bubble's words for a position: the snap acting, else why none is, then Shift's constraint. */
function leaderLabel(snap: SnapResult, modifiers: DragModifiers, constraint: string | null): string | null {
  const parts: string[] = [];
  const snapText = snapLabel(snap);
  if (snapText !== null) parts.push(snapText);
  else if (!modifiers.snap) parts.push(modifiers.inverted ? "snap off (Ctrl)" : "snap off");
  else if (!modifiers.quantise) parts.push("free (Alt)");
  if (constraint !== null) parts.push(constraint);
  return parts.length === 0 ? null : parts.join(" · ");
}

/**
 * Where the point under the pointer goes this frame: Shift's constraint first, then the snap rules
 * with Ctrl's inversion and Alt's quantise bypass applied. Without `anchorIn` the constraint is the
 * axis lock, measured from the press: the point moves along whichever axis the pointer has travelled
 * further on, and a snap that would pull it off that axis (a waypoint beside the line, a wall on the
 * other axis) is not allowed to. With `anchorIn`, a path end's segment's other end, the constraint is
 * the ray from it (`constrainToRay`, `snapAlongRay`): the line's bearing at the press is read from
 * `start`.
 */
export function resolveLeader(
  start: Pose,
  pointerIn: Vec2,
  modifiers: DragModifiers,
  context: SnapContext,
  anchorIn?: Vec2,
): LeaderResult {
  if (modifiers.constrainAxis && anchorIn !== undefined) {
    const apart = Math.hypot(start.xIn - anchorIn.xIn, start.yIn - anchorIn.yIn);
    const pressBearing = apart > 1e-9 ? Math.atan2(start.yIn - anchorIn.yIn, start.xIn - anchorIn.xIn) : undefined;
    const constrained = constrainToRay(anchorIn, pointerIn, pressBearing);
    const snap = snapAlongRay(constrained, start.headingRad, modifiers, context);
    const constraint = rayConstraintLabel(constrained);
    return { pose: snap.pose, snap, label: leaderLabel(snap, modifiers, constraint) };
  }

  const axis = modifiers.constrainAxis ? dominantAxis(start, pointerIn) : null;
  const wanted = axis === null ? pointerIn : constrainToAxis(start, pointerIn, axis);
  const snapContext: SnapContext = { ...context, enabled: modifiers.snap, altHeld: !modifiers.quantise };
  let snap = snapPose({ ...wanted, headingRad: start.headingRad }, snapContext);

  if (axis !== null) {
    const offAxis = axis === "x" ? snap.pose.yIn !== start.yIn : snap.pose.xIn !== start.xIn;
    if (offAxis && snap.kind === "waypoint") {
      snap = snapPose({ ...wanted, headingRad: start.headingRad }, { ...snapContext, waypoints: [] });
    }
    snap = {
      ...snap,
      pose: axis === "x" ? { ...snap.pose, yIn: start.yIn } : { ...snap.pose, xIn: start.xIn },
    };
  }

  return { pose: snap.pose, snap, label: leaderLabel(snap, modifiers, axis === null ? null : `axis ${axis} (Shift)`) };
}

/** An add-path click this close to the pose it would continue from adds nothing (a double-click). */
export const ADD_POINT_MIN_IN = 0.75;

export interface AddPointInput {
  /** The pointer, in the file's own frame. */
  pointerIn: Vec2;
  /** The pose the new point continues from: the end of the step it goes after. */
  from: Pose;
  /** A path point aims along its bearing from `from`; a command keeps `from`'s heading. */
  adding: "path" | "command";
  modifiers: DragModifiers;
  /** The snap rules, with the wall rule's footprint at the pose being placed. */
  context: SnapContext;
  /**
   * Start a new path with the previous path's end heading (issue #435): a path point keeps `from`'s
   * heading instead of facing along its bearing, so the preview shows the heading the new path ends at.
   */
  keepHeading?: boolean;
}

/**
 * Where an add-path or add-command click at the pointer puts its point (issue #150), or null for a
 * path point closer than `ADD_POINT_MIN_IN` to the pose it continues from. A path point faces along
 * its bearing from that pose, and the snap rules run on it, the wall rule against the robot's
 * footprint at that heading. The preview under the pointer, the click and the field menu's "Add a
 * path to here" all call this, so the point lands where the preview drew it. With Shift held a path
 * point goes on the nearest 45 degree ray from `from` instead (`snapAlongRay`), so the new line has
 * a bearing that is a multiple of 45 degrees.
 */
export function placeAddPoint(input: AddPointInput): SnapResult | null {
  const { pointerIn, from, adding, modifiers, context } = input;
  const keep = adding === "path" && input.keepHeading === true;
  if (adding === "path" && modifiers.constrainAxis) {
    // Shift keeps the new line to a 45 degree bearing from where it starts, as it does a dragged end.
    const constrained = constrainToRay(from, pointerIn);
    if (constrained.lengthIn < ADD_POINT_MIN_IN) return null;
    const along = snapAlongRay(constrained, constrained.bearingRad, modifiers, context);
    if (tooCloseToAdd(along.pose, from)) return null;
    return keep ? { ...along, pose: { ...along.pose, headingRad: from.headingRad } } : along;
  }
  const away = Math.hypot(pointerIn.xIn - from.xIn, pointerIn.yIn - from.yIn);
  if (adding === "path" && away < ADD_POINT_MIN_IN) return null;
  const headingRad =
    adding === "command" || keep || away < 1e-6 ? from.headingRad : Math.atan2(pointerIn.yIn - from.yIn, pointerIn.xIn - from.xIn);
  const snapped = snapPose(
    { xIn: pointerIn.xIn, yIn: pointerIn.yIn, headingRad },
    { ...context, enabled: modifiers.snap, altHeld: !modifiers.quantise },
  );
  // A snap can pull a point the pointer put far enough away back onto `from` (a path that ends on a
  // waypoint, clicked just past that waypoint), which would add a path of no length (issue #402).
  if (adding === "path" && tooCloseToAdd(snapped.pose, from)) return null;
  return snapped;
}

/** Whether a placed path point is closer than `ADD_POINT_MIN_IN` to the pose it continues from. */
function tooCloseToAdd(pose: Vec2, from: Vec2): boolean {
  return Math.hypot(pose.xIn - from.xIn, pose.yIn - from.yIn) < ADD_POINT_MIN_IN;
}
