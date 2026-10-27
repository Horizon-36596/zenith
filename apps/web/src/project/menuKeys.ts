/**
 * The keys the desktop app's native menu shows and registers, and the checks both ends of the
 * `zenith:menu-keys` message share. The page sends the resolved key of each menu item and the items its
 * switches hide; the main process validates the message here and rebuilds the menu from it
 * (apps/desktop/src/main/menu.ts).
 *
 * Plain data and pure functions with no DOM and no Node access, because the desktop app's main
 * process imports this file as well as the page. Keys are written the way the shortcut table
 * writes them (`app/shortcuts.ts`): `Ctrl Shift F5`.
 */
import type { DesktopMenuKeys } from "./desktopBridge";
import { DESKTOP_KEYS } from "./desktopKeys";

/**
 * The menu items whose key a person can set, by the id of the action each one runs. The File, Edit
 * and View items only show their key, since the page handles it; the Robot items register theirs,
 * so the menu runs the action itself and the page's key handler leaves those keys alone.
 */
export const MENU_ITEMS = [
  { id: "project.open", registered: false, key: "Ctrl O" },
  { id: "run.save", registered: false, key: "Ctrl S" },
  { id: "edit.undo", registered: false, key: "Ctrl Z" },
  { id: "edit.redo", registered: false, key: "Ctrl Y" },
  { id: "view.palette", registered: false, key: "Ctrl K" },
  { id: "desktop.sim", registered: true, key: DESKTOP_KEYS["desktop.sim"] },
  { id: "desktop.deploy", registered: true, key: DESKTOP_KEYS["desktop.deploy"] },
  { id: "desktop.git", registered: true, key: DESKTOP_KEYS["desktop.git"] },
] as const;

export type MenuItemId = (typeof MENU_ITEMS)[number]["id"];

export const MENU_ITEM_IDS: readonly MenuItemId[] = MENU_ITEMS.map((item) => item.id);

export const isMenuItemId = (id: string): id is MenuItemId => MENU_ITEM_IDS.some((known) => known === id);

/** Whether the menu itself registers the item's key (the Robot items), rather than only showing it. */
export const isRegisteredItem = (id: MenuItemId): boolean => MENU_ITEMS.find((item) => item.id === id)?.registered === true;

/** What the menu holds until the page says otherwise: every item on its default key, none hidden. */
export interface MenuKeys {
  /** The written key of each item, or null for an item with no key. */
  keys: Readonly<Record<MenuItemId, string | null>>;
  /** The items left out of the menu. */
  hidden: ReadonlySet<MenuItemId>;
}

export const DEFAULT_MENU_KEYS: MenuKeys = {
  keys: Object.fromEntries(MENU_ITEMS.map((item) => [item.id, item.key])) as Record<MenuItemId, string>,
  hidden: new Set(),
};

/* ---- Keys ------------------------------------------------------------------------------------- */

export interface MenuChord {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** One upper-case letter or digit, a punctuation mark, `F1` to `F24`, or one of `KEY_NAMES`. */
  key: string;
}

/** The named keys, as the shortcut table writes them, and the name Electron gives each. */
const ELECTRON_NAMES: Readonly<Record<string, string>> = {
  Del: "Delete",
  Ins: "Insert",
  PgUp: "PageUp",
  PgDn: "PageDown",
  Esc: "Escape",
  "←": "Left",
  "↑": "Up",
  "→": "Right",
  "↓": "Down",
  Home: "Home",
  End: "End",
  Enter: "Enter",
  Space: "Space",
  Plus: "Plus",
  Tab: "Tab",
};

/** The punctuation Electron accepts in an accelerator, among the marks a shortcut can be written with. */
const PUNCTUATION = ",./;'[]\\-=`";

const isFunctionKey = (key: string): boolean => /^F([1-9]|1\d|2[0-4])$/.test(key);

/** The chord a written key names, or undefined when the menu cannot show it. */
export function parseMenuKey(written: string): MenuChord | undefined {
  if (written.length > 40) return undefined;
  const tokens = written.split(" ");
  const key = tokens.pop();
  if (key === undefined || key === "") return undefined;
  const mods = new Set(tokens);
  if (mods.size !== tokens.length || tokens.some((token) => token !== "Ctrl" && token !== "Alt" && token !== "Shift")) return undefined;
  const valid =
    /^[A-Za-z0-9]$/.test(key) || (key.length === 1 && PUNCTUATION.includes(key)) || isFunctionKey(key) || Object.hasOwn(ELECTRON_NAMES, key);
  if (!valid) return undefined;
  return { ctrl: mods.has("Ctrl"), alt: mods.has("Alt"), shift: mods.has("Shift"), key: key.length === 1 ? key.toUpperCase() : key };
}

