import type { Auto, Field, PathStep, Robot, Waypoints } from "@horizon36596/zenith-schema";
import { PERIMETER_TOLERANCE_IN } from "../check.js";
import { mouthLeadingStretches, sweepSpeedReading } from "../checks/motion.js";
import { intakeTimeline } from "../checks/intake.js";
import { estimate } from "../estimate.js";
import { footprintAt } from "../footprint.js";
import { MOUTH_LEADING_TOLERANCE_RAD, robotLimits } from "../kinematics.js";
import { runLedger } from "../ledger.js";
import { flattenSteps, plan } from "../plan.js";
import { resolve } from "../resolve.js";
import type { SeasonRules } from "../season.js";
import { resimulate, simulateRun } from "../sim/simulate.js";
import type { ConditionResolver, SimOptions, SimRun, SimStepRecord, SimTrace } from "../sim/types.js";
import type { Estimate, Plan, PlanSample, PlanStep } from "../types.js";
import { FINALIST_COUNT, OPTIMIZE_SCORER_MODE, type ScorerMode } from "./budget.js";
import { autoWithRoute, canonicalAuto, type CanonicalAuto } from "./candidate.js";
import {
  CLEARANCE_EPSILON_IN,
  clearancePenalty,
  clearanceWorld,
  measureClearances,
  type ClearanceViolation,
  type ClearanceWorld,
} from "./clearance.js";

/**
 * The optimizer's objective J: the scoring window of one path step, the base run that is simulated once
 * per optimization, and J for a candidate route under the estimate (T0) or the instant sim (T1), plus
 * the clearance, MOUTH_LEADING and SWEEP_SPEED penalties.
 *
 * The window starts at the top-level step that holds the path, at any depth, and ends when that
 * step is done, or when the next top-level step is done if it inherits this one's exit. Every step
 * before the window is unchanged by a new route, so the window's end time, read from the start of
 * the auto, compares a candidate's real cost with the original's, including what it does to the
 * next step.
 *
 * `createObjective` plans, estimates and simulates the original once. `evaluate` then plans the
 * auto with the candidate's route (every other step answers from `plan()`'s memo), estimates it,
 * and resumes the instant sim from the base run's checkpoint at the window's first step, stopped
 * when the window ends (`SimOptions.stopAfterStepId`).
 *
 * What a later unit owns is left to it: the search (seeds, the local search and the penalty
 * weight's doubling), the hard final check of section 4.4 (the swept tests and the gate between
 * models), and reading the robot's own clearance for the default margin (D8), which the caller
 * passes in as `marginIn`.
 *
 * Pure (CLAUDE.md rule 1): no clock, no randomness, no I/O. The same inputs give the same J.
 */

/**
 * The seconds one unit of penalty adds to J at the base weight: 1 s per square inch of clearance
 * shortfall, per square radian of MOUTH_LEADING excess, and per squared fraction of SWEEP_SPEED
 * excess. SET BY HAND: a route 0.5 in inside its margin over ten samples costs 2.5 s, which outweighs
 * any time a margin cut could save on a path of a few seconds. The search doubles the weight for
 * each new start (section 6.3) and passes it to `evaluate`.
 */
export const PENALTY_WEIGHT_S = 1;

/**
 * The seconds added to J for a candidate whose run does not finish its window, or that is
 * infeasible (a step timeout). SET BY HAND: far longer than any autonomous period, so such a
 * candidate never outranks one that finishes, while its own time and penalty still order such
 * candidates among themselves and lead the search back out.
 */
export const OBJECTIVE_BARRIER_S = 1000;

/**
 * Arithmetic slack in seconds when two times are compared, as in "this member ends before the
 * parallel does". It is not a tolerance on the route: one sim tick is 0.01 s (CARRIED OVER:
 * `DEFAULT_TICK_S`), and a time that differs by less than this differs only by float noise.
 */
export const TIME_EPSILON_S = 1e-9;

/** Which time model scores a candidate (section 5.2). */
export type ObjectiveScorer = "sim" | "estimate";

export interface ObjectiveInput {
  auto: Auto;
  robot: Robot;
  field: Field;
  waypoints?: Waypoints;
  /** The season rules, so the instant sim reads the same ledger the editor's preview does. */
  season?: SeasonRules;
  /** The effective id of the path step to optimize, at any depth. */
  stepId: string;
}

