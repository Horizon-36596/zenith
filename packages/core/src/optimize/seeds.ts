import type { Field, PathStep, Robot } from "@horizon36596/zenith-schema";
import { boxCorners, convexHull, inflateBox, type Box2 } from "../geometry/sat.js";
import { add, cross, distance, dot, normalize, scale, sub, type Vec2 } from "../geometry/vec.js";
import type { ResolvedStep } from "../resolve.js";
import {
  emitStep,
  MIN_CANDIDATE_LENGTH_IN,
  routeEndsOf,
  type CandidateHeading,
  type CandidatePath,
  type RouteCandidate,
  type RouteEnds,
} from "./candidate.js";
import { CLEARANCE_EPSILON_IN, clearanceWorld, type ClearanceWorld } from "./clearance.js";
import { sweptAngleRad } from "./homotopy.js";
import { directionRad, FILLET_ALLOWANCE_IN, smoothPolyline, type ChainPiece, type RouteGeometry } from "./smooth.js";

/**
 * The optimizer's geometry seeds: the routes a search starts from, in a fixed order.
 *
 * 1. G0, the original step's own geometry, so the search can start from doing nothing.
 * 2. G1, the straight line from S to E, and the single cubic whose end tangents are the S and E
 *    headings.
 * 3. G2, routes through a visibility graph over the structures grown by the margin plus the
 *    footprint's half-width and the keep-outs grown by the half-width: Yen's three shortest
 *    loopless routes, with the routes that pass every obstacle on the same side as a shorter one
 *    merged into it, each smoothed into a chain (`smooth.ts`).
 *
 * A seed is geometry only. The heading families (H-default, H-dp, H-tan, H-rev, H-lin) are applied
 * to every seed by the heading unit, and `candidateFromSeed` joins a seed and a heading into a
 * `RouteCandidate`. Every seed listed here is one `emitStep` accepts, no seed has more paths than
 * `maxPaths`, and a route that is the same as an earlier seed is listed once. Whatever is left out
 * is listed in `skipped` with a sentence, so the caller can say why.
 *
 * The growth is deliberately optimistic: the half-width is half the footprint's narrower side, and
 * it ignores the corners and the mouths. The penalties and the hard final check hold the true
 * footprint.
 *
 * No randomness, no clock: the same inputs give deep-equal seeds. Pure (CLAUDE.md rule 1).
 */

/** How many shortest routes Yen's algorithm looks for (SET BY HAND: spec 16 section 6.2). */
export const YEN_ROUTE_COUNT = 3;

/**
 * The larger allowances, in inches and in order, a visibility route is smoothed with when the
 * original is blocked (`check()` finds it going through something) and the chain at `FILLET_ALLOWANCE_IN` needs
 * more paths than `maxPaths` (SET BY HAND: issue #388, search-only, doubling from the fillet
 * allowance). A coarser seed, which the local search and the penalties then pull clear, is better
 * than none: the way round the west of the hive frame from the starter's scoring spot needs five
 * paths at 1.5 in, so a step through the frame had no clear seed at all. The margin is still
 * enforced by the penalties and the hard final check, not by this.
 */
export const FILLET_FALLBACK_ALLOWANCES_IN: readonly number[] = [3, 6, 12, 24, 48];

/**
 * The end-tangent cubic's handles, as a fraction of the S to E distance (SET BY HAND: a third is
 * where a cubic with both handles along its chord traces the straight line at an even speed, so the
 * seed starts as close to the chord as its end tangents allow; the local search tunes the handles).
 */
export const END_TANGENT_HANDLE_FRACTION = 1 / 3;

/** Float noise allowed when points, lengths and sides are compared. It is arithmetic slack, not a margin. */
const SLACK_IN = CLEARANCE_EPSILON_IN;

/** Which seed family a seed comes from, in the order they are listed. */
export type SeedFamily = "original" | "straight" | "endTangentCubic" | "visibility";

/** Which side of a route an obstacle is on, looking along the route from S to E. */
export interface ObstacleSide {
  kind: "structure" | "keepOut";
  id: string;
  side: "left" | "right";
}

