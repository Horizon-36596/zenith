/**
 * The edits the toolbar, the palette, the keyboard, the inspector and the canvas all perform, in
 * one place, so a drag and its keyboard equivalent are literally the same call (UI_GUIDE section 9).
 *
 * Every mutation goes through `@horizon36596/zenith-core`'s edit primitives, which validate the result, so the
 * editor can never write a document the schema would reject.
 */
import {
  addMarker,
  addStep,
  appendPath,
  applyFix,
  fieldBounds,
  collectIds,
  joinAt,
  joinSteps,
  joinStepsProblem,
  stepAfter,
  reachInsideField,
  removeControl,
  removePath,
  type ChainContext,
  type ChainEdit,
  defaultTurnTimeoutS,
  robotLimits,
  uniqueId,
  wrapAngle,
  renameStep,
  stepIdFrom,
  stepIdProblem,
  moveStep as moveStepInCore,
  removeMarker,
  setEnvelope,
  setHeadingMode,
  setPose,
  setRejoinFrom,
  setSegmentSource,
  setSpeed,
  setStart,
  setTimeout as setStepTimeout,
  startFromCurrentFix,
  type PoseTarget,
} from "@horizon36596/zenith-core";
import type {
  Auto,
  CommandSpec,
  Field,
  Robot,
  Heading,
  MarkerAt,
  ParallelStep,
  PathStep,
  Pose,
  PoseSource,
  Step,
  TransferStep,
  Waypoints,
} from "@horizon36596/zenith-schema";
import { childLists, withChildLists } from "@horizon36596/zenith-schema";
import type { PointTarget, SelectedPoint } from "../canvas/types";
import { sameSpot } from "../canvas/scene";
import { heldPathHeading, newPathHeading } from "./newPathHeading";
import { EDITOR_PROVENANCE, setSegmentKind } from "@horizon36596/zenith-core";
import { jointTwin, type SetPoseOptions } from "@horizon36596/zenith-core";
import { flattenSteps } from "@horizon36596/zenith-core";
import {
  pathPlaceOf,
  plannedHeadingAt,
  pointHeadingRefusal,
  pointHeadingRule,
  withPointHeading,
  type PathPlace,
  type SegmentEnd,
} from "../lib/headingModes";
import { provenanceAfterTyping, typedNumberWarning, type TypedProvenance } from "../lib/provenance";
import { nearestWaypoint } from "../lib/waypoints";
import {
  cloneWithFreshIds,
  emptiedGroup,
  findEntry,
  freshId,
  freshPathId,
  indexSteps,
  isGroupKind,
  isPathStep,
  newBranchStep,
  newCommandStep,
  newParallelStep,
  newPathStep,
  newSequenceStep,
  newUntilStep,
  newWaitStep,
  siblingsOf,
  type StepEntry,
} from "../lib/stepOps";
import { foldKey } from "../state/prefs";
import { safeCheck, safeEstimate, safePlan, safeResolve } from "../lib/coreSafe";
import { resolveSeason } from "@horizon36596/zenith-seasons";
import {
  flattenResolved,
  insertStepAfter,
  moveStepReportingDeadlines,
  removeStepsReportingDeadlines,
  unwrapStep,
  wrapSteps,
  type DropPosition,
  type RepointedDeadline,
  type WrapKind,
} from "../lib/structure";
import {
  commit,
  currentDerived,
  getState,
  selectStep,
  setDeleteHiddenPrompt,
  setSelection,
  setStatus as setStoreStatus,
  REFUSED_EDIT_STATUS_MS,
  type Status,
} from "../state/store";
import { clearStatus, rememberSelectionForUndo, transactionStartAuto } from "../state/store";
import { hiddenInside, hiddenStepIds, visibleMoveIndex } from "../state/features";
import { tourSignal } from "../tour/store";
import { editingNumbers, rotateRadians } from "../settings/editingNumbers";
import { keyLabel, turnWords } from "./shortcuts";
import { askDeleteWaypoint } from "./waypointDialog";
import { chooseLegalStart, trialStart, type LegalStart, type StartTrial } from "../project/legalStart";
import type { Finding, ResolvedStep } from "@horizon36596/zenith-core";
import { defaultTransferEnds } from "../lib/transfer";

/** How far ahead of the previous end pose a freshly added path puts its endpoint, in inches. */
const NEW_PATH_REACH_IN = 24;

/**
 * The shortest leg worth keeping along the anchor's heading once it is clamped to the field, in
 * inches; anything shorter aims at the field centre instead (QA-04, the coordinator's rule).
 */
const NEW_PATH_MIN_REACH_IN = 12;

/**
 * The status line for every edit here. An error from an edit is a refused edit, and it goes by
 * itself after `REFUSED_EDIT_STATUS_MS` or at the next edit, whichever is first (issue #411); every
 * other message keeps the status bar's own timing.
 */
function setStatus(kind: Status["kind"], message: string, hint?: string): void {
  setStoreStatus(kind, message, hint, kind === "error" ? { expireMs: REFUSED_EDIT_STATUS_MS } : {});
}

/** Runs an edit primitive and turns its EditError into a status line rather than a crash. */
export function tryEdit(edit: (auto: Auto) => Auto, options: { history?: boolean } = {}): void {
  const state = getState();
  const auto = state.auto;
  if (auto === null) return;
  // Review mode is somebody else's proposal, not a working copy (06 section 4).
  if (state.review !== null) {
    setStatus("error", "Review mode is read only. Leave the review to edit this auto.");
    return;
  }
  try {
    commit(edit(auto), options);
  } catch (error) {
    setStatus("error", error instanceof Error ? error.message : String(error));
  }
}

export function selectedEntry(): StepEntry | undefined {
  const { auto, selection } = getState();
  if (auto === null || selection.stepId === undefined) return undefined;
  return findEntry(auto, selection.stepId);
}

/** The pose a point of a path step currently sits at, after refs and `"current"` are resolved. */
export function resolvedPointPose(stepId: string, target: PointTarget): Pose | null {
  const resolved = currentDerived().resolved;
  if (resolved === null) return null;
  const step = flattenResolved(resolved.steps).find((candidate) => candidate.id === stepId);
  const segment = step?.segments?.[target.segmentIndex];
  if (segment === undefined) return null;
  if (target.pointKind === "from") return segment.fromPose;
  if (target.pointKind === "to") return segment.toPose;
  // A control point has no heading of its own, and none is lent to it (N82).
  const control = segment.pointsIn[(target.controlIndex ?? 0) + 1];
  return control === undefined ? null : { xIn: control.xIn, yIn: control.yIn };
}

const asPoseTarget = (target: PointTarget): PoseTarget => ({
  segmentIndex: target.segmentIndex,
  pointKind: target.pointKind,
  controlIndex: target.controlIndex ?? 0,
});

/**
 * The point a nudge or a rotate acts on: the selected one, or the end of the selected step.
 * `fromStepEnd` is set for the end of the step, which nothing on the field was pointed at: a nudge
 * must not give such an end a pose of its own when it follows a waypoint or `"current"`.
 */
export function activePoint(): { entry: StepEntry; target: PointTarget; fromStepEnd: boolean } | null {
  const entry = selectedEntry();
  if (entry === undefined || !isPathStep(entry.step)) return null;
  const selected = getState().selection.point;
  if (selected !== undefined) return { entry, target: selected, fromStepEnd: false };
  return { entry, target: { segmentIndex: entry.step.segments.length - 1, pointKind: "to" }, fromStepEnd: true };
}

/**
 * The line a nudge says when the end of the selected step follows a waypoint, or is `"current"`,
 * and no point was picked on the field: a key press that nobody aimed at that point must not unlink
 * it (issue #161).
 */
export const STEP_END_FOLLOWS = "Select the waypoint to move it, or click the end on the field to give it its own pose.";

/** How a key gesture is written to history: a held key's repeats join the press that began it. */
export interface KeyEditOptions {
  history?: boolean;
}

/* ---- Points that follow a waypoint ---------------------------------------- */

/**
 * A point an edit gave a pose of its own in place of the waypoint it followed (issue #133): what it
 * is, mid-sentence ("the start", "point 2 of driveOut"), and the waypoint's name.
 */
export interface Unlinked {
  what: string;
  waypoint: string;
}

/** What one point of a path step is written as, or undefined when the step has no such point. */
function pointSource(auto: Auto, stepId: string, target: PointTarget): PoseSource | undefined {
  const step = findEntry(auto, stepId)?.step;
  const segment = step !== undefined && isPathStep(step) ? step.segments[target.segmentIndex] : undefined;
  if (segment === undefined) return undefined;
  if (target.pointKind === "control") return segment.kind === "bezier" ? segment.control[target.controlIndex ?? 0] : undefined;
  return segment[target.pointKind];
}

/** The waypoint a pose source follows, or null for a pose of its own or `"current"`. */
const waypointOf = (source: PoseSource | undefined): string | null =>
  source === undefined || source === "current" || !("ref" in source) ? null : source.ref;

/**
 * A path point's name mid-sentence. The ends are numbered as the field's hover bubble numbers them;
 * the first point is not called the start, so it is never taken for the routine's start.
 */
export function pointName(stepId: string, target: PointTarget): string {
  if (target.pointKind === "to") return `point ${String(target.segmentIndex + 1)} of ${stepId}`;
  if (target.pointKind === "control") return `control ${String((target.controlIndex ?? 0) + 1)} of ${stepId}`;
  return target.segmentIndex === 0
    ? `the first point of ${stepId}`
    : `the start of path ${String(target.segmentIndex + 1)} of ${stepId}`;
}

