import type { Robot } from "@horizon36596/zenith-schema";
import { wrapAngle } from "../geometry/angle.js";
import type { Pose } from "../geometry/vec.js";
import type { LedgerEntry, LedgerRun } from "../ledger.js";
import type { SeasonRules, TargetId } from "../season.js";
import type { Finding, Fix, Plan, PlanStep } from "../types.js";
import { legalApproachFix } from "./approachFix.js";
import type { PushContext } from "./pushBack.js";

/**
 * The checks that need the ledger and the season plugin: LEGAL_APPROACH, TURRET_RANGE, CAPACITY,
 * EMPTY_SHOT, TRANSFER and LAUNCH_TARGET (site/docs/checks-and-findings.md). The core still knows
 * nothing about the game; it asks the plugin and reports the answer.
 */

const degrees = (rad: number): string => `${((rad * 180) / Math.PI).toFixed(0)} degrees`;

const total = (holds: Readonly<Record<string, number>>): number =>
  Object.values(holds).reduce((sum, value) => sum + value, 0);

/** Every step in the order the ledger walked them, parallel and branch children included. */
function flatten(steps: readonly PlanStep[]): PlanStep[] {
  const flat: PlanStep[] = [];
  for (const step of steps) {
    flat.push(step);
    if (step.children !== undefined) flat.push(...flatten(step.children));
  }
  return flat;
}

/** The leg that put the robot where it is standing, which is the one a move fix has to rewrite. */
function drivingStepBefore(flat: readonly PlanStep[], stepId: string): PlanStep | null {
  const index = flat.findIndex((step) => step.id === stepId);
  for (let before = index - 1; before >= 0; before -= 1) {
    const candidate = flat[before];
    if (candidate !== undefined && candidate.kind === "path") return candidate;
  }
  return null;
}

/**
 * Why a shot from `pose` is not a legal approach when it would have been earlier: the latest step
 * before it after which the pose stopped being legal for the target, which is where the ledger
 * moved the target (a hive tipping, say), and the transfers before that step that put pieces into
 * or took them out of the target. Without this, a transfer that tips the hive a step early shows
 * up only as an error on a later, unrelated shot (issue #75). Empty when the pose was never legal,
 * which needs no history to explain.
 */
function approachCause(
  entries: readonly LedgerEntry[],
  index: number,
  target: TargetId,
  pose: Pose,
  robot: Robot,
  season: SeasonRules,
): string {
  let changedAt = -1;
  for (let before = index - 1; before >= 0; before -= 1) {
    const entry = entries[before];
    if (entry === undefined) continue;
    if (
      season.legalApproach(entry.before, target, pose, robot) &&
      !season.legalApproach(entry.after, target, pose, robot)
    ) {
      changedAt = before;
      break;
    }
  }
  const changed = entries[changedAt];
  if (changed === undefined) return "";

  const detail = season.describe === undefined ? null : season.describe(changed.before, changed.after);
  let cause = ` It was legal until ${changed.stepId}, after which ${detail === null ? "the ledger moved the target" : `the ledger says ${detail}`}.`;

  const transfers = entries
    .slice(0, changedAt)
    .flatMap((entry) => {
      const transfer = entry.transfer;
      if (transfer === null || transfer.moved <= 0) return [];
      if (transfer.from !== target && transfer.to !== target) return [];
      return [`transfer step ${entry.stepId} moved ${String(transfer.moved)} from ${transfer.from} to ${transfer.to}`];
    });
  if (transfers.length > 0) {
    cause += ` Before that, ${transfers.join(", and ")}.`;
  }
  return cause;
}

/**
 * `context` is what LEGAL_APPROACH's move fix checks the moved auto against (`legalApproachFix`);
 * without it the finding carries no fix.
 */
