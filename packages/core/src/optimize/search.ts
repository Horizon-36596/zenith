import { SchemaError, type Field, type Heading, type PathStep, type Robot } from "@horizon36596/zenith-schema";
import type { RunningFrom } from "../checks/intake.js";
import type { PathGeometry } from "../geometry/path.js";
import { robotLimits } from "../kinematics.js";
import type { ResolvedStep } from "../resolve.js";
import { DEFAULT_TICK_S } from "../sim/params.js";
import {
  canonicalPathStep,
  emitStep,
  headingProblem,
  rangesHeading,
  stepGeometry,
  type CandidateHeading,
  type CandidateRange,
  type EmitResult,
  type RouteCandidate,
  type RouteEnds,
} from "./candidate.js";
import { MAX_ALTERNATIVES, type AcceptedRoute, type FinalVerdict } from "./final.js";
import { constantFamily, headingSeeds, linearFamily, tangentFamily, type DefaultHeadingMode } from "./headingDp.js";
import { holdsActive, NO_HOLDS, stepHoldProblem, withHolds, type HeadingHolds } from "./holds.js";
import { structuralMoves, type MoveBase, type StructuralMove, type StructuralMoveKind } from "./moves.js";
import { PENALTY_WEIGHT_S, rerankFinalists, TIME_EPSILON_S, type Evaluation, type Objective } from "./objective.js";
import { candidateFromSeed, geometrySeeds, originalGeometry, type GeometrySeed } from "./seeds.js";
import type { RouteGeometry } from "./smooth.js";
import type { OptimizeCommand, OptimizeMode, OptimizePhase, OptimizeProgress, OptimizeResult } from "./types.js";

/**
 * The optimizer's search (issue #302): the seeds in their fixed order, ranked by the estimate plus the
 * penalties; the best three started as local searches, each a compass pattern search (Hooke-Jeeves)
 * over the candidate's parameters in a fixed order and each at twice the penalty weight of the one
 * before; one last pass at the highest weight from the best of them; and the ranking of everything it
 * scored, with the tie rules, for the hard final check.
 *
 * It is a generator, so a host can drive it in slices: it yields progress after every
 * `batchSize` evaluations and takes `{ stop: true }` or `{ snapshot: true }` back. The budget is a count of evaluations,
 * never a time, and nothing the search decides depends on the budget except where it stops, so a
 * run the host stops after N evaluations has found exactly what a run with a budget of N finds.
 *
 * - **Passes in turn.** The passes take one sweep each in turn, rather than each a fixed share of
 *   the budget, so no start's share depends on the budget. When every pass is done, the last pass
 *   runs from the best of them. A budget that runs out ends the search where it is: that is the
 *   normal end of a long search, and the result is built from what it found. Only the host's stop
 *   makes a result `stoppedEarly`.
 *
 * - **Evaluations.** Each candidate the objective scores counts once: a seed by the estimate, a
 *   point of a pass by the search's scorer. A candidate whose bytes were scored before is answered
 *   from memory and not counted, and one `emitStep` refuses is not scored at all.
 * - **Structural moves** (`moves.ts`, issue #307). Where a pass stalls, its structural moves are
 *   tried in their fixed order: split a path, merge two, change a path's degree, split a heading
 *   range, merge two, change a range's mode. Each move is followed by a continuous pass of its own,
 *   from `MOVE_STEP_FRACTION` of the initial steps, and the pass keeps the point that one stalls at
 *   only when its J is strictly lower; a kept move starts the moves again from there, and the pass
 *   is done when no move is left to try. A split, and a step up in degree, change nothing until
 *   that pass moves something (D3), so a move is judged after its pass and never alone.
 *   The moves come after every continuous pass, the last one included, so a budget that runs out
 *   among them leaves the search with at least what it finds without them: first where the last
 *   pass stalled, then where each other start did. No move gives a route more paths than
 *   `maxPaths`.
 * - **The modes.** `routeAndHeading` searches the geometry seeds with every heading family;
 *   `routeOnly` keeps the original's heading as written on every seed; `headingOnly` keeps the
 *   original's segments as written and searches the heading families over them.
 *
 * Pure (CLAUDE.md rule 1): no clock, no randomness. The same inputs give the same sequence of
 * evaluations.
 */

/** The most paths a route may have (SET BY HAND: spec 16 section 3). */
export const DEFAULT_MAX_PATHS = 4;

/** How many of the best seeds start a local search (SET BY HAND: spec 16 section 6.2). */
export const START_COUNT = 3;

/** The initial step of a length parameter is the S to E distance over this (SET BY HAND: spec 16 section 6.3). */
export const LENGTH_STEP_DIVISOR = 8;

/** The initial step of an angle parameter, in radians (SET BY HAND: spec 16 section 6.3). */
export const ANGLE_STEP_RAD = Math.PI / 8;

/**
 * The initial step of a range end, as a fraction of the path (SET BY HAND: the "over 8" rule spec 16
 * section 6.3 gives lengths, applied to the whole path's t of 1).
 */
export const RANGE_STEP_T = 1 / 8;

/** A length step below this, in inches, is done (SPEC: canonical inch resolution, spec 16 section 6.3). */
export const MIN_LENGTH_STEP_IN = 0.001;

/** An angle step below this, in radians, is done (SPEC: canonical radian resolution, spec 16 section 6.3). */
export const MIN_ANGLE_STEP_RAD = 1e-4;

