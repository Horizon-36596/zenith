import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import { loadField, loadLink, loadRobot, loadWaypoints } from "@horizon36596/zenith-core";
import type { Field, Link, Robot, Waypoints } from "@horizon36596/zenith-schema";

export const LINK_FILE = "zenith.json";

export class ProjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectError";
  }
}

/**
 * Resolves `target` (a path from `zenith.json`, absolute or relative to `root`) and asserts it
 * lands inside `root`. Every directory or file the CLI writes to or deletes from must go through
 * this, so a `zenith.json` value like `"../ESCAPED-DEPLOY"` (or an absolute path outside the repo)
 * is refused before any filesystem call rather than followed.
 */
export function confinePath(root: string, target: string): string {
  const resolved = isAbsolute(target) ? resolvePath(target) : resolvePath(root, target);
  const rel = relative(root, resolved);
  if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) {
    throw new ProjectError(`"${target}" resolves outside the project root (${root}); refusing to use it.`);
  }
  return resolved;
}

export interface Project {
  /** The directory holding `zenith.json`. Every path in the link file is relative to it. */
  root: string;
  link: Link;
  robot: Robot;
  field: Field;
  waypoints: Waypoints | undefined;
}

/** Walks up from a directory looking for `zenith.json`, the way git looks for `.git`. */
export function findProjectRoot(from: string): string | null {
  let current = resolvePath(from);
  for (;;) {
    if (existsSync(join(current, LINK_FILE))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * `loadProject`'s root-finding: an explicit `--project` wins outright; otherwise walk up from
 * `from` (normally the working directory); and when that finds nothing, walk up from `autoHint`
 * (a verb's raw auto argument) instead, so `zenith <verb> examples/starter/autos/x.auto.json` (run
 * from the repository root, no `zenith.json` there) finds `examples/starter`'s project the same
 * way `zenith validate` always has.
 */
function findProjectRootFor(from: string, projectDir: string | undefined, autoHint: string | undefined): string | null {
  if (projectDir !== undefined) return resolvePath(projectDir);
  const direct = findProjectRoot(from);
  if (direct !== null) return direct;
  if (autoHint === undefined) return null;
  const hintPath = isAbsolute(autoHint) ? autoHint : resolvePath(from, autoHint);
  return findProjectRoot(dirname(hintPath));
}

export function readJsonFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new ProjectError(`Cannot read ${path}.`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ProjectError(`${path} is not valid JSON: ${(error as Error).message}`);
  }
}

/**
 * Loads `zenith.json` and the robot, field and waypoints files it points at.
 *
 * `autoHint` is a verb's raw `<auto>` argument (before any resolution against `autosDir`), tried
 * as a last resort when neither `projectDir` nor walking up from `from` finds a `zenith.json`: the
 * same "walk up from the file you were given" fallback every verb should have, not just
 * `validate`.
 */
export function loadProject(from: string, projectDir?: string, autoHint?: string): Project {
  const root = findProjectRootFor(from, projectDir, autoHint);
  if (root === null) {
    throw new ProjectError(
      `No ${LINK_FILE} here or in any directory above. Run "zenith init" or pass --project <dir>.`,
    );
  }
  const linkPath = join(root, LINK_FILE);
  if (!existsSync(linkPath)) throw new ProjectError(`No ${LINK_FILE} in ${root}.`);
  const link = loadLink(readJsonFile(linkPath));
  const inRoot = (relativePath: string): string =>
    isAbsolute(relativePath) ? relativePath : join(root, relativePath);

  // Every directory zenith.json names for writing (or deleting from) must resolve inside the
  // project root; a "../ESCAPED-DEPLOY" or an absolute path is refused here, once, rather than
  // trusted by every command that later joins a file name onto it (finding 13).
  confinePath(root, link.autosDir);
  if (link.deploy !== undefined) confinePath(root, link.deploy.dir);
  if (link.codegen !== undefined) confinePath(root, link.codegen.dir);

  return {
    root,
    link,
    robot: loadRobot(readJsonFile(inRoot(link.robot))),
    field: loadField(readJsonFile(inRoot(link.field))),
    waypoints:
      link.waypoints === undefined ? undefined : loadWaypoints(readJsonFile(inRoot(link.waypoints))),
  };
}
