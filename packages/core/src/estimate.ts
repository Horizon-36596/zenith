import {
  evaluateEstimateExpression,
  parseEstimateExpression,
  UNKNOWN_ESTIMATE,
  type CommandSpec,
  type Robot,
  type Step,
} from "@horizon36596/zenith-schema";
import { wrapAngle } from "./geometry/angle.js";
import type { PathGeometry } from "./geometry/path.js";
import {
  decelInPerS2,
  lateralAccelLimitInPerS2,
  robotLimits,
  velocityCapInPerS,
  type RobotLimits,
} from "./kinematics.js";
import { containsPath } from "./resolve.js";
import type { Estimate, Plan, PlanStep, StepEstimate } from "./types.js";

/**
 * The estimate's time model.
 *
 * Pedro v3 is a geometric follower with no trajectory, so there is no profile to read: this is a
 * kinematic model that states its assumptions (`estimate().explain`) and is calibrated against
 * recorded runs in `07`. Pure and deterministic; the same files always give the same seconds.
 */

/** Speeds below this are treated as a standstill, in in/s. */
const STOPPED_IN_PER_S = 1e-6;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One sample of the velocity profile along a path step. */
interface ProfileSample {
  sIn: number;
  /** The direction of travel minus the robot's heading: 0 is nose-first, pi/2 is a left strafe. */
  phiRad: number;
  /** The cap from the velocity ellipse, the heading rate and the curvature, all applied. */
  capInPerS: number;
  /** The coasting deceleration available in this travel direction. */
  decelInPerS2: number;
}

export interface PathTiming {
  seconds: number;
  strafeFraction: number;
  exitVelocityInPerS: number;
  /** Cumulative seconds at each plan sample, so a caller can turn a time into a place on the path. */
  timeAtSampleS: number[];
}

/** A finite difference over a sampled series that copes with the two ends and with repeats. */
function slope(values: readonly number[], positions: readonly number[], index: number): number {
  const previous = index === 0 ? index : index - 1;
  const next = index === values.length - 1 ? index : index + 1;
  const ds = (positions[next] as number) - (positions[previous] as number);
  if (Math.abs(ds) < 1e-9) return 0;
  return wrapAngle((values[next] as number) - (values[previous] as number)) / ds;
}

/**
 * Builds the per-sample caps of `03` section 3 steps 1, 4 and 5: the direction-dependent velocity
 * ellipse, the heading-rate limit and the curvature cap.
 *
 * `headingAt` lets the caller ask what the same geometry would cost driven nose-first, which is how
 * the strafe cost in seconds is worked out.
 */
function profileSamples(
  step: PlanStep,
  geometry: PathGeometry,
  limits: RobotLimits,
  speedFraction: number,
  headings: readonly number[],
): ProfileSample[] {
  const positions = step.samples.map((sample) => sample.sIn);
  const travel = step.samples.map((sample) => {
    const tangent = geometry.tangentAtDistance(sample.sIn);
    return Math.atan2(tangent.yIn, tangent.xIn);
  });

  return step.samples.map((sample, index) => {
    const phiRad = wrapAngle((travel[index] as number) - (headings[index] as number));
    let cap = speedFraction * velocityCapInPerS(limits, phiRad);

    const headingRatePerIn = Math.abs(slope(headings, positions, index));
    if (headingRatePerIn > 1e-9) {
      cap = Math.min(cap, limits.maxAngularVelRadPerS / headingRatePerIn);
    }

    const curvaturePerIn = Math.abs(slope(travel, positions, index));
    if (curvaturePerIn > 1e-9) {
      cap = Math.min(cap, Math.sqrt(lateralAccelLimitInPerS2(limits) / curvaturePerIn));
    }

    return { sIn: sample.sIn, phiRad, capInPerS: cap, decelInPerS2: decelInPerS2(limits, phiRad) };
  });
}

/**
 * The two-pass profile of `03` section 3 step 6: take the minimum of the caps, raise it forwards
 * under `accel` from the entry velocity, lower it backwards under the direction's deceleration into
 * the exit velocity, then integrate `ds / v`.
 */
