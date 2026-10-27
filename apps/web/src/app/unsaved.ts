/**
 * The one question asked before anything replaces an auto that has unsaved edits (QA-12): opening
 * another auto, the example, a folder, picked files, a GitHub repository or a pull request. Every
 * one of those paths calls `confirmReplace` first, so the check and the wording live here and
 * nowhere else. The dirty test is the store's `isDirty`, the same canonical-text comparison the
 * desktop app makes before it reloads a file that changed on disk.
 *
 * The question is a dialog with Save, Discard and Cancel (`dialogs/UnsavedDialog.tsx`), not
 * `window.confirm`, so it looks like every other dialog and can offer the third choice.
 */
import { canonicalize } from "@horizon36596/zenith-core";
import { getState, isDirty, setUnsavedPrompt, waypointsDirty, type State, type UnsavedPrompt } from "../state/store";
import { changedWaypointNames, followedNote, waypointImpact, waypointsFileName } from "./waypointImpact";

export type UnsavedChoice = "save" | "discard" | "cancel";

/** What the person picked tells the waiting `confirmReplace` whether to go on. */
let answer: ((choice: UnsavedChoice) => void) | null = null;

/**
 * Thrown by an open that the person cancelled, so a caller that reports errors can tell "nothing
 * was opened because you said so" from a real failure.
 */
export class KeptUnsavedEdits extends Error {
  constructor(fileName: string) {
    super(`Kept the unsaved edits in ${fileName}. Nothing else was opened.`);
    this.name = "KeptUnsavedEdits";
  }
}

/**
 * A save other than the backend's own, for a caller that must wait for it to finish: closing the
 * desktop app with the read-only example open saves a copy through the native Save As dialog
 * (sweep D4). `save` resolves true once the edits are safe, and false when they are not (the
 * person cancelled the dialog, or the write failed, which it has already said).
 */
export interface ReplaceOptions {
  saveLabel?: string;
  save?: () => Promise<boolean>;
  /**
   * The replacement stays in the open project: another of its autos, or a New auto (issue #158).
   * On a read-only project, Save the full project then opens the folder it wrote, so what comes next
   * happens there and the saved work is what the person sees. Every other replacement leaves it
   * unset, because whatever replaces the project would close that folder straight away.
   */
  sameProject?: boolean;
}

/**
 * What is not saved, worded by what is dirty (issue #191), when the project's waypoints file has
 * changes: "waypoints.json has changes that are not saved (2 other autos follow gardenSweepStart).
 * Discard puts them back." Undefined when the auto alone has them, which keeps the plain wording.
 */
async function waypointsLead(state: State): Promise<string | undefined> {
  if (!waypointsDirty(state)) return undefined;
  const names = changedWaypointNames(state);
  let note = "";
  try {
    note = followedNote(names, await waypointImpact(names, false, state));
  } catch {
    // The other autos could not be read: the question is still asked, without the count.
  }
  const autoDirty = state.auto !== null && canonicalize("auto", state.auto) !== state.savedCanonical;
  const file = waypointsFileName(state);
  const what = autoDirty ? `${state.fileName ?? "This auto"} and ${file} have changes` : `${file} has changes`;
  return `${what} that are not saved${note === "" ? "" : ` (${note})`}. Discard puts them back.`;
}

/**
 * Resolves true when the open auto can be replaced: it has no unsaved edits, or the person chose
 * Discard, or chose Save and the save went through. Resolves false on Cancel, or when the save
 * failed (the save has already said why). `next` is the sentence the dialog shows after "has
 * edits that are not saved", saying what would happen to it: "Opening collect-and-score.auto.json
 * will replace it." `options` gives the Save button another label and another save to wait for.
 */
export async function confirmReplace(next: string, options: ReplaceOptions = {}): Promise<boolean> {
  const state = getState();
  if (!isDirty(state)) return true;
  const lead = await waypointsLead(state);
  // A second question while one is showing replaces it; the first caller is told to stop.
  answer?.("cancel");
  const fileName = state.fileName ?? "This auto";
  const prompt: UnsavedPrompt = { fileName, next };
  if (lead !== undefined) prompt.lead = lead;
  if (options.saveLabel !== undefined) prompt.saveLabel = options.saveLabel;
  const choice = await askUnsaved(prompt);
  if (choice === "cancel") return false;
  if (choice === "discard") return true;
  if (options.save !== undefined) return options.save();
  const { save } = await import("./projectActions");
  // A read-only project's save asks where to put the auto. The folder it writes to is not opened
  // when whatever this question is about replaces the project straight after; when it stays in the
  // project, the full project's folder opens and the replacement happens there. Just this auto
  // never opens the other project from here (saveReadOnly.ts).
  await save(undefined, { open: false, sameProject: options.sameProject === true });
  return !isDirty();
}

/**
 * Asks the unsaved-changes question and waits for the answer, for any work that would be lost, not
 * only an auto: a proposal's unsent changes ask with it too (UI_GUIDE 9.14). A second question
 * while one is showing replaces it, and the first caller is told Cancel.
 */
export function askUnsaved(prompt: UnsavedPrompt): Promise<UnsavedChoice> {
  answer?.("cancel");
  return new Promise<UnsavedChoice>((resolve) => {
    answer = resolve;
    setUnsavedPrompt(prompt);
  });
}

/** Like `confirmReplace`, but throws `KeptUnsavedEdits` instead of resolving false. */
export async function requireReplace(next: string): Promise<void> {
  const fileName = getState().fileName ?? "this auto";
  if (!(await confirmReplace(next))) throw new KeptUnsavedEdits(fileName);
}

/** The dialog's buttons, and its Escape. */
export function answerUnsaved(choice: UnsavedChoice): void {
  const resolve = answer;
  answer = null;
  setUnsavedPrompt(null);
  resolve?.(choice);
}

/**
 * The tab-close guard: while there are unsaved edits, the browser asks before a reload or a close
 * drops them. The desktop app asks in its own way, so this is for the web only.
 */
export function guardUnload(): () => void {
  const onBeforeUnload = (event: BeforeUnloadEvent): void => {
    if (!isDirty()) return;
    event.preventDefault();
    // Chrome still wants returnValue set before it shows its prompt.
    event.returnValue = "";
  };
  window.addEventListener("beforeunload", onBeforeUnload);
  return () => {
    window.removeEventListener("beforeunload", onBeforeUnload);
  };
}
