/**
 * The Zenith desktop app's main process (site/docs/editor.md). It hosts the same
 * `apps/web` build a browser gets, and adds what a browser cannot do: open a robot repository in
 * place, run the high-fidelity sim, deploy autos, and commit, push and open a pull request.
 *
 * The window is locked down the way Electron's security checklist asks: context isolation, the
 * sandbox, no Node in the renderer, a strict Content-Security-Policy, no navigation away from the
 * app, no new windows (links open in the system browser), and every permission request refused.
 * Signing in to the optional cloud happens in the system browser (nativeSignIn.ts). The one
 * exception, only in a development run of a build given a Firebase config, is Firebase Auth's own
 * sign-in window (cloud.ts), sandboxed with no preload and no Node, which may show only the auth
 * domain and the providers' sign-in pages.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BrowserWindow,
  Menu,
  app,
  clipboard,
  dialog,
  ipcMain,
  nativeTheme,
  net,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
  type IpcMainInvokeEvent,
} from "electron";
import type { DesktopMenuCommand, DesktopUpdate } from "../../../web/src/project/desktopBridge.js";
import { MENU_KEY_COMMAND } from "../../../web/src/project/desktopMenuKey.js";
import { DESKTOP_KEYS } from "../../../web/src/project/desktopKeys.js";
import { FULL_SIM_DEFAULT } from "../../../web/src/state/fullSimSwitch.js";
import { EVENTS } from "../shared/channels.js";
import { DESKTOP_CSS, TITLE_BAR } from "./chrome.js";
import { CloseGuard } from "./closeGuard.js";
import { DraftKeeper, stoppedQuestion } from "./crashRecovery.js";
import { AUTH_WINDOW_WEB_PREFERENCES, cloudHostsFrom, isAuthHandlerUrl, isAuthWindowUrl } from "./cloud.js";
import { ghCliStatus, ghRunnerFromEnv } from "./ghCli.js";
import { GitHubAuth, readGhToken } from "./github.js";
import { registerIpc, type IpcHandles } from "./ipc.js";
import { DEFAULT_MENU_KEYS, type MenuKeys } from "../../../web/src/project/menuKeys.js";
import { menuTemplate } from "./menu.js";
import { forwardAppCommand } from "./navigate.js";
import { NativeSignIn, signInClientsFrom } from "./nativeSignIn.js";
import { openArgsFromData, openData, parseOpenArgs, type OpenArgs } from "./openRequest.js";
import { saveCopy } from "./saveCopy.js";
import { APP_ORIGIN, APP_SCHEME, appProtocolHandler, buildCsp, devCsp, isAppUrl, isExternalWebUrl } from "./security.js";
import { SettingsStore } from "./settings.js";
import { checkForUpdate } from "./updateCheck.js";
import { initialBounds, trackBounds } from "./windowState.js";

/** Set by `scripts/dev.mjs` to the Vite dev server's URL; unset (or empty) in a built app. */
const DEV_URL = devUrl(process.env["ZENITH_DEV_URL"]);

function devUrl(value: string | undefined): string | null {
  return value === undefined || value === "" ? null : value;
}

/**
 * The Firebase web config the web build was given, baked in by `scripts/build.mjs` from the same
 * source Vite reads (`VITE_ZENITH_FIREBASE_CONFIG`). Undefined outside an esbuild bundle, and an empty
 * string in a build with no cloud; either way `CLOUD` is null and nothing below opens.
 */
declare const __ZENITH_FIREBASE_CONFIG__: string | undefined;
/**
 * The App Check site key the web build was given (`VITE_ZENITH_APPCHECK_SITE_KEY`), baked in the same
 * way. Not a secret: the page carries it too. With one, the policy lets reCAPTCHA Enterprise and App
 * Check's hosts through (cloud.ts), which does not make App Check work on `zenith://app`.
 */
declare const __ZENITH_APPCHECK_SITE_KEY__: string | undefined;
const CLOUD = cloudHostsFrom(
  typeof __ZENITH_FIREBASE_CONFIG__ === "string" ? __ZENITH_FIREBASE_CONFIG__ : undefined,
  typeof __ZENITH_APPCHECK_SITE_KEY__ === "string" ? __ZENITH_APPCHECK_SITE_KEY__ : undefined,
);
/**
 * Firebase's sign-in popup works only for a page on an http or https address, so only a development
 * run, whose page is the Vite dev server, may open it. The built app signs in through the browser.
 */
