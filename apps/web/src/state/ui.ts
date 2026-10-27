/**
 * Shell-only view state that several components open or close: the insert menu (the tour, the
 * palette and the `Enter` key open it as well as its own button), the step list's context menu
 * and the help menu. Nothing here is about the document, so it lives apart from the editor store.
 */
import { useSyncExternalStore } from "react";

/** Which part of the insert menu is showing: the list of kinds, or one kind's options. */
export type InsertPane = "kinds" | "command" | "wait" | "parallel" | "branch";

/**
 * What the insert menu opens beside: the foot button of the step list, or the Steps header's +, when
 * that is the control that opened it. The palette, the tour, Enter and the menus open it at the foot.
 */
export type InsertAnchor = "foot" | "header";

export interface StepMenu {
  stepId: string;
  xPx: number;
  yPx: number;
}

export interface UiState {
  insertOpen: boolean;
  insertPane: InsertPane;
  insertAnchor: InsertAnchor;
  stepMenu: StepMenu | null;
  helpMenuOpen: boolean;
  /**
   * The envelope the next drag on the field draws (issue #120), armed by the inspector's "Draw on
   * the field": which step it is for, and the window and provenance it starts with. Null when no
   * envelope is being drawn.
   */
  envelopeDraw: EnvelopeDraw | null;
  /** The next click on the field picks the spot for a new waypoint, armed by the palette's Add waypoint. */
  placingWaypoint: boolean;
  /**
   * Settings, Keyboard is waiting for the new keys of a binding. While it is, the keyboard handler
   * (`app/useKeyboard.ts`) runs nothing.
   */
  capturingKey: boolean;
}

export interface EnvelopeDraw {
  stepId: string;
  maxDurationS: number;
  provenance: string;
}

let ui: UiState = { insertOpen: false, insertPane: "kinds", insertAnchor: "foot", stepMenu: null, helpMenuOpen: false, envelopeDraw: null, placingWaypoint: false, capturingKey: false };
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

export const openInsertMenu = (pane: InsertPane = "kinds", anchor: InsertAnchor = "foot"): void => {
  set({ insertOpen: true, insertPane: pane, insertAnchor: anchor, stepMenu: null, helpMenuOpen: false });
};

export const setCapturingKey = (capturingKey: boolean): void => {
  if (ui.capturingKey !== capturingKey) set({ capturingKey });
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

/** Arms the field to draw a new envelope for a step with the next drag. */
export const startEnvelopeDraw = (draw: EnvelopeDraw): void => {
  set({ envelopeDraw: draw });
};

/** Stops drawing an envelope: the drag finished, Esc, or the inspector's Cancel. */
export const stopEnvelopeDraw = (): void => {
  if (ui.envelopeDraw !== null) set({ envelopeDraw: null });
};

/** Arms the field: the next click on it places a new waypoint. */
export const startWaypointPlacement = (): void => {
  if (!ui.placingWaypoint) set({ placingWaypoint: true });
};

/** Disarms the placement: the click came, Esc, or the shell turned it off. */
export const stopWaypointPlacement = (): void => {
  if (ui.placingWaypoint) set({ placingWaypoint: false });
};

export const anyMenuOpen = (): boolean => ui.insertOpen || ui.stepMenu !== null || ui.helpMenuOpen;
