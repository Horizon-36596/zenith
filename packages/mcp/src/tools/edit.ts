import { existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  addMarker,
  addSegment,
  addStep,
  insertStepAfter,
  moveStep,
  newAutoFromTemplate,
  removeMarker,
  removeSegment,
  removeStep,
  renameStep,
  repairContinuity,
  setCommandArgs,
  setHeadingMode,
  setMarkerAt,
  setMeta,
  setPose,
  setSpeed,
  setStart,
  setTimeout as setStepTimeout,
  unwrapStep,
  wrapStepsWithId,
  type IntoGroup,
} from "@horizon36596/zenith-core";
import type { Auto, CommandCall, Heading, Marker, MarkerAt, Segment, Step } from "@horizon36596/zenith-schema";
import { z } from "zod";
import { loadCurrent, writeEditResult } from "../editIo.js";
import { relativeToRoot, resolveAutoPath, resolveProject } from "../project.js";
import { guarded } from "../result.js";
import {
  autoMetaSchema,
  autoRefField,
  intoGroupSchema,
  commandArgsSchema,
  headingSchema,
  markerAtSchema,
  markerSchema,
  poseInputSchema,
  poseTargetSchema,
  projectField,
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
        "assigned one automatically — read the response's auto.steps to see it. To add a path in the " +
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
        "deadline names the old id, the deadline is updated to the new id too.",
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
        "robot is, or null. Offer zenith.edit.repairContinuity on it.",
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
        '"current") or one Bezier control point.',
      inputSchema: {
        auto: autoRefField,
        stepId: stepIdField,
        target: poseTargetSchema,
        pose: poseInputSchema,
        project: projectField,
      },
    },
    guarded(({ auto, stepId, target, pose, project }) => {
      const proj = resolveProject(project);
      const { path, auto: current } = loadCurrent(proj, auto);
      const updated = setPose(current, stepId, target, pose);
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
