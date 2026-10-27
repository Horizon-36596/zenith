import type { Heading, HeadingRange, PathStep } from "@horizon36596/zenith-schema";
import { splitControlPolygon } from "../fix.js";
import type { Curve } from "../geometry/curve.js";
import type { PathGeometry } from "../geometry/path.js";
import { distance, normalize, sub, type Vec2 } from "../geometry/vec.js";
import { headingFunction } from "../heading.js";
import { deleteRange, MIN_RANGE_T, roundRangeT, splitRange, toPiecewise } from "../headingRanges.js";
import { makeSimCurve, type SimCurve } from "../sim/curves.js";
import { parameterAtFraction, runtimeSegmentFractions } from "../sim/pedroPath.js";
import { candidateNodes, MIN_CANDIDATE_LENGTH_IN, type CandidatePath, type CandidateRange, type RouteCandidate } from "./candidate.js";
import { END_TANGENT_HANDLE_FRACTION } from "./seeds.js";
import { directionRad } from "./smooth.js";
import type { OptimizeMode } from "./types.js";

/**
 * The search's structural moves (issue #307). When a continuous pass stalls, the search tries these on
 * the candidate it stalled at, in this fixed order, and keeps one only when the continuous pass that
 * follows it ends strictly lower in J:
 *
 * 1. **Split a path** at its arc-length midpoint by de Casteljau (`fix.ts` `splitControlPolygon`).
 *    The halves draw exactly the curve the path drew, and the new joint's tangent is the curve's
 *    own there. A linear heading range that crosses the new joint is split on it at the heading the
 *    robot had there (D3), so the robot turns as it did: the runtime turns a linear range linearly
 *    in each segment's own parametric t (OPT-01), and de Casteljau keeps that parameter affine on
 *    each half.
 * 2. **Merge two adjacent paths** into one cubic. The cubic keeps the outer nodes and their
 *    directions, and its two handle lengths are fitted by least squares to the two paths at fixed
 *    fractions of their length (`MERGE_FIT_FRACTIONS`).
 * 3. **Change a path's degree**, one step down and then one step up the ladder line, quadratic,
 *    cubic, quartic. A step up is an exact degree elevation, so it changes nothing until the pass
 *    moves it, and a quartic is therefore kept only when it ends strictly faster than the cubic it
 *    came from (ADR 0001). A quartic steps down to the least-squares cubic, a cubic to the quadratic
 *    its two tangents meet in, and a quadratic to a line.
 * 4. **Split a heading range** in two at its middle, at the heading the robot already has there
 *    (`headingRanges.splitRange`, D3). Only a linear range is split: the two halves of a tangent,
 *    reversed or constant range hold exactly what the whole did, and the pass has nothing new to
 *    move on them.
 * 5. **Merge two adjacent ranges** (`headingRanges.deleteRange`): the first grows over the second.
 * 6. **Change a range's mode** to each other mode, in the order tangent, tangentReversed, constant,
 *    linear.
 *
 * "Knots re-pinned": wherever a move leaves a linear range ending into a linear or constant one, its
 * free end heading is pinned to the heading the robot had at that range's end before the move, so
 * the ranges after the one the move changed start where they did.
 *
 * A knot at a range end, split or re-pinned, is read where the runtime puts that end: through each
 * segment's chord table, not at the exact arc-length fraction, which on a curve is a little away.
 *
 * A move only builds a candidate. `emitStep`, or the heading-only emitter, still refuses one that
 * breaks a rule, such as a mode change that tears the heading at a boundary, and the search then
 * skips it without scoring it. No move gives a route more paths than `maxPaths`, a new heading range
 * when ranges are not allowed, a new heading in `routeOnly`, a new route in `headingOnly`, or a
 * heading of its own to a facePoint step, which keeps facePoint.
 *
 * Pure (CLAUDE.md rule 1).
 */

export type StructuralMoveKind = "splitPath" | "mergePaths" | "changeDegree" | "splitRange" | "mergeRanges" | "changeRangeMode";

/** The moves, in the order spec 16 section 6.3 tries them. */
export const STRUCTURAL_MOVE_ORDER: readonly StructuralMoveKind[] = [
  "splitPath",
  "mergePaths",
  "changeDegree",
  "splitRange",
  "mergeRanges",
  "changeRangeMode",
];

