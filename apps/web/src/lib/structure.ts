/**
 * The structural edits of site/docs/editor.md, as the editor calls them:
 * insert after a step, repair the continuity a middle insert leaves, wrap steps in a group and
 * unwrap one, and move a step anywhere in the tree. The first four are `@horizon36596/zenith-core`'s; this
 * module adds what the editor needs on top (wrapping in a branch, unwrapping a branch with no else
 * arm, and the drag-and-drop move) and ends every local edit in core's `finish`, so none of them can
 * write a file the schema would reject.
 */
import {
  EditError,
  addStep,
  childPrefix,
  continuityGaps,
  effectiveId,
  finish,
  insertStepAfter as insertStepAfterInCore,
  repairContinuity as repairContinuityInCore,
  unwrapStep as unwrapStepInCore,
  updateStep,
  wrapStepsWithId,
} from "@horizon36596/zenith-core";
import type { InsertResult, ResolvedAuto, ResolvedStep } from "@horizon36596/zenith-core";
import { childLists, withChildLists, type Auto, type Step, type Waypoints } from "@horizon36596/zenith-schema";

/**
 * Adds `step` straight after `afterId`, wherever that sits in the tree, or at the end of the
 * routine when there is no anchor. After an anchor, core's `insertStepAfter` starts a new path
 * where the anchor ends and names the following step when the insert left it with a gap.
 */
export function insertStepAfter(
  auto: Auto,
  step: Step,
  afterId: string | undefined,
  waypoints?: Waypoints,
): InsertResult {
  if (afterId !== undefined) return insertStepAfterInCore(auto, afterId, step, waypoints);
  const result = addStep(auto, step);
  const last = result.steps[result.steps.length - 1];
  return {
    auto: result,
    id: last?.id ?? step.id ?? "",
    continuityGapStepId: null,
    continuityGapIn: null,
  };
}

/**
 * Makes the step named `stepId` start where the robot is when it begins: its first segment's
 * `from` becomes `"current"`. The fix a middle insert offers when the step after it has a gap.
 */
export const repairContinuity = (auto: Auto, stepId: string): Auto => repairContinuityInCore(auto, stepId);

export type WrapKind = "sequence" | "parallel" | "branch";

export interface WrapOptions {
  /** For a parallel group. */
  mode?: "all" | "race" | "deadline";
  /** For a branch: the condition it tests. */
  condition?: string;
  /** For a branch: the id it is given. Core names sequence and parallel groups itself. */
  id?: string;
}

/** Finds the one list holding every id, and replaces them there with what `replace` builds. */
function editList(
  steps: readonly Step[],
  prefix: string,
  ids: ReadonlySet<string>,
  replace: (members: Step[]) => Step[],
): { steps: Step[]; done: boolean } {
  const own = steps.map((step, index) => effectiveId(step, index, prefix));
  const hits = own.flatMap((id, index) => (ids.has(id) ? [index] : []));
  if (hits.length === ids.size && hits.length > 0) {
    const first = hits[0] ?? 0;
    const members = hits.map((index) => steps[index] as Step);
    // Every step before the first hit is kept, so the replacement lands at the first hit's index.
    const kept = steps.filter((_, index) => !hits.includes(index));
    return { steps: [...kept.slice(0, first), ...replace(members), ...kept.slice(first)], done: true };
  }
  for (const [index, step] of steps.entries()) {
    const lists = childLists(step);
    for (const [listIndex, list] of lists.entries()) {
      const inner = editList(list, childPrefix(own[index] ?? "", lists.length, listIndex), ids, replace);
      if (inner.done) {
        const nextLists = lists.map((candidate, at) => (at === listIndex ? inner.steps : candidate));
        const copy = [...steps];
        copy[index] = withChildLists(step, nextLists);
        return { steps: copy, done: true };
      }
    }
  }
  return { steps: [...steps], done: false };
}

