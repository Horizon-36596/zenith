import type { Field, Robot, Step } from "@horizon36596/zenith-schema";
import { wrapAngle } from "../geometry/angle.js";
import { polygonOverlapsBox } from "../geometry/sat.js";
import {
  MOUTH_LEADING_TOLERANCE_RAD,
  robotLimits,
  strafeFractionWarn,
  sweepSpeedFraction,
} from "../kinematics.js";
import type { Estimate, Finding, Fix, Plan, PlanStep } from "../types.js";
import { intakeTimeline, mouthHeadingRad, type RunningFrom } from "./intake.js";

/**
 * The checks that are about how the robot moves: KEEPOUT, STRAFE_FRACTION, MOUTH_LEADING and
 * SWEEP_SPEED (site/docs/checks-and-findings.md).
 */

const degrees = (rad: number): string => `${((rad * 180) / Math.PI).toFixed(0)} degrees`;
const percent = (fraction: number): string => `${(fraction * 100).toFixed(0)} %`;

/**
 * KEEPOUT: the footprint enters a zone whose rule applies during autonomous.
 *
 * A zone counts only when it says `appliesInAuto: true`. The BIOBUZZ loading zones say "no start
 * here", which START_ILLEGAL already covers, and warning about driving through them would be a
 * false alarm; the flag is how a field file asks for this check.
 */
export function checkKeepout(steps: readonly PlanStep[], field: Field): Finding[] {
  const findings: Finding[] = [];
  const zones = (field.zones ?? []).filter((zone) => zone.appliesInAuto === true);
  if (zones.length === 0) return findings;

  for (const step of steps) {
    for (const zone of zones) {
      let worst: { t: number; penetrationIn: number } | null = null;
      for (const sample of step.samples) {
        for (const polygon of [sample.footprintIn, ...sample.mouthsIn]) {
          const overlap = polygonOverlapsBox(polygon, zone);
          if (!overlap.overlaps) continue;
          if (worst === null || overlap.penetrationIn > worst.penetrationIn) {
            worst = { t: sample.t, penetrationIn: overlap.penetrationIn };
          }
        }
      }
      if (worst === null) continue;
      findings.push({
        severity: "warning",
        stepId: step.id,
        t: worst.t,
        code: "KEEPOUT",
        message: `The footprint enters ${zone.id}, which applies during autonomous${zone.rule === undefined ? "" : ` (${zone.rule})`}.`,
        geometry: { zoneId: zone.id, penetrationIn: worst.penetrationIn },
      });
    }
  }
  return findings;
}

/**
 * STRAFE_FRACTION: more of a leg driven sideways than the robot file's threshold allows. The
 * finding carries both the fraction and what it costs in seconds, because `03` section 5 is
 * explicit that a percentage alone does not let anyone accept the cost knowingly.
 */
export function checkStrafeFraction(
  plan: Plan,
  estimate: Estimate | null,
  robot: Robot,
): Finding[] {
  if (estimate === null) return [];
  const threshold = strafeFractionWarn(robot);
  const findings: Finding[] = [];

  // Every leg, including the ones inside a parallel group or a branch arm: the estimate already
  // carries their strafeFraction, and a sideways leg costs the same seconds wherever it sits.
  for (const { step, siblings, index } of sited(plan.steps)) {
    const timing = estimate.byStepId[step.id];
    if (timing?.strafeFraction == null || step.kind !== "path") continue;
    if (timing.strafeFraction <= threshold) continue;

    const costS = timing.strafeCostS ?? 0;
    findings.push({
      severity: "warning",
      stepId: step.id,
      code: "STRAFE_FRACTION",
      message: `This leg is driven sideways for ${percent(timing.strafeFraction)} of its length, which costs ${costS.toFixed(2)} s against driving it nose-first; the warning threshold is ${percent(threshold)}.`,
      geometry: { polygonIn: step.samples.map((sample) => sample.pose) },
      fixes: strafeFixes(siblings, step, index),
    });
  }
  return findings;
}

/** A step with the list it is a member of, so a fix can look at what runs just before it. */
interface Sited {
  step: PlanStep;
  siblings: readonly PlanStep[];
  index: number;
}

/**
 * Every step of a plan with the list that holds it: the top level, one parallel group's members,
 * or one arm of a branch. A branch's two arms are separate lists, because the last step of `then`
 * does not run before the first step of `else`.
 */
function sited(steps: readonly PlanStep[]): Sited[] {
  const out: Sited[] = [];
  steps.forEach((step, index) => {
    out.push({ step, siblings: steps, index });
    const children = step.children;
    if (children === undefined) return;
    if (step.step.kind === "branch") {
      const thenCount = step.step.then.length;
      out.push(...sited(children.slice(0, thenCount)));
      out.push(...sited(children.slice(thenCount)));
      return;
    }
    out.push(...sited(children));
  });
  return out;
}