/**
 * The key as an Electron accelerator (`Ctrl Shift F5` is `CmdOrCtrl+Shift+F5`), or undefined when it
 * is not one the menu can show. An accelerator Electron cannot parse makes it throw, so nothing else
 * ever reaches the menu.
 */
export function toAccelerator(written: string): string | undefined {
  const chord = parseMenuKey(written);
  if (chord === undefined) return undefined;
  const key = ELECTRON_NAMES[chord.key] ?? chord.key;
  return [chord.ctrl ? "CmdOrCtrl" : "", chord.alt ? "Alt" : "", chord.shift ? "Shift" : "", key].filter((part) => part !== "").join("+");
}

/**
 * Whether one keystroke could be both chords. A digit or punctuation mark already says whether
 * Shift was held by what it types, so Shift does not tell two of those apart, as in the page's own
 * check (`chordsOverlap` in `app/keymap.ts`).
 */
function sameKey(a: MenuChord, b: MenuChord): boolean {
  const shiftFree = a.key.length === 1 && !/^[A-Z]$/.test(a.key);
  return a.key === b.key && a.ctrl === b.ctrl && a.alt === b.alt && (shiftFree || a.shift === b.shift);
}

/**
 * Chords the browser, the system or the desktop app keeps, each with the reason Settings, Keyboard
 * gives when a person tries one (spec 15 section 8.3). The menu refuses them too.
 */
export const RESERVED_CHORDS: readonly { keys: string; reason: string }[] = [
  { keys: "Ctrl W", reason: "The browser closes the tab with it." },
  { keys: "Ctrl Shift W", reason: "The browser closes the window with it." },
  { keys: "Ctrl T", reason: "The browser opens a new tab with it." },
  { keys: "Ctrl Shift T", reason: "The browser reopens a closed tab with it." },
  { keys: "Ctrl N", reason: "The browser opens a new window with it." },
  { keys: "Ctrl Shift N", reason: "The browser opens a private window with it." },
  { keys: "Ctrl Tab", reason: "The browser moves to the next tab with it." },
  { keys: "Ctrl Shift Tab", reason: "The browser moves to the previous tab with it." },
  { keys: "Ctrl L", reason: "The browser moves to its address bar with it." },
  { keys: "Ctrl H", reason: "The browser opens its history with it." },
  { keys: "Ctrl Q", reason: "The browser or the app quits with it." },
  { keys: "Ctrl M", reason: "A Mac minimizes the window with it." },
  { keys: "Ctrl R", reason: "The browser reloads the page with it." },
  { keys: "Ctrl Shift R", reason: "The browser reloads the page with it." },
  { keys: "F11", reason: "The browser goes full screen with it." },
  { keys: "F12", reason: "The browser opens its developer tools with it." },
  { keys: "Ctrl Shift I", reason: "The browser opens its developer tools with it." },
  { keys: "Ctrl Shift J", reason: "The browser opens its developer tools with it." },
  { keys: "Ctrl Shift C", reason: "The browser opens its developer tools with it." },
  { keys: "Ctrl =", reason: "The browser zooms in with it." },
  { keys: "Ctrl Plus", reason: "The browser zooms in with it." },
  { keys: "Ctrl -", reason: "The browser zooms out with it." },
  // Ctrl Shift - arrives as Ctrl _ on most layouts, and the browser zooms out with it too. The menu
  // cannot show _, so only the page needs this entry; the menu's own Ctrl - covers Ctrl Shift -.
  { keys: "Ctrl _", reason: "The browser zooms out with it." },
  { keys: "Ctrl 0", reason: "The browser resets the zoom with it." },
  { keys: "Alt F4", reason: "The system closes the window with it." },
  { keys: "Ctrl C", reason: "Copy stays the system's." },
  { keys: "Ctrl X", reason: "Cut stays the system's." },
  { keys: "Ctrl V", reason: "Paste stays the system's." },
  { keys: "Ctrl A", reason: "Select all stays the system's." },
];

const RESERVED = RESERVED_CHORDS.flatMap((entry) => {
  const chord = parseMenuKey(entry.keys);
  return chord === undefined ? [] : [{ chord, reason: entry.reason }];
});

/** The letters of the desktop app's menus, File, Edit, View, Robot and Help (apps/desktop/src/main/menu.ts). */
export const MENU_LETTERS: ReadonlySet<string> = new Set(["F", "E", "V", "R", "H"]);

