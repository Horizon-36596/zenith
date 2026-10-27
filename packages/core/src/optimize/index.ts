import type { Heading, PathStep, Segment } from "@horizon36596/zenith-schema";
import { PERIMETER_TOLERANCE_IN } from "../check.js";
import { intakeTimeline } from "../checks/intake.js";
import { formatNumber } from "../canonicalize.js";
import { makePath } from "../geometry/path.js";
import { distance } from "../geometry/vec.js";
import { sha256Hex, stableJson } from "../hash.js";
import { robotClearanceIn, robotLimits } from "../kinematics.js";
import { flattenSteps, plan } from "../plan.js";
import { resolve, type ResolvedStep } from "../resolve.js";
import type { Finding, Plan, PlanSample, PlanStep } from "../types.js";
import { OPTIMIZE_DEFAULT_BUDGET } from "./budget.js";
import { canonicalAuto, routeEndsOf, type RouteEnds } from "./candidate.js";
import {
  CENTRE_LINE_KEEPOUT_ID,
  CLEARANCE_EPSILON_IN,
  clearanceWorld,
  keepOutWords,
  measureClearances,
  type ClearanceViolation,
  type ClearanceWorld,
} from "./clearance.js";
import {
  choosePick,
  createFinalCheck,
  MAX_ALTERNATIVES,
  MIN_TIME_GAIN_S,
  pickable,
  PLANNED_PATH_ONLY_NOTE,
  SHORTFALL_TOLERANCE_IN,
  type AcceptedRoute,
  type FinalCheck,
} from "./final.js";
import { DEFAULT_HEADING_MODE, type DefaultHeadingMode } from "./headingDp.js";
import { holdsActive, holdWords, type HeadingHolds } from "./holds.js";
import { routeClassOf, sameRouteClass } from "./homotopy.js";
import { createObjective, TIME_EPSILON_S, type Evaluation, type Objective, type ObjectiveScorer } from "./objective.js";
import {
  checkFinalists,
  DEFAULT_BATCH_SIZE,
  DEFAULT_MAX_PATHS,
  finalistOrder,
  headingAllowed,
  jAtWeight,
  searchRoutes,
  timeOf,
  type SearchEntry,
  type SearchOutcome,
} from "./search.js";
import type {
  ClosestAttempt,
  ClosestClearance,
  MovedMarker,
  OptimizeCommand,
  OptimizedRoute,
  OptimizeInput,
  OptimizeMode,
  OptimizeOptions,
  OptimizeProgress,
  OptimizeResult,
  OptimizeStatus,
  OriginalBlocked,
} from "./types.js";

/**
 * Optimize path's entry points (issue #302).
 *
 * `optimizeRoute(input, options)` is a generator: it sets up the objective, refuses a step whose own
 * end overlaps something, runs the search (`search.ts`) and yields its progress, then runs the hard
 * final check (`final.ts`) on the best routes it found, picks one with the gate between models, and
 * returns an `OptimizeResult` with the moved markers, the findings it adds and removes, plain change
 * sentences and an `inputKey`. `runOptimize` drains it, for the CLI, the MCP server and tests.
 *
 * Every result has passed the final check: the optimizer never returns a route that fails it.
 *
 * Pure (CLAUDE.md rule 1): no clock, no randomness, no I/O. On one JS engine the same inputs and
 * options give byte-identical results, and a run stopped after N evaluations is reproduced by a
 * budget of N.
 */

export * from "./types.js";

/**
 * The most routes the final check is run on in one optimization (SET BY HAND: each costs a few
 * plans, a `check()` and a simulation, about what twenty evaluations cost, so a dozen keeps the
 * final check well under the budget's own time while leaving room for a pick that the swept test
 * refuses).
 */
export const FINAL_CHECK_LIMIT = 12;

/**
 * The most seeds the final check is run on to find an alternative that goes round the obstacles
 * another way (SET BY HAND: issue #310, one for each of the up to three visibility routes Yen's
 * search gives, which are the seeds that differ in their way round; each costs what a route of the
 * search's own costs the check).
 */
export const SEED_CHECK_LIMIT = 3;

/**
 * The most routes the final check is run on to find one that is faster in the estimate and slower in
 * the instant sim, offered as an alternative (SET BY HAND: issue #448, as `SEED_CHECK_LIMIT`; each
 * costs what one route of the search's own costs the check).
 */
export const ESTIMATE_ONLY_CHECK_LIMIT = 3;

/** The options with every default filled in: what decides the result, and so what `inputKey` hashes. */
export interface ResolvedOptimizeOptions {
  marginIn: number;
  budget: number;
  scorer: ObjectiveScorer;
  mode: OptimizeMode;
  allowSplit: boolean;
  allowRanges: boolean;
  allowTurnFirst: false;
  maxPaths: number;
  defaultHeadingMode: DefaultHeadingMode;
  routeAround: boolean;
  /** The heading holds, in inches; 0 is off (issue #448). */
  holdStartHeadingIn: number;
  holdEndHeadingIn: number;
}

const MODES: readonly OptimizeMode[] = ["routeAndHeading", "headingOnly", "routeOnly"];

