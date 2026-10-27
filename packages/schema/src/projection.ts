import { z } from "zod";
import { MAX_BEZIER_CONTROL_POINTS } from "./auto.js";
import { formatVersionFor, isSchemaIdFor, SCHEMA_ID } from "./ids.js";

/**
 * `projection`: what another team receives when an auto is shared with it
 * (spec 13 section 8.2). It is built on the sharer's device by
 * `projectShare` in `@horizon36596/zenith-core`, from an allowlist of the auto, the robot, the field
 * and the instant-sim trace, and it is the only one of these that leaves the team.
 *
 * Every other kind of file is forgiving about keys it does not know, because a team writes its own
 * files. This one is read from somebody else, so it is strict: an unknown key at any depth is
 * refused rather than dropped, every array and every string has a cap, and every command and
 * condition is an opaque token (`cmd3`, `cond1`) where it stands. The one exception is the optional
 * `commands` list: when the sharer ticks "Include command names" (owner ruling 2026-09-27), it names
 * what each command token stands for, with the call's own settings, and nothing else. Condition names
 * are never carried.
 *
 * Units follow the file-format rule: inches, radians and seconds, each named by its key. Poses are
 * in the season's frame, which for every shipped season is the field file's own frame.
 */

/** The most trajectory rows a projection may carry: 300 s at 10 Hz. */
export const MAX_PROJECTION_POSES = 3000;
/** The most phases a projection may carry. */
export const MAX_PROJECTION_PHASES = 200;
/** The most claims on field elements a projection may carry. */
export const MAX_PROJECTION_CLAIMS = 200;
/** The most envelopes a projection may carry. */
export const MAX_PROJECTION_ENVELOPES = 50;
/** The longest string a projection may carry: a title, a season id, an element id or a step id. */
export const MAX_PROJECTION_STRING_LENGTH = 200;
/**
 * The most entries in any list inside the structure: steps in one list, segments in one path step,
 * markers, piecewise ranges and envelope polygon corners.
 */
export const MAX_PROJECTION_LIST_LENGTH = 200;

/**
 * The most named commands a projection may carry: far more calls than any auto makes, and a cap
 * because the list is read from another team.
 */
export const MAX_PROJECTION_COMMANDS = 1000;

/**
 * The deepest a step may sit inside groups (sequence, parallel, branch) in a projection's
 * structure, counting a top-level step as 1. Far deeper than any auto nests, and a cap because the
 * schema is recursive: a projection from another team nested thousands deep would otherwise
 * overflow the stack while it is parsed instead of being refused.
 */
export const MAX_PROJECTION_STEP_DEPTH = 32;

/** The rate the trajectory is sampled at, in samples per second. It is fixed. */
export const PROJECTION_RATE_HZ = 10;

/** The fixed list of phase labels (section 8.2). */
export const PROJECTION_PHASE_LABELS = ["drive", "score", "collect", "wait", "park", "other"] as const;
export type ProjectionPhaseLabel = (typeof PROJECTION_PHASE_LABELS)[number];

/** A command's opaque token: `cmd` and a number counted from 1 in step order. */
export const COMMAND_TOKEN_PATTERN = /^cmd[1-9][0-9]{0,5}$/;
/** A condition's opaque token: `cond` and a number counted from 1 in step order. */
export const CONDITION_TOKEN_PATTERN = /^cond[1-9][0-9]{0,5}$/;
/**
 * A step's opaque id: `s` and a number counted from 1 in step order. The author's own step ids
 * never appear in a projection; the owning team maps these back (`projectionStepIdMap` in core).
 */
export const STEP_ID_PATTERN = /^s[1-9][0-9]{0,5}$/;

const finite = () => z.number().finite();
const nonNegative = () => z.number().finite().nonnegative();
const shortString = () => z.string().min(1).max(MAX_PROJECTION_STRING_LENGTH);
const list = <T extends z.ZodTypeAny>(item: T) => z.array(item).max(MAX_PROJECTION_LIST_LENGTH);

/** A full pose, in inches and radians. */
export const projectionPoseSchema = z
  .object({ xIn: finite(), yIn: finite(), headingRad: finite() })
  .strict();