export interface ObjectiveOptions {
  /**
   * The safety margin to structures, in inches (section 4.1). The caller reads it from the robot's
   * clearance (D8) or from the card's one-run override; this module has no default of its own.
   */
  marginIn: number;
  /** "estimate" when the person picked Estimate in the card's options. Default "sim". */
  scorer?: ObjectiveScorer;
  /**
   * `sim` scores every candidate with the instant sim; `finalist` scores with the estimate and lets
   * the instant sim re-rank the best few (`rerankFinalists`). Default: the bench's choice,
   * `OPTIMIZE_SCORER_MODE`.
   */
  scorerMode?: ScorerMode;
  /** A condition resolver for the instant sim, as the editor passes one; the step's own endCondition is overridden. */
  conditions?: ConditionResolver;
}

/** The part of the auto a candidate is scored over (section 5.1). */
export interface ScoringWindow {
  /** The path step being optimized. */
  stepId: string;
  /** The index of the top-level step that holds the path: the window's first step. */
  topIndex: number;
  /** The index of the window's last top-level step: `topIndex`, or the step after it. */
  endIndex: number;
  /** The ids of the window's top-level steps, in order. */
  stepIds: string[];
  /** True when the path is not itself a top-level step. */
  nested: boolean;
  /** True when the next top-level step inherits this one's exit, so the window holds it too. */
  includesNext: boolean;
  /** True when the path ends on a condition; it is scored as if the condition never fires. */
  endCondition: boolean;
  /** The path's own `timeoutS`, or null. A candidate that runs past it is infeasible. */
  timeoutS: number | null;
  /**
   * True when the path sits inside a `parallel` whose end something else decides: a slower member,
   * or a deadline that is not the path's. Candidates are then ranked by the path's own time.
   */
  notCriticalPath: boolean;
  /** What the card says about the window, in plain sentences. */
  notes: string[];
}

/** Times under one model, in seconds from the start of the auto (window end) or of the path (own). */
export interface WindowTimes {
  /** When the window ends: the time a critical-path candidate is ranked by. */
  windowEndS: number;
  /** The path step's own time, from its start to its end or the settle after it. */
  ownS: number;
}

/** The penalty of section 6.3, by part, before the weight. */
export interface PenaltyParts {
  /** Squared clearance shortfall on the plan's samples, in square inches (`clearancePenalty`). */
  clearance: number;
  /** The same on the instant sim's poses over the path's own span; 0 when the sim did not run. */
  simClearance: number;
  /** Squared MOUTH_LEADING excess over the tolerance, summed over the running stretches, in square radians. */
  mouthLeading: number;
  /** Squared SWEEP_SPEED excess of the speed fraction over the sweep fraction, once for the step. */
  sweepSpeed: number;
  /** The weight the parts were added up with, in seconds per unit. */
  weightS: number;
  /** `weightS` times the sum of the parts, in seconds: what J adds. */
  totalS: number;
}

export type EvaluationStatus = "scored" | "barrier" | "infeasible";

/** One candidate's J and everything that went into it. */
export interface Evaluation {
  /**
   * `scored`: J is a time plus a penalty. `barrier`: the run did not finish the window, so J carries
   * `OBJECTIVE_BARRIER_S`. `infeasible`: the candidate breaks a hard rule. Past the step's timeout,
   * or with a later step of the window past a timeout the original keeps to, J carries the barrier too; a route the edit refuses (it moves an end) has no time at all, and its
   * J is infinite.
   */
  status: EvaluationStatus;
  /** Why the status is not `scored`, in a sentence; null when it is. */
  reason: string | null;
  /** The objective, in seconds. Lower is better. */
  j: number;
  /** Which model's time J holds. */
  scoredBy: ObjectiveScorer;
  /** The estimate's times. Always computed: the gate between models and the timeline read them. */
  t0: WindowTimes | null;
  /** The instant sim's times, or null when the sim did not score this candidate. */
  t1: WindowTimes | null;
  penalty: PenaltyParts;
  /** True when the planned footprint penetrates a structure or a keep-out, or leaves the field; the sim is then skipped. */
  penetrates: boolean;
  /** The worst clearance shortfall on the plan's samples, or null when none falls short. */
  worst: ClearanceViolation | null;
  /** The same on the sim's poses. */
  simWorst: ClearanceViolation | null;
  /** The auto that was scored, in canonical form; null when the route could not be written into it. */
  scored: CanonicalAuto | null;
}

