import type { MarkerAt, PathStep } from "@horizon36596/zenith-schema";
import type { Pose, Vec2 } from "../geometry/vec.js";
import type { Finding } from "../types.js";
import type { ClearanceKind } from "./clearance.js";
import type { DefaultHeadingMode } from "./headingDp.js";
import type { ObjectiveInput, ObjectiveScorer, WindowTimes } from "./objective.js";

/**
 * The optimizer's public shapes: what `optimizeRoute` and `runOptimize` take, what the generator
 * yields, and the `OptimizeResult` it returns.
 *
 * Pure data (CLAUDE.md rule 1).
 */

/** What is optimized: the auto, its project files, and the effective id of one path step at any depth. */
export type OptimizeInput = ObjectiveInput;

/**
 * Which part of the route the search may change (spec 16 section 7):
 * - `routeAndHeading`: the geometry and the heading profile together;
 * - `headingOnly`: the heading profile only, over the original's segments as written ("Find a
 *   faster heading", section 8.3);
 * - `routeOnly`: the geometry only, with the original's heading kept as written.
 */
export type OptimizeMode = "routeAndHeading" | "headingOnly" | "routeOnly";

export interface OptimizeOptions {
  /** The safety margin to structures, in inches. Default: the robot's clearance (D8, section 4.1). */
  marginIn?: number;
  /** How many candidates the search may score, a count and never a time. Default `OPTIMIZE_DEFAULT_BUDGET`. */
  budget?: number;
  /** "estimate" when the person picked Estimate in the card's options. Default "sim". */
  scorer?: ObjectiveScorer;
  /** Default "routeAndHeading". */
  mode?: OptimizeMode;
  /**
   * False keeps every route to one path (the card's "Allow several paths"), as a `maxPaths` of 1
   * would. Default true, and then the search's structural moves may split a path or merge two, so a
   * route can gain or lose paths during the search, up to `maxPaths`.
   */
  allowSplit?: boolean;
  /** False keeps the heading to one mode, never piecewise ranges (the card's "Allow heading ranges"). Default true. */
  allowRanges?: boolean;
  /** A turn on the spot before driving needs the D10 step, which does not exist yet, so only false is accepted. */
  allowTurnFirst?: false;
  /**
   * The most paths a route may have. Default `DEFAULT_MAX_PATHS`. An original with more is scored
   * as candidate 0 but never searched from. `headingOnly` keeps the segments as written, so it may
   * return the original's own number.
   */
  maxPaths?: number;
  /** The person's default heading mode for new paths (D6). Default `DEFAULT_HEADING_MODE`. */
  defaultHeadingMode?: DefaultHeadingMode;
  /**
   * Route around mode (section 8.3): an explicit request to clear the margin, which the finding
   * action of that name and Add a clear path here make. Every run, since issue #388, gives an
   * original that `check()` finds going through something the fastest route that passes the final
   * check's clearance steps (4 to 6), whatever its time. With `routeAround`, an original that only
   * comes within the margin, a CLEARANCE finding on its step or the plan coming within the margin on
   * the swept test, gets the same: the pick keeps the full margin even when it is slower
   * (`OptimizeResult.originalBlocked` says what the original comes within it of). Without it, such
   * an original is kept unless a route is faster and comes no closer (PR #395). Refused with
   * `headingOnly`, which never moves the geometry. Part of `inputKey` only when it is on.
   */
  routeAround?: boolean;
  /**
   * Hold the arrival heading over the first this many inches of the route (issue #448). 0, the
   * default, is off. Every candidate keeps it and the hard final check enforces it; an original that
   * does not keep it is replaced by the fastest route found that does, whatever its time. Part of
   * `inputKey` only when it is not 0.
   */
  holdStartHeadingIn?: number;
  /** Hold E's heading over the last this many inches of the route, as `holdStartHeadingIn` holds the start. Default 0, off. */
  holdEndHeadingIn?: number;
  /**
   * How many evaluations the generator makes between two progress reports. Default
   * `DEFAULT_BATCH_SIZE`. It changes only how often the host hears from the search, never the
   * result, so it is not part of `inputKey`.
   */
  batchSize?: number;
}

/** What the search is doing when it reports. */
export type OptimizePhase = "seeds" | "search" | "lastPass" | "final";

/** What the generator yields after each batch of evaluations. */
export interface OptimizeProgress {
  evaluations: number;
  budget: number;
  /** The best J so far, in seconds, at the search's highest penalty weight; null before any candidate is scored. */
  bestJ: number | null;
  /** The route behind `bestJ`, as it would be saved. */
  bestStep?: PathStep;
  phase: OptimizePhase;
  /**
   * Only in the answer to `{ snapshot: true }`: the result a stop at this point would return, with
   * the status `stoppedEarly`. The search has not ended.
   */
  snapshot?: OptimizeResult;
}

/**
 * What the host may send back with `next()`:
 * - `{ stop: true }` ends the search now, and the result is built from what was found so far, with
 *   the status `stoppedEarly`. A run with `budget` set to that result's `evaluations` gives the same
 *   result.
 * - `{ snapshot: true }` asks for that same result without ending the search. The generator answers
 *   with a progress report that carries it in `snapshot`, at the same evaluation count, and the next
 *   `next()` goes on exactly as if nothing had been asked. This is how the editor's Stop keeps the
 *   run to Continue from (issue #306).
 *
 * Once the search is done (the `final` report), neither is read: the run goes on to its own result.
 */
export interface OptimizeCommand {
  stop?: boolean;
  snapshot?: boolean;
}

export type OptimizeStatus = "improved" | "noBetter" | "infeasible" | "stoppedEarly";

