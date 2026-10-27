import type { Auto, Field, PathStep, Step } from "@horizon36596/zenith-schema";
import { check } from "../check.js";
import { updateStep } from "../edit/tree.js";
import { estimate } from "../estimate.js";
import { angleDelta } from "../geometry/angle.js";
import { robotClearanceIn } from "../kinematics.js";
import { flattenSteps, plan } from "../plan.js";
import { resolve, type ResolvedStep } from "../resolve.js";
import { DEFAULT_TICK_S } from "../sim/params.js";
import type { Finding, PlanSample, Plan } from "../types.js";
import type { SeasonRules } from "../season.js";
import { canonicalAuto, END_HEADING_TOLERANCE_RAD, routeEndsOf, type CanonicalAuto } from "./candidate.js";
import {
  keepOutWords,
  shortfallKey,
  sweptClearanceCheck,
  sweptShortfalls,
  type ClearanceViolation,
  type SweptAllowance,
} from "./clearance.js";
import { holdsActive, holdWords, NO_HOLDS, stepHoldProblem, type HeadingHolds } from "./holds.js";
import { TIME_EPSILON_S, type Objective, type ObjectiveInput, type WindowTimes } from "./objective.js";
import type { OriginalBlocked } from "./types.js";

/**
 * The hard final check (issue #301). Every result of the optimizer passes it, on the route's rounded,
 * emitted form, inside the whole auto, before anyone sees it. `createFinalCheck(...).verify(step)` runs
 * the seven steps in order and stops at the first that fails, naming it:
 *
 * 1. the auto with the step written into it parses, and its canonical form round-trips byte for
 *    byte, with the step exactly as emitted (the bytes that are scored are the bytes that are saved);
 * 2. the keep list of section 2 equals the original's: both ends as written, the markers with each
 *    `at`, and every other key of the step; a distance marker must still be on the new route;
 * 3. `resolve` gives the same start pose S and end pose E, E's heading to 1e-4 rad, and every
 *    other step the poses it had;
 * 4. `check()` adds no error finding anywhere, and on this step none of STRUCTURE, CLEARANCE,
 *    PERIMETER, KEEPOUT, OPPONENT_SIDE, HEADING, MOUTH_LEADING, SWEEP_SPEED, TIMEOUT_TIGHT or CONTINUITY (a
 *    CLEARANCE may appear when the card's margin is below the robot's clearance, and
 *    STRAFE_FRACTION may appear: the verdict lists what was added and removed);
 * 5. the swept margin test on the plan sampled every 0.5 in (`sweptClearanceCheck`);
 * 6. when the instant sim scores the run, the same test on its own poses over the route and over
 *    what the window holds after it; otherwise it is skipped and the verdict says so;
 * 7. the route is faster than the original by at least one sim tick, under the model that scored it.
 *
 * The original is blocked (`originalBlocked`) when `check()` itself reports a collision on its
 * step: a STRUCTURE, PERIMETER, OPPONENT_SIDE or KEEPOUT finding, which the editor shows too. A
 * CLEARANCE warning alone does not count in a plain run, because `check()` gives the ends no
 * exemption: an end resting near a face would count, though no route can move it. In Route around
 * mode (`routeAround`, the finding action of that name and Add a clear path here), which is an
 * explicit request to clear the margin, a CLEARANCE finding on the step blocks it too, and so does
 * the plan coming within the margin on the swept test of step 5 (which exempts the ends), though
 * `check()` reports nothing.
 *
 * Round a blocked original, the Route around rule (spec section 8.3) waives step 7: a route that
 * passes steps 4 to 6 outright is accepted whatever its time, so a route that clears a CLEARANCE
 * keeps the full margin even when it is slower. Round an original that `check()` passes, and in a
 * plain run round one that only comes within the margin, steps 5 and 6 are advisory, because they look
 * closer than `check()` does (the review of PR #395): the original may come within the margin on the
 * plan, or ride the wall past its slack in the instant sim's tracking, and still be a route the robot
 * drives. A route is then held to being no worse than the original on those steps, its shortfall on
 * each thing no larger than the original's own (`SHORTFALL_TOLERANCE_IN`), and step 7 still holds.
 *
 * The gate between models (spec section 5.2) is not a failure. A route faster in the instant sim
 * and slower in the estimate passes and is flagged `fasterInSimOnly`. `choosePick` never makes it the
 * pick round an original that `check()` passes, and returns it as an alternative with its label;
 * round a blocked original the best clear route is the pick whatever the models say, with that label.
 *
 * What a later unit owns is left to it: the search that produces candidates, the list of moved
 * markers and the plain-sentence changes, and the card. This module only says yes or no, and why.
 *
 * Pure (CLAUDE.md rule 1): no clock, no randomness, no I/O. The same inputs give the same verdict.
 */

/**
 * The spacing of the plan's samples for the swept margin test, in inches (SET BY HAND: spec 16
 * section 4.4 step 5). It is a quarter of the plan's usual 2 in, so the hulls the test builds are
 * short and the rotation bulge it adds is small.
 */
