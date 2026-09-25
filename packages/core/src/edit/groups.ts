import {
  childLists,
  withChildLists,
  type Auto,
  type ParallelStep,
  type PathStep,
  type SequenceStep,
  type Step,
  type Waypoints,
} from "@horizon36596/zenith-schema";
import { continuityGaps } from "../continuity.js";
import { resolve, type ResolvedStep } from "../resolve.js";
import { EditError } from "./errors.js";
import { finish } from "./finish.js";
import { childPrefix, collectIds, effectiveId, uniqueId } from "./ids.js";
import { findStep, insertAfter, updateStep } from "./tree.js";

/**
 * Group edits (format version 2): wrapping a run of steps in a `sequence` or `parallel` group,
 * unwrapping one again, inserting a step in the middle so it continues from the step before it,
 * and repairing the continuity gap that insertion can leave.
 *
 * Same contract as every other primitive in this directory: the input is never mutated, the
 * candidate is always `finish`ed, and a request that does not fit throws `EditError`.
 *
 * Moving a step changes the effective id of every positional step that shifts, and a positional id
 * is what every finding, fix and later edit addresses. So these edits first give each step whose
 * position they change an explicit id equal to the one it had: the ids a person or an agent was
 * looking at before the edit still name the same steps after it.
 */

/** A list somewhere in the step tree, with the id prefix `resolve` gives its members. */
interface Located {
  list: readonly Step[];
  prefix: string;
  /** The group holding the list, or null for the top level. */
  parent: Step | null;
  parentId: string | null;
}

/** Finds the list whose members include `targetId`, anywhere in the tree. */
function locate(
  steps: readonly Step[],
  prefix: string,
  targetId: string,
  parent: Step | null = null,
  parentId: string | null = null,
): Located | null {
  for (const [index, step] of steps.entries()) {
    const id = effectiveId(step, index, prefix);
    if (id === targetId) return { list: steps, prefix, parent, parentId };
    const lists = childLists(step);
    for (const [listIndex, list] of lists.entries()) {
      const found = locate(list, childPrefix(id, lists.length, listIndex), targetId, step, id);
      if (found !== null) return found;
    }
  }
  return null;
}

/**
 * Replaces the list that holds `targetId` with `transform(list, prefix)`, wherever it sits.
 * Returns null when no list holds it.
 */
function replaceList(
  steps: readonly Step[],
  prefix: string,
  targetId: string,
  transform: (list: readonly Step[], prefix: string) => Step[],
): Step[] | null {
  for (const [index, step] of steps.entries()) {
    if (effectiveId(step, index, prefix) === targetId) return transform(steps, prefix);
  }
  for (const [index, step] of steps.entries()) {
    const id = effectiveId(step, index, prefix);
    const lists = childLists(step);
    for (const [listIndex, list] of lists.entries()) {
      const replaced = replaceList(list, childPrefix(id, lists.length, listIndex), targetId, transform);
      if (replaced === null) continue;
      const rebuilt = lists.map((original, i) => (i === listIndex ? replaced : original));
      return steps.map((sibling, i) => (i === index ? withChildLists(step, rebuilt) : sibling));
    }
  }
  return null;
}

/** The step with its effective id written out, so moving it cannot change what it is called. */
const pinned = (step: Step, index: number, prefix: string): Step =>
  step.id === undefined ? { ...step, id: effectiveId(step, index, prefix) } : step;

/** Every `parallel.deadline` equal to `oldId` renamed to `newId`, throughout the tree. */
function renameDeadline(steps: readonly Step[], oldId: string, newId: string): Step[] {
  return steps.map((step) => {
    const lists = childLists(step);
    if (lists.length === 0) return step;
    const updated = withChildLists(
      step,
      lists.map((list) => renameDeadline(list, oldId, newId)),
    );
    if (updated.kind === "parallel" && updated.deadline === oldId) updated.deadline = newId;
    return updated;
  });
}