/** A route through the visibility graph: node indices, the points they stand for, and its length. */
export interface GraphRoute {
  nodes: number[];
  pointsIn: Vec2[];
  lengthIn: number;
}

/** A visibility route as a seed carries it: the polyline it was smoothed from and the side it passes each obstacle on. */
export interface VisibilityRoute extends GraphRoute {
  sides: ObstacleSide[];
}

/** One geometry seed. */
export interface GeometrySeed {
  family: SeedFamily;
  geometry: RouteGeometry;
  /** For a G2 seed: the route it smooths. */
  route?: VisibilityRoute;
  /** For a G2 seed: its chain, piece by piece, each with its bound on how far it strays from `route`. */
  pieces?: ChainPiece[];
  /** For a G2 seed: the allowance its chain was smoothed within, `FILLET_ALLOWANCE_IN` or one of `FILLET_FALLBACK_ALLOWANCES_IN`. */
  allowanceIn?: number;
}

/** A seed that was left out, and why. */
export interface SkippedSeed {
  family: SeedFamily;
  reason: string;
}

export interface GeometrySeeds {
  /** The route's ends, as every seed shares them. */
  ends: RouteEnds;
  seeds: GeometrySeed[];
  skipped: SkippedSeed[];
}

export interface SeedInput {
  /** The path step being re-routed, as `resolve` resolved it. */
  resolved: ResolvedStep;
  robot: Robot;
  field: Field;
  /** The safety margin for this run, in inches (spec 16 section 4.1). */
  marginIn: number;
  /** The most paths a seed may have (spec 16 section 3). */
  maxPaths: number;
  /**
   * What the routes go round, the objective's own world, so a seed avoids everything the search
   * scores against, the other alliance's side included (issue #365). Left out, the field's
   * structures and keep-outs.
   */
  world?: ClearanceWorld;
  /**
   * True when the original is blocked, `check()` finding it going through something (issue #388): a visibility route
   * whose chain does not fit `maxPaths` at the fillet allowance is then smoothed again at each of
   * `FILLET_FALLBACK_ALLOWANCES_IN`, because the original and the straight line both go through
   * something and a way round is the only clear start. Default false, which keeps the seeds of a
   * clear original as they were.
   */
  fallbackAllowances?: boolean;
}

/** One obstacle of the visibility graph. */
export interface GraphObstacle {
  kind: "structure" | "keepOut";
  id: string;
  /** The obstacle itself, convex and counter-clockwise: a structure's shadow or a keep-out's box. */
  shapeIn: Vec2[];
  /** The obstacle grown as the graph grows it, convex and counter-clockwise. Its corners are graph nodes. */
  grownIn: Vec2[];
  /** The point a route's side is measured about: the mean of the shape's corners. */
  centreIn: Vec2;
}

/** The visibility graph of one route's ends over one world. */
export interface VisibilityGraph {
  /** S, E, then every grown obstacle's corners, in obstacle order (structures, then keep-outs) and corner order. */
  nodesIn: Vec2[];
  /** False for a corner outside the field, as the half-width allows it, or strictly inside another grown obstacle. */
  usable: boolean[];
  /** `visible[i][j]` is true when the line from node i to node j crosses no grown obstacle's inside. */
  visible: boolean[][];
  /** `lengthIn[i][j]` is the distance from node i to node j. */
  lengthIn: number[][];
  obstacles: GraphObstacle[];
}

export interface GraphOptions {
  marginIn: number;
  halfWidthIn: number;
}

/**
 * Half the footprint's narrower side, in inches: how far the graph grows every obstacle for the
 * robot's own size. It is the optimistic half-width, so the graph never shuts a gap the robot fits.
 */
export const footprintHalfWidthIn = (robot: Robot): number =>
  Math.min(robot.footprint.expandedIn.lengthIn, robot.footprint.expandedIn.widthIn) / 2;