export const FINAL_SAMPLE_SPACING_IN = 0.5;

/** The least a route must gain, in seconds: one sim tick (CARRIED OVER: `DEFAULT_TICK_S`, spec 16 section 4.4 step 7). */
export const MIN_TIME_GAIN_S = DEFAULT_TICK_S;

/**
 * How far a distance marker may sit past the new route's end, in inches, before the route is
 * refused (SPEC: canonical inch resolution), so a marker written at the old end of a route that
 * is shorter by a rounding is not refused for arithmetic.
 */
export const MARKER_PAST_END_TOLERANCE_IN = 0.001;

/** What the card says when step 6 is skipped, because the estimate scored the run (spec 16 section 4.4 step 6). */
export const PLANNED_PATH_ONLY_NOTE = "Clearance checked on the planned path only.";

/** The label of an alternative the gate between models kept out of the pick (spec 16 section 5.2). */
export const SIM_ONLY_LABEL = "Faster in the instant sim, slower in the estimate";

/**
 * The label of an alternative that is faster in the estimate and slower in the instant sim (issue
 * #448): the other side of the gate between models. The timeline shows the estimate, so such a
 * route is offered beside the pick, never as it.
 */
export const ESTIMATE_ONLY_LABEL = "Faster in the estimate, slower in the instant sim";

/** How many alternatives a result carries besides the pick (spec 16 section 7). */
export const MAX_ALTERNATIVES = 2;

/** The findings a route may not add on its own step, whatever their severity (step 4). */
const STEP_CODES: ReadonlySet<Finding["code"]> = new Set([
  "STRUCTURE",
  "CLEARANCE",
  "PERIMETER",
  "KEEPOUT",
  "OPPONENT_SIDE",
  "HEADING",
  "MOUTH_LEADING",
  "SWEEP_SPEED",
  "TIMEOUT_TIGHT",
  "CONTINUITY",
]);

/**
 * The findings on the original's own step that make it blocked (step 4), in the order the
 * sentences name them: the errors first, then the keep-out warning. These are collisions, which the
 * editor shows; CLEARANCE is not one, and neither is a shortfall only the swept tests see.
 */
const BLOCKING_CODES: readonly Finding["code"][] = ["STRUCTURE", "PERIMETER", "OPPONENT_SIDE", "KEEPOUT"];

/**
 * How much further a route may fall short of a thing than an original that `check()` passes, in
 * inches, before steps 5 and 6 refuse it (SPEC: canonical inch resolution), so a route that keeps the
 * original's approach is not refused for arithmetic.
 */
export const SHORTFALL_TOLERANCE_IN = 0.001;

/** How far a resolved position may differ, in inches: arithmetic slack on poses the route did not move. */
const POSE_TOLERANCE_IN = 1e-6;

/** Which step of the check refused a route. */
export type FinalStep = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** The named reason a route was refused. */
export type FinalFailureCode =
  // 1
  | "notWritable"
  | "notCanonical"
  // 2
  | "movesEnd"
  | "changesMarker"
  | "markerPastEnd"
  | "changesKeptKey"
  // 3
  | "movesStart"
  | "movesEndPose"
  | "movesEndHeading"
  | "movesOtherStep"
  | "breaksHeadingHold"
  // 4
  | "addsError"
  | "addsFinding"
  // 5
  | "sweptPlan"
  // 6
  | "sweptSim"
  | "simDoesNotFinish"
  // 7
  | "notScored"
  | "notFaster";

export interface FinalFailure {
  step: FinalStep;
  code: FinalFailureCode;
  /** A plain sentence for the card or a log. */
  reason: string;
  /** For the clearance steps (5 and 6): where the route falls furthest short. */
  worst?: ClearanceViolation;
}

/** A route that passed the check, with what the card needs to say about it. */
export interface AcceptedRoute {
  /** The path step as it is saved. */
  step: PathStep;
  /** The whole auto with the route written into it, in canonical form. */
  auto: CanonicalAuto;
  /** The scorer that decided step 7: "sim" when the instant sim scored the run, else "estimate". */
  scoredBy: "sim" | "estimate";
  /** The original's and the route's times under the estimate (T0). */
  t0: { original: WindowTimes; candidate: WindowTimes };
  /** The same under the instant sim (T1); null when the estimate scored the run, or the sim was skipped. */
  t1: { original: WindowTimes; candidate: WindowTimes } | null;
  /**
   * How much faster the route is than the original under the scorer, in seconds, by the window's
   * ranking time; null when it is not known, which is only round a blocked original.
   */
  gainS: number | null;
  /**
   * True when the instant sim has it faster and the estimate slower than the original. It is never
   * the pick round an original that `check()` passes; round a blocked one it may be, with its label.
   */
  fasterInSimOnly: boolean;
  /**
   * True when the estimate has it faster than the original by at least one sim tick and the instant
   * sim does not (issue #448). Only `verify` with `allowEstimateOnly` accepts such a route, and it is
   * never the pick: it comes back as an alternative labelled `ESTIMATE_ONLY_LABEL`.
   */
  fasterInEstimateOnly: boolean;
  /** The findings the route adds, for the card: STRAFE_FRACTION, and CLEARANCE below the robot's own margin, among others. */
  findingsAdded: Finding[];
  /** The findings the route removes. */
  findingsRemoved: Finding[];
  /** "Clearance checked on the planned path only." when step 6 was skipped; else null. */
  note: string | null;
  /**
   * True when the Route around rule let this route past step 7, because the original is blocked, or
   * because the original breaks a heading hold the person asked for (issue #448).
   */
  routedAround: boolean;
}

