import { z } from "zod";
import { provenanceSchema, valuedNumberSchema } from "./common.js";
import { isEstimateExpression } from "./expr.js";
import { formatVersionFor, schemaIdField } from "./ids.js";

/** One footprint box. Length runs along the nose (+x in the robot frame), width across it. */
export const footprintBoxSchema = z.object({
  lengthIn: z.number().positive(),
  widthIn: z.number().positive(),
  provenance: provenanceSchema.optional(),
});

/**
 * The footprint is fully customizable per robot: the box at the start of the match, the
 * box with every mechanism out, and the centre of rotation as an offset from the footprint centre.
 */
export const footprintSchema = z.object({
  startIn: footprintBoxSchema,
  expandedIn: footprintBoxSchema,
  centreOfRotationIn: z.object({
    xIn: z.number(),
    yIn: z.number(),
    provenance: provenanceSchema.optional(),
  }),
  /** How tall the robot is, for the z gate on the STRUCTURE check. `robot.heightIn` wins over it. */
  heightIn: valuedNumberSchema.optional(),
});

/**
 * A `{ value, provenance }` number that also accepts the bare number an older file wrote, so every
 * reader sees one shape. A bare number is read as `{ value }` with no provenance, which is exactly
 * what it was: a number with no label (CLAUDE.md rule 4), and the next save writes the wrapper.
 * It is a union with a transform rather than a preprocess so the published JSON Schema accepts both
 * spellings too, and an older file does not light up red in an editor before it is re-saved.
 */
const valuedOrBareNumberSchema = z
  .union([valuedNumberSchema, z.number().positive()])
  .transform((raw) => (typeof raw === "number" ? { value: raw } : raw));

/**
 * A follower switch: a bare boolean, or `{ value, provenance }` so it can say where it came from
 * like every other constant (CLAUDE.md rule 4). Both spellings are kept as written.
 */
export const valuedBooleanSchema = z.union([
  z.boolean(),
  z.object({ value: z.boolean(), provenance: provenanceSchema.optional() }),
]);

/**
 * The Pedro follower's gains and tolerances, all optional, read by the instant sim
 * (`packages/core/src/sim/params.ts`). A key left out falls back to Pedro's `ForesightConfig`
 * default or a value derived from the rest of this file, as `params.ts` lists. The key names are
 * the sim's; declaration order here is the canonical file order.
 */
export const FOLLOWER_GAIN_KEYS = [
  "forwardTranslationalPowerPerIn",
  "strafeTranslationalPowerPerIn",
  "headingPowerPerRad",
  "headingStaticPower",
  "coastPowerPerInPerS",
  "coastFeedforwardPowerPerInPerS",
  "brakeFeedforwardPowerPerInPerS",
  "maxBrakingPower",
  "headingDriveRatio",
  "brakeAggression",
  "brakeLinearForwardS",
  "brakeQuadraticForwardS2PerIn",
  "brakeLinearStrafeS",
  "brakeQuadraticStrafeS2PerIn",
  "headingBrakeLinearS",
  "headingBrakeQuadraticS2PerRad",
  "endParametricT",
  "endHeadingToleranceRad",
  "endTranslationalToleranceIn",
  "endVelocityToleranceInPerS",
  "holdTimeoutS",
  "headingDeviationToleranceRad",
  "translationalDeviationToleranceIn",
  "minCorrectionDistanceIn",
] as const;

/** The two follower switches, `cosineScale` and `turnBeforeDriving`. */
export const FOLLOWER_SWITCH_KEYS = ["cosineScale", "turnBeforeDriving"] as const;

const followerGainsShape = Object.fromEntries(
  FOLLOWER_GAIN_KEYS.map((key) => [key, valuedNumberSchema.optional()]),
) as Record<(typeof FOLLOWER_GAIN_KEYS)[number], z.ZodOptional<typeof valuedNumberSchema>>;

const followerSwitchesShape = Object.fromEntries(
  FOLLOWER_SWITCH_KEYS.map((key) => [key, valuedBooleanSchema.optional()]),
) as Record<(typeof FOLLOWER_SWITCH_KEYS)[number], z.ZodOptional<typeof valuedBooleanSchema>>;

export const followerSchema = z.object({
  library: z.enum(["pedro"]),
  version: z.string().min(1),
  holdEnd: z.boolean(),
  ...followerGainsShape,
  ...followerSwitchesShape,
});

/**
 * The drivetrain geometry and wheel response the instant sim's plant uses. Each key is optional;
 * the sim derives a stand-in from the footprint and the kinematics when one is left out.
 */
export const drivetrainSchema = z.object({
  trackWidthIn: valuedNumberSchema.optional(),
  wheelBaseIn: valuedNumberSchema.optional(),
  wheelResponseRatePerS: valuedNumberSchema.optional(),
});

export const mouthSchema = z.object({
  id: z.string().min(1),
  side: z.enum(["FRONT", "BACK", "LEFT", "RIGHT"]),
  offsetIn: z.object({
    xIn: z.number(),
    yIn: z.number(),
  }),
  widthIn: z.number().positive(),
  depthIn: z.number().positive(),
  provenance: provenanceSchema.optional(),
});

