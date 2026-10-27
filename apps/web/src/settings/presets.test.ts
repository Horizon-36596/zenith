/**
 * The built-in presets and how a stored `zenith.ui` resolves through them (section 5): the stored
 * value, then the recorded preset's, then the default.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALL_FEATURES } from "../state/features";
import { DEFAULT_FEATURES, DEFAULT_PREFS, FULL_SIM_DEFAULT, NO_FEATURES, PREFS_VERSION, loadPrefs, readPrefs, type Prefs } from "../state/prefs";
import {
  BUILT_IN_PRESETS,
  ESSENTIAL_UNCHOSEN,
  applyPreset,
  builtInBase,
  parsePresetRef,
  presetChanges,
  presetSettings,
  presetSwitchedOff,
  resolveSetting,
  type UserPresetBase,
} from "./presets";
import { SETTINGS, getSetting, isPresettable, settingEntry, withSetting } from "./registry";

describe("the built-in presets", () => {
  it("are Basic, Essential and Full, in that order", () => {
    expect(BUILT_IN_PRESETS.map((preset) => [preset.id, preset.name])).toEqual([
      ["basic", "Basic"],
      ["essential", "Essential"],
      ["full", "Full"],
    ]);
  });

  it("set the values spec 15 section 4 gives today's settings", () => {
    expect(presetSettings("basic")).toEqual({
      "features.partners": false,
      "features.ledger": false,
      "features.commands": true,
      "features.groups": false,
      "features.waypoints": false,
      "features.advancedHeading": false,
      "features.optimizer": false,
      "features.codeTab": false,
      "editing.snap": true,
      "editing.defaultHeading": "linear",
      "editing.addPathExtends": false,
      "editing.newPathKeepsHeading": true,
      "editing.protectMeasuredPins": true,
      "display.clipGhosts": true,
      "display.fieldGrid": "tiles",
      "display.ledgerCounts": true,
      "display.clearanceOutline": false,
      "display.waypointPins": "used",
      "display.findingCodes": false,
    });
    expect(presetSettings("essential")).toEqual({
      "features.partners": false,
      "features.ledger": false,
      "features.commands": true,
      "features.groups": true,
      "features.waypoints": true,
      "features.advancedHeading": true,
      "features.optimizer": true,
      "features.codeTab": true,
      "editing.snap": true,
      "editing.defaultHeading": "linear",
      "editing.addPathExtends": false,
      "editing.newPathKeepsHeading": true,
      "editing.protectMeasuredPins": true,
      "display.clipGhosts": true,
      "display.fieldGrid": "tiles",
      "display.ledgerCounts": true,
      "display.clearanceOutline": false,
      "display.waypointPins": "used",
      "display.findingCodes": true,
    });
    expect(presetSettings("full")).toEqual({
      "features.partners": true,
      "features.ledger": true,
      "features.commands": true,
      "features.groups": true,
      "features.waypoints": true,
      "features.advancedHeading": true,
      "features.optimizer": true,
      "features.codeTab": true,
      "editing.snap": true,
      "editing.defaultHeading": "linear",
      "editing.addPathExtends": false,
      "editing.newPathKeepsHeading": true,
      "editing.protectMeasuredPins": true,
      "display.clipGhosts": true,
      "display.fieldGrid": "tiles",
      "display.ledgerCounts": true,
      "display.clearanceOutline": true,
      "display.waypointPins": "all",
      "display.findingCodes": true,
    });
  });

  it("Essential is today's editor: applying it to the defaults changes no setting", () => {
    const applied = applyPreset(DEFAULT_PREFS, "essential");
    expect({ ...applied, preset: DEFAULT_PREFS.preset }).toEqual(DEFAULT_PREFS);
    expect(applied.preset).toEqual({ id: "essential", chosen: true });
  });

  it("applying writes every value the preset sets, records it, and leaves layout alone", () => {
    const before: Prefs = { ...DEFAULT_PREFS, theme: "light", fieldView: "vector", fieldStyle: "dark", panelLeftW: 410, snap: false };
    const full = applyPreset(before, "full");
    // Every switch but Full sim, which no preset carries (issue #207).
    expect(full.features).toEqual({ ...ALL_FEATURES, fullSim: DEFAULT_PREFS.features.fullSim });
    expect(full.snap).toBe(true);
    expect(full.preset).toEqual({ id: "full", chosen: true });
    expect([full.theme, full.fieldView, full.fieldStyle, full.panelLeftW]).toEqual(["light", "vector", "dark", 410]);
    expect(presetChanges(full, "full")).toEqual([]);
  });

  it("derives the changes from a preset and never stores them", () => {
    const changed = withSetting(withSetting(applyPreset(DEFAULT_PREFS, "basic"), "features.ledger", true), "display.theme", "light");
    expect(presetChanges(changed, "basic")).toEqual(["features.ledger"]);
    expect(presetChanges(changed, "full")).toEqual([
      "features.partners",
      "features.groups",
      "features.waypoints",
      "features.advancedHeading",
      "features.optimizer",
      "features.codeTab",
      "display.clearanceOutline",
      "display.waypointPins",
      "display.findingCodes",
    ]);
    expect(Object.keys(changed)).not.toContain("changes");
  });
});

describe("what a built-in turns off, for its card", () => {
  it("names each feature switch the preset sets off, from the registry, in the order General lists them", () => {
    expect(presetSwitchedOff("full")).toEqual([]);
    expect(presetSwitchedOff("essential")).toEqual(["Partner sharing", "Ledger and ball counting"]);
    expect(presetSwitchedOff("basic")).toEqual([
      "Partner sharing",
      "Ledger and ball counting",
      "Step groups",
      "Waypoints",
      "Advanced heading",
      "Optimize path",
      "Code tab",
    ]);
  });

  it("leaves out a switch registered ahead of its feature, since nothing in the editor shows it yet", () => {
    // Optimize path was the one such switch until its action arrived (spec 16); now Basic names it.
    const awaiting = SETTINGS.filter((entry) => entry.kind === "feature" && entry.awaiting !== undefined).map((entry) => entry.label);
    expect(awaiting).toEqual([]);
    for (const label of awaiting) expect(presetSwitchedOff("basic")).not.toContain(label);
    expect(presetSwitchedOff("basic")).toContain("Optimize path");
  });
});

describe("the recorded preset", () => {
  it("is Essential, not chosen, when nothing or junk is stored", () => {
    for (const raw of [undefined, null, 3, "full", [], {}, { id: "user:" }, { id: 7 }, { id: "Full" }]) {
      expect(parsePresetRef(raw), JSON.stringify(raw)).toEqual(ESSENTIAL_UNCHOSEN);
    }
  });

  it("keeps a stored choice when its preset id is unknown, so a choice is never asked for twice", () => {
    expect(parsePresetRef({ id: "advanced", chosen: true })).toEqual({ id: "essential", chosen: true });
  });

  it("keeps a built-in or a user preset, and whether it was chosen", () => {
    expect(parsePresetRef({ id: "basic", chosen: true })).toEqual({ id: "basic", chosen: true });
    expect(parsePresetRef({ id: "full" })).toEqual({ id: "full", chosen: false });
    expect(parsePresetRef({ id: "user:4f0c", chosen: "yes" })).toEqual({ id: "user:4f0c", chosen: false });
  });

  it("falls back through a user preset to the built-in it is based on, and to Essential once it is gone", () => {
    const presets: UserPresetBase[] = [{ id: "user:drive", basedOn: "full" }];
    expect(builtInBase({ id: "user:drive", chosen: true }, presets)).toBe("full");
    expect(builtInBase({ id: "user:gone", chosen: true }, presets)).toBe("essential");
    expect(builtInBase({ id: "basic", chosen: true }, presets)).toBe("basic");
  });

  it("resolves a setting as the stored value, then the preset's, then the default", () => {
    const ledger = settingEntry("features.ledger");
    expect(resolveSetting(ledger, false, "full")).toBe(false);
    expect(resolveSetting(ledger, undefined, "full")).toBe(true);
    expect(resolveSetting(ledger, "on", "full")).toBe(true);
    expect(resolveSetting(ledger, undefined, "essential")).toBe(false);
    // Layout is outside every preset, so it goes straight to the default.
    expect(resolveSetting(settingEntry("display.theme"), undefined, "full")).toBe("dark");
  });
});

/** Today's loadPrefs, rule by rule, for a blob with no `preset`: the oracle for the table below. */
function todaysFeatures(stored: Record<string, unknown>, version: number): Prefs["features"] {
  const commands = typeof stored["commands"] === "boolean" ? stored["commands"] : true;
  return {
    partners: stored["partners"] === true,
    ledger: stored["ledger"] === true,
    commands: version < 1 && !commands ? true : commands,
    // The switches added with the presets are not in an old blob, so they take Essential's value, on.
    groups: true,
    waypoints: true,
    advancedHeading: true,
    optimizer: true,
    codeTab: true,
    // Full sim reads only a stored true, else its default (issue #207): a stored false was never a choice.
    fullSim: stored["fullSim"] === true || FULL_SIM_DEFAULT,
  };
}

