import {
  type Field,
  type Obstacle,
  type Robot,
  type Step,
} from "@horizon36596/zenith-schema";
import { clearanceFinding, nearAt, type Near } from "./checks/clearance.js";
import { checkEnvelopes } from "./checks/envelope.js";
import { checkHeading } from "./checks/heading.js";
import { checkMotion } from "./checks/motion.js";
import { checkOpponentSide, startReportedOver } from "./checks/opponentSide.js";
import { routeAroundFix, withFix } from "./checks/optimizeFixes.js";
import { NO_WORST, worstPose, type Worst } from "./checks/worst.js";
import { CONTINUITY_TOLERANCE_IN, continuityGaps } from "./continuity.js";
import { checkSchedule } from "./checks/schedule.js";
import { checkSeason } from "./checks/season.js";
import { pushBackFix, type PushContext, type PushTarget } from "./checks/pushBack.js";
import { continuityFixes } from "./checks/segmentGap.js";
import { sweptSamples } from "./checks/swept.js";
import { collectIds, duplicateIds, nonCompliantStepIds, STEP_ID_MAX, stepIdFrom } from "./edit/ids.js";
import { estimate as estimatePlan } from "./estimate.js";
import { renameStepFix, turnWhileDrivingFix } from "./fix.js";
import { fieldBounds } from "./footprint.js";
import { angleDelta } from "./geometry/angle.js";
import { obstacleShadows, type ObstacleShadow } from "./geometry/obstacle.js";
import { convexPolygonsOverlap, polygonOutsideBox, type Box2 } from "./geometry/sat.js";
import type { Pose, Vec2 } from "./geometry/vec.js";
import { mirrorForField, mirrorVec } from "./mirror.js";
import { robotClearanceIn, robotHeightIn, robotHeightProvenance } from "./kinematics.js";
import { provenanceLabel } from "./provenance.js";
import { runLedger } from "./ledger.js";
import { flattenSteps } from "./plan.js";
import { isTurnInPlace } from "./turnInPlace.js";
import { noSeasonRules, type SeasonRules } from "./season.js";
import type { Estimate, Finding, Fix, Plan, PlanSample, PlanStep } from "./types.js";

/**
 * How far outside the field a footprint corner may sit before PERIMETER fires, in inches.
 *
 * A start pose touching the wall is legal and common, and canonical form rounds headings to four
 * decimals, so a nose-to-the-wall pose is out by a ten-thousandth of an inch by arithmetic alone.
 * This tolerance is far below anything a person can measure and far above that.
 */
export const PERIMETER_TOLERANCE_IN = 0.05;

/**
 * Whether the robot's height decided that an obstacle blocks it, so the STRUCTURE message names
 * the height: always for a strut, whose shadow grows with the height, and for a box that starts
 * above the tiles, which a shorter robot would pass under. A box standing on the tiles blocks any
 * robot, and its message stays as it was.
 */
const heightDecides = (obstacle: Obstacle): boolean => obstacle.kind === "strut" || obstacle.minZIn > 0;

/**
 * Every check of site/docs/checks-and-findings.md.
 *
 * The ones that need no timing (SCHEMA, CONTINUITY, HEADING_MISSING, HEADING, PERIMETER, STRUCTURE,
 * CLEARANCE, START_ILLEGAL, OPPONENT_SIDE, KEEPOUT, MOUTH_LEADING, SWEEP_SPEED, STATIONARY_MARKER, MOVES_ROBOT, PROVENANCE, STEP_ID,
 * ENVELOPE_SHAPE and the ledger's own) run whatever is passed for `estimate`; STRAFE_FRACTION, TIME_BUDGET and
 * TIMEOUT_TIGHT need it and are skipped when it is null.
 *
 * Pure: the same plan always produces the same findings in the same order, so a golden test and a
 * pull-request body can both rely on it.
 */
