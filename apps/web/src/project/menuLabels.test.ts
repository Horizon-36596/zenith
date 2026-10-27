/**
 * The native menu and the palette call each action by the same name (UI_GUIDE "One thing, many
 * names"): every menu item that runs a web action carries that action's palette label, plus only an
 * access key and, for an item that opens a dialog or picker, a trailing ellipsis.
 */
import { describe, expect, it } from "vitest";
import { ACTIONS } from "../app/actions";
import { DESKTOP_ACTIONS } from "./desktopActions";
import { MENU_LABELS, plainMenuLabel, type MenuLabelId } from "./menuLabels";

const paletteLabel = (id: MenuLabelId): string | undefined =>
  ACTIONS.find((action) => action.id === id)?.label ?? DESKTOP_ACTIONS.find((action) => action.id === id)?.label;

describe("MENU_LABELS", () => {
  it("names each item as the palette names its action", () => {
    for (const [id, label] of Object.entries(MENU_LABELS) as [MenuLabelId, string][]) {
      expect(paletteLabel(id), id).toBeDefined();
      expect(plainMenuLabel(label).replace(/…$/, ""), id).toBe(paletteLabel(id)?.replace(/…$/, ""));
    }
  });

  it("gives every item exactly one access key", () => {
    for (const [id, label] of Object.entries(MENU_LABELS)) {
      expect(label.replace(/&&/g, "").match(/&/g), id).toHaveLength(1);
    }
  });

  it("drops only the access key and the ellipsis for the palette", () => {
    expect(plainMenuLabel("&Open a robot repository folder…")).toBe("Open a robot repository folder");
    expect(plainMenuLabel("Save &as")).toBe("Save as");
  });
});
