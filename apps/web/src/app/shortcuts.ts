import { useSyncExternalStore } from "react";

/**
 * The canonical shortcut map, as one table (apps/web/UI_GUIDE.md section 9.4, the tooltip contract;
 * the keyboard equivalents of every drag are in section 11). These are the defaults: the keys a
 * person has set are resolved over them in `keymap.ts`. Only this file and `keymap.ts` read the table.
 * Tooltips, menus, hints, the tour and the palette read a key through `keyLabel(id)` or
 * `useKeyLabel(id)`, so a rebound key reaches all of them at once, and `shortcutReads.test.ts` fails on
 * a read anywhere else.
 */
export const SHORTCUTS = {
  select: "V",
  addPath: "P",
  addCommand: "C",
  marker: "M",
  heading: "H",
  measure: "U",
  snap: "S",
  alliance: "A",
  palette: "Ctrl K",
  validate: "F8",
  simulate: "F5",
  save: "Ctrl S",
  propose: "Ctrl Shift Enter",
  undo: "Ctrl Z",
  redo: "Ctrl Y",
  delete: "Del",
  renameWaypoint: "F2",
  insertAfter: "Enter",
  nudge: "← ↑ → ↓",
  nudgeFar: "Shift + arrows",
  rotate: "R / Shift R",
  cycleRegion: "F6",
  playPause: "Space",
  stepTime: ", .",
  reorder: "Alt + ↑ ↓",
  screens: "Alt + ← →",
  openProject: "Ctrl O",
  duplicate: "Ctrl D",
  help: "? or F1",
  whatsThis: "Shift F1",
  settings: "Ctrl ,",
} as const;

export type ShortcutId = keyof typeof SHORTCUTS;

/**
 * The shortcuts a person cannot rebind: Space for Play, Enter for Insert, the arrow families.
 * `keyLabel` always has a key for these. Turn, the playhead's steps and Next panel can be rebound
 * (issue #290), so theirs may be undefined.
 */
export type FixedShortcutId = "playPause" | "insertAfter" | "nudge" | "nudgeFar" | "reorder" | "screens";

/**
 * Where the person's keys come from. `keymap.ts` installs it when it loads, from the resolved keymap
 * (`resolveKeymap`); until then, and in a test that never loads the keymap, every key is its default.
 * It lives behind this seam so this file stays a leaf that `actions.ts`, the tour and the e2e specs
 * can import without pulling in the store.
 */
export interface KeyLabelSource {
  /** The key for a shortcut id, or undefined while the person has left its action without one. */
  shortcut: (id: ShortcutId) => string | undefined;
  /** The key for an action id, or undefined when the action has none. */
  action: (actionId: string) => string | undefined;
  /** Whether a binding has this action id, so that no key means the person removed it. */
  has: (actionId: string) => boolean;
  /** Calls `listener` after any change that may change a key. Returns the unsubscribe. */
  subscribe: (listener: () => void) => () => void;
}

let source: KeyLabelSource | null = null;

/** Installs the person's keys (`keymap.ts`). */
export function setKeyLabelSource(next: KeyLabelSource): void {
  source = next;
}

/**
 * The key to show for a binding, in the written form (`Ctrl Z`). Everything that names a key reads
 * this, never `SHORTCUTS` itself, so a key the person rebinds changes every tooltip, hint and tour line
 * in one place. A fixed key always has one; any other may be undefined, when the person removed it.
 */
export function keyLabel(id: FixedShortcutId): string;
export function keyLabel(id: ShortcutId): string | undefined;
export function keyLabel(id: ShortcutId): string | undefined {
  return source === null ? SHORTCUTS[id] : source.shortcut(id);
}

/** The key the page handles for an action (by its id), or undefined when it has none. */
export function actionKeyLabel(actionId: string, shortcut: ShortcutId | undefined): string | undefined {
  if (source !== null) return source.action(actionId);
  return shortcut === undefined ? undefined : SHORTCUTS[shortcut];
}

/**
 * The key to show for an action the desktop app's menu handles (`menuShortcut`): the person's own,
 * or none when they removed it, and `fallback`, the menu's default, only where no binding knows the
 * action.
 */
export function menuKeyLabel(actionId: string, fallback: string): string | undefined {
  return source !== null && source.has(actionId) ? source.action(actionId) : fallback;
}

/**
 * The key, or `words` when the person left the action without one: for a sentence such as
 * "Ctrl Z puts it back.", which then reads "Undo puts it back.".
 */
export function keyOr(id: ShortcutId, words: string): string {
  return keyLabel(id) ?? words;
}

/**
 * Turn's keys for a sentence, `R and Shift R`, from its label `R / Shift R`; undefined while the
 * person left Turn with no key (issue #290).
 */
export const turnWords = (label: string | undefined): string | undefined => label?.replace(" / ", " and ");

const NO_SOURCE = (): (() => void) => () => undefined;

/** `keyLabel` for a component, which draws again when the person changes the key. */
export function useKeyLabel(id: FixedShortcutId): string;
export function useKeyLabel(id: ShortcutId): string | undefined;
export function useKeyLabel(id: ShortcutId): string | undefined {
  return useSyncExternalStore(source?.subscribe ?? NO_SOURCE, () => keyLabel(id), () => keyLabel(id));
}

/** How far an arrow key moves a point, in inches (UI_GUIDE section 9). */
export const NUDGE_IN = 0.5;
export const NUDGE_FAR_IN = 2;

/** How far `R` turns a heading, in degrees. */
export const ROTATE_DEG = 5;

/** How far `,` and `.` move the playback head, in seconds. */
export const SCRUB_STEP_S = 0.1;
