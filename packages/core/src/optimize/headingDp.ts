import type { HeadingRange, Robot } from "@horizon36596/zenith-schema";
import { PERIMETER_TOLERANCE_IN } from "../check.js";
import { mouthHeadingRad, runningAt, type RunningFrom } from "../checks/intake.js";
import { sampleCapInPerS } from "../estimate.js";
import { footprintAt } from "../footprint.js";
import { angleDelta, wrapAngle } from "../geometry/angle.js";
import { SAMPLE_SPACING_IN, sampleDistances, type PathGeometry } from "../geometry/path.js";
import type { Vec2 } from "../geometry/vec.js";
import { headingFunction, tangentHeading } from "../heading.js";
import { MIN_RANGE_T, roundRangeT } from "../headingRanges.js";
import { MOUTH_LEADING_TOLERANCE_RAD, robotLimits, type RobotLimits } from "../kinematics.js";
import type { PlanSample } from "../types.js";
import { END_HEADING_TOLERANCE_RAD, rangesHeading, type CandidateRange, type RouteEnds } from "./candidate.js";
import { CENTRE_LINE_KEEPOUT_ID, CLEARANCE_EPSILON_IN, measureClearances, sweptPairShortfalls, type ClearanceWorld } from "./clearance.js";

/**
 * The optimizer's heading dynamic program and its fit to Pedro's modes, and the other heading families
 * (tangent, reversed, linear) it seeds the search with.
 *
 * On a fixed route the program picks one heading at each station so the route is driven fastest
 * under the estimator's own speed caps, while the footprint clears what it must and a running
 * mouth leads. The fit then writes that heading sequence as the fewest Pedro modes it can, in the
 * file's own vocabulary (`CandidateRange`, which `emitStep` writes). Nothing here plans an auto,
 * runs a sim or scores a candidate; the search does that with the seeds this file builds.
 *
 * Pure and deterministic (CLAUDE.md rule 1): no clock, no randomness, and every tie goes to the
 * lower index.
 */

/** World headings at every interior station: every 11.25 degrees (SET BY HAND: spec 16 section 6.4). */
export const DP_WORLD_HEADINGS = 32;

/** How far a mode may stray from the program's heading and still fit it, in radians: 5 degrees (SET BY HAND: spec 16 section 6.4). */
export const FIT_TOLERANCE_RAD = 0.0873;

/** How near a range end must be to a joint to snap onto it, as a fraction of the path (SET BY HAND: spec 16 section 6.4). */
export const JOINT_SNAP_T = 0.02;

/** Arithmetic slack when a heading is compared with a tolerance. It is not a tolerance itself. */
const ANGLE_EPSILON_RAD = 1e-12;

/**
 * The most one fitted linear range turns, in radians: just under half a turn, so the range never
 * turns more than half a turn and the runtime takes the way the fit meant. Canonical form rounds
 * both of its headings to 1e-4 rad, which can widen the turn by up to 1e-4, so 2e-4 is left
 * (SPEC: canonical radian resolution, `canonicalize.ts`).
 */
const MAX_LINEAR_TURN_RAD = Math.PI - 2e-4;

/** The narrowest range, in the 1e-4 steps range ends are written on (`roundRangeT`). */
const MIN_RANGE_UNITS = Math.round(MIN_RANGE_T * 10000);

/** What the program needs: the route, its ends, the robot and the world it must clear. */
export interface HeadingDpInput {
  /** The fixed route. Only its headings are chosen. */
  geometry: PathGeometry;
  /** The arrival heading (h at the first station) and E's heading (h at the last); the points are not read. */
  ends: RouteEnds;
  robot: Robot;
  world: ClearanceWorld;
  /** The safety margin to structures, in inches (spec 16 section 4.1). */
  marginIn: number;
  /** The step's speed fraction, which the velocity cap is scaled by. */
  speedFraction: number;
  /** The mouths running over this step and where (`intakeTimeline`); none when absent. */
  running?: RunningFrom;
  /** World headings per interior station; `DP_WORLD_HEADINGS` unless a test asks for a smaller lattice. */
  worldHeadings?: number;
}

/** One heading the robot may hold at a station, with its footprint and clearances. */
export interface DpState {
  headingRad: number;
  /** The footprint at this pose, as `plan()` would sample it. */
  sample: PlanSample;
  /** Signed clearance to each structure of the world, in its order, in inches. */
  structureClearancesIn: number[];
}

export interface DpStation {
  sIn: number;
  /** Arc-length fraction, the t of a heading range. */
  t: number;
  pointIn: Vec2;
  /** The direction of travel, the tangent heading at t. */
  travelRad: number;
  /** The headings kept here, in index order. The first and the last station have exactly one. */
  states: DpState[];
  /** True when a running mouth must lead here, so the headings were filtered by it as well as by clearance. */
  mouthLive: boolean;
}

/** The program's graph: its stations, and the cost and the rules of every transition. */
export interface HeadingLattice {
  stations: DpStation[];
  /** Seconds to drive from state `a` of station `i` to state `b` of station `i + 1`. */
  edgeCostS(i: number, a: number, b: number): number;
  /** True when that transition keeps every clearance rule, the rotation between the two included. */
  edgeAllowed(i: number, a: number, b: number): boolean;
  /** Why no heading sequence can exist at all, such as an end that overlaps a structure; else null. */
  problem: string | null;
}

