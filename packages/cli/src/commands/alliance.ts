import { basename, isAbsolute, relative, resolve as resolvePath } from "node:path";
import {
  allianceFixes,
  allianceRobotFromProjection,
  checkAlliance,
  FINDING_HELP,
  mirrorForField,
  ownAllianceRobot,
  type AllianceOptions,
  type AllianceRobot,
  type ClearableAllianceCode,
  type ClearingOffset,
  type Finding,
  type FindingClearingWait,
  type FindingCode,
  type FindingHelp,
  type Pose,
} from "@horizon36596/zenith-core";
import { parseProjection, type Waypoints } from "@horizon36596/zenith-schema";
import { resolveSeason } from "@horizon36596/zenith-seasons";
import { loadAutoAndPlan, resolveAutoPath } from "../autoLoad.js";
import { formatFindingsTable, type FileFindings } from "../findings.js";
import { loadProject, readJsonFile } from "../project.js";

export interface AllianceCommandOptions {
  cwd?: string;
  project?: string;
  json?: boolean;
  /** Seconds the user's robot waits at its start pose before its auto begins. */
  offset?: number;
}

/** One partner as the report names it. */
export interface AlliancePartnerReport {
  path: string;
  label: string;
  alliance: "RED" | "BLUE";
  /** True when the projection was written for the other alliance and was mirrored onto ours. */
  mirrored: boolean;
}

/** What `zenith alliance --json` prints. */
export interface AllianceReport {
  project: string;
  auto: string;
  alliance: "RED" | "BLUE";
  offsetS: number;
  partners: AlliancePartnerReport[];
  findings: Finding[];
  errors: number;
  warnings: number;
  /**
   * The smallest start offset for the user's robot, in 0.1 s steps up to 10 s, that leaves no
   * predicted collision; null when none does. Present only when there is a collision to clear.
   */
  clearingOffset?: ClearingOffset | null;
  /**
   * The editor's "Delay my start" fix for every code it is offered on: for each of
   * ALLIANCE_COLLISION, ALLIANCE_NEAR_MISS and ALLIANCE_ENVELOPE among the findings, the smallest
   * start offset, in 0.1 s steps up to 10 s, that clears every finding of that code without
   * leaving a collision, or null when none does. A code with no finding has no entry.
   * `clearingOffset` is this map's collision entry.
   */
  clearingOffsets: Partial<Record<ClearableAllianceCode, ClearingOffset | null>>;
  /**
   * The editor's "Add a wait step" fix: for each of those findings, by its index in `findings`,
   * the smallest `wait` step, in 0.1 s steps up to 10 s, that clears every finding of its code
   * without leaving a collision when it is put before `wait.stepId`; `wait` is null when none does
   * or the finding names no step.
   */
  clearingWaits: FindingClearingWait[];
  help: Partial<Record<FindingCode, FindingHelp>>;
}

const slash = (path: string): string => path.split("\\").join("/");

/** A file as the person named it: relative to the working directory when inside it, else absolute. */
function displayPath(cwd: string, full: string): string {
  const rel = relative(cwd, full);
  return slash(rel.startsWith("..") || isAbsolute(rel) ? full : rel);
}

/** A usage or IO problem with a projection file, which exits 2 like every other verb's. */
class AllianceInputError extends Error {}

