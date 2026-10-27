/**
 * Saving the read-only example (issue #103) in the desktop app: Save the full project writes a new
 * project into a folder the person picks, and Save just this auto writes one auto into the autos
 * folder of a project they pick. Since issue #158 that is two calls, a pick that writes nothing and
 * hands back the project's waypoints, then the write, so the editor can ask about waypoints the
 * project lacks or has elsewhere before anything is written.
 *
 * Both are deliberately narrow, because the renderer is treated as untrusted (confine.ts):
 *
 * - The folder always comes from the native picker in this process, never from the renderer.
 * - The renderer never supplies `zenith.json`. It holds `sim.command`, which this process runs
 *   (`sim.ts`), so the full project's `zenith.json` is the bundled example's own, with only the
 *   field file's name taken from the field's validated season and the waypoints line dropped when
 *   there are none. Neither can carry a command. Since issue #159 it also drops the example's
 *   `sim`, `deploy.robotClass` and `deploy.commandLibrary`, which name a robot repository the new
 *   folder is not.
 * - The robot, field, waypoints and autos the renderer sends must each load with the schema, and are
 *   written in canonical form, at fixed paths, through `confineRelative`.
 * - Nothing is ever written over a file that is already there, nor over a waypoint name. The full
 *   project goes only into an empty folder, never a robot repository (issue #159).
 *
 * Kept free of Electron, like saveCopy.ts, so the refusals are unit-tested: ipc.ts passes in the
 * picker.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { canonicalize, loadAuto, loadField, loadLink, loadRobot, loadWaypoints } from "@horizon36596/zenith-core";
import exampleLink from "../../../../examples/starter/zenith.json";
import { fullProjectFolderProblem, newProjectLink, projectFileSet, type ProjectFile } from "../../../web/src/project/projectFiles.js";
import { BridgeError, assertAutoFileName, confineRelative } from "./confine.js";
import { autoRelPath, loadDesktopProject, writeAuto, writeWaypoints } from "./project.js";

/** Far more than the example's robot, field, waypoints and every auto it ships, together. */
export const PROJECT_LIMIT_BYTES = 16 * 1024 * 1024;
/** More autos than any project has; a payload with more is not a project. */
export const AUTO_LIMIT = 200;
/** A season name that can be part of a file name: `biobuzz`, `into-the-deep`. */
const SEASON = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface PickDeps {
  /** Shows the native folder picker; the folder picked, or null when it was cancelled. */
  pick: () => Promise<string | null>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const slash = (path: string): string => path.split("\\").join("/");

/** Parses one file of the payload with its loader, or refuses naming the file. */
function load<T>(name: string, text: unknown, loader: (json: unknown) => T): T {
  if (typeof text !== "string") throw new BridgeError(`The project's ${name} is not text, so nothing was written.`);
  try {
    return loader(JSON.parse(text));
  } catch (error) {
    throw new BridgeError(`The project's ${name} does not load, so nothing was written: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * The files of the full project, from what the renderer sent, or a refusal. `zenith.json` is the
 * bundled example's without its sim command, robot class and command library, so nothing in it is
 * anything the renderer could choose.
 */
export function fullProjectFiles(payload: unknown): ProjectFile[] {
  if (!isRecord(payload) || !Array.isArray(payload["autos"])) {
    throw new BridgeError("That is not a project Zenith can save.");
  }
  const autosIn = payload["autos"] as unknown[];
  if (autosIn.length > AUTO_LIMIT) throw new BridgeError("That project has too many autos to save here.");
  let bytes = 0;
  const autos: Record<string, string> = {};
  for (const entry of autosIn) {
    if (!isRecord(entry) || typeof entry["text"] !== "string") throw new BridgeError("That is not a project Zenith can save.");
    const fileName = assertAutoFileName(entry["fileName"]);
    if (fileName in autos) throw new BridgeError(`${fileName} is in the project twice, so nothing was written.`);
    autos[fileName] = entry["text"];
    bytes += entry["text"].length;
  }
  for (const key of ["robot", "field", "waypoints"]) {
    const text = payload[key];
    if (typeof text === "string") bytes += text.length;
  }
  if (bytes > PROJECT_LIMIT_BYTES) throw new BridgeError("That project is too large to save here.");

  const robot = load("robot.json", payload["robot"], loadRobot);
  const field = load("field file", payload["field"], loadField);
  const waypointsText = payload["waypoints"];
  const waypoints =
    waypointsText === null || waypointsText === undefined ? undefined : load("waypoints.json", waypointsText, loadWaypoints);
  if (!SEASON.test(field.season)) {
    throw new BridgeError(`The field's season "${field.season}" cannot name a file, so nothing was written.`);
  }

  const link: Record<string, unknown> = { ...(exampleLink as Record<string, unknown>), field: `autos/field/${field.season}.field.json` };
  if (waypoints === undefined) delete link["waypoints"];
  try {
    return projectFileSet({ link: newProjectLink(loadLink(link)), robot, field, ...(waypoints === undefined ? {} : { waypoints }), autos });
  } catch (error) {
    throw new BridgeError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Writes the files into `root`, which must be empty but for hidden entries (issue #159): a folder
 * that already has a `zenith.json` is someone's project, and one with `TeamCode` or `build.gradle`
 * is a robot repository, which Open folder offers to set up instead. Every path is confined first,
 * so a refusal leaves the folder as it was.
 */
export function writeFullProject(root: string, files: readonly ProjectFile[]): void {
  const problem = fullProjectFolderProblem(basename(root), existsSync(root) ? readdirSync(root) : []);
  if (problem !== null) throw new BridgeError(problem);
  const targets = files.map((file) => ({ file, full: confineRelative(root, file.path) }));
  const taken = targets.find((target) => existsSync(target.full));
  if (taken !== undefined) {
    throw new BridgeError(
      taken.file.path === "zenith.json"
        ? `${basename(root)} already has a zenith.json, so nothing was written. Pick an empty folder, or use Save just this auto to add the auto to that project.`
        : `${basename(root)} already has ${taken.file.path}, so nothing was written. Pick an empty folder.`,
    );
  }
  for (const { file, full } of targets) {
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file.text, "utf8");
  }
}

/** Save the full project: checks what it was given, asks for a folder, then writes. Null on cancel. */
export async function saveFullProject(deps: PickDeps, payload: unknown): Promise<string | null> {
  const files = fullProjectFiles(payload);
  const root = await deps.pick();
  if (root === null || root === "") return null;
  writeFullProject(root, files);
  return root;
}

/** The auto, as the renderer sent it, loaded with the schema and in canonical form, or a refusal. */
function canonicalAuto(name: string, text: unknown): string {
  if (typeof text !== "string" || text.length > PROJECT_LIMIT_BYTES) {
    throw new BridgeError("That auto is not text Zenith can save.");
  }
  return canonicalize("auto", load(name, text, loadAuto));
}

/** Where Save just this auto would put an auto in a project folder, and that project's waypoints. */
export interface AutoTarget {
  root: string;
  /** Relative to the root, with `/` separators: `autos/first-auto.auto.json`. */
  path: string;
  /** The waypoints file `zenith.json` names, relative to the root, or null when it names none. */
  waypointsPath: string | null;
  /** That file's text, or null when it names none or the file cannot be read. */
  waypoints: string | null;
}

/**
 * Checks a project folder for Save just this auto, writing nothing: it must have `zenith.json` and
 * the autos folder it names, and no auto of this name yet. Says where the auto would go, and reads
 * the waypoints file `zenith.json` names, so the editor can compare it with the waypoints the auto
 * follows before anything is written (issue #158).
 */
export function autoTargetAt(root: string, name: string): AutoTarget {
  const project = loadDesktopProject(root);
  const path = autoRelPath(project, name);
  const full = confineRelative(root, path);
  if (existsSync(full)) {
    throw new BridgeError(`${basename(root)} already has ${path}, so nothing was written. Open ${basename(root)} to change that auto there.`);
  }
  if (!existsSync(dirname(full))) {
    throw new BridgeError(`The autos folder ${project.link.autosDir} does not exist in ${basename(root)}, so nothing was written.`);
  }
  const waypointsPath = project.link.waypoints === undefined ? null : slash(project.link.waypoints).replace(/^\.\//, "");
  let waypoints: string | null = null;
  if (waypointsPath !== null) {
    try {
      waypoints = readFileSync(confineRelative(root, waypointsPath), "utf8");
    } catch {
      waypoints = null;
    }
  }
  return { root, path, waypointsPath, waypoints };
}

/**
 * The first step of Save just this auto (issue #158): asks for a project folder in the native
 * picker and checks it (`autoTargetAt`), writing nothing. Null on cancel. The auto's name is checked
 * before the picker shows.
 */
export async function pickAutoTarget(deps: PickDeps, fileName: unknown): Promise<AutoTarget | null> {
  const name = assertAutoFileName(fileName);
  const root = await deps.pick();
  if (root === null || root === "") return null;
  return autoTargetAt(root, name);
}

/** The waypoints the renderer asks to add, as a plain record of names, or null for none. */
function waypointsToAdd(add: unknown): Record<string, unknown> | null {
  if (add === null || add === undefined) return null;
  if (typeof add !== "object" || Array.isArray(add)) throw new BridgeError("Those are not waypoints Zenith can add.");
  const entries = Object.entries(add as Record<string, unknown>);
  return entries.length === 0 ? null : Object.fromEntries(entries);
}

/**
 * The second step of Save just this auto (issue #158), into `root`, a folder the person picked: the
 * auto goes into the autos folder `zenith.json` names, in canonical form, never over a file already
 * there. `addWaypoints` (name to waypoint) first go into the waypoints file `zenith.json` names,
 * after the waypoints already in it, never over a name already there; that file is written as
 * `writeWaypoints` writes it, loaded with the schema. Any refusal comes before the first write, so it
 * leaves the folder as it was. `note` sees each path and text before it is written.
 */
export function writeAutoInto(
  root: string,
  fileName: unknown,
  text: unknown,
  addWaypoints: unknown,
  note?: (rel: string, text: string) => void,
): { root: string; path: string } {
  const name = assertAutoFileName(fileName);
  const canonical = canonicalAuto(name, text);
  const add = waypointsToAdd(addWaypoints);
  const target = autoTargetAt(root, name);
  if (add !== null) {
    if (target.waypointsPath === null) {
      throw new BridgeError(`${basename(root)}'s zenith.json names no waypoints file, so nothing was written.`);
    }
    const current = load(target.waypointsPath, target.waypoints, loadWaypoints);
    for (const added of Object.keys(add)) {
      if (Object.prototype.hasOwnProperty.call(current.waypoints, added)) {
        throw new BridgeError(`${basename(root)}'s ${target.waypointsPath} already has a waypoint named ${added}, so nothing was written.`);
      }
    }
    writeWaypoints(root, { ...current, waypoints: { ...current.waypoints, ...add } }, note);
  }
  note?.(target.path, canonical);
  writeAuto(root, name, canonical);
  return { root, path: target.path };
}

/**
 * Save just this auto in one step, as desktop builds before issue #158 offered it: asks for a project
 * folder, which must have `zenith.json` and the autos folder it names, and writes the auto there in
 * canonical form, never over an auto already there. Resolves with the folder and the auto's path in
 * it, or null on cancel. The web build uses `pickAutoTarget` and `writeAutoInto` where it can.
 */
export async function saveAutoInto(
  deps: PickDeps,
  fileName: unknown,
  text: unknown,
): Promise<{ root: string; path: string } | null> {
  const name = assertAutoFileName(fileName);
  canonicalAuto(name, text);
  const target = await pickAutoTarget(deps, name);
  if (target === null) return null;
  return writeAutoInto(target.root, name, text, null);
}