/** "a", "a and b", "a, b and c". */
export const listed = (items: readonly string[]): string =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1] ?? ""}`;

/**
 * The status line for points an edit unlinked from their waypoints: what no longer follows which
 * waypoint, and that Undo links it again (issue #133). For example "The start no longer follows
 * waypoint start. Undo links it again."
 */
export function unlinkedMessage(unlinked: readonly Unlinked[]): string {
  const one = unlinked.length === 1;
  const what = unlinked.length > 3 ? `${String(unlinked.length)} points` : listed(unlinked.map((entry) => entry.what));
  const names = [...new Set(unlinked.map((entry) => entry.waypoint))];
  const waypoints =
    names.length === 1 ? `waypoint ${names[0] ?? ""}` : names.length > 3 ? "their waypoints" : `waypoints ${listed(names)}`;
  const sentence = `${what} no longer ${one ? "follows" : "follow"} ${waypoints}. Undo links ${one ? "it" : "them"} again.`;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/**
 * Says on the status line what an edit unlinked, when the edit went through. A drag says it once:
 * from its second frame on, the point it unlinked already has a pose of its own.
 */
function sayUnlinked(before: Auto | null, unlinked: readonly Unlinked[]): void {
  if (unlinked.length === 0 || getState().auto === before) return;
  setStatus("info", unlinkedMessage(unlinked));
}

/**
 * The status line for points an edit made follow a waypoint they were snapped onto (issue #150):
 * for example "Point 1 of path1 now follows waypoint park." Each entry names a point and the
 * waypoint it now follows.
 */
export function linkedMessage(linked: readonly Unlinked[]): string {
  const what = linked.length > 3 ? `${String(linked.length)} points` : listed(linked.map((entry) => entry.what));
  const names = [...new Set(linked.map((entry) => entry.waypoint))];
  const sentence = `${what} now ${linked.length === 1 ? "follows" : "follow"} ${names.length === 1 ? "waypoint" : "waypoints"} ${listed(names)}.`;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/** `waypoint`, when `waypoints.json` has it, so a point can follow it; else null. */
function followableWaypoint(waypoint: string | undefined): string | null {
  const named = getState().project?.waypoints?.waypoints;
  return waypoint !== undefined && named !== undefined && Object.prototype.hasOwnProperty.call(named, waypoint) ? waypoint : null;
}

/**
 * What one frame of a drag did to which waypoints its points follow (issue #150), measured from the
 * press, so the status line says what the whole drag has done so far: `unlinked` no longer follow
 * the waypoint they followed at the press, `linked` now follow one they did not, and `settled` is
 * set when a point is back to what it followed at the press, so nothing is left to say about it.
 */
interface LinkChanges {
  unlinked: Unlinked[];
  linked: Unlinked[];
  settled: boolean;
}

/** Says what a drag's frame did to the points' waypoints, when the frame changed the document. */
function sayLinkChanges(before: Auto | null, changes: LinkChanges): void {
  if (getState().auto === before) return;
  const said: string[] = [];
  if (changes.unlinked.length > 0) said.push(unlinkedMessage(changes.unlinked));
  if (changes.linked.length > 0) said.push(linkedMessage(changes.linked));
  if (said.length > 0) setStatus("info", said.join(" "));
  else if (changes.settled) clearStatus();
}

/** One point of a path step and the pose an edit writes into it. */
export interface PointMove {
  stepId: string;
  target: PointTarget;
  pose: Pose;
}

/** Writes a pose into one point of a path step. The canvas drag and the arrow keys both land here. */
export function writePose(
  stepId: string,
  target: PointTarget,
  pose: Pose,
  options: { history?: boolean } = {},
): void {
  writePoses([{ stepId, target, pose }], options);
}

/**
 * Several points moved in one frame, as one edit: a group drag, an endpoint carrying its curve
 * handles, or a smooth node mirroring the handle opposite the one dragged. A point that followed a
 * waypoint gets a pose of its own, and the status line says so (issue #133).
 *
 * A move that names the waypoint the drag snapped it onto (issue #150) makes a path end follow it,
 * `{ ref }`, and the status line says so; an end that already follows it keeps it and is not
 * unlinked. A Bezier handle cannot follow a waypoint, so it takes the waypoint's numbers with the
 * waypoint's provenance. Inside a drag, what the status line says is measured from the press, so an
 * end dragged off its waypoint and back onto it is not reported as unlinked.
 */
export function writePoses(
  moves: ReadonlyArray<{ stepId: string; target: PointTarget; pose: Pose; waypoint?: string }>,
  options: { history?: boolean } = {},
): void {
  if (moves.length === 0) return;
  const before = getState().auto;
  // An end that already follows the waypoint it was snapped onto stays as it is.
  const keepsFollowing = (doc: Auto, move: (typeof moves)[number]): boolean => {
    const snapped = followableWaypoint(move.waypoint);
    return snapped !== null && move.target.pointKind !== "control" && waypointOf(pointSource(doc, move.stepId, move.target)) === snapped;
  };
  if (before === null || moves.every((move) => keepsFollowing(before, move))) return;
  const atPress = transactionStartAuto() ?? before;
  const changes: LinkChanges = { unlinked: [], linked: [], settled: false };
  tryEdit((auto) => {
    changes.unlinked.length = 0;
    changes.linked.length = 0;
    changes.settled = false;
    return moves.reduce((doc, move) => {
      if (keepsFollowing(doc, move)) return doc;
      const followed = waypointOf(pointSource(doc, move.stepId, move.target));
      const pressed = waypointOf(pointSource(atPress, move.stepId, move.target));
      const what = pointName(move.stepId, move.target);
      const snapped = followableWaypoint(move.waypoint);
      if (snapped !== null && move.target.pointKind !== "control") {
        if (pressed === snapped) changes.settled = true;
        else changes.linked.push({ what, waypoint: snapped });
        return setSegmentSource(doc, move.stepId, move.target.segmentIndex, move.target.pointKind, { ref: snapped });
      }
      if (followed !== null) {
        if (pressed !== null) changes.unlinked.push({ what, waypoint: pressed });
        else changes.settled = true;
      }
      const fromWaypoint = snapped === null ? undefined : waypointPose(snapped, null).provenance;
      return setPose(doc, move.stepId, asPoseTarget(move.target), {
        xIn: move.pose.xIn,
        yIn: move.pose.yIn,
        headingRad: move.pose.headingRad,
        provenance: move.pose.provenance ?? fromWaypoint ?? EDITOR_PROVENANCE,
      });
    }, auto);
  }, options);
  sayLinkChanges(before, changes);
}

/**
 * Splits one segment of a path step in two at its own curve parameter `u` (QA-10).
 *
 * Core's split fix does the work, the same one the HEADING check offers (issue #186): it is handed
 * the segment's ends as the same resolve the canvas draws from has them, so a `"current"` or a
 * waypoint end can be cut, and it puts the original ends back. The first half still starts from
 * `"current"` or its waypoint, the second half still ends at the original `to`, and only the new
 * point in the middle is an explicit pose, with SET FROM EDITOR on it and on a curve's new handles.
 */
export function splitSegmentAt(stepId: string, segmentIndex: number, u: number): void {
  const auto = getState().auto;
  if (auto === null) return;
  const resolved = currentDerived().resolved;
  const drawn = resolved === null ? undefined : flattenResolved(resolved.steps).find((step) => step.id === stepId);
  const ends = drawn?.segments?.[segmentIndex];
  tryEdit((current) => {
    const original = findEntry(current, stepId)?.step;
    if (original === undefined || !isPathStep(original) || original.segments[segmentIndex] === undefined) {
      throw new Error(`There is no path ${String(segmentIndex + 1)} on ${stepId} to split.`);
    }
    if (ends === undefined) {
      throw new Error(`${stepId} cannot be drawn yet, so there is nowhere on it to split.`);
    }
    const split = applyFix(current, {
      kind: "splitSegment",
      stepId,
      label: "Split here",
      params: {
        segmentIndex,
        u,
        fromIn: { xIn: ends.fromPose.xIn, yIn: ends.fromPose.yIn },
        toIn: { xIn: ends.toPose.xIn, yIn: ends.toPose.yIn },
      },
    });
    const halves = findEntry(split, stepId)?.step;
    if (halves === undefined || !isPathStep(halves) || halves.segments.length !== original.segments.length + 1) {
      throw new Error("That point is at the very end of the path, so there is nothing to split off.");
    }
    return split;
  });
}

/**
 * Turns one segment of a path step into a curve or back into a straight line (issue #143). The
 * inspector's Kind, the palette's Make curve and Make straight line, and a path's right-click menu
 * all land here.
 *
 * A curve gets one control point, at the midpoint of the segment's ends as the planner resolves
 * them, through the same resolve the canvas draws from, so `"current"` and waypoint ends count. It
 * carries the editor's provenance. A curve whose one control sits halfway between its ends is the
 * straight line itself, so the switch changes nothing the checks or the estimate see; dragging the
 * hollow square then bends it. When the ends cannot be worked out, the status line says so and
 * nothing is written, rather than a guessed point. A line keeps the segment's two ends as written.
 *
 * Resolve draws a waypoint it cannot find, or a start that follows one, at a stand-in pose (the
 * field centre for the start), and `"current"` carries that stand-in on. So the ends count as worked
 * out only when resolve raised no error on this step, nor, for a segment that chains from
 * `"current"` back to the step's start, on the routine's start or any step drawn before it.
 */
export function setSegmentKindAt(stepId: string, segmentIndex: number, kind: "line" | "bezier"): void {
  const auto = getState().auto;
  if (auto === null) return;
  const step = findEntry(auto, stepId)?.step;
  const segment = step !== undefined && isPathStep(step) ? step.segments[segmentIndex] : undefined;
  const which = `${String(segmentIndex + 1)} of ${stepId}`;
  if (step === undefined || !isPathStep(step) || segment === undefined) {
    setStatus("error", `There is no path ${which} to change.`);
    return;
  }
  if (segment.kind === kind) return;
  // A step of one path is that path, so the line names the step alone: "path1 is a curve now."
  const named = step.segments.length === 1 ? stepId : `Path ${which}`;
  if (kind === "line") {
    tryEdit((current) => setSegmentKind(current, stepId, segmentIndex, "line"));
    if (getState().auto !== auto) setStatus("ok", `${named} is a straight line now.`);
    return;
  }
  const resolved = currentDerived().resolved;
  const drawnSteps = resolved === null ? [] : flattenResolved(resolved.steps);
  const at = drawnSteps.findIndex((candidate) => candidate.id === stepId);
  const ends = drawnSteps[at]?.segments?.[segmentIndex];
  const chained = step.segments.slice(0, segmentIndex + 1).every((candidate) => candidate.from === "current");
  const upstream = chained ? ["start", ...drawnSteps.slice(0, Math.max(0, at)).map((candidate) => candidate.id)] : [];
  const behind = new Set([stepId, ...upstream]);
  const unknown = resolved?.findings.find((finding) => finding.severity === "error" && behind.has(finding.stepId));
  if (ends === undefined || unknown !== undefined) {
    const why = unknown === undefined ? "" : ` ${unknown.message}`;
    setStatus(
      "error",
      `Zenith cannot work out where path ${which} starts and ends yet, so there is nowhere to put the curve's control point.${why}`,
    );
    return;
  }
  const control = {
    xIn: (ends.fromPose.xIn + ends.toPose.xIn) / 2,
    yIn: (ends.fromPose.yIn + ends.toPose.yIn) / 2,
    provenance: EDITOR_PROVENANCE,
  };
  tryEdit((current) => setSegmentKind(current, stepId, segmentIndex, "bezier", control));
  if (getState().auto !== auto) {
    setStatus("ok", `${named} is a curve now. Drag the hollow square in its middle to bend it.`);
  }
}

/* ---- Path chains: adding, removing and joining paths (issue #185) ------- */

/** What core's chain edits measure against: the project's waypoints, robot and field. */
const chainContext = (): ChainContext => {
  const state = getState();
  const robot = state.autoRobot ?? state.project?.robot ?? undefined;
  const field = state.autoField ?? state.project?.field ?? undefined;
  return {
    ...(state.project?.waypoints === undefined ? {} : { waypoints: state.project.waypoints }),
    // Extend this chain keeps the heading the chain ends at through the path it adds (issue #435).
    ...(state.prefs.newPathKeepsHeading ? { keepEndHeading: true } : {}),
    ...(robot === undefined || robot === null ? {} : { robot }),
    ...(field === undefined || field === null ? {} : { field }),
  };
};

const plural = (count: number, one: string, many: string): string => `${String(count)} ${count === 1 ? one : many}`;

/**
 * What a chain edit did besides the paths it changed, for the status line: the markers and heading
 * ranges it rescaled to keep their distance along the unchanged part (decision D5), and the
 * waypoints the chain no longer follows.
 */
export function chainEditNotes(edit: Pick<ChainEdit, "movedMarkers" | "movedRanges" | "droppedWaypoints">, stepId: string): string[] {
  const notes: string[] = [];
  const moved = [
    ...(edit.movedMarkers > 0 ? [plural(edit.movedMarkers, "marker", "markers")] : []),
    ...(edit.movedRanges > 0 ? [plural(edit.movedRanges, "heading range", "heading ranges")] : []),
  ];
  if (moved.length > 0) {
    const one = edit.movedMarkers + edit.movedRanges === 1;
    notes.push(`${listed(moved)} ${one ? "stays where it was" : "stay where they were"} on the unchanged part of the chain.`);
  }
  const dropped = edit.droppedWaypoints;
  if (dropped.length > 0) {
    notes.push(`${stepId} no longer follows ${dropped.length === 1 ? "waypoint" : "waypoints"} ${listed(dropped)}.`);
  }
  return notes;
}

/** Runs one chain edit as one undo step; returns what it did, or null when it was refused. */
function chainEdit(edit: (auto: Auto) => ChainEdit): ChainEdit | null {
  const before = getState().auto;
  const done: { edit?: ChainEdit } = {};
  tryEdit((current) => {
    done.edit = edit(current);
    return done.edit.auto;
  });
  return done.edit === undefined || getState().auto === before ? null : done.edit;
}

const say = (main: string, edit: ChainEdit, stepId: string): void => {
  setStatus("ok", [main, ...chainEditNotes(edit, stepId)].join(" "));
};

/**
 * The Inspector's Add path to chain: a straight path from the chain's end, 24 in along the way
 * the robot faces there and kept on the field, selected so the arrow keys or a drag put it in place.
 */
export function appendPathToChain(stepId: string): boolean {
  const edit = chainEdit((auto) => appendPath(auto, stepId, chainContext()));
  if (edit === null) return false;
  const step = findEntry(edit.auto, stepId)?.step;
  const count = step !== undefined && isPathStep(step) ? step.segments.length : 1;
  setSelection({ stepId, point: { segmentIndex: count - 1, pointKind: "to" } });
  say(`Added a path to ${stepId}. Drag its end to where it should go.`, edit, stepId);
  return true;
}

/**
 * The path step an add-path click, Add a path to here or Insert a path adds to instead of making a
 * new step (issue #204, decision D5): the selected step, while Extend this chain is on and that
 * step is a path step. Otherwise null, and they make a new step after the selection as always.
 */
export function chainToExtend(): string | null {
  if (!getState().prefs.addPathExtends) return null;
  const entry = selectedEntry();
  return entry !== undefined && isPathStep(entry.step) ? entry.id : null;
}

/**
 * Extend this chain's add-path click: a straight path from the end of `stepId`'s chain to `to`,
 * as one undo step, with its end selected so the next click extends the chain again.
 */
function extendChainTo(stepId: string, to: PoseSource, follows: string | null): string | null {
  const edit = chainEdit((auto) => appendPath(auto, stepId, chainContext(), to));
  if (edit === null) return null;
  const step = findEntry(edit.auto, stepId)?.step;
  const count = step !== undefined && isPathStep(step) ? step.segments.length : 1;
  const end: PointTarget = { segmentIndex: count - 1, pointKind: "to" };
  setSelection({ stepId, point: end });
  const linked = follows === null ? [] : [linkedMessage([{ what: pointName(stepId, end), waypoint: follows }])];
  say([`Added a path to ${stepId}.`, ...linked].join(" "), edit, stepId);
  return stepId;
}