export function integrateProfile(
  samples: readonly ProfileSample[],
  limits: RobotLimits,
  entryVelocityInPerS: number,
  exitVelocityInPerS: number,
): PathTiming {
  const count = samples.length;
  if (count === 0) {
    return { seconds: 0, strafeFraction: 0, exitVelocityInPerS: 0, timeAtSampleS: [] };
  }
  if (count === 1) {
    return {
      seconds: 0,
      strafeFraction: 0,
      exitVelocityInPerS: entryVelocityInPerS,
      timeAtSampleS: [0],
    };
  }

  const velocities = samples.map((sample) => sample.capInPerS);
  velocities[0] = Math.min(velocities[0] as number, entryVelocityInPerS);
  for (let i = 1; i < count; i += 1) {
    const ds = (samples[i] as ProfileSample).sIn - (samples[i - 1] as ProfileSample).sIn;
    const reachable = Math.sqrt(
      (velocities[i - 1] as number) ** 2 + 2 * limits.accelInPerS2 * Math.max(ds, 0),
    );
    velocities[i] = Math.min(velocities[i] as number, reachable);
  }

  velocities[count - 1] = Math.min(velocities[count - 1] as number, exitVelocityInPerS);
  for (let i = count - 2; i >= 0; i -= 1) {
    const ds = (samples[i + 1] as ProfileSample).sIn - (samples[i] as ProfileSample).sIn;
    const stoppable = Math.sqrt(
      (velocities[i + 1] as number) ** 2 +
        2 * (samples[i] as ProfileSample).decelInPerS2 * Math.max(ds, 0),
    );
    velocities[i] = Math.min(velocities[i] as number, stoppable);
  }

  let seconds = 0;
  let sidewaysIn = 0;
  let totalIn = 0;
  const timeAtSampleS: number[] = [0];
  for (let i = 1; i < count; i += 1) {
    const before = samples[i - 1] as ProfileSample;
    const after = samples[i] as ProfileSample;
    const ds = after.sIn - before.sIn;
    if (ds <= 0) {
      timeAtSampleS.push(seconds);
      continue;
    }
    const mean = ((velocities[i - 1] as number) + (velocities[i] as number)) / 2;
    seconds += mean <= STOPPED_IN_PER_S ? 0 : ds / mean;
    timeAtSampleS.push(seconds);
    totalIn += ds;
    // Each interval is attributed half to the sample at each of its ends, so a leg that is
    // sideways throughout scores exactly 1 and a nose-first leg exactly 0.
    for (const sample of [before, after]) {
      if (Math.abs(Math.sin(sample.phiRad)) > Math.abs(Math.cos(sample.phiRad))) {
        sidewaysIn += ds / 2;
      }
    }
  }

  return {
    seconds,
    // Clamped because the halves are summed in floating point: a leg that is sideways throughout
    // must read exactly 1, not 1.0000000000000002.
    strafeFraction: totalIn === 0 ? 0 : Math.min(1, Math.max(0, sidewaysIn / totalIn)),
    exitVelocityInPerS: velocities[count - 1] as number,
    timeAtSampleS,
  };
}

/** The numbers a command's `estimateS` expression may name: its arguments, resolved to seconds. */
export function commandScope(
  spec: CommandSpec | undefined,
  args: Readonly<Record<string, string | number | boolean>> | undefined,
  robot: Robot,
): Record<string, number> {
  const durations = namedDurations(robot);
  const scope: Record<string, number> = {};

  const put = (name: string, raw: string | number | boolean | undefined): void => {
    if (raw === undefined) return;
    if (typeof raw === "number") scope[name] = raw;
    else if (typeof raw === "boolean") scope[name] = raw ? 1 : 0;
    else {
      // An enum argument stands for a duration the robot file tabulates, which is how
      // `0.6 + count * cadence` reads `shooter.cadenceS.rapid` (site/docs/file-format.md).
      const seconds = durations.get(raw);
      if (seconds !== undefined) scope[name] = seconds;
    }
  };

  for (const [name, param] of Object.entries(spec?.params ?? {})) {
    const fromArgs = args?.[name];
    put(name, fromArgs ?? ("default" in param ? param.default : undefined));
  }
  for (const [name, raw] of Object.entries(args ?? {})) {
    if (!(name in scope)) put(name, raw);
  }
  return scope;
}