/** A range-end step below this is done (SPEC: range ends are written on four decimals, `roundRangeT`). */
export const MIN_RANGE_STEP_T = 1e-4;

/**
 * The continuous pass that follows a structural move starts at this fraction of the initial steps
 * (SET BY HAND: a move lands beside the point the pass stalled at, so its pass needs no
 * field-sized first steps).
 */
export const MOVE_STEP_FRACTION = 1 / 4;

/** Candidates within one sim tick of the best are tied (CARRIED OVER: `DEFAULT_TICK_S`, spec 16 section 6.3). */
export const TIE_S = DEFAULT_TICK_S;

/**
 * Evaluations between two progress reports when the caller names none (SET BY HAND: about 65 ms
 * of scoring at the bench's 2.62 ms per evaluation, so Stop gets in, and a page that runs the
 * search itself redraws, between two batches).
 */
export const DEFAULT_BATCH_SIZE = 25;

/** The penalty weight of start `index`: the base weight, doubled for each start before it (spec 16 section 6.3). */
export const startWeightS = (index: number): number => PENALTY_WEIGHT_S * 2 ** index;

/** What the search needs, all of it worked out once by `optimizeRoute`. */
export interface SearchContext {
  objective: Objective;
  /** The path step as `resolve` resolved it in the canonical auto. */
  resolved: ResolvedStep;
  /** The original step, as the canonical auto holds it. */
  original: PathStep;
  /** The original's geometry, which `headingOnly` keeps. */
  originalGeometry: PathGeometry;
  ends: RouteEnds;
  robot: Robot;
  field: Field;
  /** The mouths running over the step, for the heading program. */
  running: RunningFrom | undefined;
  speedFraction: number;
  mode: OptimizeMode;
  maxPaths: number;
  allowRanges: boolean;
  defaultHeadingMode: DefaultHeadingMode;
  /**
   * The heading holds the person asked for (issue #448): every heading seed has them written in, and
   * the emitter refuses any route that breaks them, so no such route is scored. None when absent.
   */
  holds?: HeadingHolds;
  budget: number;
  batchSize: number;
  /**
   * True when the original is blocked, `check()` finding it going through something (issue #388), so the
   * visibility seeds may be smoothed at the fallback allowances (`SeedInput.fallbackAllowances`).
   * Default false.
   */
  originalBlocked?: boolean;
  /**
   * Builds the result a stop right now would return, from the outcome so far. The search calls it
   * when the host sends `{ snapshot: true }`; `optimizeRoute` passes the same function it builds its
   * own result with. Without it, a snapshot is not answered.
   */
  snapshot?: (outcome: SearchOutcome) => OptimizeResult;
}

/** One candidate the search scored, with what the ranking and the card need. */
export interface SearchEntry {
  /** The route as it is saved. */
  step: PathStep;
  /** Its bytes, the key it is remembered by. */
  key: string;
  /** Its evaluation by the search's scorer. */
  evaluation: Evaluation;
  /** The order it was first scored in: the "lower candidate index" of the tie rules. */
  index: number;
  /** The start (0, 1 or 2) whose pass scored it first; -1 for a seed only the estimate scored. */
  lineage: number;
  /** True for the original step itself, candidate 0. */
  original: boolean;
}

export interface SearchOutcome {
  /** Everything the search's scorer scored, ranked best first by J at the highest weight, with the tie rules. */
  ranked: SearchEntry[];
  /** Every seed's evaluation by the estimate, in seed order. */
  seeds: SearchEntry[];
  evaluations: number;
  /** True when the host stopped the search. */
  stopped: boolean;
  /** True when the budget ran out before every pass was done. */
  exhausted: boolean;
  /** The highest penalty weight the search used, in seconds per unit. */
  weightS: number;
  /** Every structural move a pass kept, in the order they were kept. */
  keptMoves: KeptMove[];
}

/** Thrown inside the search when it must stop: the budget is spent, or the host asked. */
class StopSearch extends Error {
  constructor(readonly by: "budget" | "host") {
    super("The search stopped.");
  }
}

/** The units of penalty in an evaluation, before the weight. */
const penaltyUnits = (evaluation: Evaluation): number => {
  const parts = evaluation.penalty;
  return parts.clearance + parts.simClearance + parts.mouthLeading + parts.sweepSpeed;
};

/** J of an evaluation at another penalty weight: the same time and barrier, the penalty reweighed. */
export function jAtWeight(evaluation: Evaluation, weightS: number): number {
  if (!Number.isFinite(evaluation.j)) return evaluation.j;
  return evaluation.j - evaluation.penalty.totalS + weightS * penaltyUnits(evaluation);
}

/** The part of J that is time, the barrier included: J at a weight of 0. */
export const timeOf = (evaluation: Evaluation): number => jAtWeight(evaluation, 0);

/** How a route ranks among tied ones (spec 16 section 6.3): fewer paths, fewer ranges, lower degree, the D6 mode, the lower index. */
function tieKey(entry: SearchEntry, defaultMode: DefaultHeadingMode): number[] {
  const segments = entry.step.segments;
  const heading = entry.step.heading;
  const ranges = heading?.mode === "piecewise" ? heading.ranges.length : 1;
  const degree = segments.reduce((sum, segment) => sum + (segment.kind === "bezier" ? segment.control.length + 1 : 1), 0);
  const notDefault = heading?.mode === defaultMode ? 0 : 1;
  return [segments.length, ranges, degree, notDefault, entry.index];
}

