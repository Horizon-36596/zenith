import { splitControlPolygon } from "../fix.js";
import { add, cross, distance, dot, normalize, scale, sub, type Vec2 } from "../geometry/vec.js";
import { MIN_CANDIDATE_LENGTH_IN, type RouteCandidate } from "./candidate.js";

/**
 * Fillet smoothing: how the optimizer turns a visibility route, a polyline from S through grown
 * obstacle corners to E, into a chain of paths a candidate can hold (the G2 seeds of `seeds.ts`).
 *
 * - Straight stretches are lines.
 * - Each corner is filleted with a quadratic Bezier whose control point is the corner and whose
 *   ends lie on the two legs, so the chain leaves a line along it and its joints are G1.
 * - Each fillet is as large as it can be while it stays within the allowance of the polyline and
 *   while it shares each leg with the fillet at the leg's other end.
 * - Touching fillets, which consume the whole leg between them, merge into one cubic when that
 *   cubic stays within the allowance; otherwise they stay two quadratics meeting on the leg.
 * - A chain with more paths than `maxPaths` merges a fillet, the line after it and the next fillet
 *   into one cubic, the merge that strays least first, while a merge stays within the allowance.
 *   A chain that still has too many paths is refused with a sentence, never cut short.
 *
 * Every piece carries a closed-form bound on how far it strays from the polyline, so "within the
 * allowance" is proved, not sampled:
 *
 * - A piece whose control polygon is a stretch of the polyline (every line and every fillet) is
 *   bounded by the sharp bound of Nairn, Peters and Lutterkort (1999) on the distance between a
 *   Bezier of degree n and its control polygon: floor(n/2) * ceil(n/2) / (2n) times the largest
 *   second difference of its control points, which is |A - 2P + B| / 4 for a fillet A, P, B.
 * - A merged cubic is bounded against the polyline by its convex hull, refined by de Casteljau
 *   halving until the bound is sharp to the canonical inch resolution (`hullDeviationBoundIn`).
 *
 * Everything is in a fixed order, with no randomness. Pure (CLAUDE.md rule 1).
 */

/**
 * How far a fillet may stray from the polyline it smooths, in inches (SET BY HAND: spec 16 section
 * 6.2, search-only). It shapes the seeds and nothing else: the margin is enforced by the penalties
 * and the hard final check, not by this.
 */
export const FILLET_ALLOWANCE_IN = 1.5;

/**
 * Arithmetic slack for two directions being parallel, as the sine of the angle between them. It is
 * not a tolerance on the route: a corner this straight is no corner.
 */
const COLLINEAR_EPSILON = 1e-12;

/** A candidate's geometry: everything but its ends and its heading. */
export type RouteGeometry = Pick<RouteCandidate, "jointsIn" | "tangentsRad" | "paths">;

/** The kind of one piece of a smoothed chain. */
export type ChainPieceKind = "line" | "quadratic" | "cubic";

/** One path of a smoothed chain, as a control polygon. */
export interface ChainPiece {
  kind: ChainPieceKind;
  /** The control polygon: the start, any control points, the end. */
  pointsIn: Vec2[];
  /** A closed-form bound on how far the piece strays from the polyline it smooths, in inches. */
  deviationBoundIn: number;
}

/** A polyline smoothed into a chain. */
export interface SmoothedChain {
  /** The polyline the chain smooths, with repeated points and straight-through corners removed. */
  polylineIn: Vec2[];
  pieces: ChainPiece[];
  /** The chain as a candidate's geometry, for `emitStep`. */
  geometry: RouteGeometry;
}

export type SmoothResult = { ok: true; chain: SmoothedChain } | { ok: false; reason: string };

export interface SmoothOptions {
  /** How far a piece may stray from the polyline, in inches. `FILLET_ALLOWANCE_IN` for the seeds. */
  allowanceIn: number;
  /** The most paths the chain may have. */
  maxPaths: number;
}

