/**
 * The small questions of issue #103, as view state apart from the editor store (like
 * `state/importNotice.ts`): where Save puts a read-only project's auto (the full project, or just
 * this auto), what to do with an auto opened on its own, and, since issue #158, what Just this auto
 * does about waypoints the picked project lacks or has elsewhere. `saveReadOnly.ts` asks and acts;
 * `dialogs/SaveChoiceDialog.tsx` shows them.
 */
import { useSyncExternalStore } from "react";
import type { WaypointAnswer } from "./waypointCheck";

export type SaveChoice = "project" | "auto" | "cancel";

export interface SaveChoicePrompt {
  fileName: string;
  /** The bundled example, rather than files picked on their own. */
  isExample: boolean;
  /** `folder`: both choices write into a folder the person picks. `download`: a zip, and the auto file. */
  where: "folder" | "download";
  /**
   * The project's waypoints have unsaved changes (issue #134). They are saved only with the full
   * project, so Just this auto is off and says why.
   */
  waypointsChanged?: boolean;
  /**
   * False when the folder Save the full project writes is not opened afterwards: the unsaved-edits
   * question asked before another project replaces this one (issue #158). The row then says to open
   * the folder later instead of promising Zenith opens it.
   */
  opensProject?: boolean;
  /** How many waypoints the auto follows by name, which Just this auto checks in the other project. */
  waypointsFollowed?: number;
}

/**
 * The step after Just this auto picked a project whose waypoints lack or differ from the ones the
 * auto follows (issue #158): each such name with both poses, and the ways on. Nothing is written
 * until the person answers.
 */
export interface WaypointCheckPrompt {
  fileName: string;
  /** The picked project's folder name. */
  project: string;
  /** Every name the auto follows. */
  followed: number;
  rows: Array<{ name: string; match: "missing" | "differs"; here: string; there: string | null }>;
  /** `<project>/autos/waypoints.json` when the missing waypoints can be added there, otherwise null. */
  addTo: string | null;
}

export type WaypointCheckAnswer = WaypointAnswer | "cancel";

export interface LoneAutoPrompt {
  /** The autos that were opened, by file name. */
  autoTexts: Readonly<Record<string, string>>;
}

interface View {
  saveChoice: SaveChoicePrompt | null;
  waypointCheck: WaypointCheckPrompt | null;
  loneAuto: LoneAutoPrompt | null;
}

let view: View = { saveChoice: null, waypointCheck: null, loneAuto: null };
let answer: ((choice: SaveChoice) => void) | null = null;
let checkAnswer: ((choice: WaypointCheckAnswer) => void) | null = null;
const listeners = new Set<() => void>();

const set = (patch: Partial<View>): void => {
  view = { ...view, ...patch };
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const getView = (): View => view;
/** The save question showing now, or null. */
export const getSaveChoice = (): SaveChoicePrompt | null => view.saveChoice;
/** The waypoint step of Just this auto showing now, or null. */
export const getWaypointCheck = (): WaypointCheckPrompt | null => view.waypointCheck;
export const useSaveChoiceView = (): View => useSyncExternalStore(subscribe, getView, getView);

/** Shows the save question and resolves with the person's choice. A second question cancels the first. */
export function askSaveChoice(prompt: SaveChoicePrompt): Promise<SaveChoice> {
  answer?.("cancel");
  return new Promise<SaveChoice>((resolve) => {
    answer = resolve;
    set({ saveChoice: prompt });
  });
}

/** The dialog's buttons, and its Escape. */
export function answerSaveChoice(choice: SaveChoice): void {
  const resolve = answer;
  answer = null;
  set({ saveChoice: null });
  resolve?.(choice);
}

/**
 * Shows the waypoint step of Just this auto and resolves with the person's answer. A second one
 * cancels the first, as the save question does.
 */
export function askWaypointCheck(prompt: WaypointCheckPrompt): Promise<WaypointCheckAnswer> {
  checkAnswer?.("cancel");
  return new Promise<WaypointCheckAnswer>((resolve) => {
    checkAnswer = resolve;
    set({ waypointCheck: prompt });
  });
}

/** The waypoint step's buttons, and its Escape. */
export function answerWaypointCheck(choice: WaypointCheckAnswer): void {
  const resolve = checkAnswer;
  checkAnswer = null;
  set({ waypointCheck: null });
  resolve?.(choice);
}

export const showLoneAuto =(prompt: LoneAutoPrompt): void => {
  set({ loneAuto: prompt });
};

export const dismissLoneAuto = (): void => {
  if (view.loneAuto !== null) set({ loneAuto: null });
};
