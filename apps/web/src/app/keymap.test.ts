/**
 * The shortcut sheet and the keyboard handler read one table (QA-13), so every key the sheet lists
 * runs what the sheet says, and no two actions claim the same key.
 */
import { describe, expect, it } from "vitest";
import { ACTIONS, shortcutOf } from "./actions";
import { KEY_ONLY, actionForKey, chordsFor, parseShortcut, type KeyChord, type KeyLike } from "./keymap";
import { SHORTCUTS } from "./shortcuts";

/** The keystroke a chord describes, as a browser would report it. */
const press = (chord: KeyChord): KeyLike => ({
  key: chord.key.length === 1 && chord.shift === true ? chord.key.toUpperCase() : chord.key,
  ctrlKey: chord.ctrl,
  metaKey: false,
  shiftKey: chord.shift === true,
  altKey: chord.alt,
});

const key = (key: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

describe("the keymap", () => {
  it("runs every action the sheet lists from the keys the sheet shows for it", () => {
    for (const action of ACTIONS) {
      const written = shortcutOf(action);
      if (written === undefined) continue;
      const chords = parseShortcut(written);
      expect(chords.length, `${action.id}: "${written}" names no key`).toBeGreaterThan(0);
      for (const chord of chords) {
        expect(actionForKey(press(chord))?.id, `${written} runs ${action.id}`).toBe(action.id);
      }
    }
  });

  it("gives no two actions the same key", () => {
    const seen = new Map<string, string>();
    for (const action of ACTIONS) {
      for (const chord of chordsFor(action)) {
        const id = JSON.stringify(chord);
        expect(seen.get(id), `${action.id} and ${seen.get(id) ?? ""} share ${id}`).toBeUndefined();
        seen.set(id, action.id);
      }
    }
  });

  it("lists every shortcut in the table, on an action or as a key of its own", () => {
    const shown = new Set([
      ...ACTIONS.map((action) => shortcutOf(action)).filter((keys): keys is string => keys !== undefined),
      ...KEY_ONLY.map((row) => row.keys),
    ]);
    for (const [id, keys] of Object.entries(SHORTCUTS)) {
      expect(shown.has(keys), `${id} (${keys}) is on the sheet`).toBe(true);
    }
  });

  it("runs Propose from Ctrl Shift Enter, and Insert only from a plain Enter", () => {
    expect(actionForKey(key("Enter", { ctrlKey: true, shiftKey: true }))?.id).toBe("run.propose");
    expect(actionForKey(key("Enter"))?.id).toBe("insert.menu");
    expect(actionForKey(key("Enter", { shiftKey: true }))).toBeUndefined();
  });

  it("leaves browser chords alone: Ctrl C, A, V, R and P run nothing", () => {
    for (const letter of ["c", "a", "v", "r", "p"]) {
      expect(actionForKey(key(letter, { ctrlKey: true })), `Ctrl ${letter}`).toBeUndefined();
      expect(actionForKey(key(letter, { metaKey: true })), `Cmd ${letter}`).toBeUndefined();
    }
  });

  it("takes a plain letter with or without Shift, and a chord only exactly", () => {
    expect(actionForKey(key("V", { shiftKey: true }))?.id).toBe("tool.select");
    expect(actionForKey(key("z", { ctrlKey: true }))?.id).toBe("edit.undo");
    expect(actionForKey(key("Z", { ctrlKey: true, shiftKey: true }))?.id).toBe("edit.redo");
    expect(actionForKey(key("?", { shiftKey: true }))?.id).toBe("help.shortcuts");
    expect(actionForKey(key("Backspace"))?.id).toBe("edit.delete");
  });
});