/** The direction of a vector as an angle, in radians. */
export const directionRad = (vector: Vec2): number => Math.atan2(vector.yIn, vector.xIn);

/**
 * The sharp bound of Nairn, Peters and Lutterkort on how far a Bezier strays from its own control
 * polygon (each point is compared with the polygon's point at the same parameter, the polygon's
 * corners spaced evenly in it): floor(n/2) * ceil(n/2) / (2n) times the largest second difference
 * of the control points. A line's bound is 0.
 */
export function controlPolygonBoundIn(pointsIn: readonly Vec2[]): number {
  const n = pointsIn.length - 1;
  if (n < 2) return 0;
  let largest = 0;
  for (let i = 0; i + 2 <= n; i += 1) {
    const a = pointsIn[i] as Vec2;
    const b = pointsIn[i + 1] as Vec2;
    const c = pointsIn[i + 2] as Vec2;
    largest = Math.max(largest, Math.hypot(a.xIn - 2 * b.xIn + c.xIn, a.yIn - 2 * b.yIn + c.yIn));
  }
  return ((Math.floor(n / 2) * Math.ceil(n / 2)) / (2 * n)) * largest;
}

/** A line, quadratic or cubic control polygon raised to a cubic's, which draws the same curve. */
function asCubic(pointsIn: readonly Vec2[]): Vec2[] {
  const [first, ...rest] = pointsIn;
  const last = pointsIn[pointsIn.length - 1] as Vec2;
  if (first === undefined || rest.length === 0) throw new Error("A piece needs two points.");
  if (pointsIn.length === 2) {
    const step = scale(sub(last, first), 1 / 3);
    return [first, add(first, step), add(first, scale(step, 2)), last];
  }
  if (pointsIn.length === 3) {
    const control = pointsIn[1] as Vec2;
    return [first, add(first, scale(sub(control, first), 2 / 3)), add(last, scale(sub(control, last), 2 / 3)), last];
  }
  return pointsIn.map((point) => ({ ...point }));
}

const isCurve = (piece: ChainPiece): boolean => piece.kind !== "line";

/** The distance from a point to a segment. */
function segmentDistanceIn(point: Vec2, from: Vec2, to: Vec2): number {
  const along = sub(to, from);
  const lengthSquared = dot(along, along);
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, dot(sub(point, from), along) / lengthSquared));
  return distance(point, add(from, scale(along, t)));
}

/** The distance from a point to a polyline. */
export function polylineDistanceIn(point: Vec2, polylineIn: readonly Vec2[]): number {
  let nearest = Infinity;
  for (let i = 0; i + 1 < polylineIn.length; i += 1) {
    nearest = Math.min(nearest, segmentDistanceIn(point, polylineIn[i] as Vec2, polylineIn[i + 1] as Vec2));
  }
  return nearest;
}

/**
 * A bound on how far a Bezier strays from a polyline, in inches, sharp to the canonical inch
 * resolution.
 *
 * A Bezier lies inside the convex hull of its control points, and the distance to one segment is a
 * convex function, so no point of the curve is further from the polyline than the largest distance
 * from a control point to whichever single segment makes that largest distance smallest. Where that
 * is more than `MIN_CANDIDATE_LENGTH_IN` above the distance of the curve's own two ends (which lie
 * on the curve), the curve is split in half by de Casteljau (`fix.ts` `splitControlPolygon`) and
 * each half is bounded the same way, until its control polygon is shorter than that resolution.
 * The result is never below the true distance, and is about that resolution above it at most.
 */
