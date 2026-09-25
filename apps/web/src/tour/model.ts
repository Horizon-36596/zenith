/**
 * The guided tour as a pure state machine (site/docs/getting-started.md, the first-run tour): a core tour
 * of about six stops, then a choice between the full tour and jumping straight in. Nothing here
 * touches the DOM, the store or the clock, so every transition is a unit test
 * (`model.test.ts`); `Tour.tsx` renders whatever state this says and feeds events back in.
 */
import type { TourProgress } from "../state/prefs";

/**
 * Something the person did in the editor that a stop can wait for. The shell raises these from
 * the same functions a button, a shortcut and a canvas gesture all call, so a stop that says
 * "drag a point" advances however the point was moved.
 */
export type TourSignal =
  | "pointDragged"
  | "stepSelected"
  | "stepInserted"
  | "insertMenuOpened"
  | "playToggled"
  | "toolChanged"
  | "snapToggled"
  | "allianceToggled"
  | "paletteOpened"
  | "shortcutsOpened"
  /** A heading changed on the canvas: an arrow dragged, a range boundary moved, a split. */
  | "headingTurned";

/**
 * What the shell does before a stop shows, so the thing it points at is on screen.
 * `selectPathWithMarker` and `selectPathWithPose` pick the first path that has a marker, or a pose
 * written out in numbers (which is what carries a provenance chip), and fall back to the first path.
 * `selectPathWithHeadingArrows` picks the first path whose heading arrows can be dragged (Constant,
 * Linear, or a piecewise heading with such a range).
 */
export type TourPrepare =
  | "selectFirstPath"
  | "selectPathWithHeadingArrows"
  | "selectPathWithMarker"
  | "selectPathWithPose"
  | "selectNothing"
  | "openInsertMenu"
  | "closeMenus";

export interface TourStop {
  id: string;
  /** The `data-tour` value of the element the coach mark points at; null centres the card. */
  anchor: string | null;
  title: string;
  /** One or two plain sentences for someone who has never planned an FTC path. */
  body: string;
  /** An optional thing to try. The stop advances by itself when the person does it. */
  task?: { label: string; signal: TourSignal };
  prepare?: TourPrepare;
  /** Which side of the anchor the card sits on. The renderer flips it to stay on screen. */
  side?: "top" | "bottom" | "left" | "right";
  /**
   * Other `data-tour` anchors the card must not cover, when the stop's task happens somewhere
   * other than its anchor: the Heading stop rings the toolbar button but asks for a drag on the field.
   */
  keepClear?: readonly string[];
}

export interface TourStops {
  core: readonly TourStop[];
  full: readonly TourStop[];
}

/**
 * `off`: nothing shown. `core` and `full`: a coach mark at `index`. `choice`: the card after the
 * core tour. `finished`: the closing card after the full tour.
 */
export type TourPhase = "off" | "core" | "choice" | "full" | "finished";

export interface TourState {
  phase: TourPhase;
  index: number;
}

export type TourEvent =
  | { type: "startCore" }
  /** `at` starts at the stop with that id: the "Show me" link in a help tooltip. */
  | { type: "startFull"; at?: string }
  | { type: "next" }
  | { type: "back" }
  | { type: "chooseFull" }
  | { type: "jumpIn" }
  | { type: "exit" }
  | { type: "signal"; signal: TourSignal };

export const TOUR_OFF: TourState = { phase: "off", index: 0 };

const listOf = (phase: TourPhase, stops: TourStops): readonly TourStop[] =>
  phase === "core" ? stops.core : phase === "full" ? stops.full : [];

/** The stop on screen, or null for the choice card, the closing card and no tour. */
export function currentStop(state: TourState, stops: TourStops): TourStop | null {
  return listOf(state.phase, stops)[state.index] ?? null;
}

function advance(state: TourState, stops: TourStops): TourState {
  const list = listOf(state.phase, stops);
  if (state.index + 1 < list.length) return { phase: state.phase, index: state.index + 1 };
  if (state.phase === "core") return { phase: "choice", index: 0 };
  if (state.phase === "full") return { phase: "finished", index: 0 };
  return state;
}

export function tourReducer(state: TourState, event: TourEvent, stops: TourStops): TourState {
  switch (event.type) {
    case "startCore":
      return stops.core.length === 0 ? { phase: "choice", index: 0 } : { phase: "core", index: 0 };
    case "startFull": {
      if (stops.full.length === 0) return { phase: "finished", index: 0 };
      const at = event.at === undefined ? 0 : stops.full.findIndex((stop) => stop.id === event.at);
      return { phase: "full", index: Math.max(0, at) };
    }
    case "next":
      if (state.phase === "choice") return { phase: "full", index: 0 };
      if (state.phase === "finished") return TOUR_OFF;
      return advance(state, stops);
    case "back":
      if (state.phase === "choice") return { phase: "core", index: Math.max(0, stops.core.length - 1) };
      if (state.phase === "finished") return { phase: "full", index: Math.max(0, stops.full.length - 1) };
      if (state.phase === "core" || state.phase === "full") {
        return { phase: state.phase, index: Math.max(0, state.index - 1) };
      }
      return state;
    case "chooseFull":
      return state.phase === "choice" ? { phase: "full", index: 0 } : state;
    case "jumpIn":
      return state.phase === "choice" ? TOUR_OFF : state;
    case "exit":
      return TOUR_OFF;
    case "signal": {
      const stop = currentStop(state, stops);
      return stop?.task?.signal === event.signal ? advance(state, stops) : state;
    }
  }
}

/**
 * What the transition from `before` to `after` means for the saved progress. Starting any tour
 * marks it seen, so a reload in the middle of it, a skip or a "Jump in" all keep it from starting
 * by itself again; reaching the choice card finishes the core tour and reaching the closing card
 * finishes the full one.
 */
export function progressAfter(
  progress: TourProgress,
  before: TourState,
  after: TourState,
): TourProgress {
  if (before.phase === after.phase && before.index === after.index) return progress;
  let next = progress;
  if (after.phase !== "off" && !next.seen) next = { ...next, seen: true };
  if (after.phase === "choice" && !next.coreDone) next = { ...next, coreDone: true };
  if (after.phase === "finished" && !next.fullDone) next = { ...next, fullDone: true };
  return next;
}

/** Whether the tour should start by itself: only on a first visit, once there is something to show. */
export const shouldAutoStart = (progress: TourProgress, hasDocument: boolean): boolean =>
  !progress.seen && hasDocument;

/** "3 / 6", for the card (UI_GUIDE section 10.2). The choice and closing cards have no position. */
export function positionLabel(state: TourState, stops: TourStops): string | null {
  const list = listOf(state.phase, stops);
  if (list.length === 0) return null;
  return `${String(state.index + 1)} / ${String(list.length)}`;
}
