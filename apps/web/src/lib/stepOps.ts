/**
 * What the step list needs on top of `@horizon36596/zenith-core`'s edit primitives: the tree walked into flat
 * rows with a depth and a branch arm, a deep copy with fresh ids, and the factories for a new step
 * of each kind. The mutations themselves are core's (`packages/core/src/edit/`), which validate the
 * result, so the editor never builds a document the schema would reject.
 */
import { childPrefix, collectIds, effectiveId, numberedId, stepIdFrom, uniqueId } from "@horizon36596/zenith-core";
import { childLists, withChildLists } from "@horizon36596/zenith-schema";
import type {
  BranchStep,
  CommandSpec,
  CommandStep,
  Heading,
  ParallelStep,
  PathStep,
  Pose,
  PoseSource,
  Segment,
  SequenceStep,
  Step,
  WaitStep,
  Auto,
} from "@horizon36596/zenith-schema";

export type StepArm = "then" | "else";

export interface StepEntry {
  /** The id `resolve` gives this step, so findings, the canvas and the panels agree. */
  id: string;
  step: Step;
  depth: number;
  /** Which branch arm this step sits in, when it sits in one. */
  arm?: StepArm;
  /** The parent's id, for reordering inside the list the step already lives in. */
  parentId?: string;
  /** This step's position among its siblings, and how many siblings there are. */
  index: number;
  siblings: number;
}

export const isPathStep = (step: Step): step is PathStep => step.kind === "path";
export const isGroupKind = (kind: Step["kind"]): boolean =>
  kind === "sequence" || kind === "parallel" || kind === "branch";

export const isCommandStep = (step: Step): step is CommandStep => step.kind === "command";

/**
 * Walks the tree in document order. The ids are `effectiveId`'s, the one definition `resolve`,
 * `diff` and every edit primitive use, so a row in this list, a finding and a `stepId` an agent
 * passes to the CLI are all the same string.
 */
export function indexSteps(auto: Auto): StepEntry[] {
  const entries: StepEntry[] = [];

  const walk = (
    steps: readonly Step[],
    prefix: string,
    depth: number,
    arm: StepArm | undefined,
    parentId: string | undefined,
  ): void => {
    steps.forEach((step, index) => {
      const id = effectiveId(step, index, prefix);
      entries.push({ id, step, depth, arm, parentId, index, siblings: steps.length });
      const lists = childLists(step);
      lists.forEach((list, listIndex) => {
        const armName: StepArm | undefined =
          step.kind === "branch" ? (listIndex === 0 ? "then" : "else") : undefined;
        walk(list, childPrefix(id, lists.length, listIndex), depth + 1, armName, id);
      });
    });
  };

  walk(auto.steps, "step", 0, undefined, undefined);
  return entries;
}

export const findEntry = (auto: Auto, stepId: string): StepEntry | undefined =>
  indexSteps(auto).find((entry) => entry.id === stepId);

/** The entries that share a parent and an arm with `entry`, in document order. */
export const siblingsOf = (entries: readonly StepEntry[], entry: StepEntry): StepEntry[] =>
  entries.filter(
    (other) => other.parentId === entry.parentId && other.arm === entry.arm,
  );

/**
 * The first sequence or parallel group that taking the steps in `goneIds` out of it would leave
 * with no steps, while the group itself stays, or undefined when every group keeps one. The format
 * needs at least one step in each of those groups; a branch's arms may be empty, so a branch is
 * never one. A group that goes too, itself or with a group around it, is not counted.
 */
export function emptiedGroup(entries: readonly StepEntry[], goneIds: readonly string[]): StepEntry | undefined {
  const parentOf = new Map(entries.map((entry) => [entry.id, entry.parentId]));
  const goes = (id: string): boolean => {
    for (let at: string | undefined = id; at !== undefined; at = parentOf.get(at)) if (goneIds.includes(at)) return true;
    return false;
  };
  return entries.find((group) => {
    if (group.step.kind !== "sequence" && group.step.kind !== "parallel") return false;
    if (goes(group.id)) return false;
    const children = entries.filter((entry) => entry.parentId === group.id);
    return children.length > 0 && children.every((child) => goneIds.includes(child.id));
  });
}

/**
 * A deep copy whose own id and every nested id is free in `auto`.
 *
 * A copied deadline group names the copy of its own deadline member, not the original's (issue
 * #160). The member is found by its place among the original group's direct children, so a
 * deadline that names an explicit id and one that names a positional id both carry over. A copy
 * with no id of its own gets the one `addStep` would give it anyway, so that a deadline inside it
 * can name its members.
 */
