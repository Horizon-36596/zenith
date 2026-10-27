/**
 * Set up Zenith in a folder (issue #159), as view state apart from the editor store, like
 * `saveChoice.ts`: the question about a folder with no `zenith.json`, then the Gradle lines once the
 * files are written. `setupProject.ts` scans, writes and opens; `dialogs/SetupDialog.tsx` shows it.
 */
import { useSyncExternalStore } from "react";
import type { CommandLibrary } from "@horizon36596/zenith-core";
import type { ExistingProject } from "../project/setupFiles";
import type { SetupPlan } from "./setupPlan";

export interface SetupPrompt {
  /** The folder's own name. */
  folder: string;
  /** False when the folder has no TeamCode folder, so there was no code to scan. */
  teamCode: boolean;
  plan: SetupPlan;
  /** Files Set up would write that are already in the folder. Set up writes nothing while there are any. */
  taken: string[];
  /**
   * The autos already in the folder (issue #496), or null when it holds none. With them, Set up
   * writes only `zenith.json` pointing at them where they are, and a robot or field the folder lacks.
   */
  existing: ExistingProject | null;
  /** Why the last Set up wrote nothing, such as a robot class that is not a class name. */
  problem: string | null;
  /** Whether `problem` is about the robot class, so the dialog shows it under that field (issue #502). */
  problemAt?: "robotClass";
}

export interface SetupDone {
  folder: string;
  /** What was written, in order. */
  written: string[];
  library: CommandLibrary | null;
  robotClass: string | null;
  /** What to add to `build.dependencies.gradle`. */
  gradle: string;
}

interface View {
  prompt: SetupPrompt | null;
  done: SetupDone | null;
}

let view: View = { prompt: null, done: null };
const listeners = new Set<() => void>();

const set = (next: View): void => {
  view = next;
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const getView = (): View => view;
export const getSetupView = (): View => view;
export const useSetupView = (): View => useSyncExternalStore(subscribe, getView, getView);

/** Shows the Set up question for a folder, replacing whatever Set up showed before. */
export const showSetup = (prompt: SetupPrompt): void => {
  set({ prompt, done: null });
};

/** Puts why Set up wrote nothing under the question, or under the robot class when it is about that. */
export const setSetupProblem = (problem: string | null, at?: "robotClass"): void => {
  if (view.prompt === null) return;
  const { problemAt: _was, ...prompt } = view.prompt;
  set({ ...view, prompt: { ...prompt, problem, ...(at === undefined ? {} : { problemAt: at }) } });
};

/** Replaces the question with what was written and the Gradle lines. */
export const showSetupDone = (done: SetupDone): void => {
  set({ prompt: null, done });
};

export const hideSetup = (): void => {
  if (view.prompt !== null || view.done !== null) set({ prompt: null, done: null });
};