const compareKeys = (a: readonly number[], b: readonly number[]): number => {
  for (let k = 0; k < a.length; k += 1) {
    const difference = (a[k] as number) - (b[k] as number);
    if (difference !== 0) return difference;
  }
  return 0;
};

/**
 * Entries best first by `jOf`, with the tie rules: the best J and every entry within one sim tick
 * of it are tied and ordered by the tie key; then the same again for what is left.
 */
export function rankEntries(
  entries: readonly SearchEntry[],
  jOf: (entry: SearchEntry) => number,
  defaultMode: DefaultHeadingMode,
): SearchEntry[] {
  let remaining = [...entries].sort((a, b) => jOf(a) - jOf(b) || a.index - b.index);
  const out: SearchEntry[] = [];
  while (remaining.length > 0) {
    const best = jOf(remaining[0] as SearchEntry);
    const tied = Number.isFinite(best) ? remaining.filter((entry) => jOf(entry) - best < TIE_S - TIME_EPSILON_S) : remaining;
    tied.sort((a, b) => compareKeys(tieKey(a, defaultMode), tieKey(b, defaultMode)));
    out.push(...tied);
    const taken = new Set(tied);
    remaining = remaining.filter((entry) => !taken.has(entry));
  }
  return out;
}

/**
 * The routes for the final check in finalist mode (spec 16 section 5.2): the best few by the
 * estimate, re-ranked by the instant sim, come first, then every other route in the order given.
 * Outside finalist mode the order is kept as it is.
 */
export function finalistOrder(objective: Objective, eligible: readonly SearchEntry[]): SearchEntry[] {
  if (!objective.finalist || eligible.length === 0) return [...eligible];
  const byKey = new Map(eligible.map((entry) => [entry.key, entry]));
  const reranked = rerankFinalists(objective, eligible.map((entry) => ({ step: entry.step, evaluation: entry.evaluation })));
  const first = reranked.map((candidate) => {
    const entry = byKey.get(JSON.stringify(candidate.step));
    if (entry === undefined) throw new Error("A re-ranked finalist is not one of the routes it was given.");
    return entry;
  });
  const firstKeys = new Set(first.map((entry) => entry.key));
  return [...first, ...eligible.filter((entry) => !firstKeys.has(entry.key))];
}

/**
 * Runs the final check on `eligible`, best first, and keeps at most one plain route and one gated
 * route (`fasterInSimOnly`) per start. It stops after `limit` checks, or once it has more plain
 * routes than `MAX_ALTERNATIVES`.
 *
 * A pass that ends against an obstacle leaves many routes a hair apart, all as fast and all refused
 * for the same shortfall. Once one is refused, the others of its start with as many paths, within
 * one sim tick of it, are passed over, so they do not use up the limit. A route of another number
 * of paths, which a structural move gives the same start, is another shape and is still checked.
 */
export function checkFinalists(
  eligible: readonly SearchEntry[],
  verify: (step: PathStep) => FinalVerdict,
  limit: number,
): { accepted: AcceptedRoute[]; verified: number } {
  const accepted: AcceptedRoute[] = [];
  const plainLineages = new Set<number>();
  const gatedLineages = new Set<number>();
  const refused: SearchEntry[] = [];
  let verified = 0;
  for (const entry of eligible) {
    if (verified >= limit || accepted.filter((route) => !route.fasterInSimOnly).length > MAX_ALTERNATIVES) break;
    if (plainLineages.has(entry.lineage)) continue;
    const time = timeOf(entry.evaluation);
    const paths = entry.step.segments.length;
    const nearRefused = refused.some(
      (other) =>
        other.lineage === entry.lineage &&
        other.step.segments.length === paths &&
        Math.abs(timeOf(other.evaluation) - time) < TIE_S - TIME_EPSILON_S,
    );
    if (nearRefused) continue;
    verified += 1;
    const verdict = verify(entry.step);
    if (!verdict.ok) {
      refused.push(entry);
      continue;
    }
    const route = verdict.accepted;
    if (route.fasterInSimOnly) {
      if (gatedLineages.has(entry.lineage)) continue;
      gatedLineages.add(entry.lineage);
    } else {
      plainLineages.add(entry.lineage);
    }
    accepted.push(route);
  }
  return { accepted, verified };
}

/** The kind of a parameter, which sets its initial step and the step it is done at. */
type ParameterKind = "length" | "angle" | "t";

interface Parameter {
  kind: ParameterKind;
  read(candidate: RouteCandidate): number;
  write(candidate: RouteCandidate, value: number): RouteCandidate;
}

const replaceAt = <T>(items: readonly T[], index: number, item: T): T[] => items.map((old, k) => (k === index ? item : old));

/**
 * The parameters of a candidate, in the order of spec 16 section 6.3: joint x and joint y (joint by
 * joint), the joint tangents (every node a curve reads one at, ends included), the handle lengths
 * (and a quartic's middle control), the heading knots (a linear range's free end heading), and the
 * range ends. `headingOnly` has only the last two, `routeOnly` only the first three.
 */