/** How one route is verified. */
export interface VerifyOptions {
  /**
   * Accept a route that is faster in the estimate by at least one sim tick though not in the instant
   * sim, flagged `fasterInEstimateOnly`, instead of refusing it at step 7 (issue #448). Default false.
   */
  allowEstimateOnly?: boolean;
  /**
   * Hold the route to the full margin on steps 5 and 6, as round a clear original, even when the
   * original itself falls short there (issue #448: a route faster only in the estimate is offered
   * against the instant sim's verdict, so it must at least keep the margin in the sim's motion). Default false.
   */
  fullMargin?: boolean;
}

export type FinalVerdict = { ok: true; accepted: AcceptedRoute } | { ok: false; failure: FinalFailure };

export interface FinalCheckOptions {
  /**
   * Route around mode (spec 16 section 8.3): an explicit request to clear the margin. A collision
   * finding of `check()` blocks the original in every check (issue #388); with this on, a CLEARANCE
   * finding on the step and the plan coming within the margin block it too, so the route must keep
   * the full margin whatever its time.
   */
  routeAround?: boolean;
  /**
   * The heading holds the person asked for (issue #448): step 3 refuses a route that breaks one, and
   * an original that breaks one lets a route that keeps it past step 7, whatever its time. None when absent.
   */
  holds?: HeadingHolds;
}

export interface FinalCheck {
  /** Runs the seven steps on an emitted path step for the objective's step. */
  verify(step: PathStep, options?: VerifyOptions): FinalVerdict;
  /**
   * What the original does not hold, as a phrase ("does not hold its end heading over the last 12
   * in"), when it breaks a heading hold the person asked for; else null (issue #448).
   */
  originalBreaksHolds: string | null;
  /**
   * What the original goes through, from a collision finding of `check()` on its step (or, in Route
   * around mode, a CLEARANCE finding or the plan coming within the margin), which lets a route skip
   * step 7; null when there is none, and then steps 5 and 6 hold a route to the original's own
   * shortfalls.
   */
  originalBlocked: OriginalBlocked | null;
  /** True when `originalBlocked` is not null. */
  originalCollides: boolean;
}

/** JSON with every object's keys in order, so two values compare by what they hold and not how they were built. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (inner === null || typeof inner !== "object" || Array.isArray(inner)) return inner;
    return Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  });
}

const same = (a: unknown, b: unknown): boolean => stable(a) === stable(b);

/** The step of `auto` whose effective id is `stepId`, or undefined. */
function stepOf(auto: Auto, stepId: string): Step | undefined {
  let found: Step | undefined;
  updateStep(auto.steps, "step", stepId, (step) => {
    found = step;
    return undefined;
  });
  return found;
}

/** The auto with the step written in outright: no check that an end stayed, which is step 2's to name. */
function withStep(auto: Auto, stepId: string, step: PathStep): unknown {
  const result = updateStep(auto.steps, "step", stepId, () => step);
  return { ...auto, steps: result.steps };
}

/** Every resolved step at every depth, in order. */
function flattenResolved(steps: readonly ResolvedStep[]): ResolvedStep[] {
  return steps.flatMap((step) => [step, ...flattenResolved(step.children ?? [])]);
}

/** A finding's identity for "added" and "removed": its code, its step and the obstacle or zone it is about. */
const findingKey = (finding: Finding): string =>
  `${finding.code}|${finding.stepId}|${finding.geometry?.obstacleId ?? finding.geometry?.zoneId ?? ""}`;

/** The findings in `after` that `before` does not have as many of, and the ones `before` has more of. */
function findingDifference(before: readonly Finding[], after: readonly Finding[]): { added: Finding[]; removed: Finding[] } {
  const take = (from: readonly Finding[], against: readonly Finding[]): Finding[] => {
    const left = new Map<string, number>();
    for (const finding of against) left.set(findingKey(finding), (left.get(findingKey(finding)) ?? 0) + 1);
    const out: Finding[] = [];
    for (const finding of from) {
      const count = left.get(findingKey(finding)) ?? 0;
      if (count > 0) left.set(findingKey(finding), count - 1);
      else out.push(finding);
    }
    return out;
  };
  return { added: take(after, before), removed: take(before, after) };
}