export function cloneWithFreshIds(auto: Auto, step: Step): Step {
  const taken = collectIds(auto.steps);
  const rename = (original: Step): Step => {
    const copy = structuredClone(original) as Step;
    if (copy.id !== undefined) {
      // An old id outside the step id rule (a space, a dot) gives a copy whose id is inside it.
      const fresh = stepIdFrom(`${copy.id}Copy`, taken);
      taken.add(fresh);
      copy.id = fresh;
    }
    return withChildLists(copy, childLists(copy).map((list) => list.map(rename)));
  };
  const copy = rename(step);
  copy.id ??= uniqueId(copy.kind, taken);
  const originalId = indexSteps(auto).find((entry) => entry.step === step)?.id ?? step.id ?? "";
  repointDeadlines(step, originalId, copy, copy.id);
  return copy;
}

/**
 * Points each parallel group in `copy` at its own member in the place the matching group in
 * `original` has its deadline member. The two trees have the same shape; `copy` is a fresh object
 * this module owns, so it is changed in place.
 */
function repointDeadlines(original: Step, originalId: string, copy: Step, copyId: string): void {
  const originalLists = childLists(original);
  const copyLists = childLists(copy);
  if (original.kind === "parallel" && copy.kind === "parallel" && original.deadline !== undefined) {
    const prefix = childPrefix(originalId, 1, 0);
    const at = original.steps.findIndex((member, index) => effectiveId(member, index, prefix) === original.deadline);
    const member = copy.steps[at];
    if (member !== undefined) copy.deadline = effectiveId(member, at, childPrefix(copyId, 1, 0));
  }
  originalLists.forEach((list, listIndex) => {
    const copied = copyLists[listIndex] ?? [];
    const originalPrefix = childPrefix(originalId, originalLists.length, listIndex);
    const copyPrefix = childPrefix(copyId, copyLists.length, listIndex);
    list.forEach((child, index) => {
      const copiedChild = copied[index];
      if (copiedChild === undefined) return;
      repointDeadlines(
        child,
        effectiveId(child, index, originalPrefix),
        copiedChild,
        effectiveId(copiedChild, index, copyPrefix),
      );
    });
  });
}

/**
 * An id nothing in the document uses, derived from `base` with no randomness, and inside the step id
 * rule even when `base` is not, as a command's name with a dot or a space may be (`stepIdFrom`).
 */
export const freshId = (auto: Auto, base: string): string => stepIdFrom(base, collectIds(auto.steps));

/** A new path step's id: `path1`, `path2` and so on, the lowest number the document does not use. */
export const freshPathId = (auto: Auto, taken: Iterable<string> = []): string =>
  numberedId("path", new Set([...collectIds(auto.steps), ...taken]));

/* ---- Step factories ---------------------------------------------------- */

/**
 * A new path step of one line. The heading comes from the caller, never from here: `apps/web` builds
 * it from the person's setting for new paths (`defaultPathHeading`), so this stays free of
 * preferences and so does core.
 */
export function newPathStep(id: string, from: PoseSource, to: PoseSource, heading: Heading): PathStep {
  const segment: Segment = { kind: "line", from, to };
  return { id, kind: "path", segments: [segment], heading };
}

/** A command step with each parameter at the default `robot.json` declares, and nothing invented. */
export function newCommandStep(id: string, spec: CommandSpec): CommandStep {
  const args: Record<string, string | number | boolean> = {};
  for (const [name, param] of Object.entries(spec.params ?? {})) {
    if (param.type === "enum") {
      const value = param.default ?? param.values[0];
      if (value !== undefined) args[name] = value;
    } else if (param.default !== undefined) {
      args[name] = param.default;
    }
  }
  const step: CommandStep = { id, kind: "command", name: spec.name };
  if (Object.keys(args).length > 0) step.args = args;
  return step;
}

export const newWaitStep = (id: string): WaitStep => ({ id, kind: "wait", seconds: 0.5 });

export const newUntilStep = (id: string, condition: string): WaitStep => ({
  id,
  kind: "wait",
  until: condition,
});

export const newSequenceStep = (id: string, children: Step[]): SequenceStep => ({
  id,
  kind: "sequence",
  steps: children,
});

export function newParallelStep(
  id: string,
  children: Step[],
  mode: ParallelStep["mode"] = "all",
  deadline?: string,
): ParallelStep {
  const step: ParallelStep = { id, kind: "parallel", mode, steps: children };
  if (mode === "deadline" && deadline !== undefined) step.deadline = deadline;
  return step;
}

export function newBranchStep(
  id: string,
  condition: string,
  then: Step[],
  otherwise?: Step[],
): BranchStep {
  const step: BranchStep = { id, kind: "branch", condition, then };
  if (otherwise !== undefined) step.else = otherwise;
  return step;
}

/** The pose a `from`/`to` source points at, when it is an inline pose rather than a ref. */
export const inlinePose = (source: PoseSource): Pose | null =>
  source === "current" || "ref" in source ? null : source;
