/**
 * The page's list of shares kept for offline use (`keptShares.ts`), and what the Partners panel does
 * with it (spec 13 section 6): Keep for offline, reopen, and remembering a link share opened here.
 *
 * Keep reads the share now, which is what puts it in the cloud's offline cache; if the share cannot
 * be read, it is not marked kept and the status line says why. Reopening reads it again the same
 * way, from the cache when there is no connection.
 */
import { useSyncExternalStore } from "react";
import { account } from "../account/store";
import { browserSessionStorage, browserStorage } from "../account/storage";
import { setStatus } from "../state/store";
import { KeptShares, keptSharesStorage, type KeptShare } from "./keptShares";
import { loadReceivedShare } from "./received";
import { onShareOpened, openShareById, openShareByLink } from "./store";
import { fromTeamWords } from "./words";

/**
 * `localStorage` while someone is signed in on their own device, and `sessionStorage` otherwise, so
 * a signed-out visitor's opened links, and the secrets in them, go when the tab closes.
 */
export const keptShares = new KeptShares(
  keptSharesStorage(browserStorage(), browserSessionStorage(), () => {
    const state = account.getState();
    return state.user !== null && !state.sharedComputer;
  }),
);

const SHARED_COMPUTER = "This is marked as a shared computer, so nothing is kept offline here.";

// A link share opened on this device, from its address or the list, is listed to open again.
onShareOpened((share) => {
  if (share.audience !== "link" || share.linkSecret === undefined || account.getState().sharedComputer) return;
  keptShares.recordOpenedLink({ id: share.id, secret: share.linkSecret, label: fromTeamWords(share) });
});

/** Reads a listed share again: a link share by its secret, a share to the team by its id. */
function openEntry(entry: { id: string; secret?: string }): ReturnType<typeof openShareById> {
  return entry.secret === undefined ? openShareById(entry.id) : openShareByLink(entry.secret);
}

/** Both stores: the list itself, and the account, whose sign-out clears it. */
function subscribe(listener: () => void): () => void {
  const stopKept = keptShares.subscribe(listener);
  const stopAccount = account.subscribe(listener);
  return () => {
    stopKept();
    stopAccount();
  };
}

export const useKeptShares = (): KeptShare[] => useSyncExternalStore(subscribe, keptShares.list, keptShares.list);

/** Why nothing can be kept offline here, or null. */
export const whyCannotKeep = (): string | null => (account.getState().sharedComputer ? SHARED_COMPUTER : null);

/**
 * Keep for offline, on a received share or an opened link. `label` is who it is from, as the list
 * shows it; once the share is read, the label is the one the share itself gives.
 */
export async function keepForOffline(entry: { id: string; secret?: string; label: string; via: "team" | "link" }, keep: boolean): Promise<void> {
  if (!keep) {
    keptShares.setKept(entry, false);
    setStatus("info", `No longer keeping the auto from ${entry.label} for offline use. The copy already here stays until you sign out.`);
    return;
  }
  const why = whyCannotKeep();
  if (why !== null) {
    setStatus("error", why);
    return;
  }
  const opened = await openEntry(entry);
  if (!opened.ok) {
    setStatus("error", opened.why);
    return;
  }
  const label = fromTeamWords(opened.share);
  keptShares.setKept({ ...entry, label }, true);
  setStatus("ok", `Kept the auto from ${label} for offline use on this computer. It opens here with no connection until it ends.`);
}

/** Opens a kept or opened-link share again: beside the open auto, or alone, as Load does. */
export async function reopenKept(entry: KeptShare): Promise<void> {
  const opened = await openEntry(entry);
  if (!opened.ok) {
    setStatus("error", opened.why);
    return;
  }
  await loadReceivedShare(opened.share);
}

/**
 * Reads every kept share again while online, so the offline copy is the newest one: a share that
 * follows the sharer's latest version changes on each publish. Failures are left for Open to report.
 */
export async function refreshKept(): Promise<void> {
  if (!account.getState().online) return;
  for (const entry of keptShares.list()) {
    if (entry.kept) await openEntry(entry).catch(() => undefined);
  }
}
