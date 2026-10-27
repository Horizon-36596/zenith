/**
 * The notice "Import from another planner" leaves behind: what was imported and the importer's
 * warnings, or why nothing was. It is non-modal, so the person can read the warnings while they look
 * at the imported path, and it stays until they dismiss it or import something else. It is view state
 * only, so it lives apart from the editor store and never touches the document.
 */
import { useSyncExternalStore } from "react";

export interface ImportNotice {
  /** `warning` when the auto was imported with warnings, `ok` with none, `error` when it was not imported. */
  tone: "ok" | "warning" | "error";
  /** One sentence: what happened. */
  title: string;
  /** The file the person picked. */
  sourceName: string;
  /** Full sentences: the importer's warnings, or each wrong field with what is wrong with it. */
  lines: string[];
  /** One thing the person can do about the import from the notice, such as importing it for the other alliance. */
  action?: ImportNoticeAction;
}

export interface ImportNoticeAction {
  /** The button's text. */
  label: string;
  /** Its tooltip: what pressing it does. */
  hint: string;
  testId: string;
  run: () => void;
}

let notice: ImportNotice | null = null;
const listeners = new Set<() => void>();

const set = (next: ImportNotice | null): void => {
  notice = next;
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getImportNotice = (): ImportNotice | null => notice;
export const useImportNotice = (): ImportNotice | null => useSyncExternalStore(subscribe, getImportNotice, getImportNotice);

export const showImportNotice = (next: ImportNotice): void => {
  set(next);
};

export const dismissImportNotice = (): void => {
  if (notice !== null) set(null);
};
