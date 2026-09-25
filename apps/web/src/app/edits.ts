/**
 * The edits the toolbar, the palette, the keyboard, the inspector and the canvas all perform, in
 * one place, so a drag and its keyboard equivalent are literally the same call (UI_GUIDE section 9).
 *
 * Every mutation goes through `@horizon36596/zenith-core`'s edit primitives, which validate the result, so the
 * editor can never write a document the schema would reject.
 */
import {
  addStep,
  applyFix,
  fieldBounds,
  footprintBoundsIn,
  collectIds,
  degToRad,
  uniqueId,
  moveStep as moveStepInCore,
  removeStep as removeStepInCore,
  setHeadingMode,
  setPose,
  setSpeed,
  setTimeout as setStepTimeout,
  type PoseTarget,
} from "@horizon36596/zenith-core";
import type {
  Auto,
  CommandSpec,
  Field,
  Heading,
  ParallelStep,
  PathStep,
  Pose,
  PoseSource,
  Robot,
  Step,
} from "@horizon36596/zenith-schema";
import type { PointTarget } from "../canvas/types";
import { EDITOR_PROVENANCE } from "@horizon36596/zenith-core";
import {
  cloneWithFreshIds,
  findEntry,
  freshId,
  indexSteps,
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
import {
  flattenResolved,
  insertStepAfter,
  moveStepRelative,
  repairContinuity,
  unwrapStep,
  updateStep,
  wrapSteps,
  type DropPosition,
  type WrapKind,
} from "../lib/structure";
import { commit, currentDerived, getState, selectStep, setStatus } from "../state/store";
import { tourSignal } from "../tour/store";
import { NUDGE_IN, ROTATE_DEG } from "./shortcuts";

/** How far ahead of the previous end pose a freshly added path puts its endpoint, in inches. */
const NEW_PATH_REACH_IN = 24;

/**
 * The shortest leg worth keeping along the anchor's heading once it is clamped to the field, in
 * inches; anything shorter aims at the field centre instead (QA-04, the coordinator's rule).
 */
const NEW_PATH_MIN_REACH_IN = 12;

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
  const flat = [...resolved.steps];
  for (const step of resolved.steps) if (step.children !== undefined) flat.push(...step.children);
  const step = flat.find((candidate) => candidate.id === stepId);
  const segment = step?.segments?.[target.segmentIndex];
  if (segment === undefined) return null;
  if (target.pointKind === "from") return segment.fromPose;
  if (target.pointKind === "to") return segment.toPose;
  const control = segment.pointsIn[(target.controlIndex ?? 0) + 1];
  return control === undefined ? null : { ...control, headingRad: segment.fromPose.headingRad };
}

const asPoseTarget = (target: PointTarget): PoseTarget => ({
  segmentIndex: target.segmentIndex,
  pointKind: target.pointKind,
  controlIndex: target.controlIndex ?? 0,
});

/** The point a nudge or a rotate acts on: the selected one, or the end of the selected step. */
export function activePoint(): { entry: StepEntry; target: PointTarget } | null {
  const entry = selectedEntry();
  if (entry === undefined || !isPathStep(entry.step)) return null;
  const selected = getState().selection.point;
  if (selected !== undefined) return { entry, target: selected };
  return { entry, target: { segmentIndex: entry.step.segments.length - 1, pointKind: "to" } };
}

/** Writes a pose into one point of a path step. The canvas drag and the arrow keys both land here. */
export function writePose(
  stepId: string,
  target: PointTarget,
  pose: Pose,
  options: { history?: boolean } = {},
): void {
  tryEdit(
    (auto) =>
      setPose(auto, stepId, asPoseTarget(target), {
        xIn: pose.xIn,
        yIn: pose.yIn,
        headingRad: pose.headingRad,
        provenance: pose.provenance ?? EDITOR_PROVENANCE,
      }),
    options,
  );
}

/**
 * Several points moved in one frame, as one edit: a group drag, an endpoint carrying its curve
 * handles, or a smooth node mirroring the handle opposite the one dragged.
 */
