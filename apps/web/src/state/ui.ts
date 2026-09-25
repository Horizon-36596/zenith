/**
 * Shell-only view state that several components open or close: the insert menu (the tour, the
 * palette and the `Enter` key open it as well as its own button), the step list's context menu
 * and the help menu. Nothing here is about the document, so it lives apart from the editor store.
 */
import { useSyncExternalStore } from "react";

/** Which part of the insert menu is showing: the list of kinds, or one kind's options. */
export type InsertPane = "kinds" | "command" | "wait" | "parallel" | "branch";

export interface StepMenu {
  stepId: string;
  xPx: number;
  yPx: number;
}

export interface UiState {
  insertOpen: boolean;
  insertPane: InsertPane;
  stepMenu: StepMenu | null;
  helpMenuOpen: boolean;
}

let ui: UiState = { insertOpen: false, insertPane: "kinds", stepMenu: null, helpMenuOpen: false };
const listeners = new Set<() => void>();

const set = (patch: Partial<UiState>): void => {
  ui = { ...ui, ...patch };
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getUi = (): UiState => ui;
export const useUi = (): UiState => useSyncExternalStore(subscribe, getUi, getUi);

export const openInsertMenu = (pane: InsertPane = "kinds"): void => {
  set({ insertOpen: true, insertPane: pane, stepMenu: null, helpMenuOpen: false });
};

export const setInsertPane = (pane: InsertPane): void => {
  set({ insertPane: pane });
};

export const closeInsertMenu = (): void => {
  if (ui.insertOpen) set({ insertOpen: false, insertPane: "kinds" });
};

export const openStepMenu = (menu: StepMenu): void => {
  set({ stepMenu: menu, insertOpen: false, helpMenuOpen: false });
};

export const closeStepMenu = (): void => {
  if (ui.stepMenu !== null) set({ stepMenu: null });
};

export const setHelpMenuOpen = (helpMenuOpen: boolean): void => {
  set({ helpMenuOpen, insertOpen: helpMenuOpen ? false : ui.insertOpen });
};

/** Closes every menu this module owns: Escape, and a tour stop that needs a clear screen. */
export const closeMenus = (): void => {
  set({ insertOpen: false, insertPane: "kinds", stepMenu: null, helpMenuOpen: false });
};

export const anyMenuOpen = (): boolean => ui.insertOpen || ui.stepMenu !== null || ui.helpMenuOpen;