/**
 * The fractions of the merged stretch's length that the merged cubic is fitted at: eight, evenly
 * spaced strictly inside it (SET BY HAND: twice the cubic's four control points, so the two free
 * handle lengths are well over-determined, and few enough to cost nothing beside a plan).
 */
export const MERGE_FIT_FRACTIONS: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8].map((k) => k / 9);

/** The path kinds by degree: the ladder "change a path's degree" steps along. */
const DEGREE_LADDER: readonly CandidatePath["kind"][] = ["line", "quadratic", "cubic", "quartic"];

/** The range modes a range may change to, in the order they are tried. */
const RANGE_MODES: readonly CandidateRange["mode"][] = ["tangent", "tangentReversed", "constant", "linear"];

/** One structural move: what it is, where, and the candidate it builds. */
export interface StructuralMove {
  kind: StructuralMoveKind;
  /** The path (moves 1 to 3) or the range (moves 4 to 6) it acts on, from 0; for a merge, the first of the two. */
  index: number;
  /** The new path kind or range mode, for a change of degree or mode; null otherwise. */
  to: string | null;
  candidate: RouteCandidate;
}

/** The candidate a pass stalled at, as it was scored. */
export interface MoveBase {
  candidate: RouteCandidate;
  /** Its emitted step, in canonical form: the bytes that were scored. */
  step: PathStep;
  /** The geometry `step` drives: its own, or the original's in `headingOnly`, which keeps the segments. */
  geometry: PathGeometry;
}

export interface MoveOptions {
  mode: OptimizeMode;
  maxPaths: number;
  allowRanges: boolean;
}

type Piecewise = Extract<Heading, { mode: "piecewise" }>;

const replaceAt = <T>(items: readonly T[], index: number, item: T): T[] => items.map((old, k) => (k === index ? item : old));

/**
 * A file heading as a candidate's ranges: each mode kept, and each linear range's end heading as its
 * free knot. Null for a heading the optimizer does not write (`facePoint`).
 */
export function candidateRangesOf(heading: Heading): CandidateRange[] | null {
  const out: CandidateRange[] = [];
  for (const range of toPiecewise(heading).ranges) {
    const inner = range.heading;
    if (inner.mode === "facePoint") return null;
    out.push(inner.mode === "linear" ? { mode: "linear", endT: range.endT, endHeadingRad: inner.toRad } : { mode: inner.mode, endT: range.endT });
  }
  if (out.length > 0) (out[out.length - 1] as CandidateRange).endT = 1;
  return out;
}

/** The candidate's own ranges, or the ones its kept heading is written as; null for facePoint. */
function rangesOf(base: MoveBase): CandidateRange[] | null {
  if (base.candidate.heading.mode === "facePoint") return null;
  if (base.candidate.heading.mode === "ranges") return [...base.candidate.heading.ranges];
  return base.step.heading === undefined ? null : candidateRangesOf(base.step.heading);
}

/** The heading the robot has at arc-length fraction t on the base route, as the plan and the sim read it. */
function robotHeadingAt(base: MoveBase, t: number): number {
  return headingFunction(base.step.heading as Heading, base.geometry)(t);
}

/**
 * The arc-length fraction of the point where the runtime puts a heading range's end at range t. The
 * runtime turns a range's t into a segment's own t through that segment's chord table
 * (`parameterAtFraction`, 64 chords), which on a curve lands a little away from the point at that
 * exact arc-length fraction.
 */
function runtimeBoundaryT(geometry: PathGeometry, t: number): number {
  if (geometry.lengthIn === 0 || t <= 0 || t >= 1) return t;
  const curves = geometry.curves.map((curve) => makeSimCurve(curve.points.map((point) => ({ x: point.xIn, y: point.yIn }))));
  const fractions = runtimeSegmentFractions(curves);
  const found = fractions.findIndex((share) => t <= share.endFraction);
  const index = found < 0 ? fractions.length - 1 : found;
  const share = fractions[index] as { startFraction: number; endFraction: number };
  const span = share.endFraction - share.startFraction;
  const u = span <= 0 ? 0 : parameterAtFraction(curves[index] as SimCurve, (t - share.startFraction) / span);
  const alongIn = (geometry.breaks[index] as number) + (geometry.curves[index] as Curve).lengthAt(u);
  return Math.min(1, Math.max(0, alongIn / geometry.lengthIn));
}