/** The path step's samples in a plan, or undefined. */
const samplesOf = (planned: Plan, stepId: string): readonly PlanSample[] | undefined =>
  flattenSteps(planned.steps).find((step) => step.id === stepId)?.samples;

const inches = (value: number): string => (Math.round(value * 1000) / 1000).toString();

/**
 * A sentence for a clearance shortfall, naming what the route comes too close to, and the original's
 * own shortfall there when `originalShortfalls` has one, since the route is then refused for going further.
 */
function describeViolation(violation: ClearanceViolation, where: string, originalShortfalls: ReadonlyMap<string, number>): string {
  const what =
    violation.kind === "structure"
      ? `the structure ${JSON.stringify(violation.id)}`
      : violation.kind === "keepOut"
        ? keepOutWords(violation.id)
        : "the field wall";
  const sentence = `${where} falls ${inches(violation.shortfallIn)} in short of its clearance to ${what}`;
  const originalIn = originalShortfalls.get(shortfallKey(violation.kind, violation.id));
  return originalIn === undefined ? `${sentence}.` : `${sentence}, more than the original's ${inches(originalIn)} in.`;
}

/** An allowance of the original's own shortfalls, each widened by `SHORTFALL_TOLERANCE_IN`. */
const allowanceOf = (shortfalls: ReadonlyMap<string, number>): SweptAllowance =>
  new Map([...shortfalls].map(([key, shortfallIn]) => [key, shortfallIn + SHORTFALL_TOLERANCE_IN]));

/** The spans of the sim's poses the swept test of step 6 runs on, in order. */
const SIM_SPANS = ["path", "after"] as const;
type SimSpan = (typeof SIM_SPANS)[number];

const NO_SHORTFALLS: ReadonlyMap<string, number> = new Map();

/**
 * Builds the final check for one optimization: canonicalises, plans, estimates and checks the
 * original once, then `verify` runs a candidate through the seven steps. `objective` is the one
 * the search scored with, so the times and the margin are the ones the search used.
 */