/** A point, in inches. */
export const projectionPointSchema = z.object({ xIn: finite(), yIn: finite() }).strict();

/**
 * One trajectory row, `[xIn, yIn, headingRad]`. It is an array of exactly three numbers rather than
 * a zod tuple so the published JSON Schema stays valid under draft 2020-12 (`jsonschema.ts`); the
 * TypeScript type below is the tuple.
 */
export const projectionPoseRowSchema = z.array(finite()).length(3);

/** A time span in seconds from the start of the auto, which may not end before it starts. */
const spanRefinement = <T extends { startS: number; endS: number }>(span: T): boolean => span.endS >= span.startS;
const spanMessage = { message: "endS must not be before startS" };

export const projectionPhaseSchema = z
  .object({
    startS: nonNegative(),
    endS: nonNegative(),
    label: z.enum(PROJECTION_PHASE_LABELS),
  })
  .strict()
  .refine(spanRefinement, spanMessage);

export const projectionClaimSchema = z
  .object({
    elementId: shortString(),
    action: z.enum(["take", "score"]),
    atS: nonNegative(),
  })
  .strict();

export const projectionEnvelopeSchema = z
  .object({
    startS: nonNegative(),
    endS: nonNegative(),
    polygon: z.array(projectionPointSchema).min(3).max(MAX_PROJECTION_LIST_LENGTH),
  })
  .strict()
  .refine(spanRefinement, spanMessage);

export const projectionBoundingBoxSchema = z
  .object({
    lengthIn: z.number().finite().positive(),
    widthIn: z.number().finite().positive(),
    centreOffsetIn: projectionPointSchema,
  })
  .strict();

export const projectionTrajectorySchema = z
  .object({
    rateHz: z.literal(PROJECTION_RATE_HZ),
    positionQuantumIn: z.number().finite().positive(),
    headingQuantumRad: z.number().finite().positive(),
    poses: z.array(projectionPoseRowSchema).min(1).max(MAX_PROJECTION_POSES),
  })
  .strict();

// ------------------------------------------------------------------------------------------------
// The structure, carried only at the propose level
// ------------------------------------------------------------------------------------------------

export const projectionCommandTokenSchema = z.string().regex(COMMAND_TOKEN_PATTERN);
/** Where a condition name stood: an endCondition, a wait's until, a branch's condition. */
export const projectionConditionSchema = z
  .object({ token: z.string().regex(CONDITION_TOKEN_PATTERN) })
  .strict();

export const projectionLineSegmentSchema = z
  .object({ kind: z.literal("line"), from: projectionPoseSchema, to: projectionPoseSchema })
  .strict();

export const projectionBezierSegmentSchema = z
  .object({
    kind: z.literal("bezier"),
    from: projectionPoseSchema,
    control: z.array(projectionPointSchema).min(1).max(MAX_BEZIER_CONTROL_POINTS),
    to: projectionPoseSchema,
  })
  .strict();

export const projectionSegmentSchema = z.discriminatedUnion("kind", [
  projectionLineSegmentSchema,
  projectionBezierSegmentSchema,
]);

const tangentHeading = z.object({ mode: z.literal("tangent") }).strict();
const tangentReversedHeading = z.object({ mode: z.literal("tangentReversed") }).strict();
const constantHeading = z.object({ mode: z.literal("constant"), headingRad: finite() }).strict();
const linearHeading = z.object({ mode: z.literal("linear"), fromRad: finite(), toRad: finite() }).strict();
const facePointHeading = z
  .object({ mode: z.literal("facePoint"), xIn: finite(), yIn: finite(), offsetRad: finite().optional() })
  .strict();

export const projectionRangeHeadingSchema = z.discriminatedUnion("mode", [
  tangentHeading,
  tangentReversedHeading,
  constantHeading,
  linearHeading,
  facePointHeading,
]);

export const projectionHeadingRangeSchema = z
  .object({
    startT: z.number().min(0).max(1),
    endT: z.number().min(0).max(1),
    heading: projectionRangeHeadingSchema,
  })
  .strict();

export const projectionHeadingSchema = z.discriminatedUnion("mode", [
  tangentHeading,
  tangentReversedHeading,
  constantHeading,
  linearHeading,
  facePointHeading,
  z.object({ mode: z.literal("piecewise"), ranges: list(projectionHeadingRangeSchema).min(1) }).strict(),
]);