function parametersOf(candidate: RouteCandidate, mode: OptimizeMode): Parameter[] {
  const parameters: Parameter[] = [];
  if (mode !== "headingOnly") {
    candidate.jointsIn.forEach((_, j) => {
      for (const axis of ["xIn", "yIn"] as const) {
        parameters.push({
          kind: "length",
          read: (c) => (c.jointsIn[j] as { xIn: number; yIn: number })[axis],
          write: (c, value) => ({ ...c, jointsIn: replaceAt(c.jointsIn, j, { ...(c.jointsIn[j] as { xIn: number; yIn: number }), [axis]: value }) }),
        });
      }
    });
    candidate.tangentsRad.forEach((_, node) => {
      const incoming = node > 0 ? candidate.paths[node - 1] : undefined;
      const outgoing = candidate.paths[node];
      if (incoming?.kind === "line" || outgoing?.kind === "line") return;
      parameters.push({
        kind: "angle",
        read: (c) => c.tangentsRad[node] as number,
        write: (c, value) => ({ ...c, tangentsRad: replaceAt(c.tangentsRad, node, value) }),
      });
    });
    candidate.paths.forEach((path, k) => {
      if (path.kind !== "cubic" && path.kind !== "quartic") return;
      for (const handle of ["startHandleIn", "endHandleIn"] as const) {
        parameters.push({
          kind: "length",
          read: (c) => {
            const p = c.paths[k];
            return p !== undefined && (p.kind === "cubic" || p.kind === "quartic") ? p[handle] : 0;
          },
          write: (c, value) => {
            const p = c.paths[k];
            if (p === undefined || (p.kind !== "cubic" && p.kind !== "quartic")) return c;
            return { ...c, paths: replaceAt(c.paths, k, { ...p, [handle]: value }) };
          },
        });
      }
      if (path.kind === "quartic") {
        for (const axis of ["xIn", "yIn"] as const) {
          parameters.push({
            kind: "length",
            read: (c) => {
              const p = c.paths[k];
              return p?.kind === "quartic" ? p.middleIn[axis] : 0;
            },
            write: (c, value) => {
              const p = c.paths[k];
              if (p?.kind !== "quartic") return c;
              return { ...c, paths: replaceAt(c.paths, k, { ...p, middleIn: { ...p.middleIn, [axis]: value } }) };
            },
          });
        }
      }
    });
  }
  if (mode !== "routeOnly" && candidate.heading.mode === "ranges") {
    const ranges = candidate.heading.ranges;
    const withRange = (c: RouteCandidate, r: number, range: CandidateRange): RouteCandidate =>
      c.heading.mode === "ranges" ? { ...c, heading: { mode: "ranges", ranges: replaceAt(c.heading.ranges, r, range) } } : c;
    const rangeOf = (c: RouteCandidate, r: number): CandidateRange | undefined =>
      c.heading.mode === "ranges" ? c.heading.ranges[r] : undefined;
    ranges.forEach((range, r) => {
      const next = ranges[r + 1];
      if (range.mode !== "linear" || next === undefined || (next.mode !== "linear" && next.mode !== "constant")) return;
      if (range.endHeadingRad === undefined) return;
      parameters.push({
        kind: "angle",
        read: (c) => {
          const found = rangeOf(c, r);
          return found?.mode === "linear" ? (found.endHeadingRad ?? 0) : 0;
        },
        write: (c, value) => {
          const found = rangeOf(c, r);
          return found?.mode === "linear" ? withRange(c, r, { ...found, endHeadingRad: value }) : c;
        },
      });
    });
    ranges.forEach((_, r) => {
      if (r === ranges.length - 1) return;
      parameters.push({
        kind: "t",
        read: (c) => rangeOf(c, r)?.endT ?? 0,
        write: (c, value) => {
          const found = rangeOf(c, r);
          return found === undefined ? c : withRange(c, r, { ...found, endT: value });
        },
      });
    });
  }
  return parameters;
}

const MIN_STEP: Record<ParameterKind, number> = { length: MIN_LENGTH_STEP_IN, angle: MIN_ANGLE_STEP_RAD, t: MIN_RANGE_STEP_T };

/** A point of a pass: a candidate (null when it has no parameters of its own) and the scored route. */
interface Point {
  candidate: RouteCandidate | null;
  entry: SearchEntry;
}

/** A continuous pass's own state: where it is, what it moves, and how far. */
interface Polish {
  x: Point;
  parameters: Parameter[];
  steps: number[];
}

/**
 * One local search's state (spec 16 section 6.3): its continuous pass and, once that stalls, the
 * structural moves of the point it stalled at, each followed by a continuous pass of its own.
 */
interface Pass {
  lineage: number;
  weightS: number;
  /** The pass's own continuous pass; its `x` is the pass's best point. */
  main: Polish;
  /** The structural moves still to try at `main.x`, in order; null until `main` stalls there. */
  moves: StructuralMove[] | null;
  /** The continuous pass that follows a structural move, and the move; null between trials. */
  trial: { polish: Polish; move: StructuralMove } | null;
  done: boolean;
}

/**
 * True when a structural move is kept: the continuous pass after it stalled strictly lower in J
 * than the pass before it did (spec 16 section 6.3). A tie is not kept, so a move that changes
 * nothing, such as an exact step up in degree, never replaces the route it came from.
 */
export const keepsStructuralMove = (beforeJ: number, afterJ: number): boolean => afterJ < beforeJ;

