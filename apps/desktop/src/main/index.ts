/**
 * The Zenith desktop app's main process (site/docs/editor.md). It hosts the same
 * `apps/web` build a browser gets, and adds what a browser cannot do: open a robot repository in
 * place, run the high-fidelity sim, deploy autos, and commit, push and open a pull request.
 *
 * The window is locked down the way Electron's security checklist asks: context isolation, the
 * sandbox, no Node in the renderer, a strict Content-Security-Policy, no navigation away from the
 * app, no new windows (links open in the system browser), and every permission request refused.
 */
import { join } from "node:path";
import {
  BrowserWindow,
  Menu,
  app,
  dialog,
  ipcMain,
  nativeTheme,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
  type IpcMainInvokeEvent,
} from "electron";
import type { DesktopMenuCommand } from "../../../web/src/project/desktopBridge.js";
import { EVENTS } from "../shared/channels.js";
import { DESKTOP_CSS, TITLE_BAR } from "./chrome.js";
import { CloseGuard } from "./closeGuard.js";
import { GitHubAuth } from "./github.js";
import { registerIpc, type IpcHandles } from "./ipc.js";
import { menuTemplate } from "./menu.js";
import { APP_ORIGIN, APP_SCHEME, appProtocolHandler, devCsp, isAppUrl, isExternalWebUrl } from "./security.js";
import { SettingsStore } from "./settings.js";
import { MIN_SIZE, initialBounds, trackBounds } from "./windowState.js";

/** Set by `scripts/dev.mjs` to the Vite dev server's URL; unset (or empty) in a built app. */
const DEV_URL = devUrl(process.env["ZENITH_DEV_URL"]);

function devUrl(value: string | undefined): string | null {
  return value === undefined || value === "" ? null : value;
}

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

// A second launch focuses the running window instead of opening a second copy of the app, which
// would otherwise race the first for the same settings file and file watches.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  start();
}

function start(): void {
  let mainWindow: BrowserWindow | null = null;
  let closeGuard: CloseGuard | null = null;
  let handles: IpcHandles | null = null;

  const settings = new SettingsStore(join(app.getPath("userData"), "settings.json"));
  const auth = new GitHubAuth({
    box: safeStorage,
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
    const options = {
      type: "info" as const,
      title: "About Zenith",
      message: `Zenith ${app.getVersion()}`,
      detail: [
        "An autonomous planner for FTC that people and agents share.",
        "Horizon (FTC 36596).",
        "",
        "BIOBUZZ field images by Team Juice 16236, from the r/FTC post \"BIOBUZZ custom field images (MeepMeep compatible)\".",
        "",
        `Electron ${process.versions.electron}, Chromium ${process.versions.chrome}, Node ${process.versions.node}.`,
      ].join("\n"),
      buttons: ["OK"],
    };
    void (win === null ? dialog.showMessageBox(options) : dialog.showMessageBox(win, options));
  };

  const buildMenu = () => {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        menuTemplate(settings.get().recent, { send: sendMenu, about, quit: () => app.quit(), isDev: DEV_URL !== null }),
      ),
    );
  };

  const trusted = (event: IpcMainInvokeEvent): boolean =>
    mainWindow !== null &&
    event.sender === mainWindow.webContents &&
    event.senderFrame !== null &&
    isAppUrl(event.senderFrame.url, DEV_URL);

  const createWindow = () => {
    const { bounds, maximized } = initialBounds(
      settings.get().bounds,
      screen.getAllDisplays().map((display) => display.workArea),
    );
    const win = new BrowserWindow({
      ...bounds,
      minWidth: MIN_SIZE.width,
      minHeight: MIN_SIZE.height,
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

    // Unsaved edits: every close and quit asks the page first (closeGuard.ts).
    const guard = new CloseGuard(
      {
        isDestroyed: () => win.isDestroyed(),
        close: () => {
          win.close();
        },
        askPage: () => {
          win.webContents.send(EVENTS.closeRequest);
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

    win.once("ready-to-show", () => {
      if (HEADLESS) return;
      if (maximized) win.maximize();
      win.show();
    });

    // Links open in the system browser; the app never opens a second window of its own.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (isExternalWebUrl(url)) void shell.openExternal(url);
      return { action: "deny" };
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
      if (!HEADLESS && input.type === "keyDown" && input.key === "F10" && !input.alt && !input.control && !input.shift && !input.meta) {
        Menu.getApplicationMenu()?.popup({ window: win, x: 8, y: TITLE_BAR.height });
      }
    });

    win.webContents.on("dom-ready", () => {
      void win.webContents.insertCSS(DESKTOP_CSS);
    });

    // A crashed page leaves a blank window; say why on stderr, which is where a bug report starts.
    win.webContents.on("render-process-gone", (_event, details) => {
      guard.pageGone();
      console.error(`Zenith: the page stopped (${details.reason}, exit code ${String(details.exitCode)}).`);
    });
    win.webContents.on("did-fail-load", (_event, code, description, url) => {
      console.error(`Zenith: could not load ${url} (${String(code)} ${description}).`);
    });

    win.on("closed", () => {
      mainWindow = null;
    });

    void win.loadURL(DEV_URL ?? `${APP_ORIGIN}/`);
  };

  app.on("second-instance", () => {
    if (mainWindow === null || HEADLESS) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  void app.whenReady().then(() => {
    nativeTheme.themeSource = "dark";
    const rendererDir = join(__dirname, "renderer");
    protocol.handle(APP_SCHEME, appProtocolHandler(rendererDir));

    // No camera, microphone, notifications, geolocation or anything else: the editor needs none.
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
      callback(false);
    });
    session.defaultSession.setPermissionCheckHandler(() => false);
    if (DEV_URL !== null) {
      const policy = devCsp(new URL(DEV_URL).origin);
      session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        callback({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [policy] } });
      });
    }

    handles = registerIpc({
      ipcMain,
      window: () => mainWindow,
      settings,
      auth,
      onRecentChanged: buildMenu,
      trusted,
      headless: HEADLESS,
      closeGuard: () => closeGuard,
    });
    buildMenu();
    createWindow();
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
