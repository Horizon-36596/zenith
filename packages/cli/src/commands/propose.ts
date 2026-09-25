import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { estimate as coreEstimate, hasErrors, ledger as coreLedger, prBody, render as coreRender } from "@horizon36596/zenith-core";
import { resolveSeason } from "@horizon36596/zenith-seasons";
import { loadAutoAndPlan, resolveAutoPath } from "../autoLoad.js";
import { tryCore } from "../coreGate.js";
import { formatFindingsTable, type FileFindings } from "../findings.js";
import { confinePath, loadProject } from "../project.js";

export interface ProposeOptions {
  cwd?: string;
  project?: string;
  json?: boolean;
  dryRun?: boolean;
  base?: string;
}

const slash = (path: string): string => path.split("\\").join("/");

/**
 * `zenith propose <auto> [--dry-run]`: the CLI half of site/docs/github.md. The GitHub half (a work
 * branch, a commit, an actual pull request) is another agent's (`packages/github`); today only
 * `--dry-run` is implemented, exactly as section 5 describes for an agent that may not push:
 * validate, render, print the PR body for a human to paste.
 */
export function runPropose(autoArg: string, options: ProposeOptions): number {
  if (options.dryRun !== true) {
    process.stderr.write("GitHub mode: use the web app or pass --dry-run.\n");
    return 2;
  }

  const cwd = options.cwd ?? process.cwd();
  const project = loadProject(cwd, options.project, autoArg);
  const path = resolveAutoPath(cwd, project, autoArg);
  const result = loadAutoAndPlan(path, project);
  const findings = result.ok ? result.loaded.findings : result.findings;

  if (!result.ok || hasErrors(findings)) {
    const files: FileFindings[] = [{ path: autoArg, findings }];
    if (options.json === true) process.stdout.write(`${JSON.stringify({ files }, null, 2)}\n`);
    else process.stdout.write(`${formatFindingsTable(files)}\n`);
    return 1;
  }
  const { auto, plan, robot, field, seasonWarnings } = result.loaded;

  const estimateOutcome = tryCore(() => coreEstimate(plan, robot));
  const ledgerOutcome = tryCore(() => coreLedger(plan, field, resolveSeason(field).rules));
  const renderOutcome = tryCore(() => coreRender(plan, estimateOutcome.ok ? estimateOutcome.value : null, findings, ledgerOutcome.ok ? ledgerOutcome.value : [], {}));

  if (!renderOutcome.ok) {
    const message = [renderOutcome.message, !estimateOutcome.ok ? estimateOutcome.message : null, !ledgerOutcome.ok ? ledgerOutcome.message : null]
      .filter((line): line is string => line !== null)
      .join("\n");
    if (options.json === true) process.stdout.write(`${JSON.stringify({ error: message }, null, 2)}\n`);
    else process.stderr.write(`${message}\n`);
    return 2;
  }

  const renderRelative = `${project.link.autosDir}/.renders/${auto.name}.svg`;
  const renderFull = confinePath(project.root, renderRelative);
  mkdirSync(dirname(renderFull), { recursive: true });
  writeFileSync(renderFull, renderOutcome.value, "utf8");

  // No commit has happened in --dry-run mode, so there is no raw GitHub URL to point at (that is
  // packages/github's propose() once GitHub mode lands); the local render path is the closest
  // useful thing to show a human in the meantime, passed straight in rather than substituted after
  // the fact.
  const body = prBody(
    auto,
    estimateOutcome.ok ? estimateOutcome.value : null,
    findings,
    ledgerOutcome.ok ? ledgerOutcome.value : [],
    { periodS: field.periods?.autoS, renderUrl: slash(renderRelative) },
  );

  if (options.json === true) {
    process.stdout.write(`${JSON.stringify({ render: renderRelative, body, seasonWarnings }, null, 2)}\n`);
  } else {
    for (const warning of seasonWarnings) process.stderr.write(`warning: ${autoArg}: ${warning}\n`);
    process.stdout.write(`${body}\n`);
  }
  return 0;
}