export function createFinalCheck(input: ObjectiveInput, objective: Objective, options: FinalCheckOptions = {}): FinalCheck {
  const { robot, field, waypoints, season, stepId } = input;
  const { marginIn, world } = objective;
  const routeAround = options.routeAround ?? false;
  const holds = options.holds ?? NO_HOLDS;

  const original = canonicalAuto(input.auto);
  const originalStep = stepOf(original.auto, stepId) as PathStep;
  const originalResolved = resolve(original.auto, waypoints, robot);
  const resolvedStep = flattenResolved(originalResolved.steps).find((resolved) => resolved.id === stepId);
  const ends = resolvedStep === undefined ? null : routeEndsOf(resolvedStep);
  // What the original does not hold of the holds the person asked for (issue #448), or null.
  const originalBreaksHolds =
    holdsActive(holds) && ends !== null && stepHoldProblem(originalStep, ends, holds) !== null ? `does not hold ${holdWords(holds)}` : null;
  const originalPlan = plan(originalResolved, robot, field);
  const originalFindings = check(originalPlan, estimate(originalPlan, robot), robot, field, season);
  const robotMarginIn = robotClearanceIn(robot);
  // A margin below the robot's own lets CLEARANCE appear: the card lists it (spec 16 section 4.4 step 4).
  const stepCodes = marginIn < robotMarginIn ? new Set([...STEP_CODES].filter((code) => code !== "CLEARANCE")) : STEP_CODES;

  const rank = (times: WindowTimes): number => (objective.scoringWindow.notCriticalPath ? times.ownS : times.windowEndS);

  /** The step's samples on the planned path at 0.5 in. */
  const plannedSamples = (auto: Auto): readonly PlanSample[] =>
    samplesOf(plan(resolve(auto, waypoints, robot), robot, field, { sampleSpacingIn: FINAL_SAMPLE_SPACING_IN }), stepId) ?? [];

  /** The original's own samples at 0.5 in, planned once and only when a swept test needs them. */
  const originalSamples = ((): (() => readonly PlanSample[]) => {
    let samples: readonly PlanSample[] | undefined;
    return () => (samples ??= plannedSamples(original.auto));
  })();

  const originalBlocked = ((): OriginalBlocked | null => {
    const codes = routeAround ? [...BLOCKING_CODES, "CLEARANCE" as const] : BLOCKING_CODES;
    for (const code of codes) {
      const finding = originalFindings.find((candidate) => candidate.stepId === stepId && candidate.code === code);
      if (finding !== undefined) return blockedByFinding(finding, field, season);
    }
    // Route around also counts the plan coming within the margin on the swept test, which exempts the ends.
    if (!routeAround) return null;
    const samples = originalSamples();
    if (samples.length === 0) return null;
    const { worst } = sweptClearanceCheck(world, samples, marginIn);
    return worst === null ? null : blockedBySweep(worst, field, season);
  })();

  // What the original itself falls short of on steps 5 and 6, which a route round an original that
  // check() passes may match and not exceed. Round a blocked original a route must clear outright.
  const originalShortfalls = ((): { plan: ReadonlyMap<string, number>; sim: Record<SimSpan, ReadonlyMap<string, number>> } => {
    const none = { plan: NO_SHORTFALLS, sim: { path: NO_SHORTFALLS, after: NO_SHORTFALLS } };
    if (originalBlocked !== null) return none;
    const samples = originalSamples();
    const poses = objective.scorer === "sim" ? objective.simulatedPoses(objective.originalStep) : null;
    const of = (span: readonly PlanSample[]): ReadonlyMap<string, number> => (span.length === 0 ? NO_SHORTFALLS : sweptShortfalls(world, span, marginIn));
    return {
      plan: of(samples),
      sim: { path: poses === null ? NO_SHORTFALLS : of(poses.path), after: poses === null ? NO_SHORTFALLS : of(poses.after) },
    };
  })();
  const planAllowance = allowanceOf(originalShortfalls.plan);
  const simAllowance: Record<SimSpan, SweptAllowance> = { path: allowanceOf(originalShortfalls.sim.path), after: allowanceOf(originalShortfalls.sim.after) };

  /** The swept test over the planned path at 0.5 in, held to the original's own shortfalls. */
  const plannedSweep = (auto: Auto, fullMargin: boolean): { ok: boolean; worst: ClearanceViolation | null } => {
    const samples = plannedSamples(auto);
    return samples.length === 0 ? { ok: true, worst: null } : sweptClearanceCheck(world, samples, marginIn, fullMargin ? undefined : planAllowance);
  };

  /** The swept test over the sim's poses, held to the original's own shortfalls, or null when the sim did not run or did not finish. */
  const simulatedSweep = (step: PathStep, fullMargin: boolean): { ok: boolean; worst: ClearanceViolation | null; spans: SimSpan } | "unfinished" | null => {
    if (objective.scorer !== "sim") return null;
    const poses = objective.simulatedPoses(step);
    if (poses === null) return "unfinished";
    for (const spans of SIM_SPANS) {
      const samples = poses[spans];
      if (samples.length === 0) continue;
      const swept = sweptClearanceCheck(world, samples, marginIn, fullMargin ? undefined : simAllowance[spans]);
      if (!swept.ok) return { ...swept, spans };
    }
    return { ok: true, worst: null, spans: "path" };
  };

  const originalEvaluations = (() => {
    let t0: WindowTimes | null | undefined;
    let t1: WindowTimes | null | undefined;
    return {
      t0: (): WindowTimes | null => (t0 === undefined ? (t0 = objective.evaluate(objective.originalStep, { scoreWith: "estimate" }).t0) : t0),
      t1: (): WindowTimes | null =>
        objective.scorer !== "sim"
          ? null
          : t1 === undefined
            ? (t1 = objective.evaluate(objective.originalStep, { scoreWith: "sim" }).t1)
            : t1,
    };
  })();

  const fail = (step: FinalStep, code: FinalFailureCode, reason: string, worst?: ClearanceViolation | null): FinalVerdict => ({
    ok: false,
    failure: { step, code, reason, ...(worst === undefined || worst === null ? {} : { worst }) },
  });

  const verify = (step: PathStep, verifyOptions: VerifyOptions = {}): FinalVerdict => {
    // The id is how the step is found in the auto, so a route that renames it is named here, not as unwritable.
    if (step.id !== originalStep.id) {
      return fail(2, "changesKeptKey", `The route changes the step's "id" from ${JSON.stringify(originalStep.id)} to ${JSON.stringify(step.id)}, which an optimization keeps as written.`);
    }
    // 1. The auto with the step in it parses, round-trips byte for byte, and keeps the step as emitted.
    let candidate: CanonicalAuto;
    try {
      candidate = canonicalAuto(withStep(original.auto, stepId, step) as Auto);
    } catch (error) {
      return fail(1, "notWritable", `The route cannot be written into the auto: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (canonicalAuto(candidate.auto).text !== candidate.text) {
      return fail(1, "notCanonical", "The auto does not round-trip through canonical form byte for byte.");
    }
    const saved = stepOf(candidate.auto, stepId);
    if (saved === undefined || saved.kind !== "path") {
      return fail(1, "notWritable", `Step ${JSON.stringify(stepId)} is not a path step in the auto with the route written in.`);
    }
    if (!same(saved, step)) {
      return fail(1, "notCanonical", "The route is not in the form it is saved in: rounding to canonical form changes it.");
    }
    const savedStep: PathStep = saved;

    // 2. The keep list of section 2.
    const oldFirst = originalStep.segments[0];
    const oldLast = originalStep.segments[originalStep.segments.length - 1];
    const newFirst = savedStep.segments[0];
    const newLast = savedStep.segments[savedStep.segments.length - 1];
    if (oldFirst === undefined || oldLast === undefined || newFirst === undefined || newLast === undefined) {
      return fail(2, "movesEnd", "The route has no segments, so it has no ends.");
    }
    if (!same(newFirst.from, oldFirst.from)) {
      return fail(2, "movesEnd", `The route moves the start of the step: it begins at ${stable(newFirst.from)}, not at ${stable(oldFirst.from)} as written.`);
    }
    if (!same(newLast.to, oldLast.to)) {
      return fail(2, "movesEnd", `The route moves the end of the step: it ends at ${stable(newLast.to)}, not at ${stable(oldLast.to)} as written.`);
    }
    const oldMarkers = originalStep.markers ?? [];
    const newMarkers = savedStep.markers ?? [];
    if (oldMarkers.length !== newMarkers.length) {
      return fail(2, "changesMarker", `The route changes the number of markers, from ${String(oldMarkers.length)} to ${String(newMarkers.length)}.`);
    }
    for (const [index, marker] of oldMarkers.entries()) {
      const after = newMarkers[index];
      if (after === undefined || !same(after.at, marker.at)) {
        return fail(2, "changesMarker", `The route changes where marker ${String(index + 1)} (${JSON.stringify(marker.command.name)}) is written: its \`at\` is not as it was.`);
      }
      if (!same(after, marker)) {
        return fail(2, "changesMarker", `The route changes marker ${String(index + 1)} (${JSON.stringify(marker.command.name)}).`);
      }
    }
    const keys = new Set([...Object.keys(originalStep), ...Object.keys(savedStep)]);
    for (const key of [...keys].sort()) {
      if (key === "segments" || key === "heading" || key === "markers") continue;
      if (!same((originalStep as Record<string, unknown>)[key], (savedStep as Record<string, unknown>)[key])) {
        return fail(2, "changesKeptKey", `The route changes the step's ${JSON.stringify(key)}, which an optimization keeps as written.`);
      }
    }
    // Every other step is the original's by construction: only this one was written into the auto.

    // The plan of the candidate, at the usual spacing, as the Problems panel sees it.
    const resolved = resolve(candidate.auto, waypoints, robot);
    const planned = plan(resolved, robot, field);
    const lengthIn = flattenSteps(planned.steps).find((planStep) => planStep.id === stepId)?.lengthIn ?? 0;
    for (const [index, marker] of savedStep.markers?.entries() ?? []) {
      const at = marker.at;
      const distanceIn = "distanceIn" in at ? at.distanceIn : "distanceFromEndIn" in at ? at.distanceFromEndIn : null;
      if (distanceIn !== null && distanceIn > lengthIn + MARKER_PAST_END_TOLERANCE_IN) {
        return fail(
          2,
          "markerPastEnd",
          `Marker ${String(index + 1)} (${JSON.stringify(marker.command.name)}) is ${inches(distanceIn)} in ${"distanceIn" in at ? "from the start" : "from the end"}, past the new route's ${inches(lengthIn)} in.`,
        );
      }
    }

    // 3. The same S and E, and every other step where it was.
    const before = flattenResolved(originalResolved.steps);
    const afterByIds = new Map(flattenResolved(resolved.steps).map((resolvedStep) => [resolvedStep.id, resolvedStep]));
    for (const old of before) {
      const now = afterByIds.get(old.id);
      if (now === undefined) return fail(3, "movesOtherStep", `Step ${JSON.stringify(old.id)} is gone after the route is written.`);
      const own = old.id === stepId;
      const start = Math.hypot(now.startPose.xIn - old.startPose.xIn, now.startPose.yIn - old.startPose.yIn);
      if (start > POSE_TOLERANCE_IN || Math.abs(angleDelta(now.startPose.headingRad, old.startPose.headingRad)) > END_HEADING_TOLERANCE_RAD) {
        return own
          ? fail(3, "movesStart", "The route changes where the step starts, S.")
          : fail(3, "movesOtherStep", `Step ${JSON.stringify(old.id)} would start at a different pose.`);
      }
      const end = Math.hypot(now.endPose.xIn - old.endPose.xIn, now.endPose.yIn - old.endPose.yIn);
      if (end > POSE_TOLERANCE_IN) {
        return own
          ? fail(3, "movesEndPose", "The route changes where the step ends, E.")
          : fail(3, "movesOtherStep", `Step ${JSON.stringify(old.id)} would end at a different pose.`);
      }
      const turn = Math.abs(angleDelta(now.endPose.headingRad, old.endPose.headingRad));
      if (turn > END_HEADING_TOLERANCE_RAD) {
        return own
          ? fail(3, "movesEndHeading", `The route ends facing ${inches(now.endPose.headingRad)} rad, not E's ${inches(old.endPose.headingRad)} rad.`)
          : fail(3, "movesOtherStep", `Step ${JSON.stringify(old.id)} would end facing another way.`);
      }
    }
    // The heading holds the person asked for (issue #448), over the route's own length.
    if (ends !== null) {
      const holdProblem = stepHoldProblem(savedStep, ends, holds);
      if (holdProblem !== null) return fail(3, "breaksHeadingHold", holdProblem);
    }

    // 4. check() adds no error anywhere, and none of the step's codes on this step.
    const findings = check(planned, estimate(planned, robot), robot, field, season);
    const { added, removed } = findingDifference(originalFindings, findings);
    for (const finding of added) {
      if (finding.severity === "error") {
        return fail(4, "addsError", `The route adds the error ${finding.code} on step ${JSON.stringify(finding.stepId)}: ${finding.message}`);
      }
      if (finding.stepId === stepId && stepCodes.has(finding.code)) {
        return fail(4, "addsFinding", `The route adds a ${finding.code} finding on its own step: ${finding.message}`);
      }
    }

    // 5. The swept margin test on the plan, no worse than an original that check() passes.
    const fullMargin = verifyOptions.fullMargin === true;
    const sweptPlan = plannedSweep(candidate.auto, fullMargin);
    if (!sweptPlan.ok) {
      return fail(5, "sweptPlan", describeViolation(sweptPlan.worst as ClearanceViolation, "The planned path", originalShortfalls.plan), sweptPlan.worst);
    }

    // 6. The same test on the sim's own poses, when the sim scored the run.
    const simSweep = simulatedSweep(savedStep, fullMargin);
    if (simSweep === "unfinished") {
      return fail(6, "simDoesNotFinish", "The instant sim does not finish the stretch of the routine that is scored with this route, so its motion cannot be checked.");
    }
    if (simSweep !== null && !simSweep.ok) {
      const where = simSweep.spans === "path" ? "The instant sim's motion along the route" : "The instant sim's motion after the route";
      return fail(6, "sweptSim", describeViolation(simSweep.worst as ClearanceViolation, where, originalShortfalls.sim[simSweep.spans]), simSweep.worst);
    }
    const note = simSweep === null ? PLANNED_PATH_ONLY_NOTE : null;

    // 7. Time.
    const estimated = objective.evaluate(savedStep, { scoreWith: "estimate" });
    if (estimated.status !== "scored" || estimated.t0 === null) {
      return fail(7, "notScored", estimated.reason ?? "The route cannot be scored by the estimate.");
    }
    const simulated = objective.scorer === "sim" ? objective.evaluate(savedStep, { scoreWith: "sim" }) : null;
    if (simulated !== null && (simulated.status !== "scored" || simulated.t1 === null)) {
      return fail(7, "notScored", simulated.reason ?? "The route cannot be scored by the instant sim.");
    }
    const scoredBy = simulated === null ? "estimate" : "sim";
    const originalT0 = originalEvaluations.t0();
    const originalT1 = originalEvaluations.t1();
    const candidateT1 = simulated?.t1 ?? null;
    const gainUnder = (from: WindowTimes | null, to: WindowTimes | null): number | null =>
      from === null || to === null ? null : rank(from) - rank(to);
    const gainS = scoredBy === "sim" ? gainUnder(originalT1, candidateT1) : gainUnder(originalT0, estimated.t0);
    const estimateGainS = gainUnder(originalT0, estimated.t0);
    // Round a blocked original, or one that breaks a heading hold the person asked for, the time test is waived.
    const routedAround = originalBlocked !== null || originalBreaksHolds !== null;
    const notFaster = gainS === null || gainS < MIN_TIME_GAIN_S - TIME_EPSILON_S;
    // The other side of the gate between models (issue #448): faster in the estimate by a tick, not in the sim.
    const fasterInEstimateOnly =
      !routedAround &&
      notFaster &&
      verifyOptions.allowEstimateOnly === true &&
      scoredBy === "sim" &&
      estimateGainS !== null &&
      estimateGainS >= MIN_TIME_GAIN_S - TIME_EPSILON_S;
    if (!routedAround && notFaster && !fasterInEstimateOnly) {
      return fail(
        7,
        "notFaster",
        gainS === null
          ? "The original's time is not known, so the route cannot be shown to be faster."
          : `The route is ${inches(gainS)} s faster than the original, less than one sim tick (${String(MIN_TIME_GAIN_S)} s).`,
      );
    }
    // Faster under the sim and slower under the estimate. Round an original check() passes, step 7
    // has already made the route faster under the sim; round a blocked one, a route slower under
    // both models does not contradict the timeline, so only the sim gain decides. The flag is the
    // label `choosePick` gives the route, and round a clear original it also keeps it from the pick.
    const fasterInSimOnly =
      scoredBy === "sim" && gainS !== null && gainS > TIME_EPSILON_S && estimateGainS !== null && estimateGainS < -TIME_EPSILON_S;

    return {
      ok: true,
      accepted: {
        step: savedStep,
        auto: candidate,
        scoredBy,
        t0: { original: originalT0 as WindowTimes, candidate: estimated.t0 },
        t1: originalT1 === null || candidateT1 === null ? null : { original: originalT1, candidate: candidateT1 },
        gainS,
        fasterInSimOnly,
        fasterInEstimateOnly,
        findingsAdded: added,
        findingsRemoved: removed,
        note,
        routedAround,
      },
    };
  };

  return { verify, originalBlocked, originalCollides: originalBlocked !== null, originalBreaksHolds };
}

