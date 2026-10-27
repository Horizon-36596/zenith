/**
 * Project presets (issue #484): where a project keeps
 * them, how its files are read (each as an import reads one, at most 20, a bad file listed and the
 * rest kept), how a person's copy is linked to its file and matched against it, and which projects
 * Add to project can write into.
 */
import { describe, expect, it } from "vitest";
import { isPresetFileName, projectPresetPath, projectPresetsDir } from "../project/presetPaths";
import type { ProjectSource } from "../project/types";
import { presetFileText, type PresetFilePreset } from "./presetFile";
import type { UserPreset } from "./presets";
import { MAX_PROJECT_PRESETS, linkedCopy, matchesFile, projectPresetsReadOnlyReason, readProjectPresets } from "./projectPresets";

const CONTEXT = { desktop: false };

const filePreset = (name: string, settings: PresetFilePreset["settings"] = { "features.ledger": true }): PresetFilePreset => ({
  name,
  description: "",
  basedOn: "full",
  settings,
});

/** A read function over a folder held in a map, which fails for a name it does not have. */
const folder = (files: Record<string, string>) => async (file: string) => {
  const text = files[file];
  if (text === undefined) throw new Error(`no file ${file}`);
  return text;
};

describe("where a project keeps its presets", () => {
  it("is the presets folder inside autosDir, however autosDir is spelled", () => {
    expect(projectPresetsDir({ autosDir: "autos" })).toBe("autos/presets");
    expect(projectPresetsDir({ autosDir: "./autos/" })).toBe("autos/presets");
    expect(projectPresetsDir({ autosDir: "TeamCode/autos" })).toBe("TeamCode/autos/presets");
    expect(projectPresetsDir({ autosDir: "." })).toBe("presets");
    expect(projectPresetPath({ autosDir: "autos" }, "Drive team.zenith-preset.json")).toBe("autos/presets/Drive team.zenith-preset.json");
  });

  it("holds only bare, visible *.zenith-preset.json names", () => {
    expect(isPresetFileName("Drive team.zenith-preset.json")).toBe(true);
    expect(isPresetFileName(".zenith-preset.json")).toBe(false);
    expect(isPresetFileName(".hidden.zenith-preset.json")).toBe(false);
    expect(isPresetFileName("notes.json")).toBe(false);
    expect(isPresetFileName("a/b.zenith-preset.json")).toBe(false);
    expect(isPresetFileName("a\\b.zenith-preset.json")).toBe(false);
  });
});

describe("reading a project's presets", () => {
  it("reads each preset file in name order and leaves other files alone", async () => {
    const list = await readProjectPresets(
      ["b.zenith-preset.json", "README.md", "a.zenith-preset.json"],
      folder({ "a.zenith-preset.json": presetFileText(filePreset("Alpha")), "b.zenith-preset.json": presetFileText(filePreset("Bravo")) }),
      CONTEXT,
    );
    expect(list.presets.map((one) => [one.file, one.preset.name])).toEqual([
      ["a.zenith-preset.json", "Alpha"],
      ["b.zenith-preset.json", "Bravo"],
    ]);
    expect(list.presets[0]?.preset.settings).toEqual({ "features.ledger": true });
    expect(list.problems).toEqual([]);
    expect(list.more).toBe(0);
  });

  it("lists a file it cannot read, or that is not a preset, and keeps the rest", async () => {
    const list = await readProjectPresets(
      ["bad.zenith-preset.json", "gone.zenith-preset.json", "good.zenith-preset.json"],
      folder({ "bad.zenith-preset.json": "{ not json", "good.zenith-preset.json": presetFileText(filePreset("Good")) }),
      CONTEXT,
    );
    expect(list.presets.map((one) => one.preset.name)).toEqual(["Good"]);
    expect(list.problems).toEqual([
      { file: "bad.zenith-preset.json", reason: expect.stringMatching(/^The file is not valid JSON \(line 1, column \d+\)\. Fix it, or restore it from git\.$/) as string },
      { file: "gone.zenith-preset.json", reason: "It could not be read: no file gone.zenith-preset.json" },
    ]);
  });

  it("checks each file as an import does: a robot's id and a layout id are refused", async () => {
    const text = presetFileText({ ...filePreset("Team"), settings: { "features.ledger": true, "display.theme": "light" } as never });
    const list = await readProjectPresets(["t.zenith-preset.json"], folder({ "t.zenith-preset.json": text }), CONTEXT);
    expect(list.presets[0]?.preset.settings).toEqual({ "features.ledger": true });
    expect(list.presets[0]?.report.refused.map((one) => one.id)).toEqual(["display.theme"]);
  });

  it("gives two files with one name 'Name' and 'Name (2)'", async () => {
    const text = presetFileText(filePreset("Team"));
    const list = await readProjectPresets(["a.zenith-preset.json", "b.zenith-preset.json"], folder({ "a.zenith-preset.json": text, "b.zenith-preset.json": text }), CONTEXT);
    expect(list.presets.map((one) => one.preset.name)).toEqual(["Team", "Team (2)"]);
  });

  it(`reads at most ${String(MAX_PROJECT_PRESETS)} files and counts the rest`, async () => {
    const names = Array.from({ length: MAX_PROJECT_PRESETS + 3 }, (_, n) => `p${String(n).padStart(2, "0")}.zenith-preset.json`);
    const files = Object.fromEntries(names.map((name, n) => [name, presetFileText(filePreset(`P${String(n)}`))]));
    const list = await readProjectPresets(names, folder(files), CONTEXT);
    expect(list.presets).toHaveLength(MAX_PROJECT_PRESETS);
    expect(list.more).toBe(3);
  });
});

