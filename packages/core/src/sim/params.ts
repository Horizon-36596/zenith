import type { Field, Robot } from "@horizon36596/zenith-schema";
import { robotLimits } from "../kinematics.js";
import type { FollowerParams, PlantParams, SimFidelity, SimOptions } from "./types.js";

/**
 * Where every number the instant sim runs on comes from, in one place, with the order of
 * preference stated: the caller's `options`, then `robot.json`, then a default. Each default is
 * either Pedro Pathing v3's own `ForesightConfig` default (read from the pinned sources jar, see
 * site/docs/simulation.md) or derived from a number `robot.json` already carries, and
 * says which. None is a number made up for the purpose (CLAUDE.md rule 4).
 *
 * The follower gains, the drivetrain geometry and each condition's `ledger` meaning are optional
 * keys in `robot.json` (`followerSchema` and `drivetrainSchema` in `packages/schema/src/robot.ts`,
 * site/docs/file-format.md). This file still reads them structurally, so a key the schema adds
 * later takes effect without a change here.
 */

/** The default tick for the preview, in seconds. */
export const DEFAULT_TICK_S = 0.01;

/** The tick of a Gradle headless sim's 50 Hz loop, in seconds. */
export const GRADLE_TICK_S = 0.02;

/**
 * Seconds the sim runs past the auto period before it gives up on a routine that has not finished:
 * the same margin a Gradle headless sim gives a 30 s period (1700 ticks of 0.02 s is 34 s).
 */
export const PERIOD_MARGIN_S = 4;

/** When the field declares no auto period, the sim stops here. FTC's auto period is 30 s. */
export const DEFAULT_PERIOD_S = 30;

/** The stop-snap threshold of the robot repository's headless-sim motor model. */
export const STOP_SNAP_FRACTION = 0.02;

/** `MecanumConfig.powerThreshold`'s default in Pedro's revhub. */
export const POWER_THRESHOLD = 0.01;

/**
 * Pedro's `ForesightConfig` defaults, for the knobs Pedro gives a default to. SPEC: copied from
 * `com/pedropathing/algorithm/ForesightConfig.java` in core-3.0.0-20260828.185437-17.
 */
