import type { Trace, TraceEvent, TracePoseRow, TraceStep } from "../trace.js";
import type { LedgerRun } from "../ledger.js";
import type { SeasonRules } from "../season.js";

/**
 * The instant sim's own types (site/docs/simulation.md). Everything the sim returns is
 * a `Trace`, the same shape the robot repository's headless sim writes, with fields added and never
 * changed, so the overlay, the timeline and the checks read either one without knowing which it is.
 *
 * The follower and plant parameters mirror Pedro Pathing v3's `ForesightConfig` and a Gradle
 * headless sim's drivetrain model; `params.ts` says where every one of them comes from and what
 * each default is.
 */

/**
 * Which world the sim reproduces.
 *
 * - `robot` (the default): the follower sees the robot's true velocity, the way the real OctoQuad
 *   reports it, and a wheel commanded to zero power coasts down at the measured natural
 *   deceleration. This is the preview.
 * - `gradle`: reproduces the robot repository's headless harness exactly, including what it does
 *   not model: its `FakeOctoQuad` reports a velocity of zero, so Pedro never projects a stopping
 *   distance; its `FakeMotor` sheds speed at the same first-order rate whether it is driven or
 *   coasting; and the pose is quantised to whole millimetres and 1/5000 rad. Use it to compare
 *   against a Gradle trace and to check this port, not to plan a routine.
 */
export type SimFidelity = "robot" | "gradle";

/** How a wheel commanded to (nearly) zero power loses speed. */
export type CoastModel = "natural" | "firstOrder";

/**
 * Pedro's ForesightV3 knobs, named for their `robot.json` keys (`kinematics.follower`).
 * Powers are motor power fractions in [-1, 1].
 */
export interface FollowerParams {
  /** `forwardTranslational`: power per inch of cross-track error along the nose. */
  forwardTranslationalPowerPerIn: number;
  /** `strafeTranslational`: power per inch of cross-track error across the nose. */
  strafeTranslationalPowerPerIn: number;
  /** `headingFeedback`: turn power per radian of heading error. */
  headingPowerPerRad: number;
  /** `headingStaticFF`: a constant turn power in the direction of the error. */
  headingStaticPower: number;
  /** `coast`'s proportional term. V3 feeds it the target velocity itself, not an error. */
  coastPowerPerInPerS: number;
  /** `coast`'s feedforward term: power per in/s of target velocity. */
  coastFeedforwardPowerPerInPerS: number;
  /** `brake`: power per in/s of the velocity the brake model says the robot can still carry. */
  brakeFeedforwardPowerPerInPerS: number;
  /** `maxBrakingPower`: the most power allowed against the direction of motion. */
  maxBrakingPower: number;
  /** `headingDriveRatio`: the share of heading feedback moved ahead of the drive vector. */
  headingDriveRatio: number;
  /** `cosineScale`: damp the drive vector by cos(error) when far off the path. */
  cosineScale: boolean;
  /** `turnBeforeDriving`: hold the drive vector at the start until the heading is close. */
  turnBeforeDriving: boolean;
  /** `brakeAggression`: above 1 brakes later (overshoots), below 1 earlier. */
  brakeAggression: number;
  /** `linearBrakeCoefficients` (0, 0): stopping inches per in/s nose-on. */
  brakeLinearForwardS: number;
  /** `quadraticBrakeCoefficients` (0, 0): stopping inches per (in/s)^2 nose-on. */
  brakeQuadraticForwardS2PerIn: number;
  /** `linearBrakeCoefficients` (1, 1): the same sideways. */
  brakeLinearStrafeS: number;
  /** `quadraticBrakeCoefficients` (1, 1): the same sideways. */
  brakeQuadraticStrafeS2PerIn: number;
  /** `headingBrakeCoefficients.x`: stopping radians per rad/s. */
  headingBrakeLinearS: number;
  /** `headingBrakeCoefficients.y`: stopping radians per (rad/s)^2. */
  headingBrakeQuadraticS2PerRad: number;
  /** `parametricTConstraint`: a segment ends once the closest point passes t = 1 minus this. */
  endParametricT: number;
  /** `headingConstraint`: the hold counts as settled inside this heading error. */
  endHeadingToleranceRad: number;
  /** `translationalConstraint`: the hold counts as settled inside this distance. */
  endTranslationalToleranceIn: number;
  /** `velocityConstraint`: the hold counts as settled below this speed toward the target. */
  endVelocityToleranceInPerS: number;
  /** `timeoutConstraint`, in seconds rather than Pedro's milliseconds. */
  holdTimeoutS: number;
  /** `headingDeviationTolerance`: past this, heading correction takes priority over the drive. */
  headingDeviationToleranceRad: number;
  /** `translationalDeviationTolerance`: past this, translational correction takes priority. */
  translationalDeviationToleranceIn: number;
  /** `minCorrectionDistance`: no translational correction inside this. */
  minCorrectionDistanceIn: number;
}