/** One station of the program's answer. */
export interface DpHeading {
  sIn: number;
  t: number;
  /** The state's heading, wrapped to (-pi, pi]. */
  headingRad: number;
  /** The same heading unwrapped along the route, each step the short way from the one before. */
  unwrappedRad: number;
}

export type HeadingDpResult =
  | { ok: true; costS: number; stateIndices: number[]; stations: DpHeading[] }
  | { ok: false; reason: string };

/** The headings tried at an interior station, in index order, with exact repeats dropped. */
function stationHeadings(count: number, travelRad: number, ends: RouteEnds): number[] {
  const headings: number[] = [];
  for (let k = 0; k < count; k += 1) headings.push(wrapAngle((2 * Math.PI * k) / count));
  headings.push(
    wrapAngle(travelRad),
    wrapAngle(travelRad + Math.PI),
    wrapAngle(travelRad + Math.PI / 2),
    wrapAngle(travelRad - Math.PI / 2),
    wrapAngle(ends.endHeadingRad),
    wrapAngle(ends.arrivalHeadingRad),
  );
  const unique: number[] = [];
  for (const heading of headings) if (!unique.includes(heading)) unique.push(heading);
  return unique;
}

function sampleAt(sIn: number, t: number, pointIn: Vec2, headingRad: number, robot: Robot): PlanSample {
  const pose = { xIn: pointIn.xIn, yIn: pointIn.yIn, headingRad };
  const footprint = footprintAt(pose, robot);
  return { sIn, t, pose, footprintIn: footprint.bodyIn, mouthsIn: footprint.mouthsIn };
}

/** The first thing a lone sample overlaps, or null. Structures and keep-outs first, then the wall. */
function overlapAt(world: ClearanceWorld, sample: PlanSample): string | null {
  const measured = measureClearances(world, [sample]);
  for (const [k, structure] of world.structures.entries()) {
    if ((measured.structuresIn[k]?.[0] as number) < -CLEARANCE_EPSILON_IN) return structure.id;
  }
  for (const [k, keepOut] of world.keepOuts.entries()) {
    if ((measured.keepOutsIn[k]?.[0] as number) < -CLEARANCE_EPSILON_IN) {
      return keepOut.id === CENTRE_LINE_KEEPOUT_ID ? "the centre line" : keepOut.id;
    }
  }
  if ((measured.wallsIn[0] as number) < -PERIMETER_TOLERANCE_IN) return "the field wall";
  return null;
}

/**
 * The program's graph on one route (spec 16 section 6.4).
 *
 * - **Stations** are every 2 in of arc length (`SAMPLE_SPACING_IN`) plus every joint, as `plan()`
 *   samples a path.
 * - **States.** The first station holds only the arrival heading and the last only E's heading.
 *   Every other station holds the world headings, the tangent, the tangent + pi, the tangent ± pi/2,
 *   E's heading and the arrival heading, in that order, without repeats. A state is dropped when
 *   its footprint touches a wall (past `PERIMETER_TOLERANCE_IN`) or a keep-out that applies in
 *   auto, penetrates a structure, or comes inside the margin of a structure that neither end is
 *   already inside the margin of. While an intake runs (over its spans in `running`), a state is also
 *   dropped unless a running mouth points within MOUTH_LEADING's tolerance of the direction of
 *   travel, by the check's own predicate. The two ends are fixed, so they are not held to it.
 * - **Cost.** A transition costs `ds / cap`, with `cap` the estimator's own `sampleCapInPerS` at
 *   the transition's middle: the velocity ellipse at travel minus heading, the heading rate of the
 *   short-way turn over `ds`, and the curvature of the route over `ds`.
 * - **Transitions** turn the short way and are allowed only when the rotation clears: the swept
 *   pair test of the final check (`sweptPairShortfalls`, hulls plus the rotation bulge) passes.
 *   A structure the start sits inside the margin of follows the end exemption (spec 16 section 4.3)
 *   step by step: while the clearance is under the margin it must not fall, and once it reaches the
 *   margin it stays there. A structure E sits inside the margin of is held to the same in reverse.
 *   A structure inside the margin at both ends takes either rule on each step, which the exact
 *   rule does not always allow; the hard final check (section 4.4) holds a candidate to it.
 *
 * The cost ignores acceleration, as the spec's sum of `ds / cap` does: the search scores the
 * fitted heading with the real objective afterwards.
 */
