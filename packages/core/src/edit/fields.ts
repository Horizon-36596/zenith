import type {
  Auto,
  BranchStep,
  CommandCall,
  CommandStep,
  Envelope,
  EnvelopePoint,
  ParallelStep,
  PathStep,
  PoseSource,
  RejoinPose,
  Segment,
  Step,
  TransferStep,
  WaitStep,
} from "@horizon36596/zenith-schema";
import { EditError } from "./errors.js";
import { finish } from "./finish.js";
import { defaultDeadlineIndex } from "./groups.js";
import { childPrefix, effectiveId } from "./ids.js";
import { tidyPinnedIds } from "./rename.js";
import { updateStep } from "./tree.js";

/**
 * The field-level edits the inspector and an agent both need, on top of the structural primitives
 * next to them: pointing a segment endpoint at a waypoint, turning a line into a curve, and
 * setting the one field that makes a wait a wait or a branch a branch.
 *
 * `setPose` (`path.ts`) writes literal poses only, so the editor could not say "this endpoint is
 * the `shootNorth` waypoint" through core at all; these fill that gap. Same contract as every
 * other primitive here: never mutate the input, always `finish` the candidate, so an edit that
 * would leave the file invalid throws rather than being written.
 */

function asPathStep(step: Step, stepId: string): PathStep {
  if (step.kind !== "path") {
    throw new EditError(`Step ${JSON.stringify(stepId)} is a ${step.kind} step, not a path.`);
  }
  return step;
}

/** Applies `edit` to the step with this effective id, or throws naming the id that is not there. */
function editStep(auto: Auto, stepId: string, edit: (step: Step) => Step): Auto {
  const result = updateStep(auto.steps, "step", stepId, (step) => edit(step));
  if (!result.found) throw new EditError(`No step with id ${JSON.stringify(stepId)}.`);
  return finish({ ...auto, steps: result.steps });
}

/** The segment at this index, or a message naming the step that has no such segment. */
function segmentAt(step: PathStep, stepId: string, segmentIndex: number): Segment {
  const segment = step.segments[segmentIndex];
  if (segment === undefined) {
    throw new EditError(
      `Step ${JSON.stringify(stepId)} has no segment at index ${String(segmentIndex)}.`,
    );
  }
  return segment;
}

/**
 * Points a segment endpoint at a waypoint (`{ ref }`), at the previous step's end (`"current"`),
 * or at a literal pose. The one edit `setPose` cannot express.
 */
export function setSegmentSource(
  auto: Auto,
  stepId: string,
  segmentIndex: number,
  pointKind: "from" | "to",
  source: PoseSource,
): Auto {
  return editStep(auto, stepId, (step) => {
    const path = asPathStep(step, stepId);
    segmentAt(path, stepId, segmentIndex);
    const segments = path.segments.map((segment, index): Segment => {
      if (index !== segmentIndex) return segment;
      return pointKind === "from" ? { ...segment, from: source } : { ...segment, to: source };
    });
    return { ...path, segments };
  });
}

/**
 * Turns a segment into a line or a Bezier. Becoming a Bezier needs somewhere to put the new
 * control point, and core will not invent one (CLAUDE.md rule 4): the caller passes the point, with
 * its provenance, and becoming a line needs none. The editor passes the midpoint of the segment's
 * ends as the planner resolves them, `"current"` and waypoints included, so the new curve lies on
 * the line (`setSegmentKindAt` in `apps/web/src/app/edits.ts`).
 */
export function setSegmentKind(
  auto: Auto,
  stepId: string,
  segmentIndex: number,
  kind: Segment["kind"],
  control?: { xIn: number; yIn: number; provenance?: string },
): Auto {
  return editStep(auto, stepId, (step) => {
    const path = asPathStep(step, stepId);
    segmentAt(path, stepId, segmentIndex);
    const segments = path.segments.map((segment, index): Segment => {
      if (index !== segmentIndex || segment.kind === kind) return segment;
      if (kind === "line") return { kind: "line", from: segment.from, to: segment.to };
      if (control === undefined) {
        throw new EditError(
          `Segment ${String(segmentIndex + 1)} of ${JSON.stringify(stepId)} needs a control point to become a curve.`,
        );
      }
      return { kind: "bezier", from: segment.from, control: [{ ...control }], to: segment.to };
    });
    return { ...path, segments };
  });
}

