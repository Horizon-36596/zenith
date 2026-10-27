import {
  FORMAT_VERSIONS,
  parseAuto,
  SCHEMA_ID,
  SchemaError,
  type Auto,
  type Heading,
  type HeadingRange,
  type PathStep,
  type Pose as FilePose,
  type RangeHeading,
  type Segment,
} from "@horizon36596/zenith-schema";
import { canonicalize, digitsForKey, formatNumber } from "../canonicalize.js";
import { setRoute } from "../edit/path.js";
import { angleDelta } from "../geometry/angle.js";
import { makePath, type PathGeometry } from "../geometry/path.js";
import { add, cross, distance, dot, normalize, scale, sub, type Vec2 } from "../geometry/vec.js";
import { HALF_TURN_TOLERANCE_RAD, headingFunction, rangeHeadingFunction, rangeProblem } from "../heading.js";
import { MIN_RANGE_T, roundRangeT } from "../headingRanges.js";
import { EDITOR_PROVENANCE } from "../provenance.js";
import type { ResolvedStep } from "../resolve.js";

/**
 * The optimizer's candidate route and how it becomes a file.
 *
 * A `RouteCandidate` is the search's own representation of one path step's route: the interior
 * joints, one tangent direction per node, each path's kind and handle lengths, and the heading
 * ranges. It can only describe routes the specs allow:
 *
 * - Joints are G1. A line pins the tangent at both of its ends to its chord, so a curve beside a
 *   line leaves along it; two lines that meet make a deliberate corner. Elsewhere the curves on
 *   both sides of a joint read the joint's one tangent.
 * - The heading is continuous: a linear range starts on the heading the range before it ends on, a
 *   constant range holds that heading, h(0) is the heading the robot arrives with and h(1) is E's.
 *
 * `emitStep` writes the candidate as an ordinary `PathStep`: the original with only its `segments`
 * and `heading` replaced, both ends kept as written, every interior `from` `"current"` and every
 * interior `to` a bare inline point. The step it returns is already in canonical form, so the step
 * the search scores is the step that is saved. A candidate the specs do not allow, or one whose
 * rounded form breaks a rule, is refused with a sentence instead.
 *
 * Pure (CLAUDE.md rule 1).
 */

/**
 * How far E's heading, and the heading on either side of a range boundary, may differ from what
 * they must be, in radians (SPEC: canonical radian resolution, spec 16 section 2).
 */
export const END_HEADING_TOLERANCE_RAD = 1e-4;

/**
 * The shortest path, and the shortest Bezier handle, a candidate may have, in inches (SPEC:
 * canonical inch resolution, `canonicalize.ts`). Anything shorter collapses onto its end point when
 * the file is rounded, and its direction is lost. A handle this short keeps a direction but not
 * the one it was given: rounding can turn it by tenths of a radian, which `G1_TOLERANCE_RAD`
 * catches at a joint.
 */
export const MIN_CANDIDATE_LENGTH_IN = 0.001;

/**
 * How far the direction a path arrives at a joint on may differ from the direction the next path
 * leaves on, in the saved bytes, for the joint to count as G1, in radians (SET BY HAND: about half
 * a degree, which no follower or eye tells from a smooth joint). Rounding to the canonical inch
 * resolution turns a handle of h inches by at most 0.0007 / h rad, so two handles of 0.15 in or
 * longer always meet within it. Two lines that meet are a deliberate corner and are not held to it.
 */
export const G1_TOLERANCE_RAD = 0.01;

/** Arithmetic slack when two directions are tested for being parallel. It is not a tolerance on the route. */
const PARALLEL_EPSILON = 1e-9;

/** Where a route starts and ends, and the headings it must start and end on. */
export interface RouteEnds {
  /** Where the step's first `from` resolves: the route's first point. */
  startIn: Vec2;
  /** Where the step's last `to` resolves: the route's last point. */
  endIn: Vec2;
  /** The heading the robot arrives with, S's heading. A candidate's h(0). */
  arrivalHeadingRad: number;
  /** E's heading: what the original step's heading gives at t = 1 (`resolve.ts` `headingForEnd`). A candidate's h(1). */
  endHeadingRad: number;
}

