/**
 * Which key does what, as one table the keyboard handler and the shortcut sheet both read, so the
 * two cannot drift apart (QA-13). Every action with a `shortcut` in `ACTIONS` is found here by its
 * key; the few keys with no action of their own (nudging, turning, stepping the playhead, moving
 * focus) are `KEY_ONLY`, as the sheet lists them. Of those, Turn, Step back, Step forward and Next
 * panel are bindings too (`KEY_BINDINGS`, issue #290), found by the person's keys like any action;
 * the arrows and Esc stay fixed, and `useKeyboard` checks them itself.
 *
 * A person can rebind keys in Settings, Keyboard. The defaults stay `SHORTCUTS`; the person's keys are
 * stored by binding id (an action id) in `zenith.ui` under `keys`, and `resolveKeymap` lays them over
 * the defaults. Everything that runs or shows a key reads the resolved map: `chordsFor` and
 * `actionForKey`, so `useKeyboard`; and `keyLabel`, so the tooltips, the palette, the shortcut sheet
 * and the hints.
 *
 * The parsing, overlap, validation and resolution below are pure: they take what they need as
 * arguments, and are tested in `keymap.test.ts`. Only `currentKeymap` and the key label source at
 * the end read the store.
 */
import { DESKTOP_KEYS } from "../project/desktopKeys";
import { canSetMenuKeys, isDesktop } from "../project/desktop";
import { RESERVED_CHORDS, menuRefusal } from "../project/menuKeys";
import type { KeyOverrides } from "../settings/registry";
import { actionShown, getFeatures } from "../state/features";
import { getState, subscribeEditor } from "../state/store";
import { ACTIONS, type ActionDef, type ActionGroup } from "./actions";
import { DEFAULT_EDITING_NUMBERS, formatInches, formatSeconds, type EditingNumbers } from "../settings/editingNumbers";
import { SHORTCUTS, setKeyLabelSource, type ShortcutId } from "./shortcuts";

// The resolver's seam lives in `shortcuts.ts`, a leaf, so `actions.ts` and the tour can read it
// without a cycle through this file; this file installs the person's keys into it, at the end.
export { keyLabel, keyOr, useKeyLabel } from "./shortcuts";

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

/**
 * The written names for keys whose `KeyboardEvent.key` differs. Page Up, Page Down and Insert take
 * the short names their keycaps print, so no label is longer than `Ctrl Shift Enter` and the
 * shortcut sheet keeps one line a row.
 */
const KEY_NAMES: Record<string, readonly string[]> = {
  Del: ["Delete", "Backspace"],
  Space: [" "],
  Esc: ["Escape"],
  Plus: ["+"],
  PgUp: ["PageUp"],
  PgDn: ["PageDown"],
  Ins: ["Insert"],
  "←": ["ArrowLeft"],
  "↑": ["ArrowUp"],
  "→": ["ArrowRight"],
  "↓": ["ArrowDown"],
};

/** The named keys a binding may be written with, as `KeyboardEvent.key` names them. */
const NAMED_KEYS: ReadonlySet<string> = new Set([
  "Enter",
  "Tab",
  "Home",
  "End",
  ...Array.from({ length: 24 }, (_, index) => `F${String(index + 1)}`),
]);

/** Keys that are only modifiers: pressed alone, they are not a key of their own. */
const MODIFIER_KEYS: ReadonlySet<string> = new Set([
  "Shift",
  "Control",
  "Alt",
  "AltGraph",
  "Meta",
  "OS",
  "Super",
  "Hyper",
  "Fn",
  "CapsLock",
  "NumLock",
  "ScrollLock",
]);

const MODIFIERS = new Set(["Ctrl", "Shift", "Alt"]);

const isLetter = (key: string): boolean => /^[a-z]$/i.test(key);

/**
 * Whether Shift is part of a chord. A plain letter works with or without Shift (Caps Lock, a held
 * Shift); a chord with a letter is exact. A digit or punctuation key already says whether Shift was
 * held by which character it types (`?` is Shift + / on most layouts), so Shift does not matter.
 */
function shiftOf(key: string, ctrl: boolean, alt: boolean, shift: boolean): boolean | "any" {
  if (key.length === 1 && !isLetter(key)) return "any";
  if (isLetter(key) && !ctrl && !alt && !shift) return "any";
  return shift;
}

/** The chords one written alternative (`Ctrl Shift E`, `Del`) names, or undefined when it names no key. */
function alternativeChords(alternative: string): KeyChord[] | undefined {
  const tokens = alternative.trim().split(/\s+/);
  const names = tokens.filter((token) => !MODIFIERS.has(token));
  const name = names[0];
  if (name === undefined || names.length !== 1) return undefined;
  const ctrl = tokens.includes("Ctrl");
  const shift = tokens.includes("Shift");
  const alt = tokens.includes("Alt");
  const keys = KEY_NAMES[name] ?? [name];
  return keys.map((key) => {
    const lower = key.length === 1 ? key.toLowerCase() : key;
    return { key: lower, ctrl, alt, shift: shiftOf(lower, ctrl, alt, shift) };
  });
}

