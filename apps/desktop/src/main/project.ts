/**
 * Reading and writing a robot repository for the desktop backend
 * (apps/web/src/project/desktop.ts): open, list the autos, read any file, write an auto in place,
 * and watch for edits made outside Zenith.
 *
 * Every function takes a root the caller has already checked with `RootRegistry.assert`, and every
 * path goes through `confineRelative`, so nothing here can read or write outside the repository.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, renameSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { DesktopFileChange, DesktopProjectRef } from "../../../web/src/project/desktopBridge.js";
import { loadProject, type Project } from "./cli.js";
import { BridgeError, assertAutoFileName, confineRelative } from "./confine.js";

/** Large enough for any real auto, small enough that a runaway renderer cannot fill the disk. */
const MAX_AUTO_BYTES = 4 * 1024 * 1024;

const slash = (path: string): string => path.split("\\").join("/");

/** Loads `zenith.json` and what it names, turning the CLI's errors into ones worth showing. */
export function loadDesktopProject(root: string): Project {
  if (!existsSync(join(root, "zenith.json"))) {
    throw new BridgeError(
      `${basename(root)} has no zenith.json, so it is not a robot repository Zenith can open. Pick the folder that has zenith.json at its top.`,
    );
  }
  try {
    return loadProject(root, root);
  } catch (error) {
    throw new BridgeError(error instanceof Error ? error.message : String(error));
  }
}

export function describeProject(root: string): DesktopProjectRef {
  loadDesktopProject(root);
  return { root, name: basename(root) };
}

export function listAutos(root: string): string[] {
  const project = loadDesktopProject(root);
  const dir = confineRelative(root, project.link.autosDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".auto.json"))
    .sort((a, b) => a.localeCompare(b));
}

export function readProjectFile(root: string, path: string): string {
  const full = confineRelative(root, path);
  try {
    return readFileSync(full, "utf8");
  } catch {
    throw new BridgeError(`Could not read ${path} in this folder.`);
  }
}

/** The project-relative path an auto file name lives at, e.g. `autos/first-auto.auto.json`. */
export function autoRelPath(project: Project, fileName: string): string {
  return `${slash(project.link.autosDir).replace(/\/+$/, "")}/${assertAutoFileName(fileName)}`;
}

/**
 * Writes one auto in place. The text must be JSON (the web app always sends canonical text, so
 * anything else is a bug or a hostile renderer). Written to a temporary file beside the target and
 * renamed over it, so a crash mid-write never leaves half a file.
 */
export function writeAuto(root: string, fileName: string, text: unknown): string {
  if (typeof text !== "string" || text.length > MAX_AUTO_BYTES) {
    throw new BridgeError("That auto is not text Zenith can save.");
  }
  try {
    JSON.parse(text);
  } catch {
    throw new BridgeError("That auto is not valid JSON, so it was not saved.");
  }
  const project = loadDesktopProject(root);
  const rel = autoRelPath(project, fileName);
  const full = confineRelative(root, rel);
  if (!existsSync(dirname(full))) {
    throw new BridgeError(`The autos folder ${project.link.autosDir} does not exist in this repository.`);
  }
  const temp = `${full}.zenith-${String(process.pid)}.tmp`;
  writeFileSync(temp, text, "utf8");
  renameSync(temp, full);
  return rel;
}

/* ---- Watching ------------------------------------------------------------ */

export const hashText = (text: string | null): string =>
  text === null ? "missing" : createHash("sha256").update(text).digest("hex");

/** The project files whose change the editor cares about: the link file, what it names, the autos. */
export function relevantPaths(project: Project): (rel: string) => boolean {
  const fixed = new Set(
    ["zenith.json", project.link.robot, project.link.field, project.link.waypoints]
      .filter((path): path is string => path !== undefined)
      .map((path) => slash(path).replace(/^\.\//, "")),
  );
  const autosDir = slash(project.link.autosDir).replace(/^\.\//, "").replace(/\/+$/, "");
  return (rel: string) => {
    if (fixed.has(rel)) return true;
    return dirname(rel) === autosDir && rel.endsWith(".auto.json");
  };
}

export interface WatchDeps {
  watchImpl?: (root: string, listener: (eventType: string, filename: string | null) => void) => FSWatcher;
  readImpl?: (full: string) => string | null;
  debounceMs?: number;
}

const readOrNull = (full: string): string | null => {
  try {
    return statSync(full).isFile() ? readFileSync(full, "utf8") : null;
  } catch {
    return null;
  }
};

/**
 * Watches one project at a time and reports a file only when its bytes differ from the last bytes
 * Zenith itself read or wrote. That is how Zenith's own saves are ignored without any timing
 * window: the save records the text it wrote, the watcher sees the same text, and stays quiet.
 * Events are debounced per file, because editors and git write a file in several steps.
 */
export class ProjectWatcher {
  private watcher: FSWatcher | null = null;
  private root: string | null = null;
  private relevant: (rel: string) => boolean = () => false;
  private readonly known = new Map<string, string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly watchImpl: NonNullable<WatchDeps["watchImpl"]>;
  private readonly readImpl: NonNullable<WatchDeps["readImpl"]>;
  private readonly debounceMs: number;

  constructor(
    private readonly emit: (change: DesktopFileChange) => void,
    deps: WatchDeps = {},
  ) {
    this.watchImpl = deps.watchImpl ?? ((root, listener) => watch(root, { recursive: true }, listener));
    this.readImpl = deps.readImpl ?? readOrNull;
    this.debounceMs = deps.debounceMs ?? 250;
  }

  watch(root: string, project: Project): void {
    this.close();
    this.root = root;
    this.relevant = relevantPaths(project);
    this.watcher = this.watchImpl(root, (_eventType, filename) => {
      if (filename === null) return;
      this.onEvent(slash(filename));
    });
    this.watcher.on("error", () => {
      // A watch that dies (the folder was deleted or unmounted) just stops reporting; the next open
      // starts a fresh one.
      this.close();
    });
  }

  /** Records text Zenith read or wrote, so the watcher does not report it back as an external edit. */
  note(root: string, rel: string, text: string | null): void {
    if (this.root === null || root !== this.root) return;
    this.known.set(slash(rel), hashText(text));
  }

  close(): void {
    this.watcher?.close();
    this.watcher = null;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.known.clear();
    this.root = null;
  }

  private onEvent(rel: string): void {
    if (this.root === null || !this.relevant(rel)) return;
    const existing = this.timers.get(rel);
    if (existing !== undefined) clearTimeout(existing);
    this.timers.set(
      rel,
      setTimeout(() => {
        this.timers.delete(rel);
        this.settle(rel);
      }, this.debounceMs),
    );
  }

  private settle(rel: string): void {
    const root = this.root;
    if (root === null) return;
    const hash = hashText(this.readImpl(join(root, rel)));
    if (this.known.get(rel) === hash) return;
    this.known.set(rel, hash);
    if (rel === "zenith.json") {
      // The link file names the other files, so what counts as relevant may have changed with it.
      try {
        this.relevant = relevantPaths(loadDesktopProject(root));
      } catch {
        // A half-written zenith.json keeps the old list until it parses again.
      }
    }
    this.emit({ root, path: rel });
  }
}