/** The options with their defaults, checked. Throws for an option the search cannot run with. */
export function resolveOptimizeOptions(input: OptimizeInput, options: OptimizeOptions = {}): ResolvedOptimizeOptions {
  const marginIn = options.marginIn ?? robotClearanceIn(input.robot);
  if (!Number.isFinite(marginIn) || marginIn < 0) throw new Error("The safety margin must be a number of inches of at least 0.");
  const budget = options.budget ?? OPTIMIZE_DEFAULT_BUDGET;
  if (!Number.isInteger(budget) || budget < 1) throw new Error("The budget must be a whole number of evaluations, at least 1.");
  const maxPaths = options.maxPaths ?? DEFAULT_MAX_PATHS;
  if (!Number.isInteger(maxPaths) || maxPaths < 1) throw new Error("maxPaths must be a whole number of at least 1.");
  const mode = options.mode ?? "routeAndHeading";
  if (!MODES.includes(mode)) throw new Error(`The mode must be one of ${MODES.join(", ")}.`);
  const scorer = options.scorer ?? "sim";
  if (scorer !== "sim" && scorer !== "estimate") throw new Error('The scorer must be "sim" or "estimate".');
  if ((options.allowTurnFirst as boolean | undefined) === true) {
    throw new Error("A turn on the spot before driving needs the D10 step, which the optimizer does not write yet.");
  }
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("The batch size must be a whole number of evaluations, at least 1.");
  const holdStartHeadingIn = options.holdStartHeadingIn ?? 0;
  const holdEndHeadingIn = options.holdEndHeadingIn ?? 0;
  for (const value of [holdStartHeadingIn, holdEndHeadingIn]) {
    if (!Number.isFinite(value) || value < 0) throw new Error("A heading hold must be a number of inches of at least 0, and 0 is off.");
  }
  const routeAround = options.routeAround ?? false;
  if (routeAround && mode === "headingOnly") {
    throw new Error("Route around moves the geometry, and the headingOnly mode keeps it: use routeAndHeading or routeOnly.");
  }
  return {
    marginIn,
    budget,
    scorer,
    mode,
    allowSplit: options.allowSplit ?? true,
    allowRanges: options.allowRanges ?? true,
    allowTurnFirst: false,
    maxPaths,
    defaultHeadingMode: options.defaultHeadingMode ?? DEFAULT_HEADING_MODE,
    routeAround,
    holdStartHeadingIn,
    holdEndHeadingIn,
  };
}

/** The heading holds of resolved options. */
export const holdsOf = (settings: ResolvedOptimizeOptions): HeadingHolds => ({
  startIn: settings.holdStartHeadingIn,
  endIn: settings.holdEndHeadingIn,
});

/** A hash of the inputs and the options that decide the result (spec 16 section 7). The batch size does not. */
export function optimizeInputKey(input: OptimizeInput, settings: ResolvedOptimizeOptions): string {
  // Route around is part of the key only when it is on, and each heading hold only when it is not 0,
  // so every key made before them stays what it was.
  const { routeAround, holdStartHeadingIn, holdEndHeadingIn, ...rest } = settings;
  const decisive = {
    ...rest,
    ...(routeAround ? { routeAround } : {}),
    ...(holdStartHeadingIn > 0 ? { holdStartHeadingIn } : {}),
    ...(holdEndHeadingIn > 0 ? { holdEndHeadingIn } : {}),
  };
  return sha256Hex(
    stableJson({
      auto: canonicalAuto(input.auto).text,
      robot: input.robot,
      field: input.field,
      waypoints: input.waypoints ?? null,
      season: input.season?.id ?? null,
      stepId: input.stepId,
      options: decisive,
    }),
  );
}

function flattenResolved(steps: readonly ResolvedStep[]): ResolvedStep[] {
  return steps.flatMap((step) => [step, ...flattenResolved(step.children ?? [])]);
}

const seconds = (value: number): string => `${value.toFixed(2)} s`;
const inches = (value: number): string => `${formatNumber(Math.round(value * 1000) / 1000, 3)} in`;

/** What a footprint overlaps, in words, for a violation. */
function describeThing(kind: ClearanceViolation["kind"], id: string | null): string {
  if (kind === "structure") return `the structure ${JSON.stringify(id)}`;
  if (kind === "keepOut") return keepOutWords(id);
  return "the field wall";
}

/** The first thing the footprint at a lone sample overlaps, or null: structures, keep-outs, then the wall. */
function overlapAt(world: ClearanceWorld, sample: PlanSample): { kind: ClearanceViolation["kind"]; id: string | null; shortfallIn: number } | null {
  const measured = measureClearances(world, [sample]);
  for (const [k, structure] of world.structures.entries()) {
    const value = measured.structuresIn[k]?.[0] as number;
    if (value < -CLEARANCE_EPSILON_IN) return { kind: "structure", id: structure.id, shortfallIn: -value };
  }
  for (const [k, keepOut] of world.keepOuts.entries()) {
    const value = measured.keepOutsIn[k]?.[0] as number;
    if (value < -CLEARANCE_EPSILON_IN) return { kind: "keepOut", id: keepOut.id, shortfallIn: -value };
  }
  const wall = measured.wallsIn[0] as number;
  if (wall < -PERIMETER_TOLERANCE_IN) return { kind: "wall", id: null, shortfallIn: -wall };
  return null;
}

/** The plan step of the path in a plan. */
const pathIn = (planned: Plan, stepId: string): PlanStep | undefined => flattenSteps(planned.steps).find((step) => step.id === stepId);

