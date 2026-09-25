import {
  type Field,
  type Obstacle,
  type Robot,
  type Step,
} from "@horizon36596/zenith-schema";
import { checkHeading } from "./checks/heading.js";
import { checkMotion } from "./checks/motion.js";
import { CONTINUITY_TOLERANCE_IN, continuityGaps } from "./continuity.js";
import { checkSchedule } from "./checks/schedule.js";
import { checkSeason } from "./checks/season.js";
import { duplicateIds } from "./edit/ids.js";
import { fieldBounds } from "./footprint.js";
import { polygonOutsideBox, polygonOverlapsBox, type Box2 } from "./geometry/sat.js";
import type { Pose } from "./geometry/vec.js";
import { robotHeightIn } from "./kinematics.js";
import { runLedger } from "./ledger.js";
import { flattenSteps } from "./plan.js";
import { noSeasonRules, type SeasonRules } from "./season.js";
import type { Estimate, Finding, Plan, PlanStep } from "./types.js";

/**
 * How far outside the field a footprint corner may sit before PERIMETER fires, in inches.
 *
 * A start pose touching the wall is legal and common, and canonical form rounds headings to four
 * decimals, so a nose-to-the-wall pose is out by a ten-thousandth of an inch by arithmetic alone.
 * This tolerance is far below anything a person can measure and far above that.
 */
export const PERIMETER_TOLERANCE_IN = 0.05;

const obstacleBox = (obstacle: Obstacle): Box2 => ({
  minXIn: obstacle.minXIn,
  maxXIn: obstacle.maxXIn,
  minYIn: obstacle.minYIn,
  maxYIn: obstacle.maxYIn,
});

/**
 * The z gate: an obstacle only matters when its underside is lower than the robot is tall. The RED
 * hive's pivot bar starts at 25.5 in, so an 18 in robot drives under it; the hive's base does not.
 */
const reachesRobot = (obstacle: Obstacle, robotHeightIn: number): boolean =>
  obstacle.minZIn < robotHeightIn;

/**
 * Every check of site/docs/checks-and-findings.md.
 *
 * The ones that need no timing (SCHEMA, CONTINUITY, HEADING_MISSING, HEADING, PERIMETER, STRUCTURE,
 * START_ILLEGAL, KEEPOUT, MOUTH_LEADING, SWEEP_SPEED, STATIONARY_MARKER, MOVES_ROBOT, PROVENANCE
 * and the ledger's own) run whatever is passed for `estimate`; STRAFE_FRACTION, TIME_BUDGET and
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
  const findings: Finding[] = [...plan.findings];
  const steps = flattenSteps(plan.steps);

  findings.push(...checkIds(plan));
  findings.push(...checkRegistry(plan, robot));
  findings.push(...checkGroups(steps));
  findings.push(...checkContinuity(plan.steps, plan.startPose));
  findings.push(...checkGeometry(steps, robot, field));
  findings.push(...checkHeading(steps));
  findings.push(...season.startLegal(field, plan.startPose, robot, plan.auto.alliance));
  findings.push(...checkMotion(plan, estimate, robot, field, steps));
  findings.push(...checkSeason(plan, robot, season, runLedger(plan, field, season)));
  findings.push(...checkSchedule(estimate, robot, field, steps));

  return findings;
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
  return continuityGaps(steps, entry).map((gap) => ({
    severity: "error" as const,
    stepId: gap.stepId,
    code: "CONTINUITY" as const,
    message:
      gap.where === "segment"
        ? `Segment ${String((gap.segmentIndex ?? 0) + 1)} starts ${gap.gapIn.toFixed(2)} in from where segment ${String(gap.segmentIndex ?? 0)} ended; the limit is ${String(CONTINUITY_TOLERANCE_IN)} in.`
        : `This step starts ${gap.gapIn.toFixed(2)} in from where the robot was; the limit is ${String(CONTINUITY_TOLERANCE_IN)} in.`,
    geometry: { pointIn: gap.pointIn },
  }));
}

/** PERIMETER and STRUCTURE, over every footprint sample of every step. */
function checkGeometry(steps: readonly PlanStep[], robot: Robot, field: Field): Finding[] {
  const findings: Finding[] = [];
  const bounds = fieldBounds(field);
  const heightIn = robotHeightIn(robot);
  const obstacles = (field.obstacles ?? []).filter(
    (obstacle) => (obstacle.solidToRobot ?? true) && reachesRobot(obstacle, heightIn),
  );

  for (const step of steps) {
    if (step.samples.length === 0) continue;

    let worstOutside = { worstIn: 0, t: 0, pointIn: { xIn: 0, yIn: 0 } };
    const deepest = new Map<string, { penetrationIn: number; t: number }>();

    for (const sample of step.samples) {
      for (const polygon of [sample.footprintIn, ...sample.mouthsIn]) {
        const outside = polygonOutsideBox(polygon, bounds);
        if (outside.worstIn > PERIMETER_TOLERANCE_IN && outside.worstIn > worstOutside.worstIn) {
          worstOutside = {
            worstIn: outside.worstIn,
            t: sample.t,
            pointIn: outside.worstPointIn ?? { xIn: 0, yIn: 0 },
          };
        }
        for (const obstacle of obstacles) {
          const overlap = polygonOverlapsBox(polygon, obstacleBox(obstacle));
          if (!overlap.overlaps) continue;
          const seen = deepest.get(obstacle.id);
          if (seen === undefined || overlap.penetrationIn > seen.penetrationIn) {
            deepest.set(obstacle.id, { penetrationIn: overlap.penetrationIn, t: sample.t });
          }
        }
      }
    }

    if (worstOutside.worstIn > 0) {
      findings.push({
        severity: "error",
        stepId: step.id,
        t: worstOutside.t,
        code: "PERIMETER",
        message: `The footprint leaves the field by ${worstOutside.worstIn.toFixed(2)} in.`,
        geometry: { pointIn: worstOutside.pointIn },
      });
    }

    for (const [obstacleId, hit] of deepest) {
      findings.push({
        severity: "error",
        stepId: step.id,
        t: hit.t,
        code: "STRUCTURE",
        message: `The footprint overlaps ${obstacleId} by ${hit.penetrationIn.toFixed(2)} in at its deepest.`,
        geometry: { obstacleId, penetrationIn: hit.penetrationIn },
      });
    }
  }
  return findings;
}

/** True when any finding is an error, which is what `zenith validate` exits non-zero on. */
export const hasErrors = (findings: readonly Finding[]): boolean =>
  findings.some((finding) => finding.severity === "error");