export function check(
  plan: Plan,
  estimate: Estimate | null,
  robot: Robot,
  field: Field,
  season: SeasonRules = noSeasonRules,
): Finding[] {
  return checkPlan(plan, estimate, robot, field, season, true);
}

/**
 * `check` itself. With `withFixes` false it leaves out the fixes that plan the auto again (Push end
 * clear and Move to approach), which is how Move to approach checks a moved auto as a whole without
 * each check of it searching for fixes of its own.
 */
function checkPlan(plan: Plan, estimate: Estimate | null, robot: Robot, field: Field, season: SeasonRules, withFixes: boolean): Finding[] {
  const findings: Finding[] = [...plan.findings];
  const steps = flattenSteps(plan.steps);

  findings.push(...checkIds(plan));
  findings.push(...checkStepIdNames(plan));
  findings.push(...checkRegistry(plan, robot));
  findings.push(...checkGroups(steps));
  findings.push(...checkContinuity(plan.steps, plan.startPose));
  findings.push(...checkGeometry(steps, robot, field, arrivalHeadings(plan.steps, plan.startPose.headingRad), sweptSamples(plan.steps, plan.startPose), season, plan, withFixes));
  findings.push(...checkHeading(steps));
  const startFindings = season.startLegal(field, plan.startPose, robot, plan.auto.alliance);
  findings.push(...startFindings);
  const ownSide = season.ownSide?.(field, plan.auto.alliance) ?? null;
  if (ownSide !== null) {
    // The start pose is checked here too, unless START_ILLEGAL has already said it is over the line.
    const startChecked = startReportedOver(field, plan.startPose, robot, ownSide, startFindings);
    findings.push(...checkOpponentSide(steps, sweptSamples(plan.steps, plan.startPose, startChecked), ownSide, plan.auto.alliance));
  }
  findings.push(...checkMotion(plan, estimate, robot, field, steps));
  const run = runLedger(plan, field, season);
  const seasonPlain = checkSeason(plan, robot, season, run);
  const after = [...checkSchedule(estimate, robot, field, steps), ...checkEnvelopes(steps)];
  // Move to approach compares a moved auto's findings, checked without the fixes that plan it again,
  // with this auto's, which are all here already but its own fix; so the season's findings are
  // checked a second time, with the fix, only when there is a LEGAL_APPROACH to fix.
  const wantsMove = withFixes && seasonPlain.some((finding) => finding.code === "LEGAL_APPROACH");
  const findingsBefore = [...findings, ...seasonPlain, ...after];
  const findingsOf = (moved: Plan): Finding[] => checkPlan(moved, estimatePlan(moved, robot), robot, field, season, false);
  const seasonFindings = wantsMove ? checkSeason(plan, robot, season, run, { ...pushContext(robot, field, plan), findingsOf, findingsBefore }) : seasonPlain;
  findings.push(...seasonFindings, ...after);

  return findings;
}

/** What a fix that moves a path's end checks the moved auto against (`checks/pushBack.ts`). */
function pushContext(robot: Robot, field: Field, origin: Pick<Plan, "auto" | "startPose" | "steps">): PushContext {
  return {
    auto: origin.auto,
    startPose: origin.startPose,
    steps: origin.steps,
    robot,
    field,
    bounds: fieldBounds(field),
    shadows: obstacleShadows(field.obstacles ?? [], robotHeightIn(robot)),
    perimeterToleranceIn: PERIMETER_TOLERANCE_IN,
  };
}

