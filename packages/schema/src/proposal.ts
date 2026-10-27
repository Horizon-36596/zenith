import { z } from "zod";
import {
  actualOverWindowMessage,
  actualWithinWindow,
  ENVELOPE_MAX_DURATION_S,
  ENVELOPE_MAX_POINTS,
  ENVELOPE_MIN_POINTS,
} from "./auto.js";
import { formatVersionFor, isSchemaIdFor, SCHEMA_ID } from "./ids.js";
import {
  MAX_PROJECTION_LIST_LENGTH,
  MAX_PROJECTION_STRING_LENGTH,
  projectionConditionSchema,
  projectionHeadingSchema,
  projectionMarkerAtSchema,
  projectionMarkerSchema,
  projectionSegmentSchema,
  STEP_ID_PATTERN,
} from "./projection.js";

/**
 * `proposal`: the changes a team proposes to an auto another team shared with it at the propose
 * level (spec 13 section 14). The proposing team only ever holds the
 * projection, so every step is named by its opaque projection id (`s3`) and every command or
 * condition by its opaque token (`cmd2`, `cond1`); the owning team maps them back from the revision
 * the share is pinned to.
 *
 * The changes are a closed set, and that set is the limit of section 14: poses, heading modes,
 * speed fractions, timeouts, waits, reordering, removing and adding path steps, sliding markers and
 * envelopes. There is no way to write a command's name or arguments, rename a step, or add a
 * command: a file that tries is not a proposal. `validateProposal` in core checks what a schema
 * cannot, such as whether a token was in the share and whether a step id names a path.
 *
 * Like the projection, it is read from another team, so it is strict: an unknown key at any depth
 * is refused rather than dropped, and every array and every string has a cap. Units follow the
 * file-format rule: inches, radians and seconds, each named by its key.
 */

/** The most changes one proposal may carry. */
export const MAX_PROPOSAL_CHANGES = 200;
/** The longest one-line comment a change may carry. */
export const MAX_PROPOSAL_COMMENT_LENGTH = 200;
/**
 * The form of a structure hash: `sha256:` and 64 lowercase hex digits, the SHA-256 of the
 * projection's structure in the stable form `structureHash` in core writes.
 */
export const STRUCTURE_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
/** A share's id: the random part of its address, in the characters an address may carry. */
export const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** The closed set of changes, in the order the file format documents them. */
export const PROPOSAL_CHANGE_OPS = [
  "movePose",
  "setHeading",
  "setSpeedFraction",
  "setTimeout",
  "insertWait",
  "setWait",
  "removeStep",
  "addPath",
  "reorder",
  "moveMarker",
  "setEnvelope",
] as const;
export type ProposalChangeOp = (typeof PROPOSAL_CHANGE_OPS)[number];

const finite = () => z.number().finite();
const index = () => z.number().int().nonnegative().max(MAX_PROJECTION_LIST_LENGTH);
const stepId = () => z.string().regex(STEP_ID_PATTERN);
const list = <T extends z.ZodTypeAny>(item: T) => z.array(item).max(MAX_PROJECTION_LIST_LENGTH);

/** One line of text: no line breaks, at most `MAX_PROPOSAL_COMMENT_LENGTH` characters. */
const comment = () =>
  z
    .string()
    .min(1)
    .max(MAX_PROPOSAL_COMMENT_LENGTH)
    .regex(/^[^\r\n]*$/, { message: "a comment is one line" })
    .optional();

/** A pose to move a point to. The heading is optional, as it is on a pose in an auto. */
export const proposalPoseSchema = z
  .object({ xIn: finite(), yIn: finite(), headingRad: finite().optional() })
  .strict();

/** Which point of a segment: one of its two ends, or one Bezier control point by index. */
export const proposalPointSchema = z.union([
  z.literal("from"),
  z.literal("to"),
  z.object({ controlIndex: index() }).strict(),
]);