/** The heading the robot has at the point where the runtime puts a range end at range t (D3). */
const robotHeadingAtBoundary = (base: MoveBase, t: number): number => robotHeadingAt(base, runtimeBoundaryT(base.geometry, t));

/**
 * Re-pins the ranges at `indices` that are linear and end into a linear or constant range to the
 * heading the robot had at their end on the base route, so the ranges after them start where they
 * did. The other ranges keep their knots.
 */
function repinned(ranges: readonly CandidateRange[], base: MoveBase, indices: readonly number[]): CandidateRange[] {
  return ranges.map((range, r) => {
    const next = ranges[r + 1];
    if (!indices.includes(r) || range.mode !== "linear" || next === undefined || (next.mode !== "linear" && next.mode !== "constant")) {
      return range;
    }
    return { ...range, endHeadingRad: robotHeadingAtBoundary(base, range.endT) };
  });
}

const withRanges = (candidate: RouteCandidate, ranges: readonly CandidateRange[]): RouteCandidate => ({
  ...candidate,
  heading: { mode: "ranges", ranges },
});

/** The candidate's ranges in the file's form, with placeholder angles: `splitRange` reads only the boundaries and modes. */
function fileRanges(ranges: readonly CandidateRange[]): Piecewise {
  let startT = 0;
  return {
    mode: "piecewise",
    ranges: ranges.map((range): HeadingRange => {
      const written: HeadingRange = {
        startT,
        endT: range.endT,
        heading:
          range.mode === "linear"
            ? { mode: "linear", fromRad: 0, toRad: 0 }
            : range.mode === "constant"
              ? { mode: "constant", headingRad: 0 }
              : { mode: range.mode },
      };
      startT = range.endT;
      return written;
    }),
  };
}

/**
 * Splits the linear range that holds `t` strictly inside it at `t`, as `splitRange` cuts it, with the
 * knot there pinned to `knotRad`. Null when no linear range holds t, or when a half would be narrower
 * than `MIN_RANGE_T`.
 */
function splitLinearRangeAt(ranges: readonly CandidateRange[], t: number, knotRad: number): CandidateRange[] | null {
  const file = fileRanges(ranges);
  const at = roundRangeT(t);
  const index = file.ranges.findIndex((range) => at > range.startT && at < range.endT);
  if (index < 0 || (ranges[index] as CandidateRange).mode !== "linear") return null;
  if (splitRange(file, at) === file) return null;
  const range = ranges[index] as Extract<CandidateRange, { mode: "linear" }>;
  return [...ranges.slice(0, index), { mode: "linear", endT: at, endHeadingRad: knotRad }, range, ...ranges.slice(index + 1)];
}

/** The candidate's tangents, with every one a line pins written as that line's own direction, so a move that turns the line into a curve keeps it. */
function settledTangents(candidate: RouteCandidate, directions: readonly Vec2[]): number[] {
  return candidate.tangentsRad.map((rad, node) => {
    const incoming = node > 0 ? candidate.paths[node - 1] : undefined;
    const outgoing = candidate.paths[node];
    return incoming?.kind === "line" || outgoing?.kind === "line" ? directionRad(directions[node] as Vec2) : rad;
  });
}

/** The two halves of a path, as candidate paths, from the control polygons de Casteljau gives them. */
function halvesOf(path: CandidatePath, left: readonly Vec2[], right: readonly Vec2[]): [CandidatePath, CandidatePath] {
  const handles = (points: readonly Vec2[]): { startHandleIn: number; endHandleIn: number } => ({
    startHandleIn: distance(points[0] as Vec2, points[1] as Vec2),
    endHandleIn: distance(points[points.length - 2] as Vec2, points[points.length - 1] as Vec2),
  });
  switch (path.kind) {
    case "line":
    case "quadratic":
      return [{ kind: path.kind }, { kind: path.kind }];
    case "cubic":
      return [
        { kind: "cubic", ...handles(left) },
        { kind: "cubic", ...handles(right) },
      ];
    case "quartic":
      return [
        { kind: "quartic", ...handles(left), middleIn: { ...(left[2] as Vec2) } },
        { kind: "quartic", ...handles(right), middleIn: { ...(right[2] as Vec2) } },
      ];
  }
}

/**
 * Move 1: splits path `k` at its arc-length midpoint (de Casteljau). The new joint carries the
 * curve's own tangent there, and when ranges are allowed, a linear range that crosses it is split on
 * it at the heading the robot had there (D3). Null when the route already has `maxPaths` paths.
 */
