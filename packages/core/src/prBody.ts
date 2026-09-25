import type { Auto, Step } from "@horizon36596/zenith-schema";
import { walkSteps } from "./diff.js";
import type { Estimate, Finding, LedgerRow, StepEstimate } from "./types.js";

/**
 * The pull request body of site/docs/github.md: the name, what the
 * routine does, the committed render, a table of steps with their estimates and strafe, the totals
 * against the autonomous period, the ledger at the end and whether the simulator was run.
 *
 * It is built in core rather than in the CLI or the GitHub client so that `zenith propose`, the
 * editor's Propose button and the review bot all write the same body, and so that the body can be
 * tested without a network.
 */

/** The FTC autonomous period, used when the caller does not pass the field's own number. */
export const DEFAULT_PERIOD_S = 30;

export interface PrBodyOptions {
  /** Where the committed SVG lives, usually `autos/.renders/<name>.svg` on the work branch. */
  renderUrl?: string;
  /** One line about the simulator run, or nothing, which reads as "not run". */
  simSummary?: string;
  /** The autonomous period in seconds, from `field.periods.autoS`. */
  periodS?: number;
}

const EN_DASH = "–";
const MIDDLE_DOT = "·";

/** A markdown table cell: a pipe in a step's detail would otherwise end the column. */
const cell = (text: string): string => text.split("|").join("\\|");

const oneDecimal = (value: number): string => value.toFixed(1);

/** `2.5 (2.0–3.0)`, or `2.5` when the band is the whole estimate's and adds nothing here. */
function estimateCell(step: StepEstimate | undefined, until: string | null): string {
  if (step === undefined || step.nominalS === null) {
    return until === null ? "unknown" : `unknown (until ${until})`;
  }
  const band =
    step.lowS === null || step.highS === null
      ? ""
      : ` (${oneDecimal(step.lowS)}${EN_DASH}${oneDecimal(step.highS)})`;
  const tail = until === null ? "" : ` (until ${until})`;
  return `${oneDecimal(step.nominalS)}${band}${tail}`;
}

/** Strafe is only a question on a path step; everything else gets a dash. */
const strafeCell = (step: StepEstimate | undefined): string =>
  step === undefined || step.kind !== "path" || step.strafeFraction === null
    ? EN_DASH
    : `${String(Math.round(step.strafeFraction * 100))} %`;

/** The condition a step runs until, which is why it has no estimate. */
function until(step: Step): string | null {
  if (step.kind === "wait") return step.until ?? null;
  if (step.kind === "path") return step.endCondition?.condition ?? null;
  return null;
}

const plural = (count: number, noun: string): string =>
  `${String(count)} ${noun}${count === 1 ? "" : "s"}`;

/** `1 error, 2 warnings`, leaving out the kinds there are none of; empty when the step is clean. */
function findingsCell(findings: readonly Finding[]): string {
  const codes = findings
    .filter((finding) => finding.severity !== "info")
    .map((finding) => `${finding.severity}: ${finding.code}`);
  return [...new Set(codes)].join(", ");
}

function countsLine(findings: readonly Finding[]): string {
  const of = (severity: Finding["severity"]): number =>
    findings.filter((finding) => finding.severity === severity).length;
  return `${plural(of("error"), "error")}, ${plural(of("warning"), "warning")}`;
}

/**
 * The share of the driving that was sideways, weighted by how long each path step takes, because a
 * long leg at 40 % matters more than a short one at 80 %.
 */
function overallStrafe(estimate: Estimate | null): string {
  if (estimate === null) return EN_DASH;
  let weighted = 0;
  let total = 0;
  for (const step of estimate.steps) {
    if (step.kind !== "path" || step.strafeFraction === null || step.nominalS === null) continue;
    weighted += step.strafeFraction * step.nominalS;
    total += step.nominalS;
  }
  return total === 0 ? EN_DASH : `${String(Math.round((weighted / total) * 100))} %`;
}

/** The body of the pull request a proposal opens (`06` section 3). */
export function prBody(
  auto: Auto,
  estimate: Estimate | null,
  findings: readonly Finding[],
  ledgerRows: readonly LedgerRow[],
  options: PrBodyOptions = {},
): string {
  const periodS = options.periodS ?? DEFAULT_PERIOD_S;
  const byStep = new Map<string, Finding[]>();
  for (const finding of findings) {
    byStep.set(finding.stepId, [...(byStep.get(finding.stepId) ?? []), finding]);
  }

  const lines: string[] = [`## ${auto.name}`, ""];
  const description = auto.description ?? auto.title;
  if (description !== undefined && description !== "") lines.push(description, "");
  if (options.renderUrl !== undefined && options.renderUrl !== "") {
    lines.push(`![render](${options.renderUrl})`, "");
  }

  lines.push("| step | estimate (s) | strafe | findings |", "|---|---|---|---|");
  // Only the top-level steps get a row: a parallel group's children are its own business, and the
  // group's estimate already covers them.
  for (const entry of walkSteps(auto.steps).filter((step) => step.list === "steps")) {
    const step = estimate?.byStepId[entry.id];
    lines.push(
      `| ${cell(entry.id)} | ${estimateCell(step, until(entry.step))} | ${strafeCell(step)} | ${cell(findingsCell(byStep.get(entry.id) ?? []))} |`,
    );
  }

  const nominal = estimate?.nominalS ?? null;
  const low = estimate?.lowS ?? null;
  const high = estimate?.highS ?? null;
  const band = low === null || high === null ? "" : ` (${oneDecimal(low)}${EN_DASH}${oneDecimal(high)})`;
  // A routine with a step that has no estimate can only be given a floor, so the total says so
  // rather than pretending the number is the whole of it.
  const floor = estimate?.hasUnknown === true ? "at least " : "";
  const total =
    nominal === null
      ? `unknown of ${String(periodS)}`
      : `${floor}${oneDecimal(nominal)}${band} of ${String(periodS)}`;
  lines.push(
    `| **total** | **${total}** | **${overallStrafe(estimate)}** | ${countsLine(findings)} |`,
    "",
  );

  const end = ledgerRows.filter((row) => row.stepId === "end");
  if (end.length > 0) {
    const detail = end
      .map((row) => `${row.label}${row.detail === undefined ? "" : ` ${row.detail}`}`)
      .join(` ${MIDDLE_DOT} `);
    lines.push(`Ledger at end: ${detail}`);
  }
  lines.push(`Sim: ${options.simSummary ?? "not run"}`);

  return `${lines.join("\n").trim()}\n`;
}