export function hullDeviationBoundIn(pointsIn: readonly Vec2[], polylineIn: readonly Vec2[]): number {
  let bound = Infinity;
  for (let i = 0; i + 1 < polylineIn.length; i += 1) {
    const from = polylineIn[i] as Vec2;
    const to = polylineIn[i + 1] as Vec2;
    let furthest = 0;
    for (const point of pointsIn) furthest = Math.max(furthest, segmentDistanceIn(point, from, to));
    bound = Math.min(bound, furthest);
  }
  const ends = Math.max(
    polylineDistanceIn(pointsIn[0] as Vec2, polylineIn),
    polylineDistanceIn(pointsIn[pointsIn.length - 1] as Vec2, polylineIn),
  );
  let polygonIn = 0;
  for (let i = 0; i + 1 < pointsIn.length; i += 1) polygonIn += distance(pointsIn[i] as Vec2, pointsIn[i + 1] as Vec2);
  if (bound - ends <= MIN_CANDIDATE_LENGTH_IN || polygonIn < MIN_CANDIDATE_LENGTH_IN) return bound;
  const { left, right } = splitControlPolygon(pointsIn, 0.5);
  return Math.max(hullDeviationBoundIn(left, polylineIn), hullDeviationBoundIn(right, polylineIn));
}

/**
 * One cubic in place of a run of pieces, from the first's start to the last's end, leaving and
 * arriving along the run's own end tangents so the chain stays G1, with its bound against the
 * polyline (`hullDeviationBoundIn`).
 *
 * The cubic's parameter is shared out among the pieces in proportion to their chords, and its two
 * handles are set so that, split where the pieces meet, its first part leaves exactly as the first
 * piece does and its last part arrives exactly as the last piece does.
 */
function mergedCubic(run: readonly ChainPiece[], polylineIn: readonly Vec2[]): ChainPiece {
  const first = run[0] as ChainPiece;
  const last = run[run.length - 1] as ChainPiece;
  const start = first.pointsIn[0] as Vec2;
  const end = last.pointsIn[last.pointsIn.length - 1] as Vec2;
  const chords = run.map((piece) => distance(piece.pointsIn[0] as Vec2, piece.pointsIn[piece.pointsIn.length - 1] as Vec2));
  const total = chords.reduce((sum, chord) => sum + chord, 0);
  const firstSpan = (chords[0] as number) / total;
  const lastSpan = (chords[chords.length - 1] as number) / total;
  const leaves = asCubic(first.pointsIn)[1] as Vec2;
  const arrives = asCubic(last.pointsIn)[2] as Vec2;
  const pointsIn = [
    start,
    add(start, scale(sub(leaves, start), 1 / firstSpan)),
    sub(end, scale(sub(end, arrives), 1 / lastSpan)),
    end,
  ];
  return { kind: "cubic", pointsIn, deviationBoundIn: hullDeviationBoundIn(pointsIn, polylineIn) };
}

/** The polyline with repeated points and straight-through corners removed, or a reason it has no route. */
function cleanPolyline(polylineIn: readonly Vec2[]): Vec2[] | string {
  const start = polylineIn[0];
  const end = polylineIn[polylineIn.length - 1];
  if (start === undefined || end === undefined || polylineIn.length < 2) return "A route needs a start and an end.";
  const kept: Vec2[] = [start];
  for (const point of polylineIn.slice(1, -1)) {
    if (distance(kept[kept.length - 1] as Vec2, point) >= MIN_CANDIDATE_LENGTH_IN) kept.push(point);
  }
  if (kept.length > 1 && distance(kept[kept.length - 1] as Vec2, end) < MIN_CANDIDATE_LENGTH_IN) kept.pop();
  kept.push(end);
  if (kept.length === 2 && distance(start, end) < MIN_CANDIDATE_LENGTH_IN) return "The route's start and end are the same point.";

  let i = 1;
  while (i < kept.length - 1) {
    const incoming = normalize(sub(kept[i] as Vec2, kept[i - 1] as Vec2));
    const outgoing = normalize(sub(kept[i + 1] as Vec2, kept[i] as Vec2));
    if (Math.abs(cross(incoming, outgoing)) <= COLLINEAR_EPSILON) {
      if (dot(incoming, outgoing) < 0) return `The route turns back on itself at corner ${String(i)}.`;
      kept.splice(i, 1);
    } else {
      i += 1;
    }
  }
  return kept;
}