/** Sets or clears a path step's end condition ("stop when the hopper is full"). */
export function setEndCondition(auto: Auto, stepId: string, condition: string | null): Auto {
  return editStep(auto, stepId, (step) => {
    const path = asPathStep(step, stepId);
    if (condition === null) {
      const next = { ...path };
      delete next.endCondition;
      return next;
    }
    return { ...path, endCondition: { condition } };
  });
}

/** Sets a step's note, or removes it when the text is blank. */
export function setNotes(auto: Auto, stepId: string, notes: string): Auto {
  return editStep(auto, stepId, (step) => {
    if (notes.trim() === "") {
      const next = { ...step } as Step & { notes?: string };
      delete next.notes;
      return next;
    }
    return { ...step, notes } as Step;
  });
}

/**
 * Sets what a wait step waits for: a number of seconds or a robot-side condition, exactly one of
 * the two. The schema refuses a wait with both or with neither, so this refuses them first, in
 * plain words. The key that is not given is removed, and the step's timeout stays as it was.
 */
export function setWait(
  auto: Auto,
  stepId: string,
  wait: { seconds?: number; until?: string },
): Auto {
  if (wait.seconds !== undefined && wait.until !== undefined) {
    throw new EditError("A wait waits for a number of seconds or for a condition, not both.");
  }
  if (wait.seconds === undefined && wait.until === undefined) {
    throw new EditError("A wait needs a number of seconds or a condition to wait for.");
  }
  return editStep(auto, stepId, (step) => {
    if (step.kind !== "wait") {
      throw new EditError(`Step ${JSON.stringify(stepId)} is a ${step.kind} step, not a wait.`);
    }
    const next: WaitStep = { ...step };
    delete next.seconds;
    delete next.until;
    if (wait.seconds !== undefined) next.seconds = wait.seconds;
    if (wait.until !== undefined) next.until = wait.until;
    return next;
  });
}

/**
 * Edits a planner-only transfer step: where the pieces come from and go to, how many the routine
 * expects, and how many the ledger should move instead. `actualCount: null` removes the actual
 * count, so the ledger moves the expected one again; an actual count equal to the expected one is
 * removed too, which keeps a file that has no edge case written into it free of the key. None of
 * it changes what the robot runs.
 */
export function setTransfer(
  auto: Auto,
  stepId: string,
  patch: { from?: string; to?: string; expectedCount?: number; actualCount?: number | null },
): Auto {
  return editStep(auto, stepId, (step) => {
    if (step.kind !== "transfer") {
      throw new EditError(`Step ${JSON.stringify(stepId)} is a ${step.kind} step, not a transfer.`);
    }
    const count = (value: number, what: string): number => {
      if (!Number.isInteger(value) || value < 0) {
        throw new EditError(`A transfer's ${what} is a whole number of pieces, 0 or more; ${String(value)} is not.`);
      }
      return value;
    };
    const next: TransferStep = { ...step };
    if (patch.from !== undefined) next.from = patch.from;
    if (patch.to !== undefined) next.to = patch.to;
    if (patch.expectedCount !== undefined) next.expectedCount = count(patch.expectedCount, "expected count");
    if (patch.actualCount === null) delete next.actualCount;
    else if (patch.actualCount !== undefined) next.actualCount = count(patch.actualCount, "actual count");
    if (next.actualCount === next.expectedCount) delete next.actualCount;
    return next;
  });
}