/** SCHEMA: a command or condition the robot's registry does not define. */
function checkRegistry(plan: Plan, robot: Robot): Finding[] {
  const findings: Finding[] = [];
  const commands = new Set(robot.commands.map((command) => command.name));
  const conditions = new Set((robot.conditions ?? []).map((condition) => condition.name));

  const wantCommand = (name: string, stepId: string, where: string): void => {
    if (!commands.has(name)) {
      findings.push({
        severity: "error",
        stepId,
        code: "SCHEMA",
        message: `${where} names the command ${JSON.stringify(name)}, which robot.json does not register.`,
      });
    }
  };
  const wantCondition = (name: string, stepId: string, where: string): void => {
    if (!conditions.has(name)) {
      findings.push({
        severity: "error",
        stepId,
        code: "SCHEMA",
        message: `${where} names the condition ${JSON.stringify(name)}, which robot.json does not register.`,
      });
    }
  };

  for (const planned of flattenSteps(plan.steps)) {
    const step: Step = planned.step;
    switch (step.kind) {
      case "command":
        wantCommand(step.name, planned.id, "This step");
        break;
      case "path":
        for (const marker of step.markers ?? []) {
          wantCommand(marker.command.name, planned.id, "A marker on this step");
        }
        if (step.endCondition !== undefined) {
          wantCondition(step.endCondition.condition, planned.id, "This step's endCondition");
        }
        break;
      case "wait":
        if (step.until !== undefined) wantCondition(step.until, planned.id, "This wait");
        break;
      case "branch":
        wantCondition(step.condition, planned.id, "This branch");
        break;
      default:
        break;
    }
  }
  return findings;
}

/**
 * SCHEMA: the same effective id on two steps.
 *
 * Every finding, every one-click fix and every `zenith.edit.*` primitive addresses a step by this
 * id, and all of them take the first match, so a repeated id makes the second step's error
 * indistinguishable from the first's and silently points every edit at the wrong step. The schema
 * cannot express it (an id is optional and a positional one is minted from the index), so it is
 * checked here, over the whole tree.
 */
function checkIds(plan: Plan): Finding[] {
  return duplicateIds(plan.auto.steps).map((id) => ({
    severity: "error" as const,
    stepId: id,
    code: "SCHEMA" as const,
    message: `Two steps have the id ${JSON.stringify(id)}; every step is addressed by its id, so it has to name one step.`,
  }));
}

/** What is wrong with an explicit step id outside the rule, for the STEP_ID message. */
function stepIdFault(id: string): string {
  if (id.length > STEP_ID_MAX) return `is ${String(id.length)} characters long, over the ${String(STEP_ID_MAX)} an id may have`;
  if (/\s/.test(id)) return "has a space";
  if (!/^[A-Za-z]/.test(id)) return "does not start with a letter";
  const odd = [...id].find((character) => !/[A-Za-z0-9_-]/.test(character)) ?? "";
  return `has a ${JSON.stringify(odd)}`;
}

/**
 * STEP_ID: an explicit step id outside the rule a waypoint's name follows (`STEP_ID_NAME_PATTERN`):
 * a letter, then letters, digits, `_` or `-`, at most `STEP_ID_MAX` characters. The format still
 * loads such an id, so a file written before the rule keeps working, and the generated Java still
 * compiles; it is a warning with a one-click rename to an id inside the rule, which carries every
 * deadline that named the old id with it. Positional ids are not written in the file and never
 * raise it.
 */
function checkStepIdNames(plan: Plan): Finding[] {
  const taken = collectIds(plan.auto.steps);
  return nonCompliantStepIds(plan.auto.steps).map((id) => {
    const newId = stepIdFrom(id, taken);
    taken.add(newId);
    return {
      severity: "warning" as const,
      stepId: id,
      code: "STEP_ID" as const,
      message: `Step id ${JSON.stringify(id)} ${stepIdFault(id)}. Ids start with a letter and hold only letters, digits, _ and -.`,
      fixes: [renameStepFix(id, newId)],
    };
  });
}

/**
 * SCHEMA: a `deadline` parallel group whose `deadline` does not name one of its own direct
 * children.
 *
 * Nothing in the file format can express this, so it is checked here: the estimator has no step to
 * time the group by, the generated Java falls back to a different member than the estimate assumed,
 * and the runtime throws at init. Naming a grandchild or a step outside the group is the same
 * mistake as naming nothing.
 */
