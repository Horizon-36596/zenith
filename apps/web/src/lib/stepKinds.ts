/**
 * One icon per step kind, shared by the step list, the insert menu, the palette and the timeline,
 * so a kind looks the same everywhere it appears.
 */
import { GitBranch, Hourglass, Layers, ListOrdered, Spline, Zap, type LucideIcon } from "lucide-react";
import type { Step } from "@horizon36596/zenith-schema";

export const KIND_ICON: Record<Step["kind"], LucideIcon> = {
  path: Spline,
  command: Zap,
  wait: Hourglass,
  sequence: ListOrdered,
  parallel: Layers,
  branch: GitBranch,
};

/** The kind as a person would say it. */
export const KIND_LABEL: Record<Step["kind"], string> = {
  path: "Path",
  command: "Command",
  wait: "Wait",
  sequence: "Sequence",
  parallel: "Parallel group",
  branch: "Branch",
};
