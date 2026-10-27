/**
 * The proposer's session (spec 13 section 14): which partner share is being edited, the changes
 * made so far, what is selected on the partner's routine, and the session's own playback. A small
 * observable store beside the editor's, so nothing here can reach the user's own auto: the
 * editor's document, its undo stack and its selection are never written.
 *
 * The session lives in memory only, like the partners it comes from. "Save proposal…" and "Send to
 * the share" are the only ways anything leaves it (`sink.ts`).
 */
import { useSyncExternalStore } from "react";
import type { Projection, ProposalChange, ShareRef } from "@horizon36596/zenith-schema";
import { SHARE_ID_PATTERN } from "@horizon36596/zenith-schema";
import type { PartnerShare } from "../cloud/partnerShare";
import type { PointTarget } from "../canvas/types";

/** What is selected on the partner's routine: a step, and a point of it. */
export interface ProposerSelection {
  stepId?: string;
  point?: PointTarget;
}

export interface ProposerSession {
  /** The alliance store's id of the partner being edited. */
  partnerId: string;
  label: string;
  fileName: string;
  projection: Projection;
  shareRef: ShareRef;
  /**
   * The received cloud share the partner was loaded from, which the proposal can be sent to; absent
   * for a partner loaded from a file, whose `shareRef` is then only a local reference.
   */
  share?: PartnerShare;
  changes: ProposalChange[];
  /** Earlier versions of `changes`, for the session's own undo. */
  undo: ProposalChange[][];
  redo: ProposalChange[][];
  selection: ProposerSelection;
  /** The session's scrubber, on the alliance clock. */
  playbackS: number;
  playing: boolean;
}

const HISTORY_LIMIT = 200;

let session: ProposerSession | null = null;
/** Set while a drag is running, so the whole drag is one undo step. */
let dragBase: ProposalChange[] | null = null;
const listeners = new Set<() => void>();

const emit = (next: ProposerSession | null): void => {
  session = next;
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getProposerSession = (): ProposerSession | null => session;

export const useProposerSession = (): ProposerSession | null =>
  useSyncExternalStore(subscribe, getProposerSession, getProposerSession);

/**
 * The share id a file-loaded projection is proposed against until the proposer says otherwise: the
 * file name without its extensions, in the characters a share id may hold. The team that shared
 * it can match it by eye; its own review checks the structure hash, which is what matters.
 */
export function defaultShareId(fileName: string): string {
  const base = fileName.slice(Math.max(fileName.lastIndexOf("/"), fileName.lastIndexOf("\\")) + 1);
  const stem = base.replace(/\.json$/i, "").replace(/\.projection$/i, "").replace(/\.propose$/i, "");
  const cleaned = stem.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.length > 0 && SHARE_ID_PATTERN.test(cleaned) ? cleaned : "share";
}

/** Starts editing a proposal against a partner's propose-level share. */
export function startProposerSession(input: {
  partnerId: string;
  label: string;
  fileName: string;
  projection: Projection;
  shareRef: ShareRef;
  share?: PartnerShare;
}): void {
  dragBase = null;
  emit({ ...input, changes: [], undo: [], redo: [], selection: {}, playbackS: 0, playing: false });
}

/** Ends the session; the changes are forgotten unless they were saved. */
export function endProposerSession(): void {
  dragBase = null;
  emit(null);
}

/** Replaces the changes, as one undo step unless a drag is running. */
export function setChanges(changes: ProposalChange[]): void {
  if (session === null) return;
  if (JSON.stringify(changes) === JSON.stringify(session.changes)) return;
  if (dragBase !== null) {
    emit({ ...session, changes, redo: [] });
    return;
  }
  emit({ ...session, changes, undo: [...session.undo, session.changes].slice(-HISTORY_LIMIT), redo: [] });
}

/** A drag began: every change until `endDrag` is one undo step. */
export function beginDrag(): void {
  if (session === null || dragBase !== null) return;
  dragBase = session.changes;
}

export function endDrag(): void {
  const base = dragBase;
  dragBase = null;
  if (session === null || base === null) return;
  if (JSON.stringify(base) === JSON.stringify(session.changes)) return;
  emit({ ...session, undo: [...session.undo, base].slice(-HISTORY_LIMIT), redo: [] });
}

export function undoChange(): void {
  if (session === null) return;
  const previous = session.undo[session.undo.length - 1];
  if (previous === undefined) return;
  emit({ ...session, changes: previous, undo: session.undo.slice(0, -1), redo: [...session.redo, session.changes] });
}

export function redoChange(): void {
  if (session === null) return;
  const next = session.redo[session.redo.length - 1];
  if (next === undefined) return;
  emit({ ...session, changes: next, redo: session.redo.slice(0, -1), undo: [...session.undo, session.changes] });
}

export function setProposerSelection(selection: ProposerSelection): void {
  if (session === null) return;
  emit({ ...session, selection });
}

/** Edits a file partner's local reference. A cloud partner's comes from its share and stays. */
export function setShareRef(shareRef: ShareRef): void {
  if (session === null || session.share !== undefined) return;
  emit({ ...session, shareRef });
}

export function setProposerPlayback(playbackS: number): void {
  if (session === null) return;
  emit({ ...session, playbackS: Math.max(0, playbackS) });
}

export function setProposerPlaying(playing: boolean): void {
  if (session === null) return;
  emit({ ...session, playing });
}