/**
 * One path of a candidate. Its control points follow from the tangents at its two nodes (after a
 * line's pin), so a candidate's joints are G1 by construction.
 *
 * - `line`: no controls.
 * - `quadratic`: one control, where the two tangents meet. It needs them to meet ahead of the start
 *   and behind the end; a quadratic fillet between two lines is one.
 * - `cubic`: one control `startHandleIn` along the start tangent, one `endHandleIn` back along the
 *   end tangent.
 * - `quartic`: the cubic's two handles and a free middle control point, `middleIn`.
 */
export type CandidatePath =
  | { kind: "line" }
  | { kind: "quadratic" }
  | { kind: "cubic"; startHandleIn: number; endHandleIn: number }
  | { kind: "quartic"; startHandleIn: number; endHandleIn: number; middleIn: Vec2 };

/**
 * One heading range of a candidate, up to `endT` (an arc-length fraction, as in the file). Where it
 * starts is where the range before it ends, or 0.
 *
 * Only a `linear` range has a number of its own, and only where nothing pins it: its end heading
 * `endHeadingRad` is free when the next range is `linear` or `constant`. A last linear range ends on
 * E's heading, and one followed by a tangent range ends on that range's start, so in both cases
 * `endHeadingRad` is not read. A `constant` range holds the heading it starts on.
 */
export type CandidateRange =
  | { mode: "tangent" | "tangentReversed" | "constant"; endT: number }
  | { mode: "linear"; endT: number; endHeadingRad?: number };

/**
 * A candidate's heading: its own ranges, the original's `facePoint` kept as it is (spec 16
 * section 3: a facePoint step keeps facePoint, and only its geometry is optimised), or the
 * original's heading kept exactly as written, whatever its mode (`asWritten`: candidate 0 and the
 * "routeOnly" mode of the search). A kept heading still has to start on the arrival heading and end
 * on E's heading over the new geometry, which `emittedStepProblem` checks.
 */
export type CandidateHeading =
  | { mode: "facePoint" }
  | { mode: "asWritten" }
  | { mode: "ranges"; ranges: readonly CandidateRange[] };

/** A route for one path step, as the search holds it. */
export interface RouteCandidate {
  ends: RouteEnds;
  /** The joints between the paths, in order: one fewer than `paths`. */
  jointsIn: readonly Vec2[];
  /**
   * One tangent direction per node, start and end included, so one more than `paths`, in radians.
   * A node beside a line takes the line's chord instead, and its entry here is not read.
   */
  tangentsRad: readonly number[];
  paths: readonly CandidatePath[];
  heading: CandidateHeading;
}

export type EmitResult = { ok: true; step: PathStep } | { ok: false; reason: string };

/** A document in the form it is saved in: the canonical bytes and the auto parsed back from them. */
export interface CanonicalAuto {
  auto: Auto;
  text: string;
}

/** The route's ends and its S and E headings, read from the path step as `resolve` resolved it. */
export function routeEndsOf(resolved: ResolvedStep): RouteEnds {
  const segments = resolved.segments;
  const first = segments?.[0]?.pointsIn[0];
  const lastSegment = segments?.[segments.length - 1];
  const last = lastSegment?.pointsIn[lastSegment.pointsIn.length - 1];
  if (resolved.kind !== "path" || first === undefined || last === undefined) {
    throw new Error(`Step ${JSON.stringify(resolved.id)} is not a path with segments, so it has no route ends.`);
  }
  return {
    startIn: { xIn: first.xIn, yIn: first.yIn },
    endIn: { xIn: last.xIn, yIn: last.yIn },
    arrivalHeadingRad: resolved.startPose.headingRad,
    endHeadingRad: resolved.endPose.headingRad,
  };
}

/** The doc wrapped round a lone step so it can be written and read as an auto. */
function wrapperAuto(step: PathStep): unknown {
  return {
    $schema: SCHEMA_ID.auto,
    formatVersion: FORMAT_VERSIONS.auto,
    name: "candidate",
    alliance: "RED",
    start: { pose: { xIn: 0, yIn: 0, headingRad: 0 } },
    steps: [step],
  };
}

