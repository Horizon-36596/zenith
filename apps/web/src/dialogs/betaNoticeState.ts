/**
 * The beta notice's state: a small dialog on the first load of each version that says Zenith is in
 * beta and where to report a bug (`BetaNotice.tsx` draws it). Its dismissal is remembered in
 * localStorage under a key that names the version, so a new version shows it once more. Storage that
 * is blocked or throws is never an error: the notice then shows on every load, and the app works as
 * usual once it is closed.
 *
 * The notice comes first and alone. While it is open, the first run's preset card and tour wait for
 * it (`afterBetaNotice`), and so do the pages a link opens on load (a share, invite or admin link).
 */
import { useSyncExternalStore } from "react";

/** The localStorage key that records the notice was closed for one version. */
export const betaNoticeKey = (version: string): string => `zenith.betaNotice.${version}`;

/** The value written under the key. Anything else there counts as not dismissed. */
export const BETA_NOTICE_DISMISSED = "dismissed";

/** The slice of `Storage` the notice uses, so a test can hand it one that throws. */
export interface NoticeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The page's localStorage, or null where reaching it throws (blocked site data, some private windows). */
function pageStorage(): NoticeStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Whether the notice is due: not dismissed for this version, or storage that cannot say. */
export function betaNoticeDue(version: string, storage: NoticeStorage | null): boolean {
  if (storage === null) return true;
  try {
    return storage.getItem(betaNoticeKey(version)) !== BETA_NOTICE_DISMISSED;
  } catch {
    return true;
  }
}

/** Records the dismissal. A write that throws is dropped, so the notice shows again next load. */
export function rememberBetaNoticeDismissed(version: string, storage: NoticeStorage | null): void {
  if (storage === null) return;
  try {
    storage.setItem(betaNoticeKey(version), BETA_NOTICE_DISMISSED);
  } catch {
    // Nothing to do: the notice shows on the next load, which is the documented fallback.
  }
}

let open = false;
let decided = false;
let shownFor = "";
let waiting: Array<() => void> = [];
const listeners = new Set<() => void>();

const notify = (): void => {
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const isBetaNoticeOpen = (): boolean => open;

/** Whether the notice is on screen, for a component that hides what must wait for it. */
export const useBetaNoticeOpen = (): boolean => useSyncExternalStore(subscribe, isBetaNoticeOpen, isBetaNoticeOpen);

/**
 * Decides, once per page load, whether the notice shows for this version. Called before the first
 * render, so the notice is in the first frame and nothing that waits for it starts early.
 */
export function initBetaNotice(version: string, storage: NoticeStorage | null = pageStorage()): void {
  if (decided) return;
  decided = true;
  shownFor = version;
  open = betaNoticeDue(version, storage);
  notify();
}

/** Got it, or Escape: remembers it for this version and lets whatever was waiting go on. */
export function dismissBetaNotice(storage: NoticeStorage | null = pageStorage()): void {
  if (!open) return;
  rememberBetaNoticeDismissed(shownFor, storage);
  open = false;
  notify();
  const run = waiting;
  waiting = [];
  for (const next of run) next();
}

/** Runs `next` now when the notice is closed, or once it closes. */
export function afterBetaNotice(next: () => void): void {
  if (open) waiting.push(next);
  else next();
}

/** For tests: back to a page that has not decided yet. */
export function resetBetaNoticeForTest(): void {
  open = false;
  decided = false;
  shownFor = "";
  waiting = [];
  notify();
}
