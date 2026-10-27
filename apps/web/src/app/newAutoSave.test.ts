/**
 * Issue #157: a New auto saved into a folder goes on the project's list of autos, so the next New
 * auto takes a free name and its Save never writes over the first. New auto and an import list the
 * folder again before they choose a name, and the first save of an auto that has never been saved
 * refuses when a file of its name is already on disk.
 *
 * The folder is an in-memory stand-in for the File System Access API's directory handle, and the
 * desktop app's bridge is a stand-in over a map of paths, so both run in node.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { LocalBackend } from "../project/backend";
import { DesktopBackend } from "../project/desktop";
import type { ZenithDesktopBridge } from "../project/desktopBridge";
import { freshAutoName } from "../project/hostBackend";
import { loadProjectFromDirectory } from "../project/local";
import { clearStatus, commit, getState, isDirty, openProject } from "../state/store";
import { importFromFile } from "./importActions";
import { createAuto } from "./newAuto";
import { save } from "./projectActions";
import { moveWaypoint } from "./waypointEdits";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const read = (path: string): string => readFileSync(`${repo}${path}`, "utf8").replace(/\r\n/g, "\n");

/** The starter project's files, by their path in the repository. */
const starter = (): Record<string, string> =>
  Object.fromEntries(
    ["zenith.json", "autos/robot.json", "autos/waypoints.json", "autos/field/biobuzz.field.json", "autos/first-auto.auto.json"].map(
      (path) => [path, read(`examples/starter/${path}`)],
    ),
  );

/** A missing entry fails as the File System Access API's does, with a `NotFoundError`. */
const notFound = (message: string): Error => Object.assign(new Error(message), { name: "NotFoundError" });

/** Enough of a `FileSystemDirectoryHandle` for `local.ts`: folders, files, and listing a folder. */
class MemoryFolder {
  readonly kind = "directory";
  private readonly files = new Map<string, string>();
  private readonly folders = new Map<string, MemoryFolder>();

  constructor(readonly name: string) {}

  static of(name: string, files: Record<string, string>): MemoryFolder {
    const root = new MemoryFolder(name);
    for (const [path, text] of Object.entries(files)) root.put(path, text);
    return root;
  }

  /** Writes a file the way another program would, behind the editor's back. */
  put(path: string, text: string): void {
    const parts = path.split("/");
    const file = parts.pop() ?? "";
    let folder: MemoryFolder = this;
    for (const part of parts) {
      const next = folder.folders.get(part) ?? new MemoryFolder(part);
      folder.folders.set(part, next);
      folder = next;
    }
    folder.files.set(file, text);
  }

  text(path: string): string | undefined {
    const parts = path.split("/");
    const file = parts.pop() ?? "";
    let folder: MemoryFolder | undefined = this;
    for (const part of parts) folder = folder?.folders.get(part);
    return folder?.files.get(file);
  }

  getDirectoryHandle(name: string, options: { create?: boolean } = {}): Promise<MemoryFolder> {
    const found = this.folders.get(name);
    if (found !== undefined) return Promise.resolve(found);
    if (options.create !== true) return Promise.reject(notFound(`${name} is not a folder here`));
    const made = new MemoryFolder(name);
    this.folders.set(name, made);
    return Promise.resolve(made);
  }

  getFileHandle(name: string, options: { create?: boolean } = {}): Promise<unknown> {
    if (!this.files.has(name) && options.create !== true) return Promise.reject(notFound(`${name} is not a file here`));
    const files = this.files;
    return Promise.resolve({
      kind: "file",
      getFile: () => Promise.resolve({ text: () => Promise.resolve(files.get(name) ?? "") }),
      createWritable: () => {
        let written = "";
        return Promise.resolve({
          write: (text: string) => {
            written += text;
            return Promise.resolve();
          },
          close: () => {
            files.set(name, written);
            return Promise.resolve();
          },
        });
      },
    });
  }

  async *entries(): AsyncGenerator<[string, { kind: string }]> {
    for (const name of this.files.keys()) yield [name, { kind: "file" }];
    for (const [name, folder] of this.folders) yield [name, folder];
  }
}

