/**
 * Every IPC handler the preload script can reach, in one table. Each one checks the root against
 * the roots the user picked, and each failure crosses back as `{ __zenithError: message }` so the
 * renderer sees a sentence and never a stack trace or a path the user did not give it.
 */
import { writeFileSync } from "node:fs";
import { Menu, app, dialog, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from "electron";
import type { DesktopOpenRequest, DesktopProjectRef, DesktopSimEvent, DesktopSimSpeed, DesktopUpdate } from "../../../web/src/project/desktopBridge.js";
import { CHANNELS, EVENTS, type IpcFailure } from "../shared/channels.js";
import type { CloseGuard } from "./closeGuard.js";
import { BridgeError, RootRegistry } from "./confine.js";
import type { DraftKeeper } from "./crashRecovery.js";
import { runDeploy } from "./deploy.js";
import { GitService } from "./git.js";
import { execGh, ghCliStatus, ghCliToken, type GhRunner } from "./ghCli.js";
import { GitHubAuth, openOrUpdatePullRequest } from "./github.js";
import { acceptMenuKeys } from "./menu.js";
import type { MenuKeys } from "../../../web/src/project/menuKeys.js";
import { signInHandlers, type NativeSignIn } from "./nativeSignIn.js";
import { resolveOpenRequest, type OpenArgs } from "./openRequest.js";
import { describeProject, hasAutoFile, listAutos, listPresetFiles, loadDesktopProject, ProjectWatcher, presetRelPath, readProjectFile, writeAuto, writePresetFile, setCommandLibrary, autoRelPath, writeRobot, writeWaypoints } from "./project.js";
import { saveCopy, saveFile } from "./saveCopy.js";
import { pickAutoTarget, saveAutoInto, saveFullProject, writeAutoInto } from "./saveProject.js";
import { pickedFolder, setupRequestFiles, setupScan, writeSetup } from "./setupProject.js";
import { pushRecent, type SettingsStore } from "./settings.js";
import { SimRunner } from "./sim.js";
import { SimDispatcher, type ServerDeps } from "./simServer.js";

export interface IpcContext {
  ipcMain: IpcMain;
  window: () => BrowserWindow | null;
  settings: SettingsStore;
  auth: GitHubAuth;
  /** Called after the recent list changes, so the File menu can be rebuilt. */
  onRecentChanged: () => void;
  /** Called with the keys and hidden items the page sent and this process accepted, so the menu can be rebuilt. */
  onMenuKeys: (keys: MenuKeys) => void;
  /** True for events from the app's own window and page; anything else is refused. */
  trusted: (event: IpcMainInvokeEvent) => boolean;
  /** Under `ZENITH_HEADLESS`, nothing may appear on screen, so the menu does not pop up. */
  headless?: boolean;
  /** Asks the page before the window closes (closeGuard.ts). */
  closeGuard?: () => CloseGuard | null;
  /** Signing in to the optional cloud through the system browser (nativeSignIn.ts). */
  signIn?: NativeSignIn;
  /** Runs the GitHub CLI for the sign-in dialog (ghCli.ts); the real `gh` unless a test gives a fake. */
  gh?: GhRunner;
  /** How the sim server is started and timed (simServer.ts); the real ones unless a test gives others. */
  simServer?: ServerDeps;
  /** The page's unsaved edits, kept for a crash (crashRecovery.ts). */
  drafts?: DraftKeeper;
  /** The launch's check for a newer Zenith (updateCheck.ts); resolves null when there is none. */
  update?: () => Promise<DesktopUpdate | null>;
}

/** The speed the page asked for; anything else, or nothing (an older page), is Basic. */
const simSpeed = (value: unknown): DesktopSimSpeed => (value === "fast" || value === "ultrafast" ? value : "basic");

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
  sim: SimDispatcher;
  watcher: ProjectWatcher;
  /**
   * Takes a folder `zenith open` asked for (openRequest.ts): grants it, puts it on the recent list
   * and holds it for the page, which is told one is waiting and takes it once.
   */
  queueOpen: (args: OpenArgs) => void;
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
  const emitSim = (event: DesktopSimEvent) => {
    send(EVENTS.simEvent, event);
  };
  const sim = new SimDispatcher(emitSim, new SimRunner(emitSim), context.simServer);
  /** The auto file a project-relative path names, when it is one in the autos folder. */
  const autoFileOf = (root: string, rel: string): string | null => {
    try {
      const autosDir = loadDesktopProject(root).link.autosDir.split("\\").join("/").replace(/^\.\//, "").replace(/\/+$/, "");
      const prefix = `${autosDir}/`;
      const name = rel.startsWith(prefix) ? rel.slice(prefix.length) : null;
      return name !== null && !name.includes("/") && name.endsWith(".auto.json") ? name : null;
    } catch {
      return null;
    }
  };
  const watcher = new ProjectWatcher((change) => {
    send(EVENTS.fileChanged, change);
    // An auto edited elsewhere is saved too, as far as Ultrafast's background run is concerned.
    const fileName = autoFileOf(change.root, change.path);
    if (fileName !== null) sim.autoSaved(change.root, fileName);
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
    // The menu's own words for it (menuLabels.ts), so the picker and the menu name the same thing.
    const options = {
      title: "Open a robot repository folder",
      buttonLabel: "Open folder",
      properties: ["openDirectory" as const],
    };
    const picked = win === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(win, options);
    const root = picked.filePaths[0];
    if (picked.canceled || root === undefined) return null;
    // A folder with no zenith.json is granted for Set up but not opened or remembered (issue #159).
    return pickedFolder(root, {
      remember,
      grant: (folder) => {
        roots.grant(folder);
      },
    });
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

  // Read only: whether an auto of that name is in the autos folder, for the first-save check.
  handle(CHANNELS.projectHasAuto, (root, fileName) => hasAutoFile(roots.assert(root), fileName));

  handle(CHANNELS.projectWriteAuto, (root, fileName, text) => {
    const granted = roots.assert(root);
    // Noted before the write lands, so the watcher's event for it is already known to be ours.
    const rel = autoRelPath(loadDesktopProject(granted), String(fileName));
    watcher.note(granted, rel, typeof text === "string" ? text : null);
    writeAuto(granted, String(fileName), text);
    sim.autoSaved(granted, String(fileName));
    return undefined;
  });

  // Takes a library name, never file text: zenith.json also holds sim.command, which main runs.
  handle(CHANNELS.projectSetCommandLibrary, (root, library) => {
    const granted = roots.assert(root);
    // Noted before the write lands, so the watcher does not report Zenith's own change as an outside edit.
    return setCommandLibrary(granted, library, (text) => {
      watcher.note(granted, "zenith.json", text);
    });
  });

  // Takes a robot object, never file text or a path: main validates it and writes the robot file zenith.json names.
  handle(CHANNELS.projectWriteRobot, (root, robot) => {
    const granted = roots.assert(root);
    return writeRobot(granted, robot, (rel, text) => {
      watcher.note(granted, rel, text);
    });
  });

  // Takes a waypoints object, never file text or a path: main validates it and writes the waypoints file zenith.json names.
  handle(CHANNELS.projectWriteWaypoints, (root, waypoints) => {
    const granted = roots.assert(root);
    return writeWaypoints(granted, waypoints, (rel, text) => {
      watcher.note(granted, rel, text);
    });
  });

  // Read only: the preset files in the project's presets folder (spec 15 section 6.5).
  handle(CHANNELS.projectListPresets, (root) => listPresetFiles(roots.assert(root)));

  // A bare preset file name and its text: main checks both and writes only in the presets folder.
  handle(CHANNELS.projectWritePreset, (root, fileName, text) => {
    const granted = roots.assert(root);
    // Noted before the write lands, so the watcher does not report Zenith's own change as an outside edit.
    const rel = presetRelPath(loadDesktopProject(granted), String(fileName));
    watcher.note(granted, rel, typeof text === "string" ? text : null);
    writePresetFile(granted, String(fileName), text);
    return undefined;
  });

  /** The native folder picker for the two saves of a read-only project; null when cancelled. */
  const pickFolder = async (title: string, buttonLabel: string): Promise<string | null> => {
    const win = context.window();
    const options = {
      title,
      buttonLabel,
      properties: ["openDirectory" as const, "createDirectory" as const, "promptToCreate" as const],
    };
    const picked = win === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(win, options);
    const folder = picked.filePaths[0];
    return picked.canceled || folder === undefined ? null : folder;
  };

  // The folder comes from the picker here, never from the renderer, and the renderer sends no
  // zenith.json (saveProject.ts). A folder written into is granted like one opened, so it can open.
  handle(CHANNELS.projectSaveFull, async (payload) => {
    const root = await saveFullProject(
      { pick: () => pickFolder("Choose an empty folder for the project", "Save project here") },
      payload,
    );
    return root === null ? null : remember(root);
  });

  handle(CHANNELS.projectSaveAutoInto, async (fileName, text) => {
    const saved = await saveAutoInto(
      { pick: () => pickFolder("Choose your project folder, the one with zenith.json", "Save auto here") },
      fileName,
      text,
    );
    return saved === null ? null : { project: remember(saved.root), path: saved.path };
  });

  // Save just this auto in two steps (issue #158). The pick writes nothing; the folder it returns is
  // granted, so the write can name it, but goes on the recent list only once the auto is written.
  handle(CHANNELS.projectPickAutoTarget, async (fileName) => {
    const target = await pickAutoTarget(
      { pick: () => pickFolder("Choose your project folder, the one with zenith.json", "Save auto here") },
      fileName,
    );
    if (target === null) return null;
    const ref = describeProject(target.root);
    roots.grant(ref.root);
    return { project: ref, path: target.path, waypointsPath: target.waypointsPath, waypoints: target.waypoints };
  });

  handle(CHANNELS.projectWriteAutoInto, (root, fileName, text, addWaypoints) => {
    const granted = roots.assert(root);
    const saved = writeAutoInto(granted, fileName, text, addWaypoints, (rel, body) => {
      watcher.note(granted, rel, body);
    });
    return { project: remember(saved.root), path: saved.path };
  });

  // Set up Zenith in a folder Open folder granted (issue #159). The renderer sends a library name,
  // a robot class and a robot object, never zenith.json: main builds it (setupProject.ts).
  handle(CHANNELS.projectSetupScan, (root) => setupScan(roots.assert(root)));

  handle(CHANNELS.projectSetup, (root, request) => {
    const granted = roots.assert(root);
    const written = writeSetup(granted, setupRequestFiles(request, granted));
    return { project: remember(granted), written };
  });

  // Read only, and only for a folder the user granted: the open-project dialog offers GitHub mode
  // for a clone whose origin is on github.com (issue #213).
  handle(CHANNELS.projectGitHubOrigin, (root) => git.githubOrigin(roots.assert(root)));

  handle(CHANNELS.projectWatch, (root) => {
    const granted = roots.assert(root);
    watcher.watch(granted, loadDesktopProject(granted));
    return undefined;
  });

  handle(CHANNELS.saveCopy, (name, text) =>
    saveCopy(
      {
        folder: app.getPath("documents"),
        ask: async (defaultPath) => {
          const win = context.window();
          const options = {
            title: "Save a copy of the auto",
            buttonLabel: "Save a copy",
            defaultPath,
            filters: [{ name: "Zenith auto", extensions: ["json"] }],
          };
          const picked = win === null ? await dialog.showSaveDialog(options) : await dialog.showSaveDialog(win, options);
          return picked.canceled || picked.filePath === undefined ? null : picked.filePath;
        },
        write: (path, body) => {
          writeFileSync(path, body, "utf8");
        },
      },
      name,
      text,
    ),
  );

  handle(CHANNELS.saveFile, (name, data) =>
    saveFile(
      {
        folder: app.getPath("documents"),
        ask: async (defaultPath, filter) => {
          const win = context.window();
          const options = { title: "Save a copy", buttonLabel: "Save", defaultPath, filters: [filter] };
          const picked = win === null ? await dialog.showSaveDialog(options) : await dialog.showSaveDialog(win, options);
          return picked.canceled || picked.filePath === undefined ? null : picked.filePath;
        },
        write: (path, body) => {
          if (typeof body === "string") writeFileSync(path, body, "utf8");
          else writeFileSync(path, body);
        },
      },
      name,
      data,
    ),
  );

  handle(CHANNELS.draftHold, (draft) => {
    context.drafts?.hold(draft);
    return undefined;
  });
  handle(CHANNELS.draftTake, () => context.drafts?.take() ?? null);

  handle(CHANNELS.updateCheck, () => context.update?.() ?? null);

  handle(CHANNELS.simStart, (root, fileName, options) =>
    sim.start(roots.assert(root), String(fileName), simSpeed((options as { speed?: unknown } | null)?.speed)),
  );

  // Takes only a root and a speed: Ultrafast starts the project's sim server now, Basic stops it.
  handle(CHANNELS.simConfigure, (root, speed) => {
    sim.configure(root === null ? null : roots.assert(root), simSpeed(speed));
    return undefined;
  });

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
    // The page measures in CSS pixels, which page zoom scales; the menu is placed in window pixels.
    const zoom = win.webContents.getZoomFactor();
    const at = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value * zoom)) : 0);
    menu.popup({ window: win, x: at(x), y: at(y) });
    return undefined;
  });

  // The page's resolved keys and hidden features, after load and after every change (spec 15 section 8.5).
  handle(CHANNELS.menuKeys, (payload) => {
    acceptMenuKeys(payload, context.onMenuKeys);
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
  handle(CHANNELS.githubSetToken, (token, remember) => context.auth.setToken(token, remember !== false));
  handle(CHANNELS.githubForgetToken, () => context.auth.forgetToken());

  // The GitHub CLI for GitHub mode (issue #213). These two run exactly `gh auth token --hostname
  // github.com` and nothing else; there is no handler that runs a command the page names. The token
  // crosses to the page only here, only to the app's own page (`handle` checks the sender), and is
  // neither kept nor logged in this process.
  const gh = context.gh ?? execGh;
  handle(CHANNELS.githubCliStatus, () => ghCliStatus(gh));
  handle(CHANNELS.githubCliToken, () => ghCliToken(gh));

  // `zenith open`: the page takes the waiting request once, whenever it is ready for it.
  let pendingOpen: DesktopOpenRequest | null = null;
  handle(CHANNELS.openRequestTake, () => {
    const request = pendingOpen;
    pendingOpen = null;
    return request;
  });
  const queueOpen = (args: OpenArgs) => {
    const request = resolveOpenRequest(args);
    if ("error" in request) {
      console.error(`Zenith: ${request.error}`);
      pendingOpen = request;
    } else {
      pendingOpen = { project: remember(request.project.root), auto: request.auto };
    }
    send(EVENTS.openRequest, undefined);
  };

  if (context.signIn !== undefined) {
    for (const [channel, fn] of Object.entries(signInHandlers(context.signIn))) handle(channel, fn);
  }

  return {
    roots,
    sim,
    watcher,
    queueOpen,
    shutdown: () => {
      context.signIn?.cancel();
      sim.shutdown();
      watcher.close();
    },
  };
}
