import { existsSync, readdirSync, readFileSync } from "node:fs";
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
 * Resolves `target` (relative to `root`, or absolute) and asserts it lands inside `root`. Every
 * path an MCP tool derives from its own input — a `name`, an `out`, an `auto` reference — must go
 * through this before it is read or written: an agent's tool call is untrusted input in exactly
 * the way a hand-typed CLI argument is not. Throws
 * `ProjectError` rather than silently clamping the path, so the refusal is visible to the caller.
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

/** Walks up from a directory looking for `zenith.json`, the way `git` looks for `.git`. */
export function findProjectRoot(from: string): string | null {
  let current = resolvePath(from);
  for (;;) {
    if (existsSync(join(current, LINK_FILE))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
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
 * Loads `zenith.json` and the robot, field and waypoints files it points at, starting the search
 * for the link file at `dir` (an explicit `project` argument, when a tool call gives one) or at
 * the server process's own working directory otherwise — an MCP server is normally started from
 * inside the robot repo (site/docs/agents-mcp.md), the same way `zenith validate` finds a project by
 * walking up from the shell's current directory.
 */
export function resolveProject(dir?: string): Project {
  const from = dir === undefined ? process.cwd() : resolvePath(dir);
  const root = findProjectRoot(from);
  if (root === null) {
    throw new ProjectError(
      `No ${LINK_FILE} in ${from} or any directory above it. Pass "project" with the robot repo's ` +
        "directory, or run the MCP server from inside that repo.",
    );
  }
  const linkPath = join(root, LINK_FILE);
  const link = loadLink(readJsonFile(linkPath));
  const inRoot = (relativePath: string): string =>
    isAbsolute(relativePath) ? relativePath : join(root, relativePath);

  return {
    root,
    link,
    robot: loadRobot(readJsonFile(inRoot(link.robot))),
    field: loadField(readJsonFile(inRoot(link.field))),
    waypoints:
      link.waypoints === undefined ? undefined : loadWaypoints(readJsonFile(inRoot(link.waypoints))),
  };
}

/** A path relative to `project.root`, with forward slashes so it reads the same on every OS. */
export function relativeToRoot(project: Project, absolute: string): string {
  return relative(project.root, absolute).split("\\").join("/");
}

/**
 * Resolves the `auto` argument every tool takes to an absolute path. It accepts three forms: an
 * absolute path, a path (containing a slash or ending `.auto.json`) relative to the project root,
 * or a bare name — the common case, matching `zenith new <name>` — resolved against the project's
 * `autosDir`. Every form is confined to the project root (finding 2): a tool call is untrusted
 * input, so `"../../../../outside/.gitconfig"` or an absolute path outside the project is
 * refused here rather than followed, for a read as much as a write.
 */
export function resolveAutoPath(project: Project, auto: string): string {
  if (isAbsolute(auto) || auto.includes("/") || auto.includes("\\") || auto.endsWith(".auto.json")) {
    return confinePath(project.root, auto);
  }
  return confinePath(project.root, join(project.link.autosDir, `${auto}.auto.json`));
}

/** Every `*.auto.json` file name (without the extension) in the project's `autosDir`. */
export function listAutoNames(project: Project): string[] {
  const dir = join(project.root, project.link.autosDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".auto.json"))
    .map((entry) => entry.slice(0, -".auto.json".length))
    .sort();
}
