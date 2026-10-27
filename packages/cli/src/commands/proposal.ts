import { writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve as resolvePath } from "node:path";
import {
  canonicalize,
  check,
  diffProposal,
  diffToMarkdown,
  estimate,
  helpByCode,
  plan,
  readProposal,
  resolve,
  validateProposal,
  type Finding,
  type FindingCode,
  type FindingHelp,
  type ProjectShareInput,
  type ProposalChangeReport,
  type ProposalFinding,
  type ShareStatus,
} from "@horizon36596/zenith-core";
import { resolveSeason } from "@horizon36596/zenith-seasons";
import { parseProjection, type Auto, type Projection } from "@horizon36596/zenith-schema";
import { loadAutoAndPlan, resolveAutoPath, type LoadedAuto } from "../autoLoad.js";
import { formatFindingsTable } from "../findings.js";
import { confinePath, loadProject, readJsonFile, type Project } from "../project.js";

/**
 * `zenith proposal validate` and `zenith proposal apply`: the two sides of a proposed change to a
 * shared auto (spec 13 section 14). The proposer checks its proposal
 * against the projection it was given before sending it; the owner reviews one against its own
 * auto and, only with `--write`, makes the changes it accepts.
 *
 * Exit codes follow every other verb: 0 ok, 1 the proposal is refused or an accepted change cannot
 * be made (or the result has error findings), 2 a usage or IO problem.
 */

const SHARE_STATUSES: readonly ShareStatus[] = ["live", "revoked", "expired"];

const slash = (path: string): string => path.split("\\").join("/");

/** A file as the person named it: relative to the working directory when inside it, else absolute. */
function displayPath(cwd: string, full: string): string {
  const rel = relative(cwd, full);
  return slash(rel.startsWith("..") || isAbsolute(rel) ? full : rel);
}

const errorsIn = (findings: readonly Finding[]): number => findings.filter((finding) => finding.severity === "error").length;

/** The help for each code these findings raise, in the words for its most severe finding (`helpByCode`). */
const helpFor = (findings: readonly Finding[]): Partial<Record<FindingCode, FindingHelp>> => helpByCode(findings);

/** A usage problem: said once, on stderr or as JSON, with exit code 2. */
function usage(verb: string, message: string, json: boolean | undefined): number {
  if (json === true) process.stdout.write(`${JSON.stringify({ error: `zenith proposal ${verb}: ${message}` }, null, 2)}\n`);
  else process.stderr.write(`zenith proposal ${verb}: ${message}\n`);
  return 2;
}

function shareStatus(value: string | undefined): ShareStatus | null {
  if (value === undefined) return "live";
  return (SHARE_STATUSES as readonly string[]).includes(value) ? (value as ShareStatus) : null;
}

// ------------------------------------------------------------------------------------------------
// zenith proposal validate
// ------------------------------------------------------------------------------------------------

export interface ProposalValidateOptions {
  cwd?: string;
  json?: boolean;
  /** The state of the share: live (the default), revoked or expired. */
  share?: string;
}

/** What `zenith proposal validate --json` prints. */
export interface ProposalValidateReport {
  proposal: string;
  projection: string;
  share: ShareStatus;
  /** True when the proposal can be sent: no findings at all. */
  ok: boolean;
  changes: number;
  findings: ProposalFinding[];
  errors: number;
  help: Partial<Record<FindingCode, FindingHelp>>;
}

/**
 * `zenith proposal validate <proposal.json> <projection.json> [--share <state>] [--json]`: whether
 * a proposal can be sent against the projection it was made from. Every refusal is a sentence
 * saying why: a view share, a revoked or expired share, a stale structure, a token the share did
 * not hold, or a change its step cannot take.
 */
