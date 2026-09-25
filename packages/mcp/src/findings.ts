import {
  check,
  estimate,
  FINDING_HELP,
  loadField,
  loadRobot,
  plan,
  resolve,
  type Finding,
  type FindingCode,
  type FindingHelp,
  type Plan,
} from "@horizon36596/zenith-core";
import { resolveSeason } from "@horizon36596/zenith-seasons";
import type { Auto, Field, Robot } from "@horizon36596/zenith-schema";
import { isAbsolute, join } from "node:path";
import { readJsonFile, type Project } from "./project.js";

/**
 * An auto may name its own robot or field file (`auto.robot`/`auto.field`); when it does, that
 * file wins over `zenith.json`'s, and a broken override becomes a SCHEMA finding rather than a
 * thrown error, the same as `zenith validate` (`packages/cli/src/commands/validate.ts`).
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
    findings.push({
      severity: "error",
      stepId: "(file)",
      code: "SCHEMA",
      message: `Cannot use ${path}: ${(error as Error).message.split("\n")[0] ?? ""}`,
    });
    return fallback;
  }
}

export interface AutoFindings {
  findings: Finding[];
  /** Full sentences from `@horizon36596/zenith-seasons` when the field names no plugin this build carries. */
  seasonWarnings: string[];
}

/** Everything `zenith.estimate` and `zenith.render` need, planned once against the robot and field
 * the auto actually resolves to (its own `robot`/`field` override, when it has one). */
export interface LoadedAuto {
  plan: Plan;
  robot: Robot;
  field: Field;
  findings: Finding[];
  seasonWarnings: string[];
}

/**
 * `auto.name` ends up in filesystem paths and (via `zenith sim`, `packages/cli/src/commands/sim.ts`)
 * a shell command; the CLI enforces this at load time, and every MCP tool that plans an auto goes
 * through `loadAutoAndPlan` below, so the same charset is enforced here too
 * — as an error finding rather than a thrown error, so
 * an agent editing the file sees exactly why, the same as any other SCHEMA problem.
 */
const AUTO_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Resolves `auto.robot`/`auto.field` (falling back to the project's), plans, and runs `check()` —
 * the one shared load every MCP tool that needs a `Plan` should go through, so `zenith.estimate`
 * and `zenith.render` can no longer quietly plan against the project's robot/field while
 * `zenith.validate` (via `findingsForAuto` below) honours the auto's own override.
 */
export function loadAutoAndPlan(auto: Auto, project: Project): LoadedAuto {
  const findings: Finding[] = [];
  if (!AUTO_NAME_PATTERN.test(auto.name)) {
    findings.push({
      severity: "error",
      stepId: "(file)",
      code: "SCHEMA",
      message: `"name" must match ${AUTO_NAME_PATTERN.source} (letters, digits, ".", "_", "-" only); got ${JSON.stringify(auto.name)}.`,
    });
  }
  const robot: Robot = override(project, auto.robot, loadRobot, project.robot, findings);
  const field: Field = override(project, auto.field, loadField, project.field, findings);
  const planned = plan(resolve(auto, project.waypoints), robot, field);
  const season = resolveSeason(field);
  findings.push(...check(planned, estimate(planned, robot), robot, field, season.rules));
  return { plan: planned, robot, field, findings, seasonWarnings: [...season.warnings] };
}

/** Schema plus feasibility findings for a parsed `Auto`, against a project's robot and field. */
export function findingsForAuto(auto: Auto, project: Project): AutoFindings {
  const { findings, seasonWarnings } = loadAutoAndPlan(auto, project);
  return { findings, seasonWarnings };
}

export const errorCount = (findings: readonly Finding[]): number =>
  findings.filter((finding) => finding.severity === "error").length;

export const warningCount = (findings: readonly Finding[]): number =>
  findings.filter((finding) => finding.severity === "warning").length;

/**
 * What each finding code present means and how to fix it (core's `FINDING_HELP`), keyed by code,
 * so an agent explaining a finding to a person uses the same words the editor and
 * `zenith validate --explain` do.
 */
export function helpFor(findings: readonly Finding[]): Partial<Record<FindingCode, FindingHelp>> {
  const help: Partial<Record<FindingCode, FindingHelp>> = {};
  for (const finding of findings) help[finding.code] = FINDING_HELP[finding.code];
  return help;
}
