import { childLists, withChildLists, type Step } from "@horizon36596/zenith-schema";
import { childPrefix, effectiveId } from "./ids.js";

/**
 * What `updateStep`'s callback returns for the step it found: a replacement, `"remove"` to drop
 * the step from its containing list, or `undefined` to leave it exactly as it was.
 */
export type StepUpdate = Step | "remove" | undefined;

export interface UpdateResult {
  steps: Step[];
  found: boolean;
}

/**
 * Walks a step forest — the top-level list plus every `sequence.steps`, `parallel.steps` and
 * `branch.then`/`else` nested inside it — looking for the one step whose effective id
 * (`effectiveId`) is `targetId`, and rebuilds the forest with `update` applied to it. Every list on the path back to the root is
 * a new array; every step not on that path is the same object it was, so this never mutates the
 * auto it is given.
 *
 * Ids are unique by construction: `finish` refuses any edit that would repeat one and `check`
 * raises a SCHEMA error for a hand-written file that does, so the walk stops looking as soon as it
 * finds a match. On a document that has slipped through anyway, the first match in document order
 * is the one every caller acts on, which is also the one whose finding is reported first.
 */
export function updateStep(
  steps: readonly Step[],
  prefix: string,
  targetId: string,
  update: (step: Step, id: string) => StepUpdate,
): UpdateResult {
  let found = false;
  const result: Step[] = [];

  for (const [index, step] of steps.entries()) {
    if (found) {
      result.push(step);
      continue;
    }

    const id = effectiveId(step, index, prefix);
    if (id === targetId) {
      found = true;
      const outcome = update(step, id);
      if (outcome !== "remove") result.push(outcome === undefined ? step : outcome);
      continue;
    }

    const nested = inChildren(step, id, (list, childPrefixed) =>
      updateStep(list, childPrefixed, targetId, update),
    );
    if (nested !== null) found = true;
    result.push(nested ?? step);
  }

  return { steps: result, found };
}

/**
 * Tries `visit` on each child list of a group step in turn and stops at the first that finds its
 * target, returning the group rebuilt around the changed list; null when no list held the target
 * (or the step is a leaf). Every walker in this file recurses through here, so sequence, parallel
 * and branch steps are all searched alike.
 */
function inChildren(
  step: Step,
  id: string,
  visit: (list: readonly Step[], prefix: string) => UpdateResult,
): Step | null {
  const lists = childLists(step);
  for (const [listIndex, list] of lists.entries()) {
    const child = visit(list, childPrefix(id, lists.length, listIndex));
    if (!child.found) continue;
    const rebuilt = lists.map((original, i) => (i === listIndex ? child.steps : original));
    return withChildLists(step, rebuilt);
  }
  return null;
}

/** `updateStep`, but only to read the matching step out without changing the forest. */
export function findStep(steps: readonly Step[], prefix: string, targetId: string): Step | null {
  let found: Step | null = null;
  updateStep(steps, prefix, targetId, (step) => {
    found = step;
    return undefined;
  });
  return found;
}

/**
 * Inserts `newStep` immediately after the step whose effective id is `afterId`, in whichever list
 * — top level, a sequence's or parallel group's `steps`, or a branch's `then`/`else` — actually
 * contains it.
 */
export function insertAfter(
  steps: readonly Step[],
  prefix: string,
  afterId: string,
  newStep: Step,
): UpdateResult {
  let found = false;
  const result: Step[] = [];

  for (const [index, step] of steps.entries()) {
    if (found) {
      result.push(step);
      continue;
    }

    const id = effectiveId(step, index, prefix);
    if (id === afterId) {
      found = true;
      result.push(step, newStep);
      continue;
    }

    const nested = inChildren(step, id, (list, childPrefixed) =>
      insertAfter(list, childPrefixed, afterId, newStep),
    );
    if (nested !== null) found = true;
    result.push(nested ?? step);
  }

  return { steps: result, found };
}