/** A seed and a heading as one candidate for `emitStep`. */
export function candidateFromSeed(seed: GeometrySeed, ends: RouteEnds, heading: CandidateHeading): RouteCandidate {
  return {
    ends,
    jointsIn: seed.geometry.jointsIn,
    tangentsRad: seed.geometry.tangentsRad,
    paths: seed.geometry.paths,
    heading,
  };
}

/** The outward unit normal of each edge of a counter-clockwise polygon, with the edge's start. */
function edgeNormals(polygon: readonly Vec2[]): { from: Vec2; normal: Vec2 }[] {
  return polygon.map((from, k) => {
    const to = polygon[(k + 1) % polygon.length] as Vec2;
    return { from, normal: normalize({ xIn: to.yIn - from.yIn, yIn: from.xIn - to.xIn }) };
  });
}

/** True when the point is inside the convex polygon by more than float noise. */
function strictlyInside(point: Vec2, polygon: readonly Vec2[]): boolean {
  if (polygon.length < 3) return false;
  return edgeNormals(polygon).every(({ from, normal }) => dot(normal, sub(point, from)) < -SLACK_IN);
}

/**
 * True when the segment from a to b passes through the convex polygon's inside (Cyrus-Beck). A
 * segment that only touches a corner or runs along an edge does not.
 */
function crossesInside(a: Vec2, b: Vec2, polygon: readonly Vec2[]): boolean {
  if (polygon.length < 3) return false;
  const along = sub(b, a);
  let enter = 0;
  let leave = 1;
  for (const { from, normal } of edgeNormals(polygon)) {
    // The segment is inside this edge where normal . (a + t along - from) < -slack.
    const offset = dot(normal, sub(a, from)) + SLACK_IN;
    const rate = dot(normal, along);
    if (rate === 0) {
      if (offset >= 0) return false;
      continue;
    }
    const t = -offset / rate;
    if (rate > 0) leave = Math.min(leave, t);
    else enter = Math.max(enter, t);
    if (enter >= leave) return false;
  }
  return leave - enter > 0;
}

/** A convex polygon grown by `byIn` on every axis: its corners, each moved by (+-by, +-by), hulled. */
function grownPolygon(polygon: readonly Vec2[], byIn: number): Vec2[] {
  const moved: Vec2[] = [];
  for (const point of polygon) {
    for (const [dx, dy] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      moved.push({ xIn: point.xIn + dx * byIn, yIn: point.yIn + dy * byIn });
    }
  }
  return convexHull(moved);
}

const meanOf = (points: readonly Vec2[]): Vec2 =>
  scale(
    points.reduce((sum, point) => add(sum, point), { xIn: 0, yIn: 0 }),
    1 / Math.max(points.length, 1),
  );

const insideBox = (point: Vec2, box: Box2): boolean =>
  point.xIn >= box.minXIn - SLACK_IN &&
  point.xIn <= box.maxXIn + SLACK_IN &&
  point.yIn >= box.minYIn - SLACK_IN &&
  point.yIn <= box.maxYIn + SLACK_IN;

/**
 * The visibility graph between S and E (spec 16 section 6.2, G2). Structures are grown by the
 * margin plus the half-width, keep-outs by the half-width alone (D8 puts no margin on them), and
 * the field's walls hold every corner at least the half-width inside.
 *
 * A line from node i to node j is visible when it crosses no grown obstacle's inside. An end that
 * already sits inside a grown obstacle, as a scoring pose against a face may (section 4.3), is
 * tested against that obstacle's own shape instead, so a route can leave it; when the end is inside
 * the shape itself, that obstacle is not tested for the end's lines, and the final check reports the
 * overlap.
 */