/** How a sentence names a structure: the season's words for it, else its id. */
function structureWords(id: string | null, field: Field, season: SeasonRules | undefined): string {
  const label = id === null ? null : (season?.obstacleLabel?.(id, field) ?? null);
  return label === null || label === "" ? `the structure ${JSON.stringify(id)}` : label;
}

/** The words for the original coming within the margin of something, as Route around says them. */
const withinMargin = (label: string): string => `comes within the margin of ${label}`;

/** What the planned path's swept test (step 5) says the original comes within the margin of: Route around mode only. */
function blockedBySweep(worst: ClearanceViolation, field: Field, season: SeasonRules | undefined): OriginalBlocked {
  const label =
    worst.kind === "structure" ? structureWords(worst.id, field, season) : worst.kind === "keepOut" ? keepOutWords(worst.id) : "the field wall";
  return { step: 5, code: "CLEARANCE", label, phrase: withinMargin(label) };
}

/** What a finding of `check()` on the original's step says it goes through, or, for CLEARANCE, comes within the margin of. */
function blockedByFinding(finding: Finding, field: Field, season: SeasonRules | undefined): OriginalBlocked {
  const at = (label: string, phrase: string): OriginalBlocked => ({ step: 4, code: finding.code, label, phrase });
  switch (finding.code) {
    case "CLEARANCE": {
      const label = structureWords(finding.geometry?.obstacleId ?? null, field, season);
      return at(label, withinMargin(label));
    }
    case "PERIMETER":
      return at("the field wall", "goes past the field wall");
    case "OPPONENT_SIDE":
      return at("the centre line", "crosses the centre line");
    case "KEEPOUT": {
      const label = keepOutWords(finding.geometry?.zoneId ?? null);
      return at(label, `enters ${label}`);
    }
    default: {
      const label = structureWords(finding.geometry?.obstacleId ?? null, field, season);
      return at(label, `goes through ${label}`);
    }
  }
}