export function headingLattice(input: HeadingDpInput): HeadingLattice {
  const { geometry, ends, robot, world, marginIn, speedFraction } = input;
  const count = input.worldHeadings ?? DP_WORLD_HEADINGS;
  const limits: RobotLimits = robotLimits(robot);
  const distances = sampleDistances(geometry, SAMPLE_SPACING_IN);
  const lastIndex = distances.length - 1;
  const mouths = robot.mouths ?? [];
  const running: RunningFrom = input.running ?? new Map();
  const below = (clearanceIn: number): boolean => clearanceIn < marginIn - CLEARANCE_EPSILON_IN;

  const base = distances.map((sIn) => {
    const t = geometry.tAtDistance(sIn);
    return { sIn, t, pointIn: geometry.pointAtDistance(sIn), travelRad: tangentHeading(geometry, t) };
  });
  const endState = (index: number, headingRad: number): DpState | null => {
    const at = base[index];
    if (at === undefined) return null;
    const sample = sampleAt(at.sIn, at.t, at.pointIn, wrapAngle(headingRad), robot);
    const measured = measureClearances(world, [sample]);
    return { headingRad: sample.pose.headingRad, sample, structureClearancesIn: measured.structuresIn.map((row) => row[0] as number) };
  };

  let problem: string | null = null;
  if (distances.length < 2 || geometry.lengthIn <= 0) problem = "The route has no length, so there is no heading to plan along it.";
  const first = endState(0, ends.arrivalHeadingRad);
  const last = endState(lastIndex, ends.endHeadingRad);
  for (const state of [first, last]) {
    if (problem !== null || state === null) break;
    const overlap = overlapAt(world, state.sample);
    if (overlap !== null) problem = `The step's own end overlaps ${overlap}.`;
  }
  // A structure an end already sits inside the margin of, which the exemption covers there.
  const fromStart = world.structures.map((_, k) => first !== null && below(first.structureClearancesIn[k] as number));
  const fromEnd = world.structures.map((_, k) => last !== null && below(last.structureClearancesIn[k] as number));

  const liveAt = (t: number) =>
    mouths.filter((mouth) => runningAt(running.get(mouth.id), t));
  const leads = (t: number, travelRad: number, headingRad: number): boolean => {
    const live = liveAt(t);
    if (live.length === 0) return true;
    let best = Infinity;
    for (const mouth of live) best = Math.min(best, Math.abs(wrapAngle(mouthHeadingRad(mouth, headingRad) - travelRad)));
    return best <= MOUTH_LEADING_TOLERANCE_RAD + ANGLE_EPSILON_RAD;
  };

  const stations: DpStation[] = base.map((at, index) => {
    const mouthLive = index > 0 && index < lastIndex && liveAt(at.t).length > 0;
    if (problem !== null) return { ...at, states: [], mouthLive };
    if (index === 0) return { ...at, states: [first as DpState], mouthLive };
    if (index === lastIndex) return { ...at, states: [last as DpState], mouthLive };
    const samples = stationHeadings(count, at.travelRad, ends)
      .filter((headingRad) => leads(at.t, at.travelRad, headingRad))
      .map((headingRad) => sampleAt(at.sIn, at.t, at.pointIn, headingRad, robot));
    const measured = measureClearances(world, samples);
    const states: DpState[] = [];
    samples.forEach((sample, j) => {
      if ((measured.wallsIn[j] as number) < -PERIMETER_TOLERANCE_IN) return;
      if (measured.keepOutsIn.some((row) => (row[j] as number) < -CLEARANCE_EPSILON_IN)) return;
      const clearances = measured.structuresIn.map((row) => row[j] as number);
      const fails = clearances.some(
        (clearance, k) => clearance < -CLEARANCE_EPSILON_IN || (below(clearance) && !fromStart[k] && !fromEnd[k]),
      );
      if (!fails) states.push({ headingRad: sample.pose.headingRad, sample, structureClearancesIn: clearances });
    });
    return { ...at, states, mouthLive };
  });

  const middleTravel = stations.slice(1).map((station, i) => {
    const tangent = geometry.tangentAtDistance(((stations[i] as DpStation).sIn + station.sIn) / 2);
    return Math.atan2(tangent.yIn, tangent.xIn);
  });

  const edgeCostS = (i: number, a: number, b: number): number => {
    const from = stations[i] as DpStation;
    const to = stations[i + 1] as DpStation;
    const ds = to.sIn - from.sIn;
    const startRad = (from.states[a] as DpState).headingRad;
    const turnRad = angleDelta(startRad, (to.states[b] as DpState).headingRad);
    const phiRad = wrapAngle((middleTravel[i] as number) - (startRad + turnRad / 2));
    const curvaturePerIn = Math.abs(angleDelta(from.travelRad, to.travelRad)) / ds;
    const cap = sampleCapInPerS(limits, speedFraction, phiRad, Math.abs(turnRad) / ds, curvaturePerIn);
    return cap > 0 ? ds / cap : Infinity;
  };

  const allowed = new Map<string, boolean>();
  const edgeAllowed = (i: number, a: number, b: number): boolean => {
    const key = `${String(i)}:${String(a)}:${String(b)}`;
    const known = allowed.get(key);
    if (known !== undefined) return known;
    const from = (stations[i] as DpStation).states[a] as DpState;
    const to = (stations[i + 1] as DpStation).states[b] as DpState;
    let ok = true;
    const exempt: boolean[] = [];
    for (let k = 0; k < world.structures.length && ok; k += 1) {
      const before = from.structureClearancesIn[k] as number;
      const after = to.structureClearancesIn[k] as number;
      exempt.push(below(before) || below(after));
      if (!below(before) && !below(after)) continue;
      const leavingStart = fromStart[k] === true && below(before) && after >= before - CLEARANCE_EPSILON_IN;
      const arrivingAtEnd = fromEnd[k] === true && below(after) && before >= after - CLEARANCE_EPSILON_IN;
      ok = leavingStart || arrivingAtEnd;
    }
    if (ok) {
      sweptPairShortfalls(world, from.sample, to.sample, marginIn, (k) => exempt[k] === true, (_kind, _id, shortfallIn) => {
        if (shortfallIn > CLEARANCE_EPSILON_IN) ok = false;
      });
    }
    allowed.set(key, ok);
    return ok;
  };

  return { stations, edgeCostS, edgeAllowed, problem };
}

