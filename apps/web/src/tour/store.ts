/**
 * The running tour: one `TourState`, the reducer from `model.ts`, and the saved progress in UI
 * preferences. A separate observable from the editor store, because the tour is view state that
 * nothing about the document depends on.
 */
import { useSyncExternalStore } from "react";
import type { Auto, Waypoints } from "@horizon36596/zenith-schema";
import { canonicalize, walkSteps } from "@horizon36596/zenith-core";
import { clearStaleStatus, commit, commitWithWaypoints, getState, sameWaypoints, selectStep, setPrefs, setStatus } from "../state/store";
import {
  TOUR_OFF,
  currentStop,
  progressAfter,
  shouldAutoStart,
  tourReducer,
  type TourEvent,
  type TourSignal,
  type TourState,
} from "./model";
import { setTourSink } from "./signals";
import { currentTourStops } from "./stops";

let tour: TourState = TOUR_OFF;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getTour = (): TourState => tour;

export const useTour = (): TourState => useSyncExternalStore(subscribe, getTour, getTour);

export function dispatchTour(event: TourEvent): void {
  const before = tour;
  // A tour that starts, whoever started it, answers the card: it is a first-run question, and the
  // tour marks the visit seen, so it never comes back (spec 15 section 9).
  if (event.type === "startCore" || event.type === "startFull") closePresetCard();
  if (event.type !== "signal" && doneTimer !== null) {
    clearTimeout(doneTimer);
    doneTimer = null;
    doneKey = null;
  }
  const stops = currentTourStops();
  const after = tourReducer(before, event, stops);
  if (after === before) return;
  // A stop's Try it task is a demonstration: what it changed goes back when the stop is left, so the
  // later stops, Problems and Play among them, show the auto as it was (0.1.2 UX review, S2).
  const left = currentStop(before, stops);
  const entered = currentStop(after, stops);
  if (left !== entered) {
    putBackTryIt();
    if (entered?.task !== undefined && TASKS_THAT_EDIT.has(entered.task.signal)) rememberTryIt();
  }
  tour = after;
  const progress = getState().prefs.tour;
  const next = progressAfter(progress, before, after);
  if (next !== progress) setPrefs({ tour: next });
  if (after.phase === "off") sayTourEnded(before, event);
  for (const listener of listeners) listener();
}

/**
 * The line a tour leaves as it ends (UI_GUIDE 9.15): Skip tour and Escape on a stop say how to see it
 * again; any other end (Jump in, Finish) only takes away a line an earlier action left, which would
 * otherwise read as the answer to the tour.
 */
function sayTourEnded(before: TourState, event: TourEvent): void {
  if (event.type === "exit" && (before.phase === "core" || before.phase === "full")) {
    setStatus("info", "Tour skipped.", "Replay it from Help, Take the tour.");
  } else clearStaleStatus();
}

/** The Try it tasks that change the auto: a dot dragged, a step added, a heading turned. */
export const TASKS_THAT_EDIT: ReadonlySet<TourSignal> = new Set<TourSignal>(["pointDragged", "stepInserted", "headingTurned"]);

/** The status line that says the tour put a Try it edit back. */
export const TRY_IT_PUT_BACK = "The tour put the auto back as it was. Undo brings your change back.";

/** The auto and the project's waypoints as a stop with an editing task found them, or null. */
let tryIt: { fileName: string | null; auto: Auto; waypoints: Waypoints | undefined } | null = null;

function rememberTryIt(): void {
  const { auto, fileName, project } = getState();
  tryIt = auto === null ? null : { fileName, auto, waypoints: project?.waypoints };
}

/**
 * Puts the auto back as the stop found it, when the same auto is still open and something changed,
 * as one edit, so Undo brings the person's change back if they wanted it.
 */
