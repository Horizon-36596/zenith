import { childLists, withChildLists, type Step } from "@horizon36596/zenith-schema";
import { collectIds, holdIds, releaseIds, stepIdFrom, stepIdProblem } from "./ids.js";
import { updateStep } from "./tree.js";

/** `renameStep` on a forest, without the checks on the new id; null when no step is named `id`. */
export function renameStepIn(steps: readonly Step[], id: string, newId: string): Step[] | null {
  const held = holdIds(steps);
  const renamed = updateStep(held.steps, "step", held.idOf(id), (step) => ({ ...step, id: newId }));
  if (!renamed.found) return null;
  return releaseIds(fixDeadlineReferences(renamed.steps, held.idOf(id), newId));
}

/**
 * The forest `after`, which an edit made from `before`, with every id the edit pinned given one
 * inside the step id rule. An edit pins a positional step by writing its effective id as its
 * explicit id, so that it keeps the id it is known by when its siblings move or so that a
 * deadline can name it, and a positional id inside a group (`park.2`) has a dot, which the rule
 * does not allow. Such an id is renamed as `renameStep` renames, `park.2` to `park2`
 * (`stepIdFrom`), so every deadline that named it follows. An id the file already had, or one a
 * caller chose (`chosen`, such as the id of the step `insertStepAfter` adds), is left as it is.
 */
export function tidyPinnedIds(before: readonly Step[], after: Step[], chosen: readonly string[] = []): Step[] {
  const explicitBefore = new Set<string>(chosen);
  const walk = (list: readonly Step[], visit: (step: Step) => void): void => {
    for (const step of list) {
      visit(step);
      for (const children of childLists(step)) walk(children, visit);
    }
  };
  walk(before, (step) => {
    if (step.id !== undefined) explicitBefore.add(step.id);
  });
  const pinned: string[] = [];
  walk(after, (step) => {
    const id = step.id;
    if (id !== undefined && !explicitBefore.has(id) && /\.[0-9]+$/.test(id) && stepIdProblem(id) !== null) pinned.push(id);
  });
  let steps = after;
  for (const id of pinned) {
    steps = renameStepIn(steps, id, stepIdFrom(id, collectIds(steps))) ?? steps;
  }
  return steps;
}

function fixDeadlineReferences(steps: readonly Step[], oldId: string, newId: string): Step[] {
  return steps.map((step) => {
    const lists = childLists(step);
    if (lists.length === 0) return step;
    const updated = withChildLists(
      step,
      lists.map((list) => fixDeadlineReferences(list, oldId, newId)),
    );
    if (updated.kind === "parallel" && updated.deadline === oldId) updated.deadline = newId;
    return updated;
  });
}