const POPUP_CLOUD = DEV_URL === null ? null : CLOUD;

/**
 * The OAuth clients for signing in through the system browser, baked in by `scripts/build.mjs` from
 * the `VITE_ZENITH_*_CLIENT_ID` variables (nativeSignIn.ts). None is a secret.
 */
declare const __ZENITH_SIGN_IN_CLIENTS__: string | undefined;
const SIGN_IN_CLIENTS = signInClientsFrom(typeof __ZENITH_SIGN_IN_CLIENTS__ === "string" ? __ZENITH_SIGN_IN_CLIENTS__ : undefined);

/**
 * Set by tests and scripts (`ZENITH_HEADLESS=1`) so a run never puts a window on the screen or takes
 * focus from whoever is using the computer. The window still loads and paints, so tests drive it and
 * capture it through its webContents. Unset, as in every installed or hand-started copy, the app
 * behaves normally.
 */
const HEADLESS = process.env["ZENITH_HEADLESS"] === "1";
if (HEADLESS) app.disableHardwareAcceleration();
/**
 * The window and taskbar icon, the Zenith mark. `scripts/build.mjs` copies resources/icon.ico and
 * icon.png next to main.cjs, in a dev run and in the packaged app alike; Windows takes the .ico, which
 * carries every size it asks for.
 */
const WINDOW_ICON = join(__dirname, process.platform === "win32" ? "icon.ico" : "icon.png");
/** The app's frame colour before the page paints: the Horizon night ground, `--bg-app` (09 section 1). */
const GROUND = TITLE_BAR.color;

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true },
  },
]);

// Tests pass a throwaway profile so a run never reads or writes the owner's own settings. It is set
// before the single-instance lock, which is keyed on this folder.
const userData = process.env["ZENITH_USER_DATA"];
if (userData !== undefined && userData !== "") app.setPath("userData", userData);

/**
 * The folder `zenith open` started this launch for (openRequest.ts), from this process's own command
 * line. Nothing else can put one there: the app registers no URL scheme.
 */
const LAUNCH_OPEN = parseOpenArgs(process.argv, process.cwd());
/** `gh` for the sign-in dialog and the Commit panel; a fake only in a windowless test run (ghCli.ts). */
const GH = ghRunnerFromEnv(process.env, HEADLESS, process.execPath);

// A second launch focuses the running window instead of opening a second copy of the app, which
// would otherwise race the first for the same settings file and file watches. A second launch from
// `zenith open` hands its folder to the running app through the lock's data.
if (!app.requestSingleInstanceLock(LAUNCH_OPEN === null ? undefined : openData(LAUNCH_OPEN))) {
  app.quit();
} else {
  start(LAUNCH_OPEN);
}