/** The chain as a candidate's geometry: joints where pieces meet, one tangent per node, and each piece's kind. */
function chainGeometry(pieces: readonly ChainPiece[]): RouteGeometry {
  const jointsIn = pieces.slice(1).map((piece) => ({ ...(piece.pointsIn[0] as Vec2) }));
  const tangentsRad = pieces.map((piece) => directionRad(sub(piece.pointsIn[1] as Vec2, piece.pointsIn[0] as Vec2)));
  const last = (pieces[pieces.length - 1] as ChainPiece).pointsIn;
  tangentsRad.push(directionRad(sub(last[last.length - 1] as Vec2, last[last.length - 2] as Vec2)));
  const paths = pieces.map((piece): RouteGeometry["paths"][number] => {
    if (piece.kind === "line") return { kind: "line" };
    if (piece.kind === "quadratic") return { kind: "quadratic" };
    const [a, b, c, d] = piece.pointsIn as [Vec2, Vec2, Vec2, Vec2];
    return { kind: "cubic", startHandleIn: distance(a, b), endHandleIn: distance(c, d) };
  });
  return { jointsIn, tangentsRad, paths };
}

/**
 * Smooths a polyline into a G1 chain of lines, quadratic fillets and, where fillets touch or the
 * path count asks for it, cubics, every piece within `allowanceIn` of the polyline. See the file
 * comment for the rules. Refuses, with a sentence, a polyline that turns back on itself, a corner
 * too close to the next to fillet, or a chain that cannot fit `maxPaths` within the allowance.
 */