export const projectionMarkerAtSchema = z.union([
  z.object({ t: z.number().min(0).max(1) }).strict(),
  z.object({ distanceIn: nonNegative() }).strict(),
  z.object({ distanceFromEndIn: nonNegative() }).strict(),
]);

/** A marker keeps where along the path it fires; its command is a token. */
export const projectionMarkerSchema = z
  .object({ at: projectionMarkerAtSchema, token: projectionCommandTokenSchema })
  .strict();

// ------------------------------------------------------------------------------------------------
// The named commands, carried only when the sharer includes them
// ------------------------------------------------------------------------------------------------

/** One argument of a command call: the value the auto file gives it, a string, a number or a flag. */
export const projectionCommandArgValueSchema = z.union([
  z.string().max(MAX_PROJECTION_STRING_LENGTH),
  finite(),
  z.boolean(),
]);

/**
 * A call's arguments, by the parameter names the auto file uses. At most
 * `MAX_PROJECTION_LIST_LENGTH` of them.
 */
export const projectionCommandArgsSchema = z
  .record(shortString(), projectionCommandArgValueSchema)
  .refine((args) => Object.keys(args).length <= MAX_PROJECTION_LIST_LENGTH, {
    message: `a command carries at most ${String(MAX_PROJECTION_LIST_LENGTH)} arguments`,
  });

/**
 * What one command token stands for, when the sharer chose to include command names: the name the
 * auto calls, the arguments it passes, whether it is a command step or a marker on a path, and when
 * the step it belongs to ran in the instant sim (a command step's own run, or the whole of the path
 * a marker fires on). The span is left out for a step that did not run, such as one in a branch arm
 * the sim did not take. Nothing from the robot file is carried: no description, no parameter
 * table, no estimate formula, no code.
 */
export const projectionNamedCommandSchema = z
  .object({
    token: projectionCommandTokenSchema,
    kind: z.enum(["command", "marker"]),
    name: shortString(),
    args: projectionCommandArgsSchema.optional(),
    startS: nonNegative().optional(),
    endS: nonNegative().optional(),
  })
  .strict()
  .refine((entry) => (entry.startS === undefined) === (entry.endS === undefined), {
    message: "startS and endS come together or not at all",
  })
  .refine((entry) => entry.startS === undefined || entry.endS === undefined || entry.endS >= entry.startS, spanMessage);

export type ProjectionCommandArgs = z.infer<typeof projectionCommandArgsSchema>;

export interface ProjectionNamedCommand {
  token: string;
  kind: "command" | "marker";
  name: string;
  args?: ProjectionCommandArgs;
  startS?: number;
  endS?: number;
}

export interface ProjectionPose {
  xIn: number;
  yIn: number;
  headingRad: number;
}

export interface ProjectionPoint {
  xIn: number;
  yIn: number;
}

export type ProjectionSegment = z.infer<typeof projectionSegmentSchema>;
export type ProjectionHeading = z.infer<typeof projectionHeadingSchema>;
export type ProjectionRangeHeading = z.infer<typeof projectionRangeHeadingSchema>;
export type ProjectionHeadingRange = z.infer<typeof projectionHeadingRangeSchema>;
export type ProjectionMarkerAt = z.infer<typeof projectionMarkerAtSchema>;
export type ProjectionMarker = z.infer<typeof projectionMarkerSchema>;
export type ProjectionCondition = z.infer<typeof projectionConditionSchema>;

export interface ProjectionPathStep {
  id: string;
  kind: "path";
  timeoutS?: number;
  /** Every pose resolved: no waypoint reference and no `"current"`. */
  segments: ProjectionSegment[];
  heading?: ProjectionHeading;
  speedFraction?: number;
  markers?: ProjectionMarker[];
  endCondition?: ProjectionCondition;
}

/** A command step as a token, with only what a partner needs to plan around it. */
export interface ProjectionCommandStep {
  id: string;
  kind: "command";
  token: string;
  /** The seconds the robot file's `estimateS` gives for this call, or null when it is unknown. */
  estimateS: number | null;
  stationary: boolean;
  movesRobot: boolean;
  timeoutS?: number;
}

