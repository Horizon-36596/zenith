/**
 * What the step list needs on top of `@horizon36596/zenith-core`'s edit primitives: the tree walked into flat
 * rows with a depth and a branch arm, a deep copy with fresh ids, and the factories for a new step
 * of each kind. The mutations themselves are core's (`packages/core/src/edit/`), which validate the
 * result, so the editor never builds a document the schema would reject.
 */
import { childPrefix, collectIds, effectiveId, uniqueId } from "@horizon36596/zenith-core";
import { childLists, withChildLists } from "@horizon36596/zenith-schema";
import type {
  BranchStep,
  CommandSpec,
  CommandStep,
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

/** A deep copy whose own id and every nested id is free in `auto`. */
export function cloneWithFreshIds(auto: Auto, step: Step): Step {
  const taken = collectIds(auto.steps);
  const rename = (original: Step): Step => {
    const copy = structuredClone(original) as Step;
    if (copy.id !== undefined) {
      const fresh = uniqueId(`${copy.id}Copy`, taken);
      taken.add(fresh);
      copy.id = fresh;
    }
    return withChildLists(copy, childLists(copy).map((list) => list.map(rename)));
  };
  return rename(step);
}

/** An id nothing in the document uses, derived from `base` with no randomness. */
export const freshId = (auto: Auto, base: string): string => uniqueId(base, collectIds(auto.steps));

/* ---- Step factories ---------------------------------------------------- */

export function newPathStep(id: string, from: PoseSource, to: Pose): PathStep {
  const segment: Segment = { kind: "line", from, to };
  return { id, kind: "path", segments: [segment], heading: { mode: "tangent" } };
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