/**
 * Why Join with next path cannot join `stepId` with the step after it, or null when it can
 * (issue #204): core's reason, or that nothing follows it.
 */
export function joinNextReason(auto: Auto | null, stepId: string | undefined, waypoints?: Waypoints): string | null {
  if (auto === null) return "Open an auto first.";
  if (stepId === undefined) return "Select a path step first.";
  const next = stepAfter(auto, stepId);
  if (next === null) return `Nothing comes after ${stepId} in its list, so there is no path to join it with.`;
  return joinStepsProblem(auto, stepId, next, waypoints === undefined ? {} : { waypoints });
}

/**
 * Join with next path (issue #204, decision D5): the selected path step and the path step straight
 * after it become one chain, as one undo step. The status line says what became of the heading,
 * the markers and any waypoint the chain no longer follows; a join that cannot happen says why.
 */
export function joinWithNext(stepId: string | undefined = getState().selection.stepId): void {
  const auto = getState().auto;
  if (auto === null || stepId === undefined) return;
  const next = stepAfter(auto, stepId);
  if (next === null) {
    setStatus("error", `Nothing comes after ${stepId} in its list, so there is no path to join it with.`);
    return;
  }
  const before = findEntry(auto, stepId)?.step;
  const edit = chainEdit((current) => joinSteps(current, stepId, next, chainContext()));
  if (edit === null) return;
  const step = findEntry(edit.auto, stepId)?.step;
  const count = step !== undefined && isPathStep(step) ? step.segments.length : 1;
  const piecewiseNow =
    step !== undefined && isPathStep(step) && step.heading?.mode === "piecewise" && !(before !== undefined && isPathStep(before) && before.heading?.mode === "piecewise");
  const notes = [
    `Joined ${next} onto ${stepId}, one path chain of ${String(count)} paths.`,
    ...(piecewiseNow ? ["Its heading is piecewise now, one range for each old step."] : []),
    ...(edit.movedMarkers > 0
      ? [`${plural(edit.movedMarkers, "marker was", "markers were")} rewritten to keep ${edit.movedMarkers === 1 ? "its" : "their"} distance along ${edit.movedMarkers === 1 ? "its" : "their"} own part.`]
      : []),
    ...(edit.droppedWaypoints.length > 0 ? [`${stepId} no longer follows ${edit.droppedWaypoints.length === 1 ? "waypoint" : "waypoints"} ${listed(edit.droppedWaypoints)}.`] : []),
    "Ctrl+Z puts both steps back.",
  ];
  selectStep(stepId);
  setStatus("ok", notes.join(" "));
}

/** The Inspector's Remove this path: the chain stays joined, the next path starting from the one before. */
export function removePathFromChain(stepId: string, segmentIndex: number): void {
  const edit = chainEdit((auto) => removePath(auto, stepId, segmentIndex, chainContext()));
  if (edit === null) return;
  selectStep(stepId);
  say(`Removed path ${String(segmentIndex + 1)} of ${stepId}. Ctrl+Z puts it back.`, edit, stepId);
}

/** What deleting one point of a path chain does, or why it deletes the whole step instead. */
export type PointDelete =
  | { kind: "join"; nodeIndex: number }
  | { kind: "removeLast"; segmentIndex: number }
  | { kind: "control"; segmentIndex: number; controlIndex: number }
  | { kind: "step"; why: string; refused: string };

/**
 * What Delete does to one point (issue #185): a point where two paths meet joins them, the end of
 * a chain of several paths removes the last path, and a curve handle goes on its own (the last one
 * makes the path a straight line). The chain's first point, or the end of a one-path chain, cannot
 * go without the step, so `why` says so, and `refused` says it when the step is the auto's last
 * and cannot go either.
 */
export function pointDeletePlan(auto: Auto, stepId: string, target: PointTarget): PointDelete {
  const step = findEntry(auto, stepId)?.step;
  if (step === undefined || !isPathStep(step)) {
    return { kind: "step", why: `${stepId} is not a path chain.`, refused: `${stepId} is not a path chain.` };
  }
  if (target.pointKind === "control") {
    return { kind: "control", segmentIndex: target.segmentIndex, controlIndex: target.controlIndex ?? 0 };
  }
  const count = step.segments.length;
  const node = target.pointKind === "to" ? target.segmentIndex + 1 : target.segmentIndex;
  if (node > 0 && node < count) return { kind: "join", nodeIndex: node };
  if (node === count && count > 1) return { kind: "removeLast", segmentIndex: count - 1 };
  const because = node === 0 ? `This is where ${stepId} starts, so deleting it` : `${stepId} has one path, so deleting its end`;
  return {
    kind: "step",
    why: `${because} deletes the step. Use Delete step.`,
    refused: `${because} would delete the step, and an auto needs at least one step.`,
  };
}

/**
 * Deletes one point of a path chain as `pointDeletePlan` says, as one undo step, and says on the
 * status line what went; a point that cannot go alone deletes its step, as Delete always did.
 */
export function deletePoint(stepId: string, target: PointTarget): void {
  const auto = getState().auto;
  if (auto === null) return;
  const plan = pointDeletePlan(auto, stepId, target);
  if (plan.kind === "step") {
    // The person selected a point, so a refusal says why the point takes the step with it (issue #505).
    if (findEntry(auto, stepId) !== undefined) deleteSteps([stepId], plan.refused);
    return;
  }
  if (plan.kind === "removeLast") {
    removePathFromChain(stepId, plan.segmentIndex);
    return;
  }
  if (plan.kind === "join") {
    const edit = chainEdit((current) => joinAt(current, stepId, plan.nodeIndex, chainContext()));
    if (edit === null) return;
    selectStep(stepId);
    say(
      `Deleted the point where paths ${String(plan.nodeIndex)} and ${String(plan.nodeIndex + 1)} of ${stepId} met, so they are one path now. Ctrl+Z puts it back.`,
      edit,
      stepId,
    );
    return;
  }
  const edit = chainEdit((current) => removeControl(current, stepId, plan.segmentIndex, plan.controlIndex, chainContext()));
  if (edit === null) return;
  const step = findEntry(edit.auto, stepId)?.step;
  const line = step !== undefined && isPathStep(step) && step.segments[plan.segmentIndex]?.kind === "line";
  selectStep(stepId);
  say(
    `Deleted control ${String(plan.controlIndex + 1)} of path ${String(plan.segmentIndex + 1)} of ${stepId}.${line ? ` Path ${String(plan.segmentIndex + 1)} is a straight line now.` : ""} Ctrl+Z puts it back.`,
    edit,
    stepId,
  );
}

/**
 * Sets the provenance of one point of a path step by hand, from the chip menu beside its numbers
 * (#87), and leaves the numbers as they are. It is one undo step, like any other edit. A point that
 * follows a waypoint or the last step's end has no numbers of its own, so it has no provenance to set.
 */
export function writePointProvenance(stepId: string, target: PointTarget, provenance: string): void {
  tryEdit((auto) => {
    const source = pointSource(auto, stepId, target);
    if (source === undefined || source === "current" || "ref" in source) {
      throw new Error("That point follows another pose, so it has no provenance of its own to set.");
    }
    return setPose(auto, stepId, asPoseTarget(target), { ...source, provenance });
  });
}

/** Sets the start pose's provenance by hand, as `writePointProvenance` does for a path point. */
export function writeStartProvenance(provenance: string): void {
  tryEdit((auto) => {
    const pose = auto.start.pose;
    if ("ref" in pose) {
      throw new Error(`The start follows the waypoint ${pose.ref}, so it has no provenance of its own to set.`);
    }
    return setStart(auto, { ...auto.start, pose: { ...pose, provenance } });
  });
}

/** Sets a step's envelope provenance by hand, keeping its corners and its time. */
export function writeEnvelopeProvenance(stepId: string, provenance: string): void {
  tryEdit((auto) => {
    const step = findEntry(auto, stepId)?.step;
    const envelope = step !== undefined && "envelope" in step ? step.envelope : undefined;
    if (envelope === undefined) throw new Error(`${stepId} has no envelope to label.`);
    return setEnvelope(auto, stepId, { ...envelope, provenance });
  });
}

/** Sets a path's rejoin pose provenance by hand, keeping the pose. */
export function writeRejoinProvenance(stepId: string, provenance: string): void {
  tryEdit((auto) => {
    const step = findEntry(auto, stepId)?.step;
    const rejoin = step !== undefined && isPathStep(step) ? step.rejoinFrom : undefined;
    if (rejoin === undefined) throw new Error(`${stepId} has no rejoin pose to label.`);
    return setRejoinFrom(auto, stepId, { ...rejoin, provenance });
  });
}

/** The part of the start pose a change sets; anything left out, heading included, is kept. */
export type StartPatch = { xIn?: number; yIn?: number; headingRad?: number };

/** What the inspector's typed numbers change of a path point; a curve's control point has no heading. */
export type PointNumbers = { xIn?: number; yIn?: number; headingRad?: number };

/**
 * Says so on the status line when a typed number relabelled a MEASURED or CALIBRATED FROM ROBOT value
 * (issue #273). `before` is the auto the edit started from: nothing is said when the edit did not go
 * through, as in review mode.
 */
function warnRelabelled(typed: TypedProvenance, before: Auto, what: string): void {
  if (typed.replaced !== null && getState().auto !== before) setStatus("warn", typedNumberWarning(typed.replaced, what));
}

/**
 * A number typed in the inspector for one point of a path step. The point keeps its label, except a
 * MEASURED or CALIBRATED FROM ROBOT one, which becomes SET FROM EDITOR and is warned about on the
 * status line (owner ruling 2026-10-10, issue #273); the chip beside the numbers sets it back in one
 * step. One undo step either way. Where two segments meet is one point to the editor, so typing either
 * end moves both (issue #146). A point that follows a waypoint or the last step's end has no numbers
 * of its own to type, so nothing is written.
 */
export function writePointNumbers(stepId: string, target: PointTarget, patch: PointNumbers): void {
  const before = getState().auto;
  if (before === null) return;
  const source = pointSource(before, stepId, target);
  if (source === undefined || source === "current" || "ref" in source) return;
  const typed = provenanceAfterTyping(source.provenance);
  tryEdit((auto) =>
    setPose(
      auto,
      stepId,
      asPoseTarget(target),
      { ...source, ...patch, provenance: typed.provenance },
      target.pointKind === "control" ? undefined : jointOptions(),
    ),
  );
  warnRelabelled(typed, before, pointName(stepId, target));
}

/**
 * A number typed in the inspector for the start: its x, y or heading. As for a path point
 * (`writePointNumbers`), the label is kept, except that MEASURED and CALIBRATED FROM ROBOT become
 * SET FROM EDITOR with a warning. A start that follows a waypoint has no numbers of its own to type.
 */
export function writeStartNumbers(patch: StartPatch): void {
  const before = getState().auto;
  if (before === null) return;
  const pose = before.start.pose;
  if ("ref" in pose) return;
  const typed = provenanceAfterTyping(pose.provenance);
  tryEdit((auto) => setStart(auto, { ...auto.start, pose: { ...pose, ...patch, provenance: typed.provenance } }));
  warnRelabelled(typed, before, "the start");
}

/**
 * Where a start or a path end that follows `waypoint` stands now, as a pose of its own: the
 * waypoint's numbers and provenance from `waypoints.json`. A waypoint with no provenance gives the
 * editor's, naming the waypoint. For a waypoint the file does not have, it is `drawn`, the spot the
 * planner draws the point at.
 */
export function waypointPose(waypoint: string, drawn: Pose | null): Pose {
  const named = getState().project?.waypoints?.waypoints[waypoint];
  if (named !== undefined) {
    return {
      xIn: named.xIn,
      yIn: named.yIn,
      headingRad: named.headingRad,
      provenance: named.provenance ?? `${EDITOR_PROVENANCE}: copied from waypoint ${waypoint}`,
    };
  }
  const at = drawn ?? { xIn: 0, yIn: 0, headingRad: 0 };
  return { xIn: at.xIn, yIn: at.yIn, headingRad: at.headingRad, provenance: EDITOR_PROVENANCE };
}

/**
 * The path points that sit on the routine's start now: the first point of each path, written as a
 * pose or a waypoint rather than `"current"`, on the start's own spot, as in the starter autos. A
 * move of the start carries them, so the route stays joined to it (issue #133). The canvas's start
 * drag lists the same points from its scene at the press (`pointsOnStart` in `scene.ts`).
 */
export function pathPointsOnStart(): SelectedPoint[] {
  const resolved = currentDerived().resolved;
  if (resolved === null) return [];
  const points: SelectedPoint[] = [];
  for (const step of flattenResolved(resolved.steps)) {
    const from = step.segments?.[0]?.fromPose;
    if (!isPathStep(step.step) || step.step.segments[0]?.from === "current" || from === undefined) continue;
    if (sameSpot(from, resolved.startPose)) points.push({ stepId: step.id, point: { segmentIndex: 0, pointKind: "from" } });
  }
  return points;
}

