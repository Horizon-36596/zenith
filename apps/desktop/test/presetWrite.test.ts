/**
 * A project's presets folder through the desktop bridge (spec 15 section 6.5, issue #484): main lists
 * only preset files in `<autosDir>/presets/`, and writes only a bare preset file name holding a preset
 * file of at most 64 KB, making the folder when it is missing, never outside the project.
 */
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listPresetFiles, writeAuto, writePresetFile } from "../src/main/project.js";
import { exampleProject, patchLink } from "./support.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function project(): string {
  const made = exampleProject();
  cleanups.push(made.cleanup);
  return made.root;
}

const PRESET = `${JSON.stringify({ kind: "zenith-preset", presetVersion: 1, name: "Drive team", description: "", basedOn: "full", settings: {} }, null, 2)}\n`;

describe("project presets on the desktop", () => {
  it("lists none until a preset is written, then only the preset files, sorted", () => {
    const root = project();
    expect(listPresetFiles(root)).toEqual([]);
    expect(writePresetFile(root, "Drive team.zenith-preset.json", PRESET)).toBe("autos/presets/Drive team.zenith-preset.json");
    expect(readFileSync(join(root, "autos", "presets", "Drive team.zenith-preset.json"), "utf8")).toBe(PRESET);
    writeFileSync(join(root, "autos", "presets", "Alpha.zenith-preset.json"), PRESET, "utf8");
    writeFileSync(join(root, "autos", "presets", "notes.md"), "", "utf8");
    writeFileSync(join(root, "autos", "presets", ".hidden.zenith-preset.json"), PRESET, "utf8");
    mkdirSync(join(root, "autos", "presets", "folder.zenith-preset.json"));
    expect(listPresetFiles(root)).toEqual(["Alpha.zenith-preset.json", "Drive team.zenith-preset.json"]);
  });

  it("writes over a preset of the same name", () => {
    const root = project();
    writePresetFile(root, "Drive team.zenith-preset.json", PRESET);
    const changed = PRESET.replace('"description": ""', '"description": "New"');
    writePresetFile(root, "Drive team.zenith-preset.json", changed);
    expect(readFileSync(join(root, "autos", "presets", "Drive team.zenith-preset.json"), "utf8")).toBe(changed);
  });

  it("refuses a name that is not a bare preset file name", () => {
    const root = project();
    for (const name of ["../zenith.zenith-preset.json", "a/b.zenith-preset.json", "a\\\\b.zenith-preset.json", ".zenith-preset.json", "robot.json", "x:y.zenith-preset.json"]) {
      expect(() => writePresetFile(root, name, PRESET), name).toThrow(/not a preset file name/);
    }
  });

  it("refuses text that is not a preset file, or is over 64 KB", () => {
    const root = project();
    expect(() => writePresetFile(root, "a.zenith-preset.json", "{ not json")).toThrow(/not valid JSON/);
    expect(() => writePresetFile(root, "a.zenith-preset.json", '{"kind":"zenith-auto"}')).toThrow(/not a Zenith preset file/);
    expect(() => writePresetFile(root, "a.zenith-preset.json", '{"kind":"zenith-preset","presetVersion":2}')).toThrow(/not a Zenith preset file/);
    expect(() => writePresetFile(root, "a.zenith-preset.json", 7)).toThrow(/not text/);
    const big = JSON.stringify({ kind: "zenith-preset", presetVersion: 1, description: "x".repeat(70 * 1024) });
    expect(() => writePresetFile(root, "a.zenith-preset.json", big)).toThrow(/64 KB/);
    expect(listPresetFiles(root)).toEqual([]);
  });

  it("never writes outside the project, through autosDir or a link", () => {
    const root = project();
    patchLink(root, (link) => {
      link["autosDir"] = "../elsewhere";
    });
    expect(() => writePresetFile(root, "a.zenith-preset.json", PRESET)).toThrow();

    const other = project();
    const outside = join(tmpdir(), `zenith-outside-${String(process.pid)}-${String(Date.now())}`);
    mkdirSync(outside, { recursive: true });
    try {
      try {
        symlinkSync(outside, join(other, "autos", "presets"), "dir");
      } catch {
        return; // A system that cannot make the link has nothing to test here.
      }
      expect(() => writePresetFile(other, "a.zenith-preset.json", PRESET)).toThrow(/outside the project/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("a file the page sent that is not JSON", () => {
  it("is refused in the web build's words, naming the file", () => {
    const root = project();
    expect(() => writePresetFile(root, "Drive team.zenith-preset.json", '{"kind": "zenith-preset",')).toThrow(
      "Drive team.zenith-preset.json is cut off: the JSON in it stops part way. Zenith did not save it.",
    );
    expect(() => writeAuto(root, "first-auto.auto.json", "")).toThrow("first-auto.auto.json is empty. Zenith did not save it.");
    expect(() => writeAuto(root, "first-auto.auto.json", "{ name: 1 }")).toThrow(/^first-auto\.auto\.json is not valid JSON( \(line 1, column \d+\))?\. Zenith did not save it\.$/);
  });
});
