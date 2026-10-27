/**
 * User presets, the changes from the recorded preset (section 6.2), and `zenith.presets` (section 5):
 * parsed one preset at a time, at most 20, each name 1 to 40 characters and unique.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PREFS, loadPrefs, type Prefs } from "../state/prefs";
import { loadUserPresets, saveUserPresets } from "./presetStorage";
import {
  MAX_PRESET_NAME,
  MAX_USER_PRESETS,
  applyPreset,
  applyUserPreset,
  builtInBase,
  changeSummary,
  changesFrom,
  chosenPresetName,
  nameProblem,
  parsePresetRef,
  parseUserPresets,
  presetLabel,
  presetValueOf,
  uniqueName,
  userPresetFrom,
  wouldChange,
  type UserPreset,
} from "./presets";
import { getSetting, withSetting } from "./registry";

const drive = (prefs: Prefs, extra: Partial<UserPreset> = {}): UserPreset => ({
  ...userPresetFrom(prefs, { id: "user:drive", name: "Drive team", description: "", basedOn: "full", includeKeys: false }),
  ...extra,
});

describe("zenith.presets", () => {
  it("keeps the good presets when one is corrupt, and counts the one it dropped", () => {
    const good = drive(applyPreset(DEFAULT_PREFS, "full"));
    const other = { ...good, id: "user:scouts", name: "Scouts" };
    const parsed = parseUserPresets({
      version: 1,
      presets: [good, { id: "user:bad", name: 7 }, "junk", other, { ...good, id: "not-a-user-id", name: "Third" }],
    });
    expect(parsed.presets.map((preset) => preset.name)).toEqual(["Drive team", "Scouts"]);
    expect(parsed.dropped).toBe(3);
    expect(parsed.presets[0]).toEqual(good);
  });

  it("drops a bad value inside a preset and keeps the preset", () => {
    const good = drive(DEFAULT_PREFS);
    const parsed = parseUserPresets({ version: 1, presets: [{ ...good, settings: { ...good.settings, "editing.snap": "yes", "features.teleport": true } }] });
    expect(parsed.presets).toHaveLength(1);
    expect(parsed.presets[0]?.settings).not.toHaveProperty("editing.snap");
    expect(parsed.presets[0]?.settings).not.toHaveProperty("features.teleport");
    expect(parsed.presets[0]?.settings["features.ledger"]).toBe(good.settings["features.ledger"]);
  });

  it("keeps a copy's link to its project preset file, and drops a bad link without the preset (spec 15 section 6.5)", () => {
    const linked = drive(DEFAULT_PREFS, { fromProject: { project: "folder:robot", file: "Drive team.zenith-preset.json" } });
    expect(parseUserPresets({ version: 1, presets: [linked] }).presets[0]?.fromProject).toEqual({
      project: "folder:robot",
      file: "Drive team.zenith-preset.json",
    });
    for (const bad of ["folder:robot", { project: "", file: "x.zenith-preset.json" }, { project: "folder:robot", file: 3 }]) {
      const parsed = parseUserPresets({ version: 1, presets: [{ ...linked, fromProject: bad }] });
      expect(parsed.presets).toHaveLength(1);
      expect(parsed.presets[0]).not.toHaveProperty("fromProject");
    }
  });

  it("keeps at most 20, and the first of two with the same name or id", () => {
    const many = Array.from({ length: 25 }, (_, index) => drive(DEFAULT_PREFS, { id: `user:${String(index)}`, name: `Preset ${String(index)}` }));
    expect(parseUserPresets({ version: 1, presets: many }).presets).toHaveLength(MAX_USER_PRESETS);
    expect(MAX_USER_PRESETS).toBe(20);
    const twins = parseUserPresets({
      version: 1,
      presets: [drive(DEFAULT_PREFS), drive(DEFAULT_PREFS, { id: "user:other", name: "DRIVE TEAM" }), drive(DEFAULT_PREFS, { name: "Again" })],
    });
    expect(twins.presets.map((preset) => preset.id)).toEqual(["user:drive"]);
    expect(twins.dropped).toBe(2);
  });

  it("is empty for nothing stored, junk, or another version", () => {
    for (const raw of [undefined, null, "x", [], { version: 2, presets: [drive(DEFAULT_PREFS)] }, { version: 1, presets: "x" }]) {
      expect(parseUserPresets(raw).presets, JSON.stringify(raw)).toEqual([]);
    }
  });

  describe("in localStorage", () => {
    const stored = new Map<string, string>();
    beforeEach(() => {
      stored.clear();
      (globalThis as { window?: unknown }).window = {
        localStorage: {
          getItem: (key: string) => stored.get(key) ?? null,
          setItem: (key: string, value: string) => {
            stored.set(key, value);
          },
        },
      };
    });
    afterEach(() => {
      delete (globalThis as { window?: unknown }).window;
    });

    it("round-trips under its own key, apart from zenith.ui", () => {
      const preset = drive(applyPreset(DEFAULT_PREFS, "basic"));
      saveUserPresets([preset]);
      expect(JSON.parse(stored.get("zenith.presets") ?? "null")).toEqual({ version: 1, presets: [preset] });
      expect(stored.has("zenith.ui")).toBe(false);
      expect(loadUserPresets().presets).toEqual([preset]);
      stored.set("zenith.presets", "{not json");
      expect(loadUserPresets().presets).toEqual([]);
    });

    it("lets zenith.ui resolve a recorded user preset through the built-in it is based on", () => {
      saveUserPresets([drive(DEFAULT_PREFS, { basedOn: "full" })]);
      stored.set("zenith.ui", JSON.stringify({ version: 1, preset: { id: "user:drive", chosen: true } }));
      expect(loadPrefs().features.ledger).toBe(true);
    });
  });
});

describe("a preset's name", () => {
  const presets = [drive(DEFAULT_PREFS)];

  it("is 1 to 40 characters, not a built-in's, and unique ignoring case", () => {
    expect(nameProblem("", presets)).toBeDefined();
    expect(nameProblem("   ", presets)).toBeDefined();
    expect(nameProblem("x".repeat(MAX_PRESET_NAME + 1), presets)).toBeDefined();
    expect(nameProblem("x".repeat(MAX_PRESET_NAME), presets)).toBeUndefined();
    expect(nameProblem("essential", presets)).toBeDefined();
    expect(nameProblem("drive TEAM", presets)).toBeDefined();
    expect(nameProblem("Drive team", presets, "user:drive"), "renaming to its own name").toBeUndefined();
    expect(nameProblem("Scouts", presets)).toBeUndefined();
    expect(MAX_PRESET_NAME).toBe(40);
  });

  it("becomes 'Name (2)' when it is taken", () => {
    expect(uniqueName("Drive team", presets)).toBe("Drive team (2)");
    expect(uniqueName("Full", presets)).toBe("Full (2)");
    expect(uniqueName("Scouts", presets)).toBe("Scouts");
  });
});

describe("the changes from the recorded preset", () => {
  it("are 'Basic, 1 change' after one setting changes, and none once it is set back", () => {
    const basic = applyPreset(DEFAULT_PREFS, "basic");
    expect(changesFrom(basic, [])).toEqual([]);
    expect(changeSummary(basic, [])).toBe("Basic");
    const changed = withSetting(basic, "features.ledger", true);
    expect(changesFrom(changed, [])).toEqual(["features.ledger"]);
    expect(changeSummary(changed, [])).toBe("Basic, 1 change");
    const two = withSetting(changed, "features.partners", true);
    expect(changeSummary(two, [])).toBe("Basic, 2 changes");
    expect(changesFrom(withSetting(changed, "features.ledger", false), [])).toEqual([]);
    // Layout is not a change: a preset never sets it.
    expect(changesFrom(withSetting(basic, "display.theme", "light"), [])).toEqual([]);
  });

  it("count a hidden toolbar button against a user preset, which carries it", () => {
    const users = [drive(DEFAULT_PREFS)];
    const applied = applyUserPreset(DEFAULT_PREFS, users[0] as UserPreset, { keys: false });
    expect(changesFrom(applied, users)).toEqual([]);
    const hidden = withSetting(applied, "display.toolbar.run.validate", false);
    expect(changesFrom(hidden, users)).toEqual(["display.toolbar.run.validate"]);
    expect(presetValueOf(hidden, users, "display.toolbar.run.validate")).toBe(true);
  });

  it("name the chosen preset for the tour's closing line, even one whose own name starts with Custom", () => {
    const users = [drive(DEFAULT_PREFS, { name: "Custom drive" })];
    const applied = applyUserPreset(DEFAULT_PREFS, users[0] as UserPreset, { keys: false });
    expect(chosenPresetName(applied.preset, users)).toBe("Custom drive");
    // Once it is deleted it has no name of its own, and Settings calls it Custom.
    expect(chosenPresetName(applied.preset, [])).toBeNull();
    expect(chosenPresetName(applyPreset(DEFAULT_PREFS, "full").preset, [])).toBe("Full");
    expect(chosenPresetName(DEFAULT_PREFS.preset, [])).toBeNull();
  });

  it("read 'Custom (based on Full)' once the recorded user preset is deleted", () => {
    const users = [drive(applyPreset(DEFAULT_PREFS, "full"))];
    const applied = applyUserPreset(DEFAULT_PREFS, users[0] as UserPreset, { keys: false });
    expect(presetLabel(applied.preset, users)).toBe("Drive team");
    expect(presetLabel(applied.preset, [])).toBe("Custom (based on Full)");
    expect(builtInBase(applied.preset, [])).toBe("full");
  });
});

describe("applying a preset", () => {
  const mine: Prefs = { ...DEFAULT_PREFS, keys: { "run.validate": "Ctrl E" } };

  it("never changes keys for a built-in", () => {
    for (const id of ["basic", "essential", "full"] as const) expect(applyPreset(mine, id).keys).toEqual(mine.keys);
  });

  it("replaces the keys with a user preset's own only when asked to", () => {
    const preset = drive(DEFAULT_PREFS, { keys: { "tool.measure": null } });
    expect(applyUserPreset(mine, preset, { keys: true }).keys).toEqual({ "tool.measure": null });
    expect(applyUserPreset(mine, preset, { keys: false }).keys).toEqual(mine.keys);
    // A preset saved without keys leaves them whatever is asked.
    expect(applyUserPreset(mine, drive(DEFAULT_PREFS), { keys: true }).keys).toEqual(mine.keys);
  });

  it("does not count the person's keys as a change, or revert them, after Keep my keys", () => {
    const preset = drive(DEFAULT_PREFS, { keys: { "tool.measure": null } });
    const users = [preset];
    const kept = applyUserPreset(mine, preset, { keys: false });
    expect(changesFrom(kept, users)).toEqual([]);
    expect(changeSummary(kept, users)).toBe("Drive team");
    expect(presetValueOf(kept, users, "keys.bindings")).toBeUndefined();
    // Recorded as kept across a reload.
    expect(parsePresetRef(JSON.parse(JSON.stringify(kept.preset)))).toEqual(kept.preset);
    // A change to a setting is still one.
    expect(changesFrom(withSetting(kept, "features.ledger", !kept.features.ledger), users)).toEqual(["features.ledger"]);
    // Taking the preset's keys makes them part of what it sets again.
    const taken = applyUserPreset(mine, preset, { keys: true });
    expect(changesFrom(taken, users)).toEqual([]);
    expect(changesFrom({ ...taken, keys: mine.keys }, users)).toEqual(["keys.bindings"]);
  });

  it("writes the preset's settings, fills what it lacks from its base, and records it with its base", () => {
    const preset = drive(DEFAULT_PREFS, { basedOn: "basic", settings: { "features.ledger": true } });
    const applied = applyUserPreset(applyPreset(DEFAULT_PREFS, "full"), preset, { keys: false });
    expect(applied.features.ledger).toBe(true);
    expect(applied.features.partners).toBe(false);
    expect(applied.features.groups).toBe(false);
    expect(applied.preset).toEqual({ id: "user:drive", chosen: true, basedOn: "basic" });
    expect(parsePresetRef(JSON.parse(JSON.stringify(applied.preset)))).toEqual(applied.preset);
    expect(getSetting(applied, "display.theme")).toBe(DEFAULT_PREFS.theme);
  });

  it("says what an imported preset would change, keys included, without applying it", () => {
    const basic = applyPreset(DEFAULT_PREFS, "basic");
    const preset = drive(basic, { settings: { ...drive(basic).settings, "features.ledger": true }, keys: { "run.validate": "Ctrl E" } });
    expect(wouldChange(basic, preset)).toEqual(["features.ledger", "keys.bindings"]);
    expect(wouldChange(applyUserPreset(basic, preset, { keys: true }), preset)).toEqual([]);
  });

  it("saves the current settings, and the keys only with Include my keys", () => {
    const prefs = withSetting(mine, "features.partners", true);
    const without = userPresetFrom(prefs, { id: "user:a", name: "A", description: "", basedOn: "essential", includeKeys: false });
    expect(without.settings["features.partners"]).toBe(true);
    expect(without).not.toHaveProperty("keys");
    expect(without.settings).not.toHaveProperty("display.theme");
    expect(without.settings).not.toHaveProperty("keys.bindings");
    const withKeys = userPresetFrom(prefs, { id: "user:a", name: "A", description: "", basedOn: "essential", includeKeys: true });
    expect(withKeys.keys).toEqual(mine.keys);
  });
});