export function writePoses(
  moves: ReadonlyArray<{ stepId: string; target: PointTarget; pose: Pose }>,
): void {
  if (moves.length === 0) return;
  tryEdit((auto) =>
    moves.reduce(
      (doc, move) =>
        setPose(doc, move.stepId, asPoseTarget(move.target), {
          xIn: move.pose.xIn,
          yIn: move.pose.yIn,
          headingRad: move.pose.headingRad,
          provenance: move.pose.provenance ?? EDITOR_PROVENANCE,
        }),
      auto,
    ),
  );
}

/**
 * Splits one segment of a path step in two at its own curve parameter `u` (QA-10).
 *
 * Core splits only a segment whose ends are both inline poses, and leaves resolving `"current"` or a
 * waypoint to the caller. So the ends are resolved here, through the same resolve the canvas draws
 * from, the split is made on those numbers, and then the original ends are put back: the first half
 * still starts from `"current"` or its waypoint, the second half still ends at the original `to`, and
 * only the new point in the middle is an explicit pose.
 */
export function splitSegmentAt(stepId: string, segmentIndex: number, u: number): void {
  const auto = getState().auto;
  if (auto === null) return;
  const resolved = currentDerived().resolved;
  const drawn = resolved === null ? undefined : flattenResolved(resolved.steps).find((step) => step.id === stepId);
  const ends = drawn?.segments?.[segmentIndex];
  const fix = { kind: "splitSegment" as const, stepId, label: "Split here", params: { segmentIndex, u } };
  tryEdit((current) => {
    const original = findEntry(current, stepId)?.step;
    const segment = original !== undefined && isPathStep(original) ? original.segments[segmentIndex] : undefined;
    if (original === undefined || !isPathStep(original) || segment === undefined) {
      throw new Error(`There is no segment ${String(segmentIndex + 1)} on ${stepId} to split.`);
    }
    if (ends === undefined) {
      throw new Error(`${stepId} cannot be drawn yet, so there is nowhere on it to split.`);
    }
    const asNumbers = (source: PoseSource, at: { xIn: number; yIn: number }): PoseSource =>
      source === "current" || "ref" in source ? { xIn: at.xIn, yIn: at.yIn } : source;
    const inlined: PathStep = {
      ...original,
      segments: original.segments.map((candidate, index) =>
        index === segmentIndex
          ? { ...candidate, from: asNumbers(candidate.from, ends.fromPose), to: asNumbers(candidate.to, ends.toPose) }
          : candidate,
      ),
    };
    const replace = (steps: readonly Step[], step: Step): Step[] =>
      updateStep(steps, "step", stepId, () => step).steps;
    const split = applyFix({ ...current, steps: replace(current.steps, inlined) }, fix);
    const halves = findEntry(split, stepId)?.step;
    if (halves === undefined || !isPathStep(halves) || halves.segments.length !== original.segments.length + 1) {
      throw new Error("That point is at the very end of the segment, so there is nothing to split off.");
    }
    const first = halves.segments[segmentIndex];
    const second = halves.segments[segmentIndex + 1];
    if (first === undefined || second === undefined) return current;
    const middle = { ...(second.from as Pose), provenance: EDITOR_PROVENANCE };
    const segments = halves.segments.map((candidate, index) => {
      if (index === segmentIndex) return { ...candidate, from: segment.from, to: middle };
      if (index === segmentIndex + 1) return { ...candidate, from: middle, to: segment.to };
      return candidate;
    });
    return { ...current, steps: replace(current.steps, { ...original, segments }) };
  });
}

export function movePoint(dxIn: number, dyIn: number): void {
  const active = activePoint();
  if (active === null) return;
  const at = resolvedPointPose(active.entry.id, active.target);
  if (at === null) return;
  writePose(active.entry.id, active.target, {
    ...at,
    xIn: at.xIn + dxIn,
    yIn: at.yIn + dyIn,
    provenance: EDITOR_PROVENANCE,
  });
}

export const nudge = (dx: number, dy: number, far: boolean): void => {
  const step = far ? NUDGE_IN * 4 : NUDGE_IN;
  movePoint(dx * step, dy * step);
};