/** An envelope as the auto format has it (spec 13 section 10), with a cap on the provenance. */
export const proposalEnvelopeSchema = z
  .object({
    polygon: z
      .array(z.object({ xIn: finite(), yIn: finite() }).strict())
      .min(ENVELOPE_MIN_POINTS)
      .max(ENVELOPE_MAX_POINTS),
    maxDurationS: z.number().finite().positive().max(ENVELOPE_MAX_DURATION_S),
    actualDurationS: z.number().finite().positive().optional(),
    provenance: z.string().min(1).max(MAX_PROJECTION_STRING_LENGTH),
  })
  .strict()
  .refine(actualWithinWindow, (envelope) => ({
    message: actualOverWindowMessage(envelope),
    path: ["actualDurationS"],
  }));

export const movePoseChangeSchema = z
  .object({
    op: z.literal("movePose"),
    stepId: stepId(),
    segmentIndex: index(),
    point: proposalPointSchema,
    pose: proposalPoseSchema,
    comment: comment(),
  })
  .strict();

export const setHeadingChangeSchema = z
  .object({ op: z.literal("setHeading"), stepId: stepId(), heading: projectionHeadingSchema, comment: comment() })
  .strict();

export const setSpeedFractionChangeSchema = z
  .object({
    op: z.literal("setSpeedFraction"),
    stepId: stepId(),
    speedFraction: z.number().finite().positive().max(1),
    comment: comment(),
  })
  .strict();

/** `timeoutS: null` removes the step's timeout. */
export const setTimeoutChangeSchema = z
  .object({
    op: z.literal("setTimeout"),
    stepId: stepId(),
    timeoutS: z.union([z.number().finite().positive(), z.null()]),
    comment: comment(),
  })
  .strict();

/**
 * A new wait, straight after a step (in whichever list holds it) or at the start of the auto. It
 * waits for `seconds` or until a condition, given as a token the share holds; exactly one of the
 * two, as an auto's wait step.
 */
export const insertWaitChangeSchema = z
  .object({
    op: z.literal("insertWait"),
    afterStepId: stepId().optional(),
    atStart: z.literal(true).optional(),
    seconds: z.number().finite().nonnegative().optional(),
    until: projectionConditionSchema.optional(),
    comment: comment(),
  })
  .strict();

/** What an existing wait waits for: `seconds` or a condition token, exactly one of the two. */
export const setWaitChangeSchema = z
  .object({
    op: z.literal("setWait"),
    stepId: stepId(),
    seconds: z.number().finite().nonnegative().optional(),
    until: projectionConditionSchema.optional(),
    comment: comment(),
  })
  .strict();

/** Removes a path or wait step; core refuses any other kind. */
export const removeStepChangeSchema = z
  .object({ op: z.literal("removeStep"), stepId: stepId(), comment: comment() })
  .strict();

/**
 * A new path step, placed like an inserted wait. Every pose is literal, as in a projection. Its
 * markers and end condition, if any, are tokens the share holds and that the rest of the proposal
 * frees, so a token moves rather than being copied.
 */
export const addPathChangeSchema = z
  .object({
    op: z.literal("addPath"),
    afterStepId: stepId().optional(),
    atStart: z.literal(true).optional(),
    timeoutS: z.number().finite().positive().optional(),
    segments: list(projectionSegmentSchema).min(1),
    heading: projectionHeadingSchema,
    speedFraction: z.number().finite().positive().max(1).optional(),
    markers: list(projectionMarkerSchema).optional(),
    endCondition: projectionConditionSchema.optional(),
    comment: comment(),
  })
  .strict();

/** Moves a step to `newIndex` (0-based, counted after it is taken out) in the list that holds it. */
export const reorderChangeSchema = z
  .object({ op: z.literal("reorder"), stepId: stepId(), newIndex: index(), comment: comment() })
  .strict();

/** Slides one marker of a path step to a new place along it. */
export const moveMarkerChangeSchema = z
  .object({
    op: z.literal("moveMarker"),
    stepId: stepId(),
    markerIndex: index(),
    at: projectionMarkerAtSchema,
    comment: comment(),
  })
  .strict();

/** Gives a path, command or wait step an envelope, or removes it with `null`. */
export const setEnvelopeChangeSchema = z
  .object({
    op: z.literal("setEnvelope"),
    stepId: stepId(),
    envelope: z.union([proposalEnvelopeSchema, z.null()]),
    comment: comment(),
  })
  .strict();

