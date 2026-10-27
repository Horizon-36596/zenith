/**
 * Which tab the bottom panel shows, Problems or Code (issue #102), remembered per browser under its
 * own key so the Code tab stays self-contained: nothing in the editor's preferences knows about it.
 * It also decides the panel's height when a tab opens (issue #413), further down.
 */
import { useSyncExternalStore } from "react";
import { DEFAULT_PREFS } from "../state/prefs";
import { getState, setPrefs } from "../state/store";

export type BottomTab = "problems" | "code";

const KEY = "zenith.bottomTab";

function load(): BottomTab {
  try {
    return window.localStorage.getItem(KEY) === "code" ? "code" : "problems";
  } catch {
    return "problems";
  }
}

let tab: BottomTab | null = null;
const listeners = new Set<() => void>();

const current = (): BottomTab => {
  tab ??= load();
  return tab;
};

export function setBottomTab(next: BottomTab): void {
  if (current() === next) return;
  tab = next;
  try {
    window.localStorage.setItem(KEY, next);
  } catch {
    // Storage blocked: the tab still changes, it is just not remembered.
  }
  for (const listener of listeners) listener();
}

/**
 * The tab the panel shows: the stored one, or Problems while the Code tab is off
 * (`features.codeTab`). A stored "code" is kept, not rewritten, so turning the Code tab back on opens
 * it where the person left it.
 */
export const shownBottomTab = (stored: BottomTab, codeTab: boolean): BottomTab => (codeTab ? stored : "problems");

/** Brings the Problems tab forward, for Validate, which focuses the panel to show the problems. */
export const showProblemsTab = (): void => {
  setBottomTab("problems");
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const useBottomTab = (): BottomTab => useSyncExternalStore(subscribe, current, current);

/*
 * The bottom panel's height (issue #413). The panel opens tall enough to read what is wrong, and the
 * Code tab opens tall enough to read code, but only while the person has not resized the panel: a
 * height they dragged to is theirs and nothing here changes it.
 *
 * The editor's own height goes into `prefs.findingsH` like a dragged one, so the resizer starts from
 * the height on screen. It is remembered here, with the height it replaced, so a later raise or
 * restore can tell it from the person's: `findingsH` still at the default or at the editor's own
 * height means the person has not set one.
 */

/** The panel header and a one-line problem row, as `--row-h` in tokens.css. */
export const PANEL_ROW_PX = 32;
/** The status line, which can sit over the bottom of the panel for a few seconds. */
const STATUS_PX = 28;
/** How many problem rows the panel opens with room for when there is an error or a warning. */
export const PROBLEM_ROWS = 4;
/** The height that shows the header and `PROBLEM_ROWS` rows above the status line. */
export const PROBLEMS_OPEN_PX = PANEL_ROW_PX + PROBLEM_ROWS * PANEL_ROW_PX + STATUS_PX;
/** The share of the field's column the Code tab opens to. */
export const CODE_SHARE = 0.6;
/** The tallest the panel is set, as the resizer allows (`App.tsx`). */
const MAX_PX = 420;

const AUTO_KEY = "zenith.bottomPanelHeight";

/** The height the editor set and the one it replaced, to go back to. */
export interface AutoHeight {
  setPx: number;
  restorePx: number;
}

function loadAuto(): AutoHeight | null {
  try {
    const raw = window.localStorage.getItem(AUTO_KEY);
    if (raw === null) return null;
    const value = JSON.parse(raw) as Partial<AutoHeight>;
    return typeof value.setPx === "number" && typeof value.restorePx === "number" ? { setPx: value.setPx, restorePx: value.restorePx } : null;
  } catch {
    return null;
  }
}

function saveAuto(value: AutoHeight | null): void {
  try {
    if (value === null) window.localStorage.removeItem(AUTO_KEY);
    else window.localStorage.setItem(AUTO_KEY, JSON.stringify(value));
  } catch {
    // Storage blocked: the height still changes, and the next raise reads it as the person's.
  }
}

/** Whether `heightPx` is one the person set by dragging: neither the default nor the editor's own. */
export const personSizedPanel = (heightPx: number, auto: AutoHeight | null): boolean =>
  heightPx !== DEFAULT_PREFS.findingsH && heightPx !== auto?.setPx;

/**
 * The height the panel should take for `wantPx`, or null to leave it: never lower, never past the
 * resizer's limit, and never over a height the person set.
 */
export function raisedHeight(currentPx: number, wantPx: number, auto: AutoHeight | null): number | null {
  if (personSizedPanel(currentPx, auto)) return null;
  const target = Math.min(MAX_PX, Math.round(wantPx));
  return target > currentPx ? target : null;
}

/** Raises the panel to `wantPx` unless the person set its height or it is already that tall. */
export function raiseBottomPanel(wantPx: number): void {
  const now = getState().prefs.findingsH;
  const auto = loadAuto();
  const next = raisedHeight(now, wantPx, auto);
  if (next === null) return;
  saveAuto({ setPx: next, restorePx: auto?.restorePx ?? now });
  setPrefs({ findingsH: next });
}

/** Puts back the height the editor's raise replaced, while the person has not resized it since. */
export function restoreBottomPanel(): void {
  const auto = loadAuto();
  if (auto === null) return;
  saveAuto(null);
  if (getState().prefs.findingsH === auto.setPx) setPrefs({ findingsH: auto.restorePx });
}

/** The height of the field's column the panel sits in, or 0 before it is laid out. */
function columnPx(): number {
  if (typeof document === "undefined") return 0;
  return document.querySelector<HTMLElement>("[data-findings-panel]")?.parentElement?.clientHeight ?? 0;
}

/**
 * The tab a person chose. The Code tab raises the panel to `CODE_SHARE` of the column; Problems puts
 * back the height the panel had, then makes room for four rows when `problems` (an error or a
 * warning is listed). A collapsed panel opens, since a click on a tab asks to see it.
 */
export function openBottomTab(next: BottomTab, problems: boolean): void {
  if (getState().prefs.findingsCollapsed) setPrefs({ findingsCollapsed: false });
  setBottomTab(next);
  if (next === "code") {
    raiseBottomPanel(columnPx() * CODE_SHARE);
    return;
  }
  restoreBottomPanel();
  if (problems) raiseBottomPanel(PROBLEMS_OPEN_PX);
}