/**
 * Wraps sibling steps in a new sequence, parallel group or branch, at the position of the first of
 * them and in their document order, and returns the new group's id. Sequence and parallel go
 * through core's `wrapStepsWithId`; a branch puts the steps in its then arm.
 */
export function wrapSteps(
  auto: Auto,
  ids: readonly string[],
  kind: WrapKind,
  options: WrapOptions = {},
): { auto: Auto; id: string } {
  if (kind === "sequence") return wrapStepsWithId(auto, ids, "sequence");
  if (kind === "parallel") return wrapStepsWithId(auto, ids, "parallel", options.mode ?? "all");
  if (ids.length === 0) throw new EditError("Select at least one step to wrap.");
  const { condition, id } = options;
  if (condition === undefined || id === undefined) {
    throw new EditError("robot.json declares no conditions, so there is nothing to branch on.");
  }
  const result = editList(auto.steps, "step", new Set(ids), (members) => [
    { id, kind: "branch", condition, then: members },
  ]);
  if (!result.done) {
    throw new EditError("Only steps that sit side by side in the same list can be wrapped together.");
  }
  return { auto: finish({ ...auto, steps: result.steps }), id };
}

/** Why a step cannot be unwrapped, or null when it can. */
export function unwrapBlockedReason(step: Step): string | null {
  if (step.kind !== "sequence" && step.kind !== "parallel" && step.kind !== "branch") {
    return "Only a group can be unwrapped.";
  }
  if (step.kind === "branch" && step.else !== undefined && step.else.length > 0) {
    return "This branch has an else arm, and unwrapping it would lose one of the two.";
  }
  return null;
}

/**
 * Replaces a group with its own steps, in place. Sequence and parallel go through core's
 * `unwrapStep`; a branch with no else arm is replaced by its then arm.
 */
export function unwrapStep(auto: Auto, id: string): Auto {
  let group: Step | undefined;
  const result = editList(auto.steps, "step", new Set([id]), ([found]) => {
    group = found;
    return found?.kind === "branch" ? found.then : found === undefined ? [] : [found];
  });
  if (!result.done || group === undefined) throw new EditError(`No step with id ${JSON.stringify(id)}.`);
  const reason = unwrapBlockedReason(group);
  if (reason !== null) throw new EditError(reason);
  if (group.kind !== "branch") return unwrapStepInCore(auto, id);
  return finish({ ...auto, steps: result.steps });
}

/** Every resolved step, children included, in document order. */
export function flattenResolved(steps: readonly ResolvedStep[]): ResolvedStep[] {
  return steps.flatMap((step) => [step, ...flattenResolved(step.children ?? [])]);
}

/**
 * How far the step starts from where the robot actually is when it begins, in inches, when that is
 * a CONTINUITY-sized gap, found by the same walk `check` uses. Null when there is no gap, and for
 * a step that is not a path, since only a path has a start to move.
 */
export function continuityGapIn(resolved: ResolvedAuto | null, stepId: string): number | null {
  if (resolved === null) return null;
  const gap = continuityGaps(resolved.steps, resolved.startPose).find(
    (candidate) => candidate.stepId === stepId && candidate.where === "start",
  );
  if (gap === undefined) return null;
  const step = flattenResolved(resolved.steps).find((candidate) => candidate.id === stepId);
  return step?.step.kind === "path" ? gap.gapIn : null;
}

/** Updates one step wherever it is. Re-exported so callers need only this module. */
export { updateStep };

/* ---- Moving a step anywhere in the tree ---------------------------------- */

/** Where a dragged step lands relative to the row it was dropped on. */
export type DropPosition = "before" | "after" | "into";

/** One level of a step's address: its index in a list, and which child list of it to go into. */
interface Hop {
  index: number;
  list: number;
}

