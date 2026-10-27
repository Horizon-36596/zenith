/**
 * The keys the desktop menu shows and registers, and the checks the page and the main process share
 * for the `zenith:menu-keys` message.
 */
import { describe, expect, it } from "vitest";
import { actionById } from "../app/actions";
import { RESERVED_CHORDS } from "../app/keymap";
import { SHORTCUTS } from "../app/shortcuts";
import {
  DEFAULT_MENU_KEYS,
  MENU_ITEMS,
  checkMenuKeys,
  isRegisteredItem,
  menuKeysMessage,
  menuRefusal,
  parseMenuKey,
  toAccelerator,
} from "./menuKeys";

describe("the menu's default keys", () => {
  it("are the page's own default for each item the page handles, so the menu cannot show another key", () => {
    for (const item of MENU_ITEMS) {
      if (item.registered) continue;
      const shortcut = actionById(item.id)?.shortcut;
      expect(shortcut, item.id).toBeDefined();
      expect(SHORTCUTS[shortcut as keyof typeof SHORTCUTS], item.id).toBe(item.key);
    }
  });

  it("have a key of their own for every item and hide none", () => {
    expect(Object.keys(DEFAULT_MENU_KEYS.keys).sort()).toEqual(MENU_ITEMS.map((item) => item.id).sort());
    expect(DEFAULT_MENU_KEYS.hidden.size).toBe(0);
    expect(MENU_ITEMS.filter((item) => item.registered).map((item) => item.id)).toEqual(["desktop.sim", "desktop.deploy", "desktop.git"]);
  });
});

describe("a written key as an accelerator", () => {
  it("turns Ctrl into CmdOrCtrl and names the keys Electron names differently", () => {
    expect(toAccelerator("Ctrl Shift F5")).toBe("CmdOrCtrl+Shift+F5");
    expect(toAccelerator("Ctrl F5")).toBe("CmdOrCtrl+F5");
    expect(toAccelerator("Alt Shift E")).toBe("Alt+Shift+E");
    expect(toAccelerator("Ctrl PgDn")).toBe("CmdOrCtrl+PageDown");
    expect(toAccelerator("Ctrl Del")).toBe("CmdOrCtrl+Delete");
    expect(toAccelerator("Ctrl ←")).toBe("CmdOrCtrl+Left");
    expect(toAccelerator("Ctrl ,")).toBe("CmdOrCtrl+,");
    expect(toAccelerator("Ctrl 7")).toBe("CmdOrCtrl+7");
  });

  it("is undefined for anything Electron could not parse, which would make it throw", () => {
    for (const bad of ["", "Hyper+S", "Ctrl+S", "Ctrl Ctrl S", "Ctrl Shift", "Ctrl S S", "Ctrl é", "Ctrl F25", "ctrl s x", "Ctrl  S", "Super S"]) {
      expect(toAccelerator(bad), bad).toBeUndefined();
    }
    expect(parseMenuKey("Ctrl Shift e")).toMatchObject({ key: "E", ctrl: true, shift: true });
  });
});

describe("refusing a key", () => {
  it("refuses every reserved chord, whichever item it is for", () => {
    for (const entry of RESERVED_CHORDS) {
      expect(menuRefusal(entry.keys, false), entry.keys).toBeDefined();
      expect(menuRefusal(entry.keys, true), entry.keys).toBeDefined();
    }
    // The reason is the reserved list's, except for a key that is fixed for its own reason first.
    expect(menuRefusal("Ctrl W", true)).toBe("The browser closes the tab with it.");
  });

  it("keeps F10, Esc and Tab fixed and refuses Ctrl with Alt", () => {
    for (const keys of ["F10", "Ctrl F10", "Esc", "Tab", "Ctrl Alt S"]) expect(menuRefusal(keys, false), keys).toBeDefined();
  });

  it("asks a registered key for Ctrl, Alt or a function key, so it cannot run while someone types", () => {
    for (const keys of ["S", "Shift S", "Del", "1", ","]) expect(menuRefusal(keys, true), keys).toBeDefined();
    for (const keys of ["F5", "Shift F5", "Ctrl Shift F5", "Ctrl 1", "Alt S", "Ctrl Del"]) expect(menuRefusal(keys, true), keys).toBeUndefined();
    // A key the page handles, and the menu only shows, may be a plain one.
    expect(menuRefusal("S", false)).toBeUndefined();
  });

  it("refuses Alt and a menu's letter, which opens that menu", () => {
    for (const letter of "FEVRH") expect(menuRefusal(`Alt ${letter}`, true), letter).toContain("opens a menu");
    expect(menuRefusal("Alt S", true)).toBeUndefined();
  });
});