/** The two fixes `03` section 5 names for a strafing leg: drive it nose-first, or turn beforehand. */
function strafeFixes(siblings: readonly PlanStep[], step: PlanStep, index: number): Fix[] {
  const fixes: Fix[] = [
    {
      kind: "makeTangent",
      stepId: step.id,
      label: "Point the nose along the path",
      params: {},
    },
  ];

  const entryHeadingRad = step.samples[0]?.pose.headingRad;
  const tangent = step.geometry?.tangentAtDistance(0);
  if (entryHeadingRad === undefined || tangent === undefined) return fixes;
  const headingRad = wrapAngle(Math.atan2(tangent.yIn, tangent.xIn));

  let previous: PlanStep | undefined;
  for (let before = index - 1; before >= 0; before -= 1) {
    const candidate = siblings[before];
    if (candidate !== undefined && candidate.kind === "path") {
      previous = candidate;
      break;
    }
  }
  if (previous === undefined) return fixes;

  fixes.push({
    kind: "turnAtPreviousStop",
    stepId: step.id,
    label: `Turn to ${degrees(headingRad)} at the end of ${previous.id} instead`,
    params: {
      headingRad,
      fromRad: previous.samples[0]?.pose.headingRad ?? headingRad,
      turnInStepId: previous.id,
    },
  });
  return fixes;
}

/**
 * MOUTH_LEADING: a leg driven with an intake running where the running mouth is not within 30
 * degrees of the travel direction. A body wider than the mouth shoves game pieces aside instead of
 * taking them in, which is a quiet way to lose a cycle.
 */
export function checkMouthLeading(
  steps: readonly PlanStep[],
  robot: Robot,
  running: ReadonlyMap<string, RunningFrom>,
): Finding[] {
  const findings: Finding[] = [];
  const mouths = robot.mouths ?? [];
  if (mouths.length === 0) return findings;

  for (const step of steps) {
    const active = running.get(step.id);
    if (active === undefined || active.size === 0) continue;
    const geometry = step.geometry;
    if (geometry === undefined) continue;

    let runningIn = 0;
    let badIn = 0;
    let worst = { deviationRad: 0, t: 0, mouthId: "" };

    for (let i = 1; i < step.samples.length; i += 1) {
      const before = step.samples[i - 1];
      const after = step.samples[i];
      if (before === undefined || after === undefined) continue;
      const ds = after.sIn - before.sIn;
      if (ds <= 0) continue;
      const midT = (before.t + after.t) / 2;
      const live = mouths.filter((mouth) => {
        const from = active.get(mouth.id);
        return from !== undefined && midT >= from;
      });
      if (live.length === 0) continue;

      const tangent = geometry.tangentAtDistance((before.sIn + after.sIn) / 2);
      const travelRad = Math.atan2(tangent.yIn, tangent.xIn);
      const headingRad = (before.pose.headingRad + after.pose.headingRad) / 2;
      let best = { deviationRad: Infinity, mouthId: "" };
      for (const mouth of live) {
        const deviationRad = Math.abs(wrapAngle(mouthHeadingRad(mouth, headingRad) - travelRad));
        if (deviationRad < best.deviationRad) best = { deviationRad, mouthId: mouth.id };
      }

      runningIn += ds;
      if (best.deviationRad > MOUTH_LEADING_TOLERANCE_RAD) badIn += ds;
      if (best.deviationRad > worst.deviationRad) {
        worst = { deviationRad: best.deviationRad, t: midT, mouthId: best.mouthId };
      }
    }

    if (runningIn === 0 || badIn <= runningIn / 2) continue;
    findings.push({
      severity: "warning",
      stepId: step.id,
      t: worst.t,
      code: "MOUTH_LEADING",
      message: `The ${worst.mouthId} mouth is running but points up to ${degrees(worst.deviationRad)} away from the direction of travel over ${percent(badIn / runningIn)} of this leg; the limit is ${degrees(MOUTH_LEADING_TOLERANCE_RAD)}, and a body wider than the mouth shoves game pieces aside.`,
      fixes: [
        { kind: "makeTangent", stepId: step.id, label: "Point the nose along the path", params: {} },
        {
          kind: "makeTangent",
          stepId: step.id,
          label: "Point the back mouth along the path",
          params: { reversed: true },
        },
      ],
    });
  }
  return findings;
}

/** SWEEP_SPEED: a leg driven faster than the robot's sweep speed with an intake running. */
export function checkSweepSpeed(
  steps: readonly PlanStep[],
  robot: Robot,
  running: ReadonlyMap<string, RunningFrom>,
): Finding[] {
  const limits = robotLimits(robot);
  const sweep = sweepSpeedFraction(robot);
  const findings: Finding[] = [];

  for (const step of steps) {
    const active = running.get(step.id);
    if (active === undefined || active.size === 0) continue;
    if (step.step.kind !== "path") continue;
    const speedFraction =
      (step.step as Extract<Step, { kind: "path" }>).speedFraction ?? limits.defaultPathSpeedFraction;
    if (speedFraction <= sweep) continue;

    findings.push({
      severity: "warning",
      stepId: step.id,
      code: "SWEEP_SPEED",
      message: `This leg intakes at ${percent(speedFraction)} of full speed, above the ${percent(sweep)} the robot file sets for a sweep.`,
      fixes: [
        {
          kind: "slowSweep",
          stepId: step.id,
          label: `Slow this sweep to ${percent(sweep)}`,
          params: { speedFraction: sweep },
        },
      ],
    });
  }
  return findings;
}

/** Runs every motion check over a plan. */
export function checkMotion(
  plan: Plan,
  estimate: Estimate | null,
  robot: Robot,
  field: Field,
  steps: readonly PlanStep[],
): Finding[] {
  const running = intakeTimeline(plan.steps, robot).byStepId;
  return [
    ...checkKeepout(steps, field),
    ...checkStrafeFraction(plan, estimate, robot),
    ...checkMouthLeading(steps, robot, running),
    ...checkSweepSpeed(steps, robot, running),
  ];
}