export interface ProjectionWaitStep {
  id: string;
  kind: "wait";
  seconds?: number;
  until?: ProjectionCondition;
  timeoutS?: number;
}

export interface ProjectionSequenceStep {
  id: string;
  kind: "sequence";
  steps: ProjectionStep[];
}

export interface ProjectionParallelStep {
  id: string;
  kind: "parallel";
  mode: "all" | "race" | "deadline";
  /** The opaque id of the member that ends the group, when `mode` is `deadline`. */
  deadline?: string;
  steps: ProjectionStep[];
}

export interface ProjectionBranchStep {
  id: string;
  kind: "branch";
  condition: ProjectionCondition;
  then: ProjectionStep[];
  else?: ProjectionStep[];
}

export type ProjectionStep =
  | ProjectionPathStep
  | ProjectionCommandStep
  | ProjectionWaitStep
  | ProjectionSequenceStep
  | ProjectionParallelStep
  | ProjectionBranchStep;

/** The auto's steps, as the propose level carries them. */
export interface ProjectionStructure {
  steps: ProjectionStep[];
}

const stepId = () => z.string().regex(STEP_ID_PATTERN);
const stepList = () => list(z.lazy(() => projectionStepSchema));

export const projectionPathStepSchema = z
  .object({
    id: stepId(),
    kind: z.literal("path"),
    timeoutS: z.number().finite().positive().optional(),
    segments: list(projectionSegmentSchema).min(1),
    heading: projectionHeadingSchema.optional(),
    speedFraction: z.number().finite().positive().max(1).optional(),
    markers: list(projectionMarkerSchema).optional(),
    endCondition: projectionConditionSchema.optional(),
  })
  .strict();

export const projectionCommandStepSchema = z
  .object({
    id: stepId(),
    kind: z.literal("command"),
    token: projectionCommandTokenSchema,
    estimateS: z.union([nonNegative(), z.null()]),
    stationary: z.boolean(),
    movesRobot: z.boolean(),
    timeoutS: z.number().finite().positive().optional(),
  })
  .strict();

export const projectionWaitStepSchema = z
  .object({
    id: stepId(),
    kind: z.literal("wait"),
    seconds: nonNegative().optional(),
    until: projectionConditionSchema.optional(),
    timeoutS: z.number().finite().positive().optional(),
  })
  .strict();

export const projectionSequenceStepSchema = z
  .object({ id: stepId(), kind: z.literal("sequence"), steps: stepList() })
  .strict();

export const projectionParallelStepSchema = z
  .object({
    id: stepId(),
    kind: z.literal("parallel"),
    mode: z.enum(["all", "race", "deadline"]),
    deadline: stepId().optional(),
    steps: stepList(),
  })
  .strict();

export const projectionBranchStepSchema = z
  .object({
    id: stepId(),
    kind: z.literal("branch"),
    condition: projectionConditionSchema,
    then: stepList(),
    else: stepList().optional(),
  })
  .strict();

export const projectionStepSchema: z.ZodType<ProjectionStep> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    projectionPathStepSchema,
    projectionCommandStepSchema,
    projectionWaitStepSchema,
    projectionSequenceStepSchema,
    projectionParallelStepSchema,
    projectionBranchStepSchema,
  ]),
);

export const projectionStructureSchema = z.object({ steps: stepList() }).strict();

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The message for a projection whose structure nests steps deeper than `MAX_PROJECTION_STEP_DEPTH`,
 * or null. It walks the raw JSON without recursion and stops at the first step past the cap, so
 * it is safe to run before the recursive schema sees the document. Anything that is not shaped
 * like a step list is left for the schema to refuse.
 */
export function projectionDepthIssue(json: unknown): string | null {
  if (!isPlainRecord(json) || !isPlainRecord(json["structure"])) return null;
  const pending: { steps: unknown; depth: number }[] = [{ steps: json["structure"]["steps"], depth: 1 }];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (!Array.isArray(next.steps)) continue;
    if (next.depth > MAX_PROJECTION_STEP_DEPTH) {
      return `steps nest deeper than ${String(MAX_PROJECTION_STEP_DEPTH)} levels`;
    }
    for (const step of next.steps) {
      if (!isPlainRecord(step)) continue;
      for (const key of ["steps", "then", "else"]) {
        if (Array.isArray(step[key])) pending.push({ steps: step[key], depth: next.depth + 1 });
      }
    }
  }
  return null;
}