/**
 * The start moved by `change`, written with `provenance`. A start that follows a waypoint becomes
 * a pose of its own, starting from the waypoint's pose. When the start moves, not only turns, each
 * of `carried` goes to its new spot and keeps its own heading. Every point that stops following a
 * waypoint is added to `unlinked`.
 */
function moveStart(
  auto: Auto,
  change: StartPatch | ((start: Pose) => StartPatch),
  provenance: string,
  carried: readonly SelectedPoint[],
  unlinked: Unlinked[],
): Auto {
  const written = auto.start.pose;
  const pose = "ref" in written ? waypointPose(written.ref, currentDerived().resolved?.startPose ?? null) : written;
  if ("ref" in written) unlinked.push({ what: "the start", waypoint: written.ref });
  const patch = typeof change === "function" ? change(pose) : change;
  const moved: Pose = { ...pose, ...patch, provenance };
  let next = setStart(auto, { ...auto.start, pose: moved });
  if (patch.xIn === undefined && patch.yIn === undefined) return next;
  for (const { stepId, point } of carried) {
    const source = pointSource(next, stepId, point);
    if (source === undefined || source === "current") continue;
    let headingRad: number | undefined;
    if ("ref" in source) {
      unlinked.push({ what: pointName(stepId, point), waypoint: source.ref });
      headingRad = getState().project?.waypoints?.waypoints[source.ref]?.headingRad;
    } else {
      headingRad = source.headingRad;
    }
    next = setPose(next, stepId, asPoseTarget(point), {
      xIn: moved.xIn,
      yIn: moved.yIn,
      ...(headingRad === undefined ? {} : { headingRad }),
      provenance: EDITOR_PROVENANCE,
    });
  }
  return next;
}

/**
 * Moves or turns the routine's start pose (`auto.start.pose`). `change` is the patch, or a function
 * of the current start that returns one. The canvas's start drag and the arrow and rotate keys on a
 * selected start all land here, and every such change is the editor's, so the provenance is always
 * `EDITOR_PROVENANCE`.
 *
 * A start that follows a waypoint becomes a pose of its own where it is dropped, and the waypoint
 * stays where it is (issue #133). `carried` are the path points that sat on the start when the
 * gesture began; they move with it. The canvas passes the list it took at the press, the same on
 * every frame, so a drag never picks up a point it passes over. A key press is a gesture of its own
 * and takes the points on the start now. The status line says what stopped following a waypoint,
 * once per drag, and one undo links it again.
 */
export function writeStartPose(
  change: StartPatch | ((start: Pose) => StartPatch),
  options: { history?: boolean } = {},
  carried: readonly SelectedPoint[] = pathPointsOnStart(),
): void {
  const before = getState().auto;
  const unlinked: Unlinked[] = [];
  tryEdit((auto) => {
    unlinked.length = 0;
    return moveStart(auto, change, EDITOR_PROVENANCE, carried, unlinked);
  }, options);
  sayUnlinked(before, unlinked);
}

/**
 * The Problems panel's "Move the start to the nearest legal spot" on a START_ILLEGAL finding: picks
 * the start with `chooseLegalStart` (`legalStart.ts`, the season's own start rule), puts the start
 * there and says where it went. One undo step. Of the legal starts nearest the planned one, it takes
 * the first where the whole auto, as this fix writes it, gains no new error, so it does not swap
 * START_ILLEGAL for the robot turning against the wall it now starts on (issue #155); when every
 * one gains an error, it takes the nearest and the status line names that error. The search runs
 * here, on the click, and not on every plan, because it plans and checks the auto for each start it
 * tries. As for a drag, the path points on the start go with it, and a start that follows a waypoint
 * becomes a pose of its own (issue #133).
 */
export function moveStartToLegal(): void {
  const plan = currentDerived().plan;
  const current = getState().auto;
  if (plan === null || current === null) return;
  const carried = pathPointsOnStart();
  const waypoints = getState().project?.waypoints;
  const place = (auto: Auto, legal: LegalStart, unlinked: Unlinked[]): Auto =>
    moveStart(
      auto,
      { xIn: legal.xIn, yIn: legal.yIn, headingRad: legal.headingRad },
      `${EDITOR_PROVENANCE}: the nearest legal start Zenith found, touching the wall at ${legal.wall}; check it where the robot really sets up`,
      carried,
      unlinked,
    );
  const trial = (auto: () => Auto): StartTrial | null => {
    try {
      return trialStart(auto(), plan.robot, plan.field, waypoints);
    } catch {
      return null;
    }
  };
  const before = trial(() => current)?.findings ?? currentDerived().findings;
  const choice = chooseLegalStart(plan, before, (legal) => trial(() => place(current, legal, [])));
  if (choice === null) {
    setStatus("error", "Zenith found no legal start touching a wall for this robot. Drag the start to where the robot sets up.");
    return;
  }
  const legal = choice.start;
  const unlinked: Unlinked[] = [];
  tryEdit((auto) => {
    unlinked.length = 0;
    return place(auto, legal, unlinked);
  });
  if (getState().auto === current) return;
  const moved = `Moved the start to the nearest legal spot, touching the wall at ${legal.wall}.`;
  const said = choice.remaining === null ? moved : `${moved} ${remainingErrorMessage(choice.remaining)}`;
  setStatus(choice.remaining === null ? "ok" : "error", unlinked.length === 0 ? said : `${said} ${unlinkedMessage(unlinked)}`);
}

/** What the status line says when every legal start the fix tried leaves the auto a new error. */
const remainingErrorMessage = (finding: Finding): string =>
  `Every legal start Zenith tried gives the auto a new error, so this is the nearest; it still has ${finding.code} on ${finding.stepId}: ${finding.message}`;

/**
 * What the inspector's "this pose" and "a waypoint" act on: the routine's start, or one end of a
 * segment of a path step.
 */
export type PoseOwner = "start" | { stepId: string; point: { segmentIndex: number; pointKind: "from" | "to" } };

/** The owner's name mid-sentence, as the status line uses it. */
export const ownerName = (owner: PoseOwner): string => (owner === "start" ? "the start" : pointName(owner.stepId, owner.point));

/** What the owner is written as now, or undefined when the step or segment is gone. */
export const ownerSource = (auto: Auto, owner: PoseOwner): PoseSource | undefined =>
  owner === "start" ? auto.start.pose : pointSource(auto, owner.stepId, owner.point);

/** Where the planner draws the owner now, after waypoints and `"current"` are resolved. */
export const ownerDrawnPose = (owner: PoseOwner): Pose | null =>
  owner === "start" ? (currentDerived().resolved?.startPose ?? null) : resolvedPointPose(owner.stepId, owner.point);

/** The document with the owner written as `source`: a pose of its own or a waypoint to follow. */
export const writeOwner = (auto: Auto, owner: PoseOwner, source: Pose | { ref: string }): Auto =>
  owner === "start"
    ? setStart(auto, { ...auto.start, pose: source })
    : setSegmentSource(auto, owner.stepId, owner.point.segmentIndex, owner.point.pointKind, source);

/**
 * The inspector's "this pose" for the start or a path end: it becomes a pose of its own where it
 * stands now, so the robot does not move (issue #133). From a waypoint it takes the waypoint's
 * numbers and provenance, and the status line says it no longer follows the waypoint; from "last
 * step's end" it takes the pose that resolves to, with the editor's provenance. One undo puts it
 * back.
 */
export function writeOwnPose(owner: PoseOwner): void {
  const before = getState().auto;
  if (before === null) return;
  const source = ownerSource(before, owner);
  if (source === undefined || (source !== "current" && !("ref" in source))) return;
  const drawn = ownerDrawnPose(owner);
  if (source === "current") {
    if (drawn === null) {
      setStatus("error", `Zenith cannot work out where ${ownerName(owner)} is yet, so there is no pose to keep.`);
      return;
    }
    const pose: Pose = { xIn: drawn.xIn, yIn: drawn.yIn, headingRad: drawn.headingRad, provenance: EDITOR_PROVENANCE };
    tryEdit((auto) => writeOwner(auto, owner, pose));
    return;
  }
  const waypoint = source.ref;
  tryEdit((auto) => writeOwner(auto, owner, waypointPose(waypoint, drawn)));
  sayUnlinked(before, [{ what: ownerName(owner), waypoint }]);
}

/**
 * The inspector's "a waypoint" for the start or a path end: it follows the waypoint at the spot it
 * stands on now, or else the nearest one (`nearestWaypoint`), rather than the first by name (issue
 * #133). A path's first point written as "last step's end" is measured from where that resolves.
 */
export function followNearestWaypoint(owner: PoseOwner): void {
  const auto = getState().auto;
  if (auto === null) return;
  const source = ownerSource(auto, owner);
  if (source === undefined || (source !== "current" && "ref" in source)) return;
  const at = source === "current" ? ownerDrawnPose(owner) : source;
  if (at === null) {
    setStatus("error", `Zenith cannot work out where ${ownerName(owner)} is yet, so there is no waypoint nearest it.`);
    return;
  }
  const waypoint = nearestWaypoint(getState().project?.waypoints, at);
  if (waypoint === null) {
    setStatus("error", `waypoints.json has no waypoints for ${ownerName(owner)} to follow.`);
    return;
  }
  tryEdit((current) => writeOwner(current, owner, { ref: waypoint }));
}

/* ---- Joints ------------------------------------------------------------------ */

/** The options that make core's `setPose` move an interior joint as one point (issue #146). */
export const jointOptions = (): SetPoseOptions => ({ joint: true, waypoints: getState().project?.waypoints });

/**
 * One gesture's move of a path point, with the other end of the joint it sits on (core's
 * `jointTwin`): where one segment ends and the next starts is one point to the editor (issue
 * #146), so a nudge or a turn writes both ends in the same edit and the same undo step.
 */
export function jointMoves(stepId: string, target: PointTarget, pose: Pose): PointMove[] {
  const auto = getState().auto;
  const step = auto === null ? undefined : findEntry(auto, stepId)?.step;
  const twin =
    step !== undefined && isPathStep(step) ? jointTwin(step, asPoseTarget(target), getState().project?.waypoints) : null;
  return twin === null ? [{ stepId, target, pose }] : [{ stepId, target, pose }, { stepId, target: twin, pose }];
}

/* ---- The heading at a path point (issue #147) --------------------------------- */

/**
 * The heading the plan gives the robot at one end of a segment of a path step, in radians, or null
 * when the step cannot be planned. This, not the point's own `headingRad`, is the heading the robot
 * has there: the step's heading mode alone decides it.
 */
export function plannedPointHeading(stepId: string, target: SegmentEnd): number | null {
  const planned = flattenSteps(currentDerived().plan?.steps ?? []).find((step) => step.id === stepId);
  return planned === undefined ? null : plannedHeadingAt(planned, target);
}

/** The path step `stepId` and where `target` sits along it, or null when it is not a path end. */
function pathPlace(stepId: string, target: PointTarget): { step: PathStep; place: PathPlace } | null {
  const auto = getState().auto;
  const step = auto === null ? undefined : findEntry(auto, stepId)?.step;
  if (step === undefined || !isPathStep(step) || target.pointKind === "control") return null;
  return { step, place: pathPlaceOf(step.segments.length, { segmentIndex: target.segmentIndex, pointKind: target.pointKind }) };
}

/**
 * The inspector's "Set it" on a path point: writes `valueRad` into the angle of the step's heading
 * mode that decides the heading there (`pointHeadingRule`), the way dragging that end's heading
 * arrow does. A point the path or a joint decides is left alone.
 */
export function writePointHeading(stepId: string, target: PointTarget, valueRad: number): void {
  const at = pathPlace(stepId, target);
  const heading = at?.step.heading;
  if (at === null || heading === undefined || pointHeadingRule(heading, at.place).kind !== "value") return;
  writeHeadingMode(stepId, withPointHeading(heading, at.place, valueRad));
}

/**
 * Turn (`R` by default) on a path point turns what the heading arrow at that end of the path turns: Constant's angle,
 * Linear's From at the first point or To at the last, or the same in a piecewise heading's first or
 * last range. It never writes the point's pose, whose `headingRad` turns nothing, so no waypoint is
 * unlinked. Where the path decides the heading (Tangent, Reverse tangent, Facing point), or at a
 * joint between two segments, it writes nothing and the status line says what decides it.
 */
function rotatePathPointHeading(
  stepId: string,
  target: PointTarget,
  direction: 1 | -1,
  options: KeyEditOptions = {},
): void {
  const at = pathPlace(stepId, target);
  if (at === null) return;
  const rule = pointHeadingRule(at.step.heading, at.place);
  const refusal = pointHeadingRefusal(stepId, rule, turnWords(keyLabel("rotate")));
  if (rule.kind !== "value" || at.step.heading === undefined) {
    if (refusal !== null) setStatus("info", refusal);
    return;
  }
  writeHeadingMode(stepId, withPointHeading(at.step.heading, at.place, rule.valueRad + direction * rotateRadians(getState().prefs)), options);
}