/** Turns the selected point's heading by `ROTATE_DEG`: the keyboard form of the heading handle. */
export function rotateHeading(direction: 1 | -1): void {
  const active = activePoint();
  if (active === null || active.target.pointKind === "control") return;
  const at = resolvedPointPose(active.entry.id, active.target);
  if (at === null) return;
  writePose(active.entry.id, active.target, {
    ...at,
    headingRad: (at.headingRad ?? 0) + direction * degToRad(ROTATE_DEG),
    provenance: EDITOR_PROVENANCE,
  });
}

export const writeHeadingMode = (stepId: string, heading: Heading): void => {
  tryEdit((auto) => setHeadingMode(auto, stepId, heading));
};

export const writeSpeed = (stepId: string, fraction: number): void => {
  tryEdit((auto) => setSpeed(auto, stepId, fraction));
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

/**
 * Inserts the step `build` returns after the anchor, selects it, and tells the tour. Returns the
 * new step's id, or null when the edit was refused (the status line then says why).
 */
function insertStep(build: (auto: Auto) => Step): string | null {
  const state = getState();
  const auto = state.auto;
  if (auto === null) return null;
  const after = insertAnchorId();
  const step = build(auto);
  let id: string | null = null;
  tryEdit((current) => {
    const result = insertStepAfter(current, step, after, state.project?.waypoints);
    id = result.id;
    return result.auto;
  });
  if (getState().auto === auto || id === null) return null;
  selectStep(id);
  tourSignal("stepInserted");
  return id;
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
 * How far the robot can drive from `start` along `directionRad`, up to `wantIn`, with its whole
 * footprint (body and mouths, at `headingRad`) still inside the field. The footprint's box at a
 * fixed heading only translates with the pose, so the room left is a per-axis bound on the centre.
 */
function reachInsideField(
  start: { xIn: number; yIn: number },
  directionRad: number,
  headingRad: number,
  wantIn: number,
  robot: Robot,
  field: Field,
): number {
  const box = footprintBoundsIn({ xIn: 0, yIn: 0, headingRad }, robot);
  const wall = fieldBounds(field);
  const low = { xIn: wall.minXIn - box.minXIn, yIn: wall.minYIn - box.minYIn };
  const high = { xIn: wall.maxXIn - box.maxXIn, yIn: wall.maxYIn - box.maxYIn };
  const along = (from: number, step: number, min: number, max: number): number => {
    if (Math.abs(step) < 1e-9) return Infinity;
    return ((step > 0 ? max : min) - from) / step;
  };
  const dx = Math.cos(directionRad);
  const dy = Math.sin(directionRad);
  const room = Math.min(along(start.xIn, dx, low.xIn, high.xIn), along(start.yIn, dy, low.yIn, high.yIn));
  return Math.max(0, Math.min(wantIn, room));
}

/**
 * The leg a path inserted after the anchor drives (QA-04): 24 in along the way the robot faces
 * there, cut short so the footprint stays on the field, facing the way it drives. When that leaves
 * less than 12 in, because the anchor faces a nearby wall, the leg aims 24 in toward the field
 * centre instead, cut short the same way, and holds the anchor's heading rather than turning to
 * face the centre: turning on the spot next to a wall is what swings a corner off the field. With
 * the heading held, the footprint only slides between two poses that both fit, so it fits all the
 * way, and the new path can never raise PERIMETER.
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
  const ahead = (reachIn: number): PathStep =>
    newPathStep(id, "current", to(start.headingRad, reachIn, start.headingRad));
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
  return {
    ...newPathStep(id, "current", to(towardCentre, inward, start.headingRad)),
    heading: { mode: "constant", headingRad: start.headingRad },
  };
}

export function addPathStep(): string | null {
  // `"current"` resolves to the end of the step before it (packages/core/src/resolve.ts), and the
  // step before it is the anchor, so the new path continues from the anchor, not the routine's end.
  return insertStep((auto) => legFromAnchor(freshId(auto, "path")));
}

/** A path step ending at a pose the user clicked, which is what the add-path tool produces. */
export function addPathStepTo(pose: Pose): string | null {
  return insertStep((auto) =>
    newPathStep(freshId(auto, "path"), "current", { ...pose, provenance: EDITOR_PROVENANCE }),
  );
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



/** The first condition `robot.json` declares, or null with the reason on the status line. */
function firstCondition(): string | null {
  const condition = currentRobot()?.conditions?.[0]?.name;
  if (condition === undefined) {
    setStatus("error", "robot.json declares no conditions, so there is nothing to wait for or branch on.");
    return null;
  }
  return condition;
}

/** A sequence holding one new path, ready to have more steps added inside it. */
export function addSequenceStep(): string | null {
  return insertStep((auto) => {
    const id = freshId(auto, "sequence");
    const legId = uniqueId("leg", new Set([...collectIds(auto.steps), id]));
    return newSequenceStep(id, [legFromAnchor(legId)]);
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
    const children: Step[] = [legFromAnchor(driveId)];
    let commandId: string | undefined;
    if (spec !== undefined) {
      commandId = uniqueId(spec.name, new Set([...collectIds(auto.steps), groupId, driveId]));
      children.push(newCommandStep(commandId, spec));
    }
    const chosen = deadline === "command" && commandId !== undefined ? commandId : driveId;
    return newParallelStep(groupId, children, mode, mode === "deadline" ? chosen : undefined);
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
 * Makes `nextStepId` start where the step before it ends: the inline "Connect the next step" fix a
 * middle insert offers when the step after it now has a gap.
 */
export function connectStep(nextStepId: string): void {
  tryEdit((auto) => repairContinuity(auto, nextStepId));
}

/* ---- Grouping ------------------------------------------------------------ */

/** The steps "wrap" acts on: the multi-selection when there is one, else the selected step. */
export function wrapTargets(): string[] {
  const { selection, multiSteps } = getState();
  if (multiSteps.length > 0) return [...multiSteps];
  return selection.stepId === undefined ? [] : [selection.stepId];
}

export function wrapSelection(kind: WrapKind, mode: ParallelStep["mode"] = "all"): void {
  const auto = getState().auto;
  const ids = wrapTargets();
  if (auto === null || ids.length === 0) return;
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
  if (getState().auto !== auto && id !== null) selectStep(id);
}

export function unwrapSelection(): void {
  const auto = getState().auto;
  const entry = selectedEntry();
  if (auto === null || entry === undefined) return;
  tryEdit((current) => unwrapStep(current, entry.id));
  if (getState().auto !== auto) selectStep(undefined);
}

/* ---- Removing, duplicating, reordering --------------------------------- */

export function deleteSelection(): void {
  const auto = getState().auto;
  const entry = selectedEntry();
  if (auto === null || entry === undefined) return;
  if (auto.steps.length === 1 && entry.depth === 0) {
    setStatus("error", "An auto needs at least one step; the last one cannot be deleted.");
    return;
  }
  tryEdit((current) => removeStepInCore(current, entry.id));
  selectStep(undefined);
}

export function duplicateSelection(): void {
  const auto = getState().auto;
  const entry = selectedEntry();
  if (auto === null || entry === undefined) return;
  const copy = cloneWithFreshIds(auto, entry.step);
  tryEdit((current) => addStep(current, copy, entry.id));
  if (copy.id !== undefined) selectStep(copy.id);
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
    return;
  }
  // Moving down lands after the sibling now at `target`; moving up lands after the one before it.
  const anchor = siblings[target > entry.index ? target : target - 1];
  if (anchor === undefined) return;
  tryEdit((current) => moveStepInCore(current, stepId, anchor.id));
}

export function moveSelection(delta: -1 | 1): void {
  const entry = selectedEntry();
  if (entry === undefined) return;
  moveToIndex(entry.id, entry.index + delta);
}

/**
 * Drops a dragged step before or after another, or into a group as its first step, wherever the
 * two sit in the tree: the step list's drag and drop, which is how a step moves into or out of a
 * group.
 */
export function moveStepTo(sourceId: string, targetId: string, position: DropPosition): void {
  if (sourceId === targetId) return;
  tryEdit((auto) => moveStepRelative(auto, sourceId, targetId, position));
}