/** Parses a written shortcut such as `Ctrl Shift Enter` or `? or F1` into the chords it names. */
export function parseShortcut(text: string): KeyChord[] {
  return text.split(" or ").flatMap((alternative) => alternativeChords(alternative) ?? []);
}

export function matchesChord(event: KeyLike, chord: KeyChord): boolean {
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  if (key !== chord.key) return false;
  if ((event.ctrlKey || event.metaKey) !== chord.ctrl) return false;
  if (event.altKey !== chord.alt) return false;
  return chord.shift === "any" || event.shiftKey === chord.shift;
}

/**
 * Whether one keystroke could run both chords: overlap, not string equality (spec 15 section 8.3).
 * A plain letter covers itself with and without Shift, so Shift H overlaps H. Ctrl means Cmd on a Mac,
 * which `matchesChord` already reads as one.
 */
export function chordsOverlap(a: KeyChord, b: KeyChord): boolean {
  return a.key === b.key && a.ctrl === b.ctrl && a.alt === b.alt && (a.shift === "any" || b.shift === "any" || a.shift === b.shift);
}

const anyOverlap = (a: readonly KeyChord[], b: readonly KeyChord[]): boolean => a.some((one) => b.some((other) => chordsOverlap(one, other)));

/** The written name of a `KeyboardEvent.key`, or undefined for a key no binding may use. */
function writtenKey(key: string): string | undefined {
  if (key === "Delete" || key === "Backspace") return "Del";
  for (const [name, keys] of Object.entries(KEY_NAMES)) if (keys.includes(key)) return name;
  if (MODIFIER_KEYS.has(key)) return key;
  if (key.length === 1) return key.trim() === "" ? undefined : isLetter(key) ? key.toUpperCase() : key;
  return NAMED_KEYS.has(key) ? key : undefined;
}

/** A chord in the written form, modifiers first: `Ctrl Shift PgDn`. */
export function writeChord(chord: KeyChord): string {
  const name = writtenKey(chord.key) ?? chord.key;
  return [chord.ctrl ? "Ctrl" : "", chord.alt ? "Alt" : "", chord.shift === true ? "Shift" : "", name].filter((part) => part !== "").join(" ");
}

/**
 * The chord a keystroke makes, for Settings, Keyboard's capture, or "modifier" while only a
 * modifier is down and the person has not pressed the key yet; undefined for a key no binding may
 * use (a dead key, an unidentified one).
 */
export function chordOfEvent(event: KeyLike): KeyChord | "modifier" | undefined {
  if (MODIFIER_KEYS.has(event.key)) return "modifier";
  if (writtenKey(event.key) === undefined) return undefined;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key === "Backspace" ? "Delete" : event.key;
  const ctrl = event.ctrlKey || event.metaKey;
  return { key, ctrl, alt: event.altKey, shift: shiftOf(key, ctrl, event.altKey, event.shiftKey) };
}

/** The canonical written form of one alternative, or undefined when it names no single key. */
export function normalizeKeys(text: string): string | undefined {
  if (text.includes(" or ")) return undefined;
  const chords = alternativeChords(text);
  const first = chords?.[0];
  if (first === undefined) return undefined;
  const name = writtenKey(first.key);
  if (name === undefined) return undefined;
  return writeChord(first);
}

/* ---- What can be rebound ----------------------------------------------------------------- */

/**
 * The actions with no key today that a person may give one (spec 15 section 8.2). The list is fixed
 * so the shortcut sheet still fits with every one of them bound. `path.optimize` (spec 16) joins
 * the table when that action exists; until then it is skipped.
 */
export const EXTRA_BINDABLE: readonly string[] = [
  "insert.path",
  "insert.wait",
  "insert.turn",
  "edit.makeCurve",
  "edit.makeLine",
  "view.clipGhosts",
  "view.theme",
  "path.optimize",
];

/** Actions whose key is fixed, with the reason Settings, Keyboard shows by the lock. */
const FIXED_ACTIONS: Readonly<Record<string, string>> = {
  "view.play": "Space plays and pauses, and pans the field while it is held.",
  "insert.menu": "Enter opens Insert, as it presses whatever button has focus.",
};

/** Second ways to reach an action that the sheet does not list, kept to the conventional ones. */
const ALIASES: Record<string, readonly string[]> = {
  "edit.redo": ["Ctrl Shift Z"],
};

/**
 * Where a binding is listed: an action's group, or `keys` for the keys with no action of their own,
 * which the shortcut sheet lists under Keys.
 */
export type BindingGroup = ActionGroup | "keys";

