/**
 * Set up Zenith in a robot repository that has no `zenith.json` yet (issue #159), for the desktop
 * app: Open folder grants such a folder and says it needs Set up, `setupScan` reads the code under
 * its TeamCode folder for the editor to prefill from, and `writeSetup` writes the five files. A
 * folder that has autos already gets only `zenith.json`, pointing at them where they are, and a
 * robot or field only where it has none (issue #496); main finds the autos itself.
 *
 * Deliberately narrow, like saveProject.ts, because the renderer is treated as untrusted
 * (confine.ts):
 *
 * - The folder always comes from the native picker in this process, never from the renderer.
 * - The renderer never supplies `zenith.json`, which holds `sim.command`, which this process runs
 *   (`sim.ts`). This process builds it with core's skeleton from a command library, which must be
 *   one of the two or none, and a robot class, which must be a Java class name, as the schema says.
 * - The robot the renderer sends must load with the schema, and is written in canonical form. The
 *   waypoints, the field (the bundled season's) and the skeleton auto are built here.
 * - Nothing is ever written over a file that is already there; a refusal writes nothing.
 *
 * Kept free of Electron, like saveProject.ts, so the refusals are unit-tested: ipc.ts wires it up.
 */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { LIBRARIES, loadField, loadRobot, type CommandLibrary } from "@horizon36596/zenith-core";
import seasonField from "../../../../packages/season-biobuzz/field/biobuzz.field.json";
import type { DesktopPickedProject, DesktopProjectRef, DesktopSetupScan } from "../../../web/src/project/desktopBridge.js";
import type { ProjectFile } from "../../../web/src/project/projectFiles.js";
import {
  findExistingProject,
  inPlaceFileSet,
  inPlacePaths,
  robotClassProblem,
  searchesInto,
  SETUP_PATHS,
  SETUP_SEARCH_DEPTH,
  setupFileSet,
  setupTakenLine,
  type ExistingProject,
} from "../../../web/src/project/setupFiles.js";
import { readJavaSources } from "./cli.js";
import { BridgeError, confineRelative } from "./confine.js";

/** Where an FTC SDK project keeps the team's code, which the editor's Set up reads. */
const SCAN_DIR = "TeamCode";
/** The biggest source file sent to the editor, as the browser's scan reads: anything larger is not hand-written. */
const MAX_SOURCE_BYTES = 1_000_000;
/** Far more code than any team's TeamCode; a tree larger than this is not sent across the bridge. */
const MAX_SCAN_BYTES = 32 * 1024 * 1024;
/** Far larger than any real `robot.json`, even one with a long command registry. */
const MAX_ROBOT_BYTES = 1024 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * What Open folder hands the renderer for the folder picked: one with `zenith.json` is remembered
 * and opens as before; one without is granted, so Set up can read and write it, and marked as
 * needing Set up. It goes on the recent list only once Set up has written there.
 */
export function pickedFolder(
  root: string,
  deps: { remember: (root: string) => DesktopProjectRef; grant: (root: string) => void },
): DesktopPickedProject {
  if (existsSync(join(root, "zenith.json"))) return deps.remember(root);
  deps.grant(root);
  return { root, name: basename(root), needsSetup: true };
}

/** The files a project already in the folder may have, which is all the search for one keeps. */
const projectFile = (name: string): boolean =>
  name.endsWith(".auto.json") || name.endsWith(".field.json") || name === "robot.json" || name === "waypoints.json";

/**
 * The project already in `root` (issue #496), or null when it holds no autos: a walk to
 * `SETUP_SEARCH_DEPTH` that skips build output, hidden folders and links, as the browser's does.
 */
export function existingProjectIn(root: string): ExistingProject | null {
  const found: string[] = [];
  const walk = (dir: string, prefix: string, level: number): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isFile()) {
        if (projectFile(entry.name)) found.push(path);
      } else if (entry.isDirectory() && level < SETUP_SEARCH_DEPTH && searchesInto(entry.name)) {
        walk(join(dir, entry.name), path, level + 1);
      }
    }
  };
  walk(root, "", 1);
  return findExistingProject(found);
}