/**
 * The step as it is saved: canonicalised (3 decimals for inches, 4 for radians, `canonicalize.ts`)
 * and parsed back. Canonical form rounds by key, so a step's bytes do not depend on the auto
 * around it. Throws `SchemaError` for a step the schema refuses.
 */
export function canonicalPathStep(step: PathStep): PathStep {
  const text = canonicalize("auto", wrapperAuto(step));
  return parseAuto(JSON.parse(text) as unknown).steps[0] as PathStep;
}

/** The auto as it is saved: its canonical bytes, and the auto parsed back from them. */
export function canonicalAuto(auto: Auto): CanonicalAuto {
  const text = canonicalize("auto", auto);
  return { auto: parseAuto(JSON.parse(text) as unknown), text };
}

/**
 * The auto with one path step's route replaced by an emitted step's, through `setRoute`, in the form
 * it is saved. This is the auto the search plans and simulates, so the time a candidate scores is
 * the time of the bytes that would be written. Throws `EditError` for a route that moves an end.
 */
export function autoWithRoute(auto: Auto, stepId: string, step: PathStep): CanonicalAuto {
  if (step.heading === undefined) throw new Error("An emitted route always carries a heading.");
  return canonicalAuto(setRoute(auto, stepId, step.segments, step.heading));
}

const IN_DIGITS = digitsForKey("xIn");

/** An inch value rounded as canonical form rounds it. */
const roundIn = (value: number): number => Number(formatNumber(value, IN_DIGITS));

const roundPoint = (point: Vec2): Vec2 => ({ xIn: roundIn(point.xIn), yIn: roundIn(point.yIn) });

const unit = (rad: number): Vec2 => ({ xIn: Math.cos(rad), yIn: Math.sin(rad) });

const finitePoint = (point: Vec2): boolean => Number.isFinite(point.xIn) && Number.isFinite(point.yIn);

const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

/** What is wrong with a candidate's shape before any geometry is built, or null. */
function shapeProblem(candidate: RouteCandidate): string | null {
  const count = candidate.paths.length;
  if (count === 0) return "A candidate needs at least one path.";
  if (candidate.jointsIn.length !== count - 1) {
    return `A candidate with ${String(count)} paths needs ${String(count - 1)} joints, not ${String(candidate.jointsIn.length)}.`;
  }
  if (candidate.tangentsRad.length !== count + 1) {
    return `A candidate with ${String(count)} paths needs ${String(count + 1)} tangents, one per node, not ${String(candidate.tangentsRad.length)}.`;
  }
  const { ends } = candidate;
  const numbers = [
    ends.arrivalHeadingRad,
    ends.endHeadingRad,
    ...candidate.tangentsRad,
    ...candidate.paths.flatMap((path) =>
      path.kind === "cubic"
        ? [path.startHandleIn, path.endHandleIn]
        : path.kind === "quartic"
          ? [path.startHandleIn, path.endHandleIn, path.middleIn.xIn, path.middleIn.yIn]
          : [],
    ),
  ];
  const points = [ends.startIn, ends.endIn, ...candidate.jointsIn];
  if (!numbers.every(Number.isFinite) || !points.every(finitePoint)) {
    return "Every number in a candidate must be finite.";
  }
  if (candidate.heading.mode === "ranges") {
    for (const range of candidate.heading.ranges) {
      if (!Number.isFinite(range.endT)) return "Every number in a candidate must be finite.";
      if (range.mode === "linear" && range.endHeadingRad !== undefined && !Number.isFinite(range.endHeadingRad)) {
        return "Every number in a candidate must be finite.";
      }
    }
  }
  return null;
}

/**
 * The direction of travel at each node: a line's chord where a line meets the node (the incoming
 * one first), else the node's own tangent.
 */
function nodeDirections(nodes: readonly Vec2[], candidate: RouteCandidate): Vec2[] {
  return nodes.map((node, index) => {
    const incoming = index > 0 ? candidate.paths[index - 1] : undefined;
    const outgoing = candidate.paths[index];
    if (incoming?.kind === "line") return normalize(sub(node, nodes[index - 1] as Vec2));
    if (outgoing?.kind === "line") return normalize(sub(nodes[index + 1] as Vec2, node));
    return unit(candidate.tangentsRad[index] as number);
  });
}