/** One action a key can run (spec 15 section 8.1), keyed by its action id. */
export interface Binding {
  id: string;
  /** Its id in the default table, when it has a default key. */
  shortcut?: ShortcutId;
  group: BindingGroup;
  label: string;
  does: string;
  /** The default key, in the written form; undefined for an action with no key by default. */
  keys?: string;
  /** Other default chords the sheet does not list; they stay while the binding has its default key. */
  aliases: readonly string[];
  /** Why its key cannot be changed, for a fixed binding. */
  fixed?: string;
  /**
   * A key the desktop app's native menu registers (a Robot menu item), not the page's key handler.
   * Its chords are checked for what a menu accelerator can be (`project/menuKeys.ts`), and the page
   * never runs them itself.
   */
  desktop?: true;
  /**
   * Shift turns the other way (Turn, `R` and `Shift R`): the binding's key is written without Shift,
   * and runs with or without it, so its chords have `shift: "any"`.
   */
  shiftTurns?: true;
}

/**
 * The keys with no action of their own that a person may rebind (issue #290). Each runs a handler
 * in `useKeyboard`, found by its key through the resolved keymap like any action's.
 */
export type KeyBindingId = "keys.rotate" | "keys.stepBack" | "keys.stepForward" | "keys.cycleRegion";

/**
 * Their bindings, with today's keys as the defaults. Step back and Step forward are two bindings,
 * since a binding has one chord (spec 15 section 8.1); the shortcut sheet folds them into one row.
 */
export const KEY_BINDINGS: readonly (Binding & { id: KeyBindingId })[] = [
  {
    id: "keys.rotate",
    group: "keys",
    label: "Turn",
    does: "Turn the start, a waypoint, or the heading at a path's first or last point 5°. With Shift, the other way.",
    keys: "R",
    aliases: [],
    shiftTurns: true,
  },
  { id: "keys.stepBack", group: "keys", label: "Step back", does: "Step the playhead back a tenth of a second.", keys: ",", aliases: [] },
  { id: "keys.stepForward", group: "keys", label: "Step forward", does: "Step the playhead forward a tenth of a second.", keys: ".", aliases: [] },
  { id: "keys.cycleRegion", group: "keys", label: "Next panel", does: "Move focus to the next panel.", keys: "F6", aliases: [] },
];

/** Why the desktop rows cannot be changed in a desktop app that is older than the menu keys message. */
export const UPDATE_DESKTOP_NOTE = "Update the desktop app to change these.";

/**
 * The bindings of a list of actions: every action with a key, and the curated extras. The desktop
 * actions' keys (`menuShortcut`) are bindings too, but they are fixed unless `menuKeysSupported`: a
 * desktop app without the `zenith:menu-keys` message keeps the keys it has, so Settings, Keyboard
 * shows them read-only (spec 15 section 8.5).
 */
export function bindingsOf(actions: readonly ActionDef[], menuKeysSupported = false): Binding[] {
  return actions.flatMap((action): Binding[] => {
    const desktop = action.menuShortcut !== undefined;
    const keys = action.shortcut === undefined ? action.menuShortcut : SHORTCUTS[action.shortcut];
    if (keys === undefined && !EXTRA_BINDABLE.includes(action.id)) return [];
    const fixed = desktop && !menuKeysSupported ? UPDATE_DESKTOP_NOTE : FIXED_ACTIONS[action.id];
    return [
      {
        id: action.id,
        ...(action.shortcut === undefined ? {} : { shortcut: action.shortcut }),
        group: action.group,
        label: action.label,
        // Read through the action each time, not copied once: Heading's text names the person's Turn
        // key, which only settles after the keymap loads (issue #290).
        get does(): string {
          return action.does;
        },
        ...(keys === undefined ? {} : { keys }),
        aliases: ALIASES[action.id] ?? [],
        ...(fixed === undefined ? {} : { fixed }),
        ...(desktop ? { desktop: true as const } : {}),
      },
    ];
  });
}

/**
 * Every binding in this build: the action table's, then the keys with no action of their own. The
 * default keys stay `SHORTCUTS`.
 */
export const BINDINGS: readonly Binding[] = [...bindingsOf(ACTIONS, canSetMenuKeys()), ...KEY_BINDINGS];

/* ---- Validation -------------------------------------------------------------------------- */

/** What decides a refusal beyond the key itself. */
export interface KeyContext {
  /** In the desktop app, Alt and a menu's letter opens that menu. */
  desktop: boolean;
  /**
   * The Robot menu's keys are bindings the person can change, in a desktop app that takes the menu
   * keys message. Then the keys the menu uses are those bindings' keys now, not the fixed defaults.
   * Set from the bindings (`withMenuKeys`), never by a caller.
   */
  menuKeys?: boolean;
}

/** `context`, saying whether `bindings` hold Robot menu keys a person can change. */
const withMenuKeys = (context: KeyContext, bindings: readonly Binding[]): KeyContext => ({
  ...context,
  menuKeys: bindings.some((binding) => binding.desktop === true && binding.fixed === undefined),
});

/** Why a page binding cannot take a key the desktop app's Robot menu has. */
const ROBOT_MENU_REFUSAL = "The desktop app's Robot menu uses it.";

