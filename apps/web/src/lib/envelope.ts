/**
 * The editor's side of envelopes and rejoin poses (spec 13 section 10): what "Add an envelope"
 * and "Set a rejoin pose" start from, and when the inspector offers a rejoin pose at all. The
 * file edits themselves are `@horizon36596/zenith-core`'s (`setEnvelope`, `setRejoinFrom` and the
 * corner edits), so the inspector, the palette and an agent all write the same thing.
 */
import { setEnvelope, squareEnvelopeAround, type Pose, type Vec2 } from "@horizon36596/zenith-core";
import {
  ENVELOPE_MAX_DURATION_S,
  ENVELOPE_MAX_POINTS,
  ENVELOPE_MIN_POINTS,
  type Auto,
  type Envelope,
  type RejoinPose,
  type Robot,
  type Step,
} from "@horizon36596/zenith-schema";
import { findEntry, indexSteps, siblingsOf, type StepEntry } from "./stepOps";

export { ENVELOPE_MAX_DURATION_S, ENVELOPE_MAX_POINTS, ENVELOPE_MIN_POINTS };

/**
 * The side of the square a new envelope starts as, in inches. SET BY HAND (the M-C5 brief): one
 * FTC field tile, 24 in, centred on where the step starts, so the square is visible at any zoom and
 * obviously a starting point to drag rather than a claim about where the robot goes.
 */
export const DEFAULT_ENVELOPE_SIDE_IN = 24;

/** What a new envelope's provenance says: it is the editor's default until someone edits it. */
export const DEFAULT_ENVELOPE_PROVENANCE =
  "SET FROM EDITOR: default square round the step's start; move the corners to where the robot really stays";

/** The provenance a new rejoin pose carries. */
export const DEFAULT_REJOIN_PROVENANCE = "SET FROM EDITOR: where the planner had this path starting";

/** The step kinds whose inspector offers an envelope. */
export const carriesEnvelope = (step: Step): step is Extract<Step, { kind: "path" | "command" | "wait" }> =>
  step.kind === "path" || step.kind === "command" || step.kind === "wait";

/**
 * The window a new envelope declares, in seconds. It takes a number the step already has rather
 * than inventing one: its timeout, which is the longest the runtime lets it run, else its own
 * estimate, else the longest window the file format allows, the autonomous period. Clamped into
 * the range the schema accepts.
 */
export function defaultEnvelopeSeconds(step: Step, estimateS: number | null): number {
  const timeoutS = "timeoutS" in step ? step.timeoutS : undefined;
  const candidate = timeoutS ?? (estimateS !== null && estimateS > 0 ? estimateS : ENVELOPE_MAX_DURATION_S);
  return Math.min(ENVELOPE_MAX_DURATION_S, Math.max(0.1, candidate));
}

/** The envelope "Add an envelope" writes: a square round the step's start pose. */
export function defaultEnvelopeFor(step: Step, startPose: Pose, estimateS: number | null): Envelope {
  return squareEnvelopeAround(
    startPose,
    DEFAULT_ENVELOPE_SIDE_IN,
    defaultEnvelopeSeconds(step, estimateS),
    DEFAULT_ENVELOPE_PROVENANCE,
  );
}

/** The envelope a step in the auto carries, or undefined. */
export function envelopeOfStep(auto: Auto, stepId: string): Envelope | undefined {
  const step = findEntry(auto, stepId)?.step;
  return step !== undefined && carriesEnvelope(step) ? step.envelope : undefined;
}

/** What a drawn envelope's provenance says, until someone edits it. */
export const DRAWN_ENVELOPE_PROVENANCE = "SET FROM EDITOR: drawn on the field round where the robot stays";

/**
 * Gives a step's envelope a new polygon (issue #120: the rectangle a drag on the field drew,
 * resized or moved), keeping its window and its provenance. A step with no envelope yet gets one
 * with `fresh`'s window and provenance, which is how drawing a new one creates it; without `fresh`
 * that is an error, as the edit has nothing to keep.
 */
export function withEnvelopePolygon(
  auto: Auto,
  stepId: string,
  polygon: readonly Vec2[],
  fresh?: Pick<Envelope, "maxDurationS" | "provenance">,
): Auto {
  const corners = polygon.map((corner) => ({ xIn: corner.xIn, yIn: corner.yIn }));
  // An envelope the step has keeps everything but its corners, its what-if run time included.
  const existing = envelopeOfStep(auto, stepId);
  if (existing !== undefined) return setEnvelope(auto, stepId, { ...existing, polygon: corners });
  if (fresh === undefined) throw new Error(`${stepId} has no envelope to reshape.`);
  return setEnvelope(auto, stepId, { polygon: corners, maxDurationS: fresh.maxDurationS, provenance: fresh.provenance });
}

/** The rejoin pose "Set a rejoin pose" writes: where the planner has the path starting now. */
export const defaultRejoinFor = (startPose: Pose): RejoinPose => ({
  xIn: startPose.xIn,
  yIn: startPose.yIn,
  headingRad: startPose.headingRad,
  provenance: DEFAULT_REJOIN_PROVENANCE,
});

/**
 * Whether the inspector shows a path's rejoin pose: always when it has one, and otherwise only for
 * a path that starts from `"current"` right after a command `robot.json` marks `movesRobot`, the
 * one place `core.resolve` uses it. Offering it on every path would be clutter for a setting that
 * does nothing there.
 */
export function offersRejoin(auto: Auto, entry: StepEntry, robot: Robot | null | undefined): boolean {
  const step = entry.step;
  if (step.kind !== "path") return false;
  if (step.rejoinFrom !== undefined) return true;
  if (step.segments[0]?.from !== "current") return false;
  const siblings = siblingsOf(indexSteps(auto), entry);
  const previous = siblings.find((sibling) => sibling.index === entry.index - 1)?.step;
  if (previous?.kind !== "command") return false;
  return robot?.commands.some((command) => command.name === previous.name && command.movesRobot === true) === true;
}