/**
 * A candidate's nodes as `emitStep` writes them (the joints rounded as canonical form rounds them)
 * and the direction of travel at each, as `emitStep` reads it. The structural moves (`moves.ts`)
 * build on these, so a move starts from the geometry that was scored. A candidate of the wrong
 * shape gives the reason instead.
 */
export function candidateNodes(candidate: RouteCandidate): { nodesIn: Vec2[]; directions: Vec2[] } | string {
  const shape = shapeProblem(candidate);
  if (shape !== null) return shape;
  const nodesIn = [candidate.ends.startIn, ...candidate.jointsIn.map(roundPoint), candidate.ends.endIn];
  return { nodesIn, directions: nodeDirections(nodesIn, candidate) };
}

/** The control points of one path between `from` and `to`, leaving along `start` and arriving along `end`. */
function controlsFor(
  path: CandidatePath,
  index: number,
  from: Vec2,
  to: Vec2,
  start: Vec2,
  end: Vec2,
): Vec2[] | string {
  const label = `Path ${String(index + 1)}`;
  switch (path.kind) {
    case "line":
      return [];
    case "quadratic": {
      // The control is where the ray ahead of `from` meets the ray behind `to`.
      const chord = sub(to, from);
      const det = cross(start, end);
      if (Math.abs(det) <= PARALLEL_EPSILON) {
        const along = normalize(chord);
        if (Math.abs(cross(start, along)) <= PARALLEL_EPSILON && dot(start, along) > 0 && dot(end, along) > 0) {
          return [scale(add(from, to), 0.5)];
        }
        return `${label} is a quadratic whose two tangents are parallel and not along its chord, so they never meet.`;
      }
      const ahead = cross(chord, end) / det;
      const behind = cross(start, chord) / det;
      if (ahead < MIN_CANDIDATE_LENGTH_IN || behind < MIN_CANDIDATE_LENGTH_IN) {
        return `${label} is a quadratic whose tangents do not meet ahead of its start and behind its end.`;
      }
      return [add(from, scale(start, ahead))];
    }
    case "cubic":
    case "quartic": {
      if (path.startHandleIn < MIN_CANDIDATE_LENGTH_IN || path.endHandleIn < MIN_CANDIDATE_LENGTH_IN) {
        // A handle this long keeps a direction once rounded; whether it is still the joint's
        // tangent is for the G1 check on the rounded step (`emittedStepProblem`).
        return `${label} has a handle shorter than ${String(MIN_CANDIDATE_LENGTH_IN)} in, so its direction is lost when the file is rounded.`;
      }
      const first = add(from, scale(start, path.startHandleIn));
      const last = sub(to, scale(end, path.endHandleIn));
      return path.kind === "cubic" ? [first, last] : [first, path.middleIn, last];
    }
  }
}

/** The control polygon of every segment of a step, with the route's own ends where the file may name a reference. */
function stepPolygons(step: PathStep, ends: RouteEnds): Vec2[][] | string {
  const polygons: Vec2[][] = [];
  let from = ends.startIn;
  for (const [index, segment] of step.segments.entries()) {
    const last = index === step.segments.length - 1;
    if (index > 0 && segment.from !== "current") return `Path ${String(index + 1)} must start from "current".`;
    let to = ends.endIn;
    if (!last) {
      const written = segment.to;
      if (written === "current" || "ref" in written || written.headingRad !== undefined) {
        return `Path ${String(index + 1)} must end at a bare inline point, with no heading of its own.`;
      }
      to = { xIn: written.xIn, yIn: written.yIn };
    }
    const controls = segment.kind === "bezier" ? segment.control.map((point) => ({ xIn: point.xIn, yIn: point.yIn })) : [];
    polygons.push([from, ...controls, to]);
    from = to;
  }
  return polygons;
}

/** Angle text for a reason sentence, to the canonical radian resolution. */
const radText = (rad: number): string => `${formatNumber(rad, 4)} rad`;

