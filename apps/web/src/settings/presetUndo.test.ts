/**
 * Applying a preset says how many settings it changed, and one Undo puts them back with the preset
 * the settings came from before (UI_GUIDE 9.15).
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS } from "../state/prefs";
import { getState, setPrefs } from "../state/store";
import { ESSENTIAL_UNCHOSEN } from "./presets";
import { applyBuiltInPreset, presetUndoFrom, undoPresetApply } from "./presetStore";
import { SETTINGS, getSetting } from "./registry";

describe("a preset's apply and its undo", () => {
  it("counts the settings Basic changes and puts every one back", () => {
    const { theme: _theme, ...rest } = DEFAULT_PREFS;
    setPrefs({ ...rest, preset: ESSENTIAL_UNCHOSEN });
    const before = getState().prefs;
    applyBuiltInPreset("basic");
    const undo = presetUndoFrom(before, getState().prefs);
    expect(undo.changed.length).toBeGreaterThan(0);
    for (const id of undo.changed) expect(getSetting(getState().prefs, id)).not.toEqual(getSetting(before, id));

    undoPresetApply(undo);
    const after = getState().prefs;
    for (const entry of SETTINGS) expect(getSetting(after, entry.id)).toEqual(getSetting(before, entry.id));
    expect(after.preset).toEqual(before.preset);
  });

  it("counts nothing when the preset is already in place", () => {
    applyBuiltInPreset("basic");
    const before = getState().prefs;
    applyBuiltInPreset("basic");
    expect(presetUndoFrom(before, getState().prefs).changed).toEqual([]);
  });
});