const inchesText = (value: number): string => value.toFixed(1);

/**
 * The cheapest allowed heading sequence through a lattice, by dynamic programming from the first
 * station to the last. At each state the predecessors are taken cheapest first, and the lower
 * state index first among equal costs, and the first whose transition is allowed is kept, so the
 * answer is the cheapest sequence and every tie goes to the lower state index (spec 16 section
 * 6.4). Only the transitions it needs are tested for clearance.
 */
export function solveHeadingLattice(lattice: HeadingLattice): HeadingDpResult {
  if (lattice.problem !== null) return { ok: false, reason: lattice.problem };
  const { stations } = lattice;
  const costs: number[][] = [[0]];
  const back: number[][] = [[-1]];
  for (let i = 1; i < stations.length; i += 1) {
    const previous = costs[i - 1] as number[];
    const row: number[] = [];
    const from: number[] = [];
    const states = (stations[i] as DpStation).states;
    for (let b = 0; b < states.length; b += 1) {
      const options: { costS: number; a: number }[] = [];
      for (let a = 0; a < previous.length; a += 1) {
        const before = previous[a] as number;
        if (!Number.isFinite(before)) continue;
        const costS = before + lattice.edgeCostS(i - 1, a, b);
        if (Number.isFinite(costS)) options.push({ costS, a });
      }
      options.sort((x, y) => x.costS - y.costS || x.a - y.a);
      const pick = options.find((option) => lattice.edgeAllowed(i - 1, option.a, b));
      row.push(pick?.costS ?? Infinity);
      from.push(pick?.a ?? -1);
    }
    if (!row.some(Number.isFinite)) {
      const station = stations[i] as DpStation;
      return {
        ok: false,
        reason:
          states.length === 0
            ? `No heading at ${inchesText(station.sIn)} in along the route keeps the footprint clear${station.mouthLive ? ", with a running mouth leading" : ""}.`
            : `No heading the robot can turn to by ${inchesText(station.sIn)} in along the route keeps the footprint clear.`,
      };
    }
    costs.push(row);
    back.push(from);
  }

  const stateIndices: number[] = new Array<number>(stations.length).fill(0);
  for (let i = stations.length - 1; i > 0; i -= 1) {
    stateIndices[i - 1] = (back[i] as number[])[stateIndices[i] as number] as number;
  }
  const out: DpHeading[] = [];
  let unwrappedRad = 0;
  for (const [i, station] of stations.entries()) {
    const headingRad = (station.states[stateIndices[i] as number] as DpState).headingRad;
    unwrappedRad = i === 0 ? headingRad : unwrappedRad + angleDelta(out[i - 1]?.headingRad as number, headingRad);
    out.push({ sIn: station.sIn, t: station.t, headingRad, unwrappedRad });
  }
  const lastRow = costs[costs.length - 1] as number[];
  return { ok: true, costS: lastRow[0] as number, stateIndices, stations: out };
}

/** The heading dynamic program of spec 16 section 6.4 on one route: `headingLattice` then `solveHeadingLattice`. */
export function headingDp(input: HeadingDpInput): HeadingDpResult {
  return solveHeadingLattice(headingLattice(input));
}

/** A heading the fit must follow at one t, such as one station of the program's answer. */
export interface FitStation {
  t: number;
  headingRad: number;
}

export interface HeadingFit {
  /** The ranges, as a candidate holds them and `emitStep` writes them. One range is a plain mode. */
  ranges: CandidateRange[];
  /** How far the written heading strays from the stations it was fitted to, at worst, in radians. */
  maxDeviationRad: number;
}

export interface FitOptions {
  /** False to return one mode, never piecewise ranges (the card's "Allow heading ranges"). */
  allowRanges?: boolean;
}

type FitMode = "tangent" | "tangentReversed" | "constant" | "linear";

/** A linear range the fit has placed: the station it starts at, its start heading, and whether a turn fitted it. */
interface PreviousLinear {
  p: number;
  startRad: number;
  fitted: boolean;
}

/** The order modes are tried in, and the order a tie between two equally long stretches goes by. */
const FIT_ORDER: readonly FitMode[] = ["tangent", "tangentReversed", "constant", "linear"];

