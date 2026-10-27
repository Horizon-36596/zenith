/**
 * The owner's review of one proposal (spec 13 section 14), from a file or from the cloud: the
 * proposal as read, the pinned revision it is read against, which changes the owner has accepted,
 * and which an Apply has already made. A small observable store beside the editor's.
 *
 * Applying is the one thing that touches the auto, and it goes through the editor's ordinary edit
 * path (`tryEdit`), so each Apply is one undo step and nothing is written to a file until the owner
 * saves as usual.
 */
import { useSyncExternalStore } from "react";
import type { ProjectShareInput, ShareStatus } from "@horizon36596/zenith-core";
import type { Auto, ShareRef } from "@horizon36596/zenith-schema";

/** A proposal opened from the cloud: which one, who sent it, and what the owner decided so far. */
export interface CloudReviewRef {
  proposalId: string;
  /** "Team 12345" */
  fromTeam: string;
  status: "open" | "accepted" | "rejected" | "withdrawn";
  /** True while a decision is on its way, so it is not sent twice. */
  deciding: boolean;
}

/** Where the pinned revision came from, which the review says in words. */
export type PinnedSource = "current" | "revision";

/** One Apply: the changes it made, and the auto's canonical text just before it, for undo. */
export interface ApplyRecord {
  indexes: number[];
  beforeCanonical: string;
}

export interface OwnerReviewState {
  fileName: string;
  proposal: unknown;
  /** The pinned revision the proposal is read against, planned and simulated. */
  pinned: ProjectShareInput;
  pinnedAuto: Auto;
  pinnedSource: PinnedSource;
  /** The share it was opened from, when it was opened from the Sharing page. */
  shareRef?: ShareRef;
  share?: ShareStatus;
  /** The cloud proposal it is, when it was opened from the Sharing page's received proposals. */
  cloud?: CloudReviewRef;
  accepted: Set<number>;
  /**
   * The changes the owner pressed Reject on, from 0. A change in neither set is undecided, and shows
   * neither Accept nor Reject pressed; Apply leaves it out, as it does a rejected one.
   */
  rejected: Set<number>;
  applies: ApplyRecord[];
  /** The change the list and the canvas point at, from 0. */
  focus: number | null;
}

let review: OwnerReviewState | null = null;
const listeners = new Set<() => void>();

const emit = (next: OwnerReviewState | null): void => {
  review = next;
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getOwnerReview = (): OwnerReviewState | null => review;

export const useOwnerReview = (): OwnerReviewState | null => useSyncExternalStore(subscribe, getOwnerReview, getOwnerReview);

export const openOwnerReview = (state: OwnerReviewState): void => {
  emit(state);
};

export const closeOwnerReview = (): void => {
  emit(null);
};

/** Records which changes the owner has accepted and which rejected. */
export const setDecisions = (accepted: Set<number>, rejected: Set<number>): void => {
  if (review === null) return;
  emit({ ...review, accepted, rejected });
};

/**
 * Records what became of the cloud proposal `proposalId`. A decision is sent in the background, so
 * by the time it comes back the owner may be reviewing a different proposal; then nothing changes.
 */
export const setCloudReview = (proposalId: string, patch: Partial<Omit<CloudReviewRef, "proposalId">>): void => {
  if (review?.cloud?.proposalId !== proposalId) return;
  emit({ ...review, cloud: { ...review.cloud, ...patch } });
};

export const setFocus = (focus: number | null): void => {
  if (review === null) return;
  emit({ ...review, focus });
};

/**
 * Records an Apply. An earlier Apply made from this same auto text has been undone since (the auto
 * is back to what it was before it), so it and every one after it are dropped: otherwise an Apply on
 * a new branch would make `liveApplied` count the undone ones as still in the auto.
 */
export const recordApply = (record: ApplyRecord): void => {
  if (review === null) return;
  const accepted = new Set([...review.accepted].filter((index) => !record.indexes.includes(index)));
  const undone = review.applies.findIndex((earlier) => earlier.beforeCanonical === record.beforeCanonical);
  const kept = undone === -1 ? review.applies : review.applies.slice(0, undone);
  emit({ ...review, accepted, applies: [...kept, record] });
};

/**
 * The changes an Apply made that the auto still has. When the auto is back to what it was just
 * before an Apply, that Apply, and every one after it, has been undone.
 */
export function liveApplied(state: Pick<OwnerReviewState, "applies">, currentCanonical: string | null): Set<number> {
  const live = new Set<number>();
  for (const record of state.applies) {
    if (currentCanonical === record.beforeCanonical) break;
    for (const index of record.indexes) live.add(index);
  }
  return live;
}