/**
 * The first joint of the control polygons where the path before arrives on a direction more than
 * `G1_TOLERANCE_RAD` from the one the path after leaves on, or null. Two lines that meet are a
 * deliberate corner and are skipped. It reads the polygons as written, so a direction that rounding
 * turned is measured as it is saved.
 */
function cornerProblem(polygons: readonly (readonly Vec2[])[]): string | null {
  for (let index = 1; index < polygons.length; index += 1) {
    const before = polygons[index - 1] as readonly Vec2[];
    const after = polygons[index] as readonly Vec2[];
    if (before.length === 2 && after.length === 2) continue;
    const arriving = sub(before[before.length - 1] as Vec2, before[before.length - 2] as Vec2);
    const leaving = sub(after[1] as Vec2, after[0] as Vec2);
    if (Math.hypot(arriving.xIn, arriving.yIn) === 0 || Math.hypot(leaving.xIn, leaving.yIn) === 0) {
      return `Paths ${String(index)} and ${String(index + 1)} have a control point on their joint, so the direction there is lost.`;
    }
    const turn = angleDelta(Math.atan2(arriving.yIn, arriving.xIn), Math.atan2(leaving.yIn, leaving.xIn));
    if (Math.abs(turn) > G1_TOLERANCE_RAD) {
      return `Paths ${String(index)} and ${String(index + 1)} meet at a corner of ${radText(Math.abs(turn))}, not the smooth joint the optimizer writes.`;
    }
  }
  return null;
}

/**
 * What is wrong with an emitted step, or null when it obeys every rule of spec 16 sections 2 and 3
 * that its own bytes can show: interior joints are `"current"` and bare points and, unless two lines
 * meet there, G1 within `G1_TOLERANCE_RAD` as rounded, piecewise ranges are
 * valid and none is narrower than `MIN_RANGE_T`, no linear range or linear heading turns more than
 * half a turn, the heading is continuous from h(0), the arrival heading, across every boundary, and
 * h(1) is E's heading. A `facePoint` heading is the original's, and only h(1) is checked.
 *
 * It reads the step as written, so it is meant for the canonical form `emitStep` returns.
 */
export function emittedStepProblem(step: PathStep, ends: RouteEnds): string | null {
  const polygons = stepPolygons(step, ends);
  if (typeof polygons === "string") return polygons;
  const corner = cornerProblem(polygons);
  if (corner !== null) return corner;
  const heading = step.heading;
  if (heading === undefined) return "An emitted route must carry a heading.";
  return headingProblem(heading, makePath(polygons), ends);
}

/**
 * The geometry of an emitted step, with the route's own ends where the file may name a reference,
 * or why it has none (an interior joint that is not `"current"` and a bare point). The heading
 * seeds are built on it.
 */
export function stepGeometry(step: PathStep, ends: RouteEnds): PathGeometry | string {
  const polygons = stepPolygons(step, ends);
  return typeof polygons === "string" ? polygons : makePath(polygons);
}

/**
 * The heading half of `emittedStepProblem`, on a geometry the caller already has: what is wrong with
 * a heading over a route, or null. The search's "headingOnly" mode keeps the original's segments as
 * written and checks only the heading it writes over them.
 */