function checkGroups(steps: readonly PlanStep[]): Finding[] {
  const findings: Finding[] = [];
  for (const step of steps) {
    if (step.step.kind !== "parallel" || step.step.mode !== "deadline") continue;
    const deadline = step.step.deadline;
    const children = step.children ?? [];
    if (deadline !== undefined && children.some((child) => child.id === deadline)) continue;
    const names = children.map((child) => JSON.stringify(child.id)).join(", ");
    findings.push({
      severity: "error",
      stepId: step.id,
      code: "SCHEMA",
      message:
        deadline === undefined
          ? `This group runs until its deadline step finishes but names no deadline; name one of ${names}.`
          : `This group's deadline names ${JSON.stringify(deadline)}, which is not one of its own steps (${names}).`,
    });
  }
  return findings;
}

/**
 * CONTINUITY: segment endpoints inside the tolerance, and each step starting where the robot was.
 * The walk itself, including how sequences, parallel groups and branches chain, is
 * `continuityGaps`, which the editor's insert-in-the-middle reads as well.
 */
function checkContinuity(steps: readonly PlanStep[], entry: Pose): Finding[] {
  // The first step with an id is the one a fix addresses, as everywhere else.
  const byId = new Map(flattenSteps(steps).reverse().map((step) => [step.id, step.step]));
  return continuityGaps(steps, entry).map((gap) => ({
    severity: "error" as const,
    stepId: gap.stepId,
    code: "CONTINUITY" as const,
    message:
      gap.where === "segment"
        ? `Path ${String((gap.segmentIndex ?? 0) + 1)} of this chain starts ${gap.gapIn.toFixed(2)} in from where path ${String(gap.segmentIndex ?? 0)} ended; the limit is ${String(CONTINUITY_TOLERANCE_IN)} in.`
        : `This step starts ${gap.gapIn.toFixed(2)} in from where the robot was; the limit is ${String(CONTINUITY_TOLERANCE_IN)} in.`,
    geometry: { pointIn: gap.pointIn },
    ...continuityFixes(gap, byId.get(gap.stepId)),
  }));
}

/** How close to a path's first point the worst sample must be to count as "at the start". */
const TURN_AT_START_IN = 2;
/** How far the heading there must differ from the one the robot arrived with to count as a turn. */
const TURN_AT_START_RAD = (2 * Math.PI) / 180;

/**
 * PERIMETER's message. When the robot is worst where the path begins and its heading there is not
 * the one it arrived with, the wall is not the problem the point is: the robot turns while it is
 * still flush against the wall (a tangent path drawn off a wall start does this), so the message
 * says so and names the two ways out. A turn on the spot (issue #187) turns nowhere else, so its
 * message says the corners swing past the wall as it turns.
 *
 * Every message names the wall, and along a path the stretch the robot is out over, as STRUCTURE
 * and OPPONENT_SIDE say where (0.1.2 UX sweep W2-15): "The robot leaves the field past the west
 * wall by 5.00 in, t 0.80 to 1.00."
 */
function perimeterMessage(
  step: PlanStep,
  sample: PlanSample,
  depthIn: number,
  arrived: number | undefined,
  wall: string,
  run: readonly PlanSample[],
): string {
  const base = `The robot leaves the field past the ${wall} wall by ${depthIn.toFixed(2)} in`;
  if (isTurnInPlace(step)) {
    return `${base} while it turns on the spot: its corners swing past the wall as it turns. Turn further from the wall, or turn less.`;
  }
  if (turnsAtStart(step, sample, arrived)) {
    return `${base} where the path starts: the robot turns while it is still against the wall. Drive straight off the wall first, or give this path a constant or linear heading.`;
  }
  if (step.kind !== "path") return `${base} where the robot stands for this step.`;
  const first = run[0] ?? sample;
  const last = run[run.length - 1] ?? sample;
  if (first === last) return `${base} at t ${sample.t.toFixed(2)}.`;
  return `${base}, t ${first.t.toFixed(2)} to ${last.t.toFixed(2)}.`;
}

