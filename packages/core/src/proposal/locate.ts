import { childLists, type Step } from "@horizon36596/zenith-schema";
import { childPrefix, effectiveId } from "../edit/ids.js";

/**
 * Where a step sits in an auto as a path of list positions from the top, so a step can be found
 * again after an edit has moved its neighbours. A step with no `id` of its own is named by its
 * position (`step3`, `grp.2`), and inserting or removing a step before it changes that name; the
 * owner's applier keeps a locator for every step a proposal names, moves the locators along with
 * each edit exactly as the edit moved the steps, and asks for the step's name at the moment it is
 * needed. Pure.
 */

export type ListKey = "steps" | "then" | "else";

/** One step down: the list of the step above (`steps` at the top) and the place in it, from 0. */
export interface Hop {
  key: ListKey;
  index: number;
}

export type Locator = Hop[];

/** The keys of a step's child lists, in the order `childLists` returns them. */
function keysOf(step: Step): ListKey[] {
  const count = childLists(step).length;
  if (step.kind === "branch") return count > 1 ? ["then", "else"] : ["then"];
  return count > 0 ? ["steps"] : [];
}

/** Every step's effective id with its locator, in document order; the first when an id repeats. */
export function locatorsOf(steps: readonly Step[]): Map<string, Locator> {
  const found = new Map<string, Locator>();
  const visit = (list: readonly Step[], prefix: string, above: Locator, key: ListKey): void => {
    list.forEach((step, index) => {
      const id = effectiveId(step, index, prefix);
      const here: Locator = [...above, { key, index }];
      if (!found.has(id)) found.set(id, here);
      const lists = childLists(step);
      const keys = keysOf(step);
      lists.forEach((children, listIndex) => {
        visit(children, childPrefix(id, lists.length, listIndex), here, keys[listIndex] ?? "steps");
      });
    });
  };
  visit(steps, "step", [], "steps");
  return found;
}

/** The step at a locator and its effective id now, or null when nothing is there. */
export function stepAt(steps: readonly Step[], locator: Locator): { step: Step; id: string } | null {
  let list: readonly Step[] = steps;
  let prefix = "step";
  let current: { step: Step; id: string } | null = null;
  for (const hop of locator) {
    if (current !== null) {
      const lists = childLists(current.step);
      const listIndex = keysOf(current.step).indexOf(hop.key);
      const children = lists[listIndex];
      if (children === undefined) return null;
      list = children;
      prefix = childPrefix(current.id, lists.length, listIndex);
    }
    const step = list[hop.index];
    if (step === undefined) return null;
    current = { step, id: effectiveId(step, hop.index, prefix) };
  }
  return current;
}

/** Whether `locator` is a member, or inside a member, of the list `key` under `parent`. */
function inList(locator: Locator, parent: Locator, key: ListKey): boolean {
  if (locator.length <= parent.length) return false;
  for (let depth = 0; depth < parent.length; depth += 1) {
    const a = locator[depth];
    const b = parent[depth];
    if (a === undefined || b === undefined || a.key !== b.key || a.index !== b.index) return false;
  }
  return locator[parent.length]?.key === key;
}

/** The locators a set of tracked steps have, kept in step with the edits made to the auto. */
export class Tracker {
  private readonly tracked = new Map<string, Locator | null>();

  track(name: string, locator: Locator | null): void {
    this.tracked.set(name, locator === null ? null : locator.map((hop) => ({ ...hop })));
  }

  get(name: string): Locator | null {
    return this.tracked.get(name) ?? null;
  }

  private each(parent: Locator, key: ListKey, move: (index: number) => number | null): void {
    const depth = parent.length;
    for (const [name, locator] of this.tracked) {
      if (locator === null || !inList(locator, parent, key)) continue;
      const hop = locator[depth];
      if (hop === undefined) continue;
      const moved = move(hop.index);
      if (moved === null) this.tracked.set(name, null);
      else hop.index = moved;
    }
  }

  /** A step was inserted at `at` in the list `key` under `parent`. */
  inserted(parent: Locator, key: ListKey, at: number): void {
    this.each(parent, key, (index) => (index >= at ? index + 1 : index));
  }

  /** The step at `at` in the list was removed, and everything inside it with it. */
  removed(parent: Locator, key: ListKey, at: number): void {
    this.each(parent, key, (index) => (index === at ? null : index > at ? index - 1 : index));
  }

  /** The step at `from` in the list now stands at `to`. */
  moved(parent: Locator, key: ListKey, from: number, to: number): void {
    this.each(parent, key, (index) => {
      if (index === from) return to;
      if (from < to && index > from && index <= to) return index - 1;
      if (to < from && index >= to && index < from) return index + 1;
      return index;
    });
  }
}
