/**
 * The page's half of the desktop menu's hide path: a switch that hides a menu item's action takes the
 * item out of the `zenith:menu-keys` message, and turning the switch changes the message the page
 * sends. No switch gates a menu item yet, so the Robot-code sim is gated here by Code tab, standing in
 * for the switch that will.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_FEATURES, setFeatures } from "../state/features";
import type { DesktopMenuKeys, ZenithDesktopBridge } from "./desktopBridge";
import { currentMenuKeys, startMenuKeys } from "./menuKeysSync";

vi.mock("../state/features", async (importOriginal) => {
  const real = await importOriginal<typeof import("../state/features")>();
  return {
    ...real,
    actionShown: (id: string, features: Parameters<typeof real.actionShown>[1]) =>
      id === "desktop.sim" ? features.codeTab : real.actionShown(id, features),
  };
});

describe("the menu keys message", () => {
  beforeEach(() => {
    setFeatures(ALL_FEATURES);
  });
  afterEach(() => {
    setFeatures(ALL_FEATURES);
  });

  it("hides the item whose action a switch hides, and only that one", () => {
    expect(currentMenuKeys().hidden).toEqual([]);
    setFeatures({ codeTab: false });
    expect(currentMenuKeys().hidden).toEqual(["desktop.sim"]);
    // A hidden item keeps its key, so it comes back on the same key when the switch is on again.
    expect(currentMenuKeys().keys["desktop.sim"]).toBe("Ctrl F5");
  });

  it("is sent again when a switch changes", () => {
    const sent: DesktopMenuKeys[] = [];
    const bridge = {
      setMenuKeys: (message: DesktopMenuKeys) => {
        sent.push(message);
        return Promise.resolve();
      },
    } as unknown as ZenithDesktopBridge;
    const stop = startMenuKeys(bridge);
    try {
      expect(sent.map((message) => message.hidden)).toEqual([[]]);
      setFeatures({ codeTab: false });
      expect(sent.map((message) => message.hidden)).toEqual([[], ["desktop.sim"]]);
      setFeatures({ codeTab: true });
      expect(sent.map((message) => message.hidden)).toEqual([[], ["desktop.sim"], []]);
    } finally {
      stop();
    }
  });
});