describe("a person's copy of a project preset", () => {
  const copy = (over: Partial<UserPreset> = {}): UserPreset => ({
    id: "user:copy",
    name: "My name for it",
    description: "",
    basedOn: "full",
    settings: { "features.ledger": true },
    fromProject: { project: "folder:robot", file: "team.zenith-preset.json" },
    ...over,
  });

  it("is found by the project's key and the file's name", () => {
    const list = [copy(), copy({ id: "user:other", name: "Other", fromProject: { project: "folder:else", file: "team.zenith-preset.json" } })];
    expect(linkedCopy(list, "folder:robot", "team.zenith-preset.json")?.id).toBe("user:copy");
    expect(linkedCopy(list, "folder:robot", "else.zenith-preset.json")).toBeUndefined();
  });

  it("matches the file when it sets the same, whatever it is called", () => {
    expect(matchesFile(copy(), filePreset("Team"))).toBe(true);
    expect(matchesFile(copy(), filePreset("Team", { "features.ledger": false }))).toBe(false);
    expect(matchesFile(copy({ basedOn: "basic" }), filePreset("Team"))).toBe(false);
    expect(matchesFile(copy({ keys: { "run.validate": "Ctrl E" } }), filePreset("Team"))).toBe(false);
    expect(matchesFile(copy({ description: "For drivers" }), filePreset("Team"))).toBe(false);
  });
});

describe("which projects Add to project writes into", () => {
  const source = (kind: ProjectSource["kind"]): ProjectSource =>
    ({ kind, handle: {}, root: "/r", hostId: "h", owner: "o", repo: "r", base: "main", branch: "b", login: "l" }) as unknown as ProjectSource;

  it("writes into a folder in the browser or the desktop app, and says why everywhere else", () => {
    expect(projectPresetsReadOnlyReason(source("directory"), true)).toBeNull();
    expect(projectPresetsReadOnlyReason(source("desktop"), true)).toBeNull();
    expect(projectPresetsReadOnlyReason(source("desktop"), false)).toMatch(/version of the desktop app/);
    expect(projectPresetsReadOnlyReason(source("example"), true)).toMatch(/example project is read only/);
    expect(projectPresetsReadOnlyReason(source("files"), true)).toMatch(/one at a time/);
    expect(projectPresetsReadOnlyReason(source("github"), true)).toMatch(/Export the preset and commit it/);
    expect(projectPresetsReadOnlyReason(source("host"), true)).toMatch(/owns its project/);
  });
});
