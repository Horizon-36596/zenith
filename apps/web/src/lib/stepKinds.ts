/**
 * One icon per step kind, shared by the step list, the insert menu, the palette and the timeline,
 * so a kind looks the same everywhere it appears.
 */
import { ArrowRightLeft, GitBranch, Hourglass, Layers, ListOrdered, RotateCcw, Spline, Zap, type LucideIcon } from "lucide-react";
import { isTurnInPlace, type Plan, type PlanStep } from "@horizon36596/zenith-core";
import type { Step } from "@horizon36596/zenith-schema";

export const KIND_ICON: Record<Step["kind"], LucideIcon> = {
  path: Spline,
  command: Zap,
  wait: Hourglass,
  transfer: ArrowRightLeft,
  sequence: ListOrdered,
  parallel: Layers,
  branch: GitBranch,
};

/**
 * The kind as a person would say it, one word each, the same in the insert menu, the step list and
 * the Inspector (issue #411): Path, Command, Wait, Transfer, Sequence, Parallel and Branch. A turn on
 * the spot is a path step, so it has no kind of its own here.
 */
export const KIND_LABEL: Record<Step["kind"], string> = {
  path: "Path",
  command: "Command",
  wait: "Wait",
  transfer: "Transfer",
  sequence: "Sequence",
  parallel: "Parallel",
  branch: "Branch",
};

/** The kind in a sentence, after "a": "toGarden, a path, about 3.5 s". */
export const KIND_NOUN: Record<Step["kind"], string> = {
  path: "a path",
  command: "a command",
  wait: "a wait",
  transfer: "a transfer",
  sequence: "a sequence",
  parallel: "a parallel group",
  branch: "a branch",
};
/**
 * A turn on the spot is a path step with no length (core's `isTurnInPlace`), and it reads as a turn
 * wherever a kind is shown: the insert menu's icon, "Turn" and "a turn on the spot" (issue #505).
 */
export const TURN_ICON: LucideIcon = RotateCcw;
export const TURN_LABEL = "Turn";
export const TURN_NOUN = "a turn on the spot";

/** The ids of the planned steps that are turns on the spot, at any depth. */
export function turnIds(plan: Pick<Plan, "steps"> | null): Set<string> {
  const ids = new Set<string>();
  const walk = (steps: readonly PlanStep[]): void => {
    for (const step of steps) {
      if (isTurnInPlace(step)) ids.add(step.id);
      if (step.children !== undefined) walk(step.children);
    }
  };
  if (plan !== null) walk(plan.steps);
  return ids;
}
