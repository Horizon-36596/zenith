import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  addEnvelopeCorner,
  addMarker,
  addSegment,
  addStep,
  appendPath,
  insertStepAfter,
  joinAt,
  joinSteps,
  moveStep,
  newAutoFromTemplate,
  removeEnvelopeCorner,
  removeMarker,
  removePath,
  removeSegment,
  removeStep,
  renameStep,
  repairContinuity,
  setCommandArgs,
  setEnvelope,
  setEnvelopeCorner,
  setHeadingMode,
  setMarkerAt,
  setMeta,
  setPose,
  setRejoinFrom,
  setRoute,
  setSpeed,
  setStart,
  setTimeout as setStepTimeout,
  stepAfter,
  unwrapStep,
  wrapStepsWithId,
  type ChainEdit,
  type IntoGroup,
} from "@horizon36596/zenith-core";
import type {
  Auto,
  CommandCall,
  Envelope,
  EnvelopePoint,
  Heading,
  Marker,
  MarkerAt,
  RejoinPose,
  Segment,
  Step,
} from "@horizon36596/zenith-schema";
import { z } from "zod";
import { loadCurrent, writeEditResult } from "../editIo.js";
import { robotAndFieldFor } from "../findings.js";
import { relativeToRoot, resolveAutoPath, resolveProject, type Project } from "../project.js";
import { guarded } from "../result.js";
import {
  autoMetaSchema,
  autoRefField,
  intoGroupSchema,
  commandArgsSchema,
  envelopePointSchema,
  envelopeSchema,
  headingSchema,
  markerAtSchema,
  markerSchema,
  poseInputSchema,
  poseTargetSchema,
  projectField,
  rejoinPoseSchema,
  segmentSchema,
  startInputSchema,
  stepInputSchema,
} from "../schemas.js";

/**
 * `zenith.edit.*`: one tool per structural edit primitive in `packages/core/src/edit/`. Every one
 * reads the current file, applies the primitive, writes the canonical result back, and returns the
 * same shape `zenith.validate` does — `written`, the new
 * `auto`, and its `findings` — so the calling agent sees the effect of the edit without a second
 * round trip.
 *
 * The input schemas here (`../schemas.js`) are a `zod` 4 mirror of `@horizon36596/zenith-schema`'s `zod` 3
 * definitions, so the two are structurally, not nominally, compatible; `cast` below is the single
 * place that bridges them, and every primitive still re-validates fully through `parseAuto` inside
 * `finish()` regardless.
 */
function cast<T>(value: unknown): T {
  return value as T;
}

const stepIdField = z.string().min(1).describe("A step's id, as shown by zenith.auto.read or a Finding.");