export interface EvaluateOptions {
  /** The penalty weight in seconds per unit. Default `PENALTY_WEIGHT_S`. */
  penaltyWeightS?: number;
  /**
   * Score with this model instead of the objective's search scorer: finalist mode re-ranks with
   * "sim". A request for "sim" when the objective fell back to the estimate is scored by the estimate.
   */
  scoreWith?: ObjectiveScorer;
}

export interface Objective {
  scoringWindow: ScoringWindow;
  marginIn: number;
  world: ClearanceWorld;
  /** The model that is available for this run: "estimate" when it was chosen or the sim cannot run. */
  scorer: ObjectiveScorer;
  /** For a fallback, the card's sentence saying why; null when the sim runs or Estimate was chosen. */
  scorerReason: string | null;
  /** The model `evaluate` scores with by default: the estimate in finalist mode. */
  searchScorer: ObjectiveScorer;
  /** True when the search scores with the estimate and the instant sim re-ranks the finalists. */
  finalist: boolean;
  /** The original step, as the auto holds it in canonical form. */
  originalStep: PathStep;
  /** The original route's evaluation under the search scorer: candidate 0. */
  original: Evaluation;
  /** J of a candidate route: an emitted path step for `stepId`, keeping both ends. */
  evaluate(step: PathStep, options?: EvaluateOptions): Evaluation;
  /**
   * The footprints the instant sim drives a candidate route through, for the hard final check's
   * margin test on the sim's motion (section 4.4 step 6). Null when the sim does not score this
   * run, or does not finish the candidate's window. It simulates once more and is not part of J.
   */
  simulatedPoses(step: PathStep): SimulatedPoses | null;
}

/**
 * The poses of one simulated window as footprints, in the two runs the final check tests apart,
 * because the last pose of the one and the first pose of the other are not neighbours in a sweep:
 * the path's own span, and what the window holds after it.
 */
export interface SimulatedPoses {
  /** The poses from the path's start until it is done, settle included. */
  path: PlanSample[];
  /** The poses after that to the window's end, when the next step is in the window; else empty. */
  after: PlanSample[];
}

/** Where the path sits in the plan: its top-level step and every parallel on the way down. */
interface Located {
  topIndex: number;
  path: PlanStep;
  /** Every parallel that holds the path, outermost first, with the member on the way to it. */
  parallels: { parallel: PlanStep; member: PlanStep }[];
  /** True when a branch holds the path. */
  inBranch: boolean;
}

function locate(steps: readonly PlanStep[], stepId: string): Located | null {
  const walk = (
    step: PlanStep,
    parallels: Located["parallels"],
    inBranch: boolean,
  ): Omit<Located, "topIndex"> | null => {
    if (step.id === stepId) return { path: step, parallels, inBranch };
    for (const child of step.children ?? []) {
      const below =
        step.kind === "parallel" ? [...parallels, { parallel: step, member: child }] : parallels;
      const found = walk(child, below, inBranch || step.kind === "branch");
      if (found !== null) return found;
    }
    return null;
  };
  for (const [topIndex, top] of steps.entries()) {
    const found = walk(top, [], false);
    if (found !== null) return { topIndex, ...found };
  }
  return null;
}

/** The step that starts first when `step` starts: the first member of a sequence, however deep. */
function firstToRun(step: PlanStep): PlanStep {
  let first = step;
  while (first.kind === "sequence" && first.children !== undefined && first.children.length > 0) {
    first = first.children[0] as PlanStep;
  }
  return first;
}

/**
 * The window's shape, from the plan alone (section 5.1). The next top-level step joins the window
 * when it inherits the exit: when the robot does not hold its end (`holdEnd` false), so the next
 * step starts on whatever speed is left, or when the next step starts with a path, since then the
 * runtime never waits for the end constraints and the next path takes over still moving (ADR 0003).
 * Whether the path is on the critical path needs a run, so `createObjective` fills that in.
 */