export const PEDRO_DEFAULTS = {
  headingPowerPerRad: 1.5,
  headingStaticPower: 0,
  forwardTranslationalPowerPerIn: 0.07,
  strafeTranslationalPowerPerIn: 0.1,
  brakeFeedforwardPowerPerInPerS: 0.009,
  coastPowerPerInPerS: 0.025,
  coastFeedforwardPowerPerInPerS: 0.015,
  maxBrakingPower: 0.2,
  headingDriveRatio: 0.5,
  cosineScale: true,
  turnBeforeDriving: false,
  brakeAggression: 1,
  endParametricT: 0.025,
  endHeadingToleranceRad: 0.007,
  endTranslationalToleranceIn: 0.1,
  endVelocityToleranceInPerS: 0.1,
  holdTimeoutS: 0.1,
  headingDeviationToleranceRad: (11.25 * Math.PI) / 180,
  translationalDeviationToleranceIn: 2.5,
  minCorrectionDistanceIn: 1e-3,
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A `{ value, provenance }` number or a bare number under `source[key]`, when there is one. */
function numberAt(source: unknown, key: string): number | undefined {
  if (!isRecord(source)) return undefined;
  const raw = source[key];
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (isRecord(raw) && typeof raw["value"] === "number" && Number.isFinite(raw["value"])) {
    return raw["value"];
  }
  return undefined;
}

function booleanAt(source: unknown, key: string): boolean | undefined {
  if (!isRecord(source)) return undefined;
  const raw = source[key];
  if (typeof raw === "boolean") return raw;
  if (isRecord(raw) && typeof raw["value"] === "boolean") return raw["value"];
  return undefined;
}

/** `kinematics.follower` as a plain record, so keys the schema does not type yet can be read. */
const followerSection = (robot: Robot): unknown => (robot.kinematics as unknown as Record<string, unknown>)["follower"];

/** `kinematics.drivetrain`, the plant section the handoff asks for. */
const drivetrainSection = (robot: Robot): unknown =>
  (robot.kinematics as unknown as Record<string, unknown>)["drivetrain"];

/**
 * The follower the sim runs. Pedro's defaults except where a Pedro default would make the preview
 * meaningless for any robot that has not been tuned, and there the value is derived:
 *
 * - `coastFeedforwardPowerPerInPerS` defaults to 1 / maxForwardVel, the power that holds a target
 *   velocity on this robot's measured top speed (a robot with a 100 in/s top speed gets 0.01).
 *   Pedro's 0.015 would push past full power at any target, so `speedFraction` would do nothing.
 * - `coastPowerPerInPerS` defaults to 0 for the same reason: V3 feeds the coast controller the
 *   target velocity as its "error", so a P term there is a second feedforward.
 * - The brake coefficients, which Pedro makes `required()` and so has no default for, come from the
 *   measured coasting deceleration: stopping distance v^2 / 2a, linear term 0. APPROX: the real
 *   coefficients come from Pedro's braking identification OpModes and are shorter, because they
 *   brake under reverse power rather than coast.
 */
export function followerParams(robot: Robot, options: SimOptions = {}): FollowerParams {
  const k = robot.kinematics;
  const section = followerSection(robot);
  const forwardVel = k.maxForwardVelInPerS.value;
  const leverArm = plantLeverArmIn(robot);
  const read = (key: keyof FollowerParams, fallback: number): number =>
    (options.follower?.[key] as number | undefined) ?? numberAt(section, key) ?? fallback;
  const flag = (key: "cosineScale" | "turnBeforeDriving", fallback: boolean): boolean =>
    options.follower?.[key] ?? booleanAt(section, key) ?? fallback;

  const forwardDecel = k.forwardDecelInPerS2.value;
  const strafeDecel = k.strafeDecelInPerS2.value;
  // The heading's natural deceleration is the forward one acting at the lever arm, the same
  // geometry the plant turns with.
  const headingDecel = forwardDecel / leverArm;

  return {
    forwardTranslationalPowerPerIn: read(
      "forwardTranslationalPowerPerIn",
      PEDRO_DEFAULTS.forwardTranslationalPowerPerIn,
    ),
    strafeTranslationalPowerPerIn: read(
      "strafeTranslationalPowerPerIn",
      PEDRO_DEFAULTS.strafeTranslationalPowerPerIn,
    ),
    headingPowerPerRad: read("headingPowerPerRad", PEDRO_DEFAULTS.headingPowerPerRad),
    headingStaticPower: read("headingStaticPower", PEDRO_DEFAULTS.headingStaticPower),
    coastPowerPerInPerS: read("coastPowerPerInPerS", 0),
    coastFeedforwardPowerPerInPerS: read("coastFeedforwardPowerPerInPerS", 1 / forwardVel),
    brakeFeedforwardPowerPerInPerS: read(
      "brakeFeedforwardPowerPerInPerS",
      PEDRO_DEFAULTS.brakeFeedforwardPowerPerInPerS,
    ),
    maxBrakingPower: read("maxBrakingPower", PEDRO_DEFAULTS.maxBrakingPower),
    headingDriveRatio: read("headingDriveRatio", PEDRO_DEFAULTS.headingDriveRatio),
    cosineScale: flag("cosineScale", PEDRO_DEFAULTS.cosineScale),
    turnBeforeDriving: flag("turnBeforeDriving", PEDRO_DEFAULTS.turnBeforeDriving),
    brakeAggression: read("brakeAggression", PEDRO_DEFAULTS.brakeAggression),
    brakeLinearForwardS: read("brakeLinearForwardS", 0),
    brakeQuadraticForwardS2PerIn: read("brakeQuadraticForwardS2PerIn", 1 / (2 * forwardDecel)),
    brakeLinearStrafeS: read("brakeLinearStrafeS", 0),
    brakeQuadraticStrafeS2PerIn: read("brakeQuadraticStrafeS2PerIn", 1 / (2 * strafeDecel)),
    headingBrakeLinearS: read("headingBrakeLinearS", 0),
    headingBrakeQuadraticS2PerRad: read("headingBrakeQuadraticS2PerRad", 1 / (2 * headingDecel)),
    endParametricT: read("endParametricT", PEDRO_DEFAULTS.endParametricT),
    endHeadingToleranceRad: read("endHeadingToleranceRad", PEDRO_DEFAULTS.endHeadingToleranceRad),
    endTranslationalToleranceIn: read(
      "endTranslationalToleranceIn",
      PEDRO_DEFAULTS.endTranslationalToleranceIn,
    ),
    endVelocityToleranceInPerS: read(
      "endVelocityToleranceInPerS",
      PEDRO_DEFAULTS.endVelocityToleranceInPerS,
    ),
    holdTimeoutS: read("holdTimeoutS", PEDRO_DEFAULTS.holdTimeoutS),
    headingDeviationToleranceRad: read(
      "headingDeviationToleranceRad",
      PEDRO_DEFAULTS.headingDeviationToleranceRad,
    ),
    translationalDeviationToleranceIn: read(
      "translationalDeviationToleranceIn",
      PEDRO_DEFAULTS.translationalDeviationToleranceIn,
    ),
    minCorrectionDistanceIn: read("minCorrectionDistanceIn", PEDRO_DEFAULTS.minCorrectionDistanceIn),
  };
}

/**
 * The mecanum lever arm: half the wheel base plus half the track width from
 * `kinematics.drivetrain` when the file carries them, otherwise the arm that makes a full turn
 * command reach `maxAngularVelRadPerS`, so the plant's angular limit is the one `robot.json` states.
 */
export function plantLeverArmIn(robot: Robot): number {
  const section = drivetrainSection(robot);
  const trackWidth = numberAt(section, "trackWidthIn");
  const wheelBase = numberAt(section, "wheelBaseIn");
  if (trackWidth !== undefined && wheelBase !== undefined && trackWidth + wheelBase > 0) {
    return wheelBase / 2 + trackWidth / 2;
  }
  return robot.kinematics.maxForwardVelInPerS.value / robot.kinematics.maxAngularVelRadPerS.value;
}

/**
 * The plant. The wheel response rate is `kinematics.drivetrain.wheelResponseRatePerS` when present
 * (a robot's own Gradle sim sets the same rate), otherwise 2 * accel / maxForwardVel:
 * the rate at which a first-order wheel loses the same time to reaching top speed, V / (2a), as the
 * constant-acceleration estimate does, so the two agree about what `accelInPerS2` means.
 */
export function plantParams(
  robot: Robot,
  field: Field,
  fidelity: SimFidelity,
  options: SimOptions = {},
): PlantParams {
  const limits = robotLimits(robot);
  const section = drivetrainSection(robot);
  const defaults: PlantParams = {
    maxForwardVelInPerS: limits.maxForwardVelInPerS,
    maxStrafeVelInPerS: Math.min(limits.maxStrafeVelInPerS, limits.maxForwardVelInPerS),
    wheelResponseRatePerS:
      numberAt(section, "wheelResponseRatePerS") ??
      (2 * limits.accelInPerS2) / limits.maxForwardVelInPerS,
    leverArmIn: plantLeverArmIn(robot),
    forwardDecelInPerS2: limits.forwardDecelInPerS2,
    strafeDecelInPerS2: limits.strafeDecelInPerS2,
    coast: fidelity === "gradle" ? "firstOrder" : "natural",
    stopSnapFraction: STOP_SNAP_FRACTION,
    powerThreshold: POWER_THRESHOLD,
    fieldHalfIn: Math.min(field.sizeIn.xIn, field.sizeIn.yIn) / 2,
  };
  return { ...defaults, ...definedOnly(options.plant) };
}

function definedOnly<T extends object>(partial: Partial<T> | undefined): Partial<T> {
  const out: Partial<T> = {};
  if (partial === undefined) return out;
  for (const [key, value] of Object.entries(partial)) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

/** The tick, the fidelity and the stopping time, resolved. */
export function runParams(
  field: Field,
  options: SimOptions,
): { tickS: number; fidelity: SimFidelity; maxTimeS: number; periodS: number | null } {
  const fidelity = options.fidelity ?? "robot";
  const tickS = options.tickS ?? (fidelity === "gradle" ? GRADLE_TICK_S : DEFAULT_TICK_S);
  if (!(tickS > 0) || !Number.isFinite(tickS)) throw new RangeError("tickS must be a positive number of seconds.");
  const periodS = field.periods?.autoS ?? null;
  const maxTimeS = options.maxTimeS ?? (periodS ?? DEFAULT_PERIOD_S) + PERIOD_MARGIN_S;
  return { tickS, fidelity, maxTimeS, periodS };
}