/** A structural move the search kept. */
export interface KeptMove {
  /** The start whose pass kept it, or whose point the last pass started from. */
  lineage: number;
  kind: StructuralMoveKind;
  index: number;
  to: string | null;
  /** J where the pass stalled before the move, and where the pass that followed it stalled, at the pass's weight. */
  beforeJ: number;
  afterJ: number;
  /** The route the pass that followed the move stalled at, which the pass kept as its point. */
  step: PathStep;
}

/** The heading `headingOnly` writes over the original's own segments, in canonical form. */
function emitHeadingOnly(heading: CandidateHeading, original: PathStep, geometry: PathGeometry, ends: RouteEnds): EmitResult {
  if (heading.mode !== "ranges") return { ok: true, step: canonicalPathStep(original) };
  const built = rangesHeading(heading.ranges, geometry, ends);
  if (typeof built === "string") return { ok: false, reason: built };
  let step: PathStep;
  try {
    step = canonicalPathStep({ ...original, heading: built });
  } catch (error) {
    if (error instanceof SchemaError) return { ok: false, reason: error.message };
    throw error;
  }
  const problem = headingProblem(step.heading as Heading, geometry, ends);
  return problem === null ? { ok: true, step } : { ok: false, reason: problem };
}

/** A seed of the search: the candidate it starts from, or none when it is the original as written. */
interface Seed {
  candidate: RouteCandidate | null;
  step: PathStep;
  /**
   * False for a seed no pass may start from: an original with more paths than `maxPaths` allows, or
   * a piecewise heading when ranges are not allowed. It is still scored, as candidate 0 for the
   * original, but a pass keeps its start's paths and heading mode and so could only return routes
   * the options forbid.
   */
  startable: boolean;
  /**
   * True for the one seed that always takes a start when heading holds are on (issue #448): the
   * original's own geometry with its own heading mode and the holds written in, the nearest route to
   * the original that keeps them. The original itself may break them, so it is no baseline then.
   */
  pinned?: boolean;
}

/**
 * False for a route with piecewise heading ranges when ranges are not allowed (the card's "Allow
 * heading ranges" off): such a route is never searched from and never returned. A piecewise
 * original, or `routeOnly` keeping it as written, is the only way one reaches the search then.
 */
export const headingAllowed = (step: PathStep, allowRanges: boolean): boolean =>
  allowRanges || step.heading?.mode !== "piecewise";

/** The heading candidates of one geometry seed, in the order of spec 16 section 6.2. */
function headingsFor(context: SearchContext, geometry: PathGeometry | null): CandidateHeading[] {
  if (context.original.heading?.mode === "facePoint") return [{ mode: "facePoint" }];
  if (context.mode === "routeOnly") return [{ mode: "asWritten" }];
  if (geometry === null) return [];
  const { objective, ends, robot, running, speedFraction, allowRanges, defaultHeadingMode } = context;
  const holds = context.holds ?? NO_HOLDS;
  const out: CandidateHeading[] = [];
  const seen = new Set<string>();
  for (const seed of headingSeeds(
    {
      geometry,
      ends,
      robot,
      world: objective.world,
      marginIn: objective.marginIn,
      speedFraction,
      ...(running === undefined ? {} : { running }),
    },
    { allowRanges, defaultHeadingMode },
  )) {
    // The holds are written into every seed (issue #448); a seed they leave no room for is dropped.
    const ranges = withHolds(seed.ranges, geometry, ends, holds);
    if (ranges === null) continue;
    const key = JSON.stringify(ranges);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ mode: "ranges", ranges });
  }
  return out;
}

/**
 * The original's own heading mode, as one of the heading families over its own geometry, with the
 * holds written in: Tangent and Reversed tangent as H-tan and H-rev, Constant as the constant
 * family, and any other mode as H-lin. Null when the holds leave no room for it.
 */
function heldOriginalRanges(context: SearchContext): CandidateRange[] | null {
  const { original, ends, originalGeometry: geometry, speedFraction, allowRanges } = context;
  const limits = robotLimits(context.robot);
  const mode = original.heading?.mode;
  const family =
    mode === "tangent" || mode === "tangentReversed"
      ? tangentFamily(geometry, ends, limits, speedFraction, mode === "tangentReversed", allowRanges)
      : mode === "constant"
        ? constantFamily(geometry, ends, limits, speedFraction, allowRanges)
        : linearFamily();
  return family === null ? null : withHolds(family, geometry, ends, context.holds ?? NO_HOLDS);
}

/** The probe heading a geometry is emitted with, to read its geometry: the one every seed accepts. */
const probeHeading = (original: PathStep): CandidateHeading =>
  original.heading?.mode === "facePoint" ? { mode: "facePoint" } : { mode: "ranges", ranges: [{ mode: "linear", endT: 1 }] };

/** A stand-in geometry for `headingOnly`, which never reads or moves it. */
const FIXED_GEOMETRY: RouteGeometry = { jointsIn: [], tangentsRad: [0, 0], paths: [{ kind: "line" }] };

