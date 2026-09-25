import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { mirrorForField } from "@horizon36596/zenith-core";
import { findProjectRoot, loadProject, ProjectError } from "../project.js";
import { autoSkeleton } from "../skeletons.js";

export interface NewOptions {
  cwd?: string;
  project?: string;
  alliance?: string;
  json?: boolean;
  force?: boolean;
}

/** `zenith new <name>`: writes a canonical skeleton into the project's autos directory. */
export function runNew(name: string, options: NewOptions): number {
  const cwd = options.cwd ?? process.cwd();
  const project = loadProject(cwd, options.project);
  const root = options.project === undefined ? (findProjectRoot(cwd) ?? cwd) : resolvePath(options.project);
  const alliance = (options.alliance ?? "RED").toUpperCase();
  if (alliance !== "RED" && alliance !== "BLUE") {
    throw new ProjectError(`--alliance must be RED or BLUE, not ${JSON.stringify(alliance)}.`);
  }

  const relative = `${project.link.autosDir}/${name}.auto.json`;
  const full = join(root, relative);
  if (existsSync(full) && options.force !== true) {
    throw new ProjectError(`${relative} already exists. Pass --force to overwrite it.`);
  }
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, autoSkeleton(name, alliance, mirrorForField(project.field)), "utf8");

  if (options.json === true) process.stdout.write(`${JSON.stringify({ written: relative }, null, 2)}\n`);
  else process.stdout.write(`written: ${relative}\n`);
  return 0;
}
