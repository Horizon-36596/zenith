import type { Field, Robot, Step, Zone } from "@horizon36596/zenith-schema";
import { lerpAngle, wrapAngle } from "../geometry/angle.js";
import { polygonOverlapsBox } from "../geometry/sat.js";
import {
  MOUTH_LEADING_TOLERANCE_RAD,
  robotLimits,
  strafeFractionWarn,
  sweepSpeedFraction,
} from "../kinematics.js";
import type { Estimate, Finding, Fix, Plan, PlanSample, PlanStep } from "../types.js";
import { fasterHeadingFix, routeAroundFix, withFix } from "./optimizeFixes.js";
import { sweptSamples } from "./swept.js";
import { worstPose, type Worst } from "./worst.js";
import { intakeTimeline, mouthHeadingRad, runningAt, type RunningFrom } from "./intake.js";

/**
 * The checks that are about how the robot moves: KEEPOUT, STRAFE_FRACTION, MOUTH_LEADING and
 * SWEEP_SPEED (site/docs/checks-and-findings.md).
 */

const degrees = (rad: number): string => `${((rad * 180) / Math.PI).toFixed(0)} degrees`;
const percent = (fraction: number): string => `${(fraction * 100).toFixed(0)} %`;

/**
 * The least STRAFE_FRACTION's cost must be, in seconds, before it says driving nose-first saves
 * time: half the hundredth of a second the message shows, so it never claims "0.00 s".
 */
const MIN_STRAFE_COST_S = 0.005;

/**
 * The zones KEEPOUT sweeps: those whose rule applies during autonomous, in field order. The
 * optimizer treats the same zones as hard constraints (`optimize/clearance.ts`).
 */
export const autoKeepOuts = (field: Field): Zone[] => (field.zones ?? []).filter((zone) => zone.appliesInAuto === true);

/**
 * KEEPOUT: the footprint enters a zone whose rule applies during autonomous.
 *
 * A zone counts only when it says `appliesInAuto: true`. The BIOBUZZ loading zones say "no start
 * here", which START_ILLEGAL already covers, and warning about driving through them would be a
 * false alarm; the flag is how a field file asks for this check.
 *
 * `swept` (`swept.ts`) leaves out the samples where the robot stands in a pose a step before it
 * already checked, so a robot that stays in a zone through several steps is reported once, on the
 * step that drove in. Left out, every step sweeps all of its samples.
 */
