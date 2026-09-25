import { z } from "zod";

/**
 * JSON Schema input shapes for the `zenith.edit.*` tools, mirroring `packages/schema/src/auto.ts`
 * structurally so an MCP client can see exactly what a step, segment or marker looks like.
 *
 * These are written by hand against `zod` (the MCP SDK's peer version) rather than imported from
 * `@horizon36596/zenith-schema` (which pins `zod` 3): the two packages can carry different major versions of
 * `zod` side by side, but their schema objects are not interchangeable. The edit primitives in
 * `@horizon36596/zenith-core` are the actual source of truth — every `zenith.edit.*` call still round-trips
 * through `parseAuto` inside `finish()` (`packages/core/src/edit/finish.ts`), so a shape that
 * slips past this file is still caught there with a precise `EditError`. `steps` inside a
 * `parallel` or `branch` step are typed loosely (`z.unknown()`) rather than recursively for the
 * same reason: the recursion is finitely enforced downstream, not lost.
 */

export const poseInputSchema = z
  .object({
    xIn: z.number(),
    yIn: z.number(),
    headingRad: z.number().optional(),
    provenance: z.string().optional(),
  })
  .describe(
    "A literal pose in the field frame of the auto's own alliance (its `alliance`), where the robot " +
      "drives it when running as that alliance: inches and radians.",
  );

export const poseRefSchema = z
  .object({ ref: z.string().min(1) })
  .describe("A named pose from waypoints.json.");

export const poseSourceSchema = z
  .union([z.literal("current"), poseRefSchema, poseInputSchema])
  .describe(
    'Where a segment starts or ends: "current" (the previous step\'s end pose), a waypoint ref, or a literal pose.',
  );

export const lineSegmentSchema = z.object({
  kind: z.literal("line"),
  from: poseSourceSchema,
  to: poseSourceSchema,
});

export const bezierSegmentSchema = z.object({
  kind: z.literal("bezier"),
  from: poseSourceSchema,
  control: z.array(poseInputSchema).min(1).max(3).describe("One to three Bezier control points."),
  to: poseSourceSchema,
});

export const segmentSchema = z
  .discriminatedUnion("kind", [lineSegmentSchema, bezierSegmentSchema])
  .describe("A line or a Bezier segment of a path step.");

const rangeHeadingModes = [
  z.object({ mode: z.literal("tangent") }),
  z.object({ mode: z.literal("tangentReversed") }),
  z.object({ mode: z.literal("constant"), headingRad: z.number() }),
  z.object({ mode: z.literal("linear"), fromRad: z.number(), toRad: z.number() }),
  z.object({
    mode: z.literal("facePoint"),
    xIn: z.number(),
    yIn: z.number(),
    offsetRad: z.number().optional(),
  }),
] as const;

export const headingRangeSchema = z
  .object({
    startT: z.number().min(0).max(1),
    endT: z.number().min(0).max(1),
    heading: z.discriminatedUnion("mode", [...rangeHeadingModes]),
  })
  .describe("One range of a piecewise heading: from startT to endT (fractions of the path) the robot uses this heading.");

export const headingSchema = z
  .discriminatedUnion("mode", [
    ...rangeHeadingModes,
    z.object({
      mode: z.literal("piecewise"),
      ranges: z
        .array(headingRangeSchema)
        .min(1)
        .describe("In order, the first starting at 0, each starting where the one before ends, the last ending at 1."),
    }),
  ])
  .describe("One of the six heading modes of the file format (https://libraries.horizon36596.org/zenith/file-format/).");

export const commandArgsSchema = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
  .describe("Named-command arguments, keyed by the param names robot.json declares.");

export const commandCallSchema = z.object({
  name: z.string().min(1).describe("A command name registered in robot.json's commands[]."),
  args: commandArgsSchema.optional(),
});

export const markerAtSchema = z
  .union([
    z.object({ t: z.number().min(0).max(1) }),
    z.object({ distanceIn: z.number().nonnegative() }),
    z.object({ distanceFromEndIn: z.number().nonnegative() }),
  ])
  .describe("Where along the path a marker fires: a path parameter t, or a distance.");

export const markerSchema = z.object({ at: markerAtSchema, command: commandCallSchema });

export const expectSchema = z.object({
  collectFrom: z.string().min(1).optional(),
  count: z.number().optional(),
  launchesInto: z.string().min(1).optional(),
  tip: z.enum(["own", "opponent"]).optional(),
});