/** What one end of a path step overlaps, which no route between its ends can change. */
export interface EndOverlap {
  end: "start" | "end";
  kind: ClearanceViolation["kind"];
  /** The structure's or keep-out's id; null for the wall. */
  id: string | null;
  shortfallIn: number;
}

/**
 * The first end of path step `stepId` whose footprint overlaps a structure, a keep-out (with the
 * other alliance's side when the season names one) or the wall, or null when both ends are clear
 * or the step is not a path. It is the test `optimizeRoute` makes before it searches, on its own, so
 * the editor can refuse a clear path to a blocked spot at once instead of after a run.
 */
export function stepEndOverlap(input: OptimizeInput): EndOverlap | null {
  const { robot, field, waypoints, season, stepId } = input;
  const base = canonicalAuto(input.auto);
  const planned = pathIn(plan(resolve(base.auto, waypoints, robot), robot, field), stepId);
  if (planned === undefined) return null;
  const world = clearanceWorld(robot, field, season?.ownSide?.(field, base.auto.alliance) ?? null);
  const samples = planned.samples;
  const ends: ["start" | "end", PlanSample | undefined][] = [["start", samples[0]], ["end", samples[samples.length - 1]]];
  for (const [end, sample] of ends) {
    const overlap = sample === undefined ? null : overlapAt(world, sample);
    if (overlap !== null) return { end, ...overlap };
  }
  return null;
}

/** The closest a planned path comes to a structure or a keep-out, or null when there is none. */
function closestClearance(world: ClearanceWorld, samples: readonly PlanSample[]): ClosestClearance | null {
  const measured = measureClearances(world, samples);
  let closest: ClosestClearance | null = null;
  const consider = (kind: ClosestClearance["kind"], id: string, values: readonly number[]): void => {
    for (const value of values) if (closest === null || value < closest.clearanceIn) closest = { kind, id, clearanceIn: value };
  };
  world.structures.forEach((structure, k) => consider("structure", structure.id, measured.structuresIn[k] ?? []));
  world.keepOuts.forEach((keepOut, k) => consider("keepOut", keepOut.id, measured.keepOutsIn[k] ?? []));
  return closest;
}

/** Where each marker fires on a planned path, along its arc length, as `at` places it (spec 16 section 2). */
function markerPoints(step: PathStep, planned: PlanStep): { xIn: number; yIn: number }[] {
  const geometry = planned.geometry;
  if (geometry === undefined) return [];
  const lengthIn = geometry.lengthIn;
  return (step.markers ?? []).map((marker) => {
    const at = marker.at;
    const sIn = "t" in at ? at.t * lengthIn : "distanceIn" in at ? Math.min(lengthIn, at.distanceIn) : Math.max(0, lengthIn - at.distanceFromEndIn);
    return geometry.pointAtDistance(sIn);
  });
}

/** Every marker that moves on the field by more than the canonical inch resolution (spec 16 section 2). */
function movedMarkers(step: PathStep, before: PlanStep, after: PlanStep): MovedMarker[] {
  const from = markerPoints(step, before);
  const to = markerPoints(step, after);
  const moved: MovedMarker[] = [];
  for (const [index, marker] of (step.markers ?? []).entries()) {
    const a = from[index];
    const b = to[index];
    if (a === undefined || b === undefined) continue;
    const movedIn = distance(a, b);
    if (movedIn > 0.001) moved.push({ index, name: marker.command.name, at: marker.at, fromIn: a, toIn: b, movedIn });
  }
  return moved;
}

const MODE_NAMES: Record<Heading["mode"], string> = {
  tangent: "Tangent",
  tangentReversed: "Reversed tangent",
  linear: "Linear",
  constant: "Constant",
  facePoint: "Face point",
  piecewise: "Piecewise",
};

function describeHeading(heading: Heading | undefined): string {
  if (heading === undefined) return "none";
  if (heading.mode !== "piecewise") return MODE_NAMES[heading.mode];
  return `Piecewise: ${heading.ranges.map((range) => MODE_NAMES[range.heading.mode]).join(", then ")}`;
}

function describeSegment(segment: Segment): string {
  if (segment.kind === "line") return "a line";
  return ["", "a quadratic Bezier", "a cubic Bezier", "a quartic Bezier"][segment.control.length] ?? "a Bezier";
}

const describeFinding = (finding: Finding): string => `${finding.code} ${finding.severity} on step ${JSON.stringify(finding.stepId)}`;

/**
 * The card's first sentence on a route's time under `model`. It says the same time to the hundredth
 * of a second rather than "0.00 s faster" or "0.00 s slower". A route round a blocked original,
 * which may be slower, gets `blockedRouteSentence` instead.
 */
export function timeComparisonSentence(gainS: number, model: "the instant sim" | "the estimate"): string {
  const shown = seconds(Math.abs(gainS));
  if (shown === seconds(0)) return `It takes the same time in ${model}, to the hundredth of a second.`;
  return `It is ${shown} ${gainS < 0 ? "slower" : "faster"} in ${model}.`;
}

/**
 * How far inside the margin an end must be, in inches, to count as within it: CLEARANCE's own slack
 * for a footprint exactly one margin clear, so an end the check passes is not said to be inside.
 */
const END_MARGIN_SLACK_IN = 1e-6;

/** True when the original is blocked by coming within the margin, which only Route around asks a route to clear. */
const keepsMargin = (blocked: OriginalBlocked): boolean => blocked.code === "CLEARANCE";

