import { relative } from "node:path";
import { estimate as coreEstimate, hasErrors, type Estimate } from "@horizon36596/zenith-core";
import { loadAutoAndPlan, resolveAutoPath } from "../autoLoad.js";
import { CORE_NOT_LANDED_EXIT_CODE, tryCore } from "../coreGate.js";
import { formatFindingsTable, type FileFindings } from "../findings.js";
import { loadProject } from "../project.js";

export interface EstimateOptions {
  cwd?: string;
  project?: string;
  json?: boolean;
  explain?: boolean;
}

const slash = (path: string): string => path.split("\\").join("/");
const pad = (text: string, width: number): string => (text.length >= width ? text : text + " ".repeat(width - text.length));

function range(nominalS: number | null, lowS: number | null, highS: number | null): string {
  if (nominalS === null) return "unknown";
  if (lowS === null || highS === null) return nominalS.toFixed(2);
  return `${nominalS.toFixed(2)} (${lowS.toFixed(2)}–${highS.toFixed(2)})`;
}

function formatTable(estimateResult: Estimate, periodS: number | undefined): string {
  const lines: string[] = [];
  const idWidth = Math.max(2, ...estimateResult.steps.map((step) => step.stepId.length));
  lines.push(`${pad("step", idWidth)}  nominal (low–high) s   strafe  unknown`);
  for (const step of estimateResult.steps) {
    const unknown = step.nominalS === null ? "yes" : "";
    const strafe = step.strafeFraction === null ? "–" : `${(step.strafeFraction * 100).toFixed(0)} %`;
    lines.push(`${pad(step.stepId, idWidth)}  ${pad(range(step.nominalS, step.lowS, step.highS), 22)}  ${pad(strafe, 6)}  ${unknown}`);
  }
  const total = `${range(estimateResult.nominalS, estimateResult.lowS, estimateResult.highS)}${estimateResult.hasUnknown ? "+" : ""}`;
  lines.push(periodS === undefined ? `total: ${total}` : `total: ${total} of ${String(periodS)} s`);
  return lines.join("\n");
}

/** `zenith estimate <auto> [--json] [--explain]`: the per-step time table of `03` section 3. */
export function runEstimate(autoArg: string, options: EstimateOptions): number {
  const cwd = options.cwd ?? process.cwd();
  const project = loadProject(cwd, options.project, autoArg);
  const path = resolveAutoPath(cwd, project, autoArg);
  const relPath = slash(relative(project.root, path));
  const result = loadAutoAndPlan(path, project);
  const findings = result.ok ? result.loaded.findings : result.findings;

  if (!result.ok || hasErrors(findings)) {
    const files: FileFindings[] = [{ path: relPath, findings }];
    if (options.json === true) {
      process.stdout.write(`${JSON.stringify({ project: slash(project.root), files, errors: findings.length }, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatFindingsTable(files)}\n`);
    }
    return 1;
  }

  const outcome = tryCore(() => coreEstimate(result.loaded.plan, result.loaded.robot));
  if (!outcome.ok) {
    if (options.json === true) {
      process.stdout.write(`${JSON.stringify({ error: outcome.message }, null, 2)}\n`);
    } else {
      process.stderr.write(`${outcome.message}\n`);
    }
    return CORE_NOT_LANDED_EXIT_CODE;
  }

  const periodS = result.loaded.field.periods?.autoS;
  const seasonWarnings = result.loaded.seasonWarnings;
  if (options.json === true) {
    process.stdout.write(
      `${JSON.stringify(
        {
          project: slash(project.root),
          auto: relPath,
          periodS: periodS ?? null,
          estimate: outcome.value,
          assumptions: options.explain === true ? outcome.value.assumptions : undefined,
          seasonWarnings,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    for (const warning of seasonWarnings) process.stderr.write(`warning: ${relPath}: ${warning}\n`);
    process.stdout.write(`${formatTable(outcome.value, periodS)}\n`);
    if (options.explain === true) {
      process.stdout.write("\nassumptions:\n");
      for (const line of outcome.value.assumptions) process.stdout.write(`  - ${line}\n`);
    }
  }
  return 0;
}