/**
 * Chords the browser, the system or the desktop app keeps, each with the reason Settings, Keyboard
 * gives when a person tries one (spec 15 section 8.3). The list is plain data in
 * `project/menuKeys.ts`, which the desktop app's main process reads too.
 */
export { RESERVED_CHORDS };

const RESERVED =RESERVED_CHORDS.map((entry) => ({ chords: parseShortcut(entry.keys), reason: entry.reason }));

/**
 * The desktop app's own keys (`project/desktopKeys.ts`), refused in the browser too, and in a desktop
 * app too old to be told other menu keys. Where the Robot keys are bindings, `validateBinding` refuses
 * the keys they have now instead.
 */
const DESKTOP = Object.values(DESKTOP_KEYS)
  .filter((keys) => keys !== DESKTOP_KEYS.menu)
  .map((keys) => parseShortcut(keys));

/** The letters of the desktop app's menus, File, Edit, View, Robot and Help (apps/desktop/src/main/menu.ts). */
const MENU_LETTERS: ReadonlySet<string> = new Set(["f", "e", "v", "r", "h"]);

/** Why the keys and gestures that are not rebindable cannot take another meaning. */
function fixedReason(chord: KeyChord): string | undefined {
  const plain = !chord.ctrl && !chord.alt;
  if (chord.key === "Escape") return "Esc always cancels and closes.";
  if (chord.key === "Tab") return "Tab moves focus from control to control.";
  if (chord.key.startsWith("Arrow")) return "The arrows nudge, reorder and move between screens.";
  if (chord.key === " " && !chord.ctrl) return "Space plays and pauses, and pans the field while it is held.";
  if (chord.key === "Enter" && plain) return "Enter opens Insert and presses the focused button.";
  if (chord.key === "F10") return "F10 opens the menu in the desktop app, and Shift F10 a context menu.";
  return undefined;
}

/**
 * Why no binding may have these keys, or undefined when one may. `desktop` is for a binding the
 * desktop app's menu registers: it may take the desktop app's own keys, which only the page's
 * bindings are refused, but the menu must be able to draw and register the key
 * (`menuRefusal` in `project/menuKeys.ts`).
 */
export function refusalOf(chords: readonly KeyChord[], context: KeyContext, desktop = false): string | undefined {
  if (chords.length === 0) return "That is not a key a shortcut can use.";
  for (const chord of chords) {
    if (MODIFIER_KEYS.has(chord.key)) return "A modifier on its own is not a key. Hold it and press another key.";
    // On Windows, Ctrl and Alt together are AltGr, which types @, € and other characters on many
    // layouts, so such a chord would type a character in a field, or never arrive as the key it names.
    if (chord.ctrl && chord.alt) return "Ctrl and Alt together type characters on many keyboards (AltGr).";
    const fixed = fixedReason(chord);
    if (fixed !== undefined) return fixed;
    const reserved = RESERVED.find((entry) => entry.chords.some((other) => chordsOverlap(chord, other)));
    if (reserved !== undefined) return reserved.reason;
    if (desktop) {
      const menu = menuRefusal(writeChord(chord), true);
      if (menu !== undefined) return menu;
    } else if (context.menuKeys !== true && DESKTOP.some((keys) => keys.some((other) => chordsOverlap(chord, other)))) {
      return ROBOT_MENU_REFUSAL;
    }
    if (context.desktop && chord.alt && !chord.ctrl && MENU_LETTERS.has(chord.key)) return "In the desktop app, Alt and that letter opens a menu.";
  }
  return undefined;
}

/* ---- Resolution -------------------------------------------------------------------------- */

/** One binding as the person has it now. */
export interface ResolvedBinding {
  id: string;
  /** The key to show, in the written form; undefined when the action has no key. */
  keys: string | undefined;
  /** Every chord that runs it: its key, and an alias while it has its default. */
  chords: readonly KeyChord[];
  /** The person set this binding's key, or removed it. */
  custom: boolean;
}

export interface Keymap {
  bindings: ReadonlyMap<string, ResolvedBinding>;
  /**
   * Bindings left with no key because their default is one of the person's keys: a default added in
   * a later version that collides with a custom key (spec 15 section 8.3). The person's key wins.
   */
  displaced: readonly string[];
}

/** A binding's chords for one written key. Turn's run with or without Shift, which turns the other way. */
function chordsOf(binding: Binding, written: string): KeyChord[] {
  const chords = parseShortcut(written);
  return binding.shiftTurns === true ? chords.map((chord) => ({ ...chord, shift: "any" as const })) : chords;
}

/** The written key a binding keeps for `text`: Turn's without Shift, since Shift is its other way. */
function writtenFor(binding: Binding, text: string): string | undefined {
  if (binding.shiftTurns !== true) return normalizeKeys(text);
  const tokens = text.trim().split(/\s+/);
  return normalizeKeys(tokens.filter((token) => token !== "Shift").join(" "));
}

