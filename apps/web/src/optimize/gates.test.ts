/**
 * Every entry point of Optimize path goes with its switch (issue #308): the palette commands
 * `path.optimize` and `path.optimizeWithOptions`, which the Inspector's Optimize button and any key
 * bound to them run, and the finding actions that open the card. With `features.optimizer` off none of
 * them is offered; the switch lists them in its gates, as every switch does.
 */
import { describe, expect, it } from "vitest";
import { ACTIONS, actionById, isEnabled } from "../app/actions";
import { settingEntry } from "../settings/registry";
import { ALL_FEATURES, actionShown, fixShown } from "../state/features";
import { DEFAULT_PREFS } from "../state/prefs";
import { getState } from "../state/store";

const OFF = { ...ALL_FEATURES, optimizer: false };

describe("the Optimize path switch's gates", () => {
  it("list both palette commands, the field's Add a clear path here and the finding action kinds that open the card", () => {
    const gates = settingEntry("features.optimizer").gates;
    expect(gates?.actions).toEqual(["path.optimize", "path.optimizeWithOptions", "path.optimizeAll", "field.addClearPathHere"]);
    expect(gates?.fixes).toEqual(["optimizeRoute"]);
  });

  it("hide the palette commands, and so the Inspector button and any key, while the switch is off", () => {
    for (const id of ["path.optimize", "path.optimizeWithOptions", "path.optimizeAll"]) {
      expect(ACTIONS.some((action) => action.id === id)).toBe(true);
      expect(actionShown(id, ALL_FEATURES)).toBe(true);
      expect(actionShown(id, OFF)).toBe(false);
    }
  });

  it("hide a finding's Route around action while the switch is off, and leave every other fix alone", () => {
    expect(fixShown("optimizeRoute", ALL_FEATURES)).toBe(true);
    expect(fixShown("optimizeRoute", OFF)).toBe(false);
    expect(fixShown("replaceRoute", OFF)).toBe(true);
    expect(fixShown("focusTimeout", OFF)).toBe(true);
  });
});

describe("the palette commands", () => {
  it("have no default key, and say to select a path step when none is", () => {
    for (const id of ["path.optimize", "path.optimizeWithOptions", "path.optimizeAll"]) {
      const action = actionById(id);
      expect(action?.shortcut).toBeUndefined();
      expect(action?.keywords?.length).toBeGreaterThan(0);
      const state = { ...getState(), prefs: DEFAULT_PREFS };
      if (action === undefined) throw new Error(`${id} is missing`);
      expect(isEnabled(action, state)).toBe(false);
      expect(action.whyDisabled?.(state)).toBe("Open an auto first.");
    }
  });
});