function start(launchOpen: OpenArgs | null): void {
  let mainWindow: BrowserWindow | null = null;
  let closeGuard: CloseGuard | null = null;
  let handles: IpcHandles | null = null;

  const settings = new SettingsStore(join(app.getPath("userData"), "settings.json"));
  const drafts = new DraftKeeper();
  /** The launch's check for a newer Zenith (updateCheck.ts), started once the app is ready. */
  let update: DesktopUpdate | null = null;
  let updateCheck: Promise<DesktopUpdate | null> = Promise.resolve(null);
  const auth = new GitHubAuth({
    box: safeStorage,
    ghToken: () => readGhToken(GH),
    ghStatus: () => ghCliStatus(GH),
    slot: {
      get: () => settings.get().githubToken,
      set: (value) => {
        settings.update({ githubToken: value });
      },
    },
  });

  const sendMenu = (command: DesktopMenuCommand) => {
    if (mainWindow === null || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send(EVENTS.menu, command);
  };

  const about = () => {
    if (HEADLESS) return;
    const win = mainWindow;
    const versions = `Electron ${process.versions.electron}, Chromium ${process.versions.chrome}, Node ${process.versions.node}`;
    const options = {
      type: "info" as const,
      title: "About Zenith",
      message: `Zenith ${app.getVersion()}`,
      detail: ["An autonomous planner for FTC that people and agents share.", "Horizon (FTC 36596).", "", `${versions}.`].join("\n"),
      // Specific verbs, never OK (UI_GUIDE 9.9). The version is what a bug report asks for first.
      buttons: ["Copy version", "Close"],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    };
    void (win === null ? dialog.showMessageBox(options) : dialog.showMessageBox(win, options)).then(({ response }) => {
      if (response === 0) clipboard.writeText(`Zenith ${app.getVersion()} (${versions})`);
    });
  };

  // The keys the page last sent (menu.ts `acceptMenuKeys`): the defaults until it sends any.
  let menuKeys: MenuKeys = DEFAULT_MENU_KEYS;

  const buildMenu = () => {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        menuTemplate(
          settings.get().recent,
          {
            send: sendMenu,
            about,
            quit: () => app.quit(),
            isDev: DEV_URL !== null,
            fullSim: FULL_SIM_DEFAULT,
            clearRecent: () => {
              settings.update({ recent: [] });
              buildMenu();
            },
            update,
            openUpdate: () => {
              if (update !== null) void shell.openExternal(update.url);
            },
          },
          menuKeys,
        ),
      ),
    );
  };

  const trusted = (event: IpcMainInvokeEvent): boolean =>
    mainWindow !== null &&
    event.sender === mainWindow.webContents &&
    event.senderFrame !== null &&
    isAppUrl(event.senderFrame.url, DEV_URL);

  const createWindow = () => {
    const { bounds, maximized, minSize } = initialBounds(
      settings.get().bounds,
      screen.getAllDisplays().map((display) => display.workArea),
      screen.getPrimaryDisplay().workArea,
    );
    const win = new BrowserWindow({
      ...bounds,
      minWidth: minSize.width,
      minHeight: minSize.height,
      show: false,
      ...(HEADLESS ? { focusable: false, skipTaskbar: true } : {}),
      title: "Zenith",
      icon: WINDOW_ICON,
      backgroundColor: GROUND,
      // The web build's title bar is the window's; Windows draws its own controls over our colour.
      titleBarStyle: "hidden",
      titleBarOverlay: { ...TITLE_BAR },
      webPreferences: {
        preload: join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        spellcheck: false,
        // A window that is never shown must still paint, or a headless capture comes back blank.
        ...(HEADLESS ? { backgroundThrottling: false } : {}),
      },
    });
    mainWindow = win;
    trackBounds(win, settings);

    // Unsaved edits: every close and quit asks the page first (closeGuard.ts), or main itself when
    // the page has stopped and main holds its edits (crashRecovery.ts).
    const guard = new CloseGuard(
      {
        isDestroyed: () => win.isDestroyed(),
        close: () => {
          win.close();
        },
        askPage: () => {
          win.webContents.send(EVENTS.closeRequest);
        },
        holdsEdits: () => !HEADLESS && drafts.held() !== null,
        askMain: () => {
          void askStopped(stoppedWhy);
        },
      },
      () => {
        app.quit();
      },
    );
    closeGuard = guard;
    win.on("close", (event) => {
      if (!guard.onClose()) event.preventDefault();
    });
    win.webContents.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) guard.pageGone();
    });

    /** Why main is asking: the page crashed, did not load, or is being closed after it stopped. */
    let stoppedWhy: "crashed" | "load" | "close" = "close";
    /**
     * Main's own question for a stopped page (crashRecovery.ts): Reload, Save edits as… when it held
     * unsaved edits, or Close Zenith. Its answer goes to the guard like the page's would.
     */
    const askStopped = async (why: "crashed" | "load" | "close", saved: string | null = null): Promise<void> => {
      if (win.isDestroyed()) return;
      const draft = drafts.held();
      const question = stoppedQuestion(why, draft, saved);
      const { response } = await dialog.showMessageBox(win, {
        type: "warning",
        title: "Zenith",
        message: question.message,
        detail: question.detail,
        buttons: question.buttons,
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      const choice = question.choices[response] ?? "reload";
      if (choice === "close") {
        guard.answer(true);
        return;
      }
      if (choice === "save" && draft !== null) {
        let copy: string | null = null;
        try {
          copy = await saveCopy(
            {
              folder: app.getPath("documents"),
              ask: async (defaultPath) => {
                const picked = await dialog.showSaveDialog(win, {
                  title: "Save your edits",
                  buttonLabel: "Save",
                  defaultPath,
                  filters: [{ name: "Zenith auto", extensions: ["json"] }],
                });
                return picked.canceled || picked.filePath === undefined ? null : picked.filePath;
              },
              write: (path, body) => {
                writeFileSync(path, body, "utf8");
              },
            },
            draft.fileName,
            draft.text,
          );
        } catch (error) {
          dialog.showErrorBox("Zenith", error instanceof Error ? error.message : String(error));
        }
        // Asked again, now saying where the copy went, or as before when it was cancelled.
        await askStopped(why, copy);
        return;
      }
      guard.answer(false);
      if (win.isDestroyed()) return;
      drafts.recover();
      if (why === "load") void win.loadURL(DEV_URL ?? `${APP_ORIGIN}/`);
      else win.webContents.reload();
    };

    win.once("ready-to-show", () => {
      if (HEADLESS) return;
      if (maximized) win.maximize();
      win.show();
    });

    // Links open in the system browser; the app never opens a second window of its own, except, in a
    // development run, the optional cloud's sign-in window, which Firebase Auth opens on its handler page.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (isAuthHandlerUrl(url, POPUP_CLOUD)) {
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            parent: win,
            title: "Sign in to Zenith",
            icon: WINDOW_ICON,
            autoHideMenuBar: true,
            show: !HEADLESS,
            ...(HEADLESS ? { focusable: false, skipTaskbar: true } : {}),
            webPreferences: { ...AUTH_WINDOW_WEB_PREFERENCES },
          },
        };
      }
      if (isExternalWebUrl(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    win.webContents.on("did-create-window", (child) => {
      guardAuthWindow(child);
    });
    win.webContents.on("will-navigate", (event, url) => {
      if (isAppUrl(url, DEV_URL)) return;
      event.preventDefault();
      if (isExternalWebUrl(url)) void shell.openExternal(url);
    });
    win.webContents.on("will-attach-webview", (event) => {
      event.preventDefault();
    });

    // With no menu bar on screen, F10 opens the application menu under the title bar, as it reaches
    // the menu bar in any Windows app. Alt on its own is left alone: the canvas uses a held Alt to
    // turn snapping off during a drag, and releasing it must not open a menu.
    win.webContents.on("before-input-event", (_event, input) => {
      if (!HEADLESS && input.type === "keyDown" && input.key === DESKTOP_KEYS.menu && !input.alt && !input.control && !input.shift && !input.meta) {
        // The page opens it under its menu button, exactly where a click does (desktopActions.ts).
        sendMenu({ action: MENU_KEY_COMMAND });
      }
    });

    // The mouse's side buttons and the keyboard's Back and Forward keys go back and forward between
    // screens in the page (navigate.ts).
    win.on("app-command", (_event, command) => {
      forwardAppCommand(command, (direction) => {
        if (!win.isDestroyed()) win.webContents.send(EVENTS.navigate, direction);
      });
    });

    win.webContents.on("dom-ready", () => {
      void win.webContents.insertCSS(DESKTOP_CSS);
    });

    // A crashed page would leave a blank window. Say why on stderr, which is where a bug report
    // starts, and ask: Reload, which brings unsaved edits back, or close (crashRecovery.ts).
    win.webContents.on("render-process-gone", (_event, details) => {
      console.error(`Zenith: the page stopped (${details.reason}, exit code ${String(details.exitCode)}).`);
      if (details.reason === "clean-exit" || win.isDestroyed() || HEADLESS) {
        guard.pageGone();
        return;
      }
      stoppedWhy = "crashed";
      guard.pageStopped();
    });
    win.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      console.error(`Zenith: could not load ${url} (${String(code)} ${description}).`);
      // -3 is a load the next one replaced, which is not a failure; only the page itself matters.
      if (!isMainFrame || code === -3 || win.isDestroyed() || HEADLESS) return;
      stoppedWhy = "load";
      guard.pageStopped();
    });
    // Once a page has loaded, a close of the window asks main's question only if that page stops.
    win.webContents.on("did-finish-load", () => {
      stoppedWhy = "close";
    });

    win.on("closed", () => {
      mainWindow = null;
    });

    void win.loadURL(DEV_URL ?? `${APP_ORIGIN}/`);
  };

  /**
   * The sign-in window may show the auth domain and the providers' sign-in pages and nothing else. A
   * move anywhere else closes it, which Firebase reports to the page as a closed popup, and says on
   * stderr where it tried to go. It opens no windows of its own, and links in it go to the browser.
   */
  const guardAuthWindow = (child: BrowserWindow) => {
    const contents = child.webContents;
    const refuse = (event: { preventDefault(): void }, url: string) => {
      if (isAuthWindowUrl(url, POPUP_CLOUD)) return;
      event.preventDefault();
      console.error(`Zenith: the sign-in window was closed because it tried to open ${url.split(/[?#]/)[0] ?? ""}.`);
      if (!child.isDestroyed()) child.close();
    };
    contents.on("will-navigate", (event, url) => {
      refuse(event, url);
    });
    contents.on("will-redirect", (event, url) => {
      refuse(event, url);
    });
    contents.setWindowOpenHandler(({ url }) => {
      if (isExternalWebUrl(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    contents.on("will-attach-webview", (event) => {
      event.preventDefault();
    });
  };

  app.on("second-instance", (_event, _argv, _workingDirectory, additionalData) => {
    // Only the lock's data is read, never the second launch's raw command line, which Chromium may
    // have added to; and it is checked again here, having crossed from another process.
    const open = openArgsFromData(additionalData);
    if (open !== null) handles?.queueOpen(open);
    if (mainWindow === null || HEADLESS) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  void app.whenReady().then(() => {
    nativeTheme.themeSource = "dark";
    const rendererDir = join(__dirname, "renderer");
    protocol.handle(APP_SCHEME, appProtocolHandler(rendererDir, buildCsp({ devOrigin: null, cloud: CLOUD })));

    // No camera, microphone, notifications, geolocation or anything else: the editor needs none.
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
      callback(false);
    });
    session.defaultSession.setPermissionCheckHandler(() => false);
    if (DEV_URL !== null) {
      // Only the dev server's own responses get the app's policy; the sign-in window's pages keep
      // theirs, and a fetch to another host is left as it came.
      const devOrigin = new URL(DEV_URL).origin;
      const policy = devCsp(devOrigin, CLOUD);
      session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        if (!isAppUrl(details.url, DEV_URL)) {
          callback({});
          return;
        }
        callback({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [policy] } });
      });
    }

    const signIn = new NativeSignIn({
      clients: SIGN_IN_CLIENTS,
      cloudOn: CLOUD !== null,
      openExternal: (url) => shell.openExternal(url),
      onProgress: (progress) => {
        if (mainWindow !== null && !mainWindow.isDestroyed()) mainWindow.webContents.send(EVENTS.signInProgress, progress);
      },
    });

    handles = registerIpc({
      ipcMain,
      window: () => mainWindow,
      settings,
      auth,
      onRecentChanged: buildMenu,
      onMenuKeys: (keys) => {
        menuKeys = keys;
        buildMenu();
      },
      trusted,
      headless: HEADLESS,
      closeGuard: () => closeGuard,
      signIn,
      gh: GH,
      drafts,
      update: () => updateCheck,
    });
    buildMenu();
    createWindow();
    if (launchOpen !== null) handles.queueOpen(launchOpen);

    // Once per launch, and never in a test or a development run: is a newer Zenith out (updateCheck.ts)?
    if (!HEADLESS && DEV_URL === null) {
      updateCheck = checkForUpdate(app.getVersion(), (url, init) => net.fetch(url, init)).then((found) => {
        update = found;
        if (found !== null) buildMenu();
        return found;
      });
    }
  });

  app.on("before-quit", (event) => {
    // A quit waits while the page is asked about unsaved edits; a yes quits again from the guard.
    if (closeGuard !== null && !closeGuard.onBeforeQuit()) event.preventDefault();
  });

  app.on("will-quit", () => {
    // A sim left running would keep a Gradle JVM busy after the app is gone. Here rather than in
    // before-quit, which also fires for a quit that is then cancelled.
    handles?.shutdown();
  });

  app.on("window-all-closed", () => {
    app.quit();
  });
}
