/**
 * The desktop app's own keys (sweep D7): the tooltips and the palette show them, the page's key
 * handler leaves them to the native menu so a press runs its action once, and the shortcut sheet's
 * Desktop group exists only where the desktop actions do.
 */
import { Rocket } from "lucide-react";
import { describe, expect, it } from "vitest";
import { desktopRows } from "../help/ShortcutsOverlay";
import { DESKTOP_KEYS } from "../project/desktopKeys";
import { ACTIONS, pageShortcutOf, shortcutOf, type ActionDef } from "./actions";
import { actionForKey, chordsFor } from "./keymap";

const deploy: ActionDef = {
  id: "desktop.deploy",
  label: "Deploy autos into the robot repo",
  does: "Copy the project's autos into the robot repository.",
  group: "run",
  icon: Rocket,
  run: () => undefined,
  menuShortcut: DESKTOP_KEYS["desktop.deploy"],
};

describe("the desktop app's keys", () => {
  it("are shown for their actions but never claimed by the page's key handler", () => {
    expect(shortcutOf(deploy)).toBe("Ctrl Shift D");
    expect(pageShortcutOf(deploy)).toBeUndefined();
    expect(chordsFor(deploy)).toEqual([]);
  });

  it("leave Ctrl F5, Ctrl Shift D and Ctrl Shift G unhandled in the page", () => {
    const press = (key: string, shiftKey: boolean) => actionForKey({ key, ctrlKey: true, metaKey: false, shiftKey, altKey: false });
    expect(press("F5", false)).toBeUndefined();
    expect(press("D", true)).toBeUndefined();
    expect(press("G", true)).toBeUndefined();
    // Ctrl D without Shift is still Duplicate.
    expect(press("d", false)?.id).toBe("edit.duplicate");
  });

  it("add no Desktop group to the browser build's shortcut sheet", () => {
    expect(ACTIONS.some((action) => action.menuShortcut !== undefined)).toBe(false);
    expect(desktopRows()).toEqual([]);
  });

  it("do not repeat a key the page already uses", () => {
    const pageKeys = new Set(ACTIONS.map(pageShortcutOf).filter((keys) => keys !== undefined));
    for (const keys of Object.values(DESKTOP_KEYS)) expect(pageKeys.has(keys)).toBe(false);
  });
});
