/**
 * The native menu. Every item that does something in the editor sends a `DesktopMenuCommand` to
 * the renderer, named by the web build's own action id (apps/web/src/app/actions.ts) or a
 * `desktop.*` id the desktop module handles, so the menu, the toolbar, the palette and the
 * shortcuts all run the same code.
 *
 * Items whose shortcut the web build already handles (Ctrl+S, Ctrl+O, Ctrl+Z, Ctrl+Y, Ctrl+K) show
 * the shortcut but do not register it, so a keypress is handled once, by the page.
 */
import type { MenuItemConstructorOptions } from "electron";
import type { DesktopMenuCommand, RecentProject } from "../../../web/src/project/desktopBridge.js";

export interface MenuHandlers {
  send: (command: DesktopMenuCommand) => void;
  about: () => void;
  quit: () => void;
  isDev: boolean;
}

/** Shows a shortcut the page itself handles, without the menu also claiming the key. */
const shown = (accelerator: string): Pick<MenuItemConstructorOptions, "accelerator" | "registerAccelerator"> => ({
  accelerator,
  registerAccelerator: false,
});

export function menuTemplate(recent: readonly RecentProject[], handlers: MenuHandlers): MenuItemConstructorOptions[] {
  const send = (action: string, arg?: string) => () => {
    handlers.send(arg === undefined ? { action } : { action, arg });
  };

  const recentItems: MenuItemConstructorOptions[] =
    recent.length === 0
      ? [{ label: "No recent robot repositories", enabled: false }]
      : recent.map((entry) => ({
          label: `${entry.name}  (${entry.root})`,
          click: send("desktop.openRecent", entry.root),
        }));

  return [
    {
      label: "&File",
      submenu: [
        { label: "&Open robot repo…", ...shown("CmdOrCtrl+O"), click: send("project.openFolder") },
        { label: "Open &Recent", submenu: recentItems },
        { label: "Load the bundled &example", click: send("project.example") },
        { type: "separator" },
        { label: "&Save", ...shown("CmdOrCtrl+S"), click: send("run.save") },
        { type: "separator" },
        { label: "E&xit", accelerator: "Alt+F4", registerAccelerator: false, click: handlers.quit },
      ],
    },
    {
      label: "&Edit",
      submenu: [
        { label: "&Undo", ...shown("CmdOrCtrl+Z"), click: send("edit.undo") },
        { label: "&Redo", ...shown("CmdOrCtrl+Y"), click: send("edit.redo") },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "&View",
      submenu: [
        { label: "&Command palette", ...shown("CmdOrCtrl+K"), click: send("view.palette") },
        { type: "separator" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { role: "resetZoom" },
        { type: "separator" },
        { role: "togglefullscreen" },
        ...(handlers.isDev
          ? ([{ type: "separator" }, { role: "reload" }, { role: "toggleDevTools" }] as MenuItemConstructorOptions[])
          : []),
      ],
    },
    {
      label: "&Robot",
      submenu: [
        { label: "Run &high-fidelity sim", accelerator: "CmdOrCtrl+F5", click: send("desktop.sim") },
        { label: "&Cancel the sim", click: send("desktop.simCancel") },
        { type: "separator" },
        { label: "&Deploy autos into the robot repo", accelerator: "CmdOrCtrl+Shift+D", click: send("desktop.deploy") },
        { type: "separator" },
        { label: "Commit, push and open a &pull request…", accelerator: "CmdOrCtrl+Shift+G", click: send("desktop.git") },
      ],
    },
    {
      label: "&Help",
      submenu: [
        // The web build's own help actions, so the menu, the toolbar's help menu and the palette agree.
        { label: "&Tour", click: send("help.tour") },
        { label: "Show me &everything", click: send("help.fullTour") },
        { label: "Keyboard &shortcuts", click: send("help.shortcuts") },
        { type: "separator" },
        { label: "&About Zenith", click: handlers.about },
      ],
    },
  ];
}
