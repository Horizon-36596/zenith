/**
 * The page's one `AccountModel`, and how the rest of the app reaches it: `useAccount` for components,
 * `account` for actions, and `initAccount`, which the account root calls once. With the cloud off
 * (`config.ts`), `initAccount` does nothing and every account control stays hidden.
 *
 * Start-up never asks anything of the person (spec 13 section 4.1): it only reads a saved session,
 * follows a `#/join/<code>` link, and finishes an email sign-in link the page was opened from.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import { FAKE, fakeVerificationDocs } from "../admin/fakeVerification";
import { onAutoPublished } from "../cloud/followLatest";
import { openShareSecret, takeShareSecret } from "../cloud/received";
import { BROKEN_LINK, isBrokenLinkHash } from "../cloud/shareModel";
import { closeSharingSheet, subscribeCloud, getCloud } from "../cloud/store";
import { commitFor } from "../library/gitCommits";
import { desktopBridge } from "../project/desktop";
import { clearStaleStatus, getState as getEditor, isDirty, setStatus, useEditor, type State } from "../state/store";
import { createFakeDevice, createPageBackend } from "./backendFactory";
import { currentCloudConfig } from "./config";
import { parseJoinHash } from "./invites";
import { AccountModel, type AccountPanel, type AccountState } from "./model";
import { feedbackShown } from "./feedbackShown";
import { browserStorage } from "./storage";
import { publishedRevisionOf, wireCloudSession } from "./wiring";

const config = currentCloudConfig();

export const account = new AccountModel({
  mode: config.mode,
  storage: browserStorage(),
  now: () => Date.now(),
  createBackend: (options) => createPageBackend(config, options),
  pageUrl: () => (typeof window === "undefined" ? "http://localhost/" : window.location.href),
  deviceOnline: () => (typeof navigator === "undefined" ? true : navigator.onLine),
  say: (kind, message) => {
    setStatus(kind, message);
  },
  feedbackShown,
  gitShaFor: commitFor,
  onPublished: (revision) => onAutoPublished(publishedRevisionOf(revision)),
  // In the desktop app, sign-in goes through the system browser (nativeSignIn.ts).
  nativeSignIn: desktopBridge()?.cloudSignIn ?? null,
  createFakeDevice,
});

export const useAccount = (): AccountState =>
  useSyncExternalStore(account.subscribe, account.getState, account.getState);

/** Opens one account sheet, closing the sharing sheet so two never sit on top of each other. */
export function openAccountPanel(panel: Exclude<AccountPanel, null>): void {
  if (getCloud().sheet !== null) closeSharingSheet();
  account.open(panel);
  clearStaleStatus();
}

/** Toggles a sheet from its toolbar button. */
export function toggleAccountPanel(panel: Exclude<AccountPanel, null>): void {
  if (account.getState().panel === panel) account.close();
  else openAccountPanel(panel);
}

let started = false;

/**
 * The sign-in link and the join link in the address are followed once per page, however often the
 * root mounts (React mounts twice in development), because a sign-in link works only once.
 */
let followedStart = false;

/**
 * A share link's secret taken out of the address bar at start-up, before the cloud started, and
 * held here in memory only until the share opens. Never written anywhere.
 */
let heldShareSecret: string | null = null;

/** Takes the query-free, hash-free address back into the address bar. */
const clearShareHash = (): void => {
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
};

/**
 * An invite or share link cut short opens nothing, so it is said on the status line (`BROKEN_LINK`),
 * and taken out of the address bar so a reload does not say it again.
 */
function refuseBrokenLink(): void {
  if (!isBrokenLinkHash(window.location.hash)) return;
  clearShareHash();
  setStatus("error", BROKEN_LINK);
}