/**
 * `$schema` is required here, unlike the files a team writes for itself: a projection is only ever
 * written by Zenith, and naming its kind is part of what makes it safe to read from someone else.
 */
const projectionSchemaId = z.string().refine((value) => isSchemaIdFor("projection", value), {
  message: `$schema must be ${SCHEMA_ID.projection}`,
});

/** The projection file. Key declaration order is the canonical file order. */
export const projectionSchema = z
  .object({
    $schema: projectionSchemaId,
    formatVersion: formatVersionFor("projection"),
    kind: z.literal("projection"),
    level: z.enum(["view", "propose"]),
    /** The season id the field file names, such as `biobuzz`. */
    season: shortString(),
    alliance: z.enum(["RED", "BLUE"]),
    title: shortString().optional(),
    startPose: projectionPoseSchema,
    /** The union of the expanded footprint and every mouth box, in the robot frame. */
    boundingBox: projectionBoundingBoxSchema,
    trajectory: projectionTrajectorySchema,
    phases: z.array(projectionPhaseSchema).max(MAX_PROJECTION_PHASES),
    claims: z.array(projectionClaimSchema).max(MAX_PROJECTION_CLAIMS),
    envelopes: z.array(projectionEnvelopeSchema).max(MAX_PROJECTION_ENVELOPES),
    totalS: nonNegative(),
    /** Only at the propose level. */
    structure: projectionStructureSchema.optional(),
    /**
     * Only when the sharer ticks "Include command names": what each command token stands for, in
     * token order. At either level; absent otherwise, so an older projection stays valid.
     */
    commands: z.array(projectionNamedCommandSchema).max(MAX_PROJECTION_COMMANDS).optional(),
  })
  .strict();

export type ProjectionPhase = z.infer<typeof projectionPhaseSchema>;
export type ProjectionClaim = z.infer<typeof projectionClaimSchema>;
export type ProjectionEnvelope = z.infer<typeof projectionEnvelopeSchema>;
export type ProjectionBoundingBox = z.infer<typeof projectionBoundingBoxSchema>;

/** One trajectory row: `[xIn, yIn, headingRad]`. */
export type ProjectionPoseRow = [number, number, number];

export interface ProjectionTrajectory {
  rateHz: typeof PROJECTION_RATE_HZ;
  positionQuantumIn: number;
  headingQuantumRad: number;
  /** One row every 0.1 s from t = 0, in the season frame, rounded to the two quanta. */
  poses: ProjectionPoseRow[];
}

/** The projection, as `projectShare` builds it and `parseProjection` reads it. */
export interface Projection {
  $schema: string;
  formatVersion: 1;
  kind: "projection";
  level: "view" | "propose";
  season: string;
  alliance: "RED" | "BLUE";
  title?: string;
  startPose: ProjectionPose;
  boundingBox: ProjectionBoundingBox;
  trajectory: ProjectionTrajectory;
  phases: ProjectionPhase[];
  claims: ProjectionClaim[];
  envelopes: ProjectionEnvelope[];
  totalS: number;
  structure?: ProjectionStructure;
  /** Only when the sharer included command names: what each command token stands for. */
  commands?: ProjectionNamedCommand[];
}

/**
 * The hand-written `Projection` and the schema must agree except for the pose rows, which the
 * schema holds as arrays of three numbers and the type as a tuple. This fails to compile if they
 * drift apart.
 */
type Inferred = z.infer<typeof projectionSchema>;
type WithRows<T> = Omit<T, "trajectory"> & { trajectory: Omit<ProjectionTrajectory, "poses"> & { poses: number[][] } };
const _projectionMatchesSchema = (value: WithRows<Projection>): Inferred => value;
const _schemaMatchesProjection = (value: Inferred): WithRows<Projection> => value;
void _projectionMatchesSchema;
void _schemaMatchesProjection;