/** Why Turn cannot take a digit or a punctuation key: with Shift it arrives as another character. */
const SHIFT_TURNS_REFUSAL = "Shift turns the other way, and with Shift this key types another character. Choose a letter, or a key such as F7 or Home.";

/** The key and chords a binding may take for `text`, or why it may not. */
function ownKeys(binding: Binding, text: string, context: KeyContext): { keys: string; chords: KeyChord[] } | { refused: string } {
  const keys = writtenFor(binding, text);
  if (keys === undefined) return { refused: "That is not a key a shortcut can use." };
  const chords = chordsOf(binding, keys);
  if (binding.shiftTurns === true && chords.some((chord) => chord.key.length === 1 && !isLetter(chord.key))) return { refused: SHIFT_TURNS_REFUSAL };
  const refused = refusalOf(chords, context, binding.desktop === true);
  return refused === undefined ? { keys, chords } : { refused };
}

/** The custom key an override gives, or undefined when the override is not one a person may use. */
function customChords(binding: Binding, text: string, context: KeyContext): { keys: string; chords: KeyChord[] } | undefined {
  const own = ownKeys(binding, text, context);
  return "refused" in own ? undefined : own;
}

/**
 * Each binding's key and chords, with the person's keys laid over the defaults (spec 15 section
 * 8.1). An override for a fixed or unknown binding, or with a key a person may not use, is ignored,
 * so a damaged entry falls back alone; of two overrides that overlap, the first in table order wins.
 * A default that overlaps one of the person's keys gives way to it: the alternative is dropped, and a
 * binding left with no key at all is `displaced`. The result never holds two overlapping bindings.
 */
export function resolveKeymap(bindings: readonly Binding[], overrides: KeyOverrides, context: KeyContext = { desktop: false }): Keymap {
  const checks = withMenuKeys(context, bindings);
  const resolved = new Map<string, ResolvedBinding>();
  const custom: KeyChord[] = [];
  for (const binding of bindings) {
    if (binding.fixed !== undefined || !Object.hasOwn(overrides, binding.id)) continue;
    const text = overrides[binding.id];
    if (text === undefined || text === binding.keys) continue;
    if (text === null) {
      resolved.set(binding.id, { id: binding.id, keys: undefined, chords: [], custom: true });
      continue;
    }
    const own = customChords(binding, text, checks);
    if (own === undefined || anyOverlap(own.chords, custom)) continue;
    custom.push(...own.chords);
    resolved.set(binding.id, { id: binding.id, keys: own.keys, chords: own.chords, custom: true });
  }
  const displaced: string[] = [];
  const result = new Map<string, ResolvedBinding>();
  for (const binding of bindings) {
    const mine = resolved.get(binding.id);
    if (mine !== undefined) {
      result.set(binding.id, mine);
      continue;
    }
    const alternatives = (binding.keys === undefined ? [] : binding.keys.split(" or ")).filter(
      (alternative) => !anyOverlap(chordsOf(binding, alternative), custom),
    );
    const aliases = binding.aliases.filter((alias) => !anyOverlap(chordsOf(binding, alias), custom));
    const keys = alternatives.length === 0 ? undefined : alternatives.join(" or ");
    if (binding.keys !== undefined && keys === undefined) displaced.push(binding.id);
    result.set(binding.id, {
      id: binding.id,
      keys,
      chords: [...alternatives, ...(keys === undefined ? [] : aliases)].flatMap((written) => chordsOf(binding, written)),
      custom: false,
    });
  }
  return { bindings: result, displaced };
}

/** What `validateBinding` found. */
export type BindingCheck =
  | { kind: "ok"; keys: string }
  /** The keys are `other`'s now; Settings, Keyboard offers to move them. */
  | { kind: "conflict"; keys: string; other: string }
  | { kind: "refused"; reason: string };

/**
 * Whether the binding `id` may take `keys` (spec 15 section 8.3): ok, a conflict naming the binding
 * that has an overlapping key now (a hidden action's key counts too), or a refusal with the reason.
 * A page binding never takes a key the Robot menu has: the default ones, or, where the Robot keys
 * can be changed, the ones the menu has now, so a key Simulate moved off is free again.
 */
export function validateBinding(
  id: string,
  keys: string,
  keymap: Keymap,
  bindings: readonly Binding[] = BINDINGS,
  context: KeyContext = { desktop: false },
): BindingCheck {
  const binding = bindings.find((one) => one.id === id);
  if (binding === undefined) return { kind: "refused", reason: "No action has that id." };
  if (binding.fixed !== undefined) return { kind: "refused", reason: binding.fixed };
  const own = ownKeys(binding, keys, withMenuKeys(context, bindings));
  if ("refused" in own) return { kind: "refused", reason: own.refused };
  if (binding.desktop !== true) {
    const menu = bindings.filter((one) => one.desktop === true).map((one) => keymap.bindings.get(one.id)?.chords ?? []);
    if (menu.some((chords) => anyOverlap(own.chords, chords))) return { kind: "refused", reason: ROBOT_MENU_REFUSAL };
  }
  for (const [other, resolved] of keymap.bindings) {
    if (other !== id && anyOverlap(own.chords, resolved.chords)) return { kind: "conflict", keys: own.keys, other };
  }
  return { kind: "ok", keys: own.keys };
}

