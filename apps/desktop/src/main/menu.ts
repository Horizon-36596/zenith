/**
 * The native menu. Every item that does something in the editor sends a `DesktopMenuCommand` to
 * the renderer, named by the web build's own action id (apps/web/src/app/actions.ts) or a
 * `desktop.*` id the desktop module handles, so the menu, the toolbar, the palette and the
 * shortcuts all run the same code.
 *
 * Items whose shortcut the web build already handles (Ctrl+S, Ctrl+O, Ctrl+Z, Ctrl+Y, Ctrl+K) show
 * the shortcut but do not register it, so a keypress is handled once, by the page.
 *
 * The keys follow the person's own. The page sends the resolved key of each of those items and the
 * items its switches hide as `zenith:menu-keys`; `acceptMenuKeys` validates the message and the main
 * process rebuilds the menu from it, so `menuTemplate` takes the accepted keys as its last argument.
 * Until the page says anything, every item has its default key.
 */
import type { MenuItemConstructorOptions } from "electron";
import type { DesktopMenuCommand, RecentProject } from "../../../web/src/project/desktopBridge.js";
import {
  DEFAULT_MENU_KEYS,
  checkMenuKeys,
  toAccelerator,
  type MenuItemId,
  type MenuKeys,
} from "../../../web/src/project/menuKeys.js";
import { MENU_LABELS } from "../../../web/src/project/menuLabels.js";
import { BridgeError } from "./confine.js";

export interface MenuHandlers {
  send: (command: DesktopMenuCommand) => void;
  about: () => void;
  quit: () => void;
  isDev: boolean;
  /** Empties File > Open Recent. */
  clearRecent: () => void;
  /** A newer Zenith on the releases page (updateCheck.ts), offered at the top of Help; null when none. */
  update?: { version: string; url: string } | null;
  openUpdate?: () => void;
  /**
   * Whether the Robot menu offers the high-fidelity sim: the Full sim switch (issue #207,
   * apps/web/src/state/fullSimSwitch.ts), which is on.
   */
  fullSim: boolean;
}

/**
 * Validates a `zenith:menu-keys` message from the page and hands what it accepts to `apply`, which
 * rebuilds the menu. A message with an unknown id, a key the menu cannot show or a reserved one is
 * refused whole, with the reason, and the menu stays as it was.
 */
export function acceptMenuKeys(payload: unknown, apply: (keys: MenuKeys) => void): void {
  const checked = checkMenuKeys(payload);
  if (!checked.ok) throw new BridgeError(`Refused the menu keys. ${checked.reason}`);
  apply(checked.value);
}

/** How much of a recent folder's path File > Open Recent shows: enough to tell two apart, no more. */
export const RECENT_PATH_CHARS = 60;