export function visibilityGraph(startIn: Vec2, endIn: Vec2, world: ClearanceWorld, options: GraphOptions): VisibilityGraph {
  const { marginIn, halfWidthIn } = options;
  const obstacles: GraphObstacle[] = [
    ...world.structures.map((structure): GraphObstacle => {
      const shapeIn = convexHull(structure.polygonIn);
      return {
        kind: "structure",
        id: structure.id,
        shapeIn,
        grownIn: grownPolygon(shapeIn, marginIn + halfWidthIn),
        centreIn: meanOf(shapeIn),
      };
    }),
    ...world.keepOuts.map((keepOut): GraphObstacle => {
      const shapeIn = convexHull(boxCorners(keepOut.boxIn));
      return {
        kind: "keepOut",
        id: keepOut.id,
        shapeIn,
        grownIn: convexHull(boxCorners(inflateBox(keepOut.boxIn, halfWidthIn))),
        centreIn: meanOf(shapeIn),
      };
    }),
  ];
  const nodesIn: Vec2[] = [{ ...startIn }, { ...endIn }];
  const owner: number[] = [-1, -1];
  for (const [k, obstacle] of obstacles.entries()) {
    for (const corner of obstacle.grownIn) {
      nodesIn.push(corner);
      owner.push(k);
    }
  }
  const inner = inflateBox(world.boundsIn, -halfWidthIn);
  const usable = nodesIn.map(
    (node, i) =>
      i < 2 ||
      (insideBox(node, inner) && obstacles.every((obstacle, k) => k === owner[i] || !strictlyInside(node, obstacle.grownIn))),
  );

  const n = nodesIn.length;
  const lengthIn = nodesIn.map((a) => nodesIn.map((b) => distance(a, b)));
  const visible = nodesIn.map(() => new Array<boolean>(n).fill(false));
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      if (usable[i] !== true || usable[j] !== true || (lengthIn[i]?.[j] as number) < MIN_CANDIDATE_LENGTH_IN) continue;
      const a = nodesIn[i] as Vec2;
      const b = nodesIn[j] as Vec2;
      // Nodes 0 and 1 are the route's ends; every other node is a corner.
      const endsOfLine = [...(i < 2 ? [a] : []), ...(j < 2 ? [b] : [])];
      const clear = obstacles.every((obstacle) => {
        let polygon = obstacle.grownIn;
        for (const end of endsOfLine) {
          if (strictlyInside(end, obstacle.shapeIn)) return true;
          if (strictlyInside(end, obstacle.grownIn)) polygon = obstacle.shapeIn;
        }
        return !crossesInside(a, b, polygon);
      });
      (visible[i] as boolean[])[j] = clear;
      (visible[j] as boolean[])[i] = clear;
    }
  }
  return { nodesIn, usable, visible, lengthIn, obstacles };
}

const routeLength = (graph: VisibilityGraph, nodes: readonly number[]): number => {
  let total = 0;
  for (let k = 0; k + 1 < nodes.length; k += 1) total += graph.lengthIn[nodes[k] as number]?.[nodes[k + 1] as number] as number;
  return total;
};

/** Shorter first; routes within float noise of each other go by node index, then by fewer nodes. */
function compareRoutes(graph: VisibilityGraph, a: readonly number[], b: readonly number[]): number {
  const difference = routeLength(graph, a) - routeLength(graph, b);
  if (Math.abs(difference) > SLACK_IN) return difference;
  for (let k = 0; k < Math.min(a.length, b.length); k += 1) {
    if (a[k] !== b[k]) return (a[k] as number) - (b[k] as number);
  }
  return a.length - b.length;
}

/**
 * Dijkstra's shortest route from one node to another, avoiding some nodes and some directed edges.
 * Ties go to the lower node index, both in which node is settled next and in which way a node is
 * reached.
 */
