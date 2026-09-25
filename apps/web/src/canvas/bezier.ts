/**
 * Bezier nodes: where two segments of a path step meet, and the handles either side of them
 * (site/docs/editor.md).
 *
 * A path step is a chain of segments, each a control polygon `[from, ...controls, to]`. Node k is
 * where segment k-1 ends and segment k starts (node 0 is the step's start, node n its end). Its
 * **incoming** handle is segment k-1's last control point and its **outgoing** handle is segment k's
 * first. A node with both is either:
 *
 * - **smooth**: the two handles stay on one line through the node, so the path has no kink there.
 *   Dragging one handle swings the other to the opposite direction, keeping that handle's own
 *   length (PathPlanner keeps a length per side, and so does this). Shift breaks it for one drag.
 * - **corner**: the handles move independently.
 *
 * The file has no field for the kind, so a node's kind is inferred from its geometry (handles
 * collinear within `SMOOTH_TOLERANCE_DEG` read as smooth) until the user sets it with `S` or `C`
 * or the context menu, and the canvas remembers that choice for the session.
 *
 * Dragging a node carries the handles it owns: segment k-1's last control and segment k's first,
 * when that segment has two or more controls. A quadratic's single control belongs to both of its
 * ends, so it stays where it is, which is what every vector editor does with a shared handle.
 *
 * Pure arithmetic on control polygons.
 */
import type { Vec2 } from "@horizon36596/zenith-core";
import type { PointTarget } from "./types.js";

export type NodeKind = "smooth" | "corner";

export const SMOOTH_TOLERANCE_DEG = 2;

export interface NodeHandle {
  target: PointTarget;
  pointIn: Vec2;
}

export interface BezierNode {
  index: number;
  /** The draggable endpoint the node is. */
  endpoint: PointTarget;
  positionIn: Vec2;
  incoming?: NodeHandle;
  outgoing?: NodeHandle;
}

const controlTarget = (segmentIndex: number, controlIndex: number): PointTarget => ({
  segmentIndex,
  pointKind: "control",
  controlIndex,
});

export const endpointOfNode = (index: number): PointTarget =>
  index === 0 ? { segmentIndex: 0, pointKind: "from" } : { segmentIndex: index - 1, pointKind: "to" };

/** The node an endpoint target is, or null for a control point. */
export function nodeIndexOf(target: PointTarget): number | null {
  if (target.pointKind === "from") return target.segmentIndex;
  if (target.pointKind === "to") return target.segmentIndex + 1;
  return null;
}

export function bezierNodes(polygons: readonly (readonly Vec2[])[]): BezierNode[] {
  const nodes: BezierNode[] = [];
  for (let index = 0; index <= polygons.length; index += 1) {
    const before = polygons[index - 1];
    const after = polygons[index];
    const positionIn = (after?.[0] ?? before?.[before.length - 1]) as Vec2 | undefined;
    if (positionIn === undefined) continue;
    const node: BezierNode = { index, endpoint: endpointOfNode(index), positionIn };
    if (before !== undefined && before.length > 2) {
      node.incoming = {
        target: controlTarget(index - 1, before.length - 3),
        pointIn: before[before.length - 2] as Vec2,
      };
    }
    if (after !== undefined && after.length > 2) {
      node.outgoing = { target: controlTarget(index, 0), pointIn: after[1] as Vec2 };
    }
    nodes.push(node);
  }
  return nodes;
}

/** Smooth when both handles sit on one line through the node, corner otherwise; null with fewer. */
export function inferNodeKind(node: BezierNode): NodeKind | null {
  if (node.incoming === undefined || node.outgoing === undefined) return null;
  const a = { xIn: node.incoming.pointIn.xIn - node.positionIn.xIn, yIn: node.incoming.pointIn.yIn - node.positionIn.yIn };
  const b = { xIn: node.outgoing.pointIn.xIn - node.positionIn.xIn, yIn: node.outgoing.pointIn.yIn - node.positionIn.yIn };
  if (Math.hypot(a.xIn, a.yIn) < 1e-9 || Math.hypot(b.xIn, b.yIn) < 1e-9) return "smooth";
  // Opposite directions: the angle between a and -b is near zero.
  const angle = Math.abs(Math.atan2(a.xIn * -b.yIn - a.yIn * -b.xIn, a.xIn * -b.xIn + a.yIn * -b.yIn));
  return (angle * 180) / Math.PI <= SMOOTH_TOLERANCE_DEG ? "smooth" : "corner";
}