/**
 * Fits headings at stations into the fewest Pedro modes (spec 16 section 6.4).
 *
 * - One `tangent`, one `tangentReversed`, one `constant` and one `linear` are tried first, in that
 *   order. The first that stays within `FIT_TOLERANCE_RAD` of every station, starts on the arrival
 *   heading and ends on E's heading is the answer.
 * - Otherwise `piecewise` ranges are fitted greedily from the left. Each range is the longest
 *   stretch one mode fits within `FIT_TOLERANCE_RAD`, the earlier mode in that order on a tie, and
 *   it ends on a station. A range end within `JOINT_SNAP_T` of a joint snaps onto the joint.
 * - The ranges are the ones `emitStep` accepts: they start at 0, abut, and the last ends at exactly
 *   1; none is narrower than `MIN_RANGE_T` once its ends are written on four decimals; each linear
 *   range turns the short way, so never more than half a turn; and the heading is continuous across
 *   every boundary. A tangent range therefore starts only where the heading already is the tangent,
 *   or after a linear range, which then ends on the tangent, and only where that linear range still
 *   fits every one of its stations with its end pinned there. When no mode fits a stretch, the range
 *   is linear to the nearest station it may end on.
 *
 * `stations` must start at t 0 on the arrival heading and end at t 1 on E's heading, as the
 * program's answer does. The joints are read from the geometry.
 */
