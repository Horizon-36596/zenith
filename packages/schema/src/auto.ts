import { z } from "zod";
import { poseSchema, poseSourceSchema, provenanceSchema } from "./common.js";
import { formatVersionFor, schemaIdField } from "./ids.js";

/**
 * The highest number of Bezier control points a v1 auto file may carry, so the highest degree is
 * four (start, three controls, end).
 *
 * Read off the pinned Pedro snapshot: `Paths.curve(Pose...)` is variadic,
 * `BezierCurve(List<Vector2D>)` accepts any control polygon of three points or more, and the
 * runtime hands every pose in `control[]` straight to `Paths.curve`. The owner's ruling was
 * "whatever Pedro allows", so the file format allows one to three control points. Changing this
 * number changes the file format, not just the code.
 */
export const MAX_BEZIER_CONTROL_POINTS = 3;

export const lineSegmentSchema = z.object({
  kind: z.literal("line"),
  from: poseSourceSchema,
  to: poseSourceSchema,
});

export const bezierSegmentSchema = z.object({
  kind: z.literal("bezier"),
  from: poseSourceSchema,
  control: z.array(poseSchema).min(1).max(MAX_BEZIER_CONTROL_POINTS),
  to: poseSourceSchema,
});

export const segmentSchema = z.discriminatedUnion("kind", [lineSegmentSchema, bezierSegmentSchema]);

const tangentHeadingSchema = z.object({ mode: z.literal("tangent") });
const tangentReversedHeadingSchema = z.object({ mode: z.literal("tangentReversed") });
const constantHeadingSchema = z.object({ mode: z.literal("constant"), headingRad: z.number() });
const linearHeadingSchema = z.object({ mode: z.literal("linear"), fromRad: z.number(), toRad: z.number() });
const facePointHeadingSchema = z.object({
  mode: z.literal("facePoint"),
  xIn: z.number(),
  yIn: z.number(),
  offsetRad: z.number().optional(),
});

/**
 * The heading one range of a `piecewise` heading carries: any mode but `piecewise` itself. Inside a
 * range, `linear` turns from `fromRad` at the range's start to `toRad` at its end.
 */
export const rangeHeadingSchema = z.discriminatedUnion("mode", [
  tangentHeadingSchema,
  tangentReversedHeadingSchema,
  constantHeadingSchema,
  linearHeadingSchema,
  facePointHeadingSchema,
]);

/**
 * One stretch of a `piecewise` heading (format version 3): from `startT` to `endT` along the step,
 * as fractions of its arc length (no unit), with its own heading. Pedro's
 * `Interpolator.piecewise().until(t, ...)` needs the ranges to run from 0 to exactly 1, in order,
 * with no gap and no overlap; the schema only bounds each number and `HEADING_RANGES` checks the
 * rest, so a half-edited file still loads and says what is wrong with it.
 */
export const headingRangeSchema = z.object({
  startT: z.number().min(0).max(1),
  endT: z.number().min(0).max(1),
  heading: rangeHeadingSchema,
});

/** The heading modes of site/docs/file-format.md, as h(t). */
export const headingSchema = z.discriminatedUnion("mode", [
  tangentHeadingSchema,
  tangentReversedHeadingSchema,
  constantHeadingSchema,
  linearHeadingSchema,
  facePointHeadingSchema,
  z.object({ mode: z.literal("piecewise"), ranges: z.array(headingRangeSchema).min(1) }),
]);

export const markerAtSchema = z.union([
  z.object({ t: z.number().min(0).max(1) }),
  z.object({ distanceIn: z.number().nonnegative() }),
  z.object({ distanceFromEndIn: z.number().nonnegative() }),
]);