/** Every `name: seconds` pair the robot file tabulates under `shooter`, such as the shot cadences. */
function namedDurations(robot: Robot): Map<string, number> {
  const durations = new Map<string, number>();
  const shooter: unknown = robot.shooter;
  if (!isRecord(shooter)) return durations;
  for (const table of Object.values(shooter)) {
    if (!isRecord(table)) continue;
    for (const [name, value] of Object.entries(table)) {
      if (name === "value" || name === "provenance") continue;
      if (typeof value === "number") durations.set(name, value);
    }
  }
  return durations;
}

/** The seconds a command step takes, or null when its registry entry says `"unknown"`. */
export function commandSeconds(
  name: string,
  args: Readonly<Record<string, string | number | boolean>> | undefined,
  robot: Robot,
): number | null {
  const spec = robot.commands.find((command) => command.name === name);
  if (spec === undefined) return null;
  if (spec.estimateS.trim() === UNKNOWN_ESTIMATE) return null;
  let expression;
  try {
    expression = parseEstimateExpression(spec.estimateS);
  } catch {
    return null;
  }
  const seconds = evaluateEstimateExpression(expression, commandScope(spec, args, robot));
  return seconds === null || !Number.isFinite(seconds) ? null : Math.max(seconds, 0);
}

/** True when the registry marks this command as one the robot stands still for. */
export const isStationary = (robot: Robot, name: string): boolean =>
  robot.commands.find((command) => command.name === name)?.stationary === true;

interface Carry {
  velocityInPerS: number;
}

/**
 * Per-step `{nominalS, lowS, highS, strafeFraction, strafeCostS, unknown}` and the total with its
 * band, from the model of `03` section 3. Deterministic and pure.
 */