export function splitPath(base: MoveBase, k: number, options: MoveOptions): RouteCandidate | null {
  const { candidate, geometry } = base;
  const path = candidate.paths[k];
  const curve = geometry.curves[k];
  if (path === undefined || curve === undefined || candidate.paths.length >= options.maxPaths) return null;
  const nodes = candidateNodes(candidate);
  if (typeof nodes === "string") return null;
  const u = curve.uAtLength(curve.lengthIn / 2);
  const { left, right } = splitControlPolygon(curve.points, u);
  const joint = left[left.length - 1] as Vec2;
  const jointTangent = path.kind === "line" ? sub(nodes.nodesIn[k + 1] as Vec2, nodes.nodesIn[k] as Vec2) : curve.derivativeAt(u);
  const tangents = settledTangents(candidate, nodes.directions);
  const split: RouteCandidate = {
    ...candidate,
    jointsIn: [...candidate.jointsIn.slice(0, k), { ...joint }, ...candidate.jointsIn.slice(k)],
    tangentsRad: [...tangents.slice(0, k + 1), directionRad(normalize(jointTangent)), ...tangents.slice(k + 1)],
    paths: [...candidate.paths.slice(0, k), ...halvesOf(path, left, right), ...candidate.paths.slice(k + 1)],
  };

  // D3: the heading at the new joint is the heading the robot had there.
  const ranges = rangesOf(base);
  if (ranges === null || options.mode === "routeOnly" || !options.allowRanges) return split;
  const alongIn = (geometry.breaks[k] as number) + curve.lengthIn / 2;
  const knotRad = robotHeadingAt(base, geometry.lengthIn === 0 ? 0 : alongIn / geometry.lengthIn);
  // The runtime turns a range's t into a segment's t by its own segment lengths, so the boundary
  // goes where the runtime puts the new joint.
  const polygons = geometry.curves.flatMap((old, index) => (index === k ? [left, right] : [old.points]));
  const fractions = runtimeSegmentFractions(polygons.map((points) => makeSimCurve(points.map((point) => ({ x: point.xIn, y: point.yIn })))));
  const jointT = (fractions[k] as { endFraction: number }).endFraction;
  const pinned = splitLinearRangeAt(ranges, jointT, knotRad);
  return pinned === null ? split : withRanges(split, pinned);
}

/**
 * The handle lengths of the cubic from `p0`, leaving along `d0`, to `p3`, arriving along `d1`, that
 * best fits `targets` (points at the curve parameters `params`) by least squares. A handle the fit
 * makes shorter than a candidate allows, or not finite, falls back to the chord over three, where
 * the seeds' end-tangent cubic starts.
 */
export function fitCubicHandles(
  p0: Vec2,
  p3: Vec2,
  d0: Vec2,
  d1: Vec2,
  params: readonly number[],
  targets: readonly Vec2[],
): { startHandleIn: number; endHandleIn: number } {
  // B(s) = (r^3 + 3 r^2 s) p0 + (3 r s^2 + s^3) p3 + a 3 r^2 s d0 - b 3 r s^2 d1, with r = 1 - s,
  // which is linear in the two handle lengths a and b.
  let suu = 0;
  let svv = 0;
  let suv = 0;
  let su = 0;
  let sv = 0;
  const along = d0.xIn * d1.xIn + d0.yIn * d1.yIn;
  for (const [i, s] of params.entries()) {
    const q = targets[i] as Vec2;
    const r = 1 - s;
    const wa = r * r * r + 3 * r * r * s;
    const wb = 3 * r * s * s + s * s * s;
    const residual = { xIn: q.xIn - (wa * p0.xIn + wb * p3.xIn), yIn: q.yIn - (wa * p0.yIn + wb * p3.yIn) };
    const us = 3 * r * r * s;
    const vs = 3 * r * s * s;
    suu += us * us;
    svv += vs * vs;
    suv += us * vs * along;
    su += us * (d0.xIn * residual.xIn + d0.yIn * residual.yIn);
    sv += vs * (d1.xIn * residual.xIn + d1.yIn * residual.yIn);
  }
  // The normal equations: [suu, -suv; -suv, svv] [a; b] = [su; -sv].
  const det = suu * svv - suv * suv;
  const fallback = distance(p0, p3) * END_TANGENT_HANDLE_FRACTION;
  let a = det === 0 ? Number.NaN : (su * svv - suv * sv) / det;
  let b = det === 0 ? Number.NaN : (suv * su - suu * sv) / det;
  if (!Number.isFinite(a) || a < MIN_CANDIDATE_LENGTH_IN) a = fallback;
  if (!Number.isFinite(b) || b < MIN_CANDIDATE_LENGTH_IN) b = fallback;
  return { startHandleIn: a, endHandleIn: b };
}

