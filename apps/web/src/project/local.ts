/**
 * Local mode: open a robot repository folder with the File System Access API, read the five files
 * `zenith.json` points at, and write a canonical auto back in place
 * (site/docs/github.md). Git stays the user's, in their terminal.
 *
 * Browsers without the API never reach this module; `fallback.ts` picks files individually and
 * saves by download instead.
 */
import { loadField, loadLink, loadRobot, loadWaypoints } from "@horizon36596/zenith-core";
import { NoProjectLinkError, ProjectError } from "./errors";
import { type LinkKey, loadProjectFile, missingFileMessage } from "./fileErrors";
import type { Project } from "./types";

export { NoProjectLinkError, ProjectError };

/** Splits `autos/field/biobuzz.field.json` into the directories to walk and the file at the end. */
const splitPath = (path: string): { dirs: string[]; file: string } => {
  const parts = path.split("/").filter((part) => part !== "" && part !== ".");
  const file = parts.pop();
  if (file === undefined) throw new ProjectError(`${path} is not a file path.`);
  return { dirs: parts, file };
};

/** The folder at `dirs` under `root`; with `create`, the folders that are missing are made. */
export async function directoryAt(
  root: FileSystemDirectoryHandle,
  dirs: readonly string[],
  create = false,
): Promise<FileSystemDirectoryHandle> {
  let handle = root;
  for (const dir of dirs) handle = await handle.getDirectoryHandle(dir, { create });
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

/**
 * Whether a file is at `path`. False only when the file, or a folder on the way to it, is missing;
 * any other failure (no permission, a folder of that name) is thrown, because "could not look" is
 * not "not there".
 */
export async function hasFileAt(root: FileSystemDirectoryHandle, path: string): Promise<boolean> {
  const { dirs, file } = splitPath(path);
  try {
    const directory = await directoryAt(root, dirs);
    await directory.getFileHandle(file);
    return true;
  } catch (error) {
    if ((error as { name?: unknown } | null)?.name === "NotFoundError") return false;
    throw new ProjectError(`Could not tell whether ${path} is in this folder: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function writeTextAt(
  root: FileSystemDirectoryHandle,
  path: string,
  text: string,
  options: { createDirs?: boolean } = {},
): Promise<void> {
  const { dirs, file } = splitPath(path);
  const directory = await directoryAt(root, dirs, options.createDirs === true);
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

/** The auto files in `autosDir` as the folder has them now, sorted. */
export async function listAutoFiles(
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

/**
 * The files directly in the folder at `path`, sorted; none when the folder, or one on the way to it,
 * is missing. Any other failure is thrown.
 */
export async function listFilesIn(root: FileSystemDirectoryHandle, path: string): Promise<string[]> {
  const dirs = path.split("/").filter((part) => part !== "" && part !== ".");
  let directory: FileSystemDirectoryHandle;
  try {
    directory = await directoryAt(root, dirs);
  } catch (error) {
    if ((error as { name?: unknown } | null)?.name === "NotFoundError") return [];
    throw new ProjectError(`Could not open ${path} in this folder: ${error instanceof Error ? error.message : String(error)}`);
  }
  const names: string[] = [];
  for await (const [name, handle] of directory.entries()) {
    if (handle.kind === "file") names.push(name);
  }
  return names.sort((a, b) => a.localeCompare(b));
}

/** Whether the folder lists an entry called `name`. A folder that cannot be listed is not known to lack it. */
async function hasEntry(handle: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    for await (const [entry] of handle.entries()) if (entry === name) return true;
    return false;
  } catch {
    return true;
  }
}

/**
 * `zenith.json` at the top of the folder. A folder without one throws `NoProjectLinkError`, so Open
 * folder can offer to set Zenith up there (issue #159); one that has it but cannot read it still
 * says it could not be read.
 */
async function readLinkText(handle: FileSystemDirectoryHandle): Promise<string> {
  try {
    return await readTextAt(handle, "zenith.json");
  } catch (error) {
    if (!(await hasEntry(handle, "zenith.json"))) throw new NoProjectLinkError(handle.name);
    throw error;
  }
}

/**
 * Reads `zenith.json` and everything it points at. A file that is not valid JSON, or does not load,
 * is named with what is wrong and what to do; a file `zenith.json` names that is not in the folder
 * says which key names it.
 */
export async function loadProjectFromDirectory(
  handle: FileSystemDirectoryHandle,
): Promise<Project> {
  const link = loadProjectFile("link", "zenith.json", await readLinkText(handle), loadLink);
  const read = async (key: LinkKey, path: string): Promise<string> => {
    try {
      return await readTextAt(handle, path);
    } catch (error) {
      const there = await hasFileAt(handle, path).catch(() => true);
      if (!there) throw new ProjectError(missingFileMessage(path, key));
      throw error;
    }
  };
  const robot = loadProjectFile("robot", link.robot, await read("robot", link.robot), loadRobot);
  const field = loadProjectFile("field", link.field, await read("field", link.field), loadField);
  const waypoints =
    link.waypoints === undefined
      ? undefined
      : loadProjectFile("waypoints", link.waypoints, await read("waypoints", link.waypoints), loadWaypoints);
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