/** The mecanum plant, matched to the robot repository's `MecanumDrivePlant` and `FakeMotor`. */
export interface PlantParams {
  /** Full-power wheel speed, nose-on. `FakeMotor.maxVelocityTicksPerSecond / ticksPerInch`. */
  maxForwardVelInPerS: number;
  /** Full-power strafe speed. Its ratio to the forward speed is the plant's roller slip. */
  maxStrafeVelInPerS: number;
  /** `FakeMotor`'s first-order rate, 1/s: `speed += (power - speed) * rate * dt`. */
  wheelResponseRatePerS: number;
  /** Half the wheel base plus half the track width: the mecanum lever arm for rotation. */
  leverArmIn: number;
  /** The natural deceleration nose-on when every wheel is unpowered (`natural` coast only). */
  forwardDecelInPerS2: number;
  /** The same sideways. */
  strafeDecelInPerS2: number;
  coast: CoastModel;
  /** `FakeMotor.EPS`: below this speed and power a wheel stops outright. */
  stopSnapFraction: number;
  /** `CachedMotor` / `MecanumConfig.powerThreshold`: a smaller power change is not written. */
  powerThreshold: number;
  /** The pose is clamped to plus or minus this on both axes (`MecanumPoseIntegrator`). */
  fieldHalfIn: number;
}

/** What a condition resolver is asked, and when. */
export type ConditionQuery =
  | {
      /** A path's `endCondition`: return the fraction of arc length where it fires, or null. */
      kind: "endCondition";
      stepId: string;
      condition: string;
      holdsBefore: Readonly<Record<string, number>> | null;
      holdsAfter: Readonly<Record<string, number>> | null;
    }
  | {
      /** A `wait` with `until`: return the seconds after the wait starts, or null for never. */
      kind: "wait";
      stepId: string;
      condition: string;
      holds: Readonly<Record<string, number>> | null;
    }
  | {
      /** A `branch`: return whether the condition reads true as the branch starts. */
      kind: "branch";
      stepId: string;
      condition: string;
      holds: Readonly<Record<string, number>> | null;
    };

/** Returns undefined to leave the query to the default resolution. */
export type ConditionResolver = (query: ConditionQuery) => number | boolean | null | undefined;

export interface SimOptions {
  /** Seconds per tick. 0.01 for `robot`; 0.02 for `gradle`, `HeadlessOpModeRunner.TICK_SECONDS`. */
  tickS?: number;
  fidelity?: SimFidelity;
  /** Stop here even if the routine has not finished. Default: the auto period plus 4 s. */
  maxTimeS?: number;
  follower?: Partial<FollowerParams>;
  plant?: Partial<PlantParams>;
  /** The seconds a command whose `estimateS` is `"unknown"` takes. Default 0, as the estimate counts it. */
  unknownCommandS?: number;
  /** The ledger `runLedger` produced for this plan, so a condition can be resolved from it. */
  ledger?: LedgerRun;
  /** The season rules the ledger ran with, to read what the robot holds before a step. */
  season?: SeasonRules;
  /** Overrides the default resolution of conditions; return undefined to fall back to it. */
  conditions?: ConditionResolver;
  /** Conditions that mean "the robot is at capacity". Default: those the robot file marks `full`, else `hopperFull`. */
  fullConditions?: readonly string[];
  /** Conditions that mean "the robot holds nothing". Default: those marked `empty`, else `hopperEmpty`. */
  emptyConditions?: readonly string[];
}

/** `[timeS, vxInPerS, vyInPerS, omegaRadPerS]`, field frame, the velocity the plant really had. */
export type TraceVelocityRow = readonly [number, number, number, number];

/** A step as the instant sim ran it: the trace's step plus what only the sim knows. */
export interface SimStepRecord extends TraceStep {
  kind: string;
  /** The parent group's id, or null at the top level. */
  parentId: string | null;
  /** True when the step's `timeoutS` ended it. */
  timedOut: boolean;
  /** True when the step's `endCondition` or `until` fired. */
  conditionFired: boolean;
  /**
   * True when the seconds are not a prediction: a command whose `estimateS` is unknown, a
   * `movesRobot` command, or a condition the sim cannot see.
   */
  unknown: boolean;
  /** Why `unknown` is true, in a sentence. */
  unknownReason?: string;
  /** For a path step: when the hold after it first met Pedro's end constraints, if it did. */
  settledS?: number;
}

export interface SimEvent extends TraceEvent {
  stepId?: string;
  command?: string;
  detail?: string;
}

/** The trace `simulate` returns: a `Trace` with its additions. */
export interface SimTrace extends Trace {
  /** Always `"instant"`, so a reader can tell it from a Gradle trace. */
  source: "instant";
  fidelity: SimFidelity;
  steps: SimStepRecord[];
  events: SimEvent[];
  velocities: TraceVelocityRow[];
  /** True when the routine finished before `maxTimeS`. */
  completed: boolean;
  /** The auto period the field declares, when it does. */
  periodS: number | null;
}

/**
 * The state at the moment a top-level step is about to start, so `resimulate` can pick up from
 * the first edited step. Opaque to callers: only `resimulate` reads it.
 */
export interface SimCheckpoint {
  readonly stepIndex: number;
  /** A structural key of every top-level step before this one and the inputs, for reuse checks. */
  readonly prefixKey: string;
  readonly state: unknown;
}

/** A trace plus the checkpoints that let the editor re-simulate from an edited step. */
export interface SimRun {
  trace: SimTrace;
  checkpoints: SimCheckpoint[];
  /** The first top-level step this run actually simulated; 0 for a full run. */
  resumedFromStep: number;
}

export type { TracePoseRow };