/** The least-squares cubic over the stretch of `geometry` from arc length `fromIn` to `toIn`. */
function fittedCubic(geometry: PathGeometry, fromIn: number, toIn: number, p0: Vec2, p3: Vec2, d0: Vec2, d1: Vec2): CandidatePath {
  const targets = MERGE_FIT_FRACTIONS.map((f) => geometry.pointAtDistance(fromIn + f * (toIn - fromIn)));
  return { kind: "cubic", ...fitCubicHandles(p0, p3, d0, d1, MERGE_FIT_FRACTIONS, targets) };
}

/** Move 2: merges paths `k` and `k + 1` into one least-squares cubic over the outer nodes. */
export function mergePaths(base: MoveBase, k: number): RouteCandidate | null {
  const { candidate, geometry } = base;
  if (k < 0 || k + 1 >= candidate.paths.length) return null;
  const nodes = candidateNodes(candidate);
  if (typeof nodes === "string") return null;
  const d0 = nodes.directions[k] as Vec2;
  const d1 = nodes.directions[k + 2] as Vec2;
  const cubic = fittedCubic(
    geometry,
    geometry.breaks[k] as number,
    geometry.breaks[k + 2] as number,
    nodes.nodesIn[k] as Vec2,
    nodes.nodesIn[k + 2] as Vec2,
    d0,
    d1,
  );
  const tangents = settledTangents(candidate, nodes.directions);
  tangents[k] = directionRad(d0);
  tangents[k + 2] = directionRad(d1);
  return {
    ...candidate,
    jointsIn: [...candidate.jointsIn.slice(0, k), ...candidate.jointsIn.slice(k + 1)],
    tangentsRad: [...tangents.slice(0, k + 1), ...tangents.slice(k + 2)],
    paths: [...candidate.paths.slice(0, k), cubic, ...candidate.paths.slice(k + 2)],
  };
}

/**
 * Move 3: path `k` one step down or up the degree ladder. Up is exact: a line becomes the quadratic
 * along its chord, and a quadratic and a cubic are elevated. Down: a quartic becomes the
 * least-squares cubic, a cubic the quadratic its two tangents meet in (which `emitStep` refuses when
 * they do not meet), and a quadratic a line.
 */
export function changeDegree(base: MoveBase, k: number, direction: "down" | "up"): RouteCandidate | null {
  const { candidate, geometry } = base;
  const path = candidate.paths[k];
  const curve = geometry.curves[k];
  if (path === undefined || curve === undefined) return null;
  const kind = DEGREE_LADDER[DEGREE_LADDER.indexOf(path.kind) + (direction === "up" ? 1 : -1)];
  if (kind === undefined) return null;
  const nodes = candidateNodes(candidate);
  if (typeof nodes === "string") return null;
  const points = curve.points;
  let changed: CandidatePath;
  switch (kind) {
    case "line":
    case "quadratic":
      changed = { kind };
      break;
    case "cubic":
      changed =
        path.kind === "quadratic"
          ? {
              kind: "cubic",
              startHandleIn: (2 / 3) * distance(points[0] as Vec2, points[1] as Vec2),
              endHandleIn: (2 / 3) * distance(points[1] as Vec2, points[2] as Vec2),
            }
          : fittedCubic(
              geometry,
              geometry.breaks[k] as number,
              geometry.breaks[k + 1] as number,
              nodes.nodesIn[k] as Vec2,
              nodes.nodesIn[k + 1] as Vec2,
              nodes.directions[k] as Vec2,
              nodes.directions[k + 1] as Vec2,
            );
      break;
    case "quartic": {
      const [p0, p1, p2, p3] = points as [Vec2, Vec2, Vec2, Vec2];
      changed = {
        kind: "quartic",
        startHandleIn: 0.75 * distance(p0, p1),
        endHandleIn: 0.75 * distance(p2, p3),
        middleIn: { xIn: (p1.xIn + p2.xIn) / 2, yIn: (p1.yIn + p2.yIn) / 2 },
      };
      break;
    }
  }
  return { ...candidate, tangentsRad: settledTangents(candidate, nodes.directions), paths: replaceAt(candidate.paths, k, changed) };
}

