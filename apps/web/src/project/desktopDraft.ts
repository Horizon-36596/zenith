/**
 * Unsaved edits that survive a crash of the desktop app's page. The page sends the open auto's
 * unsaved text to the main process whenever it changes, and nothing once it is saved; the main
 * process keeps it in memory only (apps/desktop/src/main/crashRecovery.ts). If the page crashes,
 * main's own question offers Reload, and the reloaded page takes the edits back here and opens them
 * as unsaved edits again, on top of the file on disk, so Undo goes back to what was saved.
 */
import { canonicalize, loadAuto } from "@horizon36596/zenith-core";
import type { Auto } from "@horizon36596/zenith-schema";
import { commit, getState, isDirty, openAuto, setStatus, subscribeEditor } from "../state/store";
import { DesktopBackend } from "./desktop";
import type { DesktopDraft, ZenithDesktopBridge } from "./desktopBridge";

/**
 * How long the page waits after an edit before it sends the draft (SET BY HAND: a drag sends one
 * draft when it ends rather than one per frame, and a crash loses at most this much).
 */
export const DRAFT_DELAY_MS = 500;

/** The draft the editor's state stands for: the open auto's text while it has unsaved edits, else null. */
export function draftOf(state = getState()): DesktopDraft | null {
  if (state.auto === null || state.fileName === null || !isDirty(state)) return null;
  const source = state.project?.source;
  return { root: source?.kind === "desktop" ? source.root : null, fileName: state.fileName, text: canonicalize("auto", state.auto) };
}

let stopSync: (() => void) | null = null;

/** Keeps the main process's copy of the unsaved edits up to date, from now on. */
export function startDraftSync(bridge: ZenithDesktopBridge): void {
  const hold = bridge.drafts?.hold;
  if (hold === undefined || stopSync !== null) return;
  // Nothing has gone out yet, so the first send always does, even "no draft": main may still hold
  // one from before a plain reload, which a later crash would otherwise offer back.
  let sent: string | null | undefined = undefined;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const send = (): void => {
    timer = null;
    const draft = draftOf();
    const key = draft === null ? null : `${draft.root ?? ""}\n${draft.fileName}\n${draft.text}`;
    if (key === sent) return;
    sent = key;
    void hold.call(bridge.drafts, draft).catch(() => undefined);
  };
  const unsubscribe = subscribeEditor(() => {
    timer ??= setTimeout(send, DRAFT_DELAY_MS);
  });
  stopSync = () => {
    unsubscribe();
    if (timer !== null) clearTimeout(timer);
    stopSync = null;
  };
  send();
}

/** Stops the sync, for tests. */
export function stopDraftSyncForTests(): void {
  stopSync?.();
}

/**
 * After a crash and Reload: opens the auto the kept edits belong to, when it is in the project that
 * reopened, and puts the edits back as unsaved edits. Says on the status line what it did, or why it
 * could not, in which case main still holds the edits until the next save or crash.
 */
export async function restoreDraft(bridge: ZenithDesktopBridge): Promise<void> {
  const draft = await bridge.drafts?.take().catch(() => null);
  if (draft === undefined || draft === null) return;
  const lost = (why: string): void => {
    setStatus("error", `Zenith could not bring back your unsaved edits to ${draft.fileName}.`, why);
  };
  const state = getState();
  const source = state.project?.source;
  const root = source?.kind === "desktop" ? source.root : null;
  if (draft.root === null || root !== draft.root || !(state.backend instanceof DesktopBackend)) {
    lost("Its project did not reopen.");
    return;
  }
  let edited: Auto;
  try {
    edited = loadAuto(JSON.parse(draft.text));
  } catch {
    lost("The kept copy does not load.");
    return;
  }
  if (state.fileName !== draft.fileName) {
    try {
      const loaded = await state.backend.readAuto(draft.fileName);
      openAuto(loaded.fileName, loaded.auto, loaded.canonical);
    } catch {
      lost(`${draft.fileName} is no longer in the project.`);
      return;
    }
  }
  if (getState().auto === null || getState().fileName !== draft.fileName) {
    lost(`${draft.fileName} did not open.`);
    return;
  }
  // One edit on top of the file as saved, so the auto reads as unsaved and Undo goes back to disk.
  commit(edited);
  setStatus("info", `Brought back your unsaved edits to ${draft.fileName}.`, "Save keeps them.");
}