/** Shortens `text` to `max` characters by cutting from its middle, so both ends of a path stay. */
export function trimMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`;
}

export function menuTemplate(
  recent: readonly RecentProject[],
  handlers: MenuHandlers,
  menuKeys: MenuKeys = DEFAULT_MENU_KEYS,
): MenuItemConstructorOptions[] {
  const send = (action: string, arg?: string) => () => {
    handlers.send(arg === undefined ? { action } : { action, arg });
  };

  const acceleratorOf = (id: MenuItemId): string | undefined => {
    const written = menuKeys.keys[id];
    return written === null ? undefined : toAccelerator(written);
  };
  /** Shows the key of an item the page itself handles, without the menu also claiming it. */
  const shown = (id: MenuItemId): Pick<MenuItemConstructorOptions, "accelerator" | "registerAccelerator" | "visible"> => {
    const key = acceleratorOf(id);
    return { ...(key === undefined ? {} : { accelerator: key }), registerAccelerator: false, ...(menuKeys.hidden.has(id) ? { visible: false } : {}) };
  };
  /**
   * A Robot item, which registers its key. A hidden one is left out altogether, so its key does
   * nothing either: a hidden menu item still answers its accelerator.
   */
  const robot = (id: MenuItemId, label: string): MenuItemConstructorOptions[] => {
    if (menuKeys.hidden.has(id)) return [];
    const key = acceleratorOf(id);
    return [{ label, ...(key === undefined ? {} : { accelerator: key }), click: send(id) }];
  };
  // The high-fidelity sim follows the Full sim switch's own constant (issue #207,
  // apps/web/src/state/fullSimSwitch.ts), the value the page starts from too, before the page says
  // anything, and then the page's switches as well.
  const simOffered = handlers.fullSim && !menuKeys.hidden.has("desktop.sim");
  const robotGroups = [
    simOffered ? [...robot("desktop.sim", MENU_LABELS["desktop.sim"]), { label: "&Cancel the sim", click: send("desktop.simCancel") }] : [],
    robot("desktop.deploy", MENU_LABELS["desktop.deploy"]),
    robot("desktop.git", MENU_LABELS["desktop.git"]),
  ].filter((group) => group.length > 0);
  const robotMenu: MenuItemConstructorOptions[] =
    robotGroups.length === 0
      ? []
      : [
          {
            label: "&Robot",
            submenu: robotGroups.flatMap((group, index) => (index === 0 ? group : [{ type: "separator" as const }, ...group])),
          },
        ];

  const recentItems: MenuItemConstructorOptions[] =
    recent.length === 0
      ? [{ label: "No recent robot repositories", enabled: false }]
      : [
          ...recent.map((entry) => ({
            // A `&` in a folder name would otherwise become an access key and vanish.
            label: `${entry.name}  (${trimMiddle(entry.root, RECENT_PATH_CHARS)})`.replace(/&/g, "&&"),
            click: send("desktop.openRecent", entry.root),
          })),
          { type: "separator" as const },
          { label: "&Clear recent", click: handlers.clearRecent },
        ];

  return [
    {
      label: "&File",
      submenu: [
        // Ctrl+O is the page's Open project dialog (a repository, GitHub or the example), so the
        // shortcut sits on that item; Open a folder goes straight to the folder picker. The names are the
        // page's own, so the menu, the palette and the start screen say the same thing (UX review, X17).
        { label: MENU_LABELS["project.open"], ...shown("project.open"), click: send("project.open") },
        { label: MENU_LABELS["project.openFolder"], click: send("project.openFolder") },
        { label: "Open &recent", submenu: recentItems },
        { label: MENU_LABELS["project.example"], click: send("project.example") },
        { type: "separator" },
        { label: MENU_LABELS["run.save"], ...shown("run.save"), click: send("run.save") },
        { type: "separator" },
        { label: "E&xit", accelerator: "Alt+F4", registerAccelerator: false, click: handlers.quit },
      ],
    },
    {
      label: "&Edit",
      submenu: [
        { label: MENU_LABELS["edit.undo"], ...shown("edit.undo"), click: send("edit.undo") },
        { label: MENU_LABELS["edit.redo"], ...shown("edit.redo"), click: send("edit.redo") },
        { type: "separator" },
        // Electron's own items, in the app's sentence case and with access keys.
        { role: "cut", label: "Cu&t" },
        { role: "copy", label: "&Copy" },
        { role: "paste", label: "&Paste" },
        { role: "selectAll", label: "Select &all" },
      ],
    },
    {
      label: "&View",
      submenu: [
        { label: MENU_LABELS["view.palette"], ...shown("view.palette"), click: send("view.palette") },
        { type: "separator" },
        // Electron's default Zoom In key is Ctrl+Plus, which on a US keyboard needs Shift, so Ctrl+=
        // did nothing. The visible item takes Ctrl+=; the hidden ones keep Ctrl+Shift+= and the
        // numeric keypad working without a second menu entry.
        { role: "zoomIn", label: "Zoom &in", accelerator: "CmdOrCtrl+=" },
        { role: "zoomIn", accelerator: "CmdOrCtrl+Plus", visible: false },
        { role: "zoomIn", accelerator: "CmdOrCtrl+numadd", visible: false },
        { role: "zoomOut", label: "Zoom &out" },
        { role: "zoomOut", accelerator: "CmdOrCtrl+numsub", visible: false },
        { role: "resetZoom", label: "Reset &zoom" },
        { type: "separator" },
        { role: "togglefullscreen", label: "&Full screen" },
        ...(handlers.isDev
          ? ([
              { type: "separator" },
              { role: "reload", label: "&Reload" },
              { role: "toggleDevTools", label: "&Developer tools" },
            ] as MenuItemConstructorOptions[])
          : []),
      ],
    },
    ...robotMenu,
    {
      label: "&Help",
      submenu: [
        ...(handlers.update === undefined || handlers.update === null
          ? []
          : [
              { label: `&Get Zenith ${handlers.update.version}…`, click: () => handlers.openUpdate?.() },
              { type: "separator" as const },
            ]),
        // The web build's own help actions, so the menu, the toolbar's help menu and the palette agree.
        { label: MENU_LABELS["help.docs"], click: send("help.docs") },
        { type: "separator" },
        { label: MENU_LABELS["help.tour"], click: send("help.tour") },
        { label: MENU_LABELS["help.fullTour"], click: send("help.fullTour") },
        { label: MENU_LABELS["help.shortcuts"], click: send("help.shortcuts") },
        { type: "separator" },
        { label: "&About Zenith", click: handlers.about },
      ],
    },
  ];
}