/**
 * Wraps the steps named by `ids` in a new `sequence` or `parallel` group, in place.
 *
 * The steps must be siblings (members of one list: the top level, one group, or one branch arm)
 * and must form one unbroken run in that list, in any order in `ids`; the group takes their
 * document order. A `parallel` group takes `mode` (default `all`); a `deadline` group's deadline
 * is the first member that drives the robot, or the first member when none does.
 *
 * The new group gets an explicit id (`sequence`, `parallel`, disambiguated with `-2`, `-3`, ...),
 * which the result's `id` reports. When the run held the deadline of the parallel group around it,
 * that deadline now names the new group, which is the member that contains it.
 */
export function wrapSteps(
  auto: Auto,
  ids: readonly string[],
  kind: "sequence" | "parallel",
  mode?: ParallelStep["mode"],
): Auto {
  return wrapStepsWithId(auto, ids, kind, mode).auto;
}

/** `wrapSteps`, also returning the id the new group was given. */
export function wrapStepsWithId(
  auto: Auto,
  ids: readonly string[],
  kind: "sequence" | "parallel",
  mode?: ParallelStep["mode"],
): { auto: Auto; id: string } {
  if (ids.length === 0) throw new EditError("Name at least one step to wrap.");
  if (kind === "sequence" && mode !== undefined) {
    throw new EditError("A sequence has no mode; only a parallel group runs all, race or deadline.");
  }
  const first = ids[0] as string;
  const where = locate(auto.steps, "step", first);
  if (where === null) throw new EditError(`No step with id ${JSON.stringify(first)}.`);

  const positions = ids.map((id) => {
    const index = where.list.findIndex((step, i) => effectiveId(step, i, where.prefix) === id);
    if (index < 0) {
      throw new EditError(
        findStep(auto.steps, "step", id) === null
          ? `No step with id ${JSON.stringify(id)}.`
          : `Steps ${JSON.stringify(first)} and ${JSON.stringify(id)} are not in the same list; only siblings can be wrapped together.`,
      );
    }
    return index;
  });
  const sorted = [...new Set(positions)].sort((a, b) => a - b);
  const start = sorted[0] as number;
  const end = sorted[sorted.length - 1] as number;
  if (end - start + 1 !== sorted.length) {
    throw new EditError(
      "The steps to wrap have to be one unbroken run; wrapping steps with others between them would move those others.",
    );
  }

  const groupId = uniqueId(kind, collectIds(auto.steps));
  const steps = replaceList(auto.steps, "step", first, (list, prefix) => {
    const frozen = list.map((step, index) => (index >= start ? pinned(step, index, prefix) : step));
    const members = frozen.slice(start, end + 1);
    let group: Step;
    if (kind === "sequence") {
      const sequence: SequenceStep = { id: groupId, kind: "sequence", steps: members };
      group = sequence;
    } else {
      const parallel: ParallelStep = { id: groupId, kind: "parallel", mode: mode ?? "all", steps: members };
      if (parallel.mode === "deadline") {
        const driver = members.find((member) => stepDrives(member)) ?? members[0];
        if (driver?.id !== undefined) parallel.deadline = driver.id;
      }
      group = parallel;
    }
    return [...frozen.slice(0, start), group, ...frozen.slice(end + 1)];
  });
  if (steps === null) throw new EditError(`No step with id ${JSON.stringify(first)}.`);

  let result = steps;
  if (where.parent?.kind === "parallel" && where.parent.deadline !== undefined) {
    const wrappedIds = new Set(
      where.list.slice(start, end + 1).map((step, i) => effectiveId(step, start + i, where.prefix)),
    );
    if (wrappedIds.has(where.parent.deadline)) {
      result = repointParentDeadline(result, where.parentId as string, groupId);
    }
  }
  return { auto: finish({ ...auto, steps: result }), id: groupId };
}