/**
 * Moves the selected start or path point by an offset in inches. The arrow keys pass
 * `{ history: !event.repeat }`, so a held key is one undo step (issue #161). With no point picked,
 * the end of the selected step moves only when it has a pose of its own; one that follows a waypoint
 * or `"current"` is left alone and the status line says how to move it.
 */
export function movePoint(dxIn: number, dyIn: number, options: KeyEditOptions = {}): void {
  if (getState().selection.start === true) {
    writeStartPose((start) => ({ xIn: start.xIn + dxIn, yIn: start.yIn + dyIn }), options);
    return;
  }
  const active = activePoint();
  if (active === null) return;
  if (active.fromStepEnd) {
    const auto = getState().auto;
    const source = auto === null ? undefined : pointSource(auto, active.entry.id, active.target);
    if (source === "current" || waypointOf(source) !== null) {
      setStatus("info", STEP_END_FOLLOWS);
      return;
    }
  }
  const at = resolvedPointPose(active.entry.id, active.target);
  if (at === null) return;
  writePoses(
    jointMoves(active.entry.id, active.target, {
      ...at,
      xIn: at.xIn + dxIn,
      yIn: at.yIn + dyIn,
      provenance: EDITOR_PROVENANCE,
    }),
    options,
  );
}

export const nudge = (dx: number, dy: number, far: boolean, options: KeyEditOptions = {}): void => {
  const numbers = editingNumbers(getState().prefs);
  const step = far ? numbers.nudgeFarIn : numbers.nudgeIn;
  movePoint(dx * step, dy * step, options);
};

/**
 * Turns the selected start's heading, or the heading at the selected path point, by the Rotate setting:
 * the keyboard form of the heading arrows. A path point turns its step's heading mode
 * (`rotatePathPointHeading`, issue #147).
 */
export function rotateHeading(direction: 1 | -1, options: KeyEditOptions = {}): void {
  if (getState().selection.start === true) {
    writeStartPose((start) => ({ headingRad: (start.headingRad ?? 0) + direction * rotateRadians(getState().prefs) }), options);
    return;
  }
  const active = activePoint();
  if (active === null || active.target.pointKind === "control") return;
  rotatePathPointHeading(active.entry.id, active.target, direction, options);
}

export const writeHeadingMode = (stepId: string, heading: Heading, options: KeyEditOptions = {}): void => {
  tryEdit((auto) => setHeadingMode(auto, stepId, heading), options);
};

/**
 * Sets a path step's `speedFraction`, or removes it with `null` (the inspector's empty field or its
 * Use the robot default chip), so the path drives at the robot's default again (issue #144).
 */
export const writeSpeed = (stepId: string, fraction: number | null): void => {
  tryEdit((auto) => setSpeed(auto, stepId, fraction ?? undefined));
};

/**
 * Sets or clears a path/command/wait step's `timeoutS`. `null` (the inspector's empty field) clears
 * it, which drops the key from canonical form rather than writing `timeoutS: null`
 * (`packages/core/src/edit/timing.ts` treats `undefined` as "no timeout").
 */
export const writeTimeout = (stepId: string, value: number | null): void => {
  tryEdit((auto) => setStepTimeout(auto, stepId, value ?? undefined));
};

/* ---- Inserting --------------------------------------------------------- */

/**
 * The step a new one goes after: the selected step, or the end of the routine when nothing is
 * selected. Every insert, from the menu, the palette, the keyboard or the canvas, lands here, so
 * inserting in the middle of a routine works the same way from all of them
 * (site/docs/editor.md, "The insert menu").
 */
export const insertAnchorId = (): string | undefined => selectedEntry()?.id;

/** What a default insert built, and a sentence for its status line when it could not start clean. */
interface Built {
  built: Step;
  note?: string;
}

/**
 * Inserts the step `build` returns after the anchor, selects it, tells the tour, and says where it
 * went: "Added turn after path3." or "Added wait at the end." (UI_GUIDE 9.15). Returns the new
 * step's id, or null when the edit was refused (the status line then says why).
 */
function insertStep(build: (auto: Auto) => Step | Built): string | null {
  const state = getState();
  const auto = state.auto;
  if (auto === null) return null;
  const after = insertAnchorId();
  const made = build(auto);
  const { built: step, note } = "built" in made ? made : { built: made, note: undefined };
  let id: string | null = null;
  tryEdit((current) => {
    const result = insertStepAfter(current, step, after, state.project?.waypoints);
    id = result.id;
    return result.auto;
  });
  if (getState().auto === auto || id === null) return null;
  selectStep(id);
  tourSignal("stepInserted");
  const added = after === undefined ? `Added ${id} at the end.` : `Added ${id} after ${after}.`;
  setStatus(note === undefined ? "ok" : "warn", note === undefined ? added : `${added} ${note}`);
  return id;
}

/**
 * Whether `step`, inserted after the anchor, raises no error on any step it brings: what a default
 * insert must do, so nobody inherits a problem they did not draw (issue #498). It runs the same
 * checks Problems shows. An error of a kind the anchor already has does not count: a step that ends
 * inside a structure hands that to whatever starts there, and the person drew it. Without a robot or
 * a field nothing is checked, and it counts as clean.
 */
function insertsClean(auto: Auto, step: Step): boolean {
  const state = getState();
  const robot = currentRobot();
  const field = state.autoField ?? state.project?.field ?? null;
  if (robot === null || field === null) return true;
  const waypoints = state.project?.waypoints;
  let candidate: Auto;
  try {
    candidate = insertStepAfter(auto, step, insertAnchorId(), waypoints).auto;
  } catch {
    return false;
  }
  const brought = collectIds([step]);
  const anchor = insertAnchorId();
  const drawn = new Set(
    currentDerived()
      .findings.filter((finding) => finding.severity === "error" && anchor !== undefined && finding.stepId === anchor)
      .map((finding) => finding.code),
  );
  const findings = candidateFindings(candidate, robot, field, waypoints);
  return (
    findings !== null &&
    !findings.some(
      (finding) =>
        finding.severity === "error" && finding.stepId !== undefined && brought.has(finding.stepId) && !drawn.has(finding.code),
    )
  );
}

/**
 * The findings Problems would show for `auto`, by the same resolve, plan, estimate and checks
 * `derive` runs, without the picture and the ledger it also draws: a default insert tries a few
 * candidates, so this stays quick. Null when the candidate cannot be planned at all.
 */
function candidateFindings(auto: Auto, robot: Robot, field: Field, waypoints: Waypoints | undefined): readonly Finding[] | null {
  const resolved = safeResolve(auto, waypoints, robot);
  if (!resolved.ok) return null;
  const planned = safePlan(resolved.value, robot, field);
  if (!planned.ok) return null;
  const estimate = safeEstimate(planned.value, robot);
  const checked = safeCheck(planned.value, estimate.ok ? estimate.value : null, robot, field, resolveSeason(field).rules);
  return checked.ok ? checked.value : planned.value.findings;
}

/** The turns, in eighths of a turn from the way the robot faces, a default leg tries after straight ahead. */
const LEG_TURNS = [1, -1, 2, -2, 3, -3, 4] as const;

/**
 * The legs a default insert tries, best first: `legFromAnchor`'s, then the full reach and then a
 * shorter one toward each other eighth of a turn, holding the anchor's heading so only the robot's
 * position moves. Each is cut short to stay on the field, and one shorter than 12 in is left out.
 */
function legCandidates(id: string): PathStep[] {
  const first = legFromAnchor(id);
  const start = anchorEndPose();
  const robot = currentRobot();
  const field = getState().autoField ?? getState().project?.field ?? null;
  if (robot === null || field === null) return [first];
  const legs = [first];
  for (const turn of LEG_TURNS) {
    const directionRad = wrapAngle(start.headingRad + (turn * Math.PI) / 4);
    for (const wanted of [NEW_PATH_REACH_IN, NEW_PATH_MIN_REACH_IN]) {
      const reach = reachInsideField(start, directionRad, start.headingRad, wanted, robot, field);
      if (reach < NEW_PATH_MIN_REACH_IN) continue;
      const to: Pose = {
        xIn: start.xIn + reach * Math.cos(directionRad),
        yIn: start.yIn + reach * Math.sin(directionRad),
        headingRad: start.headingRad,
        provenance: EDITOR_PROVENANCE,
      };
      legs.push(newPathStep(id, "current", to, heldPathHeading(start.headingRad)));
    }
  }
  return legs;
}

/**
 * The first step `wrap` makes from a default leg that inserts clean (`insertsClean`), or null when
 * every leg from the anchor hits something (issue #498).
 */
function clearLeg(auto: Auto, id: string, wrap: (leg: PathStep) => Step): Step | null {
  for (const leg of legCandidates(id)) {
    const step = wrap(leg);
    if (insertsClean(auto, step)) return step;
  }
  return null;
}

/** The robot the open auto is checked against. */
const currentRobot = () => getState().autoRobot ?? getState().project?.robot ?? null;

/**
 * The pose the robot is at when the anchor step ends, which is where a new path starts: the
 * selected step's end, wherever it sits in the tree, or the routine's end.
 */
export function anchorEndPose(): Required<Pick<Pose, "xIn" | "yIn" | "headingRad">> {
  const resolved = currentDerived().resolved;
  const anchor = insertAnchorId();
  const steps = resolved?.steps ?? [];
  const at =
    anchor === undefined
      ? steps[steps.length - 1]?.endPose
      : flattenResolved(steps).find((step) => step.id === anchor)?.endPose;
  const pose = at ?? resolved?.startPose ?? { xIn: 0, yIn: 0, headingRad: 0 };
  return { xIn: pose.xIn, yIn: pose.yIn, headingRad: pose.headingRad ?? 0 };
}

/**
 * The leg a path inserted after the anchor drives (QA-04): 24 in along the way the robot faces
 * there, cut short so the footprint stays on the field, facing the way it drives. When that leaves
 * less than 12 in, because the anchor faces a nearby wall, the leg aims 24 in toward the field
 * centre instead, cut short the same way, and holds the anchor's heading rather than turning to
 * face the centre: turning on the spot next to a wall is what swings a corner off the field. With
 * the heading held, the footprint only slides between two poses that both fit, so it fits all the
 * way, and the new path can never raise PERIMETER. The held heading is Linear from the anchor's
 * heading to itself, as any new path's is with the default settings, and Constant only when the
 * person's heading for new paths is Constant (`heldPathHeading`, issue #445).
 */
function legFromAnchor(id: string): PathStep {
  const start = anchorEndPose();
  const robot = currentRobot();
  const field = getState().autoField ?? getState().project?.field ?? null;
  const to = (directionRad: number, reachIn: number, headingRad: number): Pose => ({
    xIn: start.xIn + reachIn * Math.cos(directionRad),
    yIn: start.yIn + reachIn * Math.sin(directionRad),
    headingRad,
    provenance: EDITOR_PROVENANCE,
  });
  // The setting's heading. The leg drives the way the robot faces, so it ends at the heading it
  // arrives with: Linear turns by nothing and Constant holds it.
  const ahead = (reachIn: number): PathStep =>
    newPathStep(id, "current", to(start.headingRad, reachIn, start.headingRad), newPathHeading(start.headingRad, start.headingRad));
  if (robot === null || field === null) return ahead(NEW_PATH_REACH_IN);

  const reach = reachInsideField(start, start.headingRad, start.headingRad, NEW_PATH_REACH_IN, robot, field);
  if (reach >= NEW_PATH_MIN_REACH_IN) return ahead(reach);

  const wall = fieldBounds(field);
  const centre = { xIn: (wall.minXIn + wall.maxXIn) / 2, yIn: (wall.minYIn + wall.maxYIn) / 2 };
  const towardCentre = Math.atan2(centre.yIn - start.yIn, centre.xIn - start.xIn);
  const toCentreIn = Math.hypot(centre.xIn - start.xIn, centre.yIn - start.yIn);
  const inward = reachInsideField(
    start,
    towardCentre,
    start.headingRad,
    Math.min(NEW_PATH_REACH_IN, toCentreIn),
    robot,
    field,
  );
  // The no-room-ahead leg holds the anchor's heading whatever the setting says, as explained above.
  // A held heading is Linear from that heading to itself, and Constant only for a person whose
  // setting is Constant (issue #445).
  return newPathStep(id, "current", to(towardCentre, inward, start.headingRad), heldPathHeading(start.headingRad));
}