/** `"a"`, `"a" or "b"`, `"a", "b" or "c"`: the ids a message offers, quoted. */
function eitherOf(ids: readonly string[]): string {
  const quoted = ids.map((id) => JSON.stringify(id));
  return quoted.length <= 1 ? quoted.join("") : `${quoted.slice(0, -1).join(", ")} or ${quoted[quoted.length - 1] as string}`;
}

/**
 * Sets a parallel group's mode, and which of its own steps is its deadline. Only a group in
 * deadline mode has a deadline, so every result is a group the checks accept:
 *
 * - Switching to `all` or `race` removes the deadline, and naming a deadline for such a group is
 *   refused.
 * - Switching to `deadline` keeps a deadline the group already names among its own steps, or else
 *   picks its first member that drives, as `wrapSteps` does (`stepDrives`), or its first member when
 *   none does.
 * - A deadline that is empty, or names a step outside the group, is refused in plain words.
 *
 * A deadline member with no id of its own is given one, so the deadline names it in the file: the
 * id it already went by with the dot taken out (`grp.2` becomes `grp2`, `tidyPinnedIds`), since a
 * step's id holds only letters, digits, `_` and `-`.
 */
export function setParallel(
  auto: Auto,
  stepId: string,
  patch: { mode?: ParallelStep["mode"]; deadline?: string },
): Auto {
  const edited = editStep(auto, stepId, (step) => {
    if (step.kind !== "parallel") {
      throw new EditError(
        `Step ${JSON.stringify(stepId)} is a ${step.kind} step, not a parallel group.`,
      );
    }
    const mode = patch.mode ?? step.mode;
    if (mode !== "deadline") {
      if (patch.deadline !== undefined) {
        const runs = mode === "all" ? "waits for all of its steps" : "stops when the first of its steps ends";
        throw new EditError(
          `Group ${JSON.stringify(stepId)} ${runs}; only a group in deadline mode has a deadline.`,
        );
      }
      const next: ParallelStep = { ...step, mode };
      delete next.deadline;
      return next;
    }

    const prefix = childPrefix(stepId, 1, 0);
    const memberIds = step.steps.map((member, index) => effectiveId(member, index, prefix));
    let deadline: string | undefined;
    if (patch.deadline !== undefined) {
      if (patch.deadline.trim() === "") {
        throw new EditError(
          `A deadline group ends when one of its own steps ends, so its deadline has to name one: ${eitherOf(memberIds)}.`,
        );
      }
      if (!memberIds.includes(patch.deadline)) {
        throw new EditError(
          `${JSON.stringify(patch.deadline)} is not one of this group's own steps; its deadline has to name one: ${eitherOf(memberIds)}.`,
        );
      }
      deadline = patch.deadline;
    } else if (step.mode === "deadline" && step.deadline !== undefined && memberIds.includes(step.deadline)) {
      deadline = step.deadline;
    } else {
      deadline = memberIds[defaultDeadlineIndex(step.steps)];
    }
    if (deadline === undefined) {
      throw new EditError(`Group ${JSON.stringify(stepId)} has no steps, so none can be its deadline.`);
    }
    const at = memberIds.indexOf(deadline);
    const steps = step.steps.map((member, index) =>
      index === at && member.id === undefined ? { ...member, id: deadline } : member,
    );
    const next: ParallelStep = { ...step, mode, deadline, steps };
    return next;
  });
  return finish({ ...edited, steps: tidyPinnedIds(auto.steps, edited.steps) });
}

/** Sets the robot-side condition a branch step asks about. */
export function setBranchCondition(auto: Auto, stepId: string, condition: string): Auto {
  return editStep(auto, stepId, (step) => {
    if (step.kind !== "branch") {
      throw new EditError(`Step ${JSON.stringify(stepId)} is a ${step.kind} step, not a branch.`);
    }
    const next: BranchStep = { ...step, condition };
    return next;
  });
}

/**
 * Points a command step at a different registered command. The arguments go with the old name:
 * they were built from its parameters, and keeping them would silently pass one command's
 * arguments to another.
 */