/** Sets the `deadline` of the parallel group `parentId` to `deadline`. */
function repointParentDeadline(steps: Step[], parentId: string, deadline: string): Step[] {
  return updateStep(steps, "step", parentId, (parent) =>
    parent.kind === "parallel" ? { ...parent, deadline } : undefined,
  ).steps;
}

/** True for a path step, or a group with one somewhere inside it. */
const stepDrives = (step: Step): boolean =>
  step.kind === "path" || childLists(step).some((list) => list.some(stepDrives));

/**
 * Replaces the `sequence` or `parallel` group `id` with its members, in place, in the list that
 * held it. A branch is refused: its two arms cannot both stand where it stood.
 *
 * The members keep the ids they had (a positional member is given its old id explicitly), and so
 * do the siblings after it whose position shifts. When the group was the deadline of the parallel
 * group around it, that deadline passes to the member that decided when the group ended: its own
 * deadline for a deadline group, else its last member that drives, else its last member.
 */
export function unwrapStep(auto: Auto, id: string): Auto {
  const where = locate(auto.steps, "step", id);
  if (where === null) throw new EditError(`No step with id ${JSON.stringify(id)}.`);
  const index = where.list.findIndex((step, i) => effectiveId(step, i, where.prefix) === id);
  const group = where.list[index] as Step;
  if (group.kind !== "sequence" && group.kind !== "parallel") {
    throw new EditError(
      `Step ${JSON.stringify(id)} is a ${group.kind} step; only a sequence or a parallel group can be unwrapped.`,
    );
  }

  const memberPrefix = childPrefix(id, 1, 0);
  const members = group.steps.map((member, i) => pinned(member, i, memberPrefix));
  const successor =
    (group.kind === "parallel" && group.deadline !== undefined
      ? members.find((member) => member.id === group.deadline)
      : undefined) ??
    [...members].reverse().find((member) => stepDrives(member)) ??
    members[members.length - 1];

  const steps = replaceList(auto.steps, "step", id, (list, prefix) => {
    const frozen = list.map((step, i) => (i > index ? pinned(step, i, prefix) : step));
    return [...frozen.slice(0, index), ...members, ...frozen.slice(index + 1)];
  });
  if (steps === null) throw new EditError(`No step with id ${JSON.stringify(id)}.`);

  const result =
    successor?.id === undefined ? steps : renameDeadline(steps, id, successor.id);
  return finish({ ...auto, steps: result });
}

/** What `insertStepAfter` did, and what it left for the editor to offer. */
export interface InsertResult {
  auto: Auto;
  /** The id the new step was given. */
  id: string;
  /**
   * The path step after the new one that no longer starts where the robot now is, when there is
   * one: the editor offers `repairContinuity` on it. Null when the insertion left no new gap.
   */
  continuityGapStepId: string | null;
  /** How far that step starts from where the robot now is, in inches, when there is a gap. */
  continuityGapIn: number | null;
}

/**
 * Inserts `step` right after `afterId`, continuing from where that step ends
 * (site/docs/editor.md, "The insert menu").
 *
 * When the new step is a path, its first segment starts at the pose the step at `afterId` ends
 * at: `"current"` when the new step runs right after it (the top level, a sequence, a branch arm),
 * or that pose written out when the two are members of one parallel group, where `"current"`
 * would mean the pose the group started at. `waypoints` resolves any references on the way to
 * that pose.
 *
 * The step after the insertion point used to follow `afterId` and now follows the new step, so it
 * may no longer start where the robot is. The result names it (`continuityGapStepId`) when the
 * insertion opened a CONTINUITY gap there that was not there before, and `repairContinuity` fixes
 * it. A step without an explicit id is given one, as `addStep` does.
 */