/**
 * The wall a point outside the field is past, by compass: west and east are the field's low and
 * high x, south and north its low and high y. A corner past two walls is named for the one it is
 * further past.
 *
 * The compass is the one of the alliance the field's rules are written for
 * (`field.frame.canonicalAlliance`). A file for the other alliance is read in its own frame, as the
 * other findings are, so its point and the field's box go through the field's mirror first: the same
 * auto mirrored for the other alliance names the same wall.
 */
function wallPast(pointIn: Vec2, bounds: Box2, field: Field, alliance: Plan["auto"]["alliance"]): string {
  if (alliance !== field.frame.canonicalAlliance) {
    const mode = mirrorForField(field);
    const point = mirrorVec(pointIn, mode);
    const low = mirrorVec({ xIn: bounds.minXIn, yIn: bounds.minYIn }, mode);
    const high = mirrorVec({ xIn: bounds.maxXIn, yIn: bounds.maxYIn }, mode);
    const box = {
      minXIn: Math.min(low.xIn, high.xIn),
      maxXIn: Math.max(low.xIn, high.xIn),
      minYIn: Math.min(low.yIn, high.yIn),
      maxYIn: Math.max(low.yIn, high.yIn),
    };
    return compassPast(point, box);
  }
  return compassPast(pointIn, bounds);
}

function compassPast(pointIn: Vec2, bounds: Box2): string {
  const past: [string, number][] = [
    ["west", bounds.minXIn - pointIn.xIn],
    ["east", pointIn.xIn - bounds.maxXIn],
    ["south", bounds.minYIn - pointIn.yIn],
    ["north", pointIn.yIn - bounds.maxYIn],
  ];
  return past.reduce((best, each) => (each[1] > best[1] ? each : best))[0];
}

/** The run of consecutive samples, by index, that holds `index`: the stretch the robot stays out over. */
function runHolding(outside: readonly { index: number; sample: PlanSample }[], index: number): PlanSample[] {
  const at = outside.findIndex((entry) => entry.index === index);
  if (at < 0) return [];
  let from = at;
  let to = at;
  while (from > 0 && (outside[from - 1] as { index: number }).index === (outside[from] as { index: number }).index - 1) from -= 1;
  while (to < outside.length - 1 && (outside[to + 1] as { index: number }).index === (outside[to] as { index: number }).index + 1) to += 1;
  return outside.slice(from, to + 1).map((entry) => entry.sample);
}

/**
 * True when `sample` is where a path begins and the robot faces there other than the way it
 * arrived, so it turns on the spot before it drives.
 */
function turnsAtStart(step: PlanStep, sample: PlanSample, arrived: number | undefined): arrived is number {
  const turned = sample.pose.headingRad;
  return (
    step.kind === "path" &&
    !isTurnInPlace(step) &&
    sample.sIn <= TURN_AT_START_IN &&
    arrived !== undefined &&
    turned !== undefined &&
    Math.abs(angleDelta(arrived, turned)) > TURN_AT_START_RAD
  );
}

/**
 * The fixes for a footprint finding at `sample`. Where the robot turns on the spot as the path
 * starts, "Turn while driving", a linear heading from the way it arrived to the way the path ends,
 * so it leaves facing as it was and turns as it goes (issue #155). Where it is worst at the path's
 * end, an inline pose, the push-back fix when the moved path re-checks clean (issue #186,
 * `pushBackFix`). None otherwise, and then no `fixes` key; and none for a turn on the spot, which
 * neither drives nor ends anywhere a push could move it to without making it a path.
 */
