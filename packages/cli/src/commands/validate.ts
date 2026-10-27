import { existsSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import {
  check,
  estimate,
  loadAuto,
  loadField,
  loadRobot,
  plan,
  resolve,
  type Finding,
} from "@horizon36596/zenith-core";
import { resolveSeason } from "@horizon36596/zenith-seasons";
import { javaDirsOf, SchemaError, type Field, type Robot } from "@horizon36596/zenith-schema";
import { assertValidAutoName, autoFileNameMismatch, nearestStepId, resolveAutoPath } from "../autoLoad.js";
import {
  countErrors,
  formatExplanations,
  formatFindingsTable,
  helpFor,
  type FileFindings,
} from "../findings.js";
import { readInterchange, validateInterchange, type InterchangeKind } from "../interchange.js";
import { loadProject, ProjectError, readJsonFile, type Project } from "../project.js";
import { configuredRegistryFindings, registryFileFindings } from "./importCommands.js";

export interface ValidateOptions {
  json?: boolean;
  /** Say what each finding code means and how to fix it (`FINDING_HELP`). */
  explain?: boolean;
  project?: string;
  cwd?: string;
  /**
   * Directories (or files) of the robot's Java or Kotlin: also check `robot.json`'s commands and
   * conditions against the `NamedCommands` registrations in them (Zenith's ADR 0014). Without it,
   * `zenith.json`'s `javaDir` is used when it is set; given, it wins over `javaDir`.
   */
  java?: readonly string[];
}

const schemaFinding = (stepId: string, message: string): Finding => ({
  severity: "error",
  stepId,
  code: "SCHEMA",
  message,
});

/**
 * An auto may name its own robot or field file; when it does, that file wins over the link file's,
 * and a broken override is a finding rather than a crash.
 */
function override<T>(
  project: Project,
  path: string | undefined,
  load: (json: unknown) => T,
  fallback: T,
  findings: Finding[],
): T {
  if (path === undefined) return fallback;
  const full = isAbsolute(path) ? path : join(project.root, path);
  try {
    return load(readJsonFile(full));
  } catch (error) {
    findings.push(
      schemaFinding("(file)", `Cannot use ${path}: ${(error as Error).message.split("\n")[0] ?? ""}`),
    );
    return fallback;
  }
}

export interface ValidateResult {
  findings: Finding[];
  /** Full sentences from `@horizon36596/zenith-seasons` when the field names no plugin this build carries. */
  seasonWarnings: string[];
}

/** One auto's findings, including the schema errors that stop it from being planned at all. */
export function validateAuto(path: string, project: Project): ValidateResult {
  let json: unknown;
  try {
    json = readJsonFile(path);
  } catch (error) {
    return { findings: [schemaFinding("(file)", (error as Error).message)], seasonWarnings: [] };
  }

  try {
    const auto = loadAuto(json);
    assertValidAutoName(auto.name);
    const findings: Finding[] = [];
    const nameMismatch = autoFileNameMismatch(basename(path), auto.name);
    if (nameMismatch !== null) findings.push(schemaFinding("(file)", nameMismatch));
    const robot: Robot = override(project, auto.robot, loadRobot, project.robot, findings);
    const field: Field = override(project, auto.field, loadField, project.field, findings);
    const planned = plan(resolve(auto, project.waypoints, robot), robot, field);
    const season = resolveSeason(field);
    findings.push(...check(planned, estimate(planned, robot), robot, field, season.rules));
    return { findings, seasonWarnings: [...season.warnings] };
  } catch (error) {
    if (error instanceof SchemaError) {
      return {
        findings: error.issues.map((issue) =>
          schemaFinding(
            issue.path.length === 0 ? "(file)" : nearestStepId(json, issue.path),
            `${issue.path.join(".")}: ${issue.message}`,
          ),
        ),
        seasonWarnings: [],
      };
    }
    return {
      findings: [schemaFinding("(file)", error instanceof Error ? error.message : String(error))],
      seasonWarnings: [],
    };
  }
}

const slash = (path: string): string => path.split("\\").join("/");

/** An argument that names an interchange file, with the file already read. */
interface InterchangeArg {
  full: string;
  kind: InterchangeKind;
  doc: unknown;
}

/** The interchange file an argument names, when it names one directly (no project needed to find it). */
function interchangeArg(cwd: string, arg: string): InterchangeArg | null {
  const full = isAbsolute(arg) ? arg : resolvePath(cwd, arg);
  if (!existsSync(full)) return null;
  const read = readInterchange(full);
  return read === null ? null : { full, ...read };
}

/**
 * `zenith validate <file...>`: schema plus checks, exit 1 on any error.
 *
 * Each argument is an auto, or an interchange file (`trajectory.json` or `path.json`, told apart by
 * its `kind` key). An interchange file is checked the way `zenith import` would read it, against
 * the project's field; when every argument is an interchange file and there is no project, each is
 * read against the field its season's package ships, so a planner author can check a file anywhere.
 */
export function runValidate(autos: readonly string[], options: ValidateOptions): number {
  const cwd = options.cwd ?? process.cwd();
  const java = options.java ?? [];
  if (autos.length === 0 && java.length === 0) {
    throw new ProjectError("Name at least one auto to validate, or pass --java <dir> to check robot.json against the robot's Java.");
  }
  const interchange = autos.map((arg) => interchangeArg(cwd, arg));
  // `loadProject` itself now walks up from the first auto argument when there is no zenith.json
  // above the working directory (finding 27) — every verb gets that fallback, not just this one.
  let project: Project | null;
  try {
    project = loadProject(cwd, options.project, autos[0]);
  } catch (error) {
    const onlyInterchange = interchange.every((arg) => arg !== null);
    if (!(error instanceof ProjectError) || !onlyInterchange || options.project !== undefined) throw error;
    project = null;
  }
  const files: FileFindings[] = autos.map((autoArg, index) => {
    const direct = interchange[index] ?? null;
    if (direct !== null) {
      const result = validateInterchange(direct.kind, direct.doc, project?.field ?? null);
      return { path: slash(relative(cwd, direct.full)), kind: direct.kind, findings: result.findings, seasonWarnings: [] };
    }
    // Every argument is an interchange file when there is no project, so there is one here. An
    // interchange file named relative to the project root rather than the working directory is
    // found here too.
    const withProject = project as Project;
    const full = resolveAutoPath(cwd, withProject, autoArg);
    const inProject = existsSync(full) ? readInterchange(full) : null;
    if (inProject !== null) {
      const result = validateInterchange(inProject.kind, inProject.doc, withProject.field);
      return { path: slash(relative(cwd, full)), kind: inProject.kind, findings: result.findings, seasonWarnings: [] };
    }
    const result = validateAuto(full, withProject);
    return { path: slash(relative(cwd, full)), findings: result.findings, seasonWarnings: result.seasonWarnings };
  });
  if (java.length > 0) {
    if (project === null) throw new ProjectError("--java checks robot.json, so it needs a project: run it where zenith.json is, or pass --project <dir>.");
    files.push(registryFileFindings(project, java, cwd));
  } else if (project !== null && javaDirsOf(project.link).length > 0) {
    files.push(configuredRegistryFindings(project, javaDirsOf(project.link), cwd));
  }

  const errors = countErrors(files);
  if (options.json === true) {
    const root = project === null ? null : slash(project.root);
    const body =
      options.explain === true
        ? { project: root, files, errors, help: helpFor(files) }
        : { project: root, files, errors };
    process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
  } else {
    for (const file of files) {
      for (const warning of file.seasonWarnings ?? []) {
        process.stderr.write(`warning: ${file.path}: ${warning}\n`);
      }
    }
    process.stdout.write(`${formatFindingsTable(files)}\n`);
    if (options.explain === true) {
      const explained = formatExplanations(files);
      if (explained.length > 0) process.stdout.write(`${explained}\n`);
    }
  }
  return errors === 0 ? 0 : 1;
}