export function addPathStep(): string | null {
  // With Extend this chain on and a path step selected, Insert a path adds to its chain (issue #204).
  const extend = chainToExtend();
  if (extend !== null) return appendPathToChain(extend) ? extend : null;
  // `"current"` resolves to the end of the step before it (packages/core/src/resolve.ts), and the
  // step before it is the anchor, so the new path continues from the anchor, not the routine's end.
  // The leg is one that hits nothing, when there is one (issue #498).
  return insertStep((auto) => {
    const id = freshPathId(auto);
    const clear = clearLeg(auto, id, (leg) => leg);
    if (clear !== null) return clear;
    return { built: legFromAnchor(id), note: "Every short leg from here hits something, so drag its end somewhere clear." };
  });
}

/** How far a new turn on the spot turns, counter-clockwise: a quarter turn. */
const NEW_TURN_RAD = Math.PI / 2;

/**
 * A turn on the spot after the anchor (issue #187, decision D10): a line from `"current"` to the
 * anchor's own end, so the step has no length, with a linear heading from the way the robot arrives
 * there to a quarter turn further round. The runtime holds the end heading until it settles. Where
 * the anchor is a path that ends on a waypoint, the turn's end follows the same waypoint, so moving
 * the waypoint moves both; otherwise it is the anchor's end, in numbers.
 *
 * It gets a `timeoutS`, `defaultTurnTimeoutS` (the estimate of a half turn plus a margin), so a
 * hold that never settles on the robot cannot stop the routine. With no robot loaded there is no
 * estimate to base one on, and the turn is written without.
 */
export function addTurnStep(): string | null {
  const arrival = anchorEndPose();
  const robot = currentRobot();
  const timeout = robot === null ? {} : { timeoutS: defaultTurnTimeoutS(robotLimits(robot)) };
  return insertStep((auto) => {
    const anchor = selectedEntry()?.step ?? auto.steps[auto.steps.length - 1];
    const end = anchor?.kind === "path" ? anchor.segments[anchor.segments.length - 1]?.to : undefined;
    const to: PoseSource =
      typeof end === "object" && "ref" in end ? { ref: end.ref } : { xIn: arrival.xIn, yIn: arrival.yIn, provenance: EDITOR_PROVENANCE };
    return {
      ...newPathStep(freshId(auto, "turn"), "current", to, {
        mode: "linear",
        fromRad: arrival.headingRad,
        toRad: wrapAngle(arrival.headingRad + NEW_TURN_RAD),
      }),
      ...timeout,
    };
  });
}

/**
 * A path step ending at a pose the user clicked, which is what the add-path tool produces. The end
 * gets the clicked spot only: the new step's heading mode decides which way the robot faces there,
 * so a heading written into the point would turn nothing (issue #147).
 *
 * `waypoint` is the waypoint the click snapped onto (issue #150): the end then follows it,
 * `{ ref }`, rather than copying its numbers, and the status line says so.
 *
 * With Extend this chain on and a path step selected (`chainToExtend`), the click adds a path to
 * that step's chain instead, from its end to the same point, and returns that step's id (issue #204).
 */
export function addPathStepTo(pose: Pose, waypoint?: string): string | null {
  const follows = followableWaypoint(waypoint);
  const to: PoseSource = follows === null ? { xIn: pose.xIn, yIn: pose.yIn, provenance: EDITOR_PROVENANCE } : { ref: follows };
  const extend = chainToExtend();
  if (extend !== null) return extendChainTo(extend, to, follows);
  // The end's heading is the one the add-path preview showed there; without one the robot keeps the
  // heading it arrives with.
  const arrival = anchorEndPose().headingRad;
  const heading = newPathHeading(arrival, pose.headingRad ?? arrival);
  const after = insertAnchorId();
  const id = insertStep((auto) => newPathStep(freshPathId(auto), "current", to, heading));
  if (id !== null && follows !== null) {
    setStatus("info", linkedMessage([{ what: pointName(id, { segmentIndex: 0, pointKind: "to" }), waypoint: follows }]));
  } else if (id !== null) {
    // Where the new path went, since the step list is the only other cue (issue #412).
    setStatus("info", after === undefined ? `Added ${id} at the end.` : `Added ${id} after ${after}.`);
  }
  return id;
}

export function addCommandStep(spec: CommandSpec): string | null {
  return insertStep((auto) => newCommandStep(freshId(auto, spec.name), spec));
}

export function addWaitStep(seconds = 0.5): string | null {
  return insertStep((auto) => ({ ...newWaitStep(freshId(auto, "wait")), seconds }));
}

export function addWaitUntil(condition: string): string | null {
  return insertStep((auto) => newUntilStep(freshId(auto, "waitUntil"), condition));
}

/**
 * A planner-only transfer of one piece, from the partner into this alliance's hive up cell when the
 * season counts both (`defaultTransferEnds`). The inspector then sets the places and the counts;
 * nothing about it reaches the robot.
 */
export function addTransferStep(): string | null {
  const state = getState();
  const field = state.autoField ?? state.project?.field ?? null;
  const season = currentDerived().season;
  return insertStep((auto) => {
    const ends = defaultTransferEnds(season, field, auto.alliance);
    const step: TransferStep = { id: freshId(auto, "transfer"), kind: "transfer", ...ends, expectedCount: 1 };
    return step;
  });
}



/** The first condition `robot.json` declares, or null with the reason on the status line. */
function firstCondition(): string | null {
  const condition = currentRobot()?.conditions?.[0]?.name;
  if (condition === undefined) {
    setStatus("error", "robot.json declares no conditions, so there is nothing to wait for or branch on.");
    return null;
  }
  return condition;
}

/**
 * A sequence holding one new path, ready to have more steps added inside it. The path is a leg that
 * hits nothing; when every leg from the anchor hits something, the sequence holds a wait instead,
 * so the group starts with no error either way (issue #498).
 */
export function addSequenceStep(): string | null {
  return insertStep((auto) => {
    const id = freshId(auto, "sequence");
    const legId = freshPathId(auto, [id]);
    const clear = clearLeg(auto, legId, (leg) => newSequenceStep(id, [leg]));
    if (clear !== null) return clear;
    const waitId = uniqueId("wait", new Set([...collectIds(auto.steps), id]));
    return { built: newSequenceStep(id, [newWaitStep(waitId)]), note: `No short leg from here is clear, so ${id} starts with a wait.` };
  });
}

/** Which member of a new deadline group ends it. */
export type DeadlineChoice = "drive" | "command";

/**
 * A parallel group of a drive and, when the robot registers a command, that command beside it:
 * the usual "drive while the intake runs". For a deadline group `deadline` picks which of the two
 * ends the group.
 */
export function addParallelStep(
  mode: ParallelStep["mode"] = "all",
  deadline: DeadlineChoice = "drive",
): string | null {
  const spec = currentRobot()?.commands[0];
  return insertStep((auto) => {
    const groupId = freshId(auto, "group");
    const driveId = uniqueId("drive", new Set([...collectIds(auto.steps), groupId]));
    // A command's name may hold a dot or a space; its step's id keeps to the step id rule.
    const commandId =
      spec === undefined ? undefined : stepIdFrom(spec.name, new Set([...collectIds(auto.steps), groupId, driveId]));
    const group = (first: Step): ParallelStep => {
      const children: Step[] = [first];
      if (spec !== undefined && commandId !== undefined) children.push(newCommandStep(commandId, spec));
      const chosen = deadline === "command" && commandId !== undefined ? commandId : (first.id ?? driveId);
      return newParallelStep(groupId, children, mode, mode === "deadline" ? chosen : undefined);
    };
    // The drive is a leg that hits nothing, as a new path's is; with none clear it is a wait, so the
    // group starts with no error either way (issue #498).
    const clear = clearLeg(auto, driveId, group);
    if (clear !== null) return clear;
    const waitId = uniqueId("wait", new Set([...collectIds(auto.steps), groupId, driveId]));
    return { built: group(newWaitStep(waitId)), note: `No short leg from here is clear, so ${groupId} waits where a drive would go.` };
  });
}

/** A branch on `condition`, with a placeholder wait in its then arm and, if asked, its else arm. */
export function addBranchStep(condition?: string, withElse = true): string | null {
  const on = condition ?? firstCondition();
  if (on === null) return null;
  return insertStep((auto) => {
    const id = freshId(auto, "branch");
    const thenId = uniqueId("ifTrue", new Set([...collectIds(auto.steps), id]));
    const elseId = uniqueId("ifFalse", new Set([...collectIds(auto.steps), id, thenId]));
    return newBranchStep(id, on, [newWaitStep(thenId)], withElse ? [newWaitStep(elseId)] : undefined);
  });
}

/**
 * Makes `nextStepId` start where the step before it ends, as when a middle insert leaves the step
 * after it with a gap. The Steps panel no longer offers this inline; Problems offers the same fix,
 * Start from robot, on the CONTINUITY row.
 */
export function connectStep(nextStepId: string): void {
  // The same fix CONTINUITY and MOVES_ROBOT offer in Problems, "Start from where the robot is".
  tryEdit((auto) => applyFix(auto, startFromCurrentFix(nextStepId)));
}

/* ---- Grouping ------------------------------------------------------------ */

/** The steps "wrap" acts on: the multi-selection when there is one, else the selected step. */
/**
 * Adds a marker that fires `commandName` at `at` along a path step, and selects it, so the
 * inspector opens the marker's own section straight away.
 */
export function placeMarker(stepId: string, at: MarkerAt, commandName: string): void {
  const before = getState().auto;
  tryEdit((auto) => addMarker(auto, stepId, { at, command: { name: commandName } }));
  const after = getState().auto;
  if (after === before || after === null) return;
  const entry = findEntry(after, stepId);
  if (entry === undefined || entry.step.kind !== "path") return;
  setSelection({ stepId, markerIndex: (entry.step.markers ?? []).length - 1 });
  // What was added and what it runs, since the command was picked for the person (issue #505).
  setStatus("ok", `Added a marker on ${stepId} ${markerPlace(at)} that runs ${commandName}.`, "Change its command in the Inspector.");
}

/** Where a marker sits, as the status line says it: "at 30 %", "12.0 in along" or "12.0 in before its end". */
export function markerPlace(at: MarkerAt): string {
  if ("t" in at) return `at ${String(Math.round(at.t * 100))} %`;
  if ("distanceIn" in at) return `${at.distanceIn.toFixed(1)} in along`;
  return `${at.distanceFromEndIn.toFixed(1)} in before its end`;
}

/**
 * Removes a marker and keeps the selection on what it was on: when the removed marker was the
 * selected one, its path stays selected on its own, and a later marker on that path keeps its
 * selection at its new index.
 */
export function deleteMarker(stepId: string, markerIndex: number): void {
  const before = getState().auto;
  tryEdit((auto) => removeMarker(auto, stepId, markerIndex));
  if (getState().auto === before) return;
  const selected = getState().selection;
  if (selected.stepId !== stepId || selected.markerIndex === undefined) return;
  if (selected.markerIndex === markerIndex) setSelection({ stepId });
  else if (selected.markerIndex > markerIndex) setSelection({ stepId, markerIndex: selected.markerIndex - 1 });
}

export function wrapTargets(): string[] {
  const { selection, multiSteps } = getState();
  if (multiSteps.length > 0) return [...multiSteps];
  return selection.stepId === undefined ? [] : [selection.stepId];
}

/** Why the selected steps cannot be wrapped together, in the words a student reads (issue #411). */
export const WRAP_NOT_SAME_LIST = "Pick steps in the same list to wrap them.";

/**
 * Null when the steps `ids` names can go into one group, or the reason they cannot: they must share
 * a list, the top level or one group's own list (one arm of a branch).
 */
export function wrapRefusal(auto: Auto | null, ids: readonly string[]): string | null {
  if (auto === null || ids.length < 2) return null;
  const entries = indexSteps(auto);
  const chosen = ids.map((id) => entries.find((entry) => entry.id === id));
  const first = chosen[0];
  if (first === undefined) return null;
  return chosen.every((entry) => entry !== undefined && entry.parentId === first.parentId && entry.arm === first.arm)
    ? null
    : WRAP_NOT_SAME_LIST;
}

export function wrapSelection(kind: WrapKind, mode: ParallelStep["mode"] = "all"): void {
  const auto = getState().auto;
  const ids = wrapTargets();
  if (auto === null || ids.length === 0) return;
  const refusal = wrapRefusal(auto, ids);
  if (refusal !== null) {
    setStatus("error", refusal);
    return;
  }
  let condition: string | undefined;
  if (kind === "branch") {
    const first = firstCondition();
    if (first === null) return;
    condition = first;
  }
  let id: string | null = null;
  tryEdit((current) => {
    const result = wrapSteps(current, ids, kind, { mode, condition, id: freshId(current, "branch") });
    id = result.id;
    return result.auto;
  });
  if (getState().auto === auto || id === null) return;
  selectStep(id);
  // In document order, as the list shows them, whatever order they were picked in.
  const order = indexSteps(auto).map((entry) => entry.id);
  const wrapped = [...ids].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  setStatus("ok", `Wrapped ${listed(wrapped)} in ${String(id)}.`);
}