export function estimate(plan: Plan, robot: Robot): Estimate {
  const limits = robotLimits(robot);
  const assumptions = explain(plan, robot, limits);
  const byStepId: Record<string, StepEstimate> = {};

  const band = (seconds: number | null): { lowS: number | null; highS: number | null } =>
    seconds === null
      ? { lowS: null, highS: null }
      : {
          lowS: seconds * (1 - limits.bandFraction),
          highS: seconds * (1 + limits.bandFraction),
        };

  const record = (row: StepEstimate): StepEstimate => {
    byStepId[row.stepId] = row;
    return row;
  };

  const blank = (
    step: PlanStep,
    seconds: number | null,
    carry: Carry,
    exitVelocityInPerS: number,
  ): StepEstimate => {
    carry.velocityInPerS = exitVelocityInPerS;
    return record({
      stepId: step.id,
      kind: step.kind,
      nominalS: seconds,
      ...band(seconds),
      strafeFraction: null,
      strafeCostS: null,
      unknown: seconds === null,
      exitVelocityInPerS,
    });
  };

  const estimatePath = (step: PlanStep, carry: Carry): StepEstimate => {
    const geometry = step.geometry;
    if (geometry === undefined || step.samples.length < 2) {
      return blank(step, limits.settleS, carry, 0);
    }
    const pathStep = step.step as Extract<Step, { kind: "path" }>;
    const speedFraction = pathStep.speedFraction ?? limits.defaultPathSpeedFraction;
    const headings = step.samples.map((sample) => sample.pose.headingRad);

    // The follower holds the end pose when `holdEnd` is set, so the step brakes to a stop; when it
    // does not, the backward pass leaves whatever the caps allow and the next step carries it on.
    const exitCap = limits.holdEnd ? 0 : Infinity;
    const planned = integrateProfile(
      profileSamples(step, geometry, limits, speedFraction, headings),
      limits,
      carry.velocityInPerS,
      exitCap,
    );

    // The same geometry driven nose-first, which is what "make tangent" would produce and so what
    // the strafing on this leg actually costs (`03` section 5).
    const tangentHeadings = step.samples.map((sample) => {
      const tangent = geometry.tangentAtDistance(sample.sIn);
      return Math.atan2(tangent.yIn, tangent.xIn);
    });
    const tangent = integrateProfile(
      profileSamples(step, geometry, limits, speedFraction, tangentHeadings),
      limits,
      carry.velocityInPerS,
      exitCap,
    );

    const nominalS = planned.seconds + limits.settleS;
    carry.velocityInPerS = planned.exitVelocityInPerS;
    // A step with an endCondition stops when a sensor says so, which can only be sooner than
    // driving the whole path: the seconds stay as the upper bound they are, and `unknown` says the
    // number is a bound rather than a prediction, so the timeline hatches it and the time budget
    // does not read the total as firm.
    const endsOnCondition = pathStep.endCondition !== undefined;
    return record({
      stepId: step.id,
      kind: step.kind,
      nominalS,
      ...band(nominalS),
      strafeFraction: planned.strafeFraction,
      strafeCostS: Math.max(planned.seconds - tangent.seconds, 0),
      unknown: endsOnCondition,
      exitVelocityInPerS: planned.exitVelocityInPerS,
      timeAtSampleS: planned.timeAtSampleS,
    });
  };

  const estimateStep = (step: PlanStep, carry: Carry): StepEstimate => {
    switch (step.kind) {
      case "path":
        return estimatePath(step, carry);
      case "command": {
        const call = step.step as Extract<Step, { kind: "command" }>;
        const seconds = commandSeconds(call.name, call.args, robot);
        // A command the robot stands still for leaves it stopped; one that runs while the drive
        // keeps going (`setIntake`) leaves the carried velocity alone (`03` section 3 step 3).
        const stationary = isStationary(robot, call.name);
        return blank(step, seconds, carry, stationary ? 0 : carry.velocityInPerS);
      }
      case "wait": {
        const wait = step.step as Extract<Step, { kind: "wait" }>;
        return blank(step, wait.seconds ?? null, carry, 0);
      }
      case "sequence":
        return estimateSequenceGroup(step, carry);
      case "parallel":
        return estimateParallel(step, carry);
      case "branch":
        return estimateBranch(step, carry);
    }
  };

  /**
   * A sequence costs the sum of its members, and the speed carries through it exactly as it does
   * through the top-level list: a path inside it accelerates from wherever the step before the
   * sequence left the robot, and the step after the sequence starts from its last member's exit.
   *
   * A member with no predictable duration counts as zero, as it does in the routine's total, and
   * marks the sequence `unknown`; the sum is null only when no member is known at all.
   */
  const estimateSequenceGroup = (step: PlanStep, carry: Carry): StepEstimate => {
    const children = (step.children ?? []).map((child) => estimateStep(child, carry));
    const known = children.filter((child) => child.nominalS !== null);
    const nominalS =
      children.length > 0 && known.length === 0
        ? null
        : known.reduce((sum, child) => sum + (child.nominalS as number), 0);
    return record({
      stepId: step.id,
      kind: step.kind,
      nominalS,
      ...band(nominalS),
      strafeFraction: null,
      strafeCostS: null,
      unknown: children.some((child) => child.unknown),
      exitVelocityInPerS: carry.velocityInPerS,
      children,
    });
  };

  /**
   * Members that run at the same time. Each one starts from the speed the group was entered at and
   * gets its own carry: two paths in a `parallel` both begin where the robot was and neither hands
   * its exit speed to the other, which is the same reading CONTINUITY takes of their start poses.
   */
  const estimateConcurrent = (children: readonly PlanStep[], entry: Carry): StepEstimate[] =>
    children.map((child) => estimateStep(child, { velocityInPerS: entry.velocityInPerS }));

  /** Steps that run one after another, threading one carry, seeded from `entry`. */
  const estimateSequence = (children: readonly PlanStep[], entry: Carry): StepEstimate[] => {
    const inner: Carry = { velocityInPerS: entry.velocityInPerS };
    return children.map((child) => estimateStep(child, inner));
  };

  const estimateParallel = (step: PlanStep, carry: Carry): StepEstimate => {
    const group = step.step as Extract<Step, { kind: "parallel" }>;
    const children = estimateConcurrent(step.children ?? [], carry);
    const known = children.filter((child) => child.nominalS !== null).map((child) => child.nominalS as number);
    const anyUnknown = children.some((child) => child.unknown);

    let nominalS: number | null;
    let unknown = anyUnknown;
    if (group.mode === "deadline") {
      const deadline = children.find((child) => child.stepId === group.deadline);
      if (deadline === undefined) {
        // The group names no child that exists, which `check` raises a SCHEMA error for. Cost it
        // like `all` rather than returning null: the members still take the time they take, and a
        // null here would quietly subtract it from the routine total the time budget is judged on.
        nominalS = known.length === 0 ? null : Math.max(...known);
        unknown = true;
      } else {
        nominalS = deadline.nominalS;
        unknown = deadline.unknown;
      }
    } else if (group.mode === "race") {
      // The first child to finish ends the group, so a known child is an upper bound and an
      // unknown one could still come in under it.
      nominalS = known.length === 0 ? null : Math.min(...known);
    } else {
      nominalS = known.length === 0 ? null : Math.max(...known);
    }

    // The velocity carries through a parallel group from whichever child drives (`03` §3.3).
    const mover =
      children.find((child) => child.stepId === group.deadline && containsPath(child)) ??
      [...children].reverse().find(containsPath);
    const exitVelocityInPerS = mover?.exitVelocityInPerS ?? carry.velocityInPerS;
    carry.velocityInPerS = exitVelocityInPerS;

    return record({
      stepId: step.id,
      kind: step.kind,
      nominalS,
      ...band(nominalS),
      strafeFraction: null,
      strafeCostS: null,
      unknown,
      exitVelocityInPerS,
      children,
    });
  };

  const estimateBranch = (step: PlanStep, carry: Carry): StepEstimate => {
    const branch = step.step as Extract<Step, { kind: "branch" }>;
    const planned = step.children ?? [];
    const thenCount = branch.then.length;
    // Only one arm ever runs, so the `else` side starts from the entry speed as well, not from
    // wherever the `then` side happened to finish.
    const thenSide = estimateSequence(planned.slice(0, thenCount), carry);
    const elseSide = estimateSequence(planned.slice(thenCount), carry);
    const children = [...thenSide, ...elseSide];

    const total = (rows: readonly StepEstimate[]): number | null =>
      rows.some((row) => row.nominalS === null)
        ? null
        : rows.reduce((sum, row) => sum + (row.nominalS as number), 0);
    const thenS = total(thenSide);
    const elseS = elseSide.length === 0 ? 0 : total(elseSide);

    // Nobody can know which way a condition goes at planning time, so the branch costs the longer
    // side: a time budget that assumed the short one would be a promise the routine cannot keep.
    const nominalS = thenS === null || elseS === null ? null : Math.max(thenS, elseS);
    const exitVelocityInPerS = thenSide[thenSide.length - 1]?.exitVelocityInPerS ?? carry.velocityInPerS;
    carry.velocityInPerS = exitVelocityInPerS;

    return record({
      stepId: step.id,
      kind: step.kind,
      nominalS,
      ...band(nominalS),
      strafeFraction: null,
      strafeCostS: null,
      unknown: children.some((child) => child.unknown),
      exitVelocityInPerS,
      children,
    });
  };

  const carry: Carry = { velocityInPerS: 0 };
  const steps = plan.steps.map((step) => estimateStep(step, carry));

  const hasUnknown = steps.some((step) => step.unknown);
  const nominalS = steps.reduce((sum, step) => sum + (step.nominalS ?? 0), 0);

  return {
    steps,
    byStepId,
    nominalS,
    lowS: nominalS * (1 - limits.bandFraction),
    highS: nominalS * (1 + limits.bandFraction),
    hasUnknown,
    bandFraction: limits.bandFraction,
    assumptions,
    explain: assumptions,
  };
}

