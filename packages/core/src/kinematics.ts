import { DEFAULT_ROBOT_HEIGHT_IN, type Robot } from "@horizon36596/zenith-schema";

/**
 * The one place that reads a tunable out of `robot.json` and says what happens when the file does
 * not carry it. Every default here is named where it is defined; nothing
 * is invented, and nothing is read from two places without a stated order of preference.
 */

/** Seconds added to a path step for the follower to declare the end constraints met (`03` §3.7). */
export const DEFAULT_SETTLE_S = 0.25;

/** The estimate band until `07` fits a recorded run: nominal times one plus or minus this (`03` §3). */
export const DEFAULT_BAND_FRACTION = 0.2;

/** Where STRAFE_FRACTION starts warning: a fifth of a step spent sideways (`03` §4). */
export const DEFAULT_STRAFE_FRACTION_WARN = 0.2;

/** The fastest an intaking sweep should run, as a fraction of full speed (`03` §4, SWEEP_SPEED). */
export const DEFAULT_SWEEP_SPEED_FRACTION = 0.4;

/** How far off the travel direction a running mouth may point before MOUTH_LEADING fires. */
export const MOUTH_LEADING_TOLERANCE_RAD = Math.PI / 6;

/** A step's `timeoutS` under this multiple of its estimate is TIMEOUT_TIGHT. */
export const TIMEOUT_TIGHT_MULTIPLE = 1.2;

const valueOf = (
  source: { value: number } | undefined,
  fallback: number,
): number => (source === undefined ? fallback : source.value);

/** Velocity and deceleration limits in the robot's own frame, already scaled by nothing. */
export interface RobotLimits {
  maxForwardVelInPerS: number;
  maxStrafeVelInPerS: number;
  forwardDecelInPerS2: number;
  strafeDecelInPerS2: number;
  accelInPerS2: number;
  maxAngularVelRadPerS: number;
  defaultPathSpeedFraction: number;
  settleS: number;
  bandFraction: number;
  /** True when the follower holds the end pose, so every path step brakes to a stop (`03` §2). */
  holdEnd: boolean;
}

export function robotLimits(robot: Robot): RobotLimits {
  const k = robot.kinematics;
  return {
    maxForwardVelInPerS: k.maxForwardVelInPerS.value,
    maxStrafeVelInPerS: k.maxStrafeVelInPerS.value,
    forwardDecelInPerS2: k.forwardDecelInPerS2.value,
    strafeDecelInPerS2: k.strafeDecelInPerS2.value,
    accelInPerS2: k.accelInPerS2.value,
    maxAngularVelRadPerS: k.maxAngularVelRadPerS.value,
    defaultPathSpeedFraction: k.defaultPathSpeedFraction.value,
    settleS: valueOf(k.settleS, DEFAULT_SETTLE_S),
    bandFraction: k.calibration?.band ?? DEFAULT_BAND_FRACTION,
    holdEnd: k.follower.holdEnd,
  };
}

/**
 * The STRAFE_FRACTION threshold. `strafeFractionWarn` is the spelling the biobuzz robot file uses;
 * `strafeFractionThreshold` is the older one and is still read so an existing file keeps working.
 */
export const strafeFractionWarn = (robot: Robot): number =>
  robot.kinematics.strafeFractionWarn?.value ??
  robot.kinematics.strafeFractionThreshold?.value ??
  DEFAULT_STRAFE_FRACTION_WARN;

export const sweepSpeedFraction = (robot: Robot): number =>
  valueOf(robot.kinematics.sweepSpeedFraction, DEFAULT_SWEEP_SPEED_FRACTION);

/**
 * The robot's height for the STRUCTURE z gate, and the only place it is read: the root key first,
 * then the footprint's, then the default. Both keys are `{ value, provenance }`, so whichever wins
 * carries its label with it.
 */
export const robotHeightIn = (robot: Robot): number =>
  robot.heightIn?.value ?? robot.footprint.heightIn?.value ?? DEFAULT_ROBOT_HEIGHT_IN;

/**
 * The velocity cap for a travel direction `phi` radians off the nose: the ellipse with semi-axes
 * `maxForwardVel` and `maxStrafeVel` (`03` §3.1). `phi = 0` is nose-on, `phi = pi/2` is a pure
 * strafe to the left.
 */
export function ellipseLimit(forward: number, strafe: number, phiRad: number): number {
  const cos = Math.cos(phiRad) / forward;
  const sin = Math.sin(phiRad) / strafe;
  const denominator = Math.hypot(cos, sin);
  return denominator === 0 ? forward : 1 / denominator;
}

/** The speed cap in in/s for a travel direction, before `speedFraction` is applied. */
export const velocityCapInPerS = (limits: RobotLimits, phiRad: number): number =>
  ellipseLimit(limits.maxForwardVelInPerS, limits.maxStrafeVelInPerS, phiRad);

/** The coasting deceleration in in/s^2 available in a travel direction (`03` §3.2). */
export const decelInPerS2 = (limits: RobotLimits, phiRad: number): number =>
  ellipseLimit(limits.forwardDecelInPerS2, limits.strafeDecelInPerS2, phiRad);

/** The stopping distance from a speed in a travel direction, which is what strafing really costs. */
export const stoppingDistanceIn = (
  limits: RobotLimits,
  velocityInPerS: number,
  phiRad: number,
): number => (velocityInPerS * velocityInPerS) / (2 * decelInPerS2(limits, phiRad));

/**
 * The lateral acceleration the drivetrain is assumed to hold in a corner. `03` §3.5 names
 * `strafeDecel` as the proxy and says to label it as one, which `estimate`'s explanation does.
 */
export const lateralAccelLimitInPerS2 = (limits: RobotLimits): number => limits.strafeDecelInPerS2;