/** An accepted route with the label the card shows beside it, or null for none. */
export interface LabelledRoute {
  route: AcceptedRoute;
  label: string | null;
}

export interface PickResult {
  /**
   * The best route that is no slower than the original in the estimate, or, round a blocked
   * original, the best clear route whatever the models say; null when there is none.
   */
  pick: AcceptedRoute | null;
  /** The pick's label: `SIM_ONLY_LABEL` for a pick round a blocked original that is faster only in the sim; else null. */
  pickLabel: string | null;
  /** Up to `MAX_ALTERNATIVES` others. */
  alternatives: LabelledRoute[];
}

const labelOf = (route: AcceptedRoute): string | null =>
  route.fasterInSimOnly ? SIM_ONLY_LABEL : route.fasterInEstimateOnly ? ESTIMATE_ONLY_LABEL : null;

/**
 * True when a route may be the pick: always round a blocked original, whose best clear route is the
 * pick whatever the models say, and otherwise only when it is no slower in the estimate.
 */
export const pickable = (route: AcceptedRoute): boolean => route.routedAround || (!route.fasterInSimOnly && !route.fasterInEstimateOnly);

/**
 * Chooses the pick from routes that passed the final check, best first as the search ranked them,
 * with the gate between models (spec 16 section 5.2): round an original that `check()` passes, the
 * pick must be no slower than the original under the estimate, so the timeline never contradicts the
 * card. A route the instant sim has faster and the estimate has slower is then never the pick; it
 * comes back as an alternative labelled `SIM_ONLY_LABEL`, and such alternatives are listed before the
 * others so the cap never drops one. A route faster only in the estimate (issue #448) is never the
 * pick either: it comes back as an alternative labelled `ESTIMATE_ONLY_LABEL`, after those. Round a blocked original the best clear route is the pick, and
 * keeps that label when it has it (spec 16 section 4.4 step 7).
 */
export function choosePick(accepted: readonly AcceptedRoute[]): PickResult {
  const pickIndex = accepted.findIndex(pickable);
  const pick = pickIndex < 0 ? null : (accepted[pickIndex] as AcceptedRoute);
  const rest = accepted.filter((_, index) => index !== pickIndex);
  const gated = rest.filter((route) => route.fasterInSimOnly);
  const estimateOnly = rest.filter((route) => route.fasterInEstimateOnly);
  const others = rest.filter((route) => !route.fasterInSimOnly && !route.fasterInEstimateOnly);
  const alternatives = [...gated, ...estimateOnly, ...others].slice(0, MAX_ALTERNATIVES).map((route): LabelledRoute => ({ route, label: labelOf(route) }));
  return { pick, pickLabel: pick === null ? null : labelOf(pick), alternatives };
}
