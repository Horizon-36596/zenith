/**
 * Import commands from Java: read the robot's `NamedCommands` registrations out of its Java or
 * Kotlin, in the browser, and bring `robot.json` up to date (Zenith's ADR 0014).
 * The scan and the merge are `@horizon36596/zenith-import`'s, the same code `zenith import-commands`
 * runs, so the editor and the CLI always agree.
 *
 * Where the sources come from:
 * - the project folder, when it was opened with the File System Access API;
 * - the GitHub repository, in GitHub mode, one Contents API call per directory and per file;
 * - a folder or files the person picks with a plain file input, which every browser has
 *   (`webkitdirectory` for a folder; Firefox and Safari have no File System Access API).
 *
 * Applying writes `robot.json` in place in a folder opened for writing, and downloads it anywhere
 * else, then puts the new robot in the editor so its commands are offered at once.
 */
import { canonicalize } from "@horizon36596/zenith-core";
import {
  diffHunks,
  diffLines,
  isScannableSource,
  isSkippedSourcePath,
  mergeCommandScan,
  scanCommands,
  type CommandMerge,
  type CommandScan,
  type DiffLine,
  type SourceFile,
} from "@horizon36596/zenith-import";
import { javaDirsOf, parseRobot, type Robot } from "@horizon36596/zenith-schema";
import type { Project } from "../project/types";

/** Why Import commands from Java cannot run, or null when it can. */
export function importCommandsBlockedReason(state: { project: Project | null; review: unknown }): string | null {
  if (state.project === null) return "Open a project first: the commands go into its robot.json.";
  if (state.review !== null) return "Review mode is read only.";
  if (state.project.source.kind === "host") return "In host mode the robot comes from the app that opened Zenith, so change its commands there.";
  return null;
}

/** Where most FTC robot code lives, when zenith.json has no javaDir. */
const DEFAULT_SCAN_DIR = "TeamCode";

/** The folder the dialog offers first: zenith.json's first javaDir, or `TeamCode`. The person can change it before scanning. */
export const defaultScanDir = (link: { javaDir?: string | readonly string[] | undefined } | undefined): string =>
  (link === undefined ? undefined : javaDirsOf(link)[0]) ?? DEFAULT_SCAN_DIR;

/** The biggest source file read; anything larger is not hand-written robot code. */
export const MAX_SOURCE_BYTES = 1_000_000;

export interface CommandImportPlan {
  scan: CommandScan;
  merge: CommandMerge;
  /** robot.json as it is and as it would be, both canonical. */
  before: string;
  after: string;
  /** The changed lines with three lines of context; `null` where unchanged lines are left out. */
  hunks: Array<DiffLine | null>;
}

/** Scans the sources and works out the new robot.json, without writing anything. */
export function planCommandImport(robot: Robot, sources: readonly SourceFile[]): CommandImportPlan {
  const scan = scanCommands(sources);
  const merge = mergeCommandScan(robot, scan);
  const before = canonicalize("robot", robot);
  const after = canonicalize("robot", parseRobot(merge.robot));
  return { scan, merge, before, after, hunks: diffHunks(diffLines(before, after)) };
}

/** Whether a path, relative to where the scan starts, is read: `.java` or `.kt`, outside build and test directories. */
export const wantsSource = (path: string): boolean => isScannableSource(path) && !isSkippedSourcePath(path);

/** Whether a directory is walked into. */
const wantsDirectory = (path: string): boolean => !isSkippedSourcePath(`${path}/x.java`);

const join = (dir: string, name: string): string => (dir === "" ? name : `${dir}/${name}`);

/** Strips `./`, leading and trailing slashes: `./TeamCode/` is `TeamCode`, and `` or `.` is the root. */
export function normalizeDir(dir: string): string {
  return dir
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part !== "" && part !== ".")
    .join("/");
}

/**
 * The files a plain `<input type="file" webkitdirectory>` gave, as sources. Their paths start with
 * the picked folder's name; when that is the project's own folder it is dropped, so the paths read
 * as they do from the repository root.
 */
export async function sourcesFromPickedFiles(files: readonly File[], projectFolder: string | null): Promise<SourceFile[]> {
  const out: SourceFile[] = [];
  for (const file of files) {
    // A file picked one at a time has an empty relative path (and none at all outside a browser).
    let path = (file.webkitRelativePath || file.name).replace(/\\/g, "/");
    const first = path.split("/")[0] ?? "";
    if (projectFolder !== null && first === projectFolder && path.includes("/")) path = path.slice(first.length + 1);
    if (!wantsSource(path) || file.size > MAX_SOURCE_BYTES) continue;
    out.push({ path, text: await file.text() });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Every source under `dir` of a folder opened with the File System Access API. */
export async function sourcesFromDirectory(root: FileSystemDirectoryHandle, dir: string): Promise<SourceFile[]> {
  const start = normalizeDir(dir);
  let handle: FileSystemDirectoryHandle = root;
  for (const part of start === "" ? [] : start.split("/")) {
    try {
      handle = await handle.getDirectoryHandle(part);
    } catch {
      throw new Error(`There is no folder ${start} in this project.`);
    }
  }
  const out: SourceFile[] = [];
  const walk = async (current: FileSystemDirectoryHandle, path: string): Promise<void> => {
    const entries: Array<[string, FileSystemHandle]> = [];
    for await (const entry of current.entries()) entries.push(entry);
    entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    for (const [name, entry] of entries) {
      const child = join(path, name);
      if (entry.kind === "directory") {
        if (wantsDirectory(child)) await walk(entry as FileSystemDirectoryHandle, child);
      } else if (wantsSource(child)) {
        const file = await (entry as FileSystemFileHandle).getFile();
        if (file.size <= MAX_SOURCE_BYTES) out.push({ path: child, text: await file.text() });
      }
    }
  };
  await walk(handle, start);
  return out;
}

/** What `sourcesFromGitHub` needs from GitHub mode's backend. */
export interface RepositoryReader {
  listDirectory(path: string): Promise<ReadonlyArray<{ name: string; path: string; type: string }>>;
  readText(path: string): Promise<string>;
}

/** How many GitHub requests run at once while a repository is scanned. */
const GITHUB_CONCURRENCY = 4;

/**
 * Every source under `dir` of the open GitHub repository, read through the Contents API. The
 * directories are listed one level at a time and the files read a few at a time, so a big tree
 * does not wait on one request after another; the result is sorted, whatever order they finish in.
 */
export async function sourcesFromGitHub(
  reader: RepositoryReader,
  dir: string,
  onProgress?: (read: number) => void,
): Promise<SourceFile[]> {
  const files: string[] = [];
  let level = [normalizeDir(dir)];
  while (level.length > 0) {
    const listed = await inBatches(level, (path) => reader.listDirectory(path));
    const next: string[] = [];
    for (const entries of listed) {
      for (const entry of entries) {
        if (entry.type === "dir" && wantsDirectory(entry.path)) next.push(entry.path);
        else if (entry.type === "file" && wantsSource(entry.path)) files.push(entry.path);
      }
    }
    level = next.sort();
  }
  let read = 0;
  const texts = await inBatches(files, async (path) => {
    const text = await reader.readText(path);
    read += 1;
    onProgress?.(read);
    return { path, text };
  });
  return texts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** `work` over `items`, at most `GITHUB_CONCURRENCY` at a time, results in the items' order. */
async function inBatches<T, R>(items: readonly T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let nextIndex = 0;
  const lane = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      out[index] = await work(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(GITHUB_CONCURRENCY, items.length) }, lane));
  return out;
}