function shortestRoute(
  graph: VisibilityGraph,
  from: number,
  to: number,
  avoidNodes: ReadonlySet<number>,
  avoidEdges: ReadonlySet<number>,
): number[] | null {
  const n = graph.nodesIn.length;
  const reach = new Array<number>(n).fill(Infinity);
  const previous = new Array<number>(n).fill(-1);
  const settled = new Array<boolean>(n).fill(false);
  reach[from] = 0;
  for (;;) {
    let next = -1;
    for (let i = 0; i < n; i += 1) {
      if (settled[i] === true || !Number.isFinite(reach[i] as number)) continue;
      if (next === -1 || (reach[i] as number) < (reach[next] as number) - SLACK_IN) next = i;
    }
    if (next === -1) return null;
    if (next === to) break;
    settled[next] = true;
    const row = graph.visible[next] as boolean[];
    for (let v = 0; v < n; v += 1) {
      if (settled[v] === true || row[v] !== true || avoidNodes.has(v) || avoidEdges.has(next * n + v)) continue;
      const through = (reach[next] as number) + (graph.lengthIn[next]?.[v] as number);
      const current = reach[v] as number;
      if (through < current - SLACK_IN || (Math.abs(through - current) <= SLACK_IN && next < (previous[v] as number))) {
        reach[v] = through;
        previous[v] = next;
      }
    }
  }
  const nodes = [to];
  while (nodes[0] !== from) nodes.unshift(previous[nodes[0] as number] as number);
  return nodes;
}

const asRoute = (graph: VisibilityGraph, nodes: number[]): GraphRoute => ({
  nodes,
  pointsIn: nodes.map((node) => ({ ...(graph.nodesIn[node] as Vec2) })),
  lengthIn: routeLength(graph, nodes),
});

/**
 * Yen's k shortest loopless routes from S (node 0) to E (node 1), shortest first, ties by node
 * index. Fewer come back when the graph has fewer.
 */
export function kShortestRoutes(graph: VisibilityGraph, k: number): GraphRoute[] {
  const n = graph.nodesIn.length;
  const first = shortestRoute(graph, 0, 1, new Set(), new Set());
  if (first === null) return [];
  const accepted: number[][] = [first];
  const waiting: number[][] = [];
  const seen = new Set<string>([first.join(",")]);
  while (accepted.length < k) {
    const last = accepted[accepted.length - 1] as number[];
    for (let i = 0; i + 1 < last.length; i += 1) {
      const root = last.slice(0, i + 1);
      const avoidEdges = new Set<number>();
      for (const route of accepted) {
        if (route.length > i + 1 && root.every((node, m) => route[m] === node)) {
          avoidEdges.add((route[i] as number) * n + (route[i + 1] as number));
        }
      }
      const tail = shortestRoute(graph, last[i] as number, 1, new Set(root.slice(0, -1)), avoidEdges);
      if (tail === null) continue;
      const nodes = [...root.slice(0, -1), ...tail];
      const key = nodes.join(",");
      if (seen.has(key)) continue;
      seen.add(key);
      waiting.push(nodes);
    }
    if (waiting.length === 0) break;
    waiting.sort((a, b) => compareRoutes(graph, a, b));
    accepted.push(waiting.shift() as number[]);
  }
  return accepted.map((nodes) => asRoute(graph, nodes));
}

/**
 * The routes with every route that passes every obstacle on the same side as an earlier one
 * merged into that earlier one, so the alternatives go round obstacles differently. Two routes
 * pass an obstacle on the same side when, seen from it, the angles they sweep differ by less than
 * half a turn (they differ by a whole turn when they go round it differently). The routes come in
 * shortest first, so the shortest of each kind is the one kept.
 */
export function mergeSameSide(routes: readonly GraphRoute[], graph: VisibilityGraph): VisibilityRoute[] {
  const kept: { route: VisibilityRoute; angles: number[] }[] = [];
  for (const route of routes) {
    const angles = graph.obstacles.map((obstacle) => sweptAngleRad(route.pointsIn, obstacle.centreIn));
    const merged = kept.some((earlier) => angles.every((angle, k) => Math.abs(angle - (earlier.angles[k] as number)) < Math.PI));
    if (merged) continue;
    const sides = graph.obstacles.map(
      (obstacle, k): ObstacleSide => ({ kind: obstacle.kind, id: obstacle.id, side: (angles[k] as number) > 0 ? "left" : "right" }),
    );
    kept.push({ route: { ...route, sides }, angles });
  }
  return kept.map((entry) => entry.route);
}

/** The angle the canonical inch resolution can turn a handle of this length by, at most, in radians. */
const roundingTurnRad = (handleIn: number): number => (Math.SQRT2 * MIN_CANDIDATE_LENGTH_IN) / handleIn;