export function scoringWindowShape(
  planned: Plan,
  robot: Robot,
  stepId: string,
): Omit<ScoringWindow, "notCriticalPath" | "notes"> {
  const found = locate(planned.steps, stepId);
  if (found === null) throw new Error(`No step with id ${JSON.stringify(stepId)} in the plan.`);
  if (found.path.step.kind !== "path") {
    throw new Error(`Step ${JSON.stringify(stepId)} is a ${found.path.step.kind} step, and only a path can be optimized.`);
  }
  const next = planned.steps[found.topIndex + 1];
  const includesNext = next !== undefined && (!robotLimits(robot).holdEnd || firstToRun(next).kind === "path");
  const endIndex = includesNext ? found.topIndex + 1 : found.topIndex;
  const path = found.path.step;
  return {
    stepId,
    topIndex: found.topIndex,
    endIndex,
    stepIds: planned.steps.slice(found.topIndex, endIndex + 1).map((step) => step.id),
    nested: (planned.steps[found.topIndex] as PlanStep).id !== stepId,
    includesNext,
    endCondition: path.endCondition !== undefined,
    timeoutS: path.timeoutS ?? null,
  };
}

/** The top-level record of a step in a trace. */
const topRecord = (trace: SimTrace, id: string): SimStepRecord | undefined =>
  trace.steps.find((record) => record.id === id && record.parentId === null);

const recordOf = (trace: SimTrace, id: string): SimStepRecord | undefined =>
  trace.steps.find((record) => record.id === id);

/**
 * The ids of the steps a timeout ended inside the window, at any depth, in trace order. A record is
 * inside the window when its top-level step is one of the window's.
 */
function windowTimeouts(trace: SimTrace, stepIds: readonly string[]): string[] {
  const inWindow = new Set(stepIds);
  const byId = new Map<string, SimStepRecord>();
  for (const record of trace.steps) if (!byId.has(record.id)) byId.set(record.id, record);
  const topOf = (record: SimStepRecord): string => {
    let at = record;
    for (let parent = at.parentId; parent !== null; parent = at.parentId) {
      const up = byId.get(parent);
      if (up === undefined) return parent;
      at = up;
    }
    return at.id;
  };
  return trace.steps.filter((record) => record.timedOut && inWindow.has(topOf(record))).map((record) => record.id);
}

/** When a record is done with: after its settle when it has one, else at its end. */
const doneS = (record: SimStepRecord): number => record.settledS ?? record.endS;

/** The estimate's seconds of the steps before and through `endIndex`, unknowns counted as 0. */
function estimateWindowEndS(result: Estimate, endIndex: number): number {
  let total = 0;
  for (const row of result.steps.slice(0, endIndex + 1)) total += row.nominalS ?? 0;
  return total;
}

/**
 * Whether the path decides when its parallels end, read from one model's timing of the original.
 * A parallel whose deadline is another member, or whose member holding the path ends before the
 * group does, waits on something slower.
 */
function offCriticalPath(
  located: Located,
  endOf: (step: PlanStep) => number | null,
): boolean {
  for (const { parallel, member } of located.parallels) {
    const group = parallel.step;
    if (group.kind !== "parallel") continue;
    if (group.mode === "deadline" && group.deadline !== undefined && member.id !== group.deadline) return true;
    const memberEnd = endOf(member);
    const groupEnd = endOf(parallel);
    if (memberEnd !== null && groupEnd !== null && memberEnd < groupEnd - TIME_EPSILON_S) return true;
  }
  return false;
}

/**
 * Why the instant sim cannot score this routine, as the fragment the card's sentence closes on, or
 * null when it can. It cannot when it fails, when a `movesRobot` command runs before the window
 * ends (the sim does not drive it, so every pose after it is fiction), when the time runs out
 * before the window ends, or when it never drives the path (a branch side it does not take).
 */
