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
import { getState, isDirty, setUnsavedPrompt } from "../state/store";

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
 * Resolves true when the open auto can be replaced: it has no unsaved edits, or the person chose
 * Discard, or chose Save and the save went through. Resolves false on Cancel, or when the save
 * failed (the save has already said why). `next` is the sentence the dialog shows after "has
 * edits that are not saved", saying what would happen to it: "Opening collect-and-score.auto.json
 * will replace it."
 */
export async function confirmReplace(next: string): Promise<boolean> {
  const state = getState();
  if (!isDirty(state)) return true;
  // A second question while one is showing replaces it; the first caller is told to stop.
  answer?.("cancel");
  const fileName = state.fileName ?? "This auto";
  const choice = await new Promise<UnsavedChoice>((resolve) => {
    answer = resolve;
    setUnsavedPrompt({ fileName, next });
  });
  if (choice === "cancel") return false;
  if (choice === "discard") return true;
  const { save } = await import("./projectActions");
  await save();
  return !isDirty();
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