export function smoothPolyline(polylineIn: readonly Vec2[], options: SmoothOptions): SmoothResult {
  const { allowanceIn, maxPaths } = options;
  if (!Number.isInteger(maxPaths) || maxPaths < 1) throw new Error("maxPaths must be a whole number of at least 1.");
  // A fillet sized to the allowance may be stretched on each side by less than the canonical inch
  // resolution to meet its neighbour or an end, which adds at most a quarter of that per side to its
  // bound; that much is held back here.
  const sizingIn = allowanceIn - MIN_CANDIDATE_LENGTH_IN / 2;
  if (!(sizingIn > 0)) throw new Error("The fillet allowance must be more than half the canonical inch resolution.");

  const cleaned = cleanPolyline(polylineIn);
  if (typeof cleaned === "string") return { ok: false, reason: cleaned };
  const points = cleaned;
  const legs = points.length - 1;
  const legLength = (j: number): number => distance(points[j] as Vec2, points[j + 1] as Vec2);
  const legDirection = (j: number): Vec2 => normalize(sub(points[j + 1] as Vec2, points[j] as Vec2));

  // Corner i (1 to legs - 1) sits between leg i - 1 and leg i. A symmetric fillet of size d there has
  // second difference d * |v - u| = 2 d sin(phi / 2) for a turn phi, so its bound is d sin(phi / 2) / 2.
  const wanted = new Array<number>(points.length).fill(0);
  for (let i = 1; i < legs; i += 1) {
    const sinHalf = distance(legDirection(i), legDirection(i - 1)) / 2;
    wanted[i] = (2 * sizingIn) / sinHalf;
  }
  /** How much of leg j the fillet at corner i (one of its ends) may take. */
  const share = (j: number, i: number): number => {
    const length = legLength(j);
    const other = i === j ? j + 1 : j;
    if (other < 1 || other >= legs) return length;
    const mine = Math.min(wanted[i] as number, length);
    const theirs = Math.min(wanted[other] as number, length);
    return mine + theirs > length ? (length * mine) / (mine + theirs) : mine;
  };
  const size = new Array<number>(points.length).fill(0);
  for (let i = 1; i < legs; i += 1) {
    size[i] = Math.min(wanted[i] as number, share(i - 1, i), share(i, i));
    if ((size[i] as number) < MIN_CANDIDATE_LENGTH_IN) {
      return { ok: false, reason: `Corner ${String(i)} of the route is too close to the next one to be filleted.` };
    }
  }

  // Where each fillet starts and ends; a leg with less than the canonical resolution left between
  // two fillets (or a fillet and an end) is consumed, and the later one starts where the earlier ends.
  const filletStart: Vec2[] = [];
  const filletEnd: Vec2[] = [];
  for (let i = 1; i < legs; i += 1) {
    filletStart[i] = sub(points[i] as Vec2, scale(legDirection(i - 1), size[i] as number));
    filletEnd[i] = add(points[i] as Vec2, scale(legDirection(i), size[i] as number));
  }
  const pieces: ChainPiece[] = [];
  for (let j = 0; j < legs; j += 1) {
    const from = j === 0 ? (points[0] as Vec2) : (filletEnd[j] as Vec2);
    const isLast = j === legs - 1;
    const left = legLength(j) - (j === 0 ? 0 : (size[j] as number)) - (isLast ? 0 : (size[j + 1] as number));
    if (left >= MIN_CANDIDATE_LENGTH_IN) {
      pieces.push({ kind: "line", pointsIn: [from, isLast ? (points[legs] as Vec2) : (filletStart[j + 1] as Vec2)], deviationBoundIn: 0 });
    } else if (isLast) {
      // The last fillet runs to E.
      const previous = pieces[pieces.length - 1];
      if (previous !== undefined) {
        previous.pointsIn[previous.pointsIn.length - 1] = points[legs] as Vec2;
        previous.deviationBoundIn = controlPolygonBoundIn(previous.pointsIn);
      }
    } else {
      filletStart[j + 1] = from;
    }
    if (!isLast) {
      const fillet = [filletStart[j + 1] as Vec2, points[j + 1] as Vec2, filletEnd[j + 1] as Vec2];
      pieces.push({ kind: "quadratic", pointsIn: fillet, deviationBoundIn: controlPolygonBoundIn(fillet) });
    }
  }

  // Touching fillets merge into one cubic when it stays within the allowance (spec 16 section 6.2).
  let k = 0;
  while (k + 1 < pieces.length) {
    if (isCurve(pieces[k] as ChainPiece) && isCurve(pieces[k + 1] as ChainPiece)) {
      const merged = mergedCubic(pieces.slice(k, k + 2), points);
      if (merged.deviationBoundIn <= allowanceIn) {
        pieces.splice(k, 2, merged);
        continue;
      }
    }
    k += 1;
  }

  // Too many paths: merge the run that strays least, while one stays within the allowance.
  while (pieces.length > maxPaths) {
    let best: { at: number; count: number; piece: ChainPiece } | null = null;
    for (let at = 0; at + 1 < pieces.length; at += 1) {
      if (!isCurve(pieces[at] as ChainPiece)) continue;
      for (const count of [2, 3]) {
        const run = pieces.slice(at, at + count);
        if (run.length !== count || !isCurve(run[count - 1] as ChainPiece)) continue;
        if (count === 3 && isCurve(run[1] as ChainPiece)) continue;
        const merged = mergedCubic(run, points);
        if (merged.deviationBoundIn > allowanceIn) continue;
        if (best === null || merged.deviationBoundIn < best.piece.deviationBoundIn) best = { at, count, piece: merged };
      }
    }
    if (best === null) {
      return {
        ok: false,
        reason: `The route needs ${String(pieces.length)} paths to stay within ${String(allowanceIn)} in of its corners, more than the ${String(maxPaths)} allowed.`,
      };
    }
    pieces.splice(best.at, best.count, best.piece);
  }

  return { ok: true, chain: { polylineIn: points, pieces, geometry: chainGeometry(pieces) } };
}
