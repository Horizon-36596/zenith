/**
 * Reading and writing a robot repository for the desktop backend
 * (apps/web/src/project/desktop.ts): open, list the autos, read any file, write an auto in place,
 * and watch for edits made outside Zenith.
 *
 * Every function takes a root the caller has already checked with `RootRegistry.assert`, and every
 * path goes through `confineRelative`, so nothing here can read or write outside the repository.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { DesktopFileChange, DesktopProjectRef } from "../../../web/src/project/desktopBridge.js";
import { canonicalize, loadLink, loadRobot, loadWaypoints } from "@horizon36596/zenith-core";
import { unreadableJsonMessage } from "../../../web/src/project/fileErrors.js";
import { loadProject, type Project } from "./cli.js";
import { BridgeError, assertAutoFileName, assertPresetFileName, confineRelative } from "./confine.js";

/** Large enough for any real auto, small enough that a runaway renderer cannot fill the disk. */
const MAX_AUTO_BYTES = 4 * 1024 * 1024;

/**
 * The folder inside `autosDir` that holds a project's presets, and the largest preset file written,
 * as the web app's `project/presetPaths.ts` and `settings/presetFile.ts` have them (spec 15 sections
 * 6.4 and 6.5). SET BY HAND there: 64 KB is many times a full preset with every key bound.
 */
const PRESETS_DIR = "presets";
const MAX_PRESET_BYTES = 64 * 1024;

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

/**
 * Whether an auto of this name is in the autos folder now: the first-save check, so a new auto's
 * Save never replaces a file that is there (issue #380). Case is ignored, because Windows and macOS
 * disks ignore it and a write of `first.auto.json` would replace `First.auto.json`. Only `zenith.json`
 * and the folder listing are read, so a robot or field file that does not load cannot refuse it. A
 * missing autos folder holds no autos; any other failure to list it is thrown, never taken as "no".
 */
