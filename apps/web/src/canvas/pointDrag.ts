/**
 * What one frame of a point drag writes, as a list of moves (site/docs/editor.md).
 *
 * One leader, the rest follow: the point under the pointer is the leader, it is the only one the
 * snap rules see, and every other moved point takes the leader's delta from where it was when the
 * press began (so nothing drifts over a long drag). The moves are, in order:
 *
 * 1. the leader, at its snapped pose;
 * 2. every other selected point, at its start plus the leader's delta;
 * 3. the Bezier handles each moved endpoint carries (`bezier.ts`), at their start plus the delta;
 * 4. when the leader is a handle of a smooth node, and Shift is not held, the opposite handle,
 *    swung to stay collinear through the node.
 *
 * A point is only ever written once per frame: a handle that is itself selected moves as a selected
 * point and is not carried a second time.
 *
 * Also here: the heading drag's payload, which is a pose whose position is exactly the point's
 * position at the press, because a heading drag never moves a point (v1's bug, `App.tsx:160`).
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
  HEADING_COARSE_DEG,
  HEADING_SNAP_DEG,
  quantiseHeading,
  snapHeading,
  snapLabel,
  snapPose,
  type SnapContext,
  type SnapResult,
} from "./snap.js";
import { constrainToAxis, dominantAxis, type DragModifiers } from "./modifiers.js";
import type { PointTarget, PoseMove, SelectedPoint } from "./types.js";

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
}

export function planPointDrag(input: PointDragInput): PoseMove[] {
  const { leader, leaderPose, followers } = input;
  const dxIn = leaderPose.xIn - leader.pose.xIn;
  const dyIn = leaderPose.yIn - leader.pose.yIn;
  const moves: PoseMove[] = [];
  const written = new Set<string>();
  const put = (stepId: string, target: PointTarget, pose: Pose): void => {
    const key = pointKey(stepId, target);
    if (written.has(key)) return;
    written.add(key);
    moves.push({ stepId, target, pose });
  };

  put(leader.stepId, leader.point, leaderPose);
  for (const follower of followers) {
    put(follower.stepId, follower.point, {
      ...follower.pose,
      xIn: follower.pose.xIn + dxIn,
      yIn: follower.pose.yIn + dyIn,
    });
  }

  // Endpoints carry the handles they own.
  for (const moved of [leader, ...followers]) {
    if (moved.point.pointKind === "control") continue;
    const polygons = input.polygonsOf(moved.stepId);
    if (polygons === null) continue;
    for (const handle of carriedHandles(polygons, moved.point)) {
      put(moved.stepId, handle.target, {
        xIn: handle.pointIn.xIn + dxIn,
        yIn: handle.pointIn.yIn + dyIn,
        headingRad: moved.pose.headingRad,
      });
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
        put(leader.stepId, opposite.target, { ...pointIn, headingRad: leaderPose.headingRad });
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
  return [{ stepId, target: node.outgoing.target, pose: { ...pointIn, headingRad: 0 } }];
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

/**
 * Where the point under the pointer goes this frame: Shift's axis constraint first (measured from
 * the press), then the snap rules with Ctrl's inversion and Alt's quantise bypass applied. A snap
 * that would pull the point off the constrained axis (a waypoint beside the line, a wall on the
 * other axis) is not allowed to: the constraint is what the user is holding a key for.
 */
export function resolveLeader(
  start: Pose,
  pointerIn: Vec2,
  modifiers: DragModifiers,
  context: SnapContext,
): LeaderResult {
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

  const parts: string[] = [];
  const snapText = snapLabel(snap);
  if (snapText !== null) parts.push(snapText);
  else if (!modifiers.snap) parts.push(modifiers.inverted ? "snap off (Ctrl)" : "snap off");
  else if (!modifiers.quantise) parts.push("free (Alt)");
  if (axis !== null) parts.push(`axis ${axis} (Shift)`);
  return { pose: snap.pose, snap, label: parts.length === 0 ? null : parts.join(" · ") };
}