/**
 * The first sentence on a route round a blocked original, one `check()` finds going through something
 * (issue #388) or, for Route around, one that comes within the margin: what the original does, that
 * the pick is the fastest clear route found (the fastest that keeps the margin) or that an
 * alternative is clear too, and its time against the original under `model`, which may be slower.
 * Without a time (`gainS` null) it says only the first part.
 *
 * With `endWithinMargin`, the step's own start or end is itself within the margin. Route around
 * keeps both ends where they are, so no route keeps the margin there and the warning stays after
 * Apply; the sentence says so rather than claim the margin is kept (0.1.2 UX sweep W2-4).
 */
export function blockedRouteSentence(
  blocked: OriginalBlocked,
  gainS: number | null,
  model: "the instant sim" | "the estimate",
  role: "pick" | "alternative" = "pick",
  endWithinMargin = false,
): string {
  const clear = keepsMargin(blocked)
    ? endWithinMargin
      ? role === "pick"
        ? "and its own end is within the margin, which Route around cannot move, so this is the fastest route found that keeps the margin everywhere else"
        : "and its own end is within the margin, which Route around cannot move; this route keeps the margin everywhere else"
      : role === "pick"
        ? "so this is the fastest route found that keeps the margin"
        : "and this route keeps the margin"
    : role === "pick"
      ? "so this is the fastest clear route found"
      : "and this route is clear of it";
  const lead = `The original ${blocked.phrase}, ${clear}`;
  if (gainS === null) return `${lead}.`;
  const shown = seconds(Math.abs(gainS));
  if (shown === seconds(0)) return `${lead}: it takes the same time in ${model}, to the hundredth of a second.`;
  return `${lead}: it is ${shown} ${gainS < 0 ? "slower" : "faster"} in ${model}.`;
}

/**
 * The first sentence on a route round an original that breaks a heading hold the run asked for
 * (issue #448): what the original does not hold, that the pick is the fastest route found that holds
 * it (or that an alternative does), and its time against the original under `model`, which may be slower.
 */
export function holdRouteSentence(
  phrase: string,
  gainS: number | null,
  model: "the instant sim" | "the estimate",
  role: "pick" | "alternative" = "pick",
): string {
  const lead = `The original ${phrase}, ${role === "pick" ? "so this is the fastest route found that does" : "and this route does"}`;
  if (gainS === null) return `${lead}.`;
  const shown = seconds(Math.abs(gainS));
  if (shown === seconds(0)) return `${lead}: it takes the same time in ${model}, to the hundredth of a second.`;
  return `${lead}: it is ${shown} ${gainS < 0 ? "slower" : "faster"} in ${model}.`;
}

/** The sentence a result with no clear route gives first when the original is blocked. */
export function blockedNoRouteSentence(blocked: OriginalBlocked): string {
  return `The original ${blocked.phrase}, and no ${keepsMargin(blocked) ? "route that keeps the margin" : "clear route"} was found between the step's two ends.`;
}

/** The plain sentences the card shows for a route (spec 16 section 7), round a blocked original when `blocked` is given. */
function changeSentences(
  route: OptimizedRoute,
  original: PathStep,
  scorer: ObjectiveScorer,
  blocked: OriginalBlocked | null,
  role: "pick" | "alternative",
  breaksHolds: string | null = null,
  endWithinMargin = false,
): string[] {
  const sentences: string[] = [];
  const t1 = route.t1;
  const timeSentence = (gainS: number | null, model: "the instant sim" | "the estimate"): string | null =>
    blocked !== null
      ? blockedRouteSentence(blocked, gainS, model, role, endWithinMargin)
      : breaksHolds !== null
        ? holdRouteSentence(breaksHolds, gainS, model, role)
        : gainS === null
          ? null
          : timeComparisonSentence(gainS, model);
  if (scorer === "sim" && t1 !== null && route.gainS !== null) {
    sentences.push(timeSentence(route.gainS, "the instant sim") as string);
    sentences.push(`The step takes ${seconds(t1.after.ownS)} instead of ${seconds(t1.before.ownS)} in the instant sim.`);
  } else {
    // A blocked original the instant sim cannot time still has the estimate's time for the step.
    const gainS = route.gainS ?? (blocked === null && breaksHolds === null ? null : route.t0.before.ownS - route.t0.after.ownS);
    const sentence = timeSentence(gainS, "the estimate");
    if (sentence !== null) sentences.push(sentence);
  }
  sentences.push(`The estimate has the step at ${seconds(route.t0.after.ownS)} instead of ${seconds(route.t0.before.ownS)}.`);
  if (JSON.stringify(route.step.segments) !== JSON.stringify(original.segments)) {
    const count = route.step.segments.length;
    sentences.push(`The route is now ${String(count)} ${count === 1 ? "path" : "paths"}: ${route.step.segments.map(describeSegment).join(", then ")}.`);
  }
  if (JSON.stringify(route.step.heading) !== JSON.stringify(original.heading)) {
    sentences.push(`The heading is now ${describeHeading(route.step.heading)}, where it was ${describeHeading(original.heading)}.`);
  }
  for (const marker of route.movedMarkers) {
    sentences.push(`Marker ${String(marker.index + 1)} (${marker.name}) moves ${inches(marker.movedIn)} on the field; its "at" is kept as written.`);
  }
  for (const finding of route.findingsRemoved) sentences.push(`It clears the ${describeFinding(finding)}.`);
  for (const finding of route.findingsAdded) sentences.push(`It adds a ${describeFinding(finding)}.`);
  return sentences;
}