export function checkSeason(
  plan: Plan,
  robot: Robot,
  season: SeasonRules,
  run: LedgerRun,
  context?: PushContext,
): Finding[] {
  const findings: Finding[] = [];
  const flat = flatten(plan.steps);
  const poseOf = new Map(flat.map((step) => [step.id, step.startPose]));
  const capacity = robot.capacity;
  const turret = robot.shooter?.turretRangeRad;

  const startHolds = season.holds === undefined ? {} : season.holds(run.initialState);
  if (capacity !== undefined && total(startHolds) > capacity.max) {
    findings.push({
      severity: "error",
      stepId: "start",
      code: "CAPACITY",
      message: `The auto starts holding ${String(total(startHolds))} ${capacity.elementKind}, over the ${String(capacity.max)} the robot can carry.`,
    });
  }

  const stepOf = new Map(flat.map((step) => [step.id, step]));

  for (const [index, entry] of run.entries.entries()) {
    // A launch is judged from where the ledger had the robot when it launched: a marker's place
    // along a path, or the start of a step after a branch's `else` side, which the plan does not
    // draw.
    const pose = entry.launchPose ?? poseOf.get(entry.stepId) ?? plan.startPose;
    const held = season.holds === undefined ? {} : season.holds(entry.before);

    // LAUNCH_TARGET: `expect.launchesInto` names something the season does not know as a target,
    // so the ledger cannot put the pieces anywhere but loose.
    const authored = stepOf.get(entry.stepId)?.step;
    const named = authored !== undefined && "expect" in authored ? authored.expect?.launchesInto : undefined;
    if (named !== undefined && season.knowsTarget !== undefined && !season.knowsTarget(entry.before, named)) {
      const current = season.currentTarget(entry.before, plan.auto.alliance);
      findings.push({
        severity: "warning",
        stepId: entry.stepId,
        code: "LAUNCH_TARGET",
        message: `expect.launchesInto names ${JSON.stringify(named)}, which is not a target on this field, so the ledger lands the pieces loose.${current === null ? "" : ` The current target is ${current}.`}`,
      });
    }

    if (entry.launched > 0) {
      const target = entry.target;

      // LEGAL_APPROACH: the ledger's current target has to be legally approachable from here.
      if (target !== null && !season.legalApproach(entry.before, target, pose, robot)) {
        const fixes: Fix[] = [];
        // A launch from a marker happens partway along the path, which moving the end of the leg
        // before it would not fix.
        const driving = entry.launchedFromMarker === true ? null : drivingStepBefore(flat, entry.stepId);
        const move =
          driving === null || context === undefined
            ? null
            : legalApproachFix({ driving, shot: pose, target, state: entry.before, robot, season, context });
        if (move !== null) fixes.push(move);
        findings.push({
          severity: "error",
          stepId: entry.stepId,
          code: "LEGAL_APPROACH",
          message: `This step launches at ${target} from a pose that is not a legal approach to it.${approachCause(run.entries, index, target, pose, robot, season)}`,
          geometry: { pointIn: { xIn: pose.xIn, yIn: pose.yIn } },
          ...(fixes.length === 0 ? {} : { fixes }),
        });
      }

      // TURRET_RANGE: the bearing from the chassis to the target has to be inside the turret's arc.
      const point =
        target === null || season.targetPoint === undefined
          ? null
          : season.targetPoint(entry.before, target);
      if (point !== null && turret !== undefined) {
        const bearingRad = wrapAngle(
          Math.atan2(point.yIn - pose.yIn, point.xIn - pose.xIn) - pose.headingRad,
        );
        if (bearingRad < turret.minRad || bearingRad > turret.maxRad) {
          findings.push({
            severity: "warning",
            stepId: entry.stepId,
            code: "TURRET_RANGE",
            message: `The target sits ${degrees(bearingRad)} off the nose here, outside the turret's range of ${degrees(turret.minRad)} to ${degrees(turret.maxRad)}.`,
            geometry: { pointIn: point },
          });
        }
      }

      // EMPTY_SHOT: firing with nothing in the hopper.
      if (total(held) === 0) {
        findings.push({
          severity: "warning",
          stepId: entry.stepId,
          code: "EMPTY_SHOT",
          message: "This step launches, and the ledger says the robot is holding nothing.",
        });
      } else if (entry.launched > total(held)) {
        findings.push({
          severity: "warning",
          stepId: entry.stepId,
          code: "EMPTY_SHOT",
          message: `This step launches ${String(entry.launched)}, and the ledger says the robot is holding only ${String(total(held))}.`,
        });
      }
    }

    // TRANSFER: a transfer step names a place the ledger does not count, or asks for more than
    // its source holds at that point, so the ledger moved fewer than the step says.
    const transfer = entry.transfer;
    if (transfer !== null) {
      if (transfer.problem !== null) {
        findings.push({
          severity: season.onTransfer === undefined ? "info" : "error",
          stepId: entry.stepId,
          code: "TRANSFER",
          message: transfer.problem,
        });
      } else if (transfer.moved < transfer.actualCount) {
        findings.push({
          severity: "warning",
          stepId: entry.stepId,
          code: "TRANSFER",
          message: `This transfer moves ${String(transfer.actualCount)} from ${transfer.from} to ${transfer.to}, and the ledger says ${transfer.from} holds only ${String(transfer.moved)} here, so it moves ${String(transfer.moved)}.`,
        });
      }
      // CAPACITY: a transfer into the robot is the author's word, but the robot still cannot
      // carry more than its capacity.
      const after = season.holds === undefined ? {} : season.holds(entry.after);
      if (capacity !== undefined && total(after) > capacity.max && total(after) > total(held)) {
        findings.push({
          severity: "error",
          stepId: entry.stepId,
          code: "CAPACITY",
          message: `This transfer leaves the robot holding ${String(total(after))} against a capacity of ${String(capacity.max)}.`,
        });
      }
    }

    // CAPACITY: collecting more than the robot can hold on top of what it already has.
    if (entry.collected !== null && capacity !== undefined) {
      const wanted = total(held) + entry.collected.count;
      if (wanted > capacity.max) {
        findings.push({
          severity: "error",
          stepId: entry.stepId,
          code: "CAPACITY",
          message: `This step collects ${String(entry.collected.count)} from ${entry.collected.containerId} on top of ${String(total(held))} already aboard, which is ${String(wanted)} against a capacity of ${String(capacity.max)}.`,
        });
      }
    }
  }

  return findings;
}
