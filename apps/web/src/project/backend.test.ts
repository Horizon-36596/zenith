/**
 * The local backend reads what the shell asks for and refuses what it cannot do, so that the shell
 * itself never has to know which of the three local sources it is talking to. The writing paths
 * (a folder handle, a download) belong to the browser and are covered by the Playwright smoke.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalize, loadField, loadLink, loadRobot, loadWaypoints } from "@horizon36596/zenith-core";
import { FORMAT_VERSIONS } from "@horizon36596/zenith-schema";
import { LocalBackend } from "./backend";
import type { Project } from "./types";

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../examples/starter/${path}`, import.meta.url)), "utf8");

/** The bundled example, assembled the way `example.ts` assembles it from Vite's `?raw` imports. */
function exampleProject(): Project {
  const collectText = read("autos/collect-and-score.auto.json");
  const firstText = read("autos/first-auto.auto.json");
  return {
    source: { kind: "files" },
    name: "examples/starter",
    link: loadLink(JSON.parse(read("zenith.json"))),
    robot: loadRobot(JSON.parse(read("autos/robot.json"))),
    field: loadField(JSON.parse(read("autos/field/biobuzz.field.json"))),
    waypoints: loadWaypoints(JSON.parse(read("autos/waypoints.json"))),
    autoFiles: ["collect-and-score.auto.json", "first-auto.auto.json"],
    autoTexts: { "collect-and-score.auto.json": collectText, "first-auto.auto.json": firstText },
  };
}