function footprintFixes(
  step: PlanStep,
  sample: PlanSample,
  arrived: number | undefined,
  target: PushTarget,
  context: PushContext | null,
): Pick<Finding, "fixes"> {
  if (isTurnInPlace(step)) return {};
  const fixes: Fix[] = [];
  const endRad = step.endPose?.headingRad;
  if (turnsAtStart(step, sample, arrived) && endRad !== undefined) fixes.push(turnWhileDrivingFix(step.id, arrived, endRad));
  const push = context === null ? null : pushBackFix(step, sample, target, context);
  if (push !== null) fixes.push(push);
  return fixes.length === 0 ? {} : { fixes };
}

/**
 * The heading the robot has as each step begins, which a plan step's own `startPose` does not
 * carry (it is the step's first sample, already turned to the path's heading). Known only where
 * steps run one after another: the top level and inside a sequence. A step in a parallel group or
 * a branch arm is left out, so its PERIMETER message stays the plain one rather than a guess.
 */
function arrivalHeadings(
  steps: readonly PlanStep[],
  arriving: number | undefined,
  out: Map<PlanStep, number> = new Map(),
): Map<PlanStep, number> {
  let heading = arriving;
  for (const step of steps) {
    if (heading !== undefined) out.set(step, heading);
    if (step.kind === "sequence" && step.children !== undefined) arrivalHeadings(step.children, heading, out);
    heading = step.endPose?.headingRad;
  }
  return out;
}

/** One sample touching one obstacle: the deepest of the sample's polygons, and where it is in the sweep. */
interface Touch extends Worst {
  sample: PlanSample;
  /** The sample's place in the samples the step sweeps, so consecutive touches make one run. */
  index: number;
}

/** How close to a path's start (0) or end (1) a finding's `t` must be to count as that end. */
const END_T = 1e-3;

/** Two depths closer than this, in inches, are a tie: the same depth reached along a stretch. */
const DEPTH_TIE_IN = 1e-9;

/**
 * The run of consecutive touching samples that goes deepest, and its worst sample. A robot
 * straddling a bar is equally deep all the way along it, so on a tie the worst sample is the one in
 * the middle of the tied stretch, where the person would look, rather than the first one reached.
 * The first run wins when two go equally deep.
 */
function deepestRun(touches: readonly Touch[]): { run: Touch[]; worst: Touch } | null {
  const runs: Touch[][] = [];
  for (const touch of touches) {
    const run = runs[runs.length - 1];
    const last = run?.[run.length - 1];
    if (run !== undefined && last !== undefined && touch.index === last.index + 1) run.push(touch);
    else runs.push([touch]);
  }
  let best: { run: Touch[]; worst: Touch } | null = null;
  for (const run of runs) {
    const deepestIn = Math.max(...run.map((touch) => touch.depthIn));
    if (best !== null && deepestIn <= best.worst.depthIn + DEPTH_TIE_IN) continue;
    const tied = run.filter((touch) => touch.depthIn >= deepestIn - DEPTH_TIE_IN);
    const first = tied[0] as Touch;
    const middleIn = (first.sample.sIn + (tied[tied.length - 1] as Touch).sample.sIn) / 2;
    let worst = first;
    for (const touch of tied) {
      if (Math.abs(touch.sample.sIn - middleIn) < Math.abs(worst.sample.sIn - middleIn)) worst = touch;
    }
    best = { run, worst };
  }
  return best;
}

/** The season's words for an obstacle, or its id: what a button says, where the id after it would be noise. */
function obstacleLabel(id: string, field: Field, season: SeasonRules): string {
  const label = season.obstacleLabel?.(id, field) ?? null;
  return label === null || label === "" ? id : label;
}

/** How a STRUCTURE message names an obstacle: the season's label with the id after it, or the id. */
function obstacleName(id: string, field: Field, season: SeasonRules): string {
  const label = obstacleLabel(id, field, season);
  return label === id ? id : `${label} (${id})`;
}

/**
 * STRUCTURE's message: how deep the robot goes, and along a path for how long, so a robot driving
 * the length of a bar does not read like one that grazes it.
 */
