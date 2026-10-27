/**
 * The files Set up writes into a robot repository that has no `zenith.json` yet (issue #159):
 * `zenith.json`, the robot, the waypoints, the season's field and one skeleton auto, each in
 * canonical form. The skeletons are core's, the same ones `zenith init` and `zenith new` write.
 *
 * Pure: no DOM, so the desktop app's main process builds the same files with the same rules. There
 * the renderer never sends `zenith.json`: main builds it from a command library, which must be one
 * of the two, and a robot class, which must be a Java class name, because `zenith.json` holds
 * `sim.command`, which main runs.
 */
import {
  autoSkeleton,
  canonicalize,
  linkSkeleton,
  loadLink,
  mirrorForField,
  waypointsSkeleton,
  type CommandLibrary,
} from "@horizon36596/zenith-core";
import { linkSchema, type Field, type Robot } from "@horizon36596/zenith-schema";
import type { DesktopExistingProject } from "./desktopBridge";
import { ProjectError } from "./errors";
import type { ProjectFile } from "./projectFiles";

/** What the provenance of every number Set up writes says wrote it. */
export const SETUP_WRITTEN_BY = "the editor's Set up";

/** The one auto Set up writes, which the project opens on. */
export const SETUP_AUTO = "first-auto.auto.json";

/** Every file Set up writes, in the order it writes them, at the paths its `zenith.json` names. */
export const SETUP_PATHS = [
  "zenith.json",
  "autos/robot.json",
  "autos/waypoints.json",
  "autos/field/biobuzz.field.json",
  `autos/${SETUP_AUTO}`,
] as const;

/** The schema's own rule for `deploy.robotClass`, so a robot class is checked exactly as the file is. */
const robotClassRule = linkSchema.shape.deploy.unwrap().shape.robotClass;

/** Why `text` cannot be `deploy.robotClass`, or null when it can. */
export function robotClassProblem(text: string): string | null {
  return robotClassRule.safeParse(text).success
    ? null
    : `${JSON.stringify(text)} is not a fully qualified Java class name, such as org.firstinspires.ftc.teamcode.robot.TeamRobot.`;
}

/**
 * What Set up says when files it would write are already in the folder `folder`: it writes nothing,
 * so it never writes over a file a team has.
 */
export function setupTakenLine(folder: string, taken: readonly string[]): string {
  if (taken.includes("zenith.json")) return `${folder} already has a zenith.json, so nothing was written. Open it with Open project.`;
  const them = taken.length === 1 ? "it" : "them";
  return `${folder} already has ${taken.join(", ")}, so nothing was written. Move ${them} out of the way, then set up again.`;
}

export interface SetupChoices {
  /** `deploy.commandLibrary`, or null to leave it out until the team names one. */
  commandLibrary: CommandLibrary | null;
  /** `deploy.robotClass`, or null to leave it out. With one, `zenith.json` also gets a `codegen` section. */
  robotClass: string | null;
  /** The skeleton robot with the commands and conditions the scan found. */
  robot: Robot;
  /** The season's field, from the bundled season data. */
  field: Field;
}

/**
 * The five files, `zenith.json` first. It has no `sim` section, and a `codegen` section only when a
 * robot class was given: every OpMode `zenith deploy` writes constructs one.
 * @throws ProjectError when the robot class is not a Java class name
 */
export function setupFileSet(choices: SetupChoices): ProjectFile[] {
  const { commandLibrary, robotClass, robot, field } = choices;
  if (robotClass !== null) {
    const problem = robotClassProblem(robotClass);
    if (problem !== null) throw new ProjectError(`${problem} Nothing was written.`);
  }
  const texts = [
    linkSkeleton({
      ...(commandLibrary === null ? {} : { commandLibrary }),
      ...(robotClass === null ? {} : { robotClass }),
      codegen: robotClass !== null,
    }),
    canonicalize("robot", robot),
    waypointsSkeleton(SETUP_WRITTEN_BY),
    canonicalize("field", field),
    autoSkeleton(SETUP_AUTO.replace(/\.auto\.json$/, ""), "RED", mirrorForField(field), SETUP_WRITTEN_BY),
  ];
  return SETUP_PATHS.map((path, index) => ({ path, text: texts[index] as string }));
}

/* ---- A folder that has autos already (issue #496) ---------------------------- */

/**
 * Folders the search for autos already in a repository never enters: version control, editor and
 * build output, and packages. A folder whose name starts with a dot is skipped too.
 */
export const SETUP_SKIP_DIRS: ReadonlySet<string> = new Set(["build", "node_modules", "out", "bin"]);

/** How deep the search goes: `TeamCode/src/main/assets/autos/x.auto.json` is five levels down. */
export const SETUP_SEARCH_DEPTH = 6;

/** Whether the search for autos goes into a folder called `name`. */
export const searchesInto = (name: string): boolean => !name.startsWith(".") && !SETUP_SKIP_DIRS.has(name);

/** Where `zenith deploy` copies the autos in the skeleton zenith.json, so a copy there is not the team's own. */
const DEPLOY_DIR = "TeamCode/src/main/assets/autos";

