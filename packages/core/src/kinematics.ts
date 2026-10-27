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

/** TIMEOUT_TIGHT's one-click fix rounds the timeout it offers up to a multiple of this, in seconds. */
export const TIMEOUT_FIX_STEP_S = 0.1;

/**
 * The timeout TIMEOUT_TIGHT's fix offers for a step estimated at `estimateS`: `TIMEOUT_TIGHT_MULTIPLE`
 * times the estimate, rounded up to `TIMEOUT_FIX_STEP_S`. A product that lands on a step already
 * (1.2 × 3.5 is 4.2) is not pushed to the next one by floating point, and the result is never under
 * the product, so applying the fix clears the finding.
 */
export function raisedTimeoutS(estimateS: number): number {
  const wantedS = estimateS * TIMEOUT_TIGHT_MULTIPLE;
  const at = (count: number): number => Math.round(count * TIMEOUT_FIX_STEP_S * 1e6) / 1e6;
  const count = Math.ceil(wantedS / TIMEOUT_FIX_STEP_S - 1e-9);
  return at(count) >= wantedS ? at(count) : at(count + 1);
}

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

/** What a robot file that gives no height is labelled with: Zenith's own default stands in. */
export const DEFAULT_ROBOT_HEIGHT_PROVENANCE = "PLACEHOLDER: Zenith's default, robot.json gives no heightIn";

/**
 * The provenance of the height `robotHeightIn` reads, from the same key it reads the value from,
 * so a STRUCTURE message can say how far to trust the height it used (issue #228).
 */
export function robotHeightProvenance(robot: Robot): string | undefined {
  if (robot.heightIn !== undefined) return robot.heightIn.provenance;
  if (robot.footprint.heightIn !== undefined) return robot.footprint.heightIn.provenance;
  return DEFAULT_ROBOT_HEIGHT_PROVENANCE;
}

/**
 * The clearance from field elements when `robot.json` gives no `footprint.clearanceIn`, in inches
 * (owner ruling D8). It is its own number: it is never derived from the follower's
 * `translationalDeviationToleranceIn` (2.5 in), and it does not reuse the perimeter, continuity or
 * alliance tolerances.
 */
export const DEFAULT_CLEARANCE_IN = 1;

/** The provenance of `DEFAULT_CLEARANCE_IN` (CLAUDE.md rule 4). */
export const DEFAULT_CLEARANCE_PROVENANCE = "SET BY HAND: owner ruling 2026-10-08 (D8)";

/**
 * How close the robot may pass a structure before CLEARANCE warns, and the only place it is read:
 * `footprint.clearanceIn` in robot.json, else the default. No per-person setting changes it, so the
 * CLI, the MCP server and the editor agree about one file (D8).
 */
export const robotClearanceIn = (robot: Robot): number => robot.footprint.clearanceIn?.value ?? DEFAULT_CLEARANCE_IN;

/** The provenance of the clearance `robotClearanceIn` reads, from the same place. */
export const robotClearanceProvenance = (robot: Robot): string | undefined =>
  robot.footprint.clearanceIn === undefined ? DEFAULT_CLEARANCE_PROVENANCE : robot.footprint.clearanceIn.provenance;

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
 * The seconds a turn in place of `turnRad` takes, either way round, at `maxAngularVelRadPerS`. A
 * robot with no angular velocity limit on file turns in no time rather than in infinite time.
 */
export const turnInPlaceS = (limits: RobotLimits, turnRad: number): number =>
  limits.maxAngularVelRadPerS > 0 ? Math.abs(turnRad) / limits.maxAngularVelRadPerS : 0;

/**
 * The lateral acceleration the drivetrain is assumed to hold in a corner. `03` §3.5 names
 * `strafeDecel` as the proxy and says to label it as one, which `estimate`'s explanation does.
 */
export const lateralAccelLimitInPerS2 = (limits: RobotLimits): number => limits.strafeDecelInPerS2;