/** Opens `folder` as the editor's project, the way Open folder does, on first-auto. */
async function openFolder(folder: MemoryFolder): Promise<LocalBackend> {
  const handle = folder as unknown as FileSystemDirectoryHandle;
  const backend = new LocalBackend(() => loadProjectFromDirectory(handle));
  openProject(await backend.open(), backend);
  return backend;
}

/** New auto, given `title`, then Save. Resolves with the file name it took. */
async function newAutoSaved(title: string): Promise<string> {
  await createAuto();
  const { auto, fileName } = getState();
  if (auto === null || fileName === null) throw new Error("New auto opened nothing");
  commit({ ...auto, title });
  await save();
  return fileName;
}

const titleIn = (text: string | undefined): unknown => (JSON.parse(text ?? "{}") as { title?: string }).title;

beforeEach(() => {
  clearStatus();
});

describe("freshAutoName and the files on disk", () => {
  it("skips names that only exist on disk once the listing is refreshed", async () => {
    const folder = MemoryFolder.of("robot-repo", starter());
    const backend = await openFolder(folder);
    const opened = getState().project?.autoFiles ?? [];
    // Another program, or another window, writes new-auto after the project opened.
    folder.put("autos/new-auto.auto.json", read("examples/starter/autos/first-auto.auto.json"));

    expect(freshAutoName(opened)).toBe("new-auto");
    const listed = await backend.listAutos();
    expect(listed).toEqual(["first-auto.auto.json", "new-auto.auto.json"]);
    expect(freshAutoName(listed)).toBe("new-auto-2");
  });

  it("New auto lists the folder again before it picks a name, and shows what it found", async () => {
    const folder = MemoryFolder.of("robot-repo", starter());
    await openFolder(folder);
    folder.put("autos/new-auto.auto.json", read("examples/starter/autos/first-auto.auto.json"));

    await createAuto();
    expect(getState().fileName).toBe("new-auto-2.auto.json");
    expect(getState().project?.autoFiles).toEqual(["first-auto.auto.json", "new-auto.auto.json"]);
  });

  it("an import lists the folder again before it picks a name", async () => {
    const folder = MemoryFolder.of("robot-repo", starter());
    await openFolder(folder);
    folder.put("autos/pedro-score-and-park.auto.json", read("examples/starter/autos/first-auto.auto.json"));

    const text = read("packages/import/fixtures/path/pedro-score-and-park.path.json");
    await importFromFile(new File([text], "pedro-score-and-park.path.json"));
    expect(getState().fileName).toBe("pedro-score-and-park-2.auto.json");
  });
});