/** The address of a step: a hop per level, the last one's `list` unused. */
function locate(steps: readonly Step[], prefix: string, id: string): Hop[] | null {
  for (const [index, step] of steps.entries()) {
    const own = effectiveId(step, index, prefix);
    if (own === id) return [{ index, list: 0 }];
    const lists = childLists(step);
    for (const [list, children] of lists.entries()) {
      const inner = locate(children, childPrefix(own, lists.length, list), id);
      if (inner !== null) return [{ index, list }, ...inner];
    }
  }
  return null;
}

/** Rebuilds the forest with the list at `parent` (a hop path to a list) replaced by `edit(list)`. */
function editAt(steps: readonly Step[], parent: readonly Hop[], edit: (list: Step[]) => Step[]): Step[] {
  const [head, ...rest] = parent;
  if (head === undefined) return edit([...steps]);
  const copy = [...steps];
  const step = copy[head.index];
  if (step === undefined) return copy;
  const lists = childLists(step);
  copy[head.index] = withChildLists(
    step,
    lists.map((list, at) => (at === head.list ? editAt(list, rest, edit) : list)),
  );
  return copy;
}

const samePrefix = (a: readonly Hop[], b: readonly Hop[], length: number): boolean =>
  a.length >= length &&
  b.length >= length &&
  a.slice(0, length).every((hop, at) => hop.index === b[at]?.index && hop.list === b[at]?.list);

/**
 * Moves `sourceId` before or after `targetId`, or into `targetId` as the first step of its first
 * list when `targetId` is a group, wherever either sits in the tree. Works on addresses rather
 * than ids so a step with a positional id is not lost when the move renumbers its siblings.
 */
export function moveStepRelative(
  auto: Auto,
  sourceId: string,
  targetId: string,
  position: DropPosition,
): Auto {
  if (sourceId === targetId) return auto;
  const source = locate(auto.steps, "step", sourceId);
  const target = locate(auto.steps, "step", targetId);
  if (source === null) throw new EditError(`No step with id ${JSON.stringify(sourceId)}.`);
  if (target === null) throw new EditError(`No step with id ${JSON.stringify(targetId)}.`);
  const sourceTail = source[source.length - 1] as Hop;
  if (
    target.length > source.length &&
    samePrefix(target, source, source.length - 1) &&
    target[source.length - 1]?.index === sourceTail.index
  ) {
    throw new EditError("A group cannot be moved inside itself.");
  }

  const sourceParent = source.slice(0, -1);
  const sourceLast = source[source.length - 1] as Hop;
  let moved: Step | undefined;
  let steps = editAt(auto.steps, sourceParent, (list) => {
    moved = list[sourceLast.index];
    return list.filter((_, index) => index !== sourceLast.index);
  });
  if (moved === undefined) return auto;

  // Removing the source shifts every later sibling at its level down by one, and that includes
  // the target or one of the target's ancestors when they share the source's parent list.
  const shifted = target.map((hop) => ({ ...hop }));
  const level = sourceParent.length;
  const atLevel = shifted[level];
  if (atLevel !== undefined && samePrefix(shifted, source, level) && atLevel.index > sourceLast.index) {
    atLevel.index -= 1;
  }

  const step = moved;
  if (position === "into") {
    const group = shifted;
    const last = group[group.length - 1] as Hop;
    steps = editAt(steps, group.slice(0, -1), (list) => {
      const parentStep = list[last.index];
      if (parentStep === undefined) return list;
      const lists = childLists(parentStep);
      if (lists.length === 0) throw new EditError("Only a group can hold other steps.");
      const copy = [...list];
      copy[last.index] = withChildLists(
        parentStep,
        lists.map((children, at) => (at === 0 ? [step, ...children] : children)),
      );
      return copy;
    });
  } else {
    const parent = shifted.slice(0, -1);
    const last = shifted[shifted.length - 1] as Hop;
    steps = editAt(steps, parent, (list) => {
      const at = position === "before" ? last.index : last.index + 1;
      return [...list.slice(0, at), step, ...list.slice(at)];
    });
  }
  return finish({ ...auto, steps });
}