/** Move 4: splits range `r`, when it is linear, at its middle, at the heading the robot has there (D3). */
export function splitHeadingRange(base: MoveBase, r: number): RouteCandidate | null {
  const ranges = rangesOf(base);
  const range = ranges?.[r];
  if (ranges === null || range === undefined) return null;
  const startT = r === 0 ? 0 : (ranges[r - 1] as CandidateRange).endT;
  const t = roundRangeT((startT + range.endT) / 2);
  const split = splitLinearRangeAt(ranges, t, robotHeadingAtBoundary(base, t));
  return split === null ? null : withRanges(base.candidate, split);
}

/** Move 5: merges range `r + 1` into range `r` (`deleteRange`), with the knots re-pinned. */
export function mergeHeadingRanges(base: MoveBase, r: number): RouteCandidate | null {
  const ranges = rangesOf(base);
  if (ranges === null || r < 0 || r + 1 >= ranges.length) return null;
  const merged = deleteRange(fileRanges(ranges), r + 1);
  if (merged.ranges.length !== ranges.length - 1) return null;
  const kept = merged.ranges.map((written, index): CandidateRange => {
    const own = ranges[index < r + 1 ? index : index + 1] as CandidateRange;
    return { ...own, endT: index === merged.ranges.length - 1 ? 1 : written.endT };
  });
  return withRanges(base.candidate, repinned(kept, base, [r]));
}

/**
 * Move 6: range `r` in another mode, with the knots re-pinned: its own, when it becomes linear, and
 * the range before it, which may now end into a range that reads its knot.
 */
export function changeRangeMode(base: MoveBase, r: number, mode: CandidateRange["mode"]): RouteCandidate | null {
  const ranges = rangesOf(base);
  const range = ranges?.[r];
  if (ranges === null || range === undefined || range.mode === mode) return null;
  return withRanges(base.candidate, repinned(replaceAt(ranges, r, { mode, endT: range.endT }), base, [r - 1, r]));
}

/** True when a range in `ranges` is narrower than the range edits allow. */
const tooNarrow = (ranges: readonly CandidateRange[]): boolean =>
  ranges.some((range, r) => range.endT - (r === 0 ? 0 : (ranges[r - 1] as CandidateRange).endT) < MIN_RANGE_T - 1e-12);

/**
 * Every structural move of a stalled candidate, in the order of spec 16 section 6.3: moves 1 to 3
 * path by path (and for a merge, pair by pair), then moves 4 to 6 range by range. A move the
 * options rule out, or one that builds nothing, is left out.
 */
export function structuralMoves(base: MoveBase, options: MoveOptions): StructuralMove[] {
  const moves: StructuralMove[] = [];
  const offer = (kind: StructuralMoveKind, index: number, to: string | null, candidate: RouteCandidate | null): void => {
    if (candidate === null) return;
    if (candidate.heading.mode === "ranges" && tooNarrow(candidate.heading.ranges)) return;
    moves.push({ kind, index, to, candidate });
  };
  const count = base.candidate.paths.length;
  if (options.mode !== "headingOnly") {
    for (let k = 0; k < count; k += 1) offer("splitPath", k, null, splitPath(base, k, options));
    for (let k = 0; k + 1 < count; k += 1) offer("mergePaths", k, null, mergePaths(base, k));
    for (let k = 0; k < count; k += 1) {
      for (const direction of ["down", "up"] as const) {
        const changed = changeDegree(base, k, direction);
        offer("changeDegree", k, changed === null ? null : (changed.paths[k] as CandidatePath).kind, changed);
      }
    }
  }
  const ranges = options.mode === "routeOnly" ? null : rangesOf(base);
  if (ranges !== null) {
    if (options.allowRanges) {
      for (let r = 0; r < ranges.length; r += 1) offer("splitRange", r, null, splitHeadingRange(base, r));
    }
    for (let r = 0; r + 1 < ranges.length; r += 1) offer("mergeRanges", r, null, mergeHeadingRanges(base, r));
    for (let r = 0; r < ranges.length; r += 1) {
      for (const mode of RANGE_MODES) offer("changeRangeMode", r, mode, changeRangeMode(base, r, mode));
    }
  }
  return moves;
}