/**
 * The original step's geometry as a seed, or why it cannot be one: more paths than `maxPaths`, a
 * Bezier of a degree a candidate does not hold, a control point on its own end (its direction there
 * is lost), or a corner at a joint between two paths that are not both lines. A joint counts as G1
 * when its two sides differ by no more than the canonical inch resolution can turn them, and its
 * tangent is then the mean of the two.
 */
export function originalGeometry(resolved: ResolvedStep, maxPaths: number): RouteGeometry | string {
  const polygons = (resolved.segments ?? []).map((segment) => segment.pointsIn);
  if (polygons.length === 0) return "The original has no segments.";
  if (polygons.length > maxPaths) {
    return `The original has ${String(polygons.length)} paths, more than the ${String(maxPaths)} allowed.`;
  }
  const paths: CandidatePath[] = [];
  const leaving: Vec2[] = [];
  const arriving: Vec2[] = [];
  const startHandles: number[] = [];
  const endHandles: number[] = [];
  for (const [index, points] of polygons.entries()) {
    const label = `Path ${String(index + 1)}`;
    const first = points[0] as Vec2;
    const last = points[points.length - 1] as Vec2;
    const second = points[1] as Vec2;
    const beforeLast = points[points.length - 2] as Vec2;
    const startHandle = distance(first, second);
    const endHandle = distance(beforeLast, last);
    if (startHandle < MIN_CANDIDATE_LENGTH_IN || endHandle < MIN_CANDIDATE_LENGTH_IN) {
      return `${label} of the original has a control point on its own end, so its direction there is lost.`;
    }
    switch (points.length) {
      case 2:
        paths.push({ kind: "line" });
        break;
      case 3:
        paths.push({ kind: "quadratic" });
        break;
      case 4:
        paths.push({ kind: "cubic", startHandleIn: startHandle, endHandleIn: endHandle });
        break;
      case 5:
        paths.push({ kind: "quartic", startHandleIn: startHandle, endHandleIn: endHandle, middleIn: { ...(points[2] as Vec2) } });
        break;
      default:
        return `${label} of the original is a Bezier of degree ${String(points.length - 1)}, which a candidate does not hold.`;
    }
    leaving.push(normalize(sub(second, first)));
    arriving.push(normalize(sub(last, beforeLast)));
    startHandles.push(startHandle);
    endHandles.push(endHandle);
  }

  const tangentsRad = [directionRad(leaving[0] as Vec2)];
  for (let joint = 1; joint < polygons.length; joint += 1) {
    const before = arriving[joint - 1] as Vec2;
    const after = leaving[joint] as Vec2;
    const turn = Math.abs(Math.atan2(cross(before, after), dot(before, after)));
    const bothLines = paths[joint - 1]?.kind === "line" && paths[joint]?.kind === "line";
    const allowed = roundingTurnRad(endHandles[joint - 1] as number) + roundingTurnRad(startHandles[joint] as number);
    if (!bothLines && turn > allowed) {
      return `Joint ${String(joint)} is a corner between curves (${turn.toFixed(4)} rad), which a candidate cannot hold.`;
    }
    tangentsRad.push(directionRad(bothLines ? after : normalize(add(before, after))));
  }
  tangentsRad.push(directionRad(arriving[arriving.length - 1] as Vec2));
  const jointsIn = polygons.slice(1).map((points) => ({ ...(points[0] as Vec2) }));
  return { jointsIn, tangentsRad, paths };
}

const FAMILY_NAMES: Record<SeedFamily, string> = {
  original: "the original",
  straight: "the straight line",
  endTangentCubic: "the end-tangent cubic",
  visibility: "a shorter visibility route",
};

/**
 * Every geometry seed for one path step, in the fixed order G0, G1 (the line, then the cubic), G2
 * (Yen's order after the merge), with each seed `emitStep` refuses, each repeat of an earlier seed
 * and each route that does not fit `maxPaths` listed in `skipped` instead.
 */