export function hasAutoFile(root: string, fileName: unknown): boolean {
  const wanted = assertAutoFileName(fileName).toLowerCase();
  const full = confineRelative(root, "zenith.json");
  let autosDir: string;
  try {
    autosDir = loadLink(JSON.parse(readFileSync(full, "utf8"))).autosDir;
  } catch (error) {
    throw new BridgeError(`Could not read this project's zenith.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  const dir = confineRelative(root, autosDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return false;
    throw new BridgeError(`Could not list the autos folder ${autosDir} in this repository.`);
  }
  return names.some((name) => name.toLowerCase() === wanted);
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
 * Writes `text` to `full` through a temporary file beside it, renamed over the target, so a crash
 * mid-write never leaves half a file. The temporary name is random and the file is opened with
 * exclusive create (`wx`), so a file or a link already at that name, which a cloned repository can
 * hold under any name, is never written through: the open fails instead (issue #406). The rename
 * replaces a link at `full` rather than following it, and `full` itself was confined by the caller.
 */
export function writeReplacing(full: string, text: string): void {
  const temp = `${full}.zenith-${randomBytes(8).toString("hex")}.tmp`;
  let created = false;
  try {
    writeFileSync(temp, text, { encoding: "utf8", flag: "wx" });
    created = true;
    renameSync(temp, full);
  } catch (error) {
    // Only a temporary file this call made is removed; whatever was already at the name stays.
    if (created) rmSync(temp, { force: true });
    throw writeFailure(full, error);
  }
}

/**
 * A failed write worded for the person: which file, what is likely wrong and what to do. The raw
 * error goes to stderr, where a bug report starts, so nothing is lost by not showing it.
 */
export function writeFailure(full: string, error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  const name = basename(full);
  const why =
    code === "EPERM" || code === "EACCES"
      ? "it is read only, or another program has it open. Close it there or make it writable, then save again."
      : code === "EBUSY"
        ? "another program has it open. Close it there, then save again."
        : code === "ENOENT"
          ? "its folder is gone. Check that the robot repository is still where it was, then save again."
          : code === "ENOSPC"
            ? "the disk is full. Free some space, then save again."
            : null;
  if (why === null) return error;
  console.error(`Zenith: could not write ${full} (${error instanceof Error ? error.message : String(error)}).`);
  return new BridgeError(`${name} could not be saved: ${why}`);
}

/** The project-relative presets folder, e.g. `autos/presets`. */
function presetsRelDir(project: Project): string {
  return `${slash(project.link.autosDir).replace(/\/+$/, "")}/${PRESETS_DIR}`;
}

/** The project-relative path a preset file lives at, e.g. `autos/presets/Drive team.zenith-preset.json`. */
export function presetRelPath(project: Project, fileName: string): string {
  return `${presetsRelDir(project)}/${assertPresetFileName(fileName)}`;
}

/**
 * The preset files in the project's presets folder (spec 15 section 6.5), sorted; none when the
 * folder is missing. Only files whose names a preset file may have are listed.
 */
export function listPresetFiles(root: string): string[] {
  const project = loadDesktopProject(root);
  const dir = confineRelative(root, presetsRelDir(project));
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => {
      try {
        assertPresetFileName(name);
        return true;
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.localeCompare(b));
}

/** The next step a file the page sent ends with when it is not JSON: nothing was written. */
const NOT_SAVED = "Zenith did not save it.";

/**
 * Writes one preset file into the project's presets folder, making the folder when it is missing:
 * Add to project (spec 15 section 6.5). The text must be a preset file of at most 64 KB, with the
 * preset file's `kind` and `presetVersion`; the web app reads every other part of it with its import
 * checks, so main only makes sure it is that kind of file. Written like an auto, through a temporary
 * file renamed over the target.
 */
export function writePresetFile(root: string, fileName: string, text: unknown): string {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_PRESET_BYTES) {
    throw new BridgeError("That preset is not text Zenith can save, or it is larger than 64 KB.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    // The web build's words for a file that is not JSON, so the desktop and the browser say the same.
    throw new BridgeError(unreadableJsonMessage(basename(fileName), text, error, NOT_SAVED));
  }
  const file = parsed as { kind?: unknown; presetVersion?: unknown } | null;
  if (typeof file !== "object" || file === null || file.kind !== "zenith-preset" || file.presetVersion !== 1) {
    throw new BridgeError("That is not a Zenith preset file, so it was not saved.");
  }
  const project = loadDesktopProject(root);
  const rel = presetRelPath(project, fileName);
  const dir = confineRelative(root, presetsRelDir(project));
  mkdirSync(dir, { recursive: true });
  // Confined again once the folder exists, so a link made in its place cannot lead the write out.
  const full = confineRelative(root, rel);
  writeReplacing(full, text);
  return rel;
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
  } catch (error) {
    throw new BridgeError(unreadableJsonMessage(basename(fileName), text, error, NOT_SAVED));
  }
  const project = loadDesktopProject(root);
  const rel = autoRelPath(project, fileName);
  const full = confineRelative(root, rel);
  if (!existsSync(dirname(full))) {
    throw new BridgeError(`The autos folder ${project.link.autosDir} does not exist in this repository.`);
  }
  writeReplacing(full, text);
  return rel;
}

/** Far larger than any real `zenith.json`. */
const MAX_LINK_BYTES = 256 * 1024;

/** The command libraries a `zenith.json` can name. */
export const COMMAND_LIBRARIES = ["solverslib", "ivy"] as const;
export type CommandLibrary = (typeof COMMAND_LIBRARIES)[number];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * `text`, a `zenith.json`, with `deploy.commandLibrary` set to `library` and nothing else changed,
 * in canonical form. Keys the schema does not name are kept, since the canonical writer keeps them.
 * @throws BridgeError when the text does not load or has no `deploy` section to hold the key
 */
export function linkTextWithCommandLibrary(text: string, library: CommandLibrary): string {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
    loadLink(raw);
  } catch (error) {
    throw new BridgeError(`zenith.json does not load, so it was not changed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(raw) || !isRecord(raw["deploy"])) {
    throw new BridgeError("zenith.json has no deploy section, so it names no command library.");
  }
  const next = { ...raw, deploy: { ...raw["deploy"], commandLibrary: library } };
  loadLink(next);
  return canonicalize("link", next);
}

/**
 * Sets the project's command library, as the Settings window does when a person picks one, and
 * returns the `zenith.json` text written.
 *
 * This is deliberately narrow. `zenith.json` also holds `sim.command`, which the main process runs
 * (`sim.ts`), so the renderer never hands over text for this file: it names one of two libraries,
 * this reads the file from disk and changes that one key, and anything else is refused. `note` sees
 * the text before it lands, so the watcher can tell Zenith's own write from an outside edit. Written
 * beside the target and renamed over it, like an auto.
 */
export function setCommandLibrary(root: string, library: unknown, note?: (text: string) => void): string {
  if (typeof library !== "string" || !(COMMAND_LIBRARIES as readonly string[]).includes(library)) {
    throw new BridgeError("The command library must be SolversLib or Ivy.");
  }
  const full = confineRelative(root, "zenith.json");
  if (!existsSync(full) || statSync(full).size > MAX_LINK_BYTES) {
    throw new BridgeError("This project's zenith.json is missing or too large to change here.");
  }
  const text = linkTextWithCommandLibrary(readFileSync(full, "utf8"), library as CommandLibrary);
  note?.(text);
  writeReplacing(full, text);
  return text;
}

/** Far larger than any real `robot.json`, even one with a long command registry. */
const MAX_ROBOT_BYTES = 1024 * 1024;

const sameFile = (a: string, b: string): boolean =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

/**
 * Writes the project's `robot.json` from a robot object, as the Settings window's Robot and Commands
 * sections do, and returns the canonical text written.
 *
 * This is narrow on purpose, like `setCommandLibrary`. The renderer sends a robot object, never file
 * text and never a path: this loads it with the schema (so anything that is not a valid robot is
 * refused), writes it in canonical form, and writes it only to the path `zenith.json` names for the
 * robot, confined to the project. Nothing in `robot.json` is run by the main process (the sim and
 * Deploy commands live in `zenith.json`), so a valid robot carries nothing that runs; even so, a
 * `zenith.json` that names itself, or any non-JSON file, as the robot is refused, so this can never
 * become a way to write the file that holds `sim.command`. Written beside the target and renamed
 * over it, like an auto. `note` sees the text before it lands, so the watcher stays quiet.
 */
export function writeRobot(root: string, robot: unknown, note?: (rel: string, text: string) => void): string {
  if (typeof robot !== "object" || robot === null || Array.isArray(robot)) {
    throw new BridgeError("That is not a robot Zenith can save.");
  }
  let raw: string;
  try {
    raw = JSON.stringify(robot);
  } catch {
    throw new BridgeError("That is not a robot Zenith can save.");
  }
  if (raw.length > MAX_ROBOT_BYTES) throw new BridgeError("That robot is too large to save here.");
  let text: string;
  try {
    // Loaded from the JSON round trip, so only plain data reaches the schema.
    text = canonicalize("robot", loadRobot(JSON.parse(raw)));
  } catch (error) {
    throw new BridgeError(`That robot is not valid, so robot.json was not changed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const project = loadDesktopProject(root);
  const rel = slash(project.link.robot).replace(/^\.\//, "");
  if (!rel.toLowerCase().endsWith(".json")) {
    throw new BridgeError(`zenith.json names ${project.link.robot} as the robot, which is not a JSON file, so it was not changed.`);
  }
  const full = confineRelative(root, rel);
  if (sameFile(full, confineRelative(root, "zenith.json"))) {
    throw new BridgeError("zenith.json names itself as the robot file, so Zenith will not write it from here.");
  }
  if (!existsSync(dirname(full))) {
    throw new BridgeError(`The folder for ${project.link.robot} does not exist in this repository.`);
  }
  note?.(rel, text);
  writeReplacing(full, text);
  return text;
}

/** Far larger than any real `waypoints.json`. */
const MAX_WAYPOINTS_BYTES = 1024 * 1024;

/**
 * Writes the project's waypoints file from a waypoints object, as the editor's Save does once a
 * waypoint was moved, added, renamed or deleted (issue #134), and returns the canonical text written.
 *
 * As narrow as `writeRobot`, and for the same reasons: the renderer sends an object, never file
 * text and never a path; this loads it with the schema, writes it in canonical form, and writes it
 * only to the path `zenith.json` names for the waypoints, confined to the project and never
 * `zenith.json` itself. A project whose `zenith.json` names no waypoints file is refused. Written
 * beside the target and renamed over it, and `note` sees the text first, so the watcher stays quiet.
 */
export function writeWaypoints(root: string, waypoints: unknown, note?: (rel: string, text: string) => void): string {
  if (typeof waypoints !== "object" || waypoints === null || Array.isArray(waypoints)) {
    throw new BridgeError("Those are not waypoints Zenith can save.");
  }
  let raw: string;
  try {
    raw = JSON.stringify(waypoints);
  } catch {
    throw new BridgeError("Those are not waypoints Zenith can save.");
  }
  if (raw.length > MAX_WAYPOINTS_BYTES) throw new BridgeError("Those waypoints are too large to save here.");
  let text: string;
  try {
    // Loaded from the JSON round trip, so only plain data reaches the schema.
    text = canonicalize("waypoints", loadWaypoints(JSON.parse(raw)));
  } catch (error) {
    throw new BridgeError(`Those waypoints are not valid, so waypoints.json was not changed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const project = loadDesktopProject(root);
  if (project.link.waypoints === undefined) {
    throw new BridgeError("This project's zenith.json names no waypoints file, so there is nowhere to save waypoints.");
  }
  const rel = slash(project.link.waypoints).replace(/^\.\//, "");
  if (!rel.toLowerCase().endsWith(".json")) {
    throw new BridgeError(`zenith.json names ${project.link.waypoints} as the waypoints, which is not a JSON file, so it was not changed.`);
  }
  const full = confineRelative(root, rel);
  if (sameFile(full, confineRelative(root, "zenith.json"))) {
    throw new BridgeError("zenith.json names itself as the waypoints file, so Zenith will not write it from here.");
  }
  if (!existsSync(dirname(full))) {
    throw new BridgeError(`The folder for ${project.link.waypoints} does not exist in this repository.`);
  }
  note?.(rel, text);
  writeReplacing(full, text);
  return text;
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