export const commandParamSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("integer"),
    min: z.number().optional(),
    max: z.number().optional(),
    default: z.number().optional(),
  }),
  z.object({
    type: z.literal("number"),
    min: z.number().optional(),
    max: z.number().optional(),
    default: z.number().optional(),
  }),
  z.object({
    type: z.literal("enum"),
    values: z.array(z.string().min(1)).min(1),
    default: z.string().optional(),
  }),
  z.object({
    type: z.literal("boolean"),
    default: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("string"),
    default: z.string().optional(),
  }),
]);

/** One entry in the named-command registry. `name` must match a NamedCommands registration. */
export const commandSpecSchema = z.object({
  name: z.string().min(1),
  summary: z.string().optional(),
  params: z.record(z.string(), commandParamSchema).optional(),
  estimateS: z.string().refine(isEstimateExpression, {
    message: 'estimateS must be an expression over the params (numbers, names, + - * /, max, min) or "unknown"',
  }),
  requires: z.array(z.string().min(1)).optional(),
  stationary: z.boolean().optional(),
  movesRobot: z.boolean().optional(),
  ledger: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});

export const conditionSpecSchema = z.object({
  name: z.string().min(1),
  summary: z.string().optional(),
  /**
   * Which condition means the robot is at capacity (`"full"`) or holding nothing (`"empty"`), so
   * the instant sim can answer it from the ledger. Without it the sim assumes `hopperFull` and
   * `hopperEmpty`.
   */
  ledger: z.enum(["full", "empty"]).optional(),
});

/**
 * `robot.json`: everything the planner needs to know about one robot
 * (site/docs/file-format.md). Key declaration order is the canonical file order.
 */
export const robotSchema = z.object({
  $schema: schemaIdField("robot"),
  formatVersion: formatVersionFor("robot"),
  name: z.string().min(1),
  frame: z.object({
    forward: z.enum(["+x", "-x", "+y", "-y"]),
    left: z.enum(["+x", "-x", "+y", "-y"]),
    headingZero: z.enum(["+x", "+y"]),
    headingPositive: z.enum(["ccw", "cw"]),
  }),
  footprint: footprintSchema,
  /**
   * Robot height, for the z-range gate on the STRUCTURE check, with the provenance every constant
   * carries. It wins over `footprint.heightIn` when both are given; `robotHeightIn` in the core is
   * the one reader. Defaults to 18 in when both are absent.
   */
  heightIn: valuedOrBareNumberSchema.optional(),
  kinematics: z.object({
    maxForwardVelInPerS: valuedNumberSchema,
    maxStrafeVelInPerS: valuedNumberSchema,
    forwardDecelInPerS2: valuedNumberSchema,
    strafeDecelInPerS2: valuedNumberSchema,
    accelInPerS2: valuedNumberSchema,
    maxAngularVelRadPerS: valuedNumberSchema,
    defaultPathSpeedFraction: valuedNumberSchema,
    /** Seconds the follower spends declaring the end constraints met (`03` section 3 step 7). */
    settleS: valuedNumberSchema.optional(),
    /** The STRAFE_FRACTION warning threshold. `strafeFractionThreshold` is the older spelling. */
    strafeFractionWarn: valuedNumberSchema.optional(),
    strafeFractionThreshold: valuedNumberSchema.optional(),
    sweepSpeedFraction: valuedNumberSchema.optional(),
    /** What `07` writes back once a recorded run has been fitted: the estimate band, as a fraction. */
    calibration: z
      .object({
        band: z.number().positive(),
        samples: z.number().int().nonnegative().optional(),
        provenance: provenanceSchema.optional(),
      })
      .optional(),
    follower: followerSchema,
    drivetrain: drivetrainSchema.optional(),
  }),
  mouths: z.array(mouthSchema).optional(),
  capacity: z
    .object({
      elementKind: z.string().min(1),
      max: z.number().int().nonnegative(),
      provenance: provenanceSchema.optional(),
    })
    .optional(),
  shooter: z
    .object({
      kind: z.string().min(1),
      turretRangeRad: z
        .object({
          minRad: z.number(),
          maxRad: z.number(),
          provenance: provenanceSchema.optional(),
        })
        .optional(),
      cadenceS: z.record(z.string(), z.union([z.number(), z.string()])).optional(),
      settleS: valuedNumberSchema.optional(),
    })
    .passthrough()
    .optional(),
  commands: z.array(commandSpecSchema),
  conditions: z.array(conditionSpecSchema).optional(),
});

export type FootprintBox = z.infer<typeof footprintBoxSchema>;
export type Footprint = z.infer<typeof footprintSchema>;
export type Mouth = z.infer<typeof mouthSchema>;
export type CommandParam = z.infer<typeof commandParamSchema>;
export type CommandSpec = z.infer<typeof commandSpecSchema>;
export type ConditionSpec = z.infer<typeof conditionSpecSchema>;
export type Robot = z.infer<typeof robotSchema>;
export type Follower = z.infer<typeof followerSchema>;
export type Drivetrain = z.infer<typeof drivetrainSchema>;
export type ValuedBoolean = z.infer<typeof valuedBooleanSchema>;

/** The robot height the STRUCTURE z-gate assumes when `robot.json` does not say. */
export const DEFAULT_ROBOT_HEIGHT_IN = 18;