export function geometrySeeds(input: SeedInput): GeometrySeeds {
  const { resolved, robot, field, marginIn, maxPaths } = input;
  if (!Number.isInteger(maxPaths) || maxPaths < 1) throw new Error("maxPaths must be a whole number of at least 1.");
  if (!Number.isFinite(marginIn) || marginIn < 0) throw new Error("The margin must be a finite number of inches, 0 or more.");
  const ends = routeEndsOf(resolved);
  const original = resolved.step as PathStep;
  // Seeds are geometry only; this heading is just how emitStep is asked whether it accepts one.
  const probe: CandidateHeading =
    original.heading?.mode === "facePoint" ? { mode: "facePoint" } : { mode: "ranges", ranges: [{ mode: "linear", endT: 1 }] };

  const seeds: GeometrySeed[] = [];
  const skipped: SkippedSeed[] = [];
  const keys: string[] = [];
  const offer = (family: SeedFamily, made: Omit<GeometrySeed, "family"> | string): void => {
    if (typeof made === "string") {
      skipped.push({ family, reason: made });
      return;
    }
    const key = JSON.stringify(made.geometry);
    const twin = keys.indexOf(key);
    if (twin >= 0) {
      skipped.push({ family, reason: `It is the same route as ${FAMILY_NAMES[(seeds[twin] as GeometrySeed).family]}.` });
      return;
    }
    const seed: GeometrySeed = { family, ...made };
    const emitted = emitStep(candidateFromSeed(seed, ends, probe), original);
    if (!emitted.ok) {
      skipped.push({ family, reason: emitted.reason });
      return;
    }
    seeds.push(seed);
    keys.push(key);
  };
  const smoothed = (pointsIn: readonly Vec2[]) => smoothPolyline(pointsIn, { allowanceIn: FILLET_ALLOWANCE_IN, maxPaths });

  // G0.
  const own = originalGeometry(resolved, maxPaths);
  offer("original", typeof own === "string" ? own : { geometry: own });

  // G1.
  const straight = smoothed([ends.startIn, ends.endIn]);
  offer("straight", straight.ok ? { geometry: straight.chain.geometry } : straight.reason);
  const chordIn = distance(ends.startIn, ends.endIn);
  const handleIn = chordIn * END_TANGENT_HANDLE_FRACTION;
  offer(
    "endTangentCubic",
    chordIn < MIN_CANDIDATE_LENGTH_IN
      ? "The route's start and end are the same point."
      : {
          geometry: {
            jointsIn: [],
            tangentsRad: [ends.arrivalHeadingRad, ends.endHeadingRad],
            paths: [{ kind: "cubic", startHandleIn: handleIn, endHandleIn: handleIn }],
          },
        },
  );

  // G2. Round a blocked original, a route whose chain does not fit `maxPaths` at the fillet
  // allowance is smoothed again at each fallback allowance in turn, and listed in `skipped` only
  // when none fits.
  const fallbacks = input.fallbackAllowances === true ? FILLET_FALLBACK_ALLOWANCES_IN : [];
  const graph = visibilityGraph(ends.startIn, ends.endIn, input.world ?? clearanceWorld(robot, field), {
    marginIn,
    halfWidthIn: footprintHalfWidthIn(robot),
  });
  for (const route of mergeSameSide(kShortestRoutes(graph, YEN_ROUTE_COUNT), graph)) {
    let chain = smoothed(route.pointsIn);
    let allowanceIn = FILLET_ALLOWANCE_IN;
    // The sentence a skip gives is the one at the fillet allowance, which the spec names.
    const firstReason = chain.ok ? null : chain.reason;
    for (const fallbackIn of fallbacks) {
      if (chain.ok) break;
      allowanceIn = fallbackIn;
      chain = smoothPolyline(route.pointsIn, { allowanceIn, maxPaths });
    }
    offer(
      "visibility",
      chain.ok
        ? { geometry: chain.chain.geometry, route, pieces: chain.chain.pieces, ...(allowanceIn === FILLET_ALLOWANCE_IN ? {} : { allowanceIn }) }
        : (firstReason ?? chain.reason),
    );
  }
  return { ends, seeds, skipped };
}
