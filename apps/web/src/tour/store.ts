/**
 * The running tour: one `TourState`, the reducer from `model.ts`, and the saved progress in UI
 * preferences. A separate observable from the editor store, because the tour is view state that
 * nothing about the document depends on.
 */
import { useSyncExternalStore } from "react";
import { getState, setPrefs } from "../state/store";
import {
  TOUR_OFF,
  currentStop,
  progressAfter,
  tourReducer,
  type TourEvent,
  type TourSignal,
  type TourState,
} from "./model";
import { setTourSink } from "./signals";
import { TOUR_STOPS } from "./stops";

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
  if (event.type !== "signal" && doneTimer !== null) {
    clearTimeout(doneTimer);
    doneTimer = null;
    doneKey = null;
  }
  const after = tourReducer(before, event, TOUR_STOPS);
  if (after === before) return;
  tour = after;
  const progress = getState().prefs.tour;
  const next = progressAfter(progress, before, after);
  if (next !== progress) setPrefs({ tour: next });
  for (const listener of listeners) listener();
}

/** How long the task's check shows before the tour moves on (UI_GUIDE section 10.2). */
const TASK_DONE_MS = 700;

/** The stop whose task was just done, keyed `phase:index`, while its check shows. */
let doneKey: string | null = null;
let doneTimer: ReturnType<typeof setTimeout> | null = null;

const keyOf = (state: TourState): string => `${state.phase}:${String(state.index)}`;

export const isTaskDone = (state: TourState): boolean => doneKey === keyOf(state);

/**
 * Called by the shell wherever the person does something a tour stop can wait for. A no-op while
 * no tour is running, so callers never need to check. When it matches the stop's task the check
 * fills first and the tour moves on a moment later, so the person sees that it worked.
 */
export function tourSignal(signal: TourSignal): void {
  if (tour.phase === "off" || doneKey !== null) return;
  const stop = currentStop(tour, TOUR_STOPS);
  if (stop?.task?.signal !== signal) return;
  const key = keyOf(tour);
  doneKey = key;
  for (const listener of listeners) listener();
  doneTimer = setTimeout(() => {
    doneKey = null;
    doneTimer = null;
    if (keyOf(tour) === key) dispatchTour({ type: "signal", signal });
    else for (const listener of listeners) listener();
  }, TASK_DONE_MS);
}

setTourSink(tourSignal);

export const startCoreTour = (): void => {
  dispatchTour({ type: "startCore" });
};

export const startFullTour = (at?: string): void => {
  dispatchTour(at === undefined ? { type: "startFull" } : { type: "startFull", at });
};

/** The full-tour stop that explains a help id's panel, for the "Show me" link, if there is one. */
export const stopFor = (anchor: string): string | undefined =>
  TOUR_STOPS.full.find((stop) => stop.anchor === anchor)?.id ??
  TOUR_STOPS.core.find((stop) => stop.anchor === anchor)?.id;
