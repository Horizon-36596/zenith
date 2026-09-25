import { isAbsolute, join, relative } from "node:path";
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
import { SchemaError, type Field, type Robot } from "@horizon36596/zenith-schema";
import { assertValidAutoName, nearestStepId, resolveAutoPath } from "../autoLoad.js";
import {
  countErrors,
  formatExplanations,
  formatFindingsTable,
  helpFor,
  type FileFindings,
} from "../findings.js";
import { loadProject, readJsonFile, type Project } from "../project.js";

export interface ValidateOptions {
  json?: boolean;
  /** Say what each finding code means and how to fix it (`FINDING_HELP`). */
  explain?: boolean;
  project?: string;
  cwd?: string;
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
    const robot: Robot = override(project, auto.robot, loadRobot, project.robot, findings);
    const field: Field = override(project, auto.field, loadField, project.field, findings);
    const planned = plan(resolve(auto, project.waypoints), robot, field);
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

/** `zenith validate <auto...>`: schema plus checks, exit 1 on any error. */
export function runValidate(autos: readonly string[], options: ValidateOptions): number {
  const cwd = options.cwd ?? process.cwd();
  // `loadProject` itself now walks up from the first auto argument when there is no zenith.json
  // above the working directory (finding 27) — every verb gets that fallback, not just this one.
  const project = loadProject(cwd, options.project, autos[0]);
  const files: FileFindings[] = autos.map((autoArg) => {
    const full = resolveAutoPath(cwd, project, autoArg);
    const result = validateAuto(full, project);
    return { path: slash(relative(cwd, full)), findings: result.findings, seasonWarnings: result.seasonWarnings };
  });

  const errors = countErrors(files);
  if (options.json === true) {
    const body =
      options.explain === true
        ? { project: slash(project.root), files, errors, help: helpFor(files) }
        : { project: slash(project.root), files, errors };
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