/**
 * A Zenith project already in a folder that has no `zenith.json`, as a team has one after copying
 * its autos across or deleting the file: the folder the autos are in (`autosDir`), their file names,
 * and the robot, field and waypoints files found, each null when there is none. Set up then writes
 * `zenith.json` pointing at them where they are, and moves and overwrites nothing. The same shape
 * crosses the desktop bridge.
 */
export type ExistingProject = DesktopExistingProject;

const dirOf = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const baseOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const under = (path: string, dir: string): boolean => dir === "" || path.startsWith(`${dir}/`);
const depth = (path: string): number => path.split("/").length;

/** The nearest of `paths` to `dir`: one under it first, then the shallowest, then by name. */
function nearest(paths: readonly string[], dir: string): string | null {
  const sorted = [...paths].sort((a, b) => Number(under(b, dir)) - Number(under(a, dir)) || depth(a) - depth(b) || a.localeCompare(b));
  return sorted[0] ?? null;
}

/**
 * The project already in a folder, from the paths of its files (relative, with `/`), or null when
 * it holds no auto. The autos are the folder with the most `*.auto.json` files in it; a copy that
 * `zenith deploy` made under TeamCode's assets counts only when there are no others.
 */
export function findExistingProject(paths: readonly string[]): ExistingProject | null {
  const byDir = new Map<string, string[]>();
  for (const path of paths) {
    const dir = dirOf(path);
    // Autos loose at the top of a repository are not a Zenith project's folder of autos.
    if (!path.endsWith(".auto.json") || dir === "") continue;
    byDir.set(dir, [...(byDir.get(dir) ?? []), baseOf(path)]);
  }
  const dirs = [...byDir.keys()];
  const own = dirs.filter((dir) => dir !== DEPLOY_DIR);
  const choices = own.length > 0 ? own : dirs;
  const autosDir = [...choices].sort(
    (a, b) => (byDir.get(b)?.length ?? 0) - (byDir.get(a)?.length ?? 0) || depth(a) - depth(b) || a.localeCompare(b),
  )[0];
  if (autosDir === undefined) return null;
  const outsideDeploy = (path: string): boolean => autosDir === DEPLOY_DIR || !under(path, DEPLOY_DIR);
  const robot = nearest(paths.filter((path) => baseOf(path) === "robot.json" && outsideDeploy(path)), autosDir);
  const field = nearest(paths.filter((path) => path.endsWith(".field.json") && outsideDeploy(path)), autosDir);
  const waypoints = paths.includes(`${autosDir}/waypoints.json`) ? `${autosDir}/waypoints.json` : null;
  return { autosDir, autos: (byDir.get(autosDir) ?? []).sort(), robot, field, waypoints };
}

/** Where Set up writes the robot and the field a folder with autos lacks: beside the autos. */
const missingPaths = (existing: ExistingProject): { robot: string; field: string } => ({
  robot: `${existing.autosDir}/robot.json`,
  field: `${existing.autosDir}/field/biobuzz.field.json`,
});

/** The paths Set up writes into a folder with autos already: `zenith.json`, and a robot or field only where it has none. */
export function inPlacePaths(existing: ExistingProject): string[] {
  const missing = missingPaths(existing);
  return ["zenith.json", ...(existing.robot === null ? [missing.robot] : []), ...(existing.field === null ? [missing.field] : [])];
}

/**
 * The files Set up writes into a folder with autos already (issue #496): `zenith.json` pointing at
 * the autos, robot, field and waypoints where they are, and only the robot or field it lacks, so
 * nothing the folder holds is moved or written over.
 * @throws ProjectError when the robot class is not a Java class name
 */
export function inPlaceFileSet(existing: ExistingProject, choices: SetupChoices): ProjectFile[] {
  const { commandLibrary, robotClass, robot, field } = choices;
  if (robotClass !== null) {
    const problem = robotClassProblem(robotClass);
    if (problem !== null) throw new ProjectError(`${problem} Nothing was written.`);
  }
  const missing = missingPaths(existing);
  const skeleton = JSON.parse(
    linkSkeleton({
      ...(commandLibrary === null ? {} : { commandLibrary }),
      ...(robotClass === null ? {} : { robotClass }),
      codegen: robotClass !== null,
    }),
  ) as Record<string, unknown>;
  // The skeleton names a waypoints file; a folder without one gets none, since Set up writes none here.
  delete skeleton["waypoints"];
  const link = {
    ...skeleton,
    autosDir: existing.autosDir,
    robot: existing.robot ?? missing.robot,
    field: existing.field ?? missing.field,
    ...(existing.waypoints === null ? {} : { waypoints: existing.waypoints }),
  };
  return [
    { path: "zenith.json", text: canonicalize("link", loadLink(link)) },
    ...(existing.robot === null ? [{ path: missing.robot, text: canonicalize("robot", robot) }] : []),
    ...(existing.field === null ? [{ path: missing.field, text: canonicalize("field", field) }] : []),
  ];
}

/**
 * What the Set up question says about a folder with autos already, such as "robot-repo has 3 autos
 * in autos but no zenith.json.", for the dialog and the status line alike.
 */
export function existingLine(folder: string, existing: ExistingProject): string {
  const count = existing.autos.length;
  return `${folder} has ${String(count)} ${count === 1 ? "auto" : "autos"} in ${existing.autosDir} but no zenith.json.`;
}