export function setCommandName(auto: Auto, stepId: string, name: string): Auto {
  return editStep(auto, stepId, (step) => {
    if (step.kind !== "command") {
      throw new EditError(`Step ${JSON.stringify(stepId)} is a ${step.kind} step, not a command.`);
    }
    return { ...step, name, args: undefined };
  });
}

/** Replaces the command a marker fires, keeping where on the path it sits. */
export function setMarkerCommand(
  auto: Auto,
  stepId: string,
  markerIndex: number,
  command: CommandCall,
): Auto {
  return editStep(auto, stepId, (step) => {
    const path = asPathStep(step, stepId);
    const markers = path.markers ?? [];
    if (markers[markerIndex] === undefined) {
      throw new EditError(
        `Step ${JSON.stringify(stepId)} has no marker at index ${String(markerIndex)}.`,
      );
    }
    return {
      ...path,
      markers: markers.map((marker, index) =>
        index === markerIndex ? { ...marker, command } : marker,
      ),
    };
  });
}

/** The envelope a step carries, or an EditError naming why it cannot carry or does not have one. */
function envelopeStep(step: Step, stepId: string): PathStep | CommandStep | WaitStep {
  if (step.kind !== "path" && step.kind !== "command" && step.kind !== "wait") {
    throw new EditError(
      `Step ${JSON.stringify(stepId)} is a ${step.kind} group; only a path, command or wait step can carry an envelope.`,
    );
  }
  return step;
}

function existingEnvelope(step: PathStep | CommandStep | WaitStep, stepId: string): Envelope {
  if (step.envelope === undefined) {
    throw new EditError(`Step ${JSON.stringify(stepId)} has no envelope.`);
  }
  return step.envelope;
}

/**
 * Gives a path, command or wait step an envelope (spec 13 section 10), replacing any it had, or
 * removes it when `envelope` is null. The polygon, the window and the provenance are the caller's:
 * the editor offers a square round the step's start pose, and an agent names its own.
 */
export function setEnvelope(auto: Auto, stepId: string, envelope: Envelope | null): Auto {
  return editStep(auto, stepId, (step) => {
    const target = envelopeStep(step, stepId);
    if (envelope === null) {
      const next = { ...target };
      delete next.envelope;
      return next;
    }
    return { ...target, envelope };
  });
}

/**
 * Sets an envelope's window (`maxDurationS`) and its what-if run time (`actualDurationS`, issue
 * #481), for the step that has the envelope. `actualDurationS: null` removes the what-if, so the
 * planner times the step by the whole window again; one equal to the window is removed too, which
 * keeps a file with no what-if in it free of the key, as `setTransfer` does with an actual count.
 * A what-if longer than the window is refused. A window shortened to the what-if or below it
 * removes the what-if, which would no longer be shorter than the window. None of it changes what
 * the robot runs.
 */
export function setEnvelopeDurations(
  auto: Auto,
  stepId: string,
  patch: { maxDurationS?: number; actualDurationS?: number | null },
): Auto {
  return editStep(auto, stepId, (step) => {
    const target = envelopeStep(step, stepId);
    const envelope: Envelope = { ...existingEnvelope(target, stepId) };
    if (patch.maxDurationS !== undefined) {
      envelope.maxDurationS = patch.maxDurationS;
      if (patch.actualDurationS === undefined && envelope.actualDurationS !== undefined && envelope.actualDurationS >= patch.maxDurationS) {
        delete envelope.actualDurationS;
      }
    }
    if (patch.actualDurationS === null) {
      delete envelope.actualDurationS;
    } else if (patch.actualDurationS !== undefined) {
      const actual = patch.actualDurationS;
      if (!Number.isFinite(actual) || actual <= 0) {
        throw new EditError(`An envelope's actual run time is a number of seconds over 0; ${String(actual)} is not.`);
      }
      if (actual > envelope.maxDurationS) {
        throw new EditError(
          `The actual run time (${String(actual)} s) is longer than the envelope's Lasts at most (${String(envelope.maxDurationS)} s); it can be at most that.`,
        );
      }
      envelope.actualDurationS = actual;
    }
    if (envelope.actualDurationS === envelope.maxDurationS) delete envelope.actualDurationS;
    return { ...target, envelope };
  });
}

