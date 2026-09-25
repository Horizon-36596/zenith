import { childLists, type Step } from "@horizon36596/zenith-schema";

/**
 * The id a step is addressed by, whether or not it carries an explicit `id` field. This is the one
 * definition: `resolve()`, `diff()` and the editor's step list all call it, so a `stepId` an edit
 * primitive accepts, a `Finding.stepId` a check raises and the id the inspector shows are always
 * the same string.
 *
 * A step with no explicit id is positional: removing or inserting a sibling before it in the same
 * list changes its effective id. That is inherent to the file format, not something an edit
 * primitive can paper over, which is why `addStep` always gives the new step an explicit id
 * (`uniqueId` below) rather than leaving it positional.
 */
export function effectiveId(step: Step, index: number, prefix: string): string {
  return step.id ?? `${prefix}${String(index + 1)}`;
}

/**
 * The id prefix `resolve()` gives the children of a group step: `grp.` for the one list of a
 * sequence or parallel group (so its members are `grp.1`, `grp.2`), and `br.1.` / `br.2.` for the
 * two arms of a branch that has both. `branchCount` is how many child lists the group has, which
 * `childLists` answers.
 */
export function childPrefix(parentId: string, branchCount: number, branchIndex: number): string {
  return `${parentId}.${branchCount > 1 ? `${String(branchIndex + 1)}.` : ""}`;
}

/**
 * Every effective id in a step forest, depth first, in document order and with repeats kept.
 *
 * `collectIds` folds this into a set for the "is this id taken" question; `duplicateIds` is the
 * other half, because an id that appears twice makes every finding, fix and edit primitive
 * ambiguous and has to be reported rather than quietly collapsed.
 */
export function listIds(steps: readonly Step[], prefix = "step", ids: string[] = []): string[] {
  steps.forEach((step, index) => {
    const id = effectiveId(step, index, prefix);
    ids.push(id);
    const lists = childLists(step);
    lists.forEach((list, listIndex) => {
      listIds(list, childPrefix(id, lists.length, listIndex), ids);
    });
  });
  return ids;
}

/** Every effective id in a step forest, depth first, for uniqueness checks. */
export function collectIds(steps: readonly Step[], prefix = "step"): Set<string> {
  return new Set(listIds(steps, prefix));
}

/** The effective ids that appear more than once, in the order they are first seen. */
export function duplicateIds(steps: readonly Step[], prefix = "step"): string[] {
  const seen = new Set<string>();
  const repeated: string[] = [];
  for (const id of listIds(steps, prefix)) {
    if (seen.has(id)) {
      if (!repeated.includes(id)) repeated.push(id);
      continue;
    }
    seen.add(id);
  }
  return repeated;
}

/**
 * A deterministic id derived from `base` that is not already in `taken`: `base`, then `base-2`,
 * `base-3`, and so on. No randomness and no clock (CLAUDE.md rule 1): the same inputs always
 * choose the same id.
 */
export function uniqueId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; n < 10000; n += 1) {
    const candidate = `${base}-${String(n)}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`Could not make a unique id from ${JSON.stringify(base)}.`);
}
