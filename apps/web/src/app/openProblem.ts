/**
 * Why the last open failed (issue #502), kept apart from the editor store as `setupView.ts` is, so
 * the empty canvas can say it where the person is looking: "robot-repo did not open", the sentence
 * the status line has, and a way to open another of the same kind. A broken robot, zenith or field
 * file left only a status line while the canvas went on saying "Plan your first autonomous". The
 * next project that opens clears it.
 */
import { useSyncExternalStore } from "react";

/**
 * What was being opened: a folder (also Set up's last step and a saved copy), a GitHub repository,
 * picked or zipped files (also autos opened on the example), the bundled example, or a host's project.
 */
export type OpenKind = "folder" | "repo" | "files" | "example" | "host";

export interface OpenProblem {
  kind: OpenKind;
  /** The folder's or repository's name, or the host's, or null when the failure does not say. */
  name: string | null;
  /** What went wrong and what to do, as the status line says it. */
  message: string;
}

/**
 * The empty canvas's title for a failed open, and the button that opens another of the same kind:
 * the folder picker, or the Open project dialog for a repository or files. The example and a host's
 * project have none of their own; the canvas offers the example either way.
 */
export function openProblemView(problem: OpenProblem): { title: string; retry: { label: string; via: "folder" | "dialog" } | null } {
  const { kind, name } = problem;
  switch (kind) {
    case "folder":
      return { title: name === null ? "The folder did not open" : `${name} did not open`, retry: { label: "Open another folder…", via: "folder" } };
    case "repo":
      return {
        title: name === null ? "The repository did not open" : `${name} did not open`,
        retry: { label: "Open another repository…", via: "dialog" },
      };
    case "files":
      return { title: "The files did not open", retry: { label: "Open other files…", via: "dialog" } };
    case "example":
      return { title: "The example did not open", retry: null };
    case "host":
      return { title: name === null ? "The project did not open" : `The project from ${name} did not open`, retry: null };
  }
}

let problem: OpenProblem | null = null;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const get = (): OpenProblem | null => problem;

const set = (next: OpenProblem | null): void => {
  if (next === problem) return;
  problem = next;
  for (const listener of listeners) listener();
};

export const getOpenProblem = get;
export const useOpenProblem = (): OpenProblem | null => useSyncExternalStore(subscribe, get, get);

/** Keeps why an open failed, for the empty canvas. */
export const setOpenProblem = (next: OpenProblem): void => {
  set(next);
};

/** Forgets it, once a project opens or the person opens the example. */
export const clearOpenProblem = (): void => {
  set(null);
};