export function headingProblem(heading: Heading, geometry: PathGeometry, ends: RouteEnds): string | null {
  const endHeading = headingFunction(heading, geometry)(1);
  if (Math.abs(angleDelta(ends.endHeadingRad, endHeading)) > END_HEADING_TOLERANCE_RAD) {
    return `The route ends facing ${radText(endHeading)}, not E's heading ${radText(ends.endHeadingRad)}, so the steps after it would start differently.`;
  }
  if (heading.mode === "facePoint") return null;
  const ranges: HeadingRange[] =
    heading.mode === "piecewise" ? heading.ranges : [{ startT: 0, endT: 1, heading: heading as RangeHeading }];
  if (heading.mode === "piecewise") {
    const problem = rangeProblem(ranges);
    if (problem !== null) return problem;
  }
  for (const [index, range] of ranges.entries()) {
    const label = `Range ${String(index + 1)}`;
    if (range.endT - range.startT < MIN_RANGE_T - 1e-12) {
      return `${label} is narrower than ${String(MIN_RANGE_T)} of the path.`;
    }
    const inner = range.heading;
    if (inner.mode === "linear" && Math.abs(inner.toRad - inner.fromRad) > Math.PI + HALF_TURN_TOLERANCE_RAD) {
      return `${label} turns more than half a turn, so the robot would take the short way round.`;
    }
    if (inner.mode === "facePoint") return `${label} faces a point, which the optimizer does not write.`;
  }
  const first = ranges[0] as HeadingRange;
  const startHeading = rangeHeadingFunction(first, geometry)(0);
  if (Math.abs(angleDelta(ends.arrivalHeadingRad, startHeading)) > END_HEADING_TOLERANCE_RAD) {
    return `The route starts facing ${radText(startHeading)}, but the robot arrives facing ${radText(ends.arrivalHeadingRad)}.`;
  }
  for (let index = 0; index + 1 < ranges.length; index += 1) {
    const range = ranges[index] as HeadingRange;
    const next = ranges[index + 1] as HeadingRange;
    const before = rangeHeadingFunction(range, geometry)(range.endT);
    const after = rangeHeadingFunction(next, geometry)(range.endT);
    if (Math.abs(angleDelta(before, after)) > END_HEADING_TOLERANCE_RAD) {
      return `Range ${String(index + 2)} starts facing ${radText(after)}, but range ${String(index + 1)} ends facing ${radText(before)}.`;
    }
  }
  return null;
}

/**
 * The heading a candidate's ranges give on the emitted geometry, or a reason it has none. The heading
 * fit (`headingDp.ts`) reads it to measure a fitted heading exactly as `emitStep` will write it.
 */
export function rangesHeading(
  ranges: readonly CandidateRange[],
  geometry: PathGeometry,
  ends: RouteEnds,
): Heading | string {
  if (ranges.length === 0) return "A candidate's heading needs at least one range.";
  if ((ranges[ranges.length - 1] as CandidateRange).endT !== 1) return "A candidate's last range must end at 1.";
  const tangent = headingFunction({ mode: "tangent" }, geometry);
  const reversed = headingFunction({ mode: "tangentReversed" }, geometry);
  const written: HeadingRange[] = [];
  // The heading so far, unwrapped, so that one range's end and the next one's start are the same number.
  let current = ends.arrivalHeadingRad;
  let startT = 0;
  for (const [index, range] of ranges.entries()) {
    const next = ranges[index + 1];
    const endT = next === undefined ? 1 : roundRangeT(range.endT);
    let inner: RangeHeading;
    switch (range.mode) {
      case "tangent":
      case "tangentReversed":
        inner = { mode: range.mode };
        current = (range.mode === "tangent" ? tangent : reversed)(endT);
        break;
      case "constant":
        inner = { mode: "constant", headingRad: current };
        break;
      case "linear": {
        let target: number;
        if (next === undefined) target = ends.endHeadingRad;
        else if (next.mode === "tangent") target = tangent(endT);
        else if (next.mode === "tangentReversed") target = reversed(endT);
        else if (range.endHeadingRad !== undefined) target = range.endHeadingRad;
        else return `Range ${String(index + 1)} is linear into a ${next.mode} range and needs an end heading of its own.`;
        // The short way round, so no range turns more than half a turn.
        const toRad = current + angleDelta(current, target);
        inner = { mode: "linear", fromRad: current, toRad };
        current = toRad;
        break;
      }
    }
    written.push({ startT, endT, heading: inner });
    startT = endT;
  }
  if (written.length === 1) return (written[0] as HeadingRange).heading;
  return { mode: "piecewise", ranges: written };
}

/**
 * The provenance every pose the optimizer places carries: its interior joints and its curve
 * controls (CLAUDE.md rule 4). The optimizer is part of the editor, so the label is the editor's
 * own, and the reason names it. Without it each optimized route added a PROVENANCE note on its own
 * step, for poses the editor itself had written (issue #434).
 */
export const OPTIMIZER_PROVENANCE = `${EDITOR_PROVENANCE}: placed by Optimize path`;