export function fitPedroModes(
  geometry: PathGeometry,
  ends: RouteEnds,
  stations: readonly FitStation[],
  options: FitOptions = {},
): HeadingFit {
  const lastIndex = stations.length - 1;
  const ts = stations.map((station) => station.t);
  const written = ts.map((t, i) => (i === 0 ? 0 : i === lastIndex ? 1 : roundRangeT(t)));
  const units = written.map((t) => Math.round(t * 10000));
  const wanted = stations.map((station) => station.headingRad);
  const tangentAt = ts.map((t) => tangentHeading(geometry, t));
  const tangentWritten = written.map((t) => tangentHeading(geometry, t));
  const endRad = ends.endHeadingRad;
  const lengthIn = geometry.lengthIn;
  const joints = new Set<number>();
  for (const atIn of geometry.breaks.slice(1, -1)) {
    const index = ts.findIndex((t, i) => i > 0 && i < lastIndex && Math.abs(t * lengthIn - atIn) <= 1e-9);
    if (index > 0) joints.add(index);
  }

  const near = (a: number, b: number, tolerance: number): boolean =>
    Math.abs(angleDelta(a, b)) <= tolerance + ANGLE_EPSILON_RAD;
  const fits = (i: number, headingRad: number): boolean => near(headingRad, wanted[i] as number, FIT_TOLERANCE_RAD);
  const widthOk = (p: number, q: number): boolean =>
    (units[q] as number) - (units[p] as number) >= MIN_RANGE_UNITS &&
    (q === lastIndex || 10000 - (units[q] as number) >= MIN_RANGE_UNITS);
  const fixedAt = (mode: FitMode, i: number, holdRad: number): number =>
    mode === "tangent"
      ? (tangentAt[i] as number)
      : mode === "tangentReversed"
        ? wrapAngle((tangentAt[i] as number) + Math.PI)
        : holdRad;
  const endsOk = (mode: FitMode, q: number, holdRad: number): boolean => {
    if (q !== lastIndex || mode === "linear") return true;
    const at = mode === "tangent" ? tangentAt[q] : mode === "tangentReversed" ? wrapAngle((tangentAt[q] as number) + Math.PI) : holdRad;
    return near(at as number, endRad, END_HEADING_TOLERANCE_RAD);
  };
  /**
   * The turns of a linear range from station `p` to station `q`, starting on `startRad`, that keep
   * every station between within the tolerance, as an interval, with the turn to the heading wanted
   * at `q` beside it. Null when no turn of at most `MAX_LINEAR_TURN_RAD` does.
   *
   * The heading a linear range gives at a station is `startRad + turn * share`, with the share read
   * from `headingFunction` itself, so the fit follows the runtime's interpolation (linear in each
   * segment's parametric t, OPT-01) and not the arc-length one. Each station therefore bounds the
   * turn to an interval, and the stretch fits when the intervals meet.
   */
  const linearBounds = (p: number, q: number, startRad: number): { lowRad: number; highRad: number; wantedRad: number } | null => {
    const share = linearShare(geometry, written[p] as number, written[q] as number);
    let lowRad = -MAX_LINEAR_TURN_RAD;
    let highRad = MAX_LINEAR_TURN_RAD;
    // The wanted headings unwrapped from the start, each the short way from the one before.
    let unwrapped = startRad + angleDelta(startRad, wanted[p] as number);
    for (let i = p + 1; i <= q; i += 1) {
      unwrapped += angleDelta(wanted[i - 1] as number, wanted[i] as number);
      const fraction = share(ts[i] as number);
      const offset = unwrapped - startRad;
      if (fraction <= 0) {
        if (Math.abs(offset) > FIT_TOLERANCE_RAD + ANGLE_EPSILON_RAD) return null;
        continue;
      }
      lowRad = Math.max(lowRad, (offset - FIT_TOLERANCE_RAD) / fraction);
      highRad = Math.min(highRad, (offset + FIT_TOLERANCE_RAD) / fraction);
      if (lowRad > highRad + ANGLE_EPSILON_RAD) return null;
    }
    return { lowRad, highRad, wantedRad: unwrapped - startRad };
  };
  const turnWithin = (bounds: { lowRad: number; highRad: number }, turnRad: number): boolean =>
    turnRad >= bounds.lowRad - ANGLE_EPSILON_RAD && turnRad <= bounds.highRad + ANGLE_EPSILON_RAD;
  /**
   * The turn of a linear range from station `p` to station `q`, starting on `startRad`, that keeps
   * every station between within the tolerance: the one nearest the heading wanted at `q`, or E's
   * heading when `q` is the last station. Null when no turn of at most `MAX_LINEAR_TURN_RAD` does.
   */
  const linearTurn = (p: number, q: number, startRad: number): number | null => {
    const bounds = linearBounds(p, q, startRad);
    if (bounds === null) return null;
    if (q === lastIndex) {
      const turnRad = angleDelta(startRad, endRad);
      return turnWithin(bounds, turnRad) ? turnRad : null;
    }
    return Math.min(bounds.highRad, Math.max(bounds.lowRad, bounds.wantedRad));
  };
  /** The heading a tangent or reversed tangent range starts on at station `p`, where its start is written. */
  const tangentStartRad = (mode: "tangent" | "tangentReversed", p: number): number =>
    mode === "tangent" ? (tangentWritten[p] as number) : wrapAngle((tangentWritten[p] as number) + Math.PI);

  /**
   * The station the longest stretch of `mode` from station `p` can end on, with a linear range's
   * turn, or null. `before` is the linear range that ends at `p`, when one does.
   *
   * A tangent range starts where the heading already is the tangent. After a linear range it may
   * also start where that range can end on the tangent instead: `rangesHeading` writes a linear
   * range that a tangent range follows ending on the tangent, which moves every one of its stations,
   * so the linear range must still fit them all with its end pinned there, the short way. A linear
   * range that no turn fitted (`fitted` false) already strays, so only its own end is held to the
   * tolerance.
   */
  const longest = (
    mode: FitMode,
    p: number,
    currentRad: number,
    before: PreviousLinear | null,
  ): { q: number; turnRad: number } | null => {
    if (mode === "tangent" || mode === "tangentReversed") {
      const startRad = tangentStartRad(mode, p);
      let starts: boolean;
      if (before === null) starts = near(currentRad, startRad, END_HEADING_TOLERANCE_RAD);
      else if (!before.fitted) starts = near(currentRad, startRad, FIT_TOLERANCE_RAD);
      else {
        const bounds = linearBounds(before.p, p, before.startRad);
        starts = bounds !== null && turnWithin(bounds, angleDelta(before.startRad, startRad));
      }
      if (!starts) return null;
    }
    let best: { q: number; turnRad: number } | null = null;
    for (let q = p + 1; q <= lastIndex; q += 1) {
      if (mode === "linear") {
        if (!widthOk(p, q)) continue;
        const turnRad = linearTurn(p, q, currentRad);
        if (turnRad !== null) best = { q, turnRad };
        continue;
      }
      if (!fits(q, fixedAt(mode, q, currentRad))) break;
      if (widthOk(p, q) && endsOk(mode, q, currentRad)) best = { q, turnRad: 0 };
    }
    return best;
  };

  const ranges: CandidateRange[] = [];
  let p = 0;
  let currentRad = ends.arrivalHeadingRad;
  // The linear range that ends at `p`, when the last range placed is one.
  let before: PreviousLinear | null = null;
  while (p < lastIndex) {
    let mode: FitMode = "linear";
    let q: number | null = null;
    let turnRad = 0;
    let fitted = true;
    for (const option of FIT_ORDER) {
      const end = longest(option, p, currentRad, before);
      if (end !== null && (q === null || end.q > q)) {
        mode = option;
        q = end.q;
        turnRad = end.turnRad;
      }
    }
    if (q === null) {
      // No mode fits: drive linear to the nearest station a range may end on, toward its heading.
      for (let end = p + 1; end <= lastIndex && q === null; end += 1) if (widthOk(p, end)) q = end;
      q ??= lastIndex;
      const toward = angleDelta(currentRad, q === lastIndex ? endRad : (wanted[q] as number));
      turnRad = Math.max(-MAX_LINEAR_TURN_RAD, Math.min(MAX_LINEAR_TURN_RAD, toward));
      fitted = false;
    }
    if (q < lastIndex) {
      let snapped: number | null = null;
      for (const joint of joints) {
        const gap = Math.abs((units[joint] as number) - (units[q] as number));
        if (joint === q || joint <= p || gap > Math.round(JOINT_SNAP_T * 10000) || !widthOk(p, joint)) continue;
        const best = snapped === null ? Infinity : Math.abs((units[snapped] as number) - (units[q] as number));
        if (gap < best || (gap === best && joint < (snapped as number))) snapped = joint;
      }
      if (snapped !== null && mode === "linear") {
        const toward = angleDelta(currentRad, wanted[snapped] as number);
        const snappedTurn = linearTurn(p, snapped, currentRad);
        turnRad = snappedTurn ?? Math.max(-MAX_LINEAR_TURN_RAD, Math.min(MAX_LINEAR_TURN_RAD, toward));
        fitted = snappedTurn !== null;
      }
      if (snapped !== null) q = snapped;
    }
    if (!(options.allowRanges ?? true) && q !== lastIndex) {
      return measured(geometry, ends, stations, [{ mode: "linear", endT: 1 }]);
    }

    const endT = q === lastIndex ? 1 : (written[q] as number);
    if (mode === "linear") {
      const target = currentRad + turnRad;
      ranges.push(q === lastIndex ? { mode, endT } : { mode, endT, endHeadingRad: target });
      before = { p, startRad: currentRad, fitted };
      currentRad = target;
    } else {
      const previous = ranges[ranges.length - 1];
      if (before !== null && previous?.mode === "linear" && (mode === "tangent" || mode === "tangentReversed")) {
        // The linear range before ends on the tangent, as `rangesHeading` writes it, so it says so.
        previous.endHeadingRad = before.startRad + angleDelta(before.startRad, tangentStartRad(mode, p));
      }
      before = null;
      ranges.push({ mode, endT });
      // A tangent range ends on the tangent where its end is written; a constant one keeps holding.
      if (mode === "tangent") currentRad = tangentWritten[q] as number;
      if (mode === "tangentReversed") currentRad = wrapAngle((tangentWritten[q] as number) + Math.PI);
    }
    p = q;
  }
  return measured(geometry, ends, stations, mergeRepeats(ranges));
}