export function checkKeepout(
  steps: readonly PlanStep[],
  field: Field,
  swept: ReadonlyMap<PlanStep, readonly PlanSample[]> = new Map(),
): Finding[] {
  const findings: Finding[] = [];
  const zones = autoKeepOuts(field);
  if (zones.length === 0) return findings;

  for (const step of steps) {
    for (const zone of zones) {
      let worst: Worst | null = null;
      for (const sample of swept.get(step) ?? step.samples) {
        for (const [index, polygon] of [sample.footprintIn, ...sample.mouthsIn].entries()) {
          const overlap = polygonOverlapsBox(polygon, zone);
          if (!overlap.overlaps) continue;
          if (worst === null || overlap.penetrationIn > worst.depthIn) {
            worst = { depthIn: overlap.penetrationIn, sample, polygonIndex: index };
          }
        }
      }
      if (worst === null) continue;
      findings.push({
        severity: "warning",
        stepId: step.id,
        t: worst.sample?.t ?? 0,
        code: "KEEPOUT",
        message: `The footprint enters ${zone.id}, which applies during autonomous${zone.rule === undefined ? "" : ` (${zone.rule})`}.`,
        geometry: { zoneId: zone.id, penetrationIn: worst.depthIn, ...worstPose(worst) },
        ...withFix(undefined, routeAroundFix(step, zone.id, { zoneId: zone.id })),
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

    // The cost counts the turn on the spot each way needs first (`estimate.ts`), so a leg the robot
    // already faces across can be no slower as it is. Then the message claims no saving and the
    // nose-first fix is not offered, since it would make the step slower (0.1.2 UX sweep W2-3).
    const costS = timing.strafeCostS ?? 0;
    const faster = costS >= MIN_STRAFE_COST_S;
    const sideways = `This path is driven sideways for ${percent(timing.strafeFraction)} of its length`;
    findings.push({
      severity: "warning",
      stepId: step.id,
      code: "STRAFE_FRACTION",
      message: faster
        ? `${sideways}, which costs ${costS.toFixed(2)} s against driving it nose-first; the warning threshold is ${percent(threshold)}.`
        : `${sideways}, over the ${percent(threshold)} warning threshold. Driving it nose-first would be no faster here, counting the turn on the spot that needs first.`,
      ...strafeStretch(step),
      ...withFix(strafeFixes(siblings, step, index, faster), fasterHeadingFix(step)),
    });
  }
  return findings;
}

/**
 * Where along the path the robot drives sideways, as STRAFE_FRACTION's geometry: `tRange` from the
 * first sample driven more sideways than forwards to the last, which the editor tints along the
 * path (0.1.2 UX sweep W2-1). It used to hand the path's own points over as `polygonIn`, which the
 * canvas closes and fills, so a curved path drew a tinted shape from its end back to its start.
 * When the sideways driving comes in more than one stretch, with nose-first driving between them,
 * `tRanges` lists each, so the editor tints them apart rather than the whole span.
 */
function strafeStretch(step: PlanStep): Pick<Finding, "geometry"> {
  const geometry = step.geometry;
  if (geometry === undefined) return {};
  const stretches: [number, number][] = [];
  let open: [number, number] | null = null;
  for (const sample of step.samples) {
    const tangent = geometry.tangentAtDistance(sample.sIn);
    const phiRad = Math.atan2(tangent.yIn, tangent.xIn) - sample.pose.headingRad;
    if (Math.abs(Math.sin(phiRad)) > Math.abs(Math.cos(phiRad))) {
      if (open === null) {
        open = [sample.t, sample.t];
        stretches.push(open);
      } else {
        open[1] = sample.t;
      }
    } else {
      open = null;
    }
  }
  const first = stretches[0];
  const last = stretches[stretches.length - 1];
  if (first === undefined || last === undefined) return {};
  return { geometry: { tRange: [first[0], last[1]], ...(stretches.length > 1 ? { tRanges: stretches } : {}) } };
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

/**
 * The two fixes `03` section 5 names for a strafing leg: drive it nose-first, or turn beforehand.
 * Driving it nose-first is offered only when that is `faster`.
 */
function strafeFixes(siblings: readonly PlanStep[], step: PlanStep, index: number, faster: boolean): Fix[] {
  const fixes: Fix[] = faster
    ? [
        {
          kind: "makeTangent",
          stepId: step.id,
          label: "Point the nose along the path",
          params: {},
        },
      ]
    : [];

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
 * One stretch between two consecutive samples of a path driven with an intake running: the unit
 * MOUTH_LEADING measures in. `deviationRad` is how far the best-placed running mouth points from
 * the direction of travel, so the stretch breaks the rule when it is above
 * `MOUTH_LEADING_TOLERANCE_RAD`.
 */
export interface MouthLeadingStretch {
  /** The stretch's arc length, in inches. */
  dsIn: number;
  /** The path fraction at the stretch's middle. */
  midT: number;
  deviationRad: number;
  /** The running mouth that points closest to the direction of travel. */
  mouthId: string;
}

/**
 * MOUTH_LEADING's predicate, stretch by stretch: every stretch of the step where a mouth is running,
 * with how far the best running mouth points from the direction of travel. Empty when the robot has
 * no mouths, no intake runs on the step, or the step has no geometry. The check and the optimizer's
 * penalty (`optimize/objective.ts`) both read it, so they cannot disagree.
 */
export function mouthLeadingStretches(
  step: PlanStep,
  robot: Robot,
  active: RunningFrom | undefined,
): MouthLeadingStretch[] {
  const mouths = robot.mouths ?? [];
  const geometry = step.geometry;
  if (mouths.length === 0 || active === undefined || active.size === 0 || geometry === undefined) return [];

  const stretches: MouthLeadingStretch[] = [];
  for (let i = 1; i < step.samples.length; i += 1) {
    const before = step.samples[i - 1];
    const after = step.samples[i];
    if (before === undefined || after === undefined) continue;
    const dsIn = after.sIn - before.sIn;
    if (dsIn <= 0) continue;
    const midT = (before.t + after.t) / 2;
    const live = mouths.filter((mouth) => runningAt(active.get(mouth.id), midT));
    if (live.length === 0) continue;

    const tangent = geometry.tangentAtDistance((before.sIn + after.sIn) / 2);
    const travelRad = Math.atan2(tangent.yIn, tangent.xIn);
    // The short way between the two samples: a plain mean of 3.12 and -3.12 would be 0, not pi.
    const headingRad = lerpAngle(before.pose.headingRad, after.pose.headingRad, 0.5);
    let best = { deviationRad: Infinity, mouthId: "" };
    for (const mouth of live) {
      const deviationRad = Math.abs(wrapAngle(mouthHeadingRad(mouth, headingRad) - travelRad));
      if (deviationRad < best.deviationRad) best = { deviationRad, mouthId: mouth.id };
    }
    stretches.push({ dsIn, midT, deviationRad: best.deviationRad, mouthId: best.mouthId });
  }
  return stretches;
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
  if ((robot.mouths ?? []).length === 0) return findings;

  for (const step of steps) {
    let runningIn = 0;
    let badIn = 0;
    let worst = { deviationRad: 0, t: 0, mouthId: "" };

    for (const stretch of mouthLeadingStretches(step, robot, running.get(step.id))) {
      runningIn += stretch.dsIn;
      if (stretch.deviationRad > MOUTH_LEADING_TOLERANCE_RAD) badIn += stretch.dsIn;
      if (stretch.deviationRad > worst.deviationRad) {
        worst = { deviationRad: stretch.deviationRad, t: stretch.midT, mouthId: stretch.mouthId };
      }
    }

    if (runningIn === 0 || badIn <= runningIn / 2) continue;
    findings.push({
      severity: "warning",
      stepId: step.id,
      t: worst.t,
      code: "MOUTH_LEADING",
      message: `The ${worst.mouthId} mouth is running but points up to ${degrees(worst.deviationRad)} away from the direction of travel over ${percent(badIn / runningIn)} of this path; the limit is ${degrees(MOUTH_LEADING_TOLERANCE_RAD)}, and a body wider than the mouth shoves game pieces aside.`,
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

/** A path driven with an intake running: the speed it drives at and the robot's sweep speed. */
export interface SweepSpeedReading {
  /** The path's `speedFraction`, or the robot's default. */
  speedFraction: number;
  /** `sweepSpeedFraction(robot)`: the fastest a sweep may drive. */
  sweepFraction: number;
}

/**
 * SWEEP_SPEED's predicate: for a path step with an intake running on it, the speed it drives at and
 * the sweep speed, so the rule is broken when `speedFraction > sweepFraction`. Null for any other
 * step. The check and the optimizer's penalty both read it.
 */
export function sweepSpeedReading(
  step: PlanStep,
  robot: Robot,
  active: RunningFrom | undefined,
): SweepSpeedReading | null {
  if (active === undefined || active.size === 0) return null;
  if (step.step.kind !== "path") return null;
  const speedFraction =
    (step.step as Extract<Step, { kind: "path" }>).speedFraction ?? robotLimits(robot).defaultPathSpeedFraction;
  return { speedFraction, sweepFraction: sweepSpeedFraction(robot) };
}

/** SWEEP_SPEED: a leg driven faster than the robot's sweep speed with an intake running. */
export function checkSweepSpeed(
  steps: readonly PlanStep[],
  robot: Robot,
  running: ReadonlyMap<string, RunningFrom>,
): Finding[] {
  const findings: Finding[] = [];

  for (const step of steps) {
    const reading = sweepSpeedReading(step, robot, running.get(step.id));
    if (reading === null) continue;
    const { speedFraction, sweepFraction: sweep } = reading;
    if (speedFraction <= sweep) continue;

    findings.push({
      severity: "warning",
      stepId: step.id,
      code: "SWEEP_SPEED",
      message: `This path intakes at ${percent(speedFraction)} of full speed, above the ${percent(sweep)} the robot file sets for a sweep.`,
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
    ...checkKeepout(steps, field, sweptSamples(plan.steps, plan.startPose)),
    ...checkStrafeFraction(plan, estimate, robot),
    ...checkMouthLeading(steps, robot, running),
    ...checkSweepSpeed(steps, robot, running),
  ];
}