/** Moves one corner of a step's envelope, by its 0-based index. */
export function setEnvelopeCorner(
  auto: Auto,
  stepId: string,
  cornerIndex: number,
  corner: EnvelopePoint,
): Auto {
  return editStep(auto, stepId, (step) => {
    const target = envelopeStep(step, stepId);
    const envelope = existingEnvelope(target, stepId);
    if (envelope.polygon[cornerIndex] === undefined) {
      throw new EditError(
        `The envelope on step ${JSON.stringify(stepId)} has no corner at index ${String(cornerIndex)}.`,
      );
    }
    const polygon = envelope.polygon.map((point, index) =>
      index === cornerIndex ? { xIn: corner.xIn, yIn: corner.yIn } : point,
    );
    return { ...target, envelope: { ...envelope, polygon } };
  });
}

/**
 * Adds a corner to a step's envelope at the middle of the edge that leaves corner `afterIndex`, so
 * the shape does not change until the new corner is moved. The schema refuses a polygon over its
 * corner limit, so this throws rather than add one too many.
 */
export function addEnvelopeCorner(auto: Auto, stepId: string, afterIndex: number): Auto {
  return editStep(auto, stepId, (step) => {
    const target = envelopeStep(step, stepId);
    const envelope = existingEnvelope(target, stepId);
    const count = envelope.polygon.length;
    const from = envelope.polygon[afterIndex];
    const to = envelope.polygon[(afterIndex + 1) % count];
    if (from === undefined || to === undefined) {
      throw new EditError(
        `The envelope on step ${JSON.stringify(stepId)} has no corner at index ${String(afterIndex)}.`,
      );
    }
    const middle = { xIn: (from.xIn + to.xIn) / 2, yIn: (from.yIn + to.yIn) / 2 };
    const polygon = [...envelope.polygon.slice(0, afterIndex + 1), middle, ...envelope.polygon.slice(afterIndex + 1)];
    return { ...target, envelope: { ...envelope, polygon } };
  });
}

/** Removes one corner of a step's envelope; the schema refuses to leave fewer than three. */
export function removeEnvelopeCorner(auto: Auto, stepId: string, cornerIndex: number): Auto {
  return editStep(auto, stepId, (step) => {
    const target = envelopeStep(step, stepId);
    const envelope = existingEnvelope(target, stepId);
    if (envelope.polygon[cornerIndex] === undefined) {
      throw new EditError(
        `The envelope on step ${JSON.stringify(stepId)} has no corner at index ${String(cornerIndex)}.`,
      );
    }
    const polygon = envelope.polygon.filter((_, index) => index !== cornerIndex);
    return { ...target, envelope: { ...envelope, polygon } };
  });
}

/**
 * Sets or clears the pose a path assumes it starts from after a command that moves the robot
 * (`rejoinFrom`, spec 13 section 10). Only a path that starts from `"current"` uses one, so a path
 * that starts anywhere else is refused rather than given a pose that would be ignored.
 */
export function setRejoinFrom(auto: Auto, stepId: string, pose: RejoinPose | null): Auto {
  return editStep(auto, stepId, (step) => {
    const path = asPathStep(step, stepId);
    if (pose === null) {
      const next = { ...path };
      delete next.rejoinFrom;
      return next;
    }
    if (path.segments[0]?.from !== "current") {
      throw new EditError(
        `Step ${JSON.stringify(stepId)} starts from a fixed pose; only a path that starts from "current" can rejoin.`,
      );
    }
    return { ...path, rejoinFrom: pose };
  });
}