function structureMessage(step: PlanStep, name: string, run: readonly Touch[], worst: Touch, height: string): string {
  const depth = `${worst.depthIn.toFixed(2)} in`;
  if (step.kind !== "path") return `The footprint overlaps ${name} by ${depth} where the robot stands for this step${height}.`;
  const first = run[0] as Touch;
  const last = run[run.length - 1] as Touch;
  const contactIn = Math.round(last.sample.sIn - first.sample.sIn);
  if (contactIn < 1) return `The robot drives into ${name} at t ${worst.sample.t.toFixed(2)}, ${depth} deep${height}.`;
  return `The robot drives into ${name} for about ${String(contactIn)} in (t ${first.sample.t.toFixed(2)} to ${last.sample.t.toFixed(2)}), up to ${depth} deep${height}.`;
}

/**
 * The end of a STRUCTURE message for an obstacle the robot's height decided (`heightDecides`):
 * the height the check used and its provenance label, so a placeholder 18 in is visible where it
 * matters (issue #228). Empty for any other obstacle.
 */
function heightClause(obstacle: Obstacle, robot: Robot): string {
  if (!heightDecides(obstacle)) return "";
  const heightIn = Math.round(robotHeightIn(robot) * 100) / 100;
  // The label in lower case mid-sentence, never the raw capitals of the file (UX review, X19).
  return `, with the robot ${String(heightIn)} in tall (${provenanceLabel(robotHeightProvenance(robot)).toLowerCase()})`;
}

/**
 * PERIMETER, STRUCTURE and CLEARANCE, over the footprint samples of every step that `sweptSamples`
 * leaves in, so a collision the robot stands in through several steps is reported once, on the step
 * that drove into it (issue #152). CLEARANCE (`checks/clearance.ts`) names an obstacle only on a
 * step that never touches it, so contact stays the STRUCTURE error.
 */
