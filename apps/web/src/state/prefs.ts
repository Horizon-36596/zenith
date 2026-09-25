/**
 * UI preferences, and only UI preferences. Nothing about a project is kept here: the files are the
 * state (site/docs/editor.md). The last opened folder is a File System
 * Access handle and lives in IndexedDB instead, because a handle cannot be stringified.
 */
export type Theme = "dark" | "light";

/**
 * How far the guided tour has got (site/docs/editor.md). `seen` is what keeps the
 * tour from starting again on the next visit, whichever way the person left it; `coreDone` and
 * `fullDone` record which of the two tours they finished, so the help menu can offer the rest.
 */
export interface TourProgress {
  seen: boolean;
  coreDone: boolean;
  fullDone: boolean;
}

/**
 * How the field is drawn under the routine (site/docs/editor.md). The same union
 * as the canvas's `FieldView`, kept here so preferences do not import the canvas.
 */
export type FieldView = "image" | "image+outlines" | "vector";

/**
 * Where the robot on the field and the timeline's clock come from (site/docs/simulation.md,
 * "Playback levels"): the planned path exactly, the instant sim, or the robot repository's own sim.
 * The same union as the canvas's `PlaybackLevel`, kept here so preferences do not import the canvas.
 */
export type PlaybackLevel = "ideal" | "instant" | "full";

export const NO_TOUR_PROGRESS: TourProgress = { seen: false, coreDone: false, fullDone: false };

export interface Prefs {
  theme: Theme;
  snap: boolean;
  panelLeftW: number;
  panelRightW: number;
  findingsH: number;
  findingsCollapsed: boolean;
  /** The ledger is folded to its title and a one-line summary until opened (UI_GUIDE 9.8). */
  ledgerOpen: boolean;
  tour: TourProgress;
  fieldView: FieldView;
  /** The field picture's named look (`field.image.variants`), or null for the field's default. */
  fieldStyle: string | null;
  /** Group rows folded shut in the step list, each as `fileName#stepId` (`foldKey`). */
  foldedGroups: string[];
  /**
   * The playback level last chosen. `full` is remembered but only used while a full sim trace is
   * loaded; without one the editor plays the ideal level (`state/playback.ts`).
   */
  playbackLevel: PlaybackLevel;
}

/** The most folded groups remembered; the oldest are forgotten first. */
export const MAX_FOLDED_GROUPS = 200;

/** A group's key in `foldedGroups`: the auto's file name and the group's id, so two autos never share one. */
export const foldKey = (fileName: string | null, stepId: string): string => `${fileName ?? ""}#${stepId}`;

export const DEFAULT_PREFS: Prefs = {
  theme: "dark",
  snap: true,
  panelLeftW: 300,
  panelRightW: 320,
  findingsH: 180,
  findingsCollapsed: false,
  ledgerOpen: false,
  tour: NO_TOUR_PROGRESS,
  fieldView: "image+outlines",
  fieldStyle: null,
  foldedGroups: [],
  playbackLevel: "ideal",
};

const KEY = "zenith.ui";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export function loadPrefs(): Prefs {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return DEFAULT_PREFS;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return DEFAULT_PREFS;
    return {
      theme: parsed["theme"] === "light" ? "light" : "dark",
      snap: parsed["snap"] !== false,
      panelLeftW: typeof parsed["panelLeftW"] === "number" ? parsed["panelLeftW"] : 300,
      panelRightW: typeof parsed["panelRightW"] === "number" ? parsed["panelRightW"] : 320,
      findingsH: typeof parsed["findingsH"] === "number" ? parsed["findingsH"] : 180,
      findingsCollapsed: parsed["findingsCollapsed"] === true,
      ledgerOpen: parsed["ledgerOpen"] === true,
      tour: parseTour(parsed["tour"]),
      fieldView:
        parsed["fieldView"] === "image" || parsed["fieldView"] === "vector"
          ? parsed["fieldView"]
          : "image+outlines",
      fieldStyle: typeof parsed["fieldStyle"] === "string" ? parsed["fieldStyle"] : null,
      foldedGroups: Array.isArray(parsed["foldedGroups"])
        ? parsed["foldedGroups"]
            .filter((key): key is string => typeof key === "string")
            .slice(-MAX_FOLDED_GROUPS)
        : [],
      playbackLevel:
        parsed["playbackLevel"] === "instant" || parsed["playbackLevel"] === "full"
          ? parsed["playbackLevel"]
          : "ideal",
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function parseTour(value: unknown): TourProgress {
  if (!isRecord(value)) return NO_TOUR_PROGRESS;
  return {
    seen: value["seen"] === true,
    coreDone: value["coreDone"] === true,
    fullDone: value["fullDone"] === true,
  };
}

export function savePrefs(prefs: Prefs): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // A browser with storage blocked still runs the editor; it just forgets the panel widths.
  }
}

/** Applies the theme to the document element, which is where tokens.css reads it. */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset["theme"] = theme;
}