export const commandCallSchema = z.object({
  name: z.string().min(1),
  args: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

export const markerSchema = z.object({
  at: markerAtSchema,
  command: commandCallSchema,
});

export const conditionRefSchema = z.object({
  condition: z.string().min(1),
});

/** Planner-only annotations; the runtime ignores them (site/docs/file-format.md, `expect`). */
export const expectSchema = z.object({
  collectFrom: z.string().min(1).optional(),
  count: z.number().optional(),
  launchesInto: z.string().min(1).optional(),
  tip: z.enum(["own", "opponent"]).optional(),
});

/** The fewest and the most corners an envelope's polygon may have. */
export const ENVELOPE_MIN_POINTS = 3;
export const ENVELOPE_MAX_POINTS = 32;

/**
 * The longest window an envelope may declare, in seconds: the whole autonomous period of an FTC
 * match (SPEC: game manual, 30 s autonomous). A window longer than the period says nothing.
 */
export const ENVELOPE_MAX_DURATION_S = 30;

/** One corner of an envelope's polygon, in field inches. */
export const envelopePointSchema = z.object({
  xIn: z.number(),
  yIn: z.number(),
});

/**
 * An optional, planner-only envelope on a step that runs (spec 13 section 10): while the step
 * runs, for at most `maxDurationS`, the robot's bounding box is declared to stay inside `polygon`.
 * The editor draws it, the estimate times a step with no prediction of its own by `maxDurationS`,
 * and a share carries the polygon and the window, never the command behind it. The runtime ignores
 * it. The schema bounds the corner count; ENVELOPE_SHAPE checks that the polygon is simple, so a
 * half-edited file still loads and says what is wrong with it.
 *
 * `actualDurationS` is a what-if (issue #481): how long the step runs this time, to preview a run
 * that finishes sooner than the window or fails early. Where the window times the step (the
 * estimate, the instant sim and so the ideal playback), the planner uses it in place of
 * `maxDurationS`. It is over 0 and at most `maxDurationS`, and absent means the step runs the whole
 * window. A partner's projection keeps `maxDurationS`, the promise; the runtime ignores both.
 */
export const envelopeSchema = z
  .object({
    polygon: z.array(envelopePointSchema).min(ENVELOPE_MIN_POINTS).max(ENVELOPE_MAX_POINTS),
    maxDurationS: z.number().positive().max(ENVELOPE_MAX_DURATION_S),
    actualDurationS: z.number().positive().optional(),
    provenance: provenanceSchema,
  })
  .refine(actualWithinWindow, (envelope) => ({
    message: actualOverWindowMessage(envelope),
    path: ["actualDurationS"],
  }));

/** True when an envelope's what-if run time, if it has one, fits inside its window. */
export function actualWithinWindow(envelope: { maxDurationS: number; actualDurationS?: number | undefined }): boolean {
  return envelope.actualDurationS === undefined || envelope.actualDurationS <= envelope.maxDurationS;
}

/** What the schema says about a what-if run time longer than the window it is a what-if of. */
export function actualOverWindowMessage(envelope: { maxDurationS: number; actualDurationS?: number | undefined }): string {
  return `An envelope's actualDurationS (${String(envelope.actualDurationS)} s) is longer than its maxDurationS (${String(envelope.maxDurationS)} s); the actual run time is at most maxDurationS.`;
}

/**
 * Where a path that starts from `"current"` assumes the robot is when the step before it ends at a
 * pose nobody can predict (a `movesRobot` command): the rejoin pose of spec 13 section 10. The
 * planner starts the path here and takes it as the end of that step; when the step before ends at
 * a known pose, the known pose wins and this is not used. The runtime ignores it: on the robot,
 * `"current"` is always the follower's own pose.
 */
export const rejoinPoseSchema = z.object({
  xIn: z.number(),
  yIn: z.number(),
  headingRad: z.number(),
  provenance: provenanceSchema.optional(),
});

export const pathStepSchema = z.object({
  id: z.string().min(1).optional(),
  kind: z.literal("path"),
  timeoutS: z.number().positive().optional(),
  rejoinFrom: rejoinPoseSchema.optional(),
  segments: z.array(segmentSchema).min(1),
  heading: headingSchema.optional(),
  speedFraction: z.number().positive().max(1).optional(),
  markers: z.array(markerSchema).optional(),
  endCondition: conditionRefSchema.optional(),
  expect: expectSchema.optional(),
  envelope: envelopeSchema.optional(),
  notes: z.string().optional(),
});

export const commandStepSchema = z.object({
  id: z.string().min(1).optional(),
  kind: z.literal("command"),
  name: z.string().min(1),
  args: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  timeoutS: z.number().positive().optional(),
  expect: expectSchema.optional(),
  envelope: envelopeSchema.optional(),
  notes: z.string().optional(),
});

/** How a wait step is named in a schema message, which is all the refinements can see of it. */
const waitName = (step: { id?: string }): string =>
  step.id === undefined ? "a wait step" : `the wait step ${JSON.stringify(step.id)}`;

/**
 * A wait ends one way or the other: after `seconds`, or when `until` reads true. Carrying both is
 * refused rather than resolved, because the two readings disagree by the whole of `seconds` — the
 * estimator would budget the number and the generated Java would emit a `WaitUntilCommand` and
 * ignore it.
 */
export const waitStepSchema = z
  .object({
    id: z.string().min(1).optional(),
    kind: z.literal("wait"),
    seconds: z.number().nonnegative().optional(),
    until: z.string().min(1).optional(),
    timeoutS: z.number().positive().optional(),
    envelope: envelopeSchema.optional(),
    notes: z.string().optional(),
  })
  .refine((step) => step.seconds !== undefined || step.until !== undefined, (step) => ({
    message: `${waitName(step)} needs either seconds or until`,
  }))
  .refine((step) => step.seconds === undefined || step.until === undefined, (step) => ({
    message: `${waitName(step)} has both seconds and until; a wait ends either after a time or on a condition, not both`,
  }));

/**
 * A planner-only transfer (format version 4): the author telling the ledger that game pieces move
 * from one ledger location to another at this point in the routine, such as the alliance partner
 * scoring into the hive, or the human player entering pieces through the loading zone. Nothing on
 * the robot does it, so the robot runtime runs it as a wait of zero seconds and the Java generator
 * writes it as a comment only.
 *
 * `expectedCount` is what the auto is written for; `actualCount`, when present, is what the ledger
 * uses instead, so a team can preview "the partner did not tip" by setting it to 0 without touching
 * the routine's structure. Absent, it equals `expectedCount`. Location ids are the season plugin's
 * (`robot`, `partner`, a hive cell, a flower, a floor quadrant, a loading zone), and the
 * TRANSFER_LOCATION check reports one the plugin does not know.
 */
export const transferStepSchema = z.object({
  id: z.string().min(1).optional(),
  kind: z.literal("transfer"),
  from: z.string().min(1),
  to: z.string().min(1),
  expectedCount: z.number().int().nonnegative(),
  actualCount: z.number().int().nonnegative().optional(),
  notes: z.string().optional(),
});

export type PathStep = z.infer<typeof pathStepSchema>;
export type TransferStep = z.infer<typeof transferStepSchema>;
export type CommandStep = z.infer<typeof commandStepSchema>;
export type WaitStep = z.infer<typeof waitStepSchema>;

/** Written by hand because the type is recursive: sequence, parallel and branch steps hold steps. */
export interface SequenceStep {
  id?: string;
  kind: "sequence";
  /** Run one after another, exactly like the top-level list; the group ends when the last does. */
  steps: Step[];
  notes?: string;
}

export interface ParallelStep {
  id?: string;
  kind: "parallel";
  mode: "all" | "race" | "deadline";
  deadline?: string;
  steps: Step[];
  notes?: string;
}

export interface BranchStep {
  id?: string;
  kind: "branch";
  condition: string;
  then: Step[];
  else?: Step[];
  notes?: string;
}

export type Step =
  | PathStep
  | CommandStep
  | WaitStep
  | TransferStep
  | SequenceStep
  | ParallelStep
  | BranchStep;

/** The step kinds that hold other steps. */
export type GroupStep = SequenceStep | ParallelStep | BranchStep;

/** Every step kind, in the order the editor's insert menu lists them. */
export const STEP_KINDS = ["path", "command", "wait", "transfer", "sequence", "parallel", "branch"] as const;
export type StepKind = (typeof STEP_KINDS)[number];

/** The step kinds the robot never acts on: they exist for the planner's ledger alone. */
export const PLANNER_ONLY_STEP_KINDS = ["transfer"] as const;

/** The count a transfer step moves in the ledger: `actualCount`, which defaults to `expectedCount`. */
export const transferCount = (step: TransferStep): number => step.actualCount ?? step.expectedCount;

/**
 * The lists of steps a step holds, in document order: none for a leaf, one for a sequence or a
 * parallel group, `then` and (when present) `else` for a branch. Every walk over the step tree
 * goes through this and `withChildLists`, so a new group kind is one change here and not one in
 * every walker.
 */
export function childLists(step: Step): Step[][] {
  switch (step.kind) {
    case "sequence":
    case "parallel":
      return [step.steps];
    case "branch":
      return step.else === undefined ? [step.then] : [step.then, step.else];
    default:
      return [];
  }
}

/**
 * The same step with its child lists replaced, in the order `childLists` returned them. The
 * input is not mutated. A leaf is returned as it is.
 */
export function withChildLists(step: Step, lists: readonly Step[][]): Step {
  switch (step.kind) {
    case "sequence":
    case "parallel":
      return { ...step, steps: lists[0] ?? step.steps };
    case "branch": {
      const updated: BranchStep = { ...step, then: lists[0] ?? step.then };
      if (step.else !== undefined) updated.else = lists[1] ?? step.else;
      return updated;
    }
    default:
      return step;
  }
}

/** True for the step kinds that hold other steps. */
export const isGroupStep = (step: Step): step is GroupStep =>
  step.kind === "sequence" || step.kind === "parallel" || step.kind === "branch";

/**
 * A `sequence` runs its steps one after another and ends when the last one does (format version
 * 2). On its own at the top level it changes nothing; its point is inside a `parallel` group or a
 * branch arm, where it lets several steps act as one member, such as intake on, wait, intake off
 * running alongside a drive.
 */
export const sequenceStepSchema = z.object({
  id: z.string().min(1).optional(),
  kind: z.literal("sequence"),
  // At least one member, for the same reason as a parallel group.
  steps: z.array(z.lazy(() => stepSchema)).min(1),
  notes: z.string().optional(),
});

export const parallelStepSchema = z.object({
  id: z.string().min(1).optional(),
  kind: z.literal("parallel"),
  mode: z.enum(["all", "race", "deadline"]),
  deadline: z.string().min(1).optional(),
  // At least one member: an empty group has no meaning, and both the estimator and the generated
  // Java reach for a first member that would not be there.
  steps: z.array(z.lazy(() => stepSchema)).min(1),
  notes: z.string().optional(),
});

export const branchStepSchema = z.object({
  id: z.string().min(1).optional(),
  kind: z.literal("branch"),
  condition: z.string().min(1),
  then: z.array(z.lazy(() => stepSchema)),
  else: z.array(z.lazy(() => stepSchema)).optional(),
  notes: z.string().optional(),
});

export const stepSchema: z.ZodType<Step> = z.lazy(() =>
  z.union([
    pathStepSchema,
    commandStepSchema,
    waitStepSchema,
    transferStepSchema,
    sequenceStepSchema,
    parallelStepSchema,
    branchStepSchema,
  ]),
);

/**
 * `*.auto.json`: one routine. Steps run in sequence (site/docs/file-format.md).
 * Key declaration order is the canonical file order.
 */
export const autoSchema = z.object({
  $schema: schemaIdField("auto"),
  formatVersion: formatVersionFor("auto"),
  name: z.string().min(1),
  title: z.string().optional(),
  description: z.string().optional(),
  robot: z.string().min(1).optional(),
  field: z.string().min(1).optional(),
  alliance: z.enum(["RED", "BLUE"]),
  authors: z.array(z.string().min(1)).optional(),
  created: z.string().optional(),
  start: z.object({
    pose: z.union([z.object({ ref: z.string().min(1) }), poseSchema]),
    holds: z.record(z.string(), z.number()).optional(),
  }),
  steps: z.array(stepSchema).min(1),
});

export type LineSegment = z.infer<typeof lineSegmentSchema>;
export type BezierSegment = z.infer<typeof bezierSegmentSchema>;
export type Segment = z.infer<typeof segmentSchema>;
export type Heading = z.infer<typeof headingSchema>;
export type HeadingMode = Heading["mode"];
export type RangeHeading = z.infer<typeof rangeHeadingSchema>;
export type HeadingRange = z.infer<typeof headingRangeSchema>;
export type MarkerAt = z.infer<typeof markerAtSchema>;
export type Marker = z.infer<typeof markerSchema>;
export type CommandCall = z.infer<typeof commandCallSchema>;
export type Expect = z.infer<typeof expectSchema>;
export type EnvelopePoint = z.infer<typeof envelopePointSchema>;
export type Envelope = z.infer<typeof envelopeSchema>;
export type RejoinPose = z.infer<typeof rejoinPoseSchema>;

/** The step kinds that may carry an `envelope`: the ones that run, as opposed to the groups. */
export const ENVELOPE_STEP_KINDS = ["path", "command", "wait"] as const;
export type Auto = z.infer<typeof autoSchema>;
