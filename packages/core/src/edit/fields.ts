import type {
  Auto,
  BranchStep,
  CommandCall,
  ParallelStep,
  PathStep,
  PoseSource,
  Segment,
  Step,
  WaitStep,
} from "@horizon36596/zenith-schema";
import { EditError } from "./errors.js";
import { finish } from "./finish.js";
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
 * control point, and core will not invent one (CLAUDE.md rule 4): the caller passes the point,
 * which is the segment's midpoint when the editor does it.
 */
export function setSegmentKind(
  auto: Auto,
  stepId: string,
  segmentIndex: number,
  kind: Segment["kind"],
  control: { xIn: number; yIn: number },
): Auto {
  return editStep(auto, stepId, (step) => {
    const path = asPathStep(step, stepId);
    segmentAt(path, stepId, segmentIndex);
    const segments = path.segments.map((segment, index): Segment => {
      if (index !== segmentIndex || segment.kind === kind) return segment;
      if (kind === "line") return { kind: "line", from: segment.from, to: segment.to };
      return { kind: "bezier", from: segment.from, control: [control], to: segment.to };
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

/** Sets what a wait step waits for: a number of seconds, a robot-side condition, or both. */
export function setWait(
  auto: Auto,
  stepId: string,
  wait: { seconds?: number; until?: string },
): Auto {
  return editStep(auto, stepId, (step) => {
    if (step.kind !== "wait") {
      throw new EditError(`Step ${JSON.stringify(stepId)} is a ${step.kind} step, not a wait.`);
    }
    const next: WaitStep = { ...step, seconds: wait.seconds, until: wait.until };
    return next;
  });
}

/** Sets a parallel group's mode, and which child is its deadline. */
export function setParallel(
  auto: Auto,
  stepId: string,
  patch: { mode?: ParallelStep["mode"]; deadline?: string },
): Auto {
  return editStep(auto, stepId, (step) => {
    if (step.kind !== "parallel") {
      throw new EditError(
        `Step ${JSON.stringify(stepId)} is a ${step.kind} step, not a parallel group.`,
      );
    }
    const next: ParallelStep = { ...step, ...patch };
    return next;
  });
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