const sameTarget = (a: PointTarget, b: PointTarget): boolean =>
  a.segmentIndex === b.segmentIndex &&
  a.pointKind === b.pointKind &&
  (a.pointKind !== "control" || (a.controlIndex ?? 0) === (b.controlIndex ?? 0));

/** Every node a control point is a handle of, and which side of it the point is. */
export function nodesOfHandle(
  nodes: readonly BezierNode[],
  target: PointTarget,
): Array<{ node: BezierNode; side: "incoming" | "outgoing" }> {
  if (target.pointKind !== "control") return [];
  const out: Array<{ node: BezierNode; side: "incoming" | "outgoing" }> = [];
  for (const node of nodes) {
    if (node.incoming !== undefined && sameTarget(node.incoming.target, target)) out.push({ node, side: "incoming" });
    if (node.outgoing !== undefined && sameTarget(node.outgoing.target, target)) out.push({ node, side: "outgoing" });
  }
  return out;
}

/** The node a point target names or is a handle of: an endpoint's own node, or a handle's nodes. */
export function nodesForTarget(nodes: readonly BezierNode[], target: PointTarget): BezierNode[] {
  const own = nodeIndexOf(target);
  if (own !== null) return nodes.filter((node) => node.index === own);
  return nodesOfHandle(nodes, target).map((entry) => entry.node);
}

/**
 * Where the opposite handle goes when one handle of a smooth node is at `draggedIn`: straight
 * through the node on the far side, at the opposite handle's own length.
 */
export function mirroredOpposite(nodeIn: Vec2, draggedIn: Vec2, oppositeIn: Vec2): Vec2 {
  const dx = draggedIn.xIn - nodeIn.xIn;
  const dy = draggedIn.yIn - nodeIn.yIn;
  const reach = Math.hypot(dx, dy);
  const keep = Math.hypot(oppositeIn.xIn - nodeIn.xIn, oppositeIn.yIn - nodeIn.yIn);
  if (reach < 1e-9) return oppositeIn;
  return { xIn: nodeIn.xIn - (dx / reach) * keep, yIn: nodeIn.yIn - (dy / reach) * keep };
}

/**
 * The handles a node drag carries with it: segment k-1's last control and segment k's first, when
 * that segment has two or more controls (so the control belongs to this end alone).
 */
export function carriedHandles(polygons: readonly (readonly Vec2[])[], endpoint: PointTarget): NodeHandle[] {
  const index = nodeIndexOf(endpoint);
  if (index === null) return [];
  const out: NodeHandle[] = [];
  const before = polygons[index - 1];
  if (before !== undefined && before.length - 2 >= 2) {
    out.push({ target: controlTarget(index - 1, before.length - 3), pointIn: before[before.length - 2] as Vec2 });
  }
  const after = polygons[index];
  if (after !== undefined && after.length - 2 >= 2) {
    out.push({ target: controlTarget(index, 0), pointIn: after[1] as Vec2 });
  }
  return out;
}

/** The session's remembered node kinds, keyed by step and node index. */
export const nodeKey = (stepId: string, index: number): string => `${stepId}#${String(index)}`;

/** The kind a node is treated as: the remembered choice, or else what its geometry says. */
export const effectiveNodeKind = (
  remembered: ReadonlyMap<string, NodeKind>,
  stepId: string,
  node: BezierNode,
): NodeKind | null => {
  if (node.incoming === undefined || node.outgoing === undefined) return null;
  return remembered.get(nodeKey(stepId, node.index)) ?? inferNodeKind(node);
};