describe("LocalBackend", () => {
  it("opens a project and lists the autos beside it", async () => {
    const backend = LocalBackend.of(exampleProject());
    const project = await backend.open();

    expect(backend.kind).toBe("local");
    expect(project.link.autosDir).toBe("autos");
    expect(await backend.listAutos()).toEqual(["collect-and-score.auto.json", "first-auto.auto.json"]);
  });

  it("reads an auto as the canonical text the editor compares against", async () => {
    const backend = LocalBackend.of(exampleProject());
    await backend.open();

    const loaded = await backend.readAuto("first-auto.auto.json");
    expect(loaded.fileName).toBe("first-auto.auto.json");
    expect(loaded.auto.name).toBe("first-auto");
    expect(loaded.canonical).toBe(canonicalize("auto", loaded.auto));
  });

  it("says which older format an auto was written in, and nothing for a current one (A20)", async () => {
    const old = readFileSync(
      fileURLToPath(new URL("../../../../packages/schema/fixtures/migrate/auto.v2.json", import.meta.url)),
      "utf8",
    );
    const project = exampleProject();
    project.autoFiles = [...project.autoFiles, "old.auto.json"];
    project.autoTexts["old.auto.json"] = old;
    const backend = LocalBackend.of(project);
    await backend.open();

    const loaded = await backend.readAuto("old.auto.json");
    expect(loaded.fromFormatVersion).toBe(2);
    expect(loaded.canonical).toContain(`"formatVersion": ${String(FORMAT_VERSIONS.auto)}`);
    expect((await backend.readAuto("first-auto.auto.json")).fromFormatVersion).toBeUndefined();
  });

  it("cannot propose, which is GitHub mode's alone", () => {
    expect(LocalBackend.of(exampleProject()).canPropose).toBe(false);
  });

  it("refuses to read before it has been opened, rather than returning half a project", async () => {
    const backend = LocalBackend.of(exampleProject());
    await expect(backend.listAutos()).rejects.toThrow(/not been opened/);
  });

  it("says which auto it does not have rather than failing on undefined", async () => {
    const backend = LocalBackend.of(exampleProject());
    await backend.open();
    await expect(backend.readAuto("nope.auto.json")).rejects.toThrow(/nope\.auto\.json/);
  });

  /**
   * Issue #380 finding 3: the first save's collision check must not take a file it cannot read for
   * a file that is not there, or Save writes over it.
   */
  describe("hasAuto in a folder", () => {
    const failure = (name: string): Error => Object.assign(new Error(name), { name });
    /** A folder handle whose autos folder holds `first-auto.auto.json`, and whose file lookups fail with `lookup`. */
    function folderProject(lookup: (file: string) => Promise<unknown>): Project {
      const autos = { getFileHandle: lookup };
      const handle = {
        name: "repo",
        getDirectoryHandle: (dir: string) => (dir === "autos" ? Promise.resolve(autos) : Promise.reject(failure("NotFoundError"))),
      } as unknown as FileSystemDirectoryHandle;
      return { ...exampleProject(), source: { kind: "directory", handle } };
    }

    it("is true for a file that is there and false only for one that is missing", async () => {
      const backend = LocalBackend.of(
        folderProject((file) => (file === "first-auto.auto.json" ? Promise.resolve({}) : Promise.reject(failure("NotFoundError")))),
      );
      await backend.open();
      expect(await backend.hasAuto("first-auto.auto.json")).toBe(true);
      expect(await backend.hasAuto("new.auto.json")).toBe(false);
    });

    it("throws, rather than saying not there, when the folder cannot be read", async () => {
      const backend = LocalBackend.of(folderProject(() => Promise.reject(failure("NotAllowedError"))));
      await backend.open();
      await expect(backend.hasAuto("first-auto.auto.json")).rejects.toThrow(/Could not tell whether autos\/first-auto\.auto\.json/);
    });
  });

  /** A project's presets folder (spec 15 section 6.5, issue #484): listed and written in a folder, none elsewhere. */
  describe("preset files", () => {
    const notFound = (what: string): Error => Object.assign(new Error(`${what} is not here`), { name: "NotFoundError" });
    /** Enough of a folder handle for listing, reading and writing: nested folders of text files. */
    function memoryFolder(files: Map<string, string>, prefix = ""): unknown {
      const under = (name: string) => `${prefix}${name}`;
      return {
        name: prefix === "" ? "repo" : prefix,
        getDirectoryHandle: (dir: string, options: { create?: boolean } = {}) => {
          const path = `${under(dir)}/`;
          const exists = [...files.keys()].some((key) => key.startsWith(path));
          if (!exists && options.create !== true) return Promise.reject(notFound(dir));
          return Promise.resolve(memoryFolder(files, path));
        },
        getFileHandle: (file: string, options: { create?: boolean } = {}) => {
          if (!files.has(under(file)) && options.create !== true) return Promise.reject(notFound(file));
          return Promise.resolve({
            getFile: () => Promise.resolve({ text: () => Promise.resolve(files.get(under(file)) ?? "") }),
            createWritable: () =>
              Promise.resolve({
                write: (text: string) => {
                  files.set(under(file), text);
                  return Promise.resolve();
                },
                close: () => Promise.resolve(),
              }),
          });
        },
        async *entries(): AsyncGenerator<[string, { kind: string }]> {
          const seen = new Set<string>();
          for (const key of files.keys()) {
            if (!key.startsWith(prefix)) continue;
            const rest = key.slice(prefix.length);
            const [first = "", ...more] = rest.split("/");
            if (seen.has(first)) continue;
            seen.add(first);
            yield [first, { kind: more.length === 0 ? "file" : "directory" }];
          }
        },
      };
    }
    const inFolder = (files: Map<string, string>): Project => ({
      ...exampleProject(),
      source: { kind: "directory", handle: memoryFolder(files) as FileSystemDirectoryHandle },
    });

    it("lists only the preset files in autos/presets, sorted, and none when the folder is missing", async () => {
      const files = new Map<string, string>([["autos/first-auto.auto.json", "{}"]]);
      const backend = LocalBackend.of(inFolder(files));
      await backend.open();
      expect(await backend.listPresetFiles()).toEqual([]);
      files.set("autos/presets/b.zenith-preset.json", "{}");
      files.set("autos/presets/a.zenith-preset.json", "{}");
      files.set("autos/presets/notes.md", "");
      files.set("autos/presets/old/c.zenith-preset.json", "{}");
      expect(await backend.listPresetFiles()).toEqual(["a.zenith-preset.json", "b.zenith-preset.json"]);
    });

    it("writes a preset file into autos/presets, making the folder, and refuses a name that is not one", async () => {
      const files = new Map<string, string>([["autos/first-auto.auto.json", "{}"]]);
      const backend = LocalBackend.of(inFolder(files));
      await backend.open();
      await backend.writePresetFile("Drive team.zenith-preset.json", '{"kind":"zenith-preset"}\n');
      expect(files.get("autos/presets/Drive team.zenith-preset.json")).toBe('{"kind":"zenith-preset"}\n');
      await expect(backend.writePresetFile("../zenith.zenith-preset.json", "{}")).rejects.toThrow(/not a preset file name/);
      await expect(backend.writePresetFile("robot.json", "{}")).rejects.toThrow(/not a preset file name/);
    });

    it("has none, and writes none, for picked files", async () => {
      const backend = LocalBackend.of(exampleProject());
      await backend.open();
      expect(await backend.listPresetFiles()).toEqual([]);
      await expect(backend.writePresetFile("a.zenith-preset.json", "{}")).rejects.toThrow(/read only/);
    });
  });

  it("refuses an arbitrary path when the source is picked files, which have no folder", async () => {
    const backend = LocalBackend.of(exampleProject());
    await backend.open();
    await expect(backend.readText("autos/robot.json")).rejects.toThrow(/only has the files/);
  });
});
