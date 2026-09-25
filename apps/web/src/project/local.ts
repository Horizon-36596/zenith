/**
 * Local mode: open a robot repository folder with the File System Access API, read the five files
 * `zenith.json` points at, and write a canonical auto back in place
 * (site/docs/github.md). Git stays the user's, in their terminal.
 *
 * Browsers without the API never reach this module; `fallback.ts` picks files individually and
 * saves by download instead.
 */
import { loadField, loadLink, loadRobot, loadWaypoints } from "@horizon36596/zenith-core";
import type { Project } from "./types";

export class ProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectError";
  }
}

/** Splits `autos/field/biobuzz.field.json` into the directories to walk and the file at the end. */
const splitPath = (path: string): { dirs: string[]; file: string } => {
  const parts = path.split("/").filter((part) => part !== "" && part !== ".");
  const file = parts.pop();
  if (file === undefined) throw new ProjectError(`${path} is not a file path.`);
  return { dirs: parts, file };
};

async function directoryAt(
  root: FileSystemDirectoryHandle,
  dirs: readonly string[],
): Promise<FileSystemDirectoryHandle> {
  let handle = root;
  for (const dir of dirs) handle = await handle.getDirectoryHandle(dir);
  return handle;
}

export async function readTextAt(
  root: FileSystemDirectoryHandle,
  path: string,
): Promise<string> {
  const { dirs, file } = splitPath(path);
  try {
    const directory = await directoryAt(root, dirs);
    const handle = await directory.getFileHandle(file);
    return await (await handle.getFile()).text();
  } catch {
    throw new ProjectError(`Could not read ${path} in this folder.`);
  }
}

export async function writeTextAt(
  root: FileSystemDirectoryHandle,
  path: string,
  text: string,
): Promise<void> {
  const { dirs, file } = splitPath(path);
  const directory = await directoryAt(root, dirs);
  const handle = await directory.getFileHandle(file, { create: true });
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
}

/** Asks for read-write permission on a handle restored from IndexedDB. */
export async function ensureWritable(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const options = { mode: "readwrite" } as const;
  const current = (await handle.queryPermission?.(options)) ?? "granted";
  if (current === "granted") return true;
  const asked = (await handle.requestPermission?.(options)) ?? "denied";
  return asked === "granted";
}

/** Shows the folder picker. Returns null when the user cancels. */
export async function pickDirectory(): Promise<FileSystemDirectoryHandle | null> {
  const picker = window.showDirectoryPicker;
  if (picker === undefined) {
    throw new ProjectError("This browser has no folder picker. Pick the files individually instead.");
  }
  try {
    return await picker.call(window, { id: "zenith-project", mode: "readwrite" });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return null;
    throw error;
  }
}

async function listAutoFiles(
  root: FileSystemDirectoryHandle,
  autosDir: string,
): Promise<string[]> {
  const dirs = autosDir.split("/").filter((part) => part !== "" && part !== ".");
  const directory = await directoryAt(root, dirs);
  const names: string[] = [];
  for await (const [name, handle] of directory.entries()) {
    if (handle.kind === "file" && name.endsWith(".auto.json")) names.push(name);
  }
  return names.sort((a, b) => a.localeCompare(b));
}

/** Reads `zenith.json` and everything it points at. */
export async function loadProjectFromDirectory(
  handle: FileSystemDirectoryHandle,
): Promise<Project> {
  const link = loadLink(JSON.parse(await readTextAt(handle, "zenith.json")));
  const robot = loadRobot(JSON.parse(await readTextAt(handle, link.robot)));
  const field = loadField(JSON.parse(await readTextAt(handle, link.field)));
  const waypoints =
    link.waypoints === undefined
      ? undefined
      : loadWaypoints(JSON.parse(await readTextAt(handle, link.waypoints)));
  const autoFiles = await listAutoFiles(handle, link.autosDir);
  return {
    source: { kind: "directory", handle },
    name: handle.name,
    link,
    robot,
    field,
    waypoints,
    autoFiles,
    autoTexts: {},
  };
}

/** The path of one auto file inside the project, as `zenith.json` lays the repository out. */
export const autoPath = (project: Project, fileName: string): string =>
  `${project.link.autosDir}/${fileName}`;
