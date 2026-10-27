/**
 * The files of a whole project, for Save the full project (issue #103): `zenith.json`, the robot,
 * the field, the waypoints and the autos, each in canonical form and at the path `zenith.json`
 * names for it, so the result opens with Open project or Open files exactly as written.
 *
 * Also here, because it is the other half of the same confusion: what to say when someone opens an
 * auto file on its own, without the project it belongs to.
 *
 * Pure: no DOM, so the desktop app's main process lays out the same files with the same rules.
 */
import { canonicalize, loadAuto } from "@horizon36596/zenith-core";
import type { Field, Link, Robot, Waypoints } from "@horizon36596/zenith-schema";
import { ProjectError } from "./errors";

export interface ProjectFile {
  /** The path inside the project folder, with forward slashes: `autos/first-auto.auto.json`. */
  path: string;
  text: string;
}

export interface ProjectParts {
  link: Link;
  robot: Robot;
  field: Field;
  waypoints?: Waypoints;
  /** Auto file name to its text, in any format version; each is written in the current one. */
  autos: Readonly<Record<string, string>>;
}

/** A bare auto file name, the same alphabet the desktop app's main process holds a name to. */
export const AUTO_FILE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*\.auto\.json$/;

/**
 * A path from `zenith.json` as one inside the project folder, or a thrown error. A legitimate
 * project never names an absolute path or climbs out with `..`, so those are refused, not fixed.
 */
export function projectPath(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter((part) => part !== "" && part !== ".");
  if (/^([A-Za-z]:|[\\/])/.test(path) || parts.includes("..") || parts.length === 0) {
    throw new ProjectError(`zenith.json names ${path}, which is not a path inside the project.`);
  }
  return parts.join("/");
}

/**
 * Every file of the project, `zenith.json` first and the autos last in name order. An auto that
 * does not load stops the whole set, naming the file, so a saved project never holds a broken one.
 */
export function projectFileSet(parts: ProjectParts): ProjectFile[] {
  const { link } = parts;
  const files: ProjectFile[] = [
    { path: "zenith.json", text: canonicalize("link", link) },
    { path: projectPath(link.robot), text: canonicalize("robot", parts.robot) },
    { path: projectPath(link.field), text: canonicalize("field", parts.field) },
  ];
  if (link.waypoints !== undefined && parts.waypoints !== undefined) {
    files.push({ path: projectPath(link.waypoints), text: canonicalize("waypoints", parts.waypoints) });
  }
  const autosDir = projectPath(link.autosDir);
  for (const name of Object.keys(parts.autos).sort((a, b) => a.localeCompare(b))) {
    if (!AUTO_FILE_NAME.test(name)) throw new ProjectError(`${name} is not an auto file name.`);
    let text: string;
    try {
      text = canonicalize("auto", loadAuto(JSON.parse(parts.autos[name] as string)));
    } catch (error) {
      throw new ProjectError(`${name} does not load, so the project was not saved: ${error instanceof Error ? error.message : String(error)}`);
    }
    files.push({ path: `${autosDir}/${name}`, text });
  }
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.path)) throw new ProjectError(`zenith.json names ${file.path} for two files.`);
    seen.add(file.path);
  }
  return files;
}

/**
 * The `zenith.json` Save the full project writes (issue #159): the open project's, without the keys
 * that name things in a robot repository the new folder does not have. `sim` runs a test in that
 * repository's code, `deploy.robotClass` is its robot class, and `deploy.commandLibrary` is the
 * library its code uses, so a new project has none of them until the team sets them.
 */
export function newProjectLink(link: Link): Link {
  const next: Link = { ...link };
  delete next.sim;
  if (link.deploy !== undefined) {
    const deploy = { ...link.deploy };
    delete deploy.robotClass;
    delete deploy.commandLibrary;
    next.deploy = deploy;
  }
  return next;
}

/** What marks a folder as an FTC SDK robot repository, at its top level, in lower case. */
const ROBOT_REPOSITORY = ["teamcode", "build.gradle"];

/**
 * Why Save the full project will not write into a folder whose top level holds `names`, or null
 * when it may (issue #159). It writes only into a new, empty folder, where hidden entries (a name
 * that starts with a dot, such as a git folder) are fine: a `zenith.json` there is someone's
 * project, and `TeamCode` or `build.gradle` is a robot repository, which Open project offers to set
 * Zenith up in instead.
 */
export function fullProjectFolderProblem(folder: string, names: readonly string[]): string | null {
  const shown = names.filter((name) => !name.startsWith(".")).map((name) => name.toLowerCase());
  if (shown.includes("zenith.json")) {
    return `${folder} already has a zenith.json, so nothing was written. Pick an empty folder, or use Save just this auto to add the auto to that project.`;
  }
  if (shown.some((name) => ROBOT_REPOSITORY.includes(name))) {
    return `${folder} is a robot repository, so nothing was written: Save the full project needs a new, empty folder. To use Zenith in ${folder}, open it with Open project, and Zenith offers to set it up there.`;
  }
  if (shown.length > 0) return `${folder} is not empty, so nothing was written: Save the full project needs a new, empty folder.`;
  return null;
}

/** The download name of a saved project: `zenith-starter.zip` for the example, else the project's own name. */
export function projectZipName(projectName: string): string {
  const last = projectName.split("/").pop() ?? projectName;
  const slug = last
    .toLowerCase()
    .replace(/\.zip$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    // A project opened from a zip this saved is named after it; saving it again keeps one prefix.
    .replace(/^zenith-/, "");
  return `zenith-${slug === "" ? "project" : slug}.zip`;
}

/* ---- An auto opened on its own ------------------------------------------- */

/** True when every picked file is an auto: someone opened an auto without the project it belongs to. */
export const onlyAutos = (names: readonly string[]): boolean =>
  names.length > 0 && names.every((name) => name.endsWith(".auto.json"));

/**
 * Thrown by Open files when every picked file is an auto. It carries the autos, so the message can
 * offer to open them on the example's robot and field.
 */
export class LoneAutoError extends ProjectError {
  constructor(readonly autoTexts: Readonly<Record<string, string>>) {
    super(loneAutoLines(Object.keys(autoTexts)).join(" "));
    this.name = "LoneAutoError";
  }
}

/**
 * What the lone-auto message says: what was opened, exactly which files are missing, and what to
 * do. Two or three short sentences.
 */
export function loneAutoLines(names: readonly string[]): string[] {
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  const what =
    sorted.length === 1
      ? `${sorted[0] as string} is only an auto.`
      : `These ${String(sorted.length)} files are only autos.`;
  const it = sorted.length === 1 ? "it" : "them";
  const belongs = sorted.length === 1 ? "it belongs" : "they belong";
  return [
    what,
    `To open ${it}, Zenith also needs the project ${belongs} to: zenith.json, robot.json and the season's field file (*.field.json).`,
    `Open the project folder ${belongs} to, or open ${it} with the example robot and field.`,
  ];
}