function putBackTryIt(): void {
  const kept = tryIt;
  tryIt = null;
  if (kept === null) return;
  const { auto, fileName, project } = getState();
  if (auto === null || fileName !== kept.fileName) return;
  const sameAuto = auto === kept.auto || canonicalize("auto", auto) === canonicalize("auto", kept.auto);
  const sameWaypointFile = sameWaypoints(project?.waypoints, kept.waypoints);
  if (sameAuto && sameWaypointFile) return;
  if (sameWaypointFile || project === null || kept.waypoints === undefined) commit(kept.auto);
  else commitWithWaypoints(kept.auto, kept.waypoints);
  // A step the task added is gone again, so it is no longer selected.
  const selected = getState().selection.stepId;
  if (selected !== undefined && ![...walkSteps(kept.auto.steps)].some((step) => step.id === selected)) selectStep(undefined);
  setStatus("info", TRY_IT_PUT_BACK);
}

/** How long the task's check shows before the tour moves on (UI_GUIDE section 10.2). */
const TASK_DONE_MS = 700;

/** The stop whose task was just done, keyed `phase:index`, while its check shows. */
let doneKey: string | null = null;
let doneTimer: ReturnType<typeof setTimeout> | null = null;

const keyOf = (state: TourState): string => `${state.phase}:${String(state.index)}`;

/**
 * Tells the tour's readers that the task's check came or went. The check is not part of `tour`, so the
 * snapshot is copied: `useTour` draws again only for a new snapshot, and with the same one the check
 * showed only when something else drew the card again (issue #403).
 */
function showDone(): void {
  tour = { ...tour };
  for (const listener of listeners) listener();
}

export const isTaskDone = (state: TourState): boolean => doneKey === keyOf(state);

/**
 * Called by the shell wherever the person does something a tour stop can wait for. A no-op while
 * no tour is running, so callers never need to check. When it matches the stop's task the check
 * fills first and the tour moves on a moment later, so the person sees that it worked.
 */
export function tourSignal(signal: TourSignal): void {
  if (tour.phase === "off" || doneKey !== null) return;
  const stop = currentStop(tour, currentTourStops());
  if (stop?.task?.signal !== signal) return;
  const key = keyOf(tour);
  doneKey = key;
  showDone();
  doneTimer = setTimeout(() => {
    doneKey = null;
    doneTimer = null;
    if (keyOf(tour) === key) dispatchTour({ type: "signal", signal });
    else showDone();
  }, TASK_DONE_MS);
}

setTourSink(tourSignal);

export const startCoreTour = (): void => {
  dispatchTour({ type: "startCore" });
};

/**
 * Starts the core tour when this is someone's first visit and something is open to point at, and
 * does nothing otherwise, so a returning visitor, whose `prefs.tour.seen` is set, never gets it
 * again by itself. Called once the first-run example has loaded, and in host mode once the host's
 * project has opened, which is how most people first meet Zenith.
 */
export function autoStartTour(): void {
  const state = getState();
  if (tour.phase === "off" && shouldAutoStart(state.prefs.tour, state.auto !== null)) startCoreTour();
}

/* ---- The first run's preset card ---------------------------------------------------------- */

let presetCardOpen = false;

export const getPresetCardOpen = (): boolean => presetCardOpen;

/** Whether the first-run preset card is on screen. Shares the tour's listeners, so one render covers both. */
export const usePresetCardOpen = (): boolean => useSyncExternalStore(subscribe, getPresetCardOpen, getPresetCardOpen);

/** Shows or hides the first-run preset card; `firstRun.ts` decides when. */
export function setPresetCardOpen(open: boolean): void {
  if (presetCardOpen === open) return;
  presetCardOpen = open;
  for (const listener of listeners) listener();
}

export const closePresetCard = (): void => {
  setPresetCardOpen(false);
};

export const startFullTour = (at?: string): void => {
  dispatchTour(at === undefined ? { type: "startFull" } : { type: "startFull", at });
};

/** The full-tour stop that explains a help id's panel, for the "Show me" link, if there is one. */
export const stopFor = (anchor: string): string | undefined =>
  currentTourStops().full.find((stop) => stop.anchor === anchor)?.id ??
  currentTourStops().core.find((stop) => stop.anchor === anchor)?.id;
