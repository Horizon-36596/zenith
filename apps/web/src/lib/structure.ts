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
  holdIds,
  insertStepAfter as insertStepAfterInCore,
  repairContinuity as repairContinuityInCore,
  releaseIds,
  repointDanglingDeadlines,
  stepDrives,
  tidyPinnedIds,
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
 *
 * A branch is wrapped as a sequence by core first and then turned into the branch, so it gets the
 * same rules (issue #312): the steps have to be one unbroken run in one list, the steps after them
 * keep their ids, and when one of them was the deadline of the parallel group around them, the
 * deadline passes to the new branch.
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
  const wrapped = wrapStepsWithId(auto, ids, "sequence");
  const replaced = updateStep(wrapped.auto.steps, "step", wrapped.id, (sequence) =>
    sequence.kind === "sequence" ? { id, kind: "branch", condition, then: sequence.steps } : undefined,
  );
  if (!replaced.found) throw new EditError(`No step with id ${JSON.stringify(wrapped.id)}.`);
  const steps = renameDeadline(replaced.steps, wrapped.id, id);
  return { auto: finish({ ...wrapped.auto, steps }), id };
}

/** Every parallel group whose deadline is `from` names `to` instead. */
function renameDeadline(steps: readonly Step[], from: string, to: string): Step[] {
  return steps.map((step) => {
    const own = step.kind === "parallel" && step.deadline === from ? { ...step, deadline: to } : step;
    const lists = childLists(own);
    return lists.length === 0 ? own : withChildLists(own, lists.map((list) => renameDeadline(list, from, to)));
  });
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
 *
 * As core does for a group (issue #401), a deadline that named the branch passes to the step of
 * its then arm that decided when it ended: its last step that drives, else its last step. With no
 * then arm left, the deadline passes on as when its step is removed. A deadline that named a
 * positional step after the branch follows that step to its new number.
 */
export function unwrapStep(auto: Auto, id: string): Auto {
  const held = holdIds(auto.steps);
  const key = held.idOf(id);
  let group: Step | undefined;
  const result = editList(held.steps, "step", new Set([key]), ([found]) => {
    group = found;
    return found?.kind === "branch" ? found.then : found === undefined ? [] : [found];
  });
  if (!result.done || group === undefined) throw new EditError(`No step with id ${JSON.stringify(id)}.`);
  const reason = unwrapBlockedReason(group);
  if (reason !== null) throw new EditError(reason);
  if (group.kind !== "branch") return unwrapStepInCore(auto, id);
  const then = group.then;
  const successor = [...then].reverse().find((member) => stepDrives(member)) ?? then[then.length - 1];
  const passed = successor?.id === undefined ? result.steps : renameDeadline(result.steps, key, successor.id);
  // A deadline passed to a positional step pins it; `tidyPinnedIds` gives that pin an id inside the rule.
  return finish({ ...auto, steps: tidyPinnedIds(auto.steps, repointDanglingDeadlines(releaseIds(passed), "step")) });
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

/** The id of the step at `hops` (an address `locate` gave), or null when there is none there. */
function idAt(steps: readonly Step[], prefix: string, hops: readonly Hop[]): string | null {
  const [head, ...rest] = hops;
  const step = head === undefined ? undefined : steps[head.index];
  if (head === undefined || step === undefined) return null;
  const own = effectiveId(step, head.index, prefix);
  if (rest.length === 0) return own;
  const lists = childLists(step);
  return idAt(lists[head.list] ?? [], childPrefix(own, lists.length, head.list), rest);
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
 * A deadline an edit passed on because the step it named left the group: the parallel group's id
 * after the edit, the step its deadline named before, and the step that is its deadline now.
 */
export interface RepointedDeadline {
  groupId: string;
  deadline: string;
  newDeadline: string;
}

/**
 * The deadlines `repointDanglingDeadlines` passed on between `before` and `after`, in document
 * order. The two forests have the same shape, because repointing a deadline only changes that one
 * key and at most gives the new deadline member an id. A stale key a group in
 * all or race mode lost is not listed: that group never used it.
 */
function repointedDeadlines(before: readonly Step[], after: readonly Step[], prefix: string): RepointedDeadline[] {
  return before.flatMap((step, index) => {
    const kept = after[index];
    if (kept === undefined) return [];
    const id = effectiveId(step, index, prefix);
    const own: RepointedDeadline[] =
      step.kind === "parallel" &&
      step.deadline !== undefined &&
      kept.kind === "parallel" &&
      kept.deadline !== undefined &&
      kept.deadline !== step.deadline
        ? [{ groupId: id, deadline: step.deadline, newDeadline: kept.deadline }]
        : [];
    const lists = childLists(step);
    const keptLists = childLists(kept);
    const inside = lists.flatMap((list, listIndex) =>
      repointedDeadlines(list, keptLists[listIndex] ?? [], childPrefix(id, lists.length, listIndex)),
    );
    return [...own, ...inside];
  });
}

/**
 * Removes each step in `roots`, with everything inside it, as core's `removeStep` does for one, and
 * says which deadlines that passed on. A deadline group that loses the step its deadline named
 * passes the deadline to its first remaining step that drives, or its first step when none drives,
 * so it stays a group the checks accept.
 */
export function removeStepsReportingDeadlines(
  auto: Auto,
  roots: readonly string[],
): { auto: Auto; repointedDeadlines: RepointedDeadline[] } {
  // Every id means the step it named before the first removal, and a deadline that named a
  // positional sibling follows it to its new number (issue #401).
  const held = holdIds(auto.steps);
  let steps: Step[] = held.steps;
  for (const id of roots) {
    const result = updateStep(steps, "step", held.idOf(id), () => "remove");
    if (!result.found) throw new EditError(`No step with id ${JSON.stringify(id)}.`);
    steps = result.steps;
  }
  return tidyDeadlines(auto, releaseIds(steps), held.nameOf);
}

/**
 * Finishes an edit made with `holdIds`, after `releaseIds`: passes on each deadline whose step
 * left its group, and lists those by the ids they had before the edit. Passing a deadline to a
 * positional step pins it, and `tidyPinnedIds` gives that pin an id inside the rule (`grp.2` to
 * `grp2`), as core's `removeStep` and `moveStep` do.
 */
function tidyDeadlines(
  auto: Auto,
  steps: Step[],
  nameOf: (id: string) => string,
): { auto: Auto; repointedDeadlines: RepointedDeadline[] } {
  const kept = tidyPinnedIds(auto.steps, repointDanglingDeadlines(steps, "step"));
  const passed = repointedDeadlines(steps, kept, "step").map((entry) => ({ ...entry, deadline: nameOf(entry.deadline) }));
  return { auto: finish({ ...auto, steps: kept }), repointedDeadlines: passed };
}

/**
 * Moves `sourceId` before or after `targetId`, or into `targetId` as the first step of its first
 * list when `targetId` is a group, wherever either sits in the tree. Works on addresses rather
 * than ids so a step with a positional id is not lost when the move renumbers its siblings.
 *
 * A deadline group whose deadline member was moved out of it passes its deadline to its first
 * remaining step that drives, or its first step when none drives, as core's `moveStep` does, so it
 * never stays a deadline group with no deadline (issues #160 and #144). A deadline whose member
 * moves about inside its own group, or is renumbered by the move, follows that member (issue #401).
 */
export function moveStepRelative(
  auto: Auto,
  sourceId: string,
  targetId: string,
  position: DropPosition,
): Auto {
  return moveStepReportingDeadlines(auto, sourceId, targetId, position).auto;
}

/**
 * `moveStepRelative`, also saying which deadlines the move passed on, and the id the moved step has
 * where it landed (`movedId`, which differs from `sourceId` for a positional step), for the status
 * line.
 */
export function moveStepReportingDeadlines(
  auto: Auto,
  sourceId: string,
  targetId: string,
  position: DropPosition,
): { auto: Auto; repointedDeadlines: RepointedDeadline[]; movedId?: string } {
  if (sourceId === targetId) return { auto, repointedDeadlines: [] };
  const held = holdIds(auto.steps);
  const source = locate(held.steps, "step", held.idOf(sourceId));
  const target = locate(held.steps, "step", held.idOf(targetId));
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
  let steps = editAt(held.steps, sourceParent, (list) => {
    moved = list[sourceLast.index];
    return list.filter((_, index) => index !== sourceLast.index);
  });
  if (moved === undefined) return { auto, repointedDeadlines: [] };

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
  const landed = locate(steps, "step", held.idOf(sourceId));
  const result = tidyDeadlines(auto, releaseIds(steps), held.nameOf);
  const movedId = landed === null ? null : idAt(result.auto.steps, "step", landed);
  return movedId === null ? result : { ...result, movedId };
}