/**
 * The overrides after the binding `id` takes `keys`: a written key, null for no key, or undefined for
 * its default back. Any other binding whose key overlaps gives it up, so the stored keymap never holds
 * two overlapping bindings: a custom key becomes no key, and a default that would have nothing left
 * becomes no key too, which is "Move it here" (spec 15 section 8.3). A default with another
 * alternative left keeps that one, as `? or F1` keeps `?` when F1 moves, unless another of the person's
 * keys already holds it.
 */
export function assignKey(
  bindings: readonly Binding[],
  overrides: KeyOverrides,
  id: string,
  keys: string | null | undefined,
  context: KeyContext = { desktop: false },
): KeyOverrides {
  const binding = bindings.find((one) => one.id === id);
  if (binding === undefined || binding.fixed !== undefined) return overrides;
  const next: Record<string, string | null> = { ...overrides };
  let taken: KeyChord[];
  if (keys === undefined || keys === binding.keys) {
    delete next[id];
    // An alias that collides gives way by itself (`resolveKeymap`), so only the default's own keys take.
    taken = binding.keys === undefined ? [] : chordsOf(binding, binding.keys);
  } else if (keys === null) {
    next[id] = null;
    taken = [];
  } else {
    const own = customChords(binding, keys, withMenuKeys(context, bindings));
    if (own === undefined) return overrides;
    next[id] = own.keys;
    taken = own.chords;
  }
  for (const other of bindings) {
    if (other.id === id || other.fixed !== undefined) continue;
    const text = next[other.id];
    if (typeof text === "string") {
      if (anyOverlap(chordsOf(other, text), taken)) next[other.id] = null;
    } else if (text === undefined && other.keys !== undefined) {
      const left = other.keys.split(" or ").filter((alternative) => !anyOverlap(chordsOf(other, alternative), taken));
      if (left.length === 0) next[other.id] = null;
    }
  }
  // A default can lose its last alternative to the person's other keys too: `? or F1` keeps only F1
  // while `?` is custom elsewhere, and loses it when F1 moves. `displaced` is kept for a new default
  // that collides with a custom key, so a binding this move leaves with no key gets null instead. One
  // that was displaced before the move stays displaced, so its upgrade note is still shown.
  const before = new Set(resolveKeymap(bindings, overrides, context).displaced);
  for (const other of resolveKeymap(bindings, next, context).displaced) {
    if (other !== id && !before.has(other)) next[other] = null;
  }
  return next;
}

/**
 * Every other binding that has a key overlapping `keys` now, in table order: what giving the binding
 * `id` its default back would take from, for Reset's conflict. A default such as `? or F1` can overlap
 * two of the person's keys at once, and `assignKey` takes both, so the conflict must name both. So
 * can Turn's key, which takes its Shift twin too: F1 for Turn is the sheet's F1 and What's this's
 * Shift F1.
 */
export function overlappingBindings(keymap: Keymap, id: string, keys: string, bindings: readonly Binding[] = BINDINGS): string[] {
  const mover = bindings.find((one) => one.id === id);
  const chords = mover === undefined ? parseShortcut(keys) : chordsOf(mover, keys);
  return [...keymap.bindings].filter(([other, resolved]) => other !== id && anyOverlap(chords, resolved.chords)).map(([other]) => other);
}

/**
 * What a binding keeps when `keys` moves away from it, for the conflict's "Move it here" line:
 * the alternatives of its default that are left, or undefined when it would have no key. `id` is the
 * binding the keys move to, whose keys can take more than they say: Turn's take the Shift twin too.
 */
export function keysLeftAfterMove(keymap: Keymap, other: string, keys: string, id?: string, bindings: readonly Binding[] = BINDINGS): string | undefined {
  const resolved = keymap.bindings.get(other);
  if (resolved === undefined || resolved.custom || resolved.keys === undefined) return undefined;
  const mover = id === undefined ? undefined : bindings.find((one) => one.id === id);
  const taken = mover === undefined ? parseShortcut(keys) : chordsOf(mover, keys);
  const left = resolved.keys.split(" or ").filter((alternative) => !anyOverlap(parseShortcut(alternative), taken));
  return left.length === 0 ? undefined : left.join(" or ");
}

/** Every key name a binding may end in, for the worst case below. */
const ALL_KEY_NAMES: readonly string[] = [
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split(""),
  ...Array.from({ length: 24 }, (_, index) => `F${String(index + 1)}`),
  ...Object.keys(KEY_NAMES),
  ...[...NAMED_KEYS].filter((name) => !name.startsWith("F")),
];