/* ---- Renaming ------------------------------------------------------------ */

/**
 * Why `wanted` cannot be `stepId`'s new id, or null when it can, or when it is the id it has: the
 * rule a waypoint's name follows (core's `stepIdProblem`, issue #494).
 */
export function stepRenameProblem(stepId: string, wanted: string): string | null {
  const next = wanted.trim();
  if (next === stepId) return null;
  return stepIdProblem(next, getState().auto ?? undefined, stepId);
}

/** Says a rename was refused, and why: "A step's id starts with a letter ... driveOut keeps its id." */
export function refuseStepRename(stepId: string, problem: string): void {
  setStatus("error", `${problem} ${stepId} keeps its id.`);
}

/**
 * Renames a step from the step list (issue #494): an id outside the rule, or one another step has,
 * is refused with the reason on the status line; otherwise the step and every deadline that named
 * it take the new id, the step stays selected and the status line says "Renamed a to b."
 * Returns the step's id afterwards.
 */
export function renameStepTo(stepId: string, wanted: string): string {
  const auto = getState().auto;
  const next = wanted.trim();
  if (auto === null || next === stepId) return stepId;
  const problem = stepRenameProblem(stepId, next);
  if (problem !== null) {
    refuseStepRename(stepId, problem);
    return stepId;
  }
  tryEdit((current) => renameStep(current, stepId, next));
  if (getState().auto === auto) return stepId;
  selectStep(next);
  setStatus("ok", `Renamed ${stepId} to ${next}.`);
  return next;
}

export function unwrapSelection(): void {
  const auto = getState().auto;
  const entry = selectedEntry();
  if (auto === null || entry === undefined) return;
  tryEdit((current) => unwrapStep(current, entry.id));
  if (getState().auto === auto) return;
  selectStep(undefined);
  setStatus("ok", `Unwrapped ${entry.id}. Its steps stay where they were.`);
}

/* ---- Removing, duplicating, reordering --------------------------------- */

/**
 * Deletes what is selected: a selected waypoint pin, which only ever asks first, through the delete
 * dialog that names the autos following it (issue #232); a selected marker, or one selected path point (`deletePoint`), or
 * else what the step list shows selected: every step of a multi-selection, as one undo step, or
 * the selected step. A step inside a group that is deleted too goes with its group. When that
 * group also holds steps the feature switches hide, the delete waits for Delete all or Cancel
 * (`dialogs/DeleteHiddenDialog.tsx`), so nobody deletes what they cannot see without being told.
 */
export function deleteSelection(): void {
  const auto = getState().auto;
  if (auto === null) return;
  const { selection, multiSteps } = getState();
  // A selected pin is what Delete asks about, and nothing goes without the dialog's answer.
  if (selection.waypoint !== undefined) {
    // Deleting a waypoint goes with the Waypoints switch; Delete's action says why while it is off.
    if (getState().prefs.features.waypoints) askDeleteWaypoint(selection.waypoint);
    return;
  }
  // A selected marker is what Delete removes, as the canvas menu's Delete marker says; never its path.
  if (multiSteps.length === 0 && selection.stepId !== undefined && selection.markerIndex !== undefined) {
    deleteMarker(selection.stepId, selection.markerIndex);
    return;
  }
  // One selected path point is what Delete removes, joining the chain around it (issue #185).
  const onePoint = (selection.points?.length ?? 0) <= 1;
  if (multiSteps.length === 0 && selection.stepId !== undefined && selection.point !== undefined && onePoint) {
    deletePoint(selection.stepId, selection.point);
    return;
  }
  deleteSteps(wrapTargets());
}

/**
 * Deletes one step, the row it is called on (the header trash, the step menu, a swipe), and not
 * `wrapTargets()`: a right-click on a row that a multi-selection does not hold must not delete the
 * selection (issue #183). It shares every check `deleteSelection` makes and says what went.
 */
export function deleteStep(id: string): void {
  const auto = getState().auto;
  if (auto === null || findEntry(auto, id) === undefined) return;
  deleteSteps([id]);
}

/**
 * `lastStepRefusal` is what to say when the delete would leave the auto with no step, in place of
 * the plain refusal: a point's delete says why the point takes its step with it.
 */
function deleteSteps(ids: readonly string[], lastStepRefusal?: string): void {
  const auto = getState().auto;
  if (auto === null || ids.length === 0) return;
  const entries = indexSteps(auto);
  const topLevel = entries.filter((entry) => entry.depth === 0);
  if (topLevel.every((entry) => ids.includes(entry.id))) {
    setStatus(
      "error",
      lastStepRefusal ??
        (topLevel.length === 1
          ? "An auto needs at least one step; the last one cannot be deleted."
          : "An auto needs at least one step, so not every step can be deleted at once."),
    );
    return;
  }
  // A sequence or parallel group needs a step, so its last one cannot go while the group stays.
  const emptied = emptiedGroup(entries, ids);
  if (emptied !== undefined) {
    const inside = entries.filter((entry) => entry.parentId === emptied.id);
    setStatus(
      "error",
      needsAStep(emptied, inside.length === 1 ? `${inside[0]?.id ?? ""} cannot be deleted` : "not all of its steps can be deleted") +
        ` Delete ${emptied.id} to remove the group with it.`,
    );
    return;
  }
  // A step whose group is deleted too is left to go with the group: removing it first could leave
  // the group empty, which the format refuses.
  const parentOf = new Map(entries.map((entry) => [entry.id, entry.parentId]));
  const insideAnother = (id: string): boolean => {
    for (let at = parentOf.get(id); at !== undefined; at = parentOf.get(at)) if (ids.includes(at)) return true;
    return false;
  };
  const roots = ids.filter((id) => !insideAnother(id));
  const hidden = hiddenInside(auto, roots, getState().prefs.features);
  if (hidden > 0) {
    setDeleteHiddenPrompt({ ids: roots, hidden });
    return;
  }
  removeRoots(roots);
}

/**
 * Removes each step in `roots`, with everything inside it, as one undo step. A deadline group that
 * loses its deadline step passes the deadline on to another of its steps, and the status line says
 * which.
 */
function removeRoots(roots: readonly string[]): void {
  const before = getState().auto;
  if (before === null) return;
  const { selection, multiSteps, undo: undoBefore } = getState();
  // Everything that goes: each root and what is inside it.
  const entries = indexSteps(before);
  const parentOf = new Map(entries.map((entry) => [entry.id, entry.parentId]));
  const goes = (id: string): boolean => {
    for (let at: string | undefined = id; at !== undefined; at = parentOf.get(at)) if (roots.includes(at)) return true;
    return false;
  };
  const selectedGoes = (selection.stepId !== undefined && goes(selection.stepId)) || multiSteps.some(goes);
  let repointed: RepointedDeadline[] = [];
  tryEdit((current) => {
    const result = removeStepsReportingDeadlines(current, roots);
    repointed = result.repointedDeadlines;
    return result.auto;
  });
  if (getState().auto === before) return;
  // Undo selects again what the delete took away: what was selected, or the row a delete on an
  // unselected row removed (issue #183).
  rememberSelectionForUndo(before, undoBefore.length, selectedGoes ? { selection, multiSteps } : { selection: { stepId: roots[0] }, multiSteps: [] });
  // The row after the deleted ones takes the selection, or the one before when they were last, so
  // a second Delete keeps going (issue #411).
  if (selectedGoes) selectStep(rowAfterDelete(entries, goes, getState().auto));
  if (repointed.length > 0) {
    setStatus("info", repointedDeadlineMessage(repointed));
    return;
  }
  setStatus("info", deletedMessage(entries, roots));
}

/** What the status line says a delete took, for example "Deleted returnToScore and its 3 steps." */
export function deletedMessage(entries: readonly StepEntry[], roots: readonly string[]): string {
  if (roots.length !== 1) return `Deleted ${String(roots.length)} steps. Ctrl+Z puts them back.`;
  const root = roots[0]!;
  const inside = stepsInside(entries, root);
  return inside === 0
    ? `Deleted ${root}. Ctrl+Z puts it back.`
    : `Deleted ${root} and its ${String(inside)} ${inside === 1 ? "step" : "steps"}. Ctrl+Z puts them back.`;
}

/**
 * How many steps that run a group holds at any depth, leaving out the groups inside it: the steps a
 * person thinks of as being in it. `returnToScore` (a drive and a sequence of two) holds 3.
 */
export function stepsInside(entries: readonly StepEntry[], groupId: string): number {
  const parentOf = new Map(entries.map((entry) => [entry.id, entry.parentId]));
  const within = (id: string): boolean => {
    for (let at = parentOf.get(id); at !== undefined; at = parentOf.get(at)) if (at === groupId) return true;
    return false;
  };
  return entries.filter((entry) => !isGroupKind(entry.step.kind) && within(entry.id)).length;
}

/** The step a delete leaves selected: the first one after the deleted rows, else the last before them. */
function rowAfterDelete(entries: readonly StepEntry[], goes: (id: string) => boolean, after: Auto | null): string | undefined {
  if (after === null) return undefined;
  const left = new Set(indexSteps(after).map((entry) => entry.id));
  const first = entries.findIndex((entry) => goes(entry.id));
  if (first < 0) return undefined;
  const next = entries.slice(first).find((entry) => !goes(entry.id) && left.has(entry.id));
  if (next !== undefined) return next.id;
  return [...entries.slice(0, first)].reverse().find((entry) => left.has(entry.id))?.id;
}

/**
 * The start of the status line for an edit refused because it would leave `group` with no steps,
 * for example "clearThenSpinUp is a sequence and needs at least one step, so readyLauncher cannot
 * be deleted."
 */
function needsAStep(group: StepEntry, refused: string): string {
  const kind = group.step.kind === "parallel" ? "a parallel group" : "a sequence";
  return `${group.id} is ${kind} and needs at least one step, so ${refused}.`;
}

/** The delete dialog's answer: Delete all removes the steps it asked about, hidden ones included. */
export function answerDeleteHidden(choice: "delete" | "cancel"): void {
  const prompt = getState().deleteHiddenPrompt;
  setDeleteHiddenPrompt(null);
  if (prompt === null || choice === "cancel") return;
  removeRoots(prompt.ids);
}

/**
 * Duplicates what the step list shows selected: every step of a multi-selection, or the selected
 * step, each copy straight after its original, as one undo step (issue #411). A step inside a group
 * that is duplicated too goes with its group. A path's copy chains on (`chainedPathCopy`), and a
 * group's copy starts its opening paths from where the robot is (`chainedGroupCopy`), so Ctrl D adds
 * no CONTINUITY error the original did not have, and the status line names what was made.
 */
export function duplicateSelection(): void {
  const auto = getState().auto;
  if (auto === null) return;
  const ids = rootsOf(indexSteps(auto), wrapTargets());
  if (ids.length === 0) return;
  const resolved = flattenResolved(currentDerived().resolved?.steps ?? []);
  const made: { from: string; copy: string }[] = [];
  tryEdit((start) => {
    let current = start;
    for (const id of ids) {
      const entry = findEntry(current, id);
      if (entry === undefined) continue;
      const cloned = cloneWithFreshIds(current, entry.step);
      const original = resolved.find((step) => step.id === id);
      const copy =
        original === undefined
          ? cloned
          : cloned.kind === "path"
            ? chainedPathCopy(cloned, original)
            : chainedGroupCopy(entry.step, cloned, original, effectiveIds(current), resolved);
      current = addStep(current, copy, id);
      if (copy.id !== undefined) made.push({ from: id, copy: copy.id });
    }
    return current;
  });
  if (getState().auto === auto || made.length === 0) return;
  selectStep(made[0]!.copy);
  setStatus(
    "ok",
    made.length === 1 ? `Duplicated ${made[0]!.from} as ${made[0]!.copy}.` : `Duplicated ${String(made.length)} steps.`,
  );
}

/** The ids in `ids` that no other id in it holds: a step inside a group in the list goes with the group. */
function rootsOf(entries: readonly StepEntry[], ids: readonly string[]): string[] {
  const parentOf = new Map(entries.map((entry) => [entry.id, entry.parentId]));
  const insideAnother = (id: string): boolean => {
    for (let at = parentOf.get(id); at !== undefined; at = parentOf.get(at)) if (ids.includes(at)) return true;
    return false;
  };
  return entries.filter((entry) => ids.includes(entry.id) && !insideAnother(entry.id)).map((entry) => entry.id);
}

/**
 * A path's copy that repeats the original's move from where the original ends (issue #411): it
 * starts from `"current"`, and every point it owns moves by the original's start-to-end offset. An
 * end that followed a waypoint becomes a pose of its own at the moved spot, since the waypoint
 * stays where it is. A rejoin pose is dropped: the copy follows a path, whose end is known.
 */