/** The sentences `zenith estimate --explain` prints: every assumption behind the numbers above. */
function explain(plan: Plan, robot: Robot, limits: RobotLimits): string[] {
  const round = (value: number, digits = 1): string => value.toFixed(digits);
  const percent = (value: number): string => `${round(value * 100, 0)} %`;
  const lines: string[] = [];

  lines.push(
    `Pedro v3 is a geometric follower with no trajectory to read, so these seconds come from a kinematic model of ${robot.name}, not from the follower.`,
  );
  lines.push(
    `The speed cap in a travel direction is the ellipse through ${round(limits.maxForwardVelInPerS)} in/s nose-on and ${round(limits.maxStrafeVelInPerS)} in/s sideways, scaled by the step's speedFraction (default ${round(limits.defaultPathSpeedFraction, 2)}).`,
  );
  lines.push(
    `Braking uses the same ellipse between ${round(limits.forwardDecelInPerS2)} in/s² forwards and ${round(limits.strafeDecelInPerS2)} in/s² sideways, which is why a sideways leg costs far more than the speed ratio suggests: stopping from full strafe takes ${round((limits.maxStrafeVelInPerS * limits.maxStrafeVelInPerS) / (2 * limits.strafeDecelInPerS2))} in against ${round((limits.maxForwardVelInPerS * limits.maxForwardVelInPerS) / (2 * limits.forwardDecelInPerS2))} in nose-first.`,
  );
  lines.push(
    `Acceleration is a flat ${round(limits.accelInPerS2)} in/s², applied from the velocity the previous step ended at; a stationary command and a wait both leave the robot at rest.`,
  );
  lines.push(
    limits.holdEnd
      ? "The follower holds the end pose, so every path step is braked to a standstill before the next one starts."
      : "The follower does not hold the end pose, so a path step hands its remaining speed to the step after it.",
  );
  lines.push(
    `A sample is slowed until the heading the mode demands fits inside ${round(limits.maxAngularVelRadPerS, 2)} rad/s.`,
  );
  lines.push(
    `Cornering is capped at sqrt(a · R) with a taken as the sideways deceleration, ${round(limits.strafeDecelInPerS2)} in/s². That is a proxy for how hard this drivetrain holds a curve, not a measurement.`,
  );
  lines.push(
    `Each path step adds ${round(limits.settleS, 2)} s of settle time for the follower to declare the end constraints met.`,
  );
  lines.push(
    `A command step is timed by its estimateS expression in robot.json; one that reads "unknown" is shown hatched and left out of the total, so the total is a lower bound.`,
  );
  lines.push(
    "A sequence costs the sum of its steps, with the speed carried through it; a parallel group costs the longest of its children under `all`, the shortest under `race`, and its deadline step under `deadline`; a branch costs the longer of its two sides.",
  );
  lines.push(
    `The band is nominal ± ${percent(limits.bandFraction)}${robot.kinematics.calibration === undefined ? ", the uncalibrated default until a recorded run narrows it" : `, fitted from a recorded run (${robot.kinematics.calibration.provenance ?? "no provenance recorded"})`}.`,
  );
  const periodS = plan.field.periods?.autoS;
  if (periodS !== undefined) {
    lines.push(`The autonomous period on this field is ${round(periodS, 0)} s.`);
  }
  return lines;
}

/**
 * Which way an estimate's total is a bound, when it is one. A step with no predictable duration
 * counts as zero seconds, so the routine takes at least the total ("lower"). A step that ends on a
 * condition is timed as if it drove its whole path, so the routine takes at most the total
 * ("upper"). When both kinds are present the total is only a lower bound on the known part, and
 * "lower" is reported because it is the claim that stays true. The renderer, the editor and the
 * pull-request body all read this one rule.
 */
export function totalBound(estimateResult: Estimate): "lower" | "upper" | null {
  if (!estimateResult.hasUnknown) return null;
  const rows = Object.values(estimateResult.byStepId);
  return rows.some((row) => row.unknown && row.nominalS === null) ? "lower" : "upper";
}