describe("Save of a new auto in a folder", () => {
  it("puts it on the project's list, so three New autos are three files", async () => {
    const folder = MemoryFolder.of("robot-repo", starter());
    await openFolder(folder);

    const names = [await newAutoSaved("RedNear"), await newAutoSaved("BlueNear"), await newAutoSaved("RedFar")];
    expect(names).toEqual(["new-auto.auto.json", "new-auto-2.auto.json", "new-auto-3.auto.json"]);
    expect(titleIn(folder.text("autos/new-auto.auto.json"))).toBe("RedNear");
    expect(titleIn(folder.text("autos/new-auto-2.auto.json"))).toBe("BlueNear");
    expect(titleIn(folder.text("autos/new-auto-3.auto.json"))).toBe("RedFar");
    // In sorted order, which is what the Ctrl+O list and the palette show.
    expect(getState().project?.autoFiles).toEqual([
      "first-auto.auto.json",
      "new-auto-2.auto.json",
      "new-auto-3.auto.json",
      "new-auto.auto.json",
    ]);
    expect(getState().status).toMatchObject({ kind: "ok", message: "Saved." });
  });

  it("refuses a first save whose file is already on disk, and writes nothing", async () => {
    const folder = MemoryFolder.of("robot-repo", starter());
    await openFolder(folder);
    await createAuto();
    const { auto } = getState();
    if (auto === null) throw new Error("New auto opened nothing");
    commit({ ...auto, title: "Mine" });
    moveWaypoint("start", { xIn: -36 }, "drag");
    const theirs = '{ "written": "by someone else" }\n';
    folder.put("autos/new-auto.auto.json", theirs);
    const waypointsBefore = folder.text("autos/waypoints.json");

    await save();
    expect(folder.text("autos/new-auto.auto.json")).toBe(theirs);
    // Nothing at all: not the waypoints either, which Save writes before the auto.
    expect(folder.text("autos/waypoints.json")).toBe(waypointsBefore);
    expect(getState().status).toMatchObject({
      kind: "error",
      message:
        "robot-repo already has autos/new-auto.auto.json, so nothing was written: saving this new auto would replace it. Open that auto from the list, or use Save a copy to downloads to keep this one.",
    });
    expect(isDirty()).toBe(true);
    expect(getState().auto?.title).toBe("Mine");
    // The file that was there is on the list now, so the advice to open it can be followed.
    expect(getState().project?.autoFiles).toEqual(["first-auto.auto.json", "new-auto.auto.json"]);
  });

  it("writes a saved auto in place again without asking", async () => {
    const folder = MemoryFolder.of("robot-repo", starter());
    await openFolder(folder);
    await newAutoSaved("RedNear");
    const { auto } = getState();
    if (auto === null) throw new Error("no auto open");
    commit({ ...auto, title: "RedNear, faster" });

    await save();
    expect(getState().status).toMatchObject({ kind: "ok", message: "Saved." });
    expect(titleIn(folder.text("autos/new-auto.auto.json"))).toBe("RedNear, faster");
  });
});

/** A desktop bridge over a map of project paths, with only what opening and saving use. */
function desktopBridge(files: Map<string, string>): ZenithDesktopBridge {
  const autos = () =>
    [...files.keys()]
      .filter((path) => path.startsWith("autos/") && path.endsWith(".auto.json") && path.split("/").length === 2)
      .map((path) => path.slice("autos/".length))
      .sort((a, b) => a.localeCompare(b));
  return {
    project: {
      listAutos: () => Promise.resolve(autos()),
      read: (_root: string, path: string) => {
        const text = files.get(path);
        return text === undefined ? Promise.reject(new Error(`Could not read ${path} in this folder.`)) : Promise.resolve(text);
      },
      writeAuto: (_root: string, fileName: string, text: string) => {
        files.set(`autos/${fileName}`, text);
        return Promise.resolve();
      },
      watch: () => Promise.resolve(),
    },
  } as unknown as ZenithDesktopBridge;
}

describe("Save of a new auto in the desktop app", () => {
  async function openDesktop(files: Map<string, string>): Promise<void> {
    const backend = new DesktopBackend(desktopBridge(files), { root: "C:/robot-repo", name: "robot-repo" } as never);
    openProject(await backend.open(), backend);
  }

  it("puts it on the project's list, so the next New auto takes a free name", async () => {
    const files = new Map(Object.entries(starter()));
    await openDesktop(files);

    expect(await newAutoSaved("RedNear")).toBe("new-auto.auto.json");
    expect(getState().project?.autoFiles).toEqual(["first-auto.auto.json", "new-auto.auto.json"]);
    expect(await newAutoSaved("BlueNear")).toBe("new-auto-2.auto.json");
    expect(titleIn(files.get("autos/new-auto.auto.json"))).toBe("RedNear");
  });

  it("refuses a first save whose file is already on disk, read through the bridge", async () => {
    const files = new Map(Object.entries(starter()));
    await openDesktop(files);
    await createAuto();
    const theirs = '{ "written": "by someone else" }\n';
    files.set("autos/new-auto.auto.json", theirs);

    await save();
    expect(files.get("autos/new-auto.auto.json")).toBe(theirs);
    expect(getState().status?.kind).toBe("error");
    expect(getState().status?.message).toMatch(/^robot-repo already has autos\/new-auto\.auto\.json, so nothing was written/);
    expect(isDirty()).toBe(true);
  });
});