/**
 * True when an evaluation keeps every clearance on its samples: the margin to structures, and no
 * contact with a keep-out or past the slack `check()` gives the walls (a start against the wall is
 * common). Only such a route is worth the final check, which tests it far more closely.
 * `clearancePenalty` already gives the walls that slack and reports no shortfall within float
 * noise, so any worst shortfall it reports fails.
 */
const clearOf = (evaluation: Evaluation): boolean =>
  evaluation.status === "scored" &&
  !evaluation.penetrates &&
  [evaluation.worst, evaluation.simWorst].every((worst) => worst === null);

/**
 * Which evaluations are worth the final check. Round a blocked original, or one that is clear, only a
 * clear route (`clearOf`). Round an original that `check()` passes but that falls short itself, near
 * a structure on the plan or past the wall's slack in the instant sim's tracking, a route that falls
 * no further short than the original, which is what the final check's steps 5 and 6 then hold it to
 * (spec 16 section 4.4). The sim's shortfall is left to the final check when the original's plan
 * penetrates, since the sim then did not score the original.
 */
function worthChecking(original: Evaluation, blocked: boolean): (evaluation: Evaluation) => boolean {
  if (blocked || clearOf(original)) return clearOf;
  const planShortIn = (evaluation: Evaluation): number => evaluation.worst?.shortfallIn ?? 0;
  const simShortIn = (evaluation: Evaluation): number => evaluation.simWorst?.shortfallIn ?? 0;
  return (evaluation) =>
    evaluation.status === "scored" &&
    (original.penetrates || !evaluation.penetrates) &&
    planShortIn(evaluation) <= planShortIn(original) + SHORTFALL_TOLERANCE_IN &&
    (original.penetrates || simShortIn(evaluation) <= simShortIn(original) + SHORTFALL_TOLERANCE_IN);
}

/**
 * The routes the final check accepts, best first, at most one plain one per start and one per seed
 * that goes round the obstacles another way. A route `allowed` refuses (more paths than `maxPaths`,
 * or heading ranges the options forbid) is never one of them (spec 16 section 3). After the pick,
 * the plain routes that go round the obstacles another way than every route before them come
 * first, so the alternatives differ in more than a hair.
 */
function finalists(
  objective: Objective,
  check: FinalCheck,
  outcome: SearchOutcome,
  allowed: (step: PathStep) => boolean,
  ends: RouteEnds,
): { accepted: AcceptedRoute[] } {
  const found = searchedFinalists(objective, check, outcome, allowed);
  const worth = worthChecking(objective.original, check.originalBlocked !== null);
  const classOf = (step: PathStep): number[] | null => routeClassOf(objective.world, step, ends);
  const classes: number[][] = [];
  // A plain route is one that may be the pick (`pickable`): round a blocked original, every clear one.
  const plain = found.accepted.filter(pickable);
  for (const route of plain) {
    const angles = classOf(route.step);
    if (angles !== null) classes.push(angles);
  }

  // The seeds of a way round that no plain route takes yet, best first by the estimate: a search
  // from three starts can end every start on the same side of an obstacle, and a seed round the
  // other side that passes the final check as it is still offers the person that way.
  const accepted = [...found.accepted];
  if (plain.length <= MAX_ALTERNATIVES) {
    const taken = new Set(accepted.map((route) => JSON.stringify(route.step)));
    const seeds = outcome.seeds
      .filter((entry) => !entry.original && allowed(entry.step) && worth(entry.evaluation))
      .sort((a, b) => a.evaluation.j - b.evaluation.j || a.index - b.index);
    let checked = 0;
    for (const entry of seeds) {
      if (checked >= SEED_CHECK_LIMIT || accepted.filter(pickable).length > MAX_ALTERNATIVES) break;
      if (taken.has(entry.key)) continue;
      const angles = classOf(entry.step);
      if (angles === null || classes.some((other) => sameRouteClass(other, angles))) continue;
      checked += 1;
      const verdict = check.verify(entry.step);
      if (!verdict.ok || !pickable(verdict.accepted)) continue;
      accepted.push(verdict.accepted);
      classes.push(angles);
      taken.add(entry.key);
    }
  }

  // The other side of the gate between models (issue #448): the timeline shows the estimate, so a
  // route the estimate has faster by a tick, though the instant sim does not, is offered beside the
  // pick, never as it. The search's own routes come first, which the instant sim scored and so found
  // clear in the follower's own motion, best first by the estimate; then the seeds, which only the
  // estimate scored, the same way. The final check then runs the sim on the one offered. Round a
  // blocked original, or one that breaks a hold, the time test is waived already.
  if (objective.scorer === "sim" && check.originalBlocked === null && check.originalBreaksHolds === null) {
    const originalT0 = objective.original.t0;
    const rankOf = (times: { windowEndS: number; ownS: number }): number => (objective.scoringWindow.notCriticalPath ? times.ownS : times.windowEndS);
    const estimateOf = (entry: SearchEntry): number => (entry.evaluation.t0 === null ? Infinity : rankOf(entry.evaluation.t0));
    const byEstimate = (a: SearchEntry, b: SearchEntry): number => estimateOf(a) - estimateOf(b) || a.index - b.index;
    const taken = new Set(accepted.map((route) => JSON.stringify(route.step)));
    // It must beat the original in the estimate by a tick, and the pick too when there is one, or it shows nothing the pick does not.
    const pick = accepted.find(pickable);
    const barS = Math.min(originalT0 === null ? -Infinity : rankOf(originalT0), pick === undefined ? Infinity : rankOf(pick.t0.candidate));
    const fasterInEstimate = (entry: SearchEntry): boolean => barS - estimateOf(entry) >= MIN_TIME_GAIN_S - TIME_EPSILON_S;
    const pool = [
      ...outcome.ranked.filter((entry) => timeOf(entry.evaluation) >= timeOf(objective.original) - MIN_TIME_GAIN_S + TIME_EPSILON_S).sort(byEstimate),
      ...[...outcome.seeds].sort(byEstimate),
    ].filter((entry) => !entry.original && allowed(entry.step) && worth(entry.evaluation) && fasterInEstimate(entry));
    let checked = 0;
    for (const entry of pool) {
      if (checked >= ESTIMATE_ONLY_CHECK_LIMIT) break;
      if (taken.has(entry.key)) continue;
      taken.add(entry.key);
      checked += 1;
      const verdict = check.verify(entry.step, { allowEstimateOnly: true, fullMargin: true });
      if (verdict.ok && verdict.accepted.fasterInEstimateOnly) {
        accepted.push(verdict.accepted);
        break;
      }
    }
  }

  // The pick stays first; after it, the plain routes of a way round not taken before them, then the rest.
  const pickIndex = accepted.findIndex(pickable);
  if (pickIndex < 0) return { accepted };
  const head = accepted.slice(0, pickIndex + 1);
  const seen: number[][] = [];
  const pickAngles = classOf((accepted[pickIndex] as AcceptedRoute).step);
  if (pickAngles !== null) seen.push(pickAngles);
  const distinct: AcceptedRoute[] = [];
  const rest: AcceptedRoute[] = [];
  for (const route of accepted.slice(pickIndex + 1)) {
    const angles = pickable(route) ? classOf(route.step) : null;
    if (angles !== null && !seen.some((other) => sameRouteClass(other, angles))) {
      seen.push(angles);
      distinct.push(route);
    } else {
      rest.push(route);
    }
  }
  return { accepted: [...head, ...distinct, ...rest] };
}