function simRefusal(
  planned: Plan,
  robot: Robot,
  scoringWindow: Omit<ScoringWindow, "notCriticalPath" | "notes">,
  located: Located,
  base: SimRun | Error,
): string | null {
  if (base instanceof Error) return `it stopped with an error: ${base.message.replace(/\.$/, "")}`;
  const moving = new Set(robot.commands.filter((command) => command.movesRobot === true).map((command) => command.name));
  for (const step of flattenSteps(planned.steps.slice(0, scoringWindow.endIndex + 1))) {
    if (step.step.kind === "command" && moving.has(step.step.name)) {
      return `step ${JSON.stringify(step.id)} runs ${JSON.stringify(step.step.name)}, which moves the robot in ways the instant sim does not drive`;
    }
  }
  const last = scoringWindow.stepIds[scoringWindow.stepIds.length - 1] as string;
  const lastRecord = topRecord(base.trace, last);
  if (lastRecord === undefined || lastRecord.interrupted) {
    return `the time ran out before step ${JSON.stringify(last)} ended`;
  }
  if (recordOf(base.trace, located.path.id) === undefined) {
    return located.inBranch
      ? `it never drives step ${JSON.stringify(located.path.id)}, which is on a branch side the sim does not take`
      : `it never drives step ${JSON.stringify(located.path.id)}`;
  }
  return null;
}

/** The plan step of the path in a plan of the candidate auto. */
function pathIn(planned: Plan, stepId: string): PlanStep | undefined {
  return flattenSteps(planned.steps).find((step) => step.id === stepId);
}

/** The footprint at each simulated pose from `fromS` to `toS`, as samples the clearance code reads. */
function simSamples(trace: SimTrace, robot: Robot, fromS: number, toS: number): PlanSample[] {
  const from = fromS - TIME_EPSILON_S;
  const to = toS + TIME_EPSILON_S;
  const samples: PlanSample[] = [];
  for (const row of trace.poses) {
    if (row[0] < from || row[0] > to) continue;
    const pose = { xIn: row[1], yIn: row[2], headingRad: row[3] };
    const footprint = footprintAt(pose, robot, "expandedIn");
    samples.push({ sIn: 0, t: 0, pose, footprintIn: footprint.bodyIn, mouthsIn: footprint.mouthsIn });
  }
  return samples;
}

/**
 * True when a footprint actually penetrates something, not just its margin: a structure or a
 * keep-out by more than float noise, or a wall by more than the slack `check()` gives the walls.
 */
function penetratesAny(world: ClearanceWorld, samples: readonly PlanSample[]): boolean {
  const measured = measureClearances(world, samples);
  const below = (rows: readonly number[], limit: number): boolean => rows.some((value) => value < limit);
  return (
    measured.structuresIn.some((rows) => below(rows, -CLEARANCE_EPSILON_IN)) ||
    measured.keepOutsIn.some((rows) => below(rows, -CLEARANCE_EPSILON_IN)) ||
    below(measured.wallsIn, -PERIMETER_TOLERANCE_IN)
  );
}

const square = (value: number): number => (value > 0 ? value * value : 0);

/** The penalty parts measured on the plan: clearance, MOUTH_LEADING and SWEEP_SPEED. */
function planPenalties(
  planned: Plan,
  path: PlanStep,
  robot: Robot,
  world: ClearanceWorld,
  marginIn: number,
): { clearance: number; mouthLeading: number; sweepSpeed: number; worst: ClearanceViolation | null } {
  const clearance = clearancePenalty(world, path.samples, marginIn);
  const active = intakeTimeline(planned.steps, robot).byStepId.get(path.id);
  let mouthLeading = 0;
  for (const stretch of mouthLeadingStretches(path, robot, active)) {
    mouthLeading += square(stretch.deviationRad - MOUTH_LEADING_TOLERANCE_RAD);
  }
  const sweep = sweepSpeedReading(path, robot, active);
  const sweepSpeed = sweep === null ? 0 : square(sweep.speedFraction - sweep.sweepFraction);
  return { clearance: clearance.penalty, mouthLeading, sweepSpeed, worst: clearance.worst };
}

const parts = (
  weightS: number,
  values: { clearance: number; simClearance: number; mouthLeading: number; sweepSpeed: number },
): PenaltyParts => ({
  ...values,
  weightS,
  totalS: weightS * (values.clearance + values.simClearance + values.mouthLeading + values.sweepSpeed),
});

/**
 * Why a candidate gets the barrier: the base run finished the window, but this candidate's own run
 * did not before the time ran out.
 */
const windowNotFinished = (id: string): string =>
  `The instant sim ran out of time before step ${JSON.stringify(id)} ended.`;

/**
 * Builds the objective for one optimization: plans, estimates and simulates the original once, and
 * returns `evaluate` for the candidates. Throws for a step id that is not a path in the auto.
 */