/** Starts the cloud session, once, when the cloud is on. Returns the clean-up. */
export function initAccount(): () => void {
  if (config.mode === "off" || started) return () => undefined;
  started = true;
  const stops: Array<() => void> = [];

  // A `#/s/<secret>` share link (spec 13 section 8.5): the secret is the share's key (spec 14), so
  // it leaves the address bar now, before the cloud starts, and waits in memory until it opens.
  heldShareSecret ??= takeShareSecret(window.location.hash, clearShareHash);
  refuseBrokenLink();

  const onConnection = () => {
    account.deviceConnectionChanged();
  };
  window.addEventListener("online", onConnection);
  window.addEventListener("offline", onConnection);
  stops.push(() => {
    window.removeEventListener("online", onConnection);
    window.removeEventListener("offline", onConnection);
  });

  // The sharing sheet and an account sheet share the right edge: opening the one closes the other.
  stops.push(
    subscribeCloud(() => {
      if (getCloud().sheet !== null && account.getState().panel !== null) account.close();
    }),
  );

  // One sign-in: the sharing store and the verification UI run on the account's backend.
  stops.push(wireCloudSession(account));

  const followJoin = () => {
    const code = parseJoinHash(window.location.hash);
    if (code !== null) void account.openJoin(code);
    else refuseBrokenLink();
  };
  // A share link opened later on this page: out of the address bar at once, opened once started.
  const followShare = () => {
    const secret = takeShareSecret(window.location.hash, clearShareHash);
    if (secret !== null) void account.start().then(() => openShareSecret(secret));
  };
  window.addEventListener("hashchange", followJoin);
  window.addEventListener("hashchange", followShare);
  stops.push(() => {
    window.removeEventListener("hashchange", followJoin);
    window.removeEventListener("hashchange", followShare);
  });

  if (followedStart) return cleanUp(stops);
  followedStart = true;
  void account.start().then(async () => {
    const href = window.location.href;
    if (await account.handleIncomingLink(href)) {
      // The link's one-time code is spent; keep it out of the address bar and the history.
      const clean = new URL(href);
      for (const key of [...clean.searchParams.keys()]) {
        if (key !== "cloud") clean.searchParams.delete(key);
      }
      window.history.replaceState(null, "", clean.toString());
    }
    followJoin();
    const held = heldShareSecret;
    heldShareSecret = null;
    if (held !== null) await openShareSecret(held);
  });

  return cleanUp(stops);
}

/**
 * The fake cloud only: adds the review page's demonstration teams, requests and disputes
 * (`admin/fakeVerification.ts`) and signs in as their Horizon admin, so `#/admin` has a queue to
 * work. Documents already in the fake, such as a team a test made on the same number, are kept.
 */
export async function signInAsDemoReviewer(): Promise<boolean> {
  if (!account.isFake()) return false;
  account.seedFake(fakeVerificationDocs(Date.now()));
  return account.switchFakeUser(FAKE.reviewer);
}

function cleanUp(stops: Array<() => void>): () => void {
  return () => {
    for (const stop of stops) stop();
    started = false;
  };
}

/**
 * Publish on every save (spec 13 section 5.2), as a hook the account root runs. The editor marks a
 * save by setting the saved text and the "Saved." status in one change, which is what this watches
 * for. Opening an auto also sets the saved text, but never that status.
 */
export function useWatchSaves(): void {
  const editor = useEditor();
  const previous = useRef<State>(editor);
  useEffect(() => {
    const before = previous.current;
    previous.current = editor;
    if (config.mode === "off") return;
    const saved =
      editor.savedCanonical !== null &&
      editor.savedCanonical !== before.savedCanonical &&
      editor.fileName !== null &&
      editor.fileName === before.fileName &&
      editor.status !== before.status &&
      editor.status?.message === "Saved.";
    if (!saved || editor.fileName === null || editor.savedCanonical === null) return;
    const project = editor.project;
    void account.onEditorSaved({
      fileName: editor.fileName,
      canonical: editor.savedCanonical,
      project: project === null ? null : { robot: project.robot, field: project.field, waypoints: project.waypoints },
    });
  }, [editor]);
}

/** The editor's saved file, as Publish sends it, or null with nothing open. */
export function savedFile(state: State = getEditor()): {
  fileName: string;
  canonical: string;
  project: State["project"];
} | null {
  if (state.fileName === null || state.savedCanonical === null || state.auto === null) return null;
  return { fileName: state.fileName, canonical: state.savedCanonical, project: state.project };
}

/**
 * True when the editor has unsaved edits, to the auto or to the project's waypoints: `isDirty`
 * itself, so a publish never sends waypoints that differ from the saved file (issue #134).
 */
export const editorDirty = (state: State = getEditor()): boolean => isDirty(state);