/**
 * The Java and Kotlin under TeamCode, relative to the root, the autos already in the folder, and which
 * of the files Set up would write are already there. Writes nothing.
 */
export function setupScan(root: string): DesktopSetupScan {
  const dir = confineRelative(root, SCAN_DIR);
  const teamCode = existsSync(dir) && statSync(dir).isDirectory();
  const sources = teamCode ? readJavaSources(root, [SCAN_DIR], root).filter((source) => source.text.length <= MAX_SOURCE_BYTES) : [];
  const bytes = sources.reduce((sum, source) => sum + source.text.length, 0);
  if (bytes > MAX_SCAN_BYTES) throw new BridgeError(`${basename(root)}'s TeamCode is too large for Zenith to scan.`);
  const existing = existingProjectIn(root);
  const taken = (existing === null ? SETUP_PATHS : inPlacePaths(existing)).filter((path) => existsSync(confineRelative(root, path)));
  return { teamCode, sources, taken, existing };
}

/** The renderer's robot, loaded with the schema from a JSON round trip so only plain data reaches it. */
function robotOf(robot: unknown) {
  let raw: string;
  try {
    raw = JSON.stringify(robot);
  } catch {
    throw new BridgeError("That is not a robot Zenith can save.");
  }
  if (raw === undefined || raw.length > MAX_ROBOT_BYTES) throw new BridgeError("That robot is too large to save here.");
  try {
    return loadRobot(JSON.parse(raw));
  } catch (error) {
    throw new BridgeError(`That robot is not valid, so nothing was written: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * The five files, from what the renderer sent, or a refusal: `zenith.json` built here from the
 * library and the robot class alone, the robot loaded with the schema, and the rest built here. With
 * `inPlace`, the files for the autos already in `root`, which this process finds itself: the
 * renderer names no path.
 */
export function setupRequestFiles(request: unknown, root?: string): ProjectFile[] {
  if (!isRecord(request)) throw new BridgeError("Zenith could not set this folder up. Open the folder again to retry.");
  const library = request["commandLibrary"];
  if (library !== null && !(typeof library === "string" && (LIBRARIES as readonly string[]).includes(library))) {
    throw new BridgeError("The command library must be SolversLib or Ivy, or none yet.");
  }
  const robotClass = request["robotClass"];
  if (robotClass !== null) {
    const problem = typeof robotClass === "string" ? robotClassProblem(robotClass) : "That robot class is not a fully qualified Java class name.";
    if (problem !== null) throw new BridgeError(`${problem} Nothing was written.`);
  }
  const choices = {
    commandLibrary: library as CommandLibrary | null,
    robotClass: robotClass as string | null,
    robot: robotOf(request["robot"]),
    field: loadField(seasonField),
  };
  if (request["inPlace"] !== true) return setupFileSet(choices);
  const existing = root === undefined ? null : existingProjectIn(root);
  if (existing === null) throw new BridgeError("There are no autos in this folder to set up where they are. Open the folder again to retry.");
  return inPlaceFileSet(existing, choices);
}

/**
 * Writes the files into `root`, which must hold none of them. Every path is confined and checked
 * first, so a refusal leaves the folder as it was. Resolves with the paths written, in order.
 */
export function writeSetup(root: string, files: readonly ProjectFile[]): string[] {
  const targets = files.map((file) => ({ file, full: confineRelative(root, file.path) }));
  const taken = targets.filter((target) => existsSync(target.full)).map((target) => target.file.path);
  if (taken.length > 0) throw new BridgeError(setupTakenLine(basename(root), taken));
  for (const { file, full } of targets) {
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file.text, "utf8");
  }
  return files.map((file) => file.path);
}