/**
 * How much of its turn a linear range from `startT` to `endT` has made at each t, as the runtime
 * evaluates it: the heading of a range turning from 0 to 1 rad, held at 0 before it and at 1 after
 * it. A linear range's heading is its start plus its turn times this share, whatever the
 * interpolation, so the fit reads the share from `headingFunction` and follows OPT-01's parametric
 * one on curves.
 */
function linearShare(geometry: PathGeometry, startT: number, endT: number): (t: number) => number {
  const turning: HeadingRange = { startT, endT, heading: { mode: "linear", fromRad: 0, toRad: 1 } };
  const ranges: HeadingRange[] = [
    ...(startT > 0 ? [{ startT: 0, endT: startT, heading: { mode: "constant" as const, headingRad: 0 } }] : []),
    turning,
    ...(endT < 1 ? [{ startT: endT, endT: 1, heading: { mode: "constant" as const, headingRad: 1 } }] : []),
  ];
  return headingFunction(ranges.length === 1 ? turning.heading : { mode: "piecewise", ranges }, geometry);
}

/** Joins neighbouring ranges of one tangent mode, or two constants, which hold the same heading. */
function mergeRepeats(ranges: readonly CandidateRange[]): CandidateRange[] {
  const merged: CandidateRange[] = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && previous.mode === range.mode && range.mode !== "linear") {
      merged[merged.length - 1] = { ...previous, endT: range.endT };
    } else {
      merged.push(range);
    }
  }
  return merged;
}

/** The ranges with how far, at worst, the heading `emitStep` writes for them strays from the stations. */
function measured(geometry: PathGeometry, ends: RouteEnds, stations: readonly FitStation[], ranges: CandidateRange[]): HeadingFit {
  const heading = rangesHeading(ranges, geometry, ends);
  if (typeof heading === "string") throw new Error(`The heading fit built ranges the emitter refuses: ${heading}`);
  const at = headingFunction(heading, geometry);
  let maxDeviationRad = 0;
  for (const station of stations) {
    maxDeviationRad = Math.max(maxDeviationRad, Math.abs(angleDelta(at(station.t), station.headingRad)));
  }
  return { ranges, maxDeviationRad };
}

/** The heading families of spec 16 section 6.2, in the order the search applies them. */
export type HeadingFamily = "default" | "dp" | "tangent" | "reversed" | "linear";

/** The person's default heading mode for new paths (D6, `editing.defaultHeading`). */
export type DefaultHeadingMode = "tangent" | "linear" | "constant";

/** D6's default when the person has not set one (SET BY HAND: owner ruling 2026-10-08, D6). */
export const DEFAULT_HEADING_MODE: DefaultHeadingMode = "linear";

export interface HeadingSeedOptions {
  /** H-default's mode; `DEFAULT_HEADING_MODE` when absent. It reaches core as an argument (D6). */
  defaultHeadingMode?: DefaultHeadingMode;
  /** False for one mode per seed (the card's "Allow heading ranges"). */
  allowRanges?: boolean;
  /**
   * H-turnfirst, a turn on the spot before driving, needs the D10 hold-turn step, which the
   * optimizer does not emit until that step and its ADR exist (spec 16 sections 3 and 11). The
   * option stays off until then, so only `false` is accepted.
   */
  allowTurnFirst?: false;
}

export interface HeadingSeed {
  family: HeadingFamily;
  ranges: CandidateRange[];
}

/** A turn's share of the route, in 1e-4 steps: the distance the robot covers turning it at its angular limit at cruise speed. */
function turnUnits(turnRad: number, lengthIn: number, limits: RobotLimits, speedFraction: number): number {
  const cruiseInPerS = speedFraction * limits.maxForwardVelInPerS;
  const distanceIn = (Math.abs(turnRad) / limits.maxAngularVelRadPerS) * cruiseInPerS;
  return Math.max(MIN_RANGE_UNITS, Math.ceil((distanceIn / lengthIn) * 10000));
}

