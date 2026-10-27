import { childLists, withChildLists, type Auto, type Step } from "@horizon36596/zenith-schema";

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

/**
 * The rule for a step's explicit `id`, the same one a waypoint's name follows
 * (`WAYPOINT_NAME_PATTERN`, which is this constant): a letter, then letters, digits, `_` or `-`.
 * Such an id reads the same in a file, a finding, a commit message and the generated Java. The
 * format itself still accepts any id that is not empty, so a file written before the rule loads as
 * it did; `check` warns about an id outside it (STEP_ID) and offers a rename to one inside it. A new
 * id (`addStep`, `insertStepAfter`, `renameStep`) is refused when it breaks the rule.
 * Positional ids (`step3`, `park.2`) are not written in the file and are not subject to the rule.
 */
export const STEP_ID_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** The longest explicit id a step may be given, the same limit a waypoint's name has. */
export const STEP_ID_MAX = 64;

/**
 * Why `id` cannot be a step's new explicit id in `auto`, as a sentence, or null when it can.
 * `renaming` is the step being renamed, whose own id does not count as taken. Without `auto` only
 * the shape of the id is checked.
 */
export function stepIdProblem(id: string, auto?: Auto, renaming?: string): string | null {
  if (id.length === 0) return "A step needs an id.";
  if (id.length > STEP_ID_MAX) return `A step's id is at most ${String(STEP_ID_MAX)} characters.`;
  if (!STEP_ID_NAME_PATTERN.test(id)) {
    return "A step's id starts with a letter and holds only letters, digits, _ and -.";
  }
  if (id !== renaming && auto !== undefined && collectIds(auto.steps).has(id)) return `There is already a step named ${id}.`;
  return null;
}

/**
 * An id inside the rule made from `text`, which may be outside it, and not already in `taken`: every
 * run of characters the rule does not allow is dropped and the word after it starts with a capital
 * (`shoot preload` becomes `shootPreload`, `park.2` becomes `park2`), `step` goes in front when what
 * is left does not start with a letter, and `-2`, `-3` and so on follow when it is taken
 * (`uniqueId`). Deterministic, like `uniqueId`.
 */
export function stepIdFrom(text: string, taken: ReadonlySet<string>): string {
  const words = text.split(/[^A-Za-z0-9_-]+/).filter((word) => word.length > 0);
  let base = words.map((word, index) => (index === 0 ? word : word.charAt(0).toUpperCase() + word.slice(1))).join("");
  if (!/^[A-Za-z]/.test(base)) base = `step${base.charAt(0).toUpperCase()}${base.slice(1)}`;
  base = base.slice(0, STEP_ID_MAX);
  const id = uniqueId(base, taken);
  // Room for the number `uniqueId` adds, when the base was already as long as an id may be.
  return id.length <= STEP_ID_MAX ? id : uniqueId(base.slice(0, STEP_ID_MAX - 5), taken);
}

/**
 * The explicit ids in a step forest that break `STEP_ID_NAME_PATTERN` or `STEP_ID_MAX`, depth first,
 * in document order and each once. An explicit id is also the id the step is addressed by. Positional
 * steps are left out: their ids are not written in the file.
 */
export function nonCompliantStepIds(steps: readonly Step[]): string[] {
  const found: string[] = [];
  const walk = (list: readonly Step[]): void => {
    for (const step of list) {
      if (step.id !== undefined && stepIdProblem(step.id) !== null && !found.includes(step.id)) found.push(step.id);
      for (const children of childLists(step)) walk(children);
    }
  };
  walk(steps);
  return found;
}

/**
 * A numbered id that is not already in `taken`: `base1`, then `base2`, and so on, the lowest free
 * number first. New path steps are named this way (`path1`, `path2`), which reads better in a step
 * list than `path-2`. Deterministic, like `uniqueId`.
 */
export function numberedId(base: string, taken: ReadonlySet<string>): string {
  for (let n = 1; n < 10000; n += 1) {
    const candidate = `${base}${String(n)}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`Could not make a numbered id from ${JSON.stringify(base)}.`);
}

/**
 * A step forest with every positional step given a stand-in explicit id for the length of one
 * edit (`holdIds`), so removing, inserting or moving a sibling cannot renumber what the edit, or a
 * parallel group's `deadline`, refers to (issue #401). `releaseIds` takes the stand-ins off again.
 */
export interface HeldSteps {
  /** The forest with every step addressed by an explicit id. */
  steps: Step[];
  /** The id a step of the original forest goes by in `steps`; any other id is returned as it is. */
  idOf: (id: string) => string;
  /** The original id of a stand-in, for a message; any other id is returned as it is. */
  nameOf: (id: string) => string;
}

/**
 * The prefix of a stand-in id. Like `PENDING_ID` in steps.ts it starts with a NUL character, which no
 * id a person or a mint writes does, so it cannot collide with a real one.
 */
const HELD_PREFIX = "\u0000held ";

/**
 * Gives every positional step a stand-in explicit id, and points each parallel group's `deadline`
 * at the stand-in of the member it named. An edit then works on ids that stay put, and
 * `releaseIds` puts the positional steps back, with each deadline naming the same member by
 * wherever that member ends up.
 */
export function holdIds(steps: readonly Step[], prefix = "step"): HeldSteps {
  const held = new Map<string, string>();
  const names = new Map<string, string>();
  let next = 0;
  const walk = (list: readonly Step[], listPrefix: string): Step[] =>
    list.map((step, index) => {
      const id = effectiveId(step, index, listPrefix);
      let own = step;
      if (step.id === undefined) {
        next += 1;
        const stand = `${HELD_PREFIX}${String(next)}`;
        held.set(id, stand);
        names.set(stand, id);
        own = { ...step, id: stand };
      }
      const lists = childLists(own);
      if (lists.length === 0) return own;
      const updated = withChildLists(
        own,
        lists.map((children, listIndex) => walk(children, childPrefix(id, lists.length, listIndex))),
      );
      if (updated.kind === "parallel" && updated.deadline !== undefined) {
        updated.deadline = held.get(updated.deadline) ?? updated.deadline;
      }
      return updated;
    });
  const result = walk(steps, prefix);
  return {
    steps: result,
    idOf: (id) => held.get(id) ?? id,
    nameOf: (id) => names.get(id) ?? id,
  };
}

/**
 * Takes the stand-in ids `holdIds` gave off again, so those steps are positional as before, and
 * points each parallel group's `deadline` at its member's id where that member now stands. A
 * deadline whose member left the group keeps the stand-in, which names nothing, for
 * `repointDanglingDeadlines` to pass on.
 */
export function releaseIds(steps: readonly Step[], prefix = "step"): Step[] {
  return steps.map((step, index) => {
    const own = step.id?.startsWith(HELD_PREFIX) === true ? withoutId(step) : step;
    const id = effectiveId(own, index, prefix);
    const lists = childLists(own);
    if (lists.length === 0) return own;
    const updated = withChildLists(
      own,
      lists.map((children, listIndex) => releaseIds(children, childPrefix(id, lists.length, listIndex))),
    );
    if (updated.kind === "parallel" && updated.deadline?.startsWith(HELD_PREFIX) === true) {
      const memberPrefix = childPrefix(id, 1, 0);
      const at = childLists(step)[0]?.findIndex((member) => member.id === updated.deadline) ?? -1;
      const member = updated.steps[at];
      if (member !== undefined) updated.deadline = effectiveId(member, at, memberPrefix);
    }
    return updated;
  });
}

function withoutId(step: Step): Step {
  const copy = { ...step };
  delete copy.id;
  return copy;
}
