/**
 * Which pair of library revisions the review view shows, if any (spec 13 section 5.3). A small
 * observable store beside the editor's, so opening the review never touches the open auto: the
 * editor's document, selection and undo history stay exactly as they were underneath it.
 */
import { useSyncExternalStore } from "react";
import type { SolidSide } from "./revisionReview";

export interface LibraryReviewState {
  autoId: string;
  /** The library auto's title, which is its file name. */
  title: string;
  /** The two revision ids, in the order they were asked for. */
  ids: readonly [string, string];
  /** Which side is drawn solid; the other is the ghost. */
  solid: SolidSide;
  /** The changed step picked in the list, drawn selected on the field. */
  stepId: string | null;
}

let state: LibraryReviewState | null = null;
const listeners = new Set<() => void>();

function set(next: LibraryReviewState | null): void {
  state = next;
  for (const listener of listeners) listener();
}

export const getLibraryReview = (): LibraryReviewState | null => state;

export function subscribeLibraryReview(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const useLibraryReview = (): LibraryReviewState | null =>
  useSyncExternalStore(subscribeLibraryReview, getLibraryReview, getLibraryReview);

/** Opens the review on two revisions. The second side starts solid, over the first. */
export function showLibraryReview(autoId: string, title: string, ids: readonly [string, string]): void {
  set({ autoId, title, ids, solid: "second", stepId: null });
}

export function closeLibraryReview(): void {
  set(null);
}

/** Draws the other side solid. */
export function swapLibraryReview(): void {
  if (state !== null) set({ ...state, solid: state.solid === "first" ? "second" : "first" });
}

export function selectLibraryReviewStep(stepId: string | null): void {
  if (state !== null) set({ ...state, stepId });
}