/** The modifiers a binding may have. Ctrl and Alt together are refused (AltGr), so two is the most. */
const MODIFIER_SETS: readonly string[] = ["Ctrl Shift ", "Alt Shift ", "Ctrl ", "Alt ", "Shift ", ""];

/**
 * Every bindable action bound, with the longest legal labels: the worst case the shortcut sheet must
 * still fit (`e2e/qa/15-visual.spec.ts`, spec 15 section 8.4). Each key is checked as a person's
 * would be, so the result is a keymap a person could really have.
 */
export function worstCaseKeys(bindings: readonly Binding[], context: KeyContext = { desktop: false }): KeyOverrides {
  const keys: Record<string, string> = {};
  const used: KeyChord[] = [];
  const candidates = MODIFIER_SETS.flatMap((modifiers) => ALL_KEY_NAMES.map((name) => `${modifiers}${name}`))
    .filter((written) => normalizeKeys(written) === written && refusalOf(parseShortcut(written), context) === undefined)
    .sort((a, b) => b.length - a.length);
  for (const binding of bindings) {
    // A desktop menu key has more to satisfy (`menuRefusal`), and it is not on the page's sheet.
    if (binding.fixed !== undefined || binding.desktop === true) continue;
    // Each candidate as this binding takes it: Turn's has no Shift, and covers its Shift twin too.
    let found: { keys: string; chords: KeyChord[] } | undefined;
    for (const candidate of candidates) {
      const own = customChords(binding, candidate, context);
      if (own !== undefined && own.keys === candidate && !anyOverlap(own.chords, used)) {
        found = own;
        break;
      }
    }
    if (found === undefined) break;
    keys[binding.id] = found.keys;
    used.push(...found.chords);
  }
  return keys;
}

/* ---- The live keymap --------------------------------------------------------------------- */

/** Where this page runs, for the refusals that depend on it. */
export const keyContext = (): KeyContext => ({ desktop: isDesktop() });

let cache: { overrides: KeyOverrides; keymap: Keymap } | null = null;

/** The person's keymap now, resolved from `prefs.keys` once per change of it. */
export function currentKeymap(): Keymap {
  const overrides = getState().prefs.keys;
  if (cache === null || cache.overrides !== overrides) cache = { overrides, keymap: resolveKeymap(BINDINGS, overrides, keyContext()) };
  return cache.keymap;
}

/** The binding's key now, in the written form, or undefined when it has none. */
export const bindingKeys = (id: string): string | undefined => currentKeymap().bindings.get(id)?.keys;

/** Whether the binding's key is the person's own (set or removed in Settings, Keyboard). */
export const isCustomKey = (id: string): boolean => currentKeymap().bindings.get(id)?.custom === true;

/** Every chord that runs `action`: its key, then any alias while it has its default. */
export function chordsFor(action: ActionDef): readonly KeyChord[] {
  // Only the page's own keys: the desktop menu's (`menuShortcut`) are the menu's to handle, so a
  // press runs its action once.
  if (action.menuShortcut !== undefined) return [];
  return currentKeymap().bindings.get(action.id)?.chords ?? [];
}

/** The action a keystroke runs, if any. A feature switched off in Settings takes its keys with it. */
export function actionForKey(event: KeyLike): ActionDef | undefined {
  const features = getFeatures();
  return ACTIONS.find(
    (action) => actionShown(action.id, features) && chordsFor(action).some((chord) => matchesChord(event, chord)),
  );
}

/**
 * The key with no action of their own that a keystroke runs, if any (issue #290): Turn, Step back,
 * Step forward or Next panel, found by the person's keys as an action is. A Ctrl or Alt chord matches
 * only a binding that has that chord, never a plain key (QA-14).
 */
export function keyBindingForKey(event: KeyLike): KeyBindingId | undefined {
  const keymap = currentKeymap();
  return KEY_BINDINGS.find((binding) => keymap.bindings.get(binding.id)?.chords.some((chord) => matchesChord(event, chord)) === true)?.id;
}

/** Turn's label: its key, then the same key with Shift for the other way (`R / Shift R`). */
export function turnLabel(keys: string | undefined): string | undefined {
  if (keys === undefined) return undefined;
  const [chord] = parseShortcut(keys);
  return chord === undefined ? keys : `${keys} / ${writeChord({ ...chord, shift: true })}`;
}

/** Step back's and Step forward's keys, the halves of the sheet's one step row, each when it has one. */
export const stepKeys = (): { id: KeyBindingId; keys: string }[] =>
  (["keys.stepBack", "keys.stepForward"] as const).flatMap((id) => {
    const keys = bindingKeys(id);
    return keys === undefined ? [] : [{ id, keys }];
  });

/** The shortcut ids whose label is made from the bindings with no action of their own. */
const KEY_BINDING_LABELS: Partial<Record<ShortcutId, () => string | undefined>> = {
  rotate: () => turnLabel(bindingKeys("keys.rotate")),
  stepTime: () => {
    const keys = stepKeys().map((half) => half.keys);
    return keys.length === 0 ? undefined : keys.join(" ");
  },
  cycleRegion: () => bindingKeys("keys.cycleRegion"),
};

