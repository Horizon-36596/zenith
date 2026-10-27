/**
 * The shortcut sheet's step row (issue #290): Step back and Step forward are two bindings shown as
 * one row, a chip for each. When the person removes one, the row keeps the other's key and says only
 * what that half does; when both are gone, the row is left out.
 */
import { afterEach, describe, expect, it } from "vitest";
import "../app/keymap";
import { setSetting } from "../state/store";
import { CANVAS_HELP } from "../canvas/help";
import { DEFAULT_EDITING_NUMBERS } from "../settings/editingNumbers";
import { keyRows, mouseTables, sheetTables } from "./ShortcutsOverlay";

const stepRows = () => keyRows().filter((row) => row.does.startsWith("Step the playhead"));

describe("the sheet's step row", () => {
  afterEach(() => {
    setSetting("keys.bindings", {});
  });

  it("has both halves by default, a chip for each, and says both ways", () => {
    expect(stepRows()).toEqual([
      {
        keys: ", .",
        does: expect.stringMatching(/^Step the playhead back or forward /),
        parts: [
          { keys: ",", custom: false },
          { keys: ".", custom: false },
        ],
      },
    ]);
  });

  it("keeps the other half's key and words when one half is removed", () => {
    setSetting("keys.bindings", { "keys.stepBack": null });
    const [row] = stepRows();
    expect(stepRows()).toHaveLength(1);
    expect(row?.keys).toBe(".");
    expect(row?.does).toMatch(/^Step the playhead forward /);
    expect(row?.does).not.toContain("back");
    expect(row?.parts).toEqual([{ keys: ".", custom: false }]);

    setSetting("keys.bindings", { "keys.stepForward": null, "keys.stepBack": "J" });
    const [back] = stepRows();
    expect(back?.keys).toBe("J");
    expect(back?.does).toMatch(/^Step the playhead back /);
    expect(back?.does).not.toContain("forward");
    expect(back?.parts).toEqual([{ keys: "J", custom: true }]);
  });

  it("is left out when neither half has a key", () => {
    setSetting("keys.bindings", { "keys.stepBack": null, "keys.stepForward": null });
    expect(stepRows()).toEqual([]);
  });
});

/**
 * The sheet in two tabs (issue #414): Keys lists every key once, with a note where one key does two
 * things, and Mouse holds the gestures. Every table has a title, so every column starts with one.
 */
describe("the sheet's two tabs", () => {
  afterEach(() => {
    setSetting("keys.bindings", {});
  });

  const keyTables = () => sheetTables(DEFAULT_EDITING_NUMBERS).filter((table) => table.rows.length > 0);
  const keysOnTheKeysTab = () => keyTables().flatMap((table) => table.rows.flatMap((row) => (row.parts === undefined ? [row.keys] : row.parts.map((part) => part.keys))));

  it("lists each key once on the Keys tab, whichever table it is in", () => {
    const keys = keysOnTheKeysTab();
    const twice = keys.filter((key, at) => keys.indexOf(key) !== at);
    expect(twice).toEqual([]);
  });

  it("says where S and C do a second thing, on the row of the action they run, rather than listing them again", () => {
    const rows = keyTables().flatMap((table) => table.rows);
    const s = rows.filter((row) => row.keys === "S");
    const c = rows.filter((row) => row.keys === "C");
    expect(s).toHaveLength(1);
    expect(c).toHaveLength(1);
    expect(s[0]?.note).toMatch(/selected curve point/);
    expect(c[0]?.note).toMatch(/selected curve point/);
    // Esc is the Keys table's row, not a second one from the canvas's gestures.
    expect(rows.filter((row) => row.keys === "Esc")).toHaveLength(1);
  });

  it("titles every table, and leaves a table out only when it has no rows", () => {
    const titles = keyTables().map((table) => table.title);
    expect(titles).toEqual(expect.arrayContaining(["Tools", "Editing", "Project and help", "Run and view", "Other keys"]));
    // The tab is Keys, so no table on it is headed Keys too (0.1.2 UX sweep, W1-11).
    expect(titles).not.toContain("Keys");
    for (const table of [...keyTables(), ...mouseTables()]) expect(table.title.trim()).not.toBe("");
  });

  it("puts every canvas gesture on a tab, the lone keys with the keys and the rest on Mouse, and none twice", () => {
    const onMouse = mouseTables().flatMap((table) => table.rows.map((row) => row.keys));
    const loneKey = (gesture: string) => /^(Esc|[A-Z])$/.test(gesture);
    for (const entry of CANVAS_HELP) {
      if (loneKey(entry.gesture)) expect(onMouse, entry.id).not.toContain(entry.gesture);
      else expect(onMouse, entry.id).toContain(entry.gesture);
    }
    expect(onMouse.filter((gesture, at) => onMouse.indexOf(gesture) !== at)).toEqual([]);
    // F zooms and no action has it, so it is a row of the Keys tab.
    expect(keysOnTheKeysTab()).toContain("F");
  });
});
