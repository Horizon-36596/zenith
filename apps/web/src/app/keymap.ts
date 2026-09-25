/**
 * Which key does what, as one table the keyboard handler and the shortcut sheet both read, so the
 * two cannot drift apart (QA-13). Every action with a `shortcut` in `ACTIONS` is found here by its
 * key; the few keys with no action of their own (nudging, turning, stepping the playhead, moving
 * focus) are `KEY_ONLY`, each with the id of the handler `useKeyboard` runs for it.
 */
import { ACTIONS, shortcutOf, type ActionDef } from "./actions";
import { SHORTCUTS } from "./shortcuts";

/** The parts of a `KeyboardEvent` that decide what it means. */
export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export interface KeyChord {
  /** `KeyboardEvent.key`, lower-cased when it is one character. */
  key: string;
  /** Ctrl, or Cmd on a Mac. */
  ctrl: boolean;
  alt: boolean;
  /** Whether Shift must be held, must not be, or does not matter (a plain letter, or `?`). */
  shift: boolean | "any";
}

/** The written names in `SHORTCUTS` for keys whose `KeyboardEvent.key` differs. */
const KEY_NAMES: Record<string, readonly string[]> = {
  Del: ["Delete", "Backspace"],
  Space: [" "],
  Esc: ["Escape"],
};

const MODIFIERS = new Set(["Ctrl", "Shift", "Alt"]);

/** Parses a written shortcut such as `Ctrl Shift Enter` or `? or F1` into the chords it names. */
export function parseShortcut(text: string): KeyChord[] {
  return text.split(" or ").flatMap((alternative) => {
    const tokens = alternative.trim().split(/\s+/);
    const ctrl = tokens.includes("Ctrl");
    const shift = tokens.includes("Shift");
    const alt = tokens.includes("Alt");
    const name = tokens.filter((token) => !MODIFIERS.has(token)).join(" ");
    const letter = /^[A-Z]$/.test(name);
    return (KEY_NAMES[name] ?? [name]).map((key) => ({
      key: key.length === 1 ? key.toLowerCase() : key,
      ctrl,
      alt,
      // A plain letter works with or without Shift (Caps Lock, a held Shift); a chord is exact.
      // `?` is Shift + / on most layouts, so Shift is part of typing it.
      shift: (letter && !ctrl && !alt && !shift) || name === "?" ? "any" : shift,
    }));
  });
}

export function matchesChord(event: KeyLike, chord: KeyChord): boolean {
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (key !== chord.key) return false;
  if ((event.ctrlKey || event.metaKey) !== chord.ctrl) return false;
  if (event.altKey !== chord.alt) return false;
  return chord.shift === "any" || event.shiftKey === chord.shift;
}

/** Second ways to reach an action that the sheet does not list, kept to the conventional ones. */
const ALIASES: Record<string, readonly string[]> = {
  "edit.redo": ["Ctrl Shift Z"],
};

/** Every chord that runs `action`: its shortcut, then any alias. */
export function chordsFor(action: ActionDef): KeyChord[] {
  const written = shortcutOf(action);
  return [
    ...(written === undefined ? [] : parseShortcut(written)),
    ...(ALIASES[action.id] ?? []).flatMap(parseShortcut),
  ];
}

/** The action a keystroke runs, if any. */
export function actionForKey(event: KeyLike): ActionDef | undefined {
  return ACTIONS.find((action) => chordsFor(action).some((chord) => matchesChord(event, chord)));
}

/**
 * Chords that edit the document stay the browser's while the user is typing, so Ctrl Z in a field
 * undoes the typing, not the routine. Other Ctrl chords and the function keys work everywhere.
 */
export const EDIT_CHORDS: ReadonlySet<string> = new Set(["edit.undo", "edit.redo", "edit.duplicate"]);

/** The handlers `useKeyboard` runs for keys with no action of their own. */
export type KeyOnlyId = "nudge" | "nudgeFar" | "rotate" | "reorder" | "stepTime" | "cycleRegion" | "escape";

export interface KeyOnlyRow {
  id: KeyOnlyId;
  keys: string;
  does: string;
}

/** Keys that act on the selection, the playhead or focus directly, as the sheet lists them. */
export const KEY_ONLY: readonly KeyOnlyRow[] = [
  { id: "nudge", keys: SHORTCUTS.nudge, does: "Move the selected point by half an inch." },
  { id: "nudgeFar", keys: SHORTCUTS.nudgeFar, does: "Move the selected point by two inches." },
  { id: "rotate", keys: SHORTCUTS.rotate, does: "Turn the selected point's heading one way or the other." },
  { id: "reorder", keys: SHORTCUTS.reorder, does: "Move the selected step up or down the list." },
  { id: "stepTime", keys: SHORTCUTS.stepTime, does: "Step the playhead back or forward a tenth of a second." },
  { id: "cycleRegion", keys: SHORTCUTS.cycleRegion, does: "Move focus to the next panel." },
  { id: "escape", keys: "Esc", does: "Close a menu, clear the selection, or leave the tour." },
];