/**
 * Writes a candidate as the original step with a new route (spec 16 sections 2, 3 and 6.1), in
 * canonical form, or says why it cannot.
 *
 * - The first `from` and the last `to` are the original's, as written: a `"current"` stays
 *   `"current"` and a `{ref}` stays that ref. An original whose last `to` is `"current"` is refused,
 *   because its end would move with the route.
 * - Every interior `from` is `"current"`, and every interior `to` is `{ xIn, yIn }` with no
 *   `headingRad`. Every interior `to` and every curve control carries `OPTIMIZER_PROVENANCE`.
 * - One range is written as that plain mode; more are written as `piecewise` ranges, their ends on
 *   four decimals as the range edits write them.
 * - Every other key of the original is kept as it is.
 *
 * The joints are rounded before the controls are placed, and the controls before the heading is
 * computed, so the pinned headings are those of the geometry that is saved. The result is then
 * canonicalised and checked by `emittedStepProblem`.
 */
export function emitStep(candidate: RouteCandidate, original: PathStep): EmitResult {
  const shape = shapeProblem(candidate);
  if (shape !== null) return fail(shape);
  const firstSegment = original.segments[0];
  const lastSegment = original.segments[original.segments.length - 1];
  if (firstSegment === undefined || lastSegment === undefined) return fail("The original step has no segments.");
  if (lastSegment.to === "current") {
    return fail('The step\'s last to is "current", so its end would move with the route; the optimizer keeps ends where they are.');
  }
  const facePoint = original.heading?.mode === "facePoint";
  const kept = candidate.heading.mode === "facePoint" || candidate.heading.mode === "asWritten";
  if (facePoint && !kept) {
    return fail("The step faces a point, and a facePoint step keeps facePoint; only its geometry is optimised.");
  }
  if (!facePoint && candidate.heading.mode === "facePoint") {
    return fail("Only a step that already faces a point keeps a facePoint heading.");
  }
  if (kept && original.heading === undefined) return fail("The original step has no heading to keep.");

  const { ends } = candidate;
  const nodes = [ends.startIn, ...candidate.jointsIn.map(roundPoint), ends.endIn];
  for (let index = 0; index + 1 < nodes.length; index += 1) {
    if (distance(nodes[index] as Vec2, nodes[index + 1] as Vec2) < MIN_CANDIDATE_LENGTH_IN) {
      return fail(`Path ${String(index + 1)} has no length once the file is rounded.`);
    }
  }
  const directions = nodeDirections(nodes, candidate);
  const segments: Segment[] = [];
  const polygons: Vec2[][] = [];
  const count = candidate.paths.length;
  for (const [index, path] of candidate.paths.entries()) {
    const from = nodes[index] as Vec2;
    const to = nodes[index + 1] as Vec2;
    const controls = controlsFor(path, index, from, to, directions[index] as Vec2, directions[index + 1] as Vec2);
    if (typeof controls === "string") return fail(controls);
    const rounded = controls.map(roundPoint);
    const fromSource = index === 0 ? firstSegment.from : "current";
    const toSource = index === count - 1 ? lastSegment.to : { xIn: to.xIn, yIn: to.yIn, provenance: OPTIMIZER_PROVENANCE };
    segments.push(
      rounded.length === 0
        ? { kind: "line", from: fromSource, to: toSource }
        : { kind: "bezier", from: fromSource, control: rounded.map((point): FilePose => ({ ...point, provenance: OPTIMIZER_PROVENANCE })), to: toSource },
    );
    polygons.push([from, ...rounded, to]);
  }

  let heading: Heading;
  if (candidate.heading.mode !== "ranges") {
    heading = original.heading as Heading;
  } else {
    const built = rangesHeading(candidate.heading.ranges, makePath(polygons), ends);
    if (typeof built === "string") return fail(built);
    heading = built;
  }

  let step: PathStep;
  try {
    step = canonicalPathStep({ ...original, segments, heading });
  } catch (error) {
    if (error instanceof SchemaError) return fail(error.message);
    throw error;
  }
  const problem = emittedStepProblem(step, ends);
  return problem === null ? { ok: true, step } : fail(problem);
}
