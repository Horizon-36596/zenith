/**
 * The hidden-data hooks of a switch that hides file data. Turning such a switch off never changes a
 * file: what it hides stays in the auto, keeps its time and saves unchanged. These hooks say what the
 * switch hides, so the step list, the selection, moving a step and deleting a group
 * (`state/features.ts`) treat every such switch alike. Today only Commands hides data.
 *
 * The module is pure, like the registry that holds the hooks: no DOM and no storage.
 */
import type { Finding } from "@horizon36596/zenith-core";
import type { Auto } from "@horizon36596/zenith-schema";
import { indexSteps } from "../lib/stepOps";

/** What a selection may point at that a switch can hide. */
export interface HideableSelection {
  stepId?: string;
  markerIndex?: number;
}

export interface HiddenDataHooks {
  /** The ids of the steps, at any depth, the switch hides in `auto` while it is off. */
  hiddenSteps: (auto: Auto) => ReadonlySet<string>;
  /**
   * The selection with the parts of a step the switch hides taken out, such as a marker, which
   * becomes its path. A selected hidden step is cleared before this is asked.
   */
  shownSelection: <T extends HideableSelection>(selection: T) => T;
  /**
   * Whether a finding is about data the switch hides beyond its own finding codes and its hidden
   * steps, judged on the finding alone.
   */
  hidesFinding: (finding: Pick<Finding, "code" | "message">) => boolean;
  /** The one line the step list shows while the switch is off and `auto` holds hidden data, or null. */
  note: (auto: Auto) => string | null;
  /** What one hidden step is called, and several, for the question before a delete. */
  stepNoun: { one: string; many: string };
}

const NONE: ReadonlySet<string> = new Set();

const plural = (count: number, one: string, many: string): string => `${String(count)} ${count === 1 ? one : many}`;

/** How many markers the auto's paths carry, at any depth. */
export function markerCount(auto: Auto | null): number {
  if (auto === null) return 0;
  let count = 0;
  for (const entry of indexSteps(auto)) if (entry.step.kind === "path") count += entry.step.markers?.length ?? 0;
  return count;
}

const commandSteps = (auto: Auto): ReadonlySet<string> => {
  const hidden = new Set<string>();
  for (const entry of indexSteps(auto)) if (entry.step.kind === "command") hidden.add(entry.id);
  return hidden.size === 0 ? NONE : hidden;
};

/**
 * Commands: its command steps, at any depth, and the markers on paths. The commit 15fd38fd rule:
 * they stay in the file and keep their time, the step list says how many are hidden, a hidden step
 * can never be selected, and a marker selection falls back to its path.
 */
export const COMMANDS_HIDDEN_DATA: HiddenDataHooks = {
  hiddenSteps: commandSteps,
  shownSelection: (selection) => {
    if (selection.markerIndex === undefined) return selection;
    const rest = { ...selection };
    delete rest.markerIndex;
    return rest;
  },
  // SCHEMA also covers a command the robot does not register; the message is the only thing that says so.
  hidesFinding: (finding) => finding.code === "SCHEMA" && finding.message.includes("names the command"),
  note: (auto) => {
    const steps = commandSteps(auto).size;
    const markers = markerCount(auto);
    if (steps === 0 && markers === 0) return null;
    const parts = [steps === 0 ? null : plural(steps, "command step", "command steps"), markers === 0 ? null : plural(markers, "marker", "markers")]
      .filter((part): part is string => part !== null)
      .join(" and ");
    return `This auto has ${parts}. Turn on Commands in Settings, General to see them.`;
  },
  stepNoun: { one: "command step", many: "command steps" },
};