export const pathStepInputSchema = z.object({
  id: z.string().min(1).optional().describe("Omit to get an id assigned automatically."),
  kind: z.literal("path"),
  timeoutS: z.number().positive().optional(),
  segments: z.array(segmentSchema).min(1),
  heading: headingSchema.optional(),
  speedFraction: z.number().positive().max(1).optional(),
  markers: z.array(markerSchema).optional(),
  endCondition: z.object({ condition: z.string().min(1) }).optional(),
  expect: expectSchema.optional(),
  notes: z.string().optional(),
});

export const commandStepInputSchema = z.object({
  id: z.string().min(1).optional(),
  kind: z.literal("command"),
  name: z.string().min(1),
  args: commandArgsSchema.optional(),
  timeoutS: z.number().positive().optional(),
  expect: expectSchema.optional(),
  notes: z.string().optional(),
});

export const waitStepInputSchema = z.object({
  id: z.string().min(1).optional(),
  kind: z.literal("wait"),
  seconds: z.number().nonnegative().optional(),
  until: z.string().min(1).optional(),
  timeoutS: z.number().positive().optional(),
  notes: z.string().optional(),
});

export const sequenceStepInputSchema = z.object({
  id: z.string().min(1).optional(),
  kind: z.literal("sequence"),
  steps: z
    .array(z.unknown())
    .describe("Nested steps, run one after another: the same shapes as a top-level step. At least one."),
  notes: z.string().optional(),
});

export const parallelStepInputSchema = z.object({
  id: z.string().min(1).optional(),
  kind: z.literal("parallel"),
  mode: z.enum(["all", "race", "deadline"]),
  deadline: z.string().min(1).optional().describe("A child step's id; only meaningful for mode 'deadline'."),
  steps: z.array(z.unknown()).describe("Nested steps: the same shapes as a top-level step."),
  notes: z.string().optional(),
});

export const branchStepInputSchema = z.object({
  id: z.string().min(1).optional(),
  kind: z.literal("branch"),
  condition: z.string().min(1).describe("A condition name registered in robot.json's conditions[]."),
  then: z.array(z.unknown()),
  else: z.array(z.unknown()).optional(),
  notes: z.string().optional(),
});

export const stepInputSchema = z
  .discriminatedUnion("kind", [
    pathStepInputSchema,
    commandStepInputSchema,
    waitStepInputSchema,
    sequenceStepInputSchema,
    parallelStepInputSchema,
    branchStepInputSchema,
  ])
  .describe("One step: path, command, wait, sequence, parallel or branch (https://libraries.horizon36596.org/zenith/file-format/).");

export const intoGroupSchema = z
  .object({
    into: z.string().min(1).describe("The id of a sequence, parallel group or branch."),
    index: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("0-based position in the group's list; clamps; the end when omitted."),
    arm: z.enum(["then", "else"]).optional().describe("For a branch: which arm. then when omitted."),
  })
  .describe("A place inside a group, for putting a step at the front of one or into an empty arm.");

export const poseTargetSchema = z.object({
  segmentIndex: z.number().int().nonnegative(),
  pointKind: z.enum(["from", "to", "control"]),
  controlIndex: z.number().int().nonnegative().optional().describe('Required, and only used, when pointKind is "control".'),
});

export const startInputSchema = z.object({
  pose: poseSourceSchema,
  holds: z.record(z.string(), z.number()).optional(),
});

// JSON has no "leave this field alone but not that one" beyond key presence, and no `undefined` —
// so clearing a field over MCP is spelled `null` (translated to `undefined` before it reaches
// `setMeta`, whose own "explicit undefined clears it" contract is a TypeScript-only convenience).
// Omitting a key entirely leaves that field unchanged either way.
export const autoMetaSchema = z.object({
  title: z.string().nullable().optional().describe("Omit to leave unchanged; null clears it."),
  description: z.string().nullable().optional().describe("Omit to leave unchanged; null clears it."),
  authors: z.array(z.string().min(1)).nullable().optional().describe("Omit to leave unchanged; null clears it."),
});

export const autoRefField = z
  .string()
  .min(1)
  .describe(
    "The auto to operate on: a bare name (e.g. \"first-auto\", resolved against the project's autosDir), a path relative to the project root, or an absolute path.",
  );

export const projectField = z
  .string()
  .optional()
  .describe("The robot repo's directory (holding zenith.json). Defaults to the server's own working directory.");