function chainedPathCopy(copy: PathStep, original: ResolvedStep): PathStep {
  const dxIn = original.endPose.xIn - original.startPose.xIn;
  const dyIn = original.endPose.yIn - original.startPose.yIn;
  const shifted = (pose: Pose): Pose => ({ ...pose, xIn: pose.xIn + dxIn, yIn: pose.yIn + dyIn });
  const moved = (source: PoseSource, drawn: Pose | undefined): PoseSource => {
    if (source === "current") return source;
    if ("ref" in source) {
      if (drawn === undefined) return source;
      const own: Pose = { xIn: drawn.xIn, yIn: drawn.yIn, provenance: EDITOR_PROVENANCE };
      if (drawn.headingRad !== undefined) own.headingRad = drawn.headingRad;
      return shifted(own);
    }
    return shifted(source);
  };
  const segments = copy.segments.map((segment, index) => {
    const drawn = original.segments?.[index];
    const from = index === 0 ? "current" : moved(segment.from, drawn?.fromPose);
    const to = moved(segment.to, drawn?.toPose);
    return segment.kind === "bezier"
      ? { ...segment, from, to, control: segment.control.map(shifted) }
      : { ...segment, from, to };
  }) as PathStep["segments"];
  const out: PathStep = { ...copy, segments };
  delete out.rejoinFrom;
  return out;
}

/** Each step object of `auto` with the id the resolver and the plan give it. */
function effectiveIds(auto: Auto): Map<Step, string> {
  return new Map(indexSteps(auto).map((entry) => [entry.step, entry.id]));
}

/** How far a written start may be from where the group starts and still count as starting there: CONTINUITY's tolerance. */
const GROUP_START_TOLERANCE_IN = 0.5;

/**
 * A group's copy that starts where the original ends (issue #411): each path that opens the group,
 * the first step of a sequence or of a branch's side and every member of a parallel group, written
 * to start where the group starts, starts from `"current"` instead, so it follows whatever comes
 * before it. Everything else is copied as it is, so with the original deleted the copy drives the
 * original's route. A path that opens the group from somewhere else keeps its start, and the gap the
 * original had with it. `original` and `copy` have the same shape (`cloneWithFreshIds`); `ids` names
 * the original's steps, and `resolved` holds them.
 */
function chainedGroupCopy(
  original: Step,
  copy: Step,
  resolvedGroup: ResolvedStep,
  ids: ReadonlyMap<Step, string>,
  resolved: readonly ResolvedStep[],
): Step {
  const start = resolvedGroup.startPose;
  const opensAtStart = (from: Step): boolean => {
    const id = ids.get(from);
    const drawn = id === undefined ? undefined : resolved.find((step) => step.id === id)?.segments?.[0]?.fromPose;
    return drawn !== undefined && Math.hypot(drawn.xIn - start.xIn, drawn.yIn - start.yIn) <= GROUP_START_TOLERANCE_IN;
  };
  const walk = (from: Step, to: Step): Step => {
    if (to.kind === "path") {
      const first = to.segments[0];
      if (first === undefined || first.from === "current" || !opensAtStart(from)) return to;
      return { ...to, segments: [{ ...first, from: "current" }, ...to.segments.slice(1)] as PathStep["segments"] };
    }
    const fromLists = childLists(from);
    const toLists = childLists(to);
    if (toLists.length === 0) return to;
    // Every member of a parallel group starts where the group starts; elsewhere only a list's first step does.
    const opening = (at: number): boolean => to.kind === "parallel" || at === 0;
    return withChildLists(
      to,
      toLists.map((list, listIndex) =>
        list.map((member, at) => {
          const twin = fromLists[listIndex]?.[at];
          return twin === undefined || !opening(at) ? member : walk(twin, member);
        }),
      ),
    );
  };
  return walk(original, copy);
}

/**
 * Moves a step inside the list it already lives in. Every move is expressed as "insert after that
 * sibling", including the move to the front, which is two moves, because `moveStep`'s numeric form
 * always lands a step at the top level and that would silently lift a step out of its group.
 */
export function moveToIndex(stepId: string, toIndex: number): void {
  const auto = getState().auto;
  if (auto === null) return;
  const entries = indexSteps(auto);
  const entry = entries.find((candidate) => candidate.id === stepId);
  if (entry === undefined) return;
  const siblings = siblingsOf(entries, entry);
  const target = Math.max(0, Math.min(siblings.length - 1, toIndex));
  if (target === entry.index) return;

  if (target === 0) {
    const first = siblings[0];
    if (first === undefined) return;
    tryEdit((current) => moveStepInCore(moveStepInCore(current, stepId, first.id), first.id, stepId));
    sayMoved(auto, stepId, undefined, landedAt(entry, target));
    return;
  }
  // Moving down lands after the sibling now at `target`; moving up lands after the one before it.
  const anchor = siblings[target > entry.index ? target : target - 1];
  if (anchor === undefined) return;
  tryEdit((current) => moveStepInCore(current, stepId, anchor.id));
  sayMoved(auto, stepId, undefined, landedAt(entry, target));
}

/**
 * The id of the step at `index` in the list `entry` lives in, in the document now: where a move
 * inside that list put it. A positional step's id is its place, so it is not the id it had.
 */
function landedAt(entry: StepEntry, index: number): string | undefined {
  const after = getState().auto;
  return after === null ? undefined : siblingsOf(indexSteps(after), entry)[index]?.id;
}

/**
 * Where a move put `stepId`, for the status line (issue #505): "Moved wait into sequence1.", "Moved
 * wait out of sequence1.", or among the same list "Moved wait before path3." (or after the step
 * before it, at the end of a list). Null when the move did not happen. `nowId` is the id the step
 * has after the move, which for a positional step is its new place rather than `stepId`; the
 * message names it by `stepId`, the name it had when it was moved, and then by its new one:
 * "Moved step3, now step2, before step3."
 */
export function movedMessage(before: Auto, after: Auto, stepId: string, nowId = stepId): string | null {
  if (after === before) return null;
  const was = findEntry(before, stepId);
  const entries = indexSteps(after);
  const now = entries.find((candidate) => candidate.id === nowId);
  if (was === undefined || now === undefined) return null;
  const name = nowId === stepId ? stepId : `${stepId}, now ${nowId},`;
  if (now.parentId !== was.parentId) {
    // Out of its group when it now sits in a list that holds that group; otherwise into a new one.
    const left = was.parentId !== undefined && (now.parentId === undefined || isInsideOf(entries, was.parentId, now.parentId));
    return left ? `Moved ${name} out of ${was.parentId ?? ""}.` : `Moved ${name} into ${now.parentId ?? ""}.`;
  }
  const siblings = siblingsOf(entries, now).filter((sibling) => sibling.arm === now.arm);
  const at = siblings.findIndex((sibling) => sibling.id === nowId);
  const next = siblings[at + 1];
  if (next !== undefined) return `Moved ${name} before ${next.id}.`;
  const previous = siblings[at - 1];
  if (previous !== undefined) return `Moved ${name} after ${previous.id}.`;
  return nowId === stepId ? `Moved ${stepId}.` : `Moved ${stepId}, now ${nowId}.`;
}

/** Whether the group `groupId` holds the step `inner` somewhere inside it. */
function isInsideOf(entries: readonly StepEntry[], inner: string, groupId: string): boolean {
  const parentOf = new Map(entries.map((entry) => [entry.id, entry.parentId]));
  for (let at = parentOf.get(inner); at !== undefined; at = parentOf.get(at)) if (at === groupId) return true;
  return false;
}

/** Writes `movedMessage` for a move that happened, with `more` after it. */
function sayMoved(before: Auto, stepId: string, more?: string, nowId?: string): void {
  const after = getState().auto;
  const moved = after === null ? null : movedMessage(before, after, stepId, nowId);
  if (moved === null) return;
  setStatus(more === undefined ? "ok" : "info", more === undefined ? moved : `${moved} ${more}`);
}

/**
 * Moves the selected step one row up or down the list, the keyboard's way of doing what a drag does
 * (site/docs/editor.md, "Steps panel"), so it also moves a step into and out of a group:
 *
 * - Next to another step in its own list, it swaps with it. A hidden sibling is never swapped with:
 *   the step moves past the next visible one, and the hidden ones stay put (`visibleMoveIndex` in
 *   `state/features.ts` has the rule).
 * - Next to a group the list shows open, it goes inside, as a drop onto the group does: moving down
 *   makes it the group's first step, moving up its last. A folded group is passed over whole.
 * - At the top or bottom of a group, it leaves the group, landing just before or just after it. In a
 *   branch, it crosses from the else arm to the end of the then arm, or from the then arm to the
 *   start of a non-empty else arm, before it leaves.
 * - At the top or bottom of the whole list, nothing happens.
 */
export function moveSelection(delta: -1 | 1): void {
  const { auto, fileName, prefs } = getState();
  const entry = selectedEntry();
  if (auto === null || entry === undefined) return;
  const entries = indexSteps(auto);
  const siblings = siblingsOf(entries, entry);
  const target = visibleMoveIndex(
    siblings.map((sibling) => sibling.id),
    entry.index,
    delta,
    hiddenStepIds(auto, prefs.features),
  );
  const childrenOf = (id: string): StepEntry[] => entries.filter((other) => other.parentId === id);
  if (target !== null) {
    const neighbour = siblings[target];
    const open =
      neighbour !== undefined &&
      isGroupKind(neighbour.step.kind) &&
      !prefs.foldedGroups.includes(foldKey(fileName, neighbour.id));
    if (neighbour === undefined || !open) {
      moveToIndex(entry.id, target);
      return;
    }
    const last = childrenOf(neighbour.id).at(-1);
    if (delta === -1 && last !== undefined) moveStepTo(entry.id, last.id, "after");
    else moveStepTo(entry.id, neighbour.id, "into");
    return;
  }
  if (entry.parentId === undefined) return;
  const parent = entries.find((other) => other.id === entry.parentId);
  if (parent === undefined) return;
  if (parent.step.kind === "branch") {
    const arm = (name: "then" | "else"): StepEntry[] => childrenOf(parent.id).filter((child) => child.arm === name);
    const lastThen = arm("then").at(-1);
    const firstElse = arm("else")[0];
    if (entry.arm === "else" && delta === -1) {
      if (lastThen !== undefined) moveStepTo(entry.id, lastThen.id, "after");
      else moveStepTo(entry.id, parent.id, "into");
      return;
    }
    if (entry.arm === "then" && delta === 1 && firstElse !== undefined) {
      moveStepTo(entry.id, firstElse.id, "before");
      return;
    }
  }
  moveStepTo(entry.id, parent.id, delta === -1 ? "before" : "after");
}

/**
 * Drops a dragged step before or after another, or into a group as its first step, wherever the
 * two sit in the tree: the step list's drag and drop, which is how a step moves into or out of a
 * group. Dragging a group's deadline member out of it clears that choice: the group's deadline passes
 * to its first remaining step that drives, or its first step, the same pick as switching the group
 * to deadline, so the group stays valid, and the status line says so (issues #160 and #144).
 */
export function moveStepTo(sourceId: string, targetId: string, position: DropPosition): void {
  if (sourceId === targetId) return;
  const before = getState().auto;
  if (before === null) return;
  // The only step of a sequence or parallel group cannot leave it: the group would be left empty.
  const emptied = emptiedGroup(indexSteps(before), [sourceId]);
  if (emptied !== undefined && !(position === "into" && targetId === emptied.id)) {
    setStatus("error", needsAStep(emptied, `${sourceId} cannot leave it`) + ` Unwrap ${emptied.id} to take the step out.`);
    return;
  }
  let repointed: RepointedDeadline[] = [];
  let movedId: string | undefined;
  tryEdit((auto) => {
    const result = moveStepReportingDeadlines(auto, sourceId, targetId, position);
    repointed = result.repointedDeadlines;
    movedId = result.movedId;
    return result.auto;
  });
  sayMoved(before, sourceId, repointed.length > 0 ? repointedDeadlineMessage(repointed) : undefined, movedId);
}

/** "press Ctrl Z to undo", or "use Undo" while the person has left Undo without a key. */
export function undoWords(): string {
  const key = keyLabel("undo");
  return key === undefined ? "use Undo" : `press ${key} to undo`;
}

/**
 * The status line for deadlines an edit passed on, for example "driveBack was the deadline of
 * returnToScore, so clearThenSpinUp is its deadline now. Pick another in the Inspector, or press
 * Ctrl Z to undo."
 */
export function repointedDeadlineMessage(repointed: readonly RepointedDeadline[]): string {
  const what = repointed
    .map((entry) => `${entry.deadline} was the deadline of ${entry.groupId}, so ${entry.newDeadline} is its deadline now`)
    .join("; ");
  const pick = repointed.length === 1 ? "another" : "others";
  return `${what}. Pick ${pick} in the Inspector, or ${undoWords()}.`;
}