/** The routes the final check accepts from the search's own ranking, best first, at most one plain one per start. */
function searchedFinalists(
  objective: Objective,
  check: FinalCheck,
  outcome: SearchOutcome,
  allowed: (step: PathStep) => boolean,
): { accepted: AcceptedRoute[] } {
  const originalTime = timeOf(objective.original);
  // The Route around rule (spec 16 section 8.3, every run's since issue #388): when check() finds
  // the original going through something, a clear route is wanted whatever its time, so the time
  // cut is dropped here as it is in the final check's step 7.
  const around = check.originalBlocked !== null;
  const worth = worthChecking(objective.original, around);
  // An original that breaks a heading hold (issue #448) waives the time cut too, but not the clearance rule.
  const timeWaived = around || check.originalBreaksHolds !== null;
  // Finalist mode (spec 16 section 5.2): the instant sim re-ranks the best few by the estimate.
  const eligible = finalistOrder(
    objective,
    outcome.ranked.filter(
      (entry) =>
        !entry.original &&
        allowed(entry.step) &&
        worth(entry.evaluation) &&
        (timeWaived || timeOf(entry.evaluation) < originalTime - MIN_TIME_GAIN_S + TIME_EPSILON_S),
    ),
  );
  if (eligible.length === 0) return { accepted: [] };
  return { accepted: checkFinalists(eligible, check.verify, FINAL_CHECK_LIMIT).accepted };
}

/** The closest attempt of an infeasible run: the scored route that falls least short, and where. */
function closestAttempt(input: OptimizeInput, objective: Objective, outcome: SearchOutcome): ClosestAttempt | null {
  const { waypoints, robot, field, stepId } = input;
  const shortfall = (evaluation: Evaluation): number => Math.max(evaluation.worst?.shortfallIn ?? 0, evaluation.simWorst?.shortfallIn ?? 0);
  const pool: { step: PathStep; evaluation: Evaluation }[] = [
    { step: objective.originalStep, evaluation: objective.original },
    ...outcome.ranked,
    ...outcome.seeds,
  ].filter((entry) => entry.evaluation.scored !== null && shortfall(entry.evaluation) > 0);
  let closest: { step: PathStep; evaluation: Evaluation } | null = null;
  for (const entry of pool) if (closest === null || shortfall(entry.evaluation) < shortfall(closest.evaluation)) closest = entry;
  if (closest === null) return null;
  const { evaluation } = closest;
  const planWorst = evaluation.worst;
  if (planWorst !== null && planWorst.shortfallIn >= (evaluation.simWorst?.shortfallIn ?? 0)) {
    const planned = pathIn(plan(resolve((evaluation.scored as { auto: typeof input.auto }).auto, waypoints, robot), robot, field), stepId);
    const sample = planned?.samples[planWorst.sampleIndex];
    if (sample !== undefined) {
      return { step: closest.step, pose: sample.pose, kind: planWorst.kind, id: planWorst.id, shortfallIn: planWorst.shortfallIn };
    }
  }
  const simWorst = evaluation.simWorst;
  if (simWorst !== null) {
    const sample = objective.simulatedPoses(closest.step)?.path[simWorst.sampleIndex];
    if (sample !== undefined) {
      return { step: closest.step, pose: sample.pose, kind: simWorst.kind, id: simWorst.id, shortfallIn: simWorst.shortfallIn };
    }
  }
  return null;
}