export function insertStepAfter(
  auto: Auto,
  afterId: string,
  step: Step,
  waypoints?: Waypoints,
): InsertResult {
  const where = locate(auto.steps, "step", afterId);
  if (where === null) throw new EditError(`No step with id ${JSON.stringify(afterId)} to insert after.`);

  const before = resolve(auto, waypoints);
  const anchor = findResolved(before.steps, afterId);
  if (anchor === null) throw new EditError(`No step with id ${JSON.stringify(afterId)} to insert after.`);

  let placed: Step = step;
  if (step.kind === "path") {
    const concurrent = where.parent?.kind === "parallel";
    const from = concurrent
      ? {
          xIn: anchor.endPose.xIn,
          yIn: anchor.endPose.yIn,
          headingRad: anchor.endPose.headingRad,
          provenance: `SET FROM EDITOR: where ${afterId} ends`,
        }
      : ("current" as const);
    const [firstSegment, ...rest] = step.segments;
    if (firstSegment !== undefined) {
      const path: PathStep = { ...step, segments: [{ ...firstSegment, from }, ...rest] };
      placed = path;
    }
  }

  // Positional siblings after the insertion point shift by one; pin them first so they keep the
  // ids the caller knows them by.
  const frozen = replaceList(auto.steps, "step", afterId, (list, prefix) => {
    const at = list.findIndex((sibling, i) => effectiveId(sibling, i, prefix) === afterId);
    return list.map((sibling, i) => (i > at ? pinned(sibling, i, prefix) : sibling));
  });
  if (frozen === null) throw new EditError(`No step with id ${JSON.stringify(afterId)} to insert after.`);

  const PENDING = " inserting";
  const inserted = insertAfter(frozen, "step", afterId, { ...placed, id: PENDING });
  const taken = collectIds(inserted.steps);
  taken.delete(PENDING);
  let id: string;
  if (step.id === undefined) {
    id = uniqueId(step.kind, taken);
  } else {
    if (taken.has(step.id)) {
      throw new EditError(`A step with id ${JSON.stringify(step.id)} already exists.`);
    }
    id = step.id;
  }
  const named = updateStep(inserted.steps, "step", PENDING, (pending) => ({ ...pending, id }));
  const result = finish({ ...auto, steps: named.steps });

  const gapsBefore = new Map(continuityGaps(before.steps, before.startPose).map((gap) => [gap.stepId, gap.gapIn]));
  const afterResolve = resolve(result, waypoints);
  const opened = continuityGaps(afterResolve.steps, afterResolve.startPose).find(
    (gap) => gap.stepId !== id && gap.gapIn > (gapsBefore.get(gap.stepId) ?? 0),
  );
  return {
    auto: result,
    id,
    continuityGapStepId: opened?.stepId ?? null,
    continuityGapIn: opened?.gapIn ?? null,
  };
}

/** The resolved step with this id, anywhere in the tree. */
function findResolved(steps: readonly ResolvedStep[], id: string): ResolvedStep | null {
  for (const step of steps) {
    if (step.id === id) return step;
    const nested = findResolved(step.children ?? [], id);
    if (nested !== null) return nested;
  }
  return null;
}

/**
 * Makes the path step `stepId` start wherever the robot is when it begins, by setting its first
 * segment's `from` to `"current"`. This is the repair `insertStepAfter` offers for the gap it can
 * leave; it removes a CONTINUITY finding between steps, and leaves any gap between one segment and
 * the next inside the step alone.
 */
export function repairContinuity(auto: Auto, stepId: string): Auto {
  const result = updateStep(auto.steps, "step", stepId, (step) => {
    if (step.kind !== "path") {
      throw new EditError(
        `Step ${JSON.stringify(stepId)} is a ${step.kind} step; only a path step has a start to repair.`,
      );
    }
    const [firstSegment, ...rest] = step.segments;
    if (firstSegment === undefined) return undefined;
    const path: PathStep = { ...step, segments: [{ ...firstSegment, from: "current" }, ...rest] };
    return path;
  });
  if (!result.found) throw new EditError(`No step with id ${JSON.stringify(stepId)}.`);
  return finish({ ...auto, steps: result.steps });
}