export function runProposalValidate(proposalArg: string, projectionArg: string, options: ProposalValidateOptions): number {
  const cwd = options.cwd ?? process.cwd();
  const share = shareStatus(options.share);
  if (share === null) return usage("validate", `--share must be one of ${SHARE_STATUSES.join(", ")}.`, options.json);

  const proposalPath = isAbsolute(proposalArg) ? proposalArg : resolvePath(cwd, proposalArg);
  const projectionPath = isAbsolute(projectionArg) ? projectionArg : resolvePath(cwd, projectionArg);
  let proposalJson: unknown;
  let projection: Projection;
  try {
    proposalJson = readJsonFile(proposalPath);
  } catch (error) {
    return usage("validate", (error as Error).message, options.json);
  }
  try {
    projection = parseProjection(readJsonFile(projectionPath));
  } catch (error) {
    return usage("validate", `${projectionArg} is not a projection: ${(error as Error).message}`, options.json);
  }

  const findings = validateProposal(proposalJson, projection, { share });
  const read = readProposal(proposalJson);
  const report: ProposalValidateReport = {
    proposal: displayPath(cwd, proposalPath),
    projection: displayPath(cwd, projectionPath),
    share,
    ok: findings.length === 0,
    changes: read.proposal?.changes.length ?? 0,
    findings,
    errors: errorsIn(findings),
    help: helpFor(findings),
  };

  if (options.json === true) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (report.ok) {
    const count = `${String(report.changes)} change${report.changes === 1 ? "" : "s"}`;
    process.stdout.write(`${report.proposal}: ${count}, all of which fit ${report.projection}; it can be sent.\n`);
  } else {
    process.stdout.write(`${formatFindingsTable([{ path: report.proposal, findings }])}\n`);
  }
  return report.errors > 0 ? 1 : 0;
}

// ------------------------------------------------------------------------------------------------
// zenith proposal apply
// ------------------------------------------------------------------------------------------------

export interface ProposalApplyOptions {
  cwd?: string;
  project?: string;
  json?: boolean;
  /** The auto as it was at the revision the share is pinned to; the auto itself when not given. */
  base?: string;
  /** `all`, or change numbers counted from 1, such as `1,2,5`. */
  accept?: string;
  /** Write the result in place. Without it, nothing is written. */
  write?: boolean;
  share?: string;
}

/** What `zenith proposal apply --json` prints. */
export interface ProposalApplyReport {
  project: string;
  auto: string;
  base: string;
  proposal: string;
  /** The change numbers accepted, counted from 1. */
  accepted: number[];
  changes: ProposalChangeReport[];
  findings: ProposalFinding[];
  errors: number;
  diff: ReturnType<typeof diffProposal>["diff"];
  /** The findings `zenith validate` would give the auto with the accepted changes. */
  validation: { findings: Finding[]; errors: number };
  /** The file written, or null on a dry run or when nothing could be written. */
  written: string | null;
  help: Partial<Record<FindingCode, FindingHelp>>;
}

/** `all` or `1,2,5` as 0-based indexes, or null when it is neither. */
function acceptedIndexes(value: string | undefined, count: number): number[] | null {
  if (value === undefined || value.trim().toLowerCase() === "all") return Array.from({ length: count }, (_, index) => index);
  if (value.trim() === "" || value.trim().toLowerCase() === "none") return [];
  const parts = value.split(",").map((part) => part.trim());
  if (!parts.every((part) => /^[1-9][0-9]*$/.test(part))) return null;
  return [...new Set(parts.map((part) => Number(part) - 1))].sort((a, b) => a - b);
}

/** What the project's own pipeline says about an auto held in memory, as `validate` would. */
function checkInMemory(auto: Auto, loaded: LoadedAuto, project: Project) {
  const planned = plan(resolve(auto, project.waypoints, loaded.robot), loaded.robot, loaded.field);
  const estimated = estimate(planned, loaded.robot);
  const findings = check(planned, estimated, loaded.robot, loaded.field, resolveSeason(loaded.field).rules);
  return { findings, estimated };
}

/**
 * `zenith proposal apply <auto> <proposal.json> [--base <auto>] [--accept all|1,2,5] [--share <state>]
 * [--write] [--json]`: the owner's review. The proposal's opaque ids and tokens are mapped back
 * through the pinned revision (`--base`, or the auto itself when the share was made from it as it
 * is), each change is marked applied, not accepted, a conflict or invalid, and the diff between the
 * auto and the auto with the accepted changes is printed. A dry run by default: only `--write`
 * writes the auto, in canonical form, and only with `--accept` naming at least one change and nothing
 * that cannot be made.
 */