/**
 * Optimizes one path step's route (spec 16 sections 6 and 7). Yields progress after every batch of
 * evaluations; send `{ stop: true }` back to stop early, or `{ snapshot: true }` for the result a stop
 * would give without stopping (`OptimizeCommand`). Returns the result. Throws for options it
 * cannot run with and for a step id that is not a path in the auto.
 */
export function* optimizeRoute(
  input: OptimizeInput,
  options: OptimizeOptions = {},
): Generator<OptimizeProgress, OptimizeResult, OptimizeCommand | undefined> {
  const settings = resolveOptimizeOptions(input, options);
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const { robot, field, waypoints, stepId } = input;
  const inputKey = optimizeInputKey(input, settings);
  const objective = createObjective(input, { marginIn: settings.marginIn, scorer: settings.scorer });

  const base = canonicalAuto(input.auto);
  const resolvedAuto = resolve(base.auto, waypoints, robot);
  const resolved = flattenResolved(resolvedAuto.steps).find((step) => step.id === stepId) as ResolvedStep;
  const basePlan = plan(resolvedAuto, robot, field);
  const planned = pathIn(basePlan, stepId) as PlanStep;
  const original = objective.originalStep;
  const ends = routeEndsOf(resolved);
  const notes = [...objective.scoringWindow.notes, ...(objective.scorerReason === null ? [] : [objective.scorerReason])];

  const result = (status: OptimizeStatus, fields: Partial<OptimizeResult>): OptimizeResult => ({
    status,
    stepId,
    mode: settings.mode,
    step: null,
    pick: null,
    alternatives: [],
    scorer: objective.scorer,
    scorerReason: objective.scorerReason,
    marginIn: settings.marginIn,
    movedMarkers: [],
    findingsAdded: [],
    findingsRemoved: [],
    changes: [],
    notes,
    evaluations: 0,
    budget: settings.budget,
    inputKey,
    closest: null,
    originalBlocked: null,
    ...fields,
  });

  // An end that overlaps something cannot be fixed by moving the route (spec 16 section 4.3).
  const samples = planned.samples;
  for (const sample of [samples[0], samples[samples.length - 1]]) {
    if (sample === undefined) continue;
    const overlap = overlapAt(objective.world, sample);
    if (overlap !== null) {
      return result("infeasible", {
        changes: [`The step's own end overlaps ${describeThing(overlap.kind, overlap.id)}.`],
        closest: { step: null, pose: sample.pose, ...overlap },
      });
    }
  }
  if (settings.mode === "headingOnly" && original.heading?.mode === "facePoint") {
    return result("noBetter", { changes: ["The step faces a point, which it keeps, so it has no heading to optimize."] });
  }
  const holds = holdsOf(settings);
  if (holdsActive(holds) && original.heading?.mode === "facePoint") {
    return result("infeasible", { changes: [`The step faces a point, which it keeps, so it cannot hold ${holdWords(holds)}.`] });
  }

  // The most paths a route may have. `headingOnly` keeps the original's segments as written, so it
  // is held to the original's own count instead.
  const maxPaths = settings.allowSplit ? settings.maxPaths : 1;
  const routeMaxPaths = settings.mode === "headingOnly" ? Math.max(maxPaths, original.segments.length) : maxPaths;
  // What a returned route may be: no more paths than that, and no heading ranges unless allowed.
  const allowedRoute = (step: PathStep): boolean =>
    step.segments.length <= routeMaxPaths && headingAllowed(step, settings.allowRanges);

  // One final check for the run: it plans and checks the original once, and says whether the
  // original is blocked (issue #388), which the seeds and the result both need. Route around
  // (`settings.routeAround`) also blocks it for a CLEARANCE finding or the plan coming within the margin.
  const finalCheck: FinalCheck = createFinalCheck(input, objective, { routeAround: settings.routeAround, holds });
  const blocked = finalCheck.originalBlocked;
  // What the original does not hold of the heading holds the run asks for (issue #448); null when it keeps them.
  const breaksHolds = blocked === null ? finalCheck.originalBreaksHolds : null;
  // Whether the step's own start or end is within the margin, which no route can change.
  const endWithinMargin = [samples[0], samples[samples.length - 1]].some((sample) => {
    if (sample === undefined) return false;
    const closest = closestClearance(objective.world, [sample]);
    return closest !== null && closest.clearanceIn < settings.marginIn - END_MARGIN_SLACK_IN;
  });

  /**
   * Builds the result from the search's outcome: the final check of the best routes, the pick with
   * the gate between models, and what the card says. A snapshot (`{ snapshot: true }`) is built the
   * same way from the outcome so far, so it is exactly what a stop at that point returns.
   */
  const finish = (outcome: SearchOutcome): OptimizeResult => {
    const { accepted } = finalists(objective, finalCheck, outcome, allowedRoute, ends);
    const { pick, pickLabel, alternatives } = choosePick(accepted);
    const routeOf = (route: AcceptedRoute, label: string | null, role: "pick" | "alternative"): OptimizedRoute => {
      const after = pathIn(plan(resolve(route.auto.auto, waypoints, robot), robot, field), stepId) as PlanStep;
      const built: OptimizedRoute = {
        step: route.step,
        label,
        t0: { before: route.t0.original, after: route.t0.candidate },
        t1: route.t1 === null ? null : { before: route.t1.original, after: route.t1.candidate },
        gainS: route.gainS,
        closest: closestClearance(objective.world, after.samples),
        movedMarkers: movedMarkers(route.step, planned, after),
        findingsAdded: route.findingsAdded,
        findingsRemoved: route.findingsRemoved,
        changes: [],
        note: route.note,
      };
      return { ...built, changes: changeSentences(built, original, route.scoredBy, blocked, role, breaksHolds, endWithinMargin) };
    };

    const shared = {
      evaluations: outcome.evaluations,
      originalBlocked: blocked,
      ...(finalCheck.originalBreaksHolds === null ? {} : { originalBreaksHolds: finalCheck.originalBreaksHolds }),
    };
    const stoppedNote = "The search stopped before it finished; this is the fastest route found so far.";
    if (pick !== null) {
      const chosen = routeOf(pick, pickLabel, "pick");
      return result(outcome.stopped ? "stoppedEarly" : "improved", {
        ...shared,
        step: chosen.step,
        pick: chosen,
        alternatives: alternatives.map((alternative) => routeOf(alternative.route, alternative.label, "alternative")),
        movedMarkers: chosen.movedMarkers,
        findingsAdded: chosen.findingsAdded,
        findingsRemoved: chosen.findingsRemoved,
        changes: chosen.changes,
        notes: [...notes, ...(chosen.note === null ? [] : [chosen.note]), ...(outcome.stopped ? [stoppedNote] : [])],
      });
    }
    const gated = alternatives.map((alternative) => routeOf(alternative.route, alternative.label, "alternative"));
    if (outcome.stopped) {
      return result("stoppedEarly", {
        ...shared,
        alternatives: gated,
        changes: [
          blocked !== null
            ? `The original ${blocked.phrase}, and the search stopped before it found a clear route.`
            : breaksHolds !== null
              ? `The original ${breaksHolds}, and the search stopped before it found a route that does.`
              : "The search stopped before it found a faster route that passes the final check.",
        ],
      });
    }
    // A blocked original is never "no better": there is no clear route to keep, so the step cannot be done.
    if (blocked !== null) {
      return result("infeasible", {
        ...shared,
        alternatives: gated,
        changes: [
          blockedNoRouteSentence(blocked),
          objective.world.keepOuts.some((keepOut) => keepOut.id === CENTRE_LINE_KEEPOUT_ID)
            ? "Every route it tried comes closer to a structure than the margin, leaves the field, enters a keep-out or crosses the centre line."
            : "Every route it tried comes closer to a structure than the margin, leaves the field or enters a keep-out.",
        ],
        closest: closestAttempt(input, objective, outcome),
      });
    }
    // An original that breaks a heading hold the run asks for does not do what was asked, so without a
    // route that keeps the holds the step cannot be done that way (issue #448).
    if (breaksHolds !== null) {
      return result("infeasible", {
        ...shared,
        alternatives: gated,
        changes: [`The original ${breaksHolds}, and no route that does was found between the step's two ends.`],
        closest: closestAttempt(input, objective, outcome),
      });
    }
    // An original check() passes is a route the robot drives, so without a faster one it stays: never
    // infeasible, even when it comes within the margin itself or rides the wall in the instant sim.
    return result("noBetter", {
      ...shared,
      alternatives: gated,
      changes: [
        clearOf(objective.original)
          ? "No faster route was found that keeps the margin, so the original stays as it is."
          : "No faster route was found that keeps at least the original's clearance, so the original stays as it is.",
      ],
      notes: objective.scorer === "estimate" ? [...notes, PLANNED_PATH_ONLY_NOTE] : notes,
    });
  };

  const outcome: SearchOutcome = yield* searchRoutes({
    objective,
    resolved,
    original,
    originalGeometry: makePath((resolved.segments ?? []).map((segment) => segment.pointsIn)),
    ends,
    robot,
    field,
    running: intakeTimeline(basePlan.steps, robot).byStepId.get(stepId),
    speedFraction: original.speedFraction ?? robotLimits(robot).defaultPathSpeedFraction,
    mode: settings.mode,
    maxPaths,
    allowRanges: settings.allowRanges,
    defaultHeadingMode: settings.defaultHeadingMode,
    holds,
    budget: settings.budget,
    batchSize,
    ...(blocked === null ? {} : { originalBlocked: true }),
    snapshot: finish,
  });
  const leader = outcome.ranked[0];
  yield {
    evaluations: outcome.evaluations,
    budget: settings.budget,
    bestJ: leader === undefined ? null : jAtWeight(leader.evaluation, outcome.weightS),
    ...(leader === undefined ? {} : { bestStep: leader.step }),
    phase: "final",
  };
  return finish(outcome);
}

/** Drains `optimizeRoute` to its result, for the CLI, the MCP server and tests. */
export function runOptimize(input: OptimizeInput, options: OptimizeOptions = {}): OptimizeResult {
  const run = optimizeRoute(input, options);
  let next = run.next();
  while (next.done !== true) next = run.next();
  return next.value;
}
