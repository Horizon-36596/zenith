import { z } from "zod";
import { MAX_BEZIER_CONTROL_POINTS } from "@horizon36596/zenith-schema";
import { trajectoryFrameSchema } from "../trajectory/schema.js";

/**
 * `path.json`: the interchange file a planner writes when its path should arrive in Zenith as an
 * auto that can be edited, rather than as a trajectory that can only be looked at. It is the
 * structure of a propose-level projection (`ProjectionStructure` in `@horizon36596/zenith-schema`)
 * with the commands taken out, plus the declared frame block of `trajectory.json`:
 *
 * - path steps, each a chain of `line` and `bezier` segments (one to three control points, the auto
 *   format's limit) with any of Zenith's heading modes, an optional speed fraction and timeout;
 * - wait steps with a number of seconds.
 *
 * Command steps, markers, end conditions and branches are left out, because a command is a name in
 * one team's own robot code and means nothing in another planner. Groups are left out with them,
 * because without commands a sequence or a parallel group of drives says nothing that a flat list
 * does not.
 *
 * Positions are in the declared frame's `units` and headings in its `headingUnit`, so the keys carry
 * no unit suffix: `x`, `y` and `heading` on a pose, `heading` on a constant heading, `from` and `to`
 * on a linear one, `x`, `y` and `offset` on a face-point one. Times are seconds (`seconds`,
 * `timeoutS`); `startT` and `endT` are fractions of a step's length, and `speedFraction` a fraction
 * of the robot's top speed, all without a unit. The schema is strict, like `trajectory.json`: a key
 * it does not know is refused with its path.
 */

export const PATH_SCHEMA_ID = "https://libraries.horizon36596.org/zenith/schema/v1/path.json";
export const PATH_FORMAT_VERSION = 1;

/** The most steps a file may carry, and the most entries in any list inside it (the projection's cap). */
export const MAX_PATH_LIST_LENGTH = 200;
/** The longest string a file may carry: a title, a season id, a step id. */
export const MAX_PATH_STRING_LENGTH = 200;

const finite = () => z.number().finite();
const shortString = () => z.string().min(1).max(MAX_PATH_STRING_LENGTH);
const list = <T extends z.ZodTypeAny>(item: T) => z.array(item).max(MAX_PATH_LIST_LENGTH);

/** A point in the declared frame. */
export const pathPointSchema = z.object({ x: finite(), y: finite() }).strict();

/** A segment's end in the declared frame. `heading` is optional, as it is on an auto's poses. */
export const pathPoseSchema = z.object({ x: finite(), y: finite(), heading: finite().optional() }).strict();

/** The start pose, which must say which way the robot faces. */
export const pathStartPoseSchema = z.object({ x: finite(), y: finite(), heading: finite() }).strict();

export const pathLineSegmentSchema = z
  .object({ kind: z.literal("line"), from: pathPoseSchema, to: pathPoseSchema })
  .strict();

export const pathBezierSegmentSchema = z
  .object({
    kind: z.literal("bezier"),
    from: pathPoseSchema,
    control: z.array(pathPointSchema).min(1).max(MAX_BEZIER_CONTROL_POINTS),
    to: pathPoseSchema,
  })
  .strict();

export const pathSegmentSchema = z.discriminatedUnion("kind", [pathLineSegmentSchema, pathBezierSegmentSchema]);

const tangentHeading = z.object({ mode: z.literal("tangent") }).strict();
const tangentReversedHeading = z.object({ mode: z.literal("tangentReversed") }).strict();
const constantHeading = z.object({ mode: z.literal("constant"), heading: finite() }).strict();
const linearHeading = z.object({ mode: z.literal("linear"), from: finite(), to: finite() }).strict();
const facePointHeading = z
  .object({ mode: z.literal("facePoint"), x: finite(), y: finite(), offset: finite().optional() })
  .strict();

/** The heading one range of a piecewise heading holds: any mode but piecewise. */
export const pathRangeHeadingSchema = z.discriminatedUnion("mode", [
  tangentHeading,
  tangentReversedHeading,
  constantHeading,
  linearHeading,
  facePointHeading,
]);

export const pathHeadingRangeSchema = z
  .object({
    startT: z.number().min(0).max(1),
    endT: z.number().min(0).max(1),
    heading: pathRangeHeadingSchema,
  })
  .strict();

export const pathHeadingSchema = z.discriminatedUnion("mode", [
  tangentHeading,
  tangentReversedHeading,
  constantHeading,
  linearHeading,
  facePointHeading,
  z.object({ mode: z.literal("piecewise"), ranges: list(pathHeadingRangeSchema).min(1) }).strict(),
]);

export const pathPathStepSchema = z
  .object({
    id: shortString().optional(),
    kind: z.literal("path"),
    timeoutS: z.number().finite().positive().optional(),
    segments: list(pathSegmentSchema).min(1),
    heading: pathHeadingSchema.optional(),
    speedFraction: z.number().finite().positive().max(1).optional(),
  })
  .strict();

export const pathWaitStepSchema = z
  .object({
    id: shortString().optional(),
    kind: z.literal("wait"),
    seconds: z.number().finite().nonnegative(),
  })
  .strict();

export const pathStepSchema = z.discriminatedUnion("kind", [pathPathStepSchema, pathWaitStepSchema]);

export const pathFileSchema = z
  .object({
    $schema: z.literal(PATH_SCHEMA_ID).optional(),
    formatVersion: z.literal(PATH_FORMAT_VERSION),
    kind: z.literal("path"),
    season: shortString(),
    alliance: z.enum(["RED", "BLUE"]),
    title: shortString().optional(),
    source: z
      .object({ planner: z.string().max(MAX_PATH_STRING_LENGTH).optional(), exporter: z.string().max(MAX_PATH_STRING_LENGTH).optional() })
      .strict()
      .optional(),
    frame: trajectoryFrameSchema,
    startPose: pathStartPoseSchema,
    steps: list(pathStepSchema).min(1),
  })
  .strict();

export type PathFile = z.infer<typeof pathFileSchema>;
export type PathFileStep = z.infer<typeof pathStepSchema>;
export type PathFileSegment = z.infer<typeof pathSegmentSchema>;
export type PathFileHeading = z.infer<typeof pathHeadingSchema>;
export type PathFileRangeHeading = z.infer<typeof pathRangeHeadingSchema>;
export type PathFilePose = z.infer<typeof pathPoseSchema>;