type Placed = { afterStepId?: string | undefined; atStart?: true | undefined };
type WaitsFor = { seconds?: number | undefined; until?: unknown };

/** The rules one object cannot say by itself: where a new step goes, and what a wait waits for. */
function refineChange(change: { op: string } & Placed & WaitsFor, context: z.RefinementCtx): void {
  if (change.op === "insertWait" || change.op === "addPath") {
    const placed = (change.afterStepId === undefined ? 0 : 1) + (change.atStart === undefined ? 0 : 1);
    if (placed !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${change.op} needs exactly one of afterStepId and atStart`,
      });
    }
  }
  if (change.op === "insertWait" || change.op === "setWait") {
    const waits = (change.seconds === undefined ? 0 : 1) + (change.until === undefined ? 0 : 1);
    if (waits !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${change.op} needs exactly one of seconds and until; a wait ends either after a time or on a condition`,
      });
    }
  }
}

export const proposalChangeSchema = z
  .discriminatedUnion("op", [
    movePoseChangeSchema,
    setHeadingChangeSchema,
    setSpeedFractionChangeSchema,
    setTimeoutChangeSchema,
    insertWaitChangeSchema,
    setWaitChangeSchema,
    removeStepChangeSchema,
    addPathChangeSchema,
    reorderChangeSchema,
    moveMarkerChangeSchema,
    setEnvelopeChangeSchema,
  ])
  .superRefine(refineChange);

export const shareRefSchema = z
  .object({
    shareId: z.string().min(1).max(MAX_PROJECTION_STRING_LENGTH).regex(SHARE_ID_PATTERN),
    /** The revision of the auto the share was made from, which is what the owner rebuilds. */
    revision: z.number().int().nonnegative(),
  })
  .strict();

/**
 * `$schema` is required, as it is on a projection: a proposal is only ever written by Zenith, and
 * naming its kind is part of what makes it safe to read from someone else.
 */
const proposalSchemaId = z.string().refine((value) => isSchemaIdFor("proposal", value), {
  message: `$schema must be ${SCHEMA_ID.proposal}`,
});

/** The proposal file. Key declaration order is the canonical file order. */
export const proposalSchema = z
  .object({
    $schema: proposalSchemaId,
    formatVersion: formatVersionFor("proposal"),
    kind: z.literal("proposal"),
    shareRef: shareRefSchema,
    /** The `structureHash` of the projection the proposal was made against. */
    baseStructureHash: z.string().regex(STRUCTURE_HASH_PATTERN),
    changes: z.array(proposalChangeSchema).max(MAX_PROPOSAL_CHANGES),
  })
  .strict();

export type ProposalPose = z.infer<typeof proposalPoseSchema>;
export type ProposalPoint = z.infer<typeof proposalPointSchema>;
export type ProposalEnvelope = z.infer<typeof proposalEnvelopeSchema>;
export type MovePoseChange = z.infer<typeof movePoseChangeSchema>;
export type SetHeadingChange = z.infer<typeof setHeadingChangeSchema>;
export type SetSpeedFractionChange = z.infer<typeof setSpeedFractionChangeSchema>;
export type SetTimeoutChange = z.infer<typeof setTimeoutChangeSchema>;
export type InsertWaitChange = z.infer<typeof insertWaitChangeSchema>;
export type SetWaitChange = z.infer<typeof setWaitChangeSchema>;
export type RemoveStepChange = z.infer<typeof removeStepChangeSchema>;
export type AddPathChange = z.infer<typeof addPathChangeSchema>;
export type ReorderChange = z.infer<typeof reorderChangeSchema>;
export type MoveMarkerChange = z.infer<typeof moveMarkerChangeSchema>;
export type SetEnvelopeChange = z.infer<typeof setEnvelopeChangeSchema>;
export type ProposalChange = z.infer<typeof proposalChangeSchema>;
export type ShareRef = z.infer<typeof shareRefSchema>;
export type Proposal = z.infer<typeof proposalSchema>;
