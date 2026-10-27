import {
  evaluateEstimateExpression,
  parseEstimateExpression,
  UNKNOWN_ESTIMATE,
  type CommandSpec,
  type Robot,
  type Step,
} from "@horizon36596/zenith-schema";
import { driftTarget } from "./drift.js";
import { envelopeOf } from "./envelope.js";
import { angleDelta, wrapAngle } from "./geometry/angle.js";
import type { PathGeometry } from "./geometry/path.js";
import { distance, type Pose } from "./geometry/vec.js";
import {
  decelInPerS2,
  lateralAccelLimitInPerS2,
  robotLimits,
  turnInPlaceS,
  velocityCapInPerS,
  type RobotLimits,
} from "./kinematics.js";
import { containsPath } from "./resolve.js";
import { holdTurnRad, isTurnInPlace, TURN_IN_PLACE_MAX_IN } from "./turnInPlace.js";
import type { Estimate, Plan, PlanSample, PlanStep, StepEstimate } from "./types.js";

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

/** The step that starts first when `step` starts: the first member of a sequence, however deep. */
function firstToRun(step: PlanStep): PlanStep {
  let first = step;
  while (first.kind === "sequence" && first.children !== undefined && first.children.length > 0) {
    first = first.children[0] as PlanStep;
  }
  return first;
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
 * The speed cap at one point of a path, in in/s: `03` section 3 steps 1, 4 and 5. It is the
 * velocity ellipse in the travel direction `phiRad` off the nose, scaled by the step's speed
 * fraction, then lowered until the heading rate fits the angular-velocity limit and until the
 * curvature fits the cornering cap. A rate or a curvature at or below 1e-9 per inch is no turn.
 *
 * `profileSamples` reads it at every plan sample, and the optimizer's heading dynamic program
 * (`optimize/headingDp.ts`) reads the same caps on its own lattice, so the two price a heading
 * the same way.
 */
export function sampleCapInPerS(
  limits: RobotLimits,
  speedFraction: number,
  phiRad: number,
  headingRatePerIn: number,
  curvaturePerIn: number,
): number {
  let cap = speedFraction * velocityCapInPerS(limits, phiRad);
  if (headingRatePerIn > 1e-9) {
    cap = Math.min(cap, limits.maxAngularVelRadPerS / headingRatePerIn);
  }
  if (curvaturePerIn > 1e-9) {
    cap = Math.min(cap, Math.sqrt(lateralAccelLimitInPerS2(limits) / curvaturePerIn));
  }
  return cap;
}

/**
 * Builds the per-sample caps of `03` section 3 steps 1, 4 and 5 (`sampleCapInPerS`) along a path
 * step, with the heading rate and the curvature taken as finite differences over the samples.
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
    const headingRatePerIn = Math.abs(slope(headings, positions, index));
    const curvaturePerIn = Math.abs(slope(travel, positions, index));
    const cap = sampleCapInPerS(limits, speedFraction, phiRad, headingRatePerIn, curvaturePerIn);
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

/** Position gaps at or below this are the same place, in inches: canonical form rounds to 1e-4. */
export const IDEAL_POSITION_TOLERANCE_IN = 0.01;

/** Heading gaps at or below this are the same heading, in radians. */
export const IDEAL_HEADING_TOLERANCE_RAD = 1e-3;

/** Spacing of the profile samples along a transition, in inches, the same as a path's. */
const TRANSITION_SPACING_IN = 2;

/** A straight move from one pose to another, turning as it goes, timed from rest to rest. */
export interface TransitionProfile {
  /** How far it drives, in inches; 0 for a turn in place. */
  translateIn: number;
  /** How far it turns, signed, the short way, in radians. */
  turnRad: number;
  /** Distance along the straight line at each profile sample, in inches. */
  sIns: number[];
  /** Seconds from the start at each of those samples; the last is the move's duration. */
  timesS: number[];
}

/**
 * The seconds and the profile of a straight move between two poses, which the ideal playback level
 * draws its transitions with. A pure turn is timed at the robot's angular velocity limit, the joint
 * turn of `03` section 3 step 8. A move samples the line at equal intervals of at most 2 in, turns the heading evenly with
 * the distance, caps each sample by the velocity ellipse at the default speed fraction and by the
 * heading rate, and integrates from rest to rest with the two-pass profile the path steps use.
 */
export function transitionProfile(from: Pose, to: Pose, limits: RobotLimits): TransitionProfile {
  const translateIn = distance(from, to);
  const turnRad = angleDelta(from.headingRad, to.headingRad);
  if (translateIn <= IDEAL_POSITION_TOLERANCE_IN) {
    return { translateIn: 0, turnRad, sIns: [0, 0], timesS: [0, turnInPlaceS(limits, turnRad)] };
  }

  // Equal intervals of at most the spacing: a short last interval would pin both of its ends near
  // rest and make a move just past a multiple of the spacing take far longer than a shorter one.
  const intervals = Math.max(1, Math.ceil(translateIn / TRANSITION_SPACING_IN - 1e-9));
  const sIns = Array.from({ length: intervals + 1 }, (_, index) =>
    index === intervals ? translateIn : (translateIn * index) / intervals,
  );
  const travelRad = Math.atan2(to.yIn - from.yIn, to.xIn - from.xIn);
  const headingRatePerIn = Math.abs(turnRad) / translateIn;
  const samples = sIns.map((sIn) => {
    const headingRad = wrapAngle(from.headingRad + turnRad * (sIn / translateIn));
    const phiRad = wrapAngle(travelRad - headingRad);
    let capInPerS = limits.defaultPathSpeedFraction * velocityCapInPerS(limits, phiRad);
    if (headingRatePerIn > 1e-9) capInPerS = Math.min(capInPerS, limits.maxAngularVelRadPerS / headingRatePerIn);
    return { sIn, phiRad, capInPerS, decelInPerS2: decelInPerS2(limits, phiRad) };
  });
  if (samples.length === 2) {
    // One interval from rest to rest: both ends of the two-pass profile are pinned at zero, and its
    // mean speed would make the move take no time. Accelerate, cruise at the lower cap of the two
    // ends if the move is long enough to reach it, and brake, in closed form.
    const capInPerS = Math.min(...samples.map((sample) => sample.capInPerS));
    const decel = Math.min(...samples.map((sample) => sample.decelInPerS2));
    return { translateIn, turnRad, sIns, timesS: [0, restToRestS(translateIn, capInPerS, limits.accelInPerS2, decel)] };
  }
  const timing = integrateProfile(samples, limits, 0, 0);
  return { translateIn, turnRad, sIns, timesS: timing.timeAtSampleS };
}

/** Seconds to drive `distanceIn` from rest to rest, accelerating and braking at the given rates, at most `capInPerS`. */
function restToRestS(distanceIn: number, capInPerS: number, accelInPerS2: number, decelInPerS2: number): number {
  if (capInPerS <= STOPPED_IN_PER_S) return 0;
  const peakInPerS = Math.sqrt((2 * distanceIn * accelInPerS2 * decelInPerS2) / (accelInPerS2 + decelInPerS2));
  if (peakInPerS <= capInPerS) return peakInPerS / accelInPerS2 + peakInPerS / decelInPerS2;
  const rampIn = (capInPerS * capInPerS) / (2 * accelInPerS2) + (capInPerS * capInPerS) / (2 * decelInPerS2);
  return capInPerS / accelInPerS2 + capInPerS / decelInPerS2 + (distanceIn - rampIn) / capInPerS;
}

/**
 * The joint turn: the seconds the robot spends turning in place before a path that starts on the
 * spot it arrives at but facing another way, such as a tangent path that leaves a corner in a new
 * direction (`03` section 3 step 8). It is the pure-turn case of `transitionProfile`, so the estimate
 * and the ideal level time the same turn the same way.
 *
 * Zero when the headings agree within `IDEAL_HEADING_TOLERANCE_RAD`, and zero when the path starts
 * more than `IDEAL_POSITION_TOLERANCE_IN` from where the robot is: that is a literal-pose gap, a
 * drive the estimate does not time, and the ideal level closes it with a transition it times itself.
 */
export function jointTurnS(arrival: Pose, start: Pose, limits: RobotLimits): number {
  if (distance(arrival, start) > IDEAL_POSITION_TOLERANCE_IN) return 0;
  const turnRad = angleDelta(arrival.headingRad, start.headingRad);
  if (Math.abs(turnRad) <= IDEAL_HEADING_TOLERANCE_RAD) return 0;
  return turnInPlaceS(limits, turnRad);
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

/**
 * The seconds a step's envelope times it for, or null when it has no envelope: its what-if
 * `actualDurationS` when the author set one, else `maxDurationS`, the longest it runs (issue #481).
 * A partner's projection reads `maxDurationS` itself, since that is the promise.
 */
export const envelopeWindowS = (step: Step): number | null => {
  const envelope = envelopeOf(step);
  if (envelope === undefined) return null;
  return envelope.actualDurationS ?? envelope.maxDurationS;
};

/** True when a step's envelope carries a what-if run time (`actualDurationS`). */
export const hasActualDuration = (step: Step): boolean => envelopeOf(step)?.actualDurationS !== undefined;

/** A path, command or wait step's `timeoutS`, or undefined when it has none or its kind has none. */
export const stepTimeoutS = (step: Step): number | undefined =>
  step.kind === "path" || step.kind === "command" || step.kind === "wait" ? step.timeoutS : undefined;

/** True when the registry marks this command as one the robot stands still for. */
export const isStationary = (robot: Robot, name: string): boolean =>
  robot.commands.find((command) => command.name === name)?.stationary === true;

interface Carry {
  velocityInPerS: number;
  /** Where the robot is and which way it faces as the next step starts, for the joint turn. */
  pose: Pose;
}

/**
 * Per-step `{nominalS, lowS, highS, strafeFraction, strafeCostS, unknown}` and the total with its
 * band, from the model of `03` section 3. Deterministic and pure.
 */
export function estimate(plan: Plan, robot: Robot): Estimate {
  const limits = robotLimits(robot);
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

  /**
   * A command or a wait. One whose own duration nobody can predict takes its envelope's window
   * instead, when it declares one (spec 13 section 10): the author has said the step is over by
   * then, so the window is the number the timeline and the time budget read, not a hatched zero.
   */
  const blank = (
    step: PlanStep,
    ownSeconds: number | null,
    carry: Carry,
    exitVelocityInPerS: number,
  ): StepEstimate => {
    carry.velocityInPerS = exitVelocityInPerS;
    const declaredS = ownSeconds === null ? envelopeWindowS(step.step) : null;
    const seconds = ownSeconds ?? declaredS;
    return record({
      stepId: step.id,
      kind: step.kind,
      nominalS: seconds,
      ...band(seconds),
      strafeFraction: null,
      strafeCostS: null,
      unknown: seconds === null,
      exitVelocityInPerS,
      ...(declaredS === null ? {} : { fromEnvelope: true }),
      ...(declaredS !== null && hasActualDuration(step.step) ? { fromActualDuration: true } : {}),
    });
  };

  /**
   * `next` is the step that runs straight after this one in the same list, when there is one. When
   * it is another path the runtime never waits for the end constraints: `FollowPath` finishes once
   * the follower passes the end of its last segment, still moving, and the next path's `follow`
   * replaces the hold on that same loop (ADR 0003). So the step costs no settle time and the robot
   * does not sit at the joint. It still brakes into it, because Pedro brakes into the end of every
   * path it is given; a path step with several segments is what flows through a joint.
   *
   * Where the path starts on the spot the robot is at but facing another way, the robot first turns
   * in place (`jointTurnS`, `03` section 3 step 8). The turn is part of the step's own seconds, under
   * its band, and it starts the drive from rest.
   */
  const estimatePath = (step: PlanStep, carry: Carry, next: PlanStep | undefined): StepEstimate => {
    const settleS = next !== undefined && firstToRun(next).kind === "path" ? 0 : limits.settleS;
    const geometry = step.geometry;
    if (geometry === undefined || step.samples.length < 2) {
      return blank(step, settleS, carry, 0);
    }
    const pathStep = step.step as Extract<Step, { kind: "path" }>;
    if (isTurnInPlace(step)) return estimateTurn(step, pathStep, carry);
    const speedFraction = pathStep.speedFraction ?? limits.defaultPathSpeedFraction;
    const headings = step.samples.map((sample) => sample.pose.headingRad);
    const turnS = jointTurnS(carry.pose, step.startPose, limits);
    const entryVelocityInPerS = turnS > 0 ? 0 : carry.velocityInPerS;

    // The follower holds the end pose when `holdEnd` is set, so the step brakes to a stop; when it
    // does not, the backward pass leaves whatever the caps allow and the next step carries it on.
    const exitCap = limits.holdEnd ? 0 : Infinity;
    const planned = integrateProfile(
      profileSamples(step, geometry, limits, speedFraction, headings),
      limits,
      entryVelocityInPerS,
      exitCap,
    );

    // The same geometry driven nose-first, which is what "make tangent" would produce and so what
    // the strafing on this leg actually costs (`03` section 5). Like for like: driven nose-first, the
    // leg opens with whatever turn on the spot the nose-first heading needs from the way the robot
    // arrives, as this one opens with its own, so a leg the robot already faces across can be
    // cheaper as it is (0.1.2 UX sweep W2-3).
    const tangentHeadings = step.samples.map((sample) => {
      const tangent = geometry.tangentAtDistance(sample.sIn);
      return Math.atan2(tangent.yIn, tangent.xIn);
    });
    const tangentTurnS = jointTurnS(carry.pose, { ...step.startPose, headingRad: tangentHeadings[0] ?? step.startPose.headingRad }, limits);
    const tangent = integrateProfile(
      profileSamples(step, geometry, limits, speedFraction, tangentHeadings),
      limits,
      tangentTurnS > 0 ? 0 : carry.velocityInPerS,
      exitCap,
    );

    // A path this short is run by the runtime as a turn on the spot (`TURN_IN_PLACE_MAX_IN`), and
    // its samples are too few for the heading-rate cap to see the turn, so it takes at least the time
    // its heading change takes at the angular limit; the clock along it is stretched to match.
    let driveS = planned.seconds;
    let timeAtSampleS = planned.timeAtSampleS;
    const endRad = (step.endPose ?? step.samples[step.samples.length - 1]?.pose ?? step.startPose).headingRad;
    const floorS = geometry.lengthIn <= TURN_IN_PLACE_MAX_IN ? turnInPlaceS(limits, holdTurnRad(step.startPose.headingRad, endRad)) : 0;
    if (floorS > driveS) {
      const scale = driveS > 0 ? floorS / driveS : null;
      const last = Math.max(1, timeAtSampleS.length - 1);
      timeAtSampleS = timeAtSampleS.map((seconds, index) => (scale === null ? (floorS * index) / last : seconds * scale));
      driveS = floorS;
    }

    const nominalS = turnS + driveS + settleS;
    carry.velocityInPerS = planned.exitVelocityInPerS;
    carry.pose = step.endPose ?? step.samples[step.samples.length - 1]?.pose ?? carry.pose;
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
      strafeCostS: Math.max(turnS + planned.seconds - (tangentTurnS + tangent.seconds), 0),
      unknown: endsOnCondition,
      exitVelocityInPerS: planned.exitVelocityInPerS,
      timeAtSampleS,
      ...(turnS > 0 ? { turnS } : {}),
    });
  };

  /**
   * A turn on the spot (`turnInPlace.ts`): the runtime holds the end pose until it settles, so
   * the step costs the turn from the heading the robot arrives with to the end heading at the
   * angular limit, the plan's samples spread evenly over it, and no settle on top, because the step
   * ends when the robot has settled on the spot. The robot is at rest at both ends of it.
   */
  const estimateTurn = (step: PlanStep, pathStep: Extract<Step, { kind: "path" }>, carry: Carry): StepEstimate => {
    const first = (step.samples[0] as PlanSample).pose;
    const end = step.endPose ?? (step.samples[step.samples.length - 1] as PlanSample).pose;
    const seconds = turnInPlaceS(limits, holdTurnRad(first.headingRad, end.headingRad));
    const last = Math.max(1, step.samples.length - 1);
    carry.velocityInPerS = 0;
    carry.pose = end;
    return record({
      stepId: step.id,
      kind: step.kind,
      nominalS: seconds,
      ...band(seconds),
      strafeFraction: 0,
      strafeCostS: 0,
      unknown: pathStep.endCondition !== undefined,
      exitVelocityInPerS: 0,
      timeAtSampleS: step.samples.map((_, index) => (seconds * index) / last),
    });
  };

  /**
   * A step's `timeoutS` ends it however long it would otherwise take, so it bounds the step's
   * seconds. A step with no estimate of its own takes at most its timeout, which becomes its
   * `highS` while it still counts as zero in the total. A step whose estimate is longer than its
   * timeout is stopped when the timeout runs out, so its seconds are the timeout and `uncappedS`
   * keeps what it would have taken, which TIMEOUT_TIGHT reads. Otherwise only its `highS` is capped.
   */
  const withTimeout = (step: PlanStep, row: StepEstimate): StepEstimate => {
    const timeoutS = stepTimeoutS(step.step);
    if (timeoutS === undefined) return row;
    if (row.nominalS === null) return record({ ...row, highS: timeoutS });
    if (row.nominalS <= timeoutS) {
      return row.highS === null || row.highS <= timeoutS ? row : record({ ...row, highS: timeoutS });
    }
    return record({
      ...row,
      nominalS: timeoutS,
      lowS: Math.min(row.lowS ?? timeoutS, timeoutS),
      highS: timeoutS,
      uncappedS: row.nominalS,
    });
  };

  const estimateStep = (step: PlanStep, carry: Carry, next?: PlanStep): StepEstimate => {
    switch (step.kind) {
      case "path":
        return withTimeout(step, estimatePath(step, carry, next));
      case "command": {
        const call = step.step as Extract<Step, { kind: "command" }>;
        const seconds = commandSeconds(call.name, call.args, robot);
        // A command the robot stands still for leaves it stopped; one that runs while the drive
        // keeps going (`setIntake`) leaves the carried velocity alone (`03` section 3 step 3).
        const stationary = isStationary(robot, call.name);
        const row = withTimeout(step, blank(step, seconds, carry, stationary ? 0 : carry.velocityInPerS));
        // A command that drives the robot to the next path's rejoin pose (`drift.ts`) ends there, at
        // rest, as the ideal playback and the instant sim show it, so the next step starts from
        // there: a path that starts there facing another way turns in place first.
        const target = driftTarget(step, robot);
        if (target !== null && (row.nominalS ?? 0) > 0) {
          carry.pose = target;
          carry.velocityInPerS = 0;
          row.exitVelocityInPerS = 0;
        }
        return row;
      }
      case "wait": {
        const wait = step.step as Extract<Step, { kind: "wait" }>;
        return withTimeout(step, blank(step, wait.seconds ?? null, carry, 0));
      }
      case "transfer":
        // The robot runtime runs a planner-only transfer as a wait of zero seconds, so it takes
        // no time and, like any wait, leaves the robot at rest.
        return blank(step, 0, carry, 0);
      case "sequence":
        return estimateSequenceGroup(step, carry, next);
      case "parallel":
        return estimateParallel(step, carry);
      case "branch":
        return estimateBranch(step, carry);
    }
  };

  /**
   * Steps that run one after another on `carry`, each told which step follows it. The last one is
   * followed by `after`, the step after the list, so a sequence and the flat list agree.
   */
  const estimateInOrder = (
    children: readonly PlanStep[],
    carry: Carry,
    after?: PlanStep,
  ): StepEstimate[] =>
    children.map((child, index) => estimateStep(child, carry, children[index + 1] ?? after));

  /**
   * A sequence costs the sum of its members, and the speed carries through it exactly as it does
   * through the top-level list: a path inside it accelerates from wherever the step before the
   * sequence left the robot, and the step after the sequence starts from its last member's exit.
   *
   * A member with no predictable duration counts as zero, as it does in the routine's total, and
   * marks the sequence `unknown`; the sum is null only when no member is known at all.
   */
  const estimateSequenceGroup = (step: PlanStep, carry: Carry, next: PlanStep | undefined): StepEstimate => {
    const children = estimateInOrder(step.children ?? [], carry, next);
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
   * Members that run at the same time. Each one starts from the speed and the pose the group was
   * entered at and gets its own carry: two paths in a `parallel` both begin where the robot was and
   * neither hands its exit speed to the other, which is the same reading CONTINUITY takes of their
   * start poses. `exits` receives each member's carry, in order, for the group to carry on from.
   */
  const estimateConcurrent = (children: readonly PlanStep[], entry: Carry, exits: Carry[] = []): StepEstimate[] =>
    children.map((child) => {
      const own: Carry = { ...entry };
      exits.push(own);
      return estimateStep(child, own);
    });

  /** Steps that run one after another from `entry`, threading one carry, which ends where they do. */
  const estimateSequence = (children: readonly PlanStep[], entry: Carry): { rows: StepEstimate[]; exit: Carry } => {
    const exit: Carry = { ...entry };
    return { rows: estimateInOrder(children, exit), exit };
  };

  const estimateParallel = (step: PlanStep, carry: Carry): StepEstimate => {
    const group = step.step as Extract<Step, { kind: "parallel" }>;
    const exits: Carry[] = [];
    const children = estimateConcurrent(step.children ?? [], carry, exits);
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
      // unknown one could still come in under it. A child with no estimate but a timeout ends by
      // its timeout (its `highS`), so it bounds the group too: the rule TIME_BUDGET's `worstS` uses.
      const ends = children
        .map((child) => child.nominalS ?? child.highS)
        .filter((seconds): seconds is number => seconds !== null);
      nominalS = ends.length === 0 ? null : Math.min(...ends);
    } else {
      nominalS = known.length === 0 ? null : Math.max(...known);
    }

    // The velocity carries through a parallel group from whichever child drives (`03` §3.3).
    const mover =
      children.find((child) => child.stepId === group.deadline && containsPath(child)) ??
      [...children].reverse().find(containsPath);
    const exitVelocityInPerS = mover?.exitVelocityInPerS ?? carry.velocityInPerS;
    carry.velocityInPerS = exitVelocityInPerS;
    // The robot ends where the member that drives leaves it, as the ideal level draws it.
    carry.pose = (mover === undefined ? undefined : exits[children.indexOf(mover)]?.pose) ?? carry.pose;

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
    // Only one arm ever runs, so the `else` side starts from the entry speed and pose as well, not
    // from wherever the `then` side happened to finish.
    const thenRun = estimateSequence(planned.slice(0, thenCount), carry);
    const thenSide = thenRun.rows;
    const elseSide = estimateSequence(planned.slice(thenCount), carry).rows;
    const children = [...thenSide, ...elseSide];

    // Each side totals like a sequence: a step with no predictable duration counts as zero and
    // marks the branch `unknown`, and a side is null only when none of its steps is known.
    const total = (rows: readonly StepEstimate[]): number | null => {
      const known = rows.filter((row) => row.nominalS !== null);
      return rows.length > 0 && known.length === 0 ? null : known.reduce((sum, row) => sum + (row.nominalS as number), 0);
    };
    const sides = [total(thenSide), total(elseSide)].filter((seconds): seconds is number => seconds !== null);

    // Nobody can know which way a condition goes at planning time, so the branch costs the longer
    // side: a time budget that assumed the short one would be a promise the routine cannot keep.
    const nominalS = sides.length === 0 ? null : Math.max(...sides);
    const exitVelocityInPerS = thenSide[thenSide.length - 1]?.exitVelocityInPerS ?? carry.velocityInPerS;
    carry.velocityInPerS = exitVelocityInPerS;
    // The ideal level and the instant sim drive the `then` side, so the robot ends where it does.
    carry.pose = thenRun.exit.pose;

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

  const carry: Carry = { velocityInPerS: 0, pose: plan.startPose };
  const steps = estimateInOrder(plan.steps, carry);
  const assumptions = explain(
    plan,
    robot,
    limits,
    Object.values(byStepId).some((row) => (row.turnS ?? 0) > 0),
    Object.values(byStepId).some((row) => row.uncappedS !== undefined || (row.nominalS === null && row.highS !== null)),
  );

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

const flattenPlan = (steps: readonly PlanStep[]): PlanStep[] =>
  steps.flatMap((step) => [step, ...flattenPlan(step.children ?? [])]);

/**
 * The sentences `zenith estimate --explain` prints: every assumption behind the numbers above.
 * `turns` is true when at least one path step opens with a joint turn, and `timeouts` when a
 * step's `timeoutS` bounds its seconds.
 */
function explain(plan: Plan, robot: Robot, limits: RobotLimits, turns: boolean, timeouts: boolean): string[] {
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
  if (turns) {
    lines.push(
      `A path that starts where the robot is but facing another way, such as a tangent path leaving a corner, first turns in place at ${round(limits.maxAngularVelRadPerS, 2)} rad/s and drives off from rest; the turn is part of that path step's time.`,
    );
  }
  if (flattenPlan(plan.steps).some(isTurnInPlace)) {
    lines.push(
      `A turn on the spot, a path step with no length, is held at its end heading until it settles, so it costs the turn from the way the robot arrives at ${round(limits.maxAngularVelRadPerS, 2)} rad/s, with no settle time on top. A path of ${round(TURN_IN_PLACE_MAX_IN, 0)} in or less takes at least the time its heading change takes at that rate.`,
    );
  }
  lines.push(
    `Cornering is capped at sqrt(a · R) with a taken as the sideways deceleration, ${round(limits.strafeDecelInPerS2)} in/s². That is a proxy for how hard this drivetrain holds a curve, not a measurement.`,
  );
  lines.push(
    `Each path step adds ${round(limits.settleS, 2)} s of settle time for the follower to declare the end constraints met, except one followed straight away by another path: the runtime starts that path without waiting, so the robot brakes into the joint but does not sit there.`,
  );
  lines.push(
    `A command step is timed by its estimateS expression in robot.json; one that reads "unknown" is shown hatched and left out of the total, so the total is a lower bound.`,
  );
  if (timeouts) {
    lines.push(
      "A step's timeoutS ends it when it runs out: a step with no estimate of its own takes at most its timeout, and one estimated longer than its timeout is counted at the timeout, where the robot stops it.",
    );
  }
  if (flattenPlan(plan.steps).some((step) => envelopeWindowS(step.step) !== null)) {
    lines.push(
      "A command or wait with no estimate of its own but an envelope is timed by the envelope's maxDurationS, the longest the author says it runs, or by its actualDurationS when the author set that what-if.",
    );
  }
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
 *
 * Given the plan, a step its group stops early is left out, as TIME_BUDGET's note leaves it out
 * (`membersThatCount`): a member of a `deadline` group other than its deadline, and a member of a
 * `race` that another member is sure to end. A race member with no estimate but a timeout is not a
 * zero either, since the race counts it at its timeout, which can only be later than the race ends.
 */
export function totalBound(estimateResult: Estimate, plan?: Pick<Plan, "steps">): "lower" | "upper" | null {
  if (!estimateResult.hasUnknown) return null;
  const planned = new Map(flattenPlan(plan?.steps ?? []).map((step) => [step.id, step]));
  const ignored = new Set<string>();
  const ignore = (row: StepEstimate): void => {
    ignored.add(row.stepId);
    for (const child of row.children ?? []) ignore(child);
  };
  const walk = (rows: readonly StepEstimate[]): void => {
    for (const row of rows) {
      const children = row.children;
      if (children === undefined) continue;
      const step = planned.get(row.stepId)?.step;
      const race = step?.kind === "parallel" && step.mode === "race";
      const counted = membersThatCount(row, children, planned);
      for (const child of children) {
        if (!counted.includes(child)) ignore(child);
        else if (race && child.children === undefined && child.nominalS === null && child.highS !== null) ignored.add(child.stepId);
      }
      walk(counted);
    }
  };
  walk(estimateResult.steps);
  const rows = Object.values(estimateResult.byStepId);
  return rows.some((row) => !ignored.has(row.stepId) && row.unknown && row.nominalS === null) ? "lower" : "upper";
}

/**
 * The members of a group that decide its seconds: a `deadline` group's deadline member, since the
 * others are stopped when it ends; for a `race` with a bounded worst case, the members that are sure
 * to end, since one of them ends the race first and stops the rest (the rule `endedByGroup` follows);
 * and otherwise every member. `planned` maps step ids to the flattened plan, which says each
 * group's mode.
 */
export function membersThatCount(
  row: StepEstimate,
  children: readonly StepEstimate[],
  planned: ReadonlyMap<string, PlanStep>,
): readonly StepEstimate[] {
  const step = planned.get(row.stepId)?.step;
  if (step?.kind !== "parallel") return children;
  if (step.mode === "deadline") {
    const deadline = children.filter((child) => child.stepId === step.deadline);
    return deadline.length > 0 ? deadline : children;
  }
  if (step.mode === "race" && worstS(row, planned) !== null) {
    return children.filter((child) => worstS(child, planned) !== null);
  }
  return children;
}

/**
 * The seconds a step takes when every step with no estimate runs its whole timeout, combined the
 * way the estimate combines them: a sequence adds its members, `all` takes the longest, `race` the
 * shortest that ends at all, `deadline` its deadline member, and a branch its longer side. Null
 * when a step with no estimate and no timeout leaves it unbounded.
 */
export function worstS(row: StepEstimate, planned: ReadonlyMap<string, PlanStep>): number | null {
  const children = row.children;
  if (children === undefined) return row.nominalS ?? row.highS;
  const each = children.map((child) => worstS(child, planned));
  const sum = (values: readonly (number | null)[]): number | null =>
    values.some((value) => value === null) ? null : values.reduce<number>((total, value) => total + (value as number), 0);
  const longest = (values: readonly (number | null)[]): number | null =>
    values.some((value) => value === null) ? null : Math.max(0, ...(values as number[]));
  const step = planned.get(row.stepId)?.step;
  if (step?.kind === "parallel") {
    if (step.mode === "race") {
      const ends = each.filter((value): value is number => value !== null);
      return ends.length === 0 ? null : Math.min(...ends);
    }
    const deadline = step.mode === "deadline" ? children.findIndex((child) => child.stepId === step.deadline) : -1;
    return deadline >= 0 ? (each[deadline] ?? null) : longest(each);
  }
  if (step?.kind === "branch") {
    const thenCount = step.then.length;
    return longest([sum(each.slice(0, thenCount)), sum(each.slice(thenCount))]);
  }
  return sum(each);
}