export function registerEditTools(server: McpServer): void {
  server.registerTool(
    "zenith.edit.addStep",
    {
      title: "Add a step",
      description:
        "Adds a step to the auto: after the step named afterId (searched anywhere in the tree, " +
        "including inside a sequence, parallel or branch group), into a group at an index (pass " +
        "into), or at the end of the top-level list when neither is given. A step given no id is " +
        "assigned one automatically — read the response's auto.steps to see it. A step given an id " +
        "follows the zenith.edit.renameStep rule (a letter, then letters, digits, _ or -, at most 64 " +
        "characters); any other id is refused with the reason. To add a path in the " +
        "middle that continues from the step before it, use zenith.edit.insertAfter instead.",
      inputSchema: {
        auto: autoRefField,
        step: stepInputSchema,
        afterId: z.string().min(1).optional(),
        into: intoGroupSchema.optional(),
        project: projectField,
      },
    },
    guarded(({ auto, step, afterId, into, project }) => {
      if (afterId !== undefined && into !== undefined) {
        throw new Error("zenith.edit.addStep takes afterId or into, not both.");
      }
      const proj = resolveProject(project);
      const { path, auto: current } = loadCurrent(proj, auto);
      const updated = addStep(current, cast<Step>(step), into === undefined ? afterId : cast<IntoGroup>(into));
      return writeEditResult(proj, path, updated);
    }),
  );

  server.registerTool(
    "zenith.edit.removeStep",
    {
      title: "Remove a step",
      description: "Removes the step named id, wherever it is in the tree.",
      inputSchema: { auto: autoRefField, id: stepIdField, project: projectField },
    },
    guarded(({ auto, id, project }) => {
      const proj = resolveProject(project);
      const { path, auto: current } = loadCurrent(proj, auto);
      return writeEditResult(proj, path, removeStep(current, id));
    }),
  );

  server.registerTool(
    "zenith.edit.moveStep",
    {
      title: "Move a step",
      description:
        "Moves the step named id to a new position: immediately after another step's id (pass " +
        "afterId, searched anywhere in the tree), into a sequence, parallel group or branch arm at an " +
        "index (pass into), or to a 0-based index in the top-level steps list (pass index; an " +
        "out-of-range index clamps, and the step is pulled out of any nested group it was in). Give " +
        "exactly one of afterId, into or index.",
      inputSchema: {
        auto: autoRefField,
        id: stepIdField,
        afterId: z.string().min(1).optional(),
        into: intoGroupSchema.optional(),
        index: z.number().int().nonnegative().optional(),
        project: projectField,
      },
    },
    guarded(({ auto, id, afterId, into, index, project }) => {
      const given = [afterId, into, index].filter((value) => value !== undefined).length;
      if (given !== 1) {
        throw new Error("zenith.edit.moveStep needs exactly one of afterId, into or index.");
      }
      const proj = resolveProject(project);
      const { path, auto: current } = loadCurrent(proj, auto);
      const target = afterId ?? (into === undefined ? (index as number) : cast<IntoGroup>(into));
      return writeEditResult(proj, path, moveStep(current, id, target));
    }),
  );

  server.registerTool(
    "zenith.edit.renameStep",
    {
      title: "Rename a step",
      description:
        "Gives the step named id a new explicit id. If it is a child of a parallel group whose " +
        "deadline names the old id, the deadline is updated to the new id too. The new id starts " +
        "with a letter and holds only letters, digits, _ and -, at most 64 characters, like a " +
        "waypoint name; any other id is refused with the reason. An old id outside that rule can be " +
        "renamed to one inside it.",
      inputSchema: { auto: autoRefField, id: stepIdField, newId: z.string().min(1), project: projectField },
    },
    guarded(({ auto, id, newId, project }) => {
      const proj = resolveProject(project);
      const { path, auto: current } = loadCurrent(proj, auto);
      return writeEditResult(proj, path, renameStep(current, id, newId));
    }),
  );

  server.registerTool(
    "zenith.edit.wrap",
    {
      title: "Wrap steps in a group",
      description:
        "Wraps the steps named by ids in a new sequence (kind sequence: they run one after another " +
        "as one member) or parallel group (kind parallel, with mode all, race or deadline; a " +
        "deadline group's deadline is its first member that drives). The steps must be siblings in " +
        "one list and form one unbroken run. Every step keeps the id it had; the new group's id is " +
        "returned as groupId.",
      inputSchema: {
        auto: autoRefField,
        ids: z.array(z.string().min(1)).min(1),
        kind: z.enum(["sequence", "parallel"]),
        mode: z.enum(["all", "race", "deadline"]).optional().describe("Only for kind parallel; all when omitted."),
        project: projectField,
      },
    },
    guarded(({ auto, ids, kind, mode, project }) => {
      const proj = resolveProject(project);
      const { path, auto: current } = loadCurrent(proj, auto);
      const wrapped = wrapStepsWithId(current, ids, kind, mode);
      return writeEditResult(proj, path, wrapped.auto, { groupId: wrapped.id });
    }),
  );

  server.registerTool(
    "zenith.edit.unwrap",
    {
      title: "Unwrap a group",
      description:
        "Replaces the sequence or parallel group named id with its members, in place. The members " +
        "keep their ids; if the group was the deadline of the group around it, that role passes to " +
        "the member that decided when it ended. A branch cannot be unwrapped.",
      inputSchema: { auto: autoRefField, id: stepIdField, project: projectField },
    },
    guarded(({ auto, id, project }) => {
      const proj = resolveProject(project);
      const { path, auto: current } = loadCurrent(proj, auto);
      return writeEditResult(proj, path, unwrapStep(current, id));
    }),
  );

  server.registerTool(
    "zenith.edit.insertAfter",
    {
      title: "Insert a step in the middle",
      description:
        "Inserts step right after afterId and, when it is a path, starts it where that step ends " +
        "(from current, or the pose written out inside a parallel group). Returns id, the new step's " +
        "id, and continuityGapStepId: the following path step that now starts away from where the " +
        "robot is, or null. Offer zenith.edit.repairContinuity on it. A step given an id follows the " +
        "zenith.edit.renameStep rule; any other id is refused with the reason.",
      inputSchema: {
        auto: autoRefField,
        afterId: stepIdField,
        step: stepInputSchema,
        project: projectField,
      },
    },
    guarded(({ auto, afterId, step, project }) => {
      const proj = resolveProject(project);
      const { path, auto: current } = loadCurrent(proj, auto);
      const inserted = insertStepAfter(current, afterId, cast<Step>(step), proj.waypoints);
      return writeEditResult(proj, path, inserted.auto, {
        id: inserted.id,
        continuityGapStepId: inserted.continuityGapStepId,
        continuityGapIn: inserted.continuityGapIn,
      });
    }),
  );

  server.registerTool(
    "zenith.edit.repairContinuity",
    {
      title: "Start a path where the robot is",
      description:
        "Sets the first segment of the path step stepId to start from current, wherever the robot " +
        "is when the step begins. This clears the CONTINUITY gap zenith.edit.insertAfter reports, " +
        "and any other gap between that step and the one before it.",
      inputSchema: { auto: autoRefField, stepId: stepIdField, project: projectField },
    },
    guarded(({ auto, stepId, project }) => {
      const proj = resolveProject(project);
      const { path, auto: current } = loadCurrent(proj, auto);
      return writeEditResult(proj, path, repairContinuity(current, stepId));
    }),
  );

  server.registerTool(
    "zenith.edit.setPose",
    {
      title: "Set a segment endpoint or control point",
      description:
        "Sets one point of one segment of a path step to a literal pose: a segment endpoint " +
        '("from" or "to", replacing whatever was there — an inline pose, a waypoint ref, or ' +
        '"current") or one Bezier control point. A control point is written without a heading, ' +
        "which the runtime ignores. With joint true, a point where two segments of the path meet " +
        "moves as one point, as it does in the editor: the other end of the joint (the next " +
        "segment's from, or the previous segment's to) gets the same pose, so no CONTINUITY gap opens.",
      inputSchema: {
        auto: autoRefField,
        stepId: stepIdField,
        target: poseTargetSchema,
        pose: poseInputSchema,
        joint: z.boolean().optional(),
        project: projectField,
      },
    },
    guarded(({ auto, stepId, target, pose, joint, project }) => {
      const proj = resolveProject(project);
      const { path, auto: current } = loadCurrent(proj, auto);
      const updated = setPose(current, stepId, target, pose, { joint: joint === true, waypoints: proj.waypoints });
      return writeEditResult(proj, path, updated);
    }),
  );

  server.registerTool(
    "zenith.edit.setHeadingMode",
    {
      title: "Set a path step's heading mode",
      description:
        "Replaces a path step's heading mode outright: tangent, tangentReversed, constant, linear, facePoint, or piecewise. The editor labels them by Pedro Pathing's names (Tangent, Reverse tangent, Constant, Linear, Facing point, Piecewise), which the runtime compiles to path.tangent(), path.reverseTangent(), path.constant(heading), path.linear(start, end), path.facingPoint(point) and Interpolator.piecewise().until(t, ...). A piecewise heading lists ranges over t 0 to 1 (arc-length fractions of the path), each with its own non-piecewise mode; they must start at 0, meet end to start with no gap or overlap, and end at 1, or validate reports HEADING_RANGES.",
      inputSchema: { auto: autoRefField, stepId: stepIdField, heading: headingSchema, project: projectField },
    },
    guarded(({ auto, stepId, heading, project }) => {
      const proj = resolveProject(project);
      const { path, auto: current } = loadCurrent(proj, auto);
      return writeEditResult(proj, path, setHeadingMode(current, stepId, cast<Heading>(heading)));
    }),
  );

  server.registerTool(
    "zenith.edit.setRoute",
    {
      title: "Set a path step's route",
      description:
        "Replaces a path step's segments and heading together and nothing else: markers, endCondition, timeoutS, speedFraction, envelope, expect, notes and rejoinFrom are kept as written. The new route must keep both ends of the step exactly: its first segment's from must equal the step's first from, and its last segment's to must equal the step's last to, each as written (a \"current\" stays \"current\", a ref stays that ref). A route that moves an end is refused with a message that names both, and nothing is written. This is how a route from zenith.optimize is applied: pass the result's step.segments and step.heading. Every later step that starts from \"current\" starts where it did.",
      inputSchema: {
        auto: autoRefField,
        stepId: stepIdField,
        segments: z.array(segmentSchema).min(1).describe("The new route, in order. At least one segment."),
        heading: headingSchema,
        project: projectField,
      },
    },
    guarded(({ auto, stepId, segments, heading, project }) => {
      const proj = resolveProject(project);
      const { path, auto: current } = loadCurrent(proj, auto);
      return writeEditResult(proj, path, setRoute(current, stepId, cast<Segment[]>(segments), cast<Heading>(heading)));
    }),
  );

  server.registerTool(
    "zenith.edit.setSpeed",
    {
      title: "Set a path step's speed fraction",
      description: "Sets a path step's speedFraction (greater than 0, at most 1).",
      inputSchema: {
        auto: autoRefField,
        stepId: stepIdField,
        fraction: z.number().positive().max(1),
        project: projectField,
      },
    },
    guarded(({ auto, stepId, fraction, project }) => {
      const proj = resolveProject(project);
      const { path, auto: current } = loadCurrent(proj, auto);
      return writeEditResult(proj, path, setSpeed(current, stepId, fraction));
    }),
  );

  server.registerTool(
    "zenith.edit.addSegment",
    {
      title: "Add a segment to a path step",
      description:
        "Appends a segment to a path step's segments. A path's segments must stay continuous; " +
        "zenith.validate (and this tool's returned findings) reports CONTINUITY if they do not.",
      inputSchema: { auto: autoRefField, stepId: stepIdField, segment: segmentSchema, project: projectField },
    },
    guarded(({ auto, stepId, segment, project }) => {
      const proj = resolveProject(project);
      const { path, auto: current } = loadCurrent(proj, auto);
      return writeEditResult(proj, path, addSegment(current, stepId, cast<Segment>(segment)));
    }),
  );

  server.registerTool(
    "zenith.edit.removeSegment",
    {
      title: "Remove a segment from a path step",
      description: "Removes the segment at segmentIndex from a path step. A path step needs at least one segment.",
      inputSchema: {
        auto: autoRefField,
        stepId: stepIdField,
        segmentIndex: z.number().int().nonnegative(),
        project: projectField,
      },
    },
    guarded(({ auto, stepId, segmentIndex, project }) => {
      const proj = resolveProject(project);
      const { path, auto: current } = loadCurrent(proj, auto);
      return writeEditResult(proj, path, removeSegment(current, stepId, segmentIndex));
    }),
  );

  // The path chain edits of issue #185: each keeps the chain joined, and its markers and piecewise
  // ranges keep their distance along the part that did not change. The result says what moved.
  const chainResult = (proj: Project, path: string, edit: ChainEdit) =>
    writeEditResult(proj, path, edit.auto, {
      movedMarkers: edit.movedMarkers,
      movedRanges: edit.movedRanges,
      droppedWaypoints: edit.droppedWaypoints,
    });

  server.registerTool(
    "zenith.edit.appendSegment",
    {
      title: "Add a segment to the end of a path step, joined",
      description:
        'Adds a straight segment to the end of a path step that starts from "current" (the end of ' +
        "the segment before it, so the joint cannot tear) and runs 24 in along the way the robot " +
        "faces there, cut short so the footprint stays on the field. Markers and piecewise heading " +
        "ranges keep their distance from the step's start: their t is rescaled, and movedMarkers and " +
        "movedRanges say how many moved. Use zenith.edit.setPose afterwards to put the new end where it belongs.",
      inputSchema: { auto: autoRefField, stepId: stepIdField, project: projectField },
    },
    guarded(({ auto, stepId, project }) => {
      const proj = resolveProject(project);
      const { path, auto: current } = loadCurrent(proj, auto);
      // The auto's own robot/field when it names one: the segment is cut to the field it runs on.
      const context = { waypoints: proj.waypoints, ...robotAndFieldFor(current, proj) };
      return chainResult(proj, path, appendPath(current, stepId, context));
    }),
  );

  server.registerTool(
    "zenith.edit.removeSegmentJoined",
    {
      title: "Remove a segment from a path step, keeping it joined",
      description:
        "Removes the segment at segmentIndex and keeps the path joined, unlike " +
        'zenith.edit.removeSegment: the segment after it starts from "current", or, when the first ' +
        "segment goes, from where the first one started. Markers and piecewise heading ranges keep " +
        "their distance along the unchanged part; droppedWaypoints names any waypoint the step no " +
        "longer follows. A path step needs at least one segment.",
      inputSchema: {
        auto: autoRefField,
        stepId: stepIdField,
        segmentIndex: z.number().int().nonnegative(),
        project: projectField,
      },
    },
    guarded(({ auto, stepId, segmentIndex, project }) => {
      const proj = resolveProject(project);
      const { path, auto: current } = loadCurrent(proj, auto);
      return chainResult(proj, path, removePath(current, stepId, segmentIndex, { waypoints: proj.waypoints }));
    }),
  );

  server.registerTool(
    "zenith.edit.joinSegmentsAt",
    {
      title: "Join the two segments that meet at a point",
      description:
        "Merges the two segments of a path step that meet at point nodeIndex into one: point 0 is " +
        "where the step starts and point n where its n-th segment ends, so nodeIndex 1 joins " +
        "segments 0 and 1. Two lines stay a line; otherwise the result is a Bezier that keeps the " +
        "outer control points, at most three. Markers and piecewise heading ranges keep their distance " +
        "along the unchanged part; droppedWaypoints names any waypoint the step no longer follows.",
      inputSchema: {
        auto: autoRefField,
        stepId: stepIdField,
        nodeIndex: z.number().int().positive(),
        project: projectField,
      },
    },
    guarded(({ auto, stepId, nodeIndex, project }) => {
      const proj = resolveProject(project);
      const { path, auto: current } = loadCurrent(proj, auto);
      return chainResult(proj, path, joinAt(current, stepId, nodeIndex, { waypoints: proj.waypoints }));
    }),
  );

  server.registerTool(
    "zenith.edit.joinSteps",
    {
      title: "Join a path step with the next one into one chain",
      description:
        "Joins the path step nextStepId (by default the step straight after stepId) onto the end of " +
        "stepId, as one path step whose segments are the first's followed by the second's; the " +
        'second\'s first segment starts from "current". Two different headings become a piecewise ' +
        "heading with one range per old step, split at the joint; a piecewise one keeps its ranges, " +
        "rescaled into its part. Markers keep their distance along their own step. Refused, with the " +
        "reason, when the two are not path steps one after the other, when the second starts away " +
        "from where the first ends, or when they differ in speedFraction, endCondition or timeoutS.",
      inputSchema: {
        auto: autoRefField,
        stepId: stepIdField,
        nextStepId: z.string().min(1).optional(),
        project: projectField,
      },
    },
    guarded(({ auto, stepId, nextStepId, project }) => {
      const proj = resolveProject(project);
      const { path, auto: current } = loadCurrent(proj, auto);
      const second = nextStepId ?? stepAfter(current, stepId);
      if (second === null) throw new Error(`Nothing comes after ${stepId} in its list, so there is no path to join it with.`);
      return chainResult(proj, path, joinSteps(current, stepId, second, { waypoints: proj.waypoints }));
    }),
  );

  server.registerTool(
    "zenith.edit.addMarker",
    {
      title: "Add a marker to a path step",
      description: "Adds a marker (a command that fires in parallel with the path, at a point or a distance) to a path step.",
      inputSchema: { auto: autoRefField, stepId: stepIdField, marker: markerSchema, project: projectField },
    },
    guarded(({ auto, stepId, marker, project }) => {
      const proj = resolveProject(project);
      const { path, auto: current } = loadCurrent(proj, auto);
      return writeEditResult(proj, path, addMarker(current, stepId, cast<Marker>(marker)));
    }),
  );

  server.registerTool(
    "zenith.edit.removeMarker",
    {
      title: "Remove a marker from a path step",
      description: "Removes the marker at markerIndex from a path step.",
      inputSchema: {
        auto: autoRefField,
        stepId: stepIdField,
        markerIndex: z.number().int().nonnegative(),
        project: projectField,
      },
    },
    guarded(({ auto, stepId, markerIndex, project }) => {
      const proj = resolveProject(project);
      const { path, auto: current } = loadCurrent(proj, auto);
      return writeEditResult(proj, path, removeMarker(current, stepId, markerIndex));
    }),
  );

  server.registerTool(
    "zenith.edit.setMarkerAt",
    {
      title: "Move a marker",
      description: "Changes where along the path the marker at markerIndex fires: a path parameter t, a distance, or a distance from the end.",
      inputSchema: {
        auto: autoRefField,
        stepId: stepIdField,
        markerIndex: z.number().int().nonnegative(),
        at: markerAtSchema,
        project: projectField,
      },
    },
    guarded(({ auto, stepId, markerIndex, at, project }) => {
      const proj = resolveProject(project);
      const { path, auto: current } = loadCurrent(proj, auto);
      const updated = setMarkerAt(current, stepId, markerIndex, cast<MarkerAt>(at));
      return writeEditResult(proj, path, updated);
    }),
  );

  server.registerTool(
    "zenith.edit.setCommandArgs",
    {
      title: "Set a command step's arguments",
      description: "Replaces a command step's args outright. Omit args to clear them.",
      inputSchema: {
        auto: autoRefField,
        stepId: stepIdField,
        args: commandArgsSchema.optional(),
        project: projectField,
      },
    },
    guarded(({ auto, stepId, args, project }) => {
      const proj = resolveProject(project);
      const { path, auto: current } = loadCurrent(proj, auto);
      const updated = setCommandArgs(current, stepId, cast<CommandCall["args"]>(args));
      return writeEditResult(proj, path, updated);
    }),
  );

  server.registerTool(
    "zenith.edit.setTimeout",
    {
      title: "Set or clear a step's timeout",
      description: "Sets timeoutS on a path, command or wait step; omit timeoutS to clear it. Other step kinds have no timeout.",
      inputSchema: {
        auto: autoRefField,
        stepId: stepIdField,
        timeoutS: z.number().positive().optional(),
        project: projectField,
      },
    },
    guarded(({ auto, stepId, timeoutS, project }) => {
      const proj = resolveProject(project);
      const { path, auto: current } = loadCurrent(proj, auto);
      return writeEditResult(proj, path, setStepTimeout(current, stepId, timeoutS));
    }),
  );

  server.registerTool(
    "zenith.edit.setEnvelope",
    {
      title: "Set or remove a step's envelope",
      description:
        "Gives a path, command or wait step a planner-only envelope, replacing any it had: while the step " +
        "runs, for at most maxDurationS, the robot's bounding box is declared to stay inside polygon (3 to 32 " +
        "corners, in order round the outside, in field inches). A command or wait with no estimate of its own " +
        "is then timed by maxDurationS instead of being left unknown, or by actualDurationS, an optional what-if " +
        "at most maxDurationS, when it is set. provenance is required. Omit envelope, " +
        "or pass null, to remove it. A sequence, parallel group or branch cannot carry one. The runtime " +
        "ignores envelopes. A polygon whose edges cross or fold back is written but reported as ENVELOPE_SHAPE.",
      inputSchema: {
        auto: autoRefField,
        stepId: stepIdField,
        envelope: envelopeSchema.nullable().optional(),
        project: projectField,
      },
    },
    guarded(({ auto, stepId, envelope, project }) => {
      const proj = resolveProject(project);
      const { path, auto: current } = loadCurrent(proj, auto);
      return writeEditResult(proj, path, setEnvelope(current, stepId, cast<Envelope | null>(envelope ?? null)));
    }),
  );

  server.registerTool(
    "zenith.edit.setEnvelopeCorner",
    {
      title: "Move one corner of a step's envelope",
      description:
        "Moves the corner at cornerIndex (0-based) of the envelope on step stepId to corner, in field " +
        "inches. The step must already have an envelope (zenith.edit.setEnvelope).",
      inputSchema: {
        auto: autoRefField,
        stepId: stepIdField,
        cornerIndex: z.number().int().nonnegative(),
        corner: envelopePointSchema,
        project: projectField,
      },
    },
    guarded(({ auto, stepId, cornerIndex, corner, project }) => {
      const proj = resolveProject(project);
      const { path, auto: current } = loadCurrent(proj, auto);
      const updated = setEnvelopeCorner(current, stepId, cornerIndex, cast<EnvelopePoint>(corner));
      return writeEditResult(proj, path, updated);
    }),
  );

  server.registerTool(
    "zenith.edit.addEnvelopeCorner",
    {
      title: "Add a corner to a step's envelope",
      description:
        "Adds a corner to the envelope on step stepId at the middle of the edge that leaves the corner at " +
        "afterIndex (0-based; the last corner's edge runs back to the first), so the shape does not change " +
        "until the new corner is moved with zenith.edit.setEnvelopeCorner. The new corner's index is " +
        "afterIndex + 1. An envelope has at most 32 corners.",
      inputSchema: {
        auto: autoRefField,
        stepId: stepIdField,
        afterIndex: z.number().int().nonnegative(),
        project: projectField,
      },
    },
    guarded(({ auto, stepId, afterIndex, project }) => {
      const proj = resolveProject(project);
      const { path, auto: current } = loadCurrent(proj, auto);
      return writeEditResult(proj, path, addEnvelopeCorner(current, stepId, afterIndex));
    }),
  );

  server.registerTool(
    "zenith.edit.removeEnvelopeCorner",
    {
      title: "Remove a corner from a step's envelope",
      description:
        "Removes the corner at cornerIndex (0-based) from the envelope on step stepId. An envelope keeps " +
        "at least three corners; to remove the whole envelope, use zenith.edit.setEnvelope with no envelope.",
      inputSchema: {
        auto: autoRefField,
        stepId: stepIdField,
        cornerIndex: z.number().int().nonnegative(),
        project: projectField,
      },
    },
    guarded(({ auto, stepId, cornerIndex, project }) => {
      const proj = resolveProject(project);
      const { path, auto: current } = loadCurrent(proj, auto);
      return writeEditResult(proj, path, removeEnvelopeCorner(current, stepId, cornerIndex));
    }),
  );

  server.registerTool(
    "zenith.edit.setRejoinFrom",
    {
      title: "Set or clear a path's rejoin pose",
      description:
        'Sets rejoinFrom on a path step whose first segment starts from "current": the pose the planner ' +
        "assumes the robot is at when the step right before the path is a command robot.json marks " +
        "movesRobot, or a sequence ending in one, so the path can be drawn and timed. Anywhere else it is " +
        "not used and validate reports a MOVES_ROBOT warning. On the robot, current is always the " +
        "follower's pose, so the runtime ignores it. Omit pose, or pass null, to clear it. A path that " +
        "starts from a fixed pose is refused.",
      inputSchema: {
        auto: autoRefField,
        stepId: stepIdField,
        pose: rejoinPoseSchema.nullable().optional(),
        project: projectField,
      },
    },
    guarded(({ auto, stepId, pose, project }) => {
      const proj = resolveProject(project);
      const { path, auto: current } = loadCurrent(proj, auto);
      return writeEditResult(proj, path, setRejoinFrom(current, stepId, cast<RejoinPose | null>(pose ?? null)));
    }),
  );

  server.registerTool(
    "zenith.edit.setStart",
    {
      title: "Set the auto's start pose",
      description: "Replaces the auto's start (pose and what it holds) outright.",
      inputSchema: { auto: autoRefField, start: startInputSchema, project: projectField },
    },
    guarded(({ auto, start, project }) => {
      const proj = resolveProject(project);
      const { path, auto: current } = loadCurrent(proj, auto);
      return writeEditResult(proj, path, setStart(current, cast<Auto["start"]>(start)));
    }),
  );

  server.registerTool(
    "zenith.edit.setMeta",
    {
      title: "Set the auto's title, description or authors",
      description:
        "Merges title, description and authors into the auto. A field left out of meta is " +
        "unchanged; a field given as null is cleared.",
      inputSchema: { auto: autoRefField, meta: autoMetaSchema, project: projectField },
    },
    guarded(({ auto, meta, project }) => {
      const proj = resolveProject(project);
      const { path, auto: current } = loadCurrent(proj, auto);
      const patch: { title?: string; description?: string; authors?: string[] } = {};
      if (Object.hasOwn(meta, "title")) patch.title = meta.title ?? undefined;
      if (Object.hasOwn(meta, "description")) patch.description = meta.description ?? undefined;
      if (Object.hasOwn(meta, "authors")) patch.authors = meta.authors ?? undefined;
      return writeEditResult(proj, path, setMeta(current, patch));
    }),
  );

  server.registerTool(
    "zenith.edit.newAutoFromTemplate",
    {
      title: "Create a new auto from a template",
      description:
        "Creates <autosDir>/<name>.auto.json with the given alliance and start pose, and one " +
        "placeholder leg so the file validates immediately. The start pose is in the given alliance's " +
        "own frame: a BLUE auto's poses are where the robot drives as BLUE. Fails if the file " +
        "already exists unless " +
        "force is true.",
      inputSchema: {
        name: z.string().min(1),
        alliance: z.enum(["RED", "BLUE"]),
        start: startInputSchema,
        robotPath: z.string().min(1).optional(),
        fieldPath: z.string().min(1).optional(),
        force: z.boolean().optional(),
        project: projectField,
      },
    },
    guarded(({ name, alliance, start, robotPath, fieldPath, force, project }) => {
      const proj = resolveProject(project);
      const path = resolveAutoPath(proj, name);
      if (existsSync(path) && force !== true) {
        throw new Error(`${relativeToRoot(proj, path)} already exists. Pass force: true to overwrite it.`);
      }
      const created = newAutoFromTemplate(name, {
        alliance,
        start: cast<Auto["start"]>(start),
        robotPath,
        fieldPath,
      });
      return writeEditResult(proj, path, created);
    }),
  );
}
