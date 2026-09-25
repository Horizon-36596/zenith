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
    writeAuto: (root, fileName, text) => call(CHANNELS.projectWriteAuto, root, fileName, text),
    watch: (root) => call(CHANNELS.projectWatch, root),
    onChange: (listener) => subscribe<DesktopFileChange>(EVENTS.fileChanged, listener),
  },

  sim: {
    start: (root, fileName) => call(CHANNELS.simStart, root, fileName),
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
    setToken: (token) => call(CHANNELS.githubSetToken, token),
    forgetToken: () => call(CHANNELS.githubForgetToken),
  },

  showMenu: (x, y) => call(CHANNELS.menuShow, Number(x), Number(y)),
  onMenu: (listener) => subscribe<DesktopMenuCommand>(EVENTS.menu, listener),

  onCloseRequest: (listener) => {
    const unsubscribe = subscribe<undefined>(EVENTS.closeRequest, () => {
      listener();
    });
    void call(CHANNELS.closeListen);
    return unsubscribe;
  },
  answerClose: (ok) => call(CHANNELS.closeAnswer, ok === true),
};

contextBridge.exposeInMainWorld("zenithDesktop", bridge);