function readPartner(cwd: string, arg: string): { robot: AllianceRobot; path: string } {
  const full = isAbsolute(arg) ? arg : resolvePath(cwd, arg);
  try {
    const projection = parseProjection(readJsonFile(full));
    const label = projection.title ?? basename(full).replace(/\.json$/i, "").replace(/\.projection$/i, "");
    return { robot: allianceRobotFromProjection(projection, label), path: full };
  } catch (error) {
    throw new AllianceInputError(`${arg}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * `zenith alliance <auto> <projection.json...> [--json] [--offset <s>]`: the alliance checks of
 * spec 13 section 9, between the auto and each partner's shared
 * projection.
 *
 * The user's robot is the auto's instant-sim run; every partner is its projection, mirrored onto
 * the auto's alliance when it was written for the other one. The exit code reports the findings
 * for an agent (1 when any is an error, 0 otherwise) and blocks nothing else: these findings are
 * never part of `zenith validate`, deploy or propose. 2 is a usage or IO problem, as everywhere.
 */
export function runAlliance(autoArg: string, projectionArgs: readonly string[], options: AllianceCommandOptions): number {
  const cwd = options.cwd ?? process.cwd();
  const offsetS = options.offset ?? 0;
  if (!Number.isFinite(offsetS) || offsetS < 0) {
    process.stderr.write("zenith alliance: --offset must be a number of seconds, zero or more.\n");
    return 2;
  }
  if (projectionArgs.length === 0) {
    process.stderr.write("zenith alliance: name at least one partner projection file.\n");
    return 2;
  }

  const project = loadProject(cwd, options.project, autoArg);
  const path = resolveAutoPath(cwd, project, autoArg);
  const relPath = slash(relative(project.root, path));
  const result = loadAutoAndPlan(path, project);
  if (!result.ok) {
    // An auto that does not load cannot be simulated, so there is nothing to compare.
    const files: FileFindings[] = [{ path: relPath, findings: result.findings }];
    if (options.json === true) {
      process.stdout.write(`${JSON.stringify({ project: slash(project.root), files, errors: result.findings.length }, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatFindingsTable(files)}\n`);
    }
    return 1;
  }

  let partners: { robot: AllianceRobot; path: string }[];
  try {
    partners = projectionArgs.map((arg) => readPartner(cwd, arg));
  } catch (error) {
    const message = `cannot read a partner projection: ${(error as Error).message}`;
    if (options.json === true) process.stdout.write(`${JSON.stringify({ error: message }, null, 2)}\n`);
    else process.stderr.write(`${message}\n`);
    return 2;
  }

  const { plan, field, auto } = result.loaded;
  const report = allianceReport(
    plan,
    field,
    partners.map((partner) => ({ robot: partner.robot, path: displayPath(cwd, partner.path) })),
    offsetS,
    project.waypoints,
  );
  const full: AllianceReport = { project: slash(project.root), auto: relPath, alliance: auto.alliance, ...report };

  if (options.json === true) {
    process.stdout.write(`${JSON.stringify(full, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatAllianceReport(full)}\n`);
  }
  return full.errors > 0 ? 1 : 0;
}

/**
 * The comparison itself, the one code path `zenith alliance` and the MCP server's
 * `zenith.alliance` share, so both report exactly what core computes: the user's robot from the
 * plan, the season's mirror hook, the field's mirror, and core's `allianceFixes` for the two
 * one-click fixes the editor offers. `waypoints` are the ones the plan was resolved against; the
 * wait fix plans the auto again with them.
 */
export function allianceReport(
  plan: Parameters<typeof ownAllianceRobot>[0],
  field: Parameters<typeof ownAllianceRobot>[1],
  partners: readonly { robot: AllianceRobot; path: string }[],
  offsetS: number,
  waypoints?: Waypoints,
): Omit<AllianceReport, "project" | "auto" | "alliance"> {
  const season = resolveSeason(field).rules;
  const own = ownAllianceRobot(plan, field, season);
  const mirrorId = season.mirrorId;
  const claimPlace = season.claimPlace;
  const options: AllianceOptions = {
    ownStartOffsetS: offsetS,
    mirror: mirrorForField(field),
    ...(mirrorId === undefined ? {} : { mirrorId: (id: string) => mirrorId.call(season, id) }),
    ...(claimPlace === undefined
      ? {}
      : { claimPlace: (elementId: string, pose: Pose) => claimPlace.call(season, field, elementId, pose) }),
  };
  const robots = partners.map((partner) => partner.robot);
  const findings = checkAlliance(own, robots, options);
  const fixes = allianceFixes(
    { plan, ...(waypoints === undefined ? {} : { waypoints }), field, season },
    own,
    robots,
    findings,
    options,
  );
  const help: Partial<Record<FindingCode, FindingHelp>> = {};
  for (const finding of findings) help[finding.code] = FINDING_HELP[finding.code];
  return {
    offsetS,
    partners: partners.map((partner) => ({
      path: partner.path,
      label: partner.robot.label,
      alliance: partner.robot.alliance ?? plan.auto.alliance,
      mirrored: partner.robot.alliance !== undefined && partner.robot.alliance !== plan.auto.alliance,
    })),
    findings,
    errors: findings.filter((finding) => finding.severity === "error").length,
    warnings: findings.filter((finding) => finding.severity === "warning").length,
    ...("ALLIANCE_COLLISION" in fixes.clearingOffsets ? { clearingOffset: fixes.clearingOffsets.ALLIANCE_COLLISION ?? null } : {}),
    clearingOffsets: fixes.clearingOffsets,
    clearingWaits: fixes.clearingWaits,
    help,
  };
}

/** What a fix for each clearable code clears, in a sentence. */
const CLEARS_WHAT: Record<ClearableAllianceCode, string> = {
  ALLIANCE_COLLISION: "every predicted collision",
  ALLIANCE_NEAR_MISS: "every predicted near miss without a collision",
  ALLIANCE_ENVELOPE: "every predicted entry into a partner's envelope without a collision",
};

/** What one finding of each clearable code is called, in a sentence. */
const FINDING_NAME: Record<ClearableAllianceCode, string> = {
  ALLIANCE_COLLISION: "collision",
  ALLIANCE_NEAR_MISS: "near miss",
  ALLIANCE_ENVELOPE: "envelope entry",
};

/** The order the fixes are printed in: the error first. */
const CLEARABLE_ORDER: readonly ClearableAllianceCode[] = ["ALLIANCE_COLLISION", "ALLIANCE_NEAR_MISS", "ALLIANCE_ENVELOPE"];

/** The two fixes as sentences for a person: the start offset for each code, then each wait. */
function formatFixes(report: AllianceReport): string[] {
  const lines: string[] = [];
  for (const code of CLEARABLE_ORDER) {
    if (!(code in report.clearingOffsets)) continue;
    const offset = report.clearingOffsets[code] ?? null;
    lines.push(
      offset === null
        ? `No start offset up to 10 s clears ${CLEARS_WHAT[code]}; add a wait step, move a path or move a start pose instead.`
        : `Delaying your start by ${offset.offsetS.toFixed(1)} s clears ${CLEARS_WHAT[code]}.`,
    );
  }
  for (const { findingIndex, code, wait } of report.clearingWaits) {
    const finding = report.findings[findingIndex];
    if (finding === undefined) continue;
    const at = finding.timeS === undefined ? "" : ` at ${finding.timeS.toFixed(1)} s`;
    const what = `For the ${FINDING_NAME[code]}${at}`;
    if (wait !== null) {
      lines.push(`${what}: a ${wait.seconds.toFixed(1)} s wait before ${wait.stepId} clears ${CLEARS_WHAT[code]}.`);
    } else if (finding.stepId.startsWith("(")) {
      lines.push(`${what}: your robot is not running a step then, so there is no step to wait before. Delay your start instead.`);
    } else {
      lines.push(`${what}: no wait of up to 10 s before the step your robot is running then clears ${CLEARS_WHAT[code]}.`);
    }
  }
  return lines;
}

function formatAllianceReport(report: AllianceReport): string {
  const lines: string[] = [];
  const partners = report.partners
    .map((partner) => `${partner.label} (${partner.path}${partner.mirrored ? `, mirrored from ${partner.alliance}` : ""})`)
    .join(", ");
  lines.push(`${report.auto} as ${report.alliance} with ${partners}`);
  if (report.offsetS > 0) lines.push(`your start delayed by ${report.offsetS.toFixed(1)} s`);
  lines.push(formatFindingsTable([{ path: "predicted alliance findings", findings: report.findings }]));
  lines.push(...formatFixes(report));
  lines.push("These are predictions from two instant-sim runs. They never block validate, deploy or propose.");
  return lines.join("\n");
}