export function createObjective(input: ObjectiveInput, options: ObjectiveOptions): Objective {
  const { robot, field, waypoints, season, stepId } = input;
  const marginIn = options.marginIn;
  if (!(marginIn >= 0) || !Number.isFinite(marginIn)) {
    throw new Error("The safety margin must be a number of inches of at least 0.");
  }
  const base = canonicalAuto(input.auto);
  const basePlan = plan(resolve(base.auto, waypoints, robot), robot, field);
  const shape = scoringWindowShape(basePlan, robot, stepId);
  const located = locate(basePlan.steps, stepId) as Located;
  const originalStep = located.path.step as PathStep;
  // The other alliance's side is a keep-out when the season names the side the robot stays on (issue #365).
  const world = clearanceWorld(robot, field, season?.ownSide?.(field, base.auto.alliance) ?? null);

  // The path's own endCondition never fires (section 5.1): the upper bound the estimate also uses.
  const userConditions = options.conditions;
  const conditions: ConditionResolver | undefined =
    shape.endCondition || userConditions !== undefined
      ? (query) => (query.kind === "endCondition" && query.stepId === stepId ? null : userConditions?.(query))
      : undefined;
  const lastId = shape.stepIds[shape.stepIds.length - 1] as string;
  const simOptionsFor = (planned: Plan): SimOptions => ({
    ...(season === undefined ? {} : { ledger: runLedger(planned, field, season), season }),
    ...(conditions === undefined ? {} : { conditions }),
    stopAfterStepId: lastId,
  });

  // The base run, once: the checkpoint at the window's first step is what every candidate resumes from.
  const requested: ObjectiveScorer = options.scorer ?? "sim";
  let baseRun: SimRun | null = null;
  let scorerReason: string | null = null;
  if (requested === "sim") {
    let run: SimRun | Error;
    try {
      run = simulateRun(basePlan, robot, field, simOptionsFor(basePlan));
    } catch (error) {
      run = error instanceof Error ? error : new Error(String(error));
    }
    const refusal = simRefusal(basePlan, robot, shape, located, run);
    if (refusal === null) baseRun = run as SimRun;
    else scorerReason = `Scored by the estimate: the instant sim could not run this routine (${refusal}).`;
  }
  const scorer: ObjectiveScorer = baseRun === null ? "estimate" : "sim";

  // A timeout cuts a step short, and the window's end with it, so a later step of the window that a
  // candidate makes run past its timeout would read as a gain (section 5.2, J rule 3). Only a
  // timeout the original does not already run into counts against a candidate; the path's own
  // timeout is ruled on apart, since a route past it is infeasible whatever the original does.
  const windowIds = new Set(flattenSteps(basePlan.steps.slice(shape.topIndex, shape.endIndex + 1)).map((step) => step.id));
  const baseSimTimeouts = new Set(baseRun === null ? [] : windowTimeouts(baseRun.trace, shape.stepIds));
  const newSimTimeout = (trace: SimTrace): string | null =>
    windowTimeouts(trace, shape.stepIds).find((id) => id !== stepId && !baseSimTimeouts.has(id)) ?? null;
  const cappedIds = (result: Estimate): string[] =>
    [...windowIds].filter((id) => id !== stepId && result.byStepId[id]?.uncappedS !== undefined);
  const timeoutOf = (planned: Plan, id: string): string => {
    const step = flattenSteps(planned.steps).find((found) => found.id === id)?.step;
    return step !== undefined && "timeoutS" in step && step.timeoutS !== undefined ? `${String(step.timeoutS)} s ` : "";
  };
  const finalist = scorer === "sim" && (options.scorerMode ?? OPTIMIZE_SCORER_MODE) === "finalist";
  const searchScorer: ObjectiveScorer = finalist ? "estimate" : scorer;

  // Whether the path decides the window's end, read from the model the search ranks by.
  const baseEstimate = estimate(basePlan, robot);
  const baseCapped = new Set(cappedIds(baseEstimate));
  const notCriticalPath = offCriticalPath(located, (step) => {
    if (searchScorer === "sim" && baseRun !== null) {
      const record = recordOf(baseRun.trace, step.id);
      return record === undefined ? null : doneS(record);
    }
    // The estimate has no start times inside a parallel: its members all start with the group,
    // so their seconds compare as end times.
    return baseEstimate.byStepId[step.id]?.nominalS ?? null;
  });

  const notes: string[] = [];
  if (notCriticalPath) {
    notes.push("This path is not on the critical path. Candidates are ranked by the path's own time.");
  }
  if (shape.endCondition) {
    notes.push("This path ends on a condition. It is scored as if the condition never fires, so it may end early.");
  }
  const scoringWindow: ScoringWindow = { ...shape, notCriticalPath, notes };
  const ranked = (times: WindowTimes): number => (notCriticalPath ? times.ownS : times.windowEndS);

  const evaluate = (step: PathStep, evaluateOptions: EvaluateOptions = {}): Evaluation => {
    const weightS = evaluateOptions.penaltyWeightS ?? PENALTY_WEIGHT_S;
    const scoreWith: ObjectiveScorer = scorer === "estimate" ? "estimate" : (evaluateOptions.scoreWith ?? searchScorer);
    const zero = { clearance: 0, simClearance: 0, mouthLeading: 0, sweepSpeed: 0 };

    let scored: CanonicalAuto;
    try {
      scored = autoWithRoute(base.auto, stepId, step);
    } catch (error) {
      return {
        status: "infeasible",
        reason: error instanceof Error ? error.message : String(error),
        j: Number.POSITIVE_INFINITY,
        scoredBy: scoreWith,
        t0: null,
        t1: null,
        penalty: parts(weightS, zero),
        penetrates: false,
        worst: null,
        simWorst: null,
        scored: null,
      };
    }

    // 1. Plan the auto with the step replaced, and estimate it (T0).
    const planned = plan(resolve(scored.auto, waypoints, robot), robot, field);
    const path = pathIn(planned, stepId) as PlanStep;
    const estimated = estimate(planned, robot);
    const own = estimated.byStepId[stepId];
    const t0: WindowTimes = { windowEndS: estimateWindowEndS(estimated, scoringWindow.endIndex), ownS: own?.nominalS ?? 0 };

    // 2. The penalties on the plan's samples.
    const fromPlan = planPenalties(planned, path, robot, world, marginIn);
    const penetrates = penetratesAny(world, path.samples);
    const planParts = { ...zero, clearance: fromPlan.clearance, mouthLeading: fromPlan.mouthLeading, sweepSpeed: fromPlan.sweepSpeed };

    const result = (
      status: EvaluationStatus,
      reason: string | null,
      scoredBy: ObjectiveScorer,
      t1: WindowTimes | null,
      penalty: PenaltyParts,
      simWorst: ClearanceViolation | null,
    ): Evaluation => {
      const time = scoredBy === "sim" && t1 !== null ? ranked(t1) : ranked(t0);
      const barrier = status === "scored" ? 0 : OBJECTIVE_BARRIER_S;
      return {
        status,
        reason,
        j: barrier + time + penalty.totalS,
        scoredBy,
        t0,
        t1,
        penalty,
        penetrates,
        worst: fromPlan.worst,
        simWorst,
        scored,
      };
    };

    // A timeout the estimate already runs past is infeasible under either model.
    if (scoringWindow.timeoutS !== null && own?.uncappedS !== undefined) {
      return result(
        "infeasible",
        `The route takes ${own.uncappedS.toFixed(2)} s by the estimate, past the step's ${String(scoringWindow.timeoutS)} s timeout.`,
        "estimate",
        null,
        parts(weightS, planParts),
        null,
      );
    }
    const capped = cappedIds(estimated).find((id) => !baseCapped.has(id));
    if (capped !== undefined) {
      return result(
        "infeasible",
        `Step ${JSON.stringify(capped)} runs past its ${timeoutOf(planned, capped)}timeout by the estimate with this route.`,
        "estimate",
        null,
        parts(weightS, planParts),
        null,
      );
    }
    // If the nominal path penetrates anything, J is the estimate plus the penalty and the sim is skipped.
    if (scoreWith === "estimate" || penetrates || baseRun === null) {
      return result("scored", null, "estimate", null, parts(weightS, planParts), null);
    }

    // 3. The instant sim from the base run's checkpoint at the window's first step (T1).
    const run = resimulate(baseRun, planned, robot, field, simOptionsFor(planned), scoringWindow.topIndex);
    const lastRecord = topRecord(run.trace, lastId);
    const pathRecord = recordOf(run.trace, stepId);
    if (lastRecord === undefined || lastRecord.interrupted || pathRecord === undefined) {
      return result("barrier", windowNotFinished(lastId), "estimate", null, parts(weightS, planParts), null);
    }
    const t1: WindowTimes = { windowEndS: doneS(lastRecord), ownS: doneS(pathRecord) - pathRecord.startS };
    const fromSim = clearancePenalty(world, simSamples(run.trace, robot, pathRecord.startS, doneS(pathRecord)), marginIn);
    const penalty = parts(weightS, { ...planParts, simClearance: fromSim.penalty });
    if (pathRecord.timedOut) {
      return result(
        "infeasible",
        `The route runs past the step's ${String(scoringWindow.timeoutS)} s timeout in the instant sim.`,
        "sim",
        t1,
        penalty,
        fromSim.worst,
      );
    }
    const timedOut = newSimTimeout(run.trace);
    if (timedOut !== null) {
      return result(
        "infeasible",
        `Step ${JSON.stringify(timedOut)} runs past its ${timeoutOf(planned, timedOut)}timeout in the instant sim with this route.`,
        "sim",
        t1,
        penalty,
        fromSim.worst,
      );
    }
    return result("scored", null, "sim", t1, penalty, fromSim.worst);
  };

  const simulatedPoses = (step: PathStep): SimulatedPoses | null => {
    if (baseRun === null) return null;
    let scored: CanonicalAuto;
    try {
      scored = autoWithRoute(base.auto, stepId, step);
    } catch {
      return null;
    }
    const planned = plan(resolve(scored.auto, waypoints, robot), robot, field);
    const run = resimulate(baseRun, planned, robot, field, simOptionsFor(planned), scoringWindow.topIndex);
    const lastRecord = topRecord(run.trace, lastId);
    const pathRecord = recordOf(run.trace, stepId);
    if (lastRecord === undefined || lastRecord.interrupted || pathRecord === undefined) return null;
    // A timeout the original does not run into ends the window early, so the poses are not the
    // window's: the route does not finish the stretch that is scored.
    if (newSimTimeout(run.trace) !== null) return null;
    const pathDoneS = doneS(pathRecord);
    const windowDoneS = doneS(lastRecord);
    return {
      path: simSamples(run.trace, robot, pathRecord.startS, pathDoneS),
      after: windowDoneS > pathDoneS + TIME_EPSILON_S ? simSamples(run.trace, robot, pathDoneS, windowDoneS) : [],
    };
  };

  return {
    scoringWindow,
    marginIn,
    world,
    scorer,
    scorerReason,
    searchScorer,
    finalist,
    originalStep,
    original: evaluate(originalStep),
    evaluate,
    simulatedPoses,
  };
}