/** A marker whose position on the field moves when the route changes (spec 16 section 2). */
export interface MovedMarker {
  /** Its index in the step's `markers`. */
  index: number;
  /** The command it runs. */
  name: string;
  /** Its `at`, exactly as written, which the route keeps. */
  at: MarkerAt;
  /** Where it fires on the original route and on the new one. */
  fromIn: Vec2;
  toIn: Vec2;
  /** How far it moves, in inches. */
  movedIn: number;
}

/** The closest the route comes to a structure or a keep-out that applies in auto. */
export interface ClosestClearance {
  kind: Exclude<ClearanceKind, "wall">;
  id: string;
  /** Signed: negative inside it. */
  clearanceIn: number;
}

/** Times under one model before and after, for the card. */
export interface BeforeAfter {
  before: WindowTimes;
  after: WindowTimes;
}

/** A route the optimizer offers: the pick, or one of the alternatives. */
export interface OptimizedRoute {
  /** The full path step as it is saved. */
  step: PathStep;
  /** The label the card shows beside it, such as "Faster in the instant sim, slower in the estimate"; null for none. */
  label: string | null;
  /** The estimate (T0) before and after. */
  t0: BeforeAfter;
  /** The instant sim (T1) before and after; null when the sim did not score the run. */
  t1: BeforeAfter | null;
  /**
   * How much faster it is under the scorer, in seconds, by the window's ranking time. Negative when
   * it is slower, which only a route round a blocked original can be (`OptimizeResult.originalBlocked`).
   */
  gainS: number | null;
  /** The closest clearance on its planned path; null when the field has no structure or keep-out. */
  closest: ClosestClearance | null;
  movedMarkers: MovedMarker[];
  findingsAdded: Finding[];
  findingsRemoved: Finding[];
  /** Plain sentences saying what changed. */
  changes: string[];
  /** "Clearance checked on the planned path only." when the estimate scored it; else null. */
  note: string | null;
}

/** For an `infeasible` result: where the closest attempt falls furthest short, and of what. */
export interface ClosestAttempt {
  /** The attempt as it would be saved; null when the step's own end is the problem. */
  step: PathStep | null;
  pose: Pose;
  kind: ClearanceKind;
  /** The structure's or keep-out's id; null for the field wall. */
  id: string | null;
  /** How much more clearance it needed there, in inches. */
  shortfallIn: number;
}

/**
 * What the original goes through, from a collision finding of `check()` on its own step (spec 16
 * section 4.4 step 7, issue #388): STRUCTURE, PERIMETER, OPPONENT_SIDE or KEEPOUT, which the editor
 * shows too. Such a route was never one the robot could drive, so no route is held to beating its
 * time: the pick is the fastest route found that passes the check, even when it is slower, and with
 * none the result is `infeasible`. An original that `check()` passes is not blocked, even when the
 * final check's swept tests see it come within the margin or ride the wall in the instant sim, except
 * in Route around mode (`OptimizeOptions.routeAround`), where coming within the margin blocks it too,
 * as a CLEARANCE finding on its step or as the plan's swept test sees it (PR #395).
 */
export interface OriginalBlocked {
  /** The step of the final check that finds it: 4 for a finding of `check()` on the step, 5 for the plan's swept test (Route around only). */
  step: 4 | 5;
  /** The finding: STRUCTURE, PERIMETER, OPPONENT_SIDE or KEEPOUT; CLEARANCE for coming within the margin (Route around only). */
  code: Finding["code"];
  /** What it goes through or comes within the margin of, in words: "the west base bar of the hive frame", "the field wall", "the centre line", "the keep-out \"lane\"". */
  label: string;
  /**
   * The words after "The original": "goes through the west base bar of the hive frame", "goes past
   * the field wall", "crosses the centre line", "enters the keep-out \"lane\"" or, for CLEARANCE,
   * "comes within the margin of the west base bar of the hive frame".
   */
  phrase: string;
}

export interface OptimizeResult {
  status: OptimizeStatus;
  stepId: string;
  mode: OptimizeMode;
  /** The pick's step; null when there is none. */
  step: PathStep | null;
  pick: OptimizedRoute | null;
  /** Up to `MAX_ALTERNATIVES` other routes that passed the final check. */
  alternatives: OptimizedRoute[];
  /** The scorer actually used. */
  scorer: ObjectiveScorer;
  /** Why the run fell back to the estimate, when it did; else null. */
  scorerReason: string | null;
  /** The safety margin the run used, in inches. */
  marginIn: number;
  /** The pick's moved markers (empty without a pick). */
  movedMarkers: MovedMarker[];
  /** The findings the pick adds and removes (empty without a pick). */
  findingsAdded: Finding[];
  findingsRemoved: Finding[];
  /** Plain sentences: what the pick changes, or why there is no pick. */
  changes: string[];
  /** What the card says about the run: the scoring window's notes, the fallback, the planned-path note. */
  notes: string[];
  /** How many candidates the search scored. The final check of the finalists is not counted. */
  evaluations: number;
  budget: number;
  /** A hash of the inputs and the options that decide the result. */
  inputKey: string;
  /** For `infeasible`, the closest attempt; else null. */
  closest: ClosestAttempt | null;
  /**
   * What the original goes through when `check()` reports a collision on its step (or, in Route
   * around mode, comes within the margin of), so the pick is the fastest clear route whatever its
   * time; null otherwise, and then a route must be faster and no worse than the original on the swept
   * tests (spec 16 section 4.4 step 7).
   */
  originalBlocked: OriginalBlocked | null;
  /**
   * Present only when the original breaks a heading hold the run asked for (issue #448): the words
   * after "The original", such as "does not hold its end heading over the last 12 in". The pick is
   * then the fastest route found that keeps the holds, whatever its time, and with none the result
   * is `infeasible`.
   */
  originalBreaksHolds?: string;
}