describe("loading zenith.ui", () => {
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
  const load = (blob: unknown): Prefs => {
    stored.set("zenith.ui", JSON.stringify(blob));
    return loadPrefs();
  };

  // The rest of a blob an existing beta user might have saved, so the table checks the whole Prefs.
  const rest = {
    theme: "light",
    snap: false,
    panelLeftW: 280,
    clipGhosts: false,
    ledgerCounts: false,
    fieldView: "vector",
    fieldStyle: "dark",
    tour: { seen: true, coreDone: true, fullDone: false },
    descriptions: "full",
  } as const;

  it("with no preset key resolves to exactly today's Prefs for every combination of the three switches", () => {
    const values: readonly unknown[] = [true, false, undefined, "junk"];
    let cases = 0;
    for (const version of [undefined, 0, PREFS_VERSION]) {
      for (const partners of values) {
        for (const ledger of values) {
          for (const commands of values) {
            const features: Record<string, unknown> = {};
            if (partners !== undefined) features["partners"] = partners;
            if (ledger !== undefined) features["ledger"] = ledger;
            if (commands !== undefined) features["commands"] = commands;
            const blob = { ...(version === undefined ? {} : { version }), ...rest, features };
            const expected: Prefs = {
              ...DEFAULT_PREFS,
              ...rest,
              features: todaysFeatures(features, version ?? 0),
              preset: ESSENTIAL_UNCHOSEN,
            };
            expect(load(blob), JSON.stringify(blob)).toEqual(expected);
            cases += 1;
          }
        }
      }
    }
    expect(cases).toBe(3 * 4 ** 3);
  });

  it("with no features key at all gives today's switches", () => {
    expect(load({ version: 1 }).features).toEqual(DEFAULT_FEATURES);
    expect(load({ version: 1, features: "yes" }).features).toEqual(DEFAULT_FEATURES);
    expect(load({ version: 1 }).preset).toEqual(ESSENTIAL_UNCHOSEN);
  });

  it("keeps every other key when one is corrupt", () => {
    const blob = { version: 1, ...rest, features: { partners: true, ledger: true, commands: false }, snap: "sideways" };
    const prefs = load(blob);
    expect(prefs.snap).toBe(true);
    expect(prefs.features).toEqual({ ...DEFAULT_FEATURES, partners: true, ledger: true, commands: false });
    expect([prefs.theme, prefs.panelLeftW, prefs.clipGhosts, prefs.fieldView, prefs.tour.seen]).toEqual(["light", 280, false, "vector", true]);
  });

  it("keeps every other key when reading one throws", () => {
    const blob = { version: 1, ...rest, features: { partners: true, ledger: false, commands: false } };
    const throwing = SETTINGS.map((entry) =>
      entry.id === "editing.snap"
        ? {
            ...entry,
            parse: () => {
              throw new Error("a damaged value");
            },
          }
        : entry,
    );
    const prefs = readPrefs(JSON.parse(JSON.stringify(blob)) as Record<string, unknown>, throwing);
    expect(prefs.snap).toBe(true);
    expect(prefs.features).toEqual({ ...DEFAULT_FEATURES, partners: true, ledger: false, commands: false });
    expect([prefs.theme, prefs.panelLeftW, prefs.clipGhosts, prefs.fieldStyle]).toEqual(["light", 280, false, "dark"]);
  });

  it("reads the person's keys binding by binding, and a damaged keys value costs nothing else", () => {
    const keys = load({ version: 1, ...rest, keys: { "run.validate": "Ctrl E", "tool.select": null, "edit.undo": 7 } });
    expect(keys.keys).toEqual({ "run.validate": "Ctrl E", "tool.select": null });
    const damaged = load({ version: 1, ...rest, keys: "Ctrl E", keysDisplacedSeen: ["later.action", 3, "later.action"] });
    expect(damaged.keys).toEqual({});
    expect(damaged.keysDisplacedSeen).toEqual(["later.action"]);
    expect([damaged.theme, damaged.snap, damaged.fieldView]).toEqual(["light", false, "vector"]);
    expect(load({ version: 1 }).keys, "no keys stored: every default").toEqual({});
  });

  it("keeps the other keys when a layout key is corrupt too", () => {
    const prefs = load({ version: 1, ...rest, panelLeftW: "wide", tour: 5, foldedGroups: { a: 1 }, ledgerH: [] });
    expect([prefs.panelLeftW, prefs.tour, prefs.foldedGroups, prefs.ledgerH]).toEqual([300, DEFAULT_PREFS.tour, [], null]);
    expect([prefs.theme, prefs.snap, prefs.fieldView]).toEqual(["light", false, "vector"]);
  });

  it("gives a setting absent from storage the recorded built-in's value", () => {
    const prefs = load({ version: 1, theme: "light", preset: { id: "full", chosen: true } });
    expect(prefs.preset).toEqual({ id: "full", chosen: true });
    for (const entry of SETTINGS.filter(isPresettable)) {
      expect(getSetting(prefs, entry.id), entry.id).toEqual(entry.presets.full);
    }
    expect(prefs.features).toEqual({ ...ALL_FEATURES, fullSim: DEFAULT_PREFS.features.fullSim });
    // A stored value still wins over the preset's, and layout keeps its own default.
    expect(load({ version: 1, preset: { id: "full", chosen: true }, features: { ledger: false } }).features.ledger).toBe(false);
    expect(load({ version: 1, preset: { id: "full", chosen: true } }).theme).toBe("dark");
  });

  it("gives a switch added with the presets the recorded preset's value, and keeps one the person set", () => {
    const basic = load({ version: 1, preset: { id: "basic", chosen: true }, features: { commands: true } });
    expect(basic.features).toEqual({ ...NO_FEATURES, commands: true, fullSim: DEFAULT_PREFS.features.fullSim });
    expect(basic.findingCodes).toBe(false);
    const kept = load({ version: 1, preset: { id: "basic", chosen: true }, features: { groups: true }, findingCodes: true });
    expect(kept.features.groups).toBe(true);
    expect(kept.features.waypoints).toBe(false);
    expect(kept.findingCodes).toBe(true);
    // No built-in sets a toolbar button, so every preset shows them all until the person hides one.
    expect(basic.toolbar).toEqual(DEFAULT_PREFS.toolbar);
    const hidden = load({ version: 1, toolbar: { run: { validate: false } } });
    expect(getSetting(hidden, "display.toolbar.run.validate")).toBe(false);
    expect(getSetting(hidden, "display.toolbar.run.save")).toBe(true);
  });

  it("saves the recorded preset with the rest, at version 1", () => {
    load({ preset: { id: "basic", chosen: true } });
    const saved = JSON.parse(stored.get("zenith.ui") ?? "{}") as { version?: number; preset?: unknown };
    expect(saved.version).toBe(1);
    expect(saved.preset).toEqual({ id: "basic", chosen: true });
    expect(PREFS_VERSION).toBe(1);
  });

  it("is the defaults when nothing is stored, or the blob is not JSON", () => {
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
    stored.set("zenith.ui", "{not json");
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
    expect(DEFAULT_PREFS.preset).toEqual(ESSENTIAL_UNCHOSEN);
  });
});
