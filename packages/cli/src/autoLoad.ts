import { existsSync } from "node:fs";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { check, estimate, loadAuto, loadField, loadRobot, plan, resolve, type Finding, type Plan } from "@horizon36596/zenith-core";
import { resolveSeason } from "@horizon36596/zenith-seasons";
import { SchemaError, type Auto, type Field, type Robot } from "@horizon36596/zenith-schema";
import { readJsonFile, type Project } from "./project.js";

/** One auto file, parsed, resolved, planned and checked, ready for a verb to use. */
export interface LoadedAuto {
  path: string;
  auto: Auto;
  robot: Robot;
  field: Field;
  plan: Plan;
  /** Every finding `check()` raised, schema problems included. */
  findings: Finding[];
  /**
   * Full sentences from `@horizon36596/zenith-seasons` when `field.json` names a season plugin this build does
   * not carry (or none at all): the routine still plans and estimates, but every season-dependent
   * check and ledger row is absent, and a caller should say so rather than stay silent about it.
   */
  seasonWarnings: string[];
}

export type LoadAutoResult = { ok: true; loaded: LoadedAuto } | { ok: false; path: string; findings: Finding[] };

const schemaFinding = (stepId: string, message: string): Finding => ({
  severity: "error",
  stepId,
  code: "SCHEMA",
  message,
});

/**
 * `auto.name` is substituted into a shell command (`zenith sim`) and into filesystem paths
 * (`zenith sim --open`, `zenith propose`) elsewhere in this package. Constraining it here, at the
 * one place every verb loads an auto, means every one of those call sites can use the value without
 * re-checking it: no shell metacharacter, path separator or ".." segment can ever reach them
 * through `auto.name`.
 */
export const AUTO_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export function assertValidAutoName(name: string): void {
  if (!AUTO_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid auto file:\n  name: must match ${AUTO_NAME_PATTERN.source} (letters, digits, ".", "_", "-" only); got ${JSON.stringify(name)}.`,
    );
  }
}

/**
 * An auto may name its own robot or field file; when it does, that file wins over the link file's,
 * and a broken override is a finding rather than a crash. Mirrors `commands/validate.ts`'s
 * `override`, kept separate so this module has no dependency on that command.
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

/**
 * Turns a verb's `<auto>` argument into a file path: a path that exists as given, or a bare name
 * resolved against the project's `autosDir`. Falls back to the given path so a bad argument still
 * fails with a plain "cannot read" message rather than a confusing one about the autos directory.
 */
export function resolveAutoPath(cwd: string, project: Project, autoArg: string): string {
  const direct = isAbsolute(autoArg) ? autoArg : resolvePath(cwd, autoArg);
  if (existsSync(direct)) return direct;
  // A path (as opposed to a bare name) may be meant relative to the project root rather than the
  // working directory, e.g. `--project examples/starter` paired with `autos/x.auto.json` when the
  // shell's cwd is the repository root, not the project.
  if (!isAbsolute(autoArg)) {
    const inProject = join(project.root, autoArg);
    if (inProject !== direct && existsSync(inProject)) return inProject;
  }
  const byName = join(project.root, project.link.autosDir, `${autoArg}.auto.json`);
  if (existsSync(byName)) return byName;
  return direct;
}

/**
 * A schema issue's `path` (e.g. `["steps", 4, "segments", 0, "control"]`) names a JSON location,
 * not a step id, so a naive `path.join(".")` used as `Finding.stepId` sends `selectStep` nowhere
 * an agent or the editor can act on (finding 26). This walks the raw (unvalidated) JSON back along
 * the issue's path, remembering the deepest `steps`/`then`/`else` array index it passes through,
 * and returns that step's own `id` when it has one, or its positional id (`step<n>`) otherwise —
 * the same convention `@horizon36596/zenith-core`'s `effectiveId` uses for a top-level, unnamed step.
 */
export function nearestStepId(rawJson: unknown, path: readonly (string | number)[]): string {
  let node: unknown = rawJson;
  let lastStep: unknown;
  let lastIndex = -1;
  const stepListKeys = new Set(["steps", "then", "else"]);
  for (let i = 0; i < path.length; i += 1) {
    const key = path[i];
    if (node === null || typeof node !== "object") break;
    const next = Array.isArray(node)
      ? (node as unknown[])[key as number]
      : (node as Record<string, unknown>)[key as string];
    if (typeof key === "string" && stepListKeys.has(key) && typeof path[i + 1] === "number") {
      const idx = path[i + 1] as number;
      if (Array.isArray(next) && idx >= 0 && idx < next.length) {
        lastStep = next[idx];
        lastIndex = idx;
      }
    }
    node = next;
  }
  if (lastStep !== undefined && lastStep !== null && typeof lastStep === "object") {
    const id = (lastStep as { id?: unknown }).id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return lastIndex >= 0 ? `step${String(lastIndex + 1)}` : "(file)";
}

/** Parses, resolves, plans and checks one auto file. Never throws; schema failures come back as findings. */
export function loadAutoAndPlan(path: string, project: Project): LoadAutoResult {
  let json: unknown;
  try {
    json = readJsonFile(path);
  } catch (error) {
    return { ok: false, path, findings: [schemaFinding("(file)", (error as Error).message)] };
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
    return {
      ok: true,
      loaded: { path, auto, robot, field, plan: planned, findings, seasonWarnings: [...season.warnings] },
    };
  } catch (error) {
    if (error instanceof SchemaError) {
      return {
        ok: false,
        path,
        findings: error.issues.map((issue) =>
          schemaFinding(
            issue.path.length === 0 ? "(file)" : nearestStepId(json, issue.path),
            `${issue.path.join(".")}: ${issue.message}`,
          ),
        ),
      };
    }
    return {
      ok: false,
      path,
      findings: [schemaFinding("(file)", error instanceof Error ? error.message : String(error))],
    };
  }
}
