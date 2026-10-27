import { z } from "zod";
import { AXIS_DIRECTIONS, FRAME_PRESETS, LENGTH_UNITS } from "../frame.js";

/**
 * `trajectory.json`: the interchange file any planner writes so Zenith can show its robot's path
 * beside a partner's in the alliance view. The planner writes poses in
 * its own frame, declares that frame, and Zenith converts. It is read from other programs, so the
 * schema is strict: a key it does not know is refused with its path, never silently dropped.
 *
 * Units: `rateHz` in samples per second; times in seconds (`startS`, `endS`, `atS`); the bounding
 * box in inches, in the robot's own frame (forward, left); `poses` and envelope corners in the
 * declared frame's `units`, and headings in its `headingUnit`.
 */

export const TRAJECTORY_SCHEMA_ID = "https://libraries.horizon36596.org/zenith/schema/v1/trajectory.json";
export const TRAJECTORY_FORMAT_VERSION = 1;

/** The phase labels a projection uses (section 8.2). */
export const PHASE_LABELS = ["drive", "score", "collect", "wait", "park", "other"] as const;

/** The longest trajectory, in poses after resampling to 10 Hz: 300 s. */
export const MAX_TRAJECTORY_POSES_10HZ = 3000;
/** The most poses a file may carry at its own rate, so a reader never holds an unbounded list. */
export const MAX_TRAJECTORY_FILE_POSES = 300_000;

const finite = () => z.number().finite();
const nonNegative = () => z.number().finite().nonnegative();

export const trajectoryFrameSchema = z
  .object({
    preset: z.enum(FRAME_PRESETS).optional(),
    originIn: z.object({ xIn: finite(), yIn: finite() }).strict().optional(),
    xAxis: z.enum(AXIS_DIRECTIONS).optional(),
    yAxis: z.enum(AXIS_DIRECTIONS).optional(),
    units: z.enum(LENGTH_UNITS).optional(),
    headingUnit: z.enum(["rad", "deg"]).optional(),
    headingZero: z.enum(["+x", "+y"]).optional(),
    headingPositive: z.enum(["ccw", "cw"]).optional(),
  })
  .strict()
  .describe(
    "The planner's frame: a preset (zenith, pedro or roadrunner), optionally with some of its keys overridden, or every key given explicitly. Axis directions are field-frame directions.",
  );

/** One pose, `[x, y, heading]`, in the declared frame. An array of three numbers, as projections write it. */
export const trajectoryPoseRowSchema = z.array(finite()).length(3);

const span = <T extends z.ZodRawShape>(shape: T) =>
  z
    .object(shape)
    .strict()
    .refine((value: { startS?: unknown; endS?: unknown }) => (value.endS as number) >= (value.startS as number), {
      message: "endS must not be before startS",
      path: ["endS"],
    });

export const trajectoryFileSchema = z
  .object({
    $schema: z.literal(TRAJECTORY_SCHEMA_ID).optional(),
    formatVersion: z.literal(TRAJECTORY_FORMAT_VERSION),
    kind: z.literal("trajectory"),
    season: z.string().min(1).max(200),
    alliance: z.enum(["RED", "BLUE"]),
    title: z.string().min(1).max(200).optional(),
    source: z
      .object({ planner: z.string().max(200).optional(), exporter: z.string().max(200).optional() })
      .strict()
      .optional(),
    frame: trajectoryFrameSchema,
    rateHz: z.number().finite().positive().max(1000),
    poses: z.array(trajectoryPoseRowSchema).min(1).max(MAX_TRAJECTORY_FILE_POSES),
    boundingBox: z
      .object({
        lengthIn: z.number().finite().positive(),
        widthIn: z.number().finite().positive(),
        centreOffsetIn: z.object({ xIn: finite(), yIn: finite() }).strict().optional(),
        provenance: z.string().min(1).max(200).optional(),
      })
      .strict(),
    phases: z.array(span({ startS: nonNegative(), endS: nonNegative(), label: z.enum(PHASE_LABELS) })).max(200).optional(),
    claims: z
      .array(z.object({ elementId: z.string().min(1).max(200), action: z.enum(["take", "score"]), atS: nonNegative() }).strict())
      .max(200)
      .optional(),
    envelopes: z
      .array(
        span({
          startS: nonNegative(),
          endS: nonNegative(),
          polygon: z.array(z.object({ x: finite(), y: finite() }).strict()).min(3).max(200),
        }),
      )
      .max(50)
      .optional(),
  })
  .strict();

export type TrajectoryFrame = z.infer<typeof trajectoryFrameSchema>;
export type TrajectoryFile = z.infer<typeof trajectoryFileSchema>;