/** Every seed, in the fixed order of spec 16 section 6.2, with candidate 0 the original as written. */
function buildSeeds(context: SearchContext): Seed[] {
  const { original, ends, mode } = context;
  const emit = emitterFor(context);
  const seeds: Seed[] = [];
  const keys = new Set<string>();
  const offer = (candidate: RouteCandidate | null, step: PathStep, startable = true, pinned = false): void => {
    const key = JSON.stringify(step);
    if (keys.has(key)) return;
    keys.add(key);
    const allowed = startable && headingAllowed(step, context.allowRanges);
    seeds.push({ candidate, step, startable: allowed, ...(pinned && allowed ? { pinned: true } : {}) });
  };

  // G0 as written: candidate 0, so the result is never slower than doing nothing. An original with
  // more paths than `maxPaths` is still scored, but no pass starts from it, since a pass keeps its
  // start's number of paths and so could only return routes the limit forbids (spec 16 section 3).
  // `headingOnly` keeps the segments as written, so the limit does not apply to it.
  const own = originalGeometry(context.resolved, Number.MAX_SAFE_INTEGER);
  const asWritten: RouteCandidate | null =
    mode === "headingOnly" || typeof own === "string" ? null : { ends, ...own, heading: { mode: "asWritten" } };
  const ownFits = mode === "headingOnly" || typeof own === "string" || own.paths.length <= context.maxPaths;
  // An original that breaks a heading hold is scored as candidate 0, but no pass starts from it.
  const ownHolds = stepHoldProblem(canonicalPathStep(original), ends, context.holds ?? NO_HOLDS) === null;
  offer(asWritten !== null && emit(asWritten).ok ? asWritten : null, canonicalPathStep(original), ownFits && ownHolds);

  // With heading holds on, the original's own geometry with its own heading mode and the holds
  // written in always takes a start (issue #448). The seeds are ranked by the estimate, which can
  // disagree with the instant sim about a heading family; without this start, the family nearest the
  // original, which the original itself shows to be a route the robot drives, might never be searched.
  const holds = context.holds ?? NO_HOLDS;
  if (holdsActive(holds) && mode !== "routeOnly" && original.heading?.mode !== "facePoint" && (mode === "headingOnly" || ownFits)) {
    const ranges = heldOriginalRanges(context);
    const geometry: RouteGeometry | null = mode === "headingOnly" ? FIXED_GEOMETRY : typeof own === "string" ? null : own;
    if (ranges !== null && geometry !== null) {
      const candidate: RouteCandidate = { ends, ...geometry, heading: { mode: "ranges", ranges } };
      const emitted = emit(candidate);
      if (emitted.ok) offer(candidate, emitted.step, true, true);
    }
  }

  if (mode === "headingOnly") {
    for (const heading of headingsFor(context, context.originalGeometry)) {
      const candidate: RouteCandidate = { ends, ...FIXED_GEOMETRY, heading };
      const emitted = emit(candidate);
      if (emitted.ok) offer(candidate, emitted.step);
    }
    return seeds;
  }

  const geometry: GeometrySeed[] = geometrySeeds({
    resolved: context.resolved,
    robot: context.robot,
    field: context.field,
    marginIn: context.objective.marginIn,
    maxPaths: context.maxPaths,
    world: context.objective.world,
    ...(context.originalBlocked === true ? { fallbackAllowances: true } : {}),
  }).seeds;
  for (const seed of geometry) {
    const probe = emitStep(candidateFromSeed(seed, ends, probeHeading(original)), original);
    const shape = probe.ok ? stepGeometry(probe.step, ends) : null;
    for (const heading of headingsFor(context, typeof shape === "string" ? null : shape)) {
      const candidate = candidateFromSeed(seed, ends, heading);
      const emitted = emit(candidate);
      if (emitted.ok) offer(candidate, emitted.step);
    }
  }
  return seeds;
}

/** How a candidate becomes a step in this run's mode. */
function emitterFor(context: SearchContext): (candidate: RouteCandidate) => EmitResult {
  const { original, ends, mode, originalGeometry: geometry } = context;
  const emit =
    mode === "headingOnly"
      ? (candidate: RouteCandidate) => emitHeadingOnly(candidate.heading, original, geometry, ends)
      : (candidate: RouteCandidate) => emitStep(candidate, original);
  const holds = context.holds ?? NO_HOLDS;
  if (!holdsActive(holds)) return emit;
  // A route that breaks a heading hold is refused here, so it is never scored (issue #448).
  return (candidate) => {
    const emitted = emit(candidate);
    if (!emitted.ok) return emitted;
    const problem = stepHoldProblem(emitted.step, ends, holds);
    return problem === null ? emitted : { ok: false, reason: problem };
  };
}

/**
 * The search: seeds ranked by the estimate plus the penalties, the best `START_COUNT` started as
 * passes at doubling weights, run a sweep at a time in turn until each is done, then one last pass
 * at the highest weight from the best of them.
 */