/**
 * Why the menu cannot take this key, or undefined when it can. `registered` is for a Robot item,
 * whose key the menu itself handles anywhere in the window: a plain letter would then run the item
 * while a person types in a field, so it needs Ctrl or Alt, or must be a function key.
 */
export function menuRefusal(written: string, registered: boolean): string | undefined {
  const chord = parseMenuKey(written);
  if (chord === undefined) return "The desktop menu cannot show that key.";
  if (chord.ctrl && chord.alt) return "Ctrl and Alt together type characters on many keyboards (AltGr).";
  if (chord.key === "Esc") return "Esc always cancels and closes.";
  if (chord.key === "Tab") return "Tab moves focus from control to control.";
  if (chord.key === "F10") return "F10 opens the menu in the desktop app, and Shift F10 a context menu.";
  const reserved = RESERVED.find((entry) => sameKey(chord, entry.chord));
  if (reserved !== undefined) return reserved.reason;
  if (!registered) return undefined;
  if (chord.key === "F6" && !chord.ctrl && !chord.alt) return "F6 moves focus to the next panel.";
  if (!chord.ctrl && !chord.alt && !isFunctionKey(chord.key)) return "A menu key works everywhere, so it needs Ctrl or Alt, or must be a function key.";
  if (chord.alt && !chord.ctrl && MENU_LETTERS.has(chord.key)) return "In the desktop app, Alt and that letter opens a menu.";
  return undefined;
}

/* ---- The message -------------------------------------------------------------------------------- */

export type MenuKeysCheck = { ok: true; value: MenuKeys } | { ok: false; reason: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Checks a `zenith:menu-keys` message, which the main process gets from a page it must not trust
 * blindly: known item ids only, each key a written key the menu can show and may register, no two
 * items on overlapping keys. An item the message leaves out keeps its default key. Any problem refuses
 * the whole message, so the menu never holds half of it.
 */
export function checkMenuKeys(payload: unknown): MenuKeysCheck {
  if (!isRecord(payload)) return { ok: false, reason: "The menu keys must be an object." };
  const given = payload["keys"] ?? {};
  const hiddenList = payload["hidden"] ?? [];
  if (!isRecord(given)) return { ok: false, reason: "The menu keys must be an object." };
  if (!Array.isArray(hiddenList) || hiddenList.length > MENU_ITEM_IDS.length) return { ok: false, reason: "The hidden menu items must be a short list." };

  const keys: Record<string, string | null> = { ...DEFAULT_MENU_KEYS.keys };
  for (const [id, written] of Object.entries(given)) {
    if (!isMenuItemId(id)) return { ok: false, reason: "The menu has no item named that." };
    if (written === null) {
      keys[id] = null;
      continue;
    }
    if (typeof written !== "string") return { ok: false, reason: `The key for ${id} must be text or null.` };
    const refusal = menuRefusal(written, isRegisteredItem(id));
    if (refusal !== undefined) return { ok: false, reason: `${id} cannot use ${written.slice(0, 40)}: ${refusal}` };
    keys[id] = written;
  }

  const hidden = new Set<MenuItemId>();
  for (const id of hiddenList) {
    if (typeof id !== "string" || !isMenuItemId(id)) return { ok: false, reason: "The menu has no item named that." };
    hidden.add(id);
  }

  const used: { id: string; chord: MenuChord }[] = [];
  for (const id of MENU_ITEM_IDS) {
    const written = keys[id];
    const chord = written === null || written === undefined ? undefined : parseMenuKey(written);
    if (chord === undefined) continue;
    const clash = used.find((other) => sameKey(chord, other.chord));
    if (clash !== undefined) return { ok: false, reason: `${id} and ${clash.id} cannot share a key.` };
    used.push({ id, chord });
  }
  return { ok: true, value: { keys: keys as Record<MenuItemId, string | null>, hidden } };
}

/**
 * The message for the page's current keys: `keyOf` gives an item's resolved key (undefined for none)
 * and `shown` whether its action is on show. A key the menu cannot show or register is sent as none,
 * so a key the page allows but the menu cannot draw never gets the whole message refused.
 */
export function menuKeysMessage(keyOf: (id: MenuItemId) => string | undefined, shown: (id: MenuItemId) => boolean): DesktopMenuKeys {
  const keys: Record<string, string | null> = {};
  const hidden: string[] = [];
  for (const id of MENU_ITEM_IDS) {
    const first = keyOf(id)?.split(" or ")[0];
    keys[id] = first !== undefined && menuRefusal(first, isRegisteredItem(id)) === undefined ? first : null;
    if (!shown(id)) hidden.push(id);
  }
  return { keys, hidden };
}