describe("checking a menu keys message", () => {
  it("fills the items it leaves out with their defaults, and accepts a rebound Simulate key", () => {
    const checked = checkMenuKeys({ keys: { "desktop.sim": "Ctrl Shift F5" }, hidden: ["desktop.git"] });
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value.keys["desktop.sim"]).toBe("Ctrl Shift F5");
    expect(checked.value.keys["desktop.deploy"]).toBe("Ctrl Shift D");
    expect(checked.value.keys["run.save"]).toBe("Ctrl S");
    expect([...checked.value.hidden]).toEqual(["desktop.git"]);
  });

  it("accepts no keys and no hidden items, and null for an item with no key", () => {
    expect(checkMenuKeys({}).ok).toBe(true);
    const none = checkMenuKeys({ keys: { "edit.redo": null }, hidden: [] });
    expect(none.ok && none.value.keys["edit.redo"]).toBeNull();
  });

  it("refuses an unknown id, a wrong shape, a reserved key and two items on one key", () => {
    for (const payload of [
      { keys: { "help.docs": "Ctrl G" } },
      { keys: { __proto__: null, constructor: "Ctrl G" } },
      { keys: { "desktop.sim": 7 } },
      { keys: { "desktop.sim": "Ctrl W" } },
      { keys: { "run.save": "Ctrl Shift F5", "desktop.sim": "Ctrl Shift F5" } },
      { keys: { "run.save": "s", "edit.undo": "S" } },
      { hidden: ["nonsense"] },
      { hidden: "desktop.sim" },
      { hidden: Array.from({ length: 20 }, () => "desktop.sim") },
      { keys: "Ctrl S" },
      [],
      null,
      42,
    ]) {
      expect(checkMenuKeys(payload).ok, JSON.stringify(payload)).toBe(false);
    }
  });

  it("names the item and the reason when it refuses", () => {
    const checked = checkMenuKeys({ keys: { "desktop.sim": "Ctrl W" } });
    expect(checked).toEqual({ ok: false, reason: expect.stringContaining("desktop.sim") });
    expect(!checked.ok && checked.reason).toContain("closes the tab");
  });
});

describe("the message the page sends", () => {
  const everyDefault = (id: string) => MENU_ITEMS.find((item) => item.id === id)?.key;

  it("carries the resolved key of each item, and passes the main process's check", () => {
    const message = menuKeysMessage((id) => (id === "desktop.sim" ? "Ctrl Shift F5" : everyDefault(id)), () => true);
    expect(message.keys["desktop.sim"]).toBe("Ctrl Shift F5");
    expect(message.keys["run.save"]).toBe("Ctrl S");
    expect(message.hidden).toEqual([]);
    expect(checkMenuKeys(message).ok).toBe(true);
  });

  it("names the hidden items, so the Robot item of a hidden feature goes", () => {
    const message = menuKeysMessage(everyDefault, (id) => id !== "desktop.sim" && id !== "desktop.git");
    expect(message.hidden).toEqual(["desktop.sim", "desktop.git"]);
    expect(isRegisteredItem("desktop.sim")).toBe(true);
    expect(checkMenuKeys(message).ok).toBe(true);
  });

  it("sends none for a removed key, the first of two keys, and none for a key the menu cannot draw", () => {
    const message = menuKeysMessage(
      (id) => (id === "run.save" ? undefined : id === "edit.undo" ? "Ctrl Z or F1" : id === "edit.redo" ? "Ctrl é" : id === "desktop.deploy" ? "D" : everyDefault(id)),
      () => true,
    );
    expect(message.keys["run.save"]).toBeNull();
    expect(message.keys["edit.undo"]).toBe("Ctrl Z");
    expect(message.keys["edit.redo"]).toBeNull();
    // A plain letter would run Deploy while someone types, so the menu is not given it.
    expect(message.keys["desktop.deploy"]).toBeNull();
    expect(checkMenuKeys(message).ok).toBe(true);
  });
});
