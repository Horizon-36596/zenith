/**
 * The preload script: the whole of what the web build can ask the desktop app for, exposed as
 * `window.zenithDesktop` through `contextBridge` (contextIsolation on, sandboxed, no Node in the
 * renderer). Every method is a named IPC call with plain arguments; there is no generic "invoke
 * any channel" escape hatch, and no Electron or Node object ever reaches the page.
 *
 * The shape is `ZenithDesktopBridge` from apps/web/src/project/desktopBridge.ts, so both sides are
 * type-checked against one definition.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  DESKTOP_API_VERSION,
  type DesktopFileChange,
  type DesktopMenuCommand,
  type DesktopNavigation,
  type DesktopSignInProgress,
  type DesktopSimEvent,
  type ZenithDesktopBridge,
} from "../../../web/src/project/desktopBridge.js";
import { CHANNELS, EVENTS, type IpcFailure } from "../shared/channels.js";

/** Calls a main-process handler and turns its `{ __zenithError }` reply back into a thrown Error. */
async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const reply = (await ipcRenderer.invoke(channel, ...args)) as T | IpcFailure;
  if (reply !== null && typeof reply === "object" && "__zenithError" in reply) {
    throw new Error((reply as IpcFailure).__zenithError);
  }
  return reply as T;
}

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_event: IpcRendererEvent, payload: T) => {
    listener(payload);
  };
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
}

const bridge: ZenithDesktopBridge = {
  apiVersion: DESKTOP_API_VERSION,
  platform: process.platform,
  appVersion: () => call(CHANNELS.appVersion),

  project: {
    pick: () => call(CHANNELS.projectPick),
    recent: () => call(CHANNELS.projectRecent),
    reopen: (root) => call(CHANNELS.projectReopen, root),
    listAutos: (root) => call(CHANNELS.projectListAutos, root),
    read: (root, path) => call(CHANNELS.projectRead, root, path),
    hasAuto: (root, fileName) => call(CHANNELS.projectHasAuto, root, String(fileName)),
    writeAuto: (root, fileName, text) => call(CHANNELS.projectWriteAuto, root, fileName, text),
    setCommandLibrary: (root, library) => call(CHANNELS.projectSetCommandLibrary, root, library),
    writeRobot: (root, robot) => call(CHANNELS.projectWriteRobot, root, robot),
    writeWaypoints: (root, waypoints) => call(CHANNELS.projectWriteWaypoints, root, waypoints),
    listPresets: (root) => call(CHANNELS.projectListPresets, root),
    writePreset: (root, fileName, text) => call(CHANNELS.projectWritePreset, root, String(fileName), String(text)),
    watch: (root) => call(CHANNELS.projectWatch, root),
    saveFullProject: (payload) => call(CHANNELS.projectSaveFull, payload),
    saveAutoInto: (fileName, text) => call(CHANNELS.projectSaveAutoInto, String(fileName), String(text)),
    pickAutoTarget: (fileName) => call(CHANNELS.projectPickAutoTarget, String(fileName)),
    writeAutoInto: (root, fileName, text, addWaypoints) =>
      call(CHANNELS.projectWriteAutoInto, root, String(fileName), String(text), addWaypoints),
    setupScan: (root) => call(CHANNELS.projectSetupScan, root),
    setup: (root, request) => call(CHANNELS.projectSetup, root, request),
    githubOrigin: (root) => call(CHANNELS.projectGitHubOrigin, root),
    onChange: (listener) => subscribe<DesktopFileChange>(EVENTS.fileChanged, listener),
  },

  saveCopy: (suggestedName, text) => call(CHANNELS.saveCopy, String(suggestedName), String(text)),
  // Text, or the bytes of a picture; main checks the name, the kind and the size again.
  saveFile: (suggestedName, data) => call(CHANNELS.saveFile, String(suggestedName), typeof data === "string" ? data : new Uint8Array(data)),

  drafts: {
    hold: (draft) => call(CHANNELS.draftHold, draft === null ? null : { root: draft.root, fileName: String(draft.fileName), text: String(draft.text) }),
    take: () => call(CHANNELS.draftTake),
  },

  updates: {
    check: () => call(CHANNELS.updateCheck),
  },

  sim: {
    // Only the speed crosses: the main process reads everything else from the project's own files.
    start: (root, fileName, options) => call(CHANNELS.simStart, root, fileName, { speed: options?.speed }),
    configure: (root, speed) => call(CHANNELS.simConfigure, root, speed),
    cancel: (runId) => call(CHANNELS.simCancel, runId),
    onEvent: (listener) => subscribe<DesktopSimEvent>(EVENTS.simEvent, listener),
  },

  deploy: {
    run: (root, options) => call(CHANNELS.deployRun, root, { dryRun: options.dryRun === true }),
  },

  git: {
    status: (root, fileName) => call(CHANNELS.gitStatus, root, fileName),
    commit: (root, input) => call(CHANNELS.gitCommit, root, { fileName: input.fileName, summary: input.summary }),
    push: (root) => call(CHANNELS.gitPush, root),
    openPullRequest: (root, input) => call(CHANNELS.gitPullRequest, root, { fileName: input.fileName }),
  },

  github: {
    status: () => call(CHANNELS.githubStatus),
    setToken: (token, remember) => call(CHANNELS.githubSetToken, token, remember !== false),
    forgetToken: () => call(CHANNELS.githubForgetToken),
    cliStatus: () => call(CHANNELS.githubCliStatus),
    // The one call that hands the page a token: the GitHub CLI's, for GitHub mode, held in memory there.
    cliToken: () => call(CHANNELS.githubCliToken),
    oauthAvailability: () => call(CHANNELS.signInRepoAvailability),
    // GitHub's device flow with the repo scope; progress and cancel are cloudSignIn's.
    oauthToken: () => call(CHANNELS.signInRepoStart),
  },

  openRequests: {
    take: () => call(CHANNELS.openRequestTake),
    // The event carries nothing; the page takes the request itself, so it is handed over once.
    onRequest: (listener) =>
      subscribe<undefined>(EVENTS.openRequest, () => {
        listener();
      }),
  },

  cloudSignIn: {
    providers: () => call(CHANNELS.signInProviders),
    start: (provider) => call(CHANNELS.signInStart, String(provider)),
    cancel: () => call(CHANNELS.signInCancel),
    onProgress: (listener) => subscribe<DesktopSignInProgress>(EVENTS.signInProgress, listener),
  },

  showMenu: (x, y) => call(CHANNELS.menuShow, Number(x), Number(y)),
  // Plain data only: the main process checks every id and key again, so nothing here is trusted.
  setMenuKeys: (payload) => call(CHANNELS.menuKeys, payload),
  onMenu: (listener) => subscribe<DesktopMenuCommand>(EVENTS.menu, listener),

  onCloseRequest: (listener) => {
    const unsubscribe = subscribe<undefined>(EVENTS.closeRequest, () => {
      listener();
    });
    void call(CHANNELS.closeListen);
    return unsubscribe;
  },
  answerClose: (ok) => call(CHANNELS.closeAnswer, ok === true),

  // Only the two directions reach the page, whatever arrives on the channel.
  onNavigate: (listener) =>
    subscribe<DesktopNavigation>(EVENTS.navigate, (direction) => {
      if (direction === "back" || direction === "forward") listener(direction);
    }),
};

contextBridge.exposeInMainWorld("zenithDesktop", bridge);