export function* searchRoutes(context: SearchContext): Generator<OptimizeProgress, SearchOutcome, OptimizeCommand | undefined> {
  const { objective, budget, batchSize, defaultHeadingMode, mode } = context;
  const emit = emitterFor(context);
  const originalKey = JSON.stringify(canonicalPathStep(context.original));
  const lengthStepIn = Math.hypot(context.ends.endIn.xIn - context.ends.startIn.xIn, context.ends.endIn.yIn - context.ends.startIn.yIn) / LENGTH_STEP_DIVISOR;
  const initialStep: Record<ParameterKind, number> = { length: lengthStepIn, angle: ANGLE_STEP_RAD, t: RANGE_STEP_T };

  let evaluations = 0;
  let order = 0;
  let phase: OptimizePhase = "seeds";
  let weightS = startWeightS(0);
  const estimated = new Map<string, SearchEntry>();
  const scored = new Map<string, SearchEntry>();
  const seedEntries: SearchEntry[] = [];
  let best: SearchEntry | null = null;

  const progress = (): OptimizeProgress => ({
    evaluations,
    budget,
    bestJ: best === null ? null : jAtWeight(best.evaluation, weightS),
    ...(best === null ? {} : { bestStep: best.step }),
    phase,
  });

  const keptMoves: KeptMove[] = [];

  /** Everything scored so far, ranked, as the outcome would be if the search ended here. */
  const outcomeOf = (stopped: boolean, exhausted: boolean): SearchOutcome => ({
    ranked: rankEntries([...scored.values()], (entry) => jAtWeight(entry.evaluation, weightS), defaultHeadingMode),
    seeds: [...seedEntries],
    evaluations,
    stopped,
    exhausted,
    weightS,
    keptMoves: [...keptMoves],
  });

  /**
   * Scores a step once, counting it, and reports after every batch. Throws `StopSearch` when it must
   * stop. `recorded` hears the entry as soon as it is scored, before the report: a stop the host
   * sends at that report must keep it, as a budget that ends there does.
   */
  function* score(
    memory: Map<string, SearchEntry>,
    step: PathStep,
    lineage: number,
    scoreWith: "estimate" | undefined,
    recorded?: (entry: SearchEntry) => void,
  ): Generator<OptimizeProgress, SearchEntry, OptimizeCommand | undefined> {
    const key = JSON.stringify(step);
    const known = memory.get(key);
    if (known !== undefined) {
      recorded?.(known);
      return known;
    }
    if (evaluations >= budget) throw new StopSearch("budget");
    const evaluation = objective.evaluate(step, scoreWith === undefined ? {} : { scoreWith });
    evaluations += 1;
    const entry: SearchEntry = { step, key, evaluation, index: order, lineage, original: key === originalKey };
    order += 1;
    memory.set(key, entry);
    recorded?.(entry);
    if (memory === scored && (best === null || jAtWeight(evaluation, weightS) < jAtWeight(best.evaluation, weightS))) best = entry;
    if (evaluations % batchSize === 0) {
      let command = yield progress();
      // A snapshot is answered with the result a stop here would give, and the search then waits
      // for the next command at the same point, so asking changes nothing it goes on to do.
      while (command?.snapshot === true && context.snapshot !== undefined) {
        command = yield { ...progress(), snapshot: context.snapshot(outcomeOf(true, false)) };
      }
      if (command?.stop === true) throw new StopSearch("host");
    }
    return entry;
  }

  /** A candidate as a point of a pass, or null when `emitStep` refuses it. */
  function* pointOf(candidate: RouteCandidate, lineage: number): Generator<OptimizeProgress, Point | null, OptimizeCommand | undefined> {
    const emitted = emit(candidate);
    if (!emitted.ok) return null;
    const entry = yield* score(scored, emitted.step, lineage, undefined);
    return Number.isFinite(entry.evaluation.j) ? { candidate, entry } : null;
  }

  const startPolish = (x: Point, stepFraction = 1): Polish => {
    const parameters = x.candidate === null ? [] : parametersOf(x.candidate, mode);
    return { x, parameters, steps: parameters.map((parameter) => initialStep[parameter.kind] * stepFraction) };
  };

  const startPass = (x: Point, lineage: number, passWeightS: number): Pass => ({
    lineage,
    weightS: passWeightS,
    main: startPolish(x),
    moves: null,
    trial: null,
    done: false,
  });

  /** True when every step of a continuous pass is below the canonical resolution. */
  const stalled = (polish: Polish): boolean =>
    polish.parameters.every((parameter, k) => (polish.steps[k] as number) < MIN_STEP[parameter.kind]);

  /** One exploratory sweep of a continuous pass, then a pattern move after an improvement or halved steps after none. */
  function* sweep(polish: Polish, lineage: number, passWeightS: number): Generator<OptimizeProgress, void, OptimizeCommand | undefined> {
    const j = (point: Point): number => jAtWeight(point.entry.evaluation, passWeightS);
    const start = polish.x;
    let improved = false;
    for (const [k, parameter] of polish.parameters.entries()) {
      const stepSize = polish.steps[k] as number;
      if (stepSize < MIN_STEP[parameter.kind]) continue;
      for (const sign of [1, -1]) {
        const from = polish.x.candidate as RouteCandidate;
        const trial = yield* pointOf(parameter.write(from, parameter.read(from) + sign * stepSize), lineage);
        if (trial !== null && j(trial) < j(polish.x)) {
          polish.x = trial;
          improved = true;
          break;
        }
      }
    }
    if (improved) {
      let pattern = polish.x.candidate as RouteCandidate;
      for (const parameter of polish.parameters) {
        pattern = parameter.write(pattern, 2 * parameter.read(pattern) - parameter.read(start.candidate as RouteCandidate));
      }
      const trial = yield* pointOf(pattern, lineage);
      if (trial !== null && j(trial) < j(polish.x)) polish.x = trial;
    } else {
      polish.steps = polish.steps.map((value) => value / 2);
    }
  }

  /** The candidate the structural moves of a point start from, or null when the point has none. */
  const moveBaseOf = (point: Point): MoveBase | null => {
    const candidate: RouteCandidate | null =
      point.candidate ?? (mode === "headingOnly" ? { ends: context.ends, ...FIXED_GEOMETRY, heading: { mode: "asWritten" } } : null);
    if (candidate === null) return null;
    const geometry = mode === "headingOnly" ? context.originalGeometry : stepGeometry(point.entry.step, context.ends);
    return typeof geometry === "string" ? null : { candidate, step: point.entry.step, geometry };
  };

  /** Ends a trial: its pass keeps the point the trial stalled at only when that is strictly lower in J. */
  const settleTrial = (pass: Pass): void => {
    const trial = pass.trial;
    if (trial === null) return;
    const beforeJ = jAtWeight(pass.main.x.entry.evaluation, pass.weightS);
    const afterJ = jAtWeight(trial.polish.x.entry.evaluation, pass.weightS);
    if (keepsStructuralMove(beforeJ, afterJ)) {
      pass.main = trial.polish;
      pass.moves = null;
      keptMoves.push({
        lineage: pass.lineage,
        kind: trial.move.kind,
        index: trial.move.index,
        to: trial.move.to,
        beforeJ,
        afterJ,
        step: trial.polish.x.entry.step,
      });
    }
    pass.trial = null;
  };

  /**
   * A stalled pass's structural moves (spec 16 section 6.3), in their fixed order: each move's
   * candidate, then a continuous pass from it, kept only when that stalls strictly lower in J. A
   * kept move makes its point the pass's, and the moves start again from there; the pass is done
   * when no move is left to try.
   */
  function* structuralPhase(pass: Pass): Generator<OptimizeProgress, void, OptimizeCommand | undefined> {
    while (!pass.done) {
      if (pass.moves === null) {
        const base = moveBaseOf(pass.main.x);
        pass.moves = base === null ? [] : structuralMoves(base, { mode, maxPaths: context.maxPaths, allowRanges: context.allowRanges });
      }
      const move = pass.moves.shift();
      if (move === undefined) {
        pass.done = true;
        return;
      }
      const point = yield* pointOf(move.candidate, pass.lineage);
      if (point === null) continue;
      pass.trial = { polish: startPolish(point, MOVE_STEP_FRACTION), move };
      while (!stalled(pass.trial.polish)) yield* sweep(pass.trial.polish, pass.lineage, pass.weightS);
      settleTrial(pass);
    }
  }

  let stopped = false;
  let exhausted = false;
  const seeds = buildSeeds(context);
  try {
    // Every seed by the estimate plus the penalties, at the base weight.
    // Each seed is recorded as it is scored, so a stop at the report after it keeps it.
    for (const seed of seeds) yield* score(estimated, seed.step, -1, "estimate", (entry) => seedEntries.push(entry));
    const bySeed = new Map(seedEntries.map((entry, k) => [entry, seeds[k] as Seed]));
    let starts = rankEntries(
      seedEntries.filter((entry) => Number.isFinite(entry.evaluation.j) && (bySeed.get(entry) as Seed).startable),
      (entry) => jAtWeight(entry.evaluation, PENALTY_WEIGHT_S),
      defaultHeadingMode,
    ).slice(0, START_COUNT);
    // The pinned seed of a run with heading holds takes the last start when it has none (issue #448).
    const pinned = seedEntries.find((entry) => (bySeed.get(entry) as Seed).pinned === true && Number.isFinite(entry.evaluation.j));
    if (pinned !== undefined && !starts.includes(pinned)) starts = [...starts.slice(0, START_COUNT - 1), pinned];

    // From here on, the best so far is judged at the highest weight, the last start's.
    phase = "search";
    weightS = startWeightS(Math.max(0, starts.length - 1));
    const passes: Pass[] = [];
    for (const [index, entry] of starts.entries()) {
      const seed = bySeed.get(entry) as Seed;
      const scoredSeed = yield* score(scored, seed.step, index, undefined);
      if (!Number.isFinite(scoredSeed.evaluation.j)) continue;
      passes.push(startPass({ candidate: seed.candidate, entry: scoredSeed }, index, startWeightS(index)));
    }

    // Every start's continuous pass, a sweep each in turn, until each has stalled.
    while (passes.some((pass) => !stalled(pass.main))) {
      for (const pass of passes) if (!stalled(pass.main)) yield* sweep(pass.main, pass.lineage, pass.weightS);
    }

    if (passes.length > 0) {
      phase = "lastPass";
      const finals = passes.map((pass) => pass.main.x.entry);
      const winner = rankEntries(finals, (entry) => jAtWeight(entry.evaluation, weightS), defaultHeadingMode)[0] as SearchEntry;
      const from = passes.find((pass) => pass.main.x.entry === winner) as Pass;
      const last = startPass(from.main.x, from.lineage, weightS);
      while (!stalled(last.main)) yield* sweep(last.main, last.lineage, last.weightS);

      // The structural moves, first where the last pass stalled, then where each other start did.
      for (const pass of [last, ...passes.filter((pass) => pass !== from)]) yield* structuralPhase(pass);
    }
  } catch (error) {
    if (!(error instanceof StopSearch)) throw error;
    if (error.by === "host") stopped = true;
    else exhausted = true;
  }

  return outcomeOf(stopped, exhausted);
}
