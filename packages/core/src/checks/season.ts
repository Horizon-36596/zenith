import type { Robot } from "@horizon36596/zenith-schema";
import { wrapAngle } from "../geometry/angle.js";
import type { LedgerRun } from "../ledger.js";
import type { SeasonRules } from "../season.js";
import type { Finding, Fix, Plan, PlanStep } from "../types.js";

/**
 * The checks that need the ledger and the season plugin: LEGAL_APPROACH, TURRET_RANGE, CAPACITY
 * and EMPTY_SHOT (site/docs/checks-and-findings.md). The core still knows
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

export function checkSeason(
  plan: Plan,
  robot: Robot,
  season: SeasonRules,
  run: LedgerRun,
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

  for (const entry of run.entries) {
    const pose = poseOf.get(entry.stepId) ?? plan.startPose;
    const held = season.holds === undefined ? {} : season.holds(entry.before);

    if (entry.launched > 0) {
      const target = entry.target;

      // LEGAL_APPROACH: the ledger's current target has to be legally approachable from here.
      if (target !== null && !season.legalApproach(entry.before, target, pose, robot)) {
        const fixes: Fix[] = [];
        const legal =
          season.nearestLegalApproach === undefined
            ? null
            : season.nearestLegalApproach(entry.before, target, pose, robot);
        const driving = drivingStepBefore(flat, entry.stepId);
        if (legal !== null && driving !== null) {
          fixes.push({
            kind: "moveToLegalApproach",
            stepId: driving.id,
            label: `Move the end of ${driving.id} to the legal approach band`,
            params: {
              xIn: legal.xIn,
              yIn: legal.yIn,
              ...(Number.isFinite(legal.headingRad) ? { headingRad: legal.headingRad } : {}),
            },
          });
        }
        findings.push({
          severity: "error",
          stepId: entry.stepId,
          code: "LEGAL_APPROACH",
          message: `This step launches at ${target} from a pose that is not a legal approach to it.`,
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