export function runProposalApply(autoArg: string, proposalArg: string, options: ProposalApplyOptions): number {
  const cwd = options.cwd ?? process.cwd();
  const share = shareStatus(options.share);
  if (share === null) return usage("apply", `--share must be one of ${SHARE_STATUSES.join(", ")}.`, options.json);
  if (options.write === true && options.accept === undefined) {
    return usage("apply", "--write needs --accept, naming the changes to accept (all, or numbers such as 1,2,5).", options.json);
  }

  const project = loadProject(cwd, options.project, autoArg);
  const path = resolveAutoPath(cwd, project, autoArg);
  const loaded = loadAutoAndPlan(path, project);
  const basePath = options.base === undefined ? path : resolveAutoPath(cwd, project, options.base);
  const base = options.base === undefined ? loaded : loadAutoAndPlan(basePath, project);
  for (const each of [loaded, base]) {
    if (!each.ok) {
      const file = slash(relative(project.root, each.path));
      if (options.json === true) process.stdout.write(`${JSON.stringify({ project: slash(project.root), files: [{ path: file, findings: each.findings }] }, null, 2)}\n`);
      else process.stdout.write(`${formatFindingsTable([{ path: file, findings: each.findings }])}\n`);
      return 1;
    }
  }
  if (!loaded.ok || !base.ok) return 1;

  const proposalPath = isAbsolute(proposalArg) ? proposalArg : resolvePath(cwd, proposalArg);
  let proposalJson: unknown;
  try {
    proposalJson = readJsonFile(proposalPath);
  } catch (error) {
    return usage("apply", (error as Error).message, options.json);
  }
  const read = readProposal(proposalJson);
  const accepted = acceptedIndexes(options.accept, read.proposal?.changes.length ?? 0);
  if (accepted === null) return usage("apply", "--accept takes all, none, or change numbers from 1 such as 1,2,5.", options.json);

  // Only the structure is compared, and it needs no trace, so none is run for the pinned revision.
  const pinned: ProjectShareInput = {
    plan: base.loaded.plan,
    trace: { poses: [], steps: [], simTimeS: 0 },
    robot: base.loaded.robot,
    field: base.loaded.field,
  };
  const review = diffProposal(loaded.loaded.auto, pinned, { level: "propose" }, proposalJson, {
    share,
    waypoints: project.waypoints,
    currentPlan: loaded.loaded.plan,
    accepted,
  });
  const errors = errorsIn(review.findings);
  const validation = checkInMemory(review.proposed, loaded.loaded, project);

  // With no change accepted there is nothing to make, so the file is left exactly as it is.
  let written: string | null = null;
  if (options.write === true && errors === 0 && accepted.length > 0) {
    writeFileSync(confinePath(project.root, path), canonicalize("auto", review.proposed), "utf8");
    written = slash(relative(project.root, path));
  }

  const report: ProposalApplyReport = {
    project: slash(project.root),
    auto: slash(relative(project.root, path)),
    base: slash(relative(project.root, basePath)),
    proposal: displayPath(cwd, proposalPath),
    accepted: accepted.map((index) => index + 1),
    changes: review.changes,
    findings: review.findings,
    errors,
    diff: review.diff,
    validation: { findings: validation.findings, errors: errorsIn(validation.findings) },
    written,
    help: helpFor([...review.findings, ...validation.findings]),
  };

  if (options.json === true) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const before = estimate(loaded.loaded.plan, loaded.loaded.robot);
    process.stdout.write(`${formatApplyReport(report, diffToMarkdown(review.diff, before, validation.estimated), options.write === true)}\n`);
  }
  return errors > 0 || report.validation.errors > 0 ? 1 : 0;
}

function formatApplyReport(report: ProposalApplyReport, diffText: string, wantedWrite: boolean): string {
  const lines: string[] = [`${report.auto} with the proposal ${report.proposal}${report.base === report.auto ? "" : `, shared from ${report.base}`}`];
  if (report.changes.length > 0) {
    const width = Math.max(...report.changes.map((change) => change.status.length));
    lines.push("", "Changes");
    for (const change of report.changes) {
      const comment = change.comment === undefined ? "" : ` Comment: ${change.comment}`;
      lines.push(`  ${String(change.number).padStart(3)}. ${change.status.padEnd(width)}  ${change.summary}${comment}`);
    }
  }
  if (report.findings.length > 0) lines.push("", formatFindingsTable([{ path: "proposal findings", findings: report.findings }]));
  lines.push("", "Diff", diffText);
  if (report.validation.findings.length > 0) {
    lines.push("", formatFindingsTable([{ path: "the auto with the accepted changes", findings: report.validation.findings }]));
  }
  lines.push("");
  if (report.written !== null) lines.push(`Wrote ${report.written}.`);
  else if (report.accepted.length === 0) lines.push("Nothing was written, because no change was accepted.");
  else if (wantedWrite) lines.push("Nothing was written, because an accepted change cannot be made; accept only the changes marked applied.");
  else lines.push("Dry run: nothing was written. Pass --accept and --write to make the accepted changes.");
  return lines.join("\n");
}
