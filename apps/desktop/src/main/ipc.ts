/**
 * Every IPC handler the preload script can reach, in one table. Each one checks the root against
 * the roots the user picked, and each failure crosses back as `{ __zenithError: message }` so the
 * renderer sees a sentence and never a stack trace or a path the user did not give it.
 */
import { Menu, app, dialog, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from "electron";
import type { DesktopProjectRef } from "../../../web/src/project/desktopBridge.js";
import { CHANNELS, EVENTS, type IpcFailure } from "../shared/channels.js";
import type { CloseGuard } from "./closeGuard.js";
import { BridgeError, RootRegistry } from "./confine.js";
import { runDeploy } from "./deploy.js";
import { GitService } from "./git.js";
import { GitHubAuth, openOrUpdatePullRequest } from "./github.js";
import { describeProject, listAutos, loadDesktopProject, ProjectWatcher, readProjectFile, writeAuto, autoRelPath } from "./project.js";
import { pushRecent, type SettingsStore } from "./settings.js";
import { buildSimPlan, SimRunner } from "./sim.js";

export interface IpcContext {
  ipcMain: IpcMain;
  window: () => BrowserWindow | null;
  settings: SettingsStore;
  auth: GitHubAuth;
  /** Called after the recent list changes, so the File menu can be rebuilt. */
  onRecentChanged: () => void;
  /** True for events from the app's own window and page; anything else is refused. */
  trusted: (event: IpcMainInvokeEvent) => boolean;
  /** Under `ZENITH_HEADLESS`, nothing may appear on screen, so the menu does not pop up. */
  headless?: boolean;
  /** Asks the page before the window closes (closeGuard.ts). */
  closeGuard?: () => CloseGuard | null;
}

const failure = (error: unknown): IpcFailure => ({
  __zenithError:
    error instanceof BridgeError
      ? error.message
      : error instanceof Error && error.message !== ""
        ? error.message
        : "Something went wrong in the desktop app.",
});

export interface IpcHandles {
  roots: RootRegistry;
  sim: SimRunner;
  watcher: ProjectWatcher;
  shutdown: () => void;
}

export function registerIpc(context: IpcContext): IpcHandles {
  const { ipcMain, settings } = context;
  const roots = new RootRegistry();
  for (const entry of settings.get().recent) roots.grant(entry.root);

  const send = (channel: string, payload: unknown) => {
    const win = context.window();
    if (win !== null && !win.isDestroyed()) win.webContents.send(channel, payload);
  };
  const watcher = new ProjectWatcher((change) => {
    send(EVENTS.fileChanged, change);
  });
  const sim = new SimRunner((event) => {
    send(EVENTS.simEvent, event);
  });
  const git = new GitService({ login: () => context.auth.login() });

  const handle = (channel: string, fn: (...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (!context.trusted(event)) return failure(new BridgeError("Refused a request from a page that is not Zenith."));
      try {
        return await fn(...args);
      } catch (error) {
        return failure(error);
      }
    });
  };

  const remember = (root: string): DesktopProjectRef => {
    const ref = describeProject(root);
    roots.grant(ref.root);
    settings.update({ recent: pushRecent(settings.get().recent, ref.root, Date.now()) });
    context.onRecentChanged();
    return ref;
  };

  handle(CHANNELS.appVersion, () => app.getVersion());

  handle(CHANNELS.projectPick, async () => {
    const win = context.window();
    const options = {
      title: "Open a robot repository",
      buttonLabel: "Open",
      properties: ["openDirectory" as const],
    };
    const picked = win === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(win, options);
    const root = picked.filePaths[0];
    if (picked.canceled || root === undefined) return null;
    return remember(root);
  });

  handle(CHANNELS.projectRecent, () => settings.get().recent);

  handle(CHANNELS.projectReopen, (root) => {
    const granted = roots.assert(root);
    try {
      return remember(granted);
    } catch (error) {
      // A folder that has moved or lost its zenith.json drops off the list rather than failing forever.
      settings.update({ recent: settings.get().recent.filter((entry) => entry.root !== granted) });
      roots.revoke(granted);
      context.onRecentChanged();
      throw error;
    }
  });

  handle(CHANNELS.projectListAutos, (root) => listAutos(roots.assert(root)));

  handle(CHANNELS.projectRead, (root, path) => {
    const granted = roots.assert(root);
    const text = readProjectFile(granted, path as string);
    watcher.note(granted, String(path), text);
    return text;
  });

  handle(CHANNELS.projectWriteAuto, (root, fileName, text) => {
    const granted = roots.assert(root);
    // Noted before the write lands, so the watcher's event for it is already known to be ours.
    const rel = autoRelPath(loadDesktopProject(granted), String(fileName));
    watcher.note(granted, rel, typeof text === "string" ? text : null);
    writeAuto(granted, String(fileName), text);
    return undefined;
  });

  handle(CHANNELS.projectWatch, (root) => {
    const granted = roots.assert(root);
    watcher.watch(granted, loadDesktopProject(granted));
    return undefined;
  });

  handle(CHANNELS.simStart, (root, fileName) => sim.start(buildSimPlan(roots.assert(root), String(fileName))));

  handle(CHANNELS.simCancel, (runId) => {
    sim.cancel(String(runId));
    return undefined;
  });

  handle(CHANNELS.deployRun, (root, options) =>
    runDeploy(roots.assert(root), (options as { dryRun?: unknown } | null)?.dryRun === true),
  );

  handle(CHANNELS.gitStatus, (root, fileName) =>
    git.status(roots.assert(root), typeof fileName === "string" ? fileName : null),
  );

  handle(CHANNELS.gitCommit, (root, input) => {
    const { fileName, summary } = (input ?? {}) as { fileName?: unknown; summary?: unknown };
    return git.commit(roots.assert(root), String(fileName), typeof summary === "string" ? summary : "");
  });

  handle(CHANNELS.gitPush, (root) => git.push(roots.assert(root)));

  handle(CHANNELS.gitPullRequest, (root, input) => {
    const { fileName } = (input ?? {}) as { fileName?: unknown };
    return git.openPullRequest(roots.assert(root), String(fileName), {
      token: () => context.auth.token(),
      openOrUpdate: openOrUpdatePullRequest,
    });
  });

  handle(CHANNELS.menuShow, (x, y) => {
    const win = context.window();
    const menu = Menu.getApplicationMenu();
    if (win === null || menu === null || context.headless === true) return undefined;
    const at = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0);
    menu.popup({ window: win, x: at(x), y: at(y) });
    return undefined;
  });

  handle(CHANNELS.closeListen, () => {
    context.closeGuard?.()?.pageListening();
    return undefined;
  });
  handle(CHANNELS.closeAnswer, (ok) => {
    context.closeGuard?.()?.answer(ok === true);
    return undefined;
  });

  handle(CHANNELS.githubStatus, () => context.auth.status());
  handle(CHANNELS.githubSetToken, (token) => context.auth.setToken(token));
  handle(CHANNELS.githubForgetToken, () => context.auth.forgetToken());

  return {
    roots,
    sim,
    watcher,
    shutdown: () => {
      sim.cancelAll();
      watcher.close();
    },
  };
}
