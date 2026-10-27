/**
 * Preset files, `<name>.zenith-preset.json`: what Export writes, and what Import keeps of a file. An
 * import adds a preset and applies nothing, so these are the only checks between a file from anywhere
 * and a person's settings.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS } from "../state/prefs";
import {
  MAX_PRESET_FILE_BYTES,
  PRESET_FILE_KIND,
  PRESET_FILE_VERSION,
  presetFileName,
  presetFileText,
  readPresetFile,
} from "./presetFile";
import { userPresetFrom, type UserPreset } from "./presets";
import { SETTINGS, settingEntry, withSetting, type AnySettingEntry } from "./registry";

const file = (body: Record<string, unknown>): string =>
  JSON.stringify({ kind: PRESET_FILE_KIND, presetVersion: PRESET_FILE_VERSION, name: "Drive team", description: "", basedOn: "full", ...body });

const read = (text: string, taken: readonly { name: string }[] = []) => {
  const result = readPresetFile(text, taken);
  if (!result.ok) throw new Error(result.reason);
  return result;
};

describe("reading a preset file", () => {
  it("keeps the settings it knows, by registry id, and the name, description and base", () => {
    const result = read(file({ description: "For matches.", settings: { "features.partners": true, "editing.snap": false } }));
    expect(result.preset).toEqual({
      name: "Drive team",
      description: "For matches.",
      basedOn: "full",
      settings: { "features.partners": true, "editing.snap": false },
    });
    expect(result.report).toEqual({ unknown: 0, dropped: [], refused: [], keysRefused: [], ignored: [], renamed: false });
  });

  it("reports a settings or keys block that is not an object, and a base that is not a built-in, rather than dropping them silently", () => {
    for (const keys of [["Ctrl E"], "Ctrl E", 3, null]) {
      const result = read(file({ settings: { "features.ledger": true }, keys }));
      expect(result.preset).not.toHaveProperty("keys");
      expect(result.report.ignored.map((one) => one.field)).toEqual(["keys"]);
    }
    for (const settings of [[], "full", 1]) {
      const result = read(file({ settings }));
      expect(result.preset.settings).toEqual({});
      expect(result.report.ignored.map((one) => one.field)).toEqual(["settings"]);
    }
    const based = read(file({ basedOn: "turbo" }));
    expect(based.preset.basedOn).toBe("essential");
    expect(based.report.ignored.map((one) => one.field)).toEqual(["basedOn"]);
    expect(based.report.ignored[0]?.reason).toContain("Essential");
    // A file without keys, or without a base, has nothing to report.
    const plain = JSON.parse(file({ settings: {} })) as Record<string, unknown>;
    delete plain["basedOn"];
    expect(read(JSON.stringify(plain)).report.ignored).toEqual([]);
  });

  it("ignores ids no setting has and counts them", () => {
    const result = read(file({ settings: { "features.ledger": true, "features.teleport": true, "display.rainbow": "on", snap: false } }));
    expect(result.preset.settings).toEqual({ "features.ledger": true });
    expect(result.report.unknown).toBe(3);
  });

  it("drops a value of the wrong type or outside its choices, and keeps the rest", () => {
    const result = read(file({ settings: { "features.ledger": "yes", "editing.snap": 1, "features.partners": false, "display.findingCodes": null } }));
    expect(result.preset.settings).toEqual({ "features.partners": false });
    expect(result.report.dropped).toEqual(["features.ledger", "editing.snap", "display.findingCodes"]);
  });

  it("refuses robot-scope ids, which belong in robot.json, and layout, which no preset carries", () => {
    const robot = { ...settingEntry("editing.snap"), id: "robot.clearance", storage: "robotClearance", scope: "robot" } as unknown as AnySettingEntry;
    const settings: readonly AnySettingEntry[] = [...SETTINGS, robot];
    const result = readPresetFile(file({ settings: { "robot.clearance": true, "display.theme": "light", "editing.snap": false } }), [], { settings });
    if (!result.ok) throw new Error(result.reason);
    expect(result.preset.settings).toEqual({ "editing.snap": false });
    expect(result.report.refused.map((refusal) => refusal.id)).toEqual(["robot.clearance", "display.theme"]);
    expect(result.report.refused[0]?.reason).toContain("robot.json");
  });

  it("refuses a file over 64 KB before reading anything in it", () => {
    const big = file({ description: "x".repeat(MAX_PRESET_FILE_BYTES) });
    const result = readPresetFile(big, []);
    expect(result).toEqual({ ok: false, reason: "The file is larger than 64 KB, so it is not a preset file. Pick a .zenith-preset.json file made by Export." });
    expect(MAX_PRESET_FILE_BYTES).toBe(64 * 1024);
  });

  it("refuses a file that is not JSON, or not a preset file of this version", () => {
    expect(readPresetFile("{ not json", []).ok).toBe(false);
    expect(readPresetFile(JSON.stringify([1, 2]), []).ok).toBe(false);
    expect(readPresetFile(file({ kind: "zenith-auto" }), []).ok).toBe(false);
    expect(readPresetFile(file({ presetVersion: 2 }), []).ok).toBe(false);
  });

  // Like every other file error, a refusal names the file and ends with what to do (UX review, S5).
  it("names the file in every refusal, and ends with the next step", () => {
    const named = { fileName: "drive.zenith-preset.json" };
    expect(readPresetFile("", [], named)).toEqual({ ok: false, reason: "drive.zenith-preset.json is empty. Pick a .zenith-preset.json file made by Export." });
    const notJson = readPresetFile("{ not json", [], named);
    expect(notJson.ok ? "" : notJson.reason).toMatch(/^drive\.zenith-preset\.json is not valid JSON \(line 1, column \d+\)\. Pick a \.zenith-preset\.json file made by Export\.$/);
    expect(readPresetFile(file({ kind: "zenith-auto" }), [], named)).toEqual({
      ok: false,
      reason: "drive.zenith-preset.json is not a Zenith preset file. Pick a .zenith-preset.json file made by Export.",
    });
    const version = readPresetFile(file({ presetVersion: 2 }), [], { ...named, next: "Next." });
    expect(version).toEqual({ ok: false, reason: "drive.zenith-preset.json is from another version of Zenith, which this one cannot read. Next." });
  });

  it("gives a name that is taken, ignoring case, or a built-in's, the next free 'Name (2)'", () => {
    const taken = [{ name: "drive team" }, { name: "Drive team (2)" }];
    const clash = read(file({}), taken);
    expect(clash.preset.name).toBe("Drive team (3)");
    expect(clash.report.renamed).toBe(true);
    expect(read(file({}), [{ name: "Drive team" }]).preset.name).toBe("Drive team (2)");
    expect(read(file({ name: "Basic" })).preset.name).toBe("Basic (2)");
    // The suffix still fits the 40 characters a name may have.
    const long = read(file({ name: "N".repeat(40) }), [{ name: "N".repeat(40) }]).preset.name;
    expect(long).toBe(`${"N".repeat(36)} (2)`);
  });

  it("names a file with no usable name, and trims one that is too long", () => {
    expect(read(file({ name: "   " })).preset.name).toBe("Imported preset");
    expect(read(file({ name: 7 })).preset.name).toBe("Imported preset");
    expect(read(file({ name: "M".repeat(60) })).preset.name).toBe("M".repeat(40));
  });

  it("reads Essential as the base when the file names no built-in", () => {
    expect(read(file({ basedOn: "advanced" })).preset.basedOn).toBe("essential");
  });

  it("keeps the keys a person may set and lists the refused ones with the reason", () => {
    const result = read(
      file({ keys: { "run.validate": "Ctrl E", "tool.measure": null, "edit.copy": "Ctrl C", "nowhere.action": "Ctrl J", "view.play": "P" } }),
    );
    expect(result.preset.keys?.["run.validate"]).toBe("Ctrl E");
    expect(result.preset.keys?.["tool.measure"]).toBeNull();
    expect(result.report.keysRefused.map((refusal) => refusal.id)).toEqual(["edit.copy", "nowhere.action", "view.play"]);
    for (const refusal of result.report.keysRefused) expect(refusal.reason.length).toBeGreaterThan(0);
  });

  it("refuses the second of two keys in the file that overlap", () => {
    const result = read(file({ keys: { "run.validate": "Ctrl E", "run.save": "Ctrl E" } }));
    expect(result.preset.keys?.["run.validate"]).toBe("Ctrl E");
    expect(result.preset.keys?.["run.save"]).not.toBe("Ctrl E");
    expect(result.report.keysRefused.map((refusal) => refusal.id)).toEqual(["run.save"]);
  });

  it("has no keys when the file has none", () => {
    expect(read(file({})).preset.keys).toBeUndefined();
  });
});

describe("writing a preset file", () => {
  const preset: UserPreset = {
    ...userPresetFrom(withSetting(DEFAULT_PREFS, "features.partners", true), {
      id: "user:1",
      name: "Drive team",
      description: "",
      basedOn: "full",
      includeKeys: false,
    }),
  };

  it("is keyed by registry ids, with its kind and version, and no keys unless the preset has them", () => {
    const parsed = JSON.parse(presetFileText(preset)) as Record<string, unknown>;
    expect(parsed["kind"]).toBe("zenith-preset");
    expect(parsed["presetVersion"]).toBe(1);
    expect(parsed["name"]).toBe("Drive team");
    expect(parsed["basedOn"]).toBe("full");
    expect((parsed["settings"] as Record<string, unknown>)["features.partners"]).toBe(true);
    expect(parsed).not.toHaveProperty("keys");
    expect(parsed).not.toHaveProperty("id");
  });

  it("reads back as the same preset", () => {
    const withKeys: UserPreset = { ...preset, keys: { "run.validate": "Ctrl E", "tool.measure": null } };
    const back = read(presetFileText(withKeys));
    expect(back.preset).toEqual({ name: withKeys.name, description: withKeys.description, basedOn: withKeys.basedOn, settings: withKeys.settings, keys: withKeys.keys });
    expect(back.report).toEqual({ unknown: 0, dropped: [], refused: [], keysRefused: [], ignored: [], renamed: false });
  });

  it("is named after the preset, with what a file name cannot hold replaced", () => {
    expect(presetFileName("Drive team")).toBe("Drive team.zenith-preset.json");
    expect(presetFileName('a/b\\c:d*e?f"g<h>i|j')).toBe("a-b-c-d-e-f-g-h-i-j.zenith-preset.json");
    expect(presetFileName("...")).toBe("preset.zenith-preset.json");
  });
});
