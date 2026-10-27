/**
 * Back and forward between screens (issue #83): the mouse's side buttons, Alt + Left and Alt + Right,
 * and in the desktop app on Windows the window's `browser-backward` and `browser-forward` commands,
 * go to the screen the person was just on and back again, like a browser.
 *
 * The history is the app's own list (`screenHistory.ts`), not the browser's. The browser's history
 * already holds entries the app does not own (a share link's secret is taken out of it, the sign-in
 * link is cleaned out of it, `#/admin` adds one), the desktop app has no browser history to speak of,
 * and a step back to another auto can be refused at the unsaved-changes question, which a browser
 * history move cannot be. So the side buttons and Alt + arrows never leave the page or reload it, and
 * the browser's own back button on the web keeps doing what it did before.
 *
 * Nothing reports to this module by hand. It watches the stores every screen already opens and
 * closes through (the editor's open auto and dialog, the account sheets, the Settings window and
 * its section, the sharing sheets, the `#/admin` address), and records each new place. Going back calls the same open and close
 * functions the buttons call, so a screen opened from history is the same as one opened by hand,
 * and opening another auto with unsaved edits asks Save, Discard or Cancel as it always does.
 */
import { account, openAccountPanel } from "../account/store";
import { cloudEnabled } from "../account/config";
import { closeAdminPage, onAdminRouteChange } from "../admin/AdminRoute";
import { openAdminDashboard } from "../account/AdminEntry";
import { isAdminHash } from "../admin/model";
import { closeSharingSheet, getCloud, openShareViewer, openSharingSheet, subscribeCloud } from "../cloud/store";
import { desktopBridge } from "../project/desktop";
import { closeSettings, getSettings, openSettings, subscribeSettings } from "../settings/store";
import { getState, setDialog, subscribeEditor } from "../state/store";
import { openAutoNamed } from "./projectActions";
import {
  NavInputGate,
  SCREEN_DIALOGS,
  ScreenHistory,
  keyDirection,
  mouseButtonDirection,
  restorePlan,
  samePlace,
  type NavDirection,
  type NavKeyLike,
  type NavSource,
  type Place,
  type SharingPlace,
} from "./screenHistory";

/** Where the person is now, read from the stores. */
export function currentPlace(): Place {
  const editor = getState();
  const cloud = getCloud();
  let sharing: SharingPlace | null = null;
  if (cloud.sheet === "share") sharing = { sheet: "share" };
  else if (cloud.sheet === "sharing") sharing = { sheet: "sharing", autoId: cloud.sharingAutoId };
  else if (cloud.sheet === "viewer" && cloud.viewing !== null) sharing = { sheet: "viewer", share: cloud.viewing };
  return {
    file: editor.fileName,
    dialog: editor.dialog !== null && SCREEN_DIALOGS.has(editor.dialog) ? editor.dialog : null,
    account: cloudEnabled() ? account.getState().panel : null,
    settings: settingsPlace(),
    sharing: cloudEnabled() ? sharing : null,
    admin: cloudEnabled() && isAdminHash(window.location.hash),
  };
}

/** The Settings section showing, or null with the window closed. */
function settingsPlace(): Place["settings"] {
  const settings = getSettings();
  return settings.open ? settings.section : null;
}

let history: ScreenHistory<Place> | null = null;
/** The project the history belongs to. Another project starts a new history. */
let historyBackend: unknown = null;
/** True while a step back or forward is being carried out, so its own changes are not recorded. */
let moving = false;
let checkQueued = false;
const gate = new NavInputGate();

/** Records the place now, once per burst of store changes (one click often changes two stores). */
function queueCheck(): void {
  if (checkQueued) return;
  checkQueued = true;
  queueMicrotask(() => {
    checkQueued = false;
    record();
  });
}

function record(): void {
  if (history === null || moving) return;
  const backend = getState().backend;
  const place = currentPlace();
  if (backend !== historyBackend) {
    // Another project: its autos are not this one's, so the places before it cannot be gone back to.
    historyBackend = backend;
    history.reset(place);
    return;
  }
  // The moment before a project's first auto opened is not a screen to go back to.
  if (history.current.file === null && place.file !== null && !history.canGo("back")) {
    history.replace(place);
    return;
  }
  history.visit(place);
}