/**
 * H-tan (or H-rev, `reversed`): the tangent mode, with a linear range at the start only where the
 * arrival heading is not along the tangent, and one at the end only where E's heading is not. Each
 * linear range is as long as the robot drives at cruise speed (`speedFraction` of the forward
 * limit) while it turns that far at its angular limit, and never narrower than `MIN_RANGE_T`. Null
 * when the turns leave no room for a tangent range between them, or, with ranges not allowed, when
 * a turn is needed.
 */
export function tangentFamily(
  geometry: PathGeometry,
  ends: RouteEnds,
  limits: RobotLimits,
  speedFraction: number,
  reversed: boolean,
  allowRanges = true,
): CandidateRange[] | null {
  const offset = reversed ? Math.PI : 0;
  const startTurn = angleDelta(ends.arrivalHeadingRad, wrapAngle(tangentHeading(geometry, 0) + offset));
  const endTurn = angleDelta(wrapAngle(tangentHeading(geometry, 1) + offset), ends.endHeadingRad);
  const mode = reversed ? "tangentReversed" : "tangent";
  const startUnits = Math.abs(startTurn) > END_HEADING_TOLERANCE_RAD ? turnUnits(startTurn, geometry.lengthIn, limits, speedFraction) : 0;
  const endUnits = Math.abs(endTurn) > END_HEADING_TOLERANCE_RAD ? turnUnits(endTurn, geometry.lengthIn, limits, speedFraction) : 0;
  if (startUnits === 0 && endUnits === 0) return [{ mode, endT: 1 }];
  if (!allowRanges || 10000 - startUnits - endUnits < MIN_RANGE_UNITS) return null;
  return [
    ...(startUnits > 0 ? [{ mode: "linear" as const, endT: startUnits / 10000 }] : []),
    { mode, endT: endUnits > 0 ? (10000 - endUnits) / 10000 : 1 },
    ...(endUnits > 0 ? [{ mode: "linear" as const, endT: 1 }] : []),
  ];
}

/** H-lin: one linear range from the arrival heading to E's, the short way. */
export const linearFamily = (): CandidateRange[] => [{ mode: "linear", endT: 1 }];

/**
 * The constant mode fitted to S and E: the arrival heading held, then a linear range at the end
 * into E's heading, sized as `tangentFamily` sizes its turns, only where E faces another way. Null
 * when that turn leaves no room for the constant range, or, with ranges not allowed, when a turn is
 * needed.
 */
export function constantFamily(
  geometry: PathGeometry,
  ends: RouteEnds,
  limits: RobotLimits,
  speedFraction: number,
  allowRanges = true,
): CandidateRange[] | null {
  const turn = angleDelta(ends.arrivalHeadingRad, ends.endHeadingRad);
  if (Math.abs(turn) <= END_HEADING_TOLERANCE_RAD) return [{ mode: "constant", endT: 1 }];
  const endUnits = turnUnits(turn, geometry.lengthIn, limits, speedFraction);
  if (!allowRanges || 10000 - endUnits < MIN_RANGE_UNITS) return null;
  return [
    { mode: "constant", endT: (10000 - endUnits) / 10000 },
    { mode: "linear", endT: 1 },
  ];
}

/**
 * The heading seeds for one route, in the order of spec 16 section 6.2:
 *
 * 1. H-default, the person's D6 mode fitted to S and E: Tangent as H-tan, Linear as H-lin, and
 *    Constant as `constantFamily`.
 * 2. H-dp, the dynamic program's answer fitted to Pedro modes. It is left out when the program
 *    finds no heading sequence that clears.
 * 3. H-tan, 4. H-rev and 5. H-lin.
 *
 * H-turnfirst is not built: it waits for the D10 step (`HeadingSeedOptions.allowTurnFirst`). A
 * family that cannot be built on this route is left out, and so is one whose ranges repeat an
 * earlier seed's, so the search never scores one heading twice. A step whose heading faces a point
 * keeps it (spec 16 section 3), so the search does not ask for these seeds for one.
 */
export function headingSeeds(input: HeadingDpInput, options: HeadingSeedOptions = {}): HeadingSeed[] {
  const { geometry, ends, speedFraction } = input;
  const limits = robotLimits(input.robot);
  const allowRanges = options.allowRanges ?? true;
  const tangent = tangentFamily(geometry, ends, limits, speedFraction, false, allowRanges);
  const reversed = tangentFamily(geometry, ends, limits, speedFraction, true, allowRanges);
  const linear = linearFamily();
  const mode = options.defaultHeadingMode ?? DEFAULT_HEADING_MODE;
  const fallback =
    mode === "tangent" ? tangent : mode === "constant" ? constantFamily(geometry, ends, limits, speedFraction, allowRanges) : linear;
  const dp = headingDp(input);
  const candidates: [HeadingFamily, CandidateRange[] | null][] = [
    ["default", fallback],
    ["dp", dp.ok ? fitPedroModes(geometry, ends, dp.stations, { allowRanges }).ranges : null],
    ["tangent", tangent],
    ["reversed", reversed],
    ["linear", linear],
  ];
  const seeds: HeadingSeed[] = [];
  const seen = new Set<string>();
  for (const [family, ranges] of candidates) {
    if (ranges === null) continue;
    const key = JSON.stringify(ranges);
    if (seen.has(key)) continue;
    seen.add(key);
    seeds.push({ family, ranges });
  }
  return seeds;
}