const BY_SHORTCUT: ReadonlyMap<ShortcutId, Binding> = new Map(
  BINDINGS.flatMap((binding) => (binding.shortcut === undefined ? [] : [[binding.shortcut, binding] as const])),
);

setKeyLabelSource({
  // A shortcut id with no action in this build (Propose in host mode) and the fixed keys with no
  // action of their own keep their default.
  shortcut: (id) => {
    const made = KEY_BINDING_LABELS[id];
    if (made !== undefined) return made();
    const binding = BY_SHORTCUT.get(id);
    return binding === undefined ? SHORTCUTS[id] : bindingKeys(binding.id);
  },
  action: bindingKeys,
  has: (id) => currentKeymap().bindings.has(id),
  subscribe: subscribeEditor,
});

/**
 * Chords that edit the document stay the browser's while the user is typing, so Ctrl Z in a field
 * undoes the typing, not the routine. Other Ctrl chords and the function keys work everywhere.
 */
export const EDIT_CHORDS: ReadonlySet<string> = new Set(["edit.undo", "edit.redo", "edit.duplicate"]);

/**
 * The editing chords that still run from a focused select. A select has no undo of its own, so
 * after a pick in one, Ctrl Z undoes the pick in the routine and Ctrl Y does it again, as the status
 * line after a Wait for switch says (issue #144).
 */
const SELECT_CHORDS: ReadonlySet<string> = new Set(["edit.undo", "edit.redo"]);

/**
 * Whether the chord that runs `actionId` is left to the focused field, whose tag name is `tag`
 * (`INPUT`, `TEXTAREA`, `SELECT`, or anything for an editable element), instead of the routine.
 */
export function fieldKeepsChord(actionId: string, tag: string): boolean {
  if (!EDIT_CHORDS.has(actionId)) return false;
  return !(tag === "SELECT" && SELECT_CHORDS.has(actionId));
}

/** The rows of keys with no action of their own, as the shortcut sheet lists them. */
export type KeyOnlyId = "nudge" | "nudgeFar" | "rotate" | "reorder" | "screens" | "stepTime" | "cycleRegion" | "escape";

/** The rows whose keys are fixed: `useKeyboard` checks their keys itself. */
export type FixedKeyOnlyId = Exclude<KeyOnlyId, "rotate" | "stepTime" | "cycleRegion">;

export interface KeyOnlyRow {
  id: KeyOnlyId;
  /** The default keys, in the sheet's words. */
  keys: string;
  does: string;
  /** The bindings that give the row its keys, when a person may change them (`KEY_BINDINGS`). */
  bindings?: readonly KeyBindingId[];
}

/**
 * Keys that act on the selection, the playhead or focus directly, as the sheet lists them. Turn, the
 * two steps of the playhead and Next panel are bindings a person may change (issue #290); the rest
 * stay fixed (spec 15 section 8.2). The words that name a distance say the person's own
 * (`editing.nudgeIn` and the other editing numbers, spec 15 section 4.3), so the sheet cannot
 * disagree with the keys.
 */
export const keyOnlyRows = (numbers: EditingNumbers): readonly KeyOnlyRow[] => [
  {
    id: "nudge",
    keys: SHORTCUTS.nudge,
    does: `Move the selected point or waypoint by ${formatInches(numbers.nudgeIn)}. On a step row they walk the list.`,
  },
  { id: "nudgeFar", keys: SHORTCUTS.nudgeFar, does: `Move the selected point or waypoint by ${formatInches(numbers.nudgeFarIn)}.` },
  {
    id: "rotate",
    keys: SHORTCUTS.rotate,
    does: "Turn the start, a waypoint, or the heading at a path's first or last point, one way or the other.",
    bindings: ["keys.rotate"],
  },
  { id: "reorder", keys: SHORTCUTS.reorder, does: "Move the selected step in the list." },
  {
    id: "screens",
    keys: SHORTCUTS.screens,
    does: "Go back or forward a screen, like the mouse's side buttons.",
  },
  {
    id: "stepTime",
    keys: SHORTCUTS.stepTime,
    does: `Step the playhead back or forward ${formatSeconds(numbers.scrubStepS)}.`,
    bindings: ["keys.stepBack", "keys.stepForward"],
  },
  { id: "cycleRegion", keys: SHORTCUTS.cycleRegion, does: "Move focus to the next panel.", bindings: ["keys.cycleRegion"] },
  { id: "escape", keys: "Esc", does: "Cancel a drag, close a menu, clear the selection, or leave the tour." },
];

/** The rows with every number at its default, which is what a person who never opens Settings sees. */
export const KEY_ONLY: readonly KeyOnlyRow[] = keyOnlyRows(DEFAULT_EDITING_NUMBERS);