/** Carries out the steps to `to`. False when the person kept their unsaved edits, and nothing moved. */
async function restore(to: Place): Promise<boolean> {
  const plan = restorePlan(currentPlace(), to);
  if (plan.openFile !== null && getState().project?.autoFiles.includes(plan.openFile) === true) {
    await openAutoNamed(plan.openFile);
    if (getState().fileName !== plan.openFile) return false;
  }
  if (plan.dialog !== null) setDialog(plan.dialog.to);
  if (plan.sharing !== null) {
    const sharing = plan.sharing.to;
    if (sharing === null) closeSharingSheet();
    else if (sharing.sheet === "viewer") openShareViewer(sharing.share);
    else if (sharing.sheet === "sharing") openSharingSheet("sharing", { autoId: sharing.autoId });
    else openSharingSheet("share");
  }
  if (plan.settings !== null && plan.settings.to === null) closeSettings();
  if (plan.account !== null) {
    const panel = plan.account.to;
    if (panel === null) account.close();
    else openAccountPanel(panel);
  }
  // After the sheets, since opening the window closes any sheet that is open.
  if (plan.settings !== null && plan.settings.to !== null) openSettings(plan.settings.to);
  if (plan.admin !== null) {
    if (plan.admin.to) openAdminDashboard();
    else closeAdminPage();
  }
  return true;
}

/** Goes one screen back or forward. Resolves false when there was nowhere to go or it was refused. */
export async function navigate(direction: NavDirection): Promise<boolean> {
  if (history === null || moving || getState().unsavedPrompt !== null) return false;
  // A change still waiting to be recorded is a place too: record it before stepping away from it.
  record();
  const target = history.peek(direction);
  if (target === null) return false;
  moving = true;
  try {
    if (!(await restore(target))) return false;
    history.go(direction);
    // What the restore reached, which can differ from what was recorded (an auto since deleted).
    history.replace(currentPlace());
    return true;
  } finally {
    moving = false;
  }
}

/** One press of back or forward, from any input. A press that arrived twice counts once. */
export function navigateFrom(source: NavSource, direction: NavDirection): void {
  if (!gate.accept(source, direction, Date.now())) return;
  void navigate(direction);
}

/** Whether there is a screen to go to in `direction`, for tests and for anything that shows it. */
export const canNavigate = (direction: NavDirection): boolean => history?.canGo(direction) === true;

/** True when the keystroke belongs to whatever the user is typing into. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable === true;
}

/**
 * Alt + Left and Alt + Right, unless the person is typing, where they move the caret by word on
 * some systems. Returns true when the key was taken. `useKeyboard` calls this before its other keys.
 */
export function navigateFromKey(event: KeyboardEvent & NavKeyLike): boolean {
  const direction = keyDirection(event);
  if (direction === null || isTyping(event.target)) return false;
  event.preventDefault();
  navigateFrom("key", direction);
  return true;
}

/**
 * Starts recording places and listening for the side buttons, and in the desktop app for the
 * window's back and forward commands. Returns the teardown.
 */
export function initNavigation(): () => void {
  historyBackend = getState().backend;
  history = new ScreenHistory<Place>(currentPlace(), samePlace);

  const stops = [
    subscribeEditor(queueCheck),
    subscribeCloud(queueCheck),
    account.subscribe(queueCheck),
    subscribeSettings(queueCheck),
    onAdminRouteChange(queueCheck),
  ];

  // Chromium starts its own back or forward on the side buttons unless the page cancels them, so
  // every event of the press is cancelled and the step is taken once, on release.
  const cancelSideButton = (event: MouseEvent): void => {
    if (mouseButtonDirection(event.button) !== null) event.preventDefault();
  };
  const onMouseUp = (event: MouseEvent): void => {
    const direction = mouseButtonDirection(event.button);
    if (direction === null) return;
    event.preventDefault();
    navigateFrom("mouse", direction);
  };
  window.addEventListener("mousedown", cancelSideButton, true);
  window.addEventListener("auxclick", cancelSideButton, true);
  window.addEventListener("mouseup", onMouseUp, true);
  stops.push(() => {
    window.removeEventListener("mousedown", cancelSideButton, true);
    window.removeEventListener("auxclick", cancelSideButton, true);
    window.removeEventListener("mouseup", onMouseUp, true);
  });

  const stopDesktop = desktopBridge()?.onNavigate?.((direction) => {
    navigateFrom("appCommand", direction);
  });
  if (stopDesktop !== undefined) stops.push(stopDesktop);

  return () => {
    for (const stop of stops) stop();
    history = null;
  };
}