/** A candidate route with its evaluation, as the search keeps them. */
export interface ScoredCandidate {
  step: PathStep;
  evaluation: Evaluation;
}

/**
 * Finalist mode (section 5.2): the `count` best candidates by the estimate's J, re-scored by the
 * instant sim and ordered by that J. Equal J keeps the estimate's order, and the estimate's order
 * keeps the order the candidates came in, so the result is the same on every run. When the
 * objective has no sim (chosen or fallen back), the estimate's best `count` are returned as they are.
 */
export function rerankFinalists(
  objective: Objective,
  candidates: readonly ScoredCandidate[],
  count: number = FINALIST_COUNT,
  options: Omit<EvaluateOptions, "scoreWith"> = {},
): ScoredCandidate[] {
  const best = candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => a.candidate.evaluation.j - b.candidate.evaluation.j || a.index - b.index)
    .slice(0, Math.max(0, count))
    .map(({ candidate }) => candidate);
  if (objective.scorer === "estimate") return best;
  return best
    .map((candidate, index) => ({
      candidate: { step: candidate.step, evaluation: objective.evaluate(candidate.step, { ...options, scoreWith: "sim" }) },
      index,
    }))
    .sort((a, b) => a.candidate.evaluation.j - b.candidate.evaluation.j || a.index - b.index)
    .map(({ candidate }) => candidate);
}