function checkGeometry(
  steps: readonly PlanStep[],
  robot: Robot,
  field: Field,
  arrivals: ReadonlyMap<PlanStep, number>,
  swept: ReadonlyMap<PlanStep, readonly PlanSample[]>,
  season: SeasonRules,
  origin: Pick<Plan, "auto" | "startPose" | "steps">,
  withFixes: boolean,
): Finding[] {
  const findings: Finding[] = [];
  const context = pushContext(robot, field, origin);
  const pushing = withFixes ? context : null;
  const { bounds, shadows } = context;
  const clearanceIn = robotClearanceIn(robot);

  for (const step of steps) {
    const samples = swept.get(step) ?? step.samples;
    if (samples.length === 0) continue;

    let worstOutside: Worst & { pointIn: Vec2; index: number } = { ...NO_WORST, pointIn: { xIn: 0, yIn: 0 }, index: -1 };
    // Every sample with a polygon past the wall, so the message can say the stretch it is out over.
    const outsides: { index: number; sample: PlanSample }[] = [];
    const touches = new Map<string, Touch[]>();
    const nears = new Map<string, Near[]>();

    for (const [sampleIndex, sample] of samples.entries()) {
      const polygons = [sample.footprintIn, ...sample.mouthsIn];
      let out = false;
      for (const [index, polygon] of polygons.entries()) {
        const outside = polygonOutsideBox(polygon, bounds);
        if (outside.worstIn > PERIMETER_TOLERANCE_IN) out = true;
        if (outside.worstIn > PERIMETER_TOLERANCE_IN && outside.worstIn > worstOutside.depthIn) {
          worstOutside = {
            depthIn: outside.worstIn,
            sample,
            polygonIndex: index,
            pointIn: outside.worstPointIn ?? { xIn: 0, yIn: 0 },
            index: sampleIndex,
          };
        }
      }
      if (out) outsides.push({ index: sampleIndex, sample });
      for (const { obstacle, polygonIn: shadow, boxIn } of shadows) {
        let touch: Touch | null = null;
        for (const [index, polygon] of polygons.entries()) {
          const overlap = convexPolygonsOverlap(polygon, shadow);
          if (overlap.overlaps && (touch === null || overlap.penetrationIn > touch.depthIn)) {
            touch = { depthIn: overlap.penetrationIn, sample, polygonIndex: index, index: sampleIndex };
          }
        }
        if (touch === null) {
          const near = nearAt(polygons, { obstacle, polygonIn: shadow, boxIn }, clearanceIn, sample, sampleIndex);
          if (near === null) continue;
          const close = nears.get(obstacle.id);
          if (close === undefined) nears.set(obstacle.id, [near]);
          else close.push(near);
          continue;
        }
        const seen = touches.get(obstacle.id);
        if (seen === undefined) touches.set(obstacle.id, [touch]);
        else seen.push(touch);
      }
    }

    if (worstOutside.sample !== null) {
      const run = runHolding(outsides, worstOutside.index);
      const first = run[0] ?? worstOutside.sample;
      const last = run[run.length - 1] ?? worstOutside.sample;
      const wall = wallPast(worstOutside.pointIn, bounds, field, origin.auto.alliance);
      findings.push({
        severity: "error",
        stepId: step.id,
        t: worstOutside.sample.t,
        code: "PERIMETER",
        message: perimeterMessage(step, worstOutside.sample, worstOutside.depthIn, arrivals.get(step), wall, run),
        geometry: {
          pointIn: worstOutside.pointIn,
          penetrationIn: worstOutside.depthIn,
          ...worstPose(worstOutside),
          ...(step.kind === "path" && !isTurnInPlace(step) ? { tRange: [first.t, last.t] as [number, number] } : {}),
        },
        ...withFix(
          footprintFixes(step, worstOutside.sample, arrivals.get(step), { kind: "wall" }, pushing).fixes,
          routeAroundFix(step, "the field wall", {}),
        ),
      });
    }

    for (const [obstacleId, touched] of touches) {
      const deepest = deepestRun(touched);
      if (deepest === null) continue;
      const { run, worst } = deepest;
      const first = run[0] as Touch;
      const last = run[run.length - 1] as Touch;
      const shadow = shadows.find((candidate) => candidate.obstacle.id === obstacleId) as ObstacleShadow;
      const name = obstacleName(obstacleId, field, season);
      findings.push({
        severity: "error",
        stepId: step.id,
        t: worst.sample.t,
        code: "STRUCTURE",
        message: structureMessage(step, name, run, worst, heightClause(shadow.obstacle, robot)),
        geometry: {
          obstacleId,
          penetrationIn: worst.depthIn,
          ...worstPose(worst),
          ...(step.kind === "path"
            ? { tRange: [first.sample.t, last.sample.t] as [number, number], contactIn: last.sample.sIn - first.sample.sIn }
            : {}),
        },
        ...withFix(
          footprintFixes(step, worst.sample, arrivals.get(step), { kind: "obstacle", shadow, name }, pushing).fixes,
          routeAroundFix(step, obstacleLabel(obstacleId, field, season), { obstacleId }),
        ),
      });
    }

    for (const [obstacleId, close] of nears) {
      if (touches.has(obstacleId)) continue;
      const warning = clearanceFinding(step, obstacleId, obstacleName(obstacleId, field, season), close, robot);
      // Route around keeps both ends of the path where they are, so where the robot comes closest
      // at an end it could never clear the warning (0.1.2 UX sweep W2-4): the end has to move first.
      const atEnd = warning.t !== undefined && (warning.t <= END_T || warning.t >= 1 - END_T);
      findings.push({ ...warning, ...withFix(undefined, atEnd ? null : routeAroundFix(step, obstacleLabel(obstacleId, field, season), { obstacleId })) });
    }
  }
  return findings;
}

/** True when any finding is an error, which is what `zenith validate` exits non-zero on. */
export const hasErrors = (findings: readonly Finding[]): boolean =>
  findings.some((finding) => finding.severity === "error");
