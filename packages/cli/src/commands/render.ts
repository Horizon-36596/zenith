import { writeFileSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import {
  estimate as coreEstimate,
  ledger as coreLedger,
  render as coreRender,
  type RenderOptions as CoreRenderOptions,
} from "@horizon36596/zenith-core";
import { resolveSeason } from "@horizon36596/zenith-seasons";
import { loadAutoAndPlan, resolveAutoPath } from "../autoLoad.js";
import { CORE_NOT_LANDED_EXIT_CODE, tryCore } from "../coreGate.js";
import { fieldImageFor } from "../fieldImage.js";
import { formatFindingsTable, type FileFindings } from "../findings.js";
import { loadProject, ProjectError } from "../project.js";

export interface RenderCommandOptions {
  cwd?: string;
  project?: string;
  json?: boolean;
  svg?: string;
  png?: string;
  alliance?: string;
  base?: string;
}

/**
 * `zenith render <auto> --svg <out> | --png <out> [--alliance BLUE] [--base <otherAuto>]`.
 * `--png` shells out to `@resvg/resvg-js`, a CLI-only dependency (`core` stays DOM-free); it is
 * imported lazily so `--svg` never needs it installed.
 */
export async function runRender(autoArg: string, options: RenderCommandOptions): Promise<number> {
  if (options.svg === undefined && options.png === undefined) {
    throw new ProjectError("zenith render needs --svg <out> or --png <out>.");
  }
  const cwd = options.cwd ?? process.cwd();
  const project = loadProject(cwd, options.project, autoArg);
  const path = resolveAutoPath(cwd, project, autoArg);
  const result = loadAutoAndPlan(path, project);
  if (!result.ok) {
    const files: FileFindings[] = [{ path: autoArg, findings: result.findings }];
    process.stdout.write(options.json === true ? `${JSON.stringify({ files }, null, 2)}\n` : `${formatFindingsTable(files)}\n`);
    return 1;
  }
  const { plan, robot, field, findings, seasonWarnings } = result.loaded;

  let alliance: "RED" | "BLUE" | undefined;
  if (options.alliance !== undefined) {
    const upper = options.alliance.toUpperCase();
    if (upper !== "RED" && upper !== "BLUE") {
      throw new ProjectError(`--alliance must be RED or BLUE, not ${JSON.stringify(options.alliance)}.`);
    }
    alliance = upper;
  }

  if (options.base !== undefined) {
    const basePath = resolveAutoPath(cwd, project, options.base);
    const baseResult = loadAutoAndPlan(basePath, project);
    if (!baseResult.ok) {
      process.stderr.write(`--base ${options.base} did not load: ${baseResult.findings[0]?.message ?? "unknown error"}\n`);
      return 2;
    }
    // core.render's current signature (packages/core/src/types.ts RenderOptions) has no field for a
    // second plan to ghost. The auto still has to load cleanly - that much is worth checking now -
    // but the overlay itself waits on that option landing with the rest of M1.
    process.stderr.write("note: --base loaded but core.render does not yet support a base overlay (pending M1).\n");
  }

  const estimateOutcome = tryCore(() => coreEstimate(plan, robot));
  const estimateValue = estimateOutcome.ok ? estimateOutcome.value : null;
  const ledgerOutcome = tryCore(() => coreLedger(plan, field, resolveSeason(field).rules));
  const ledgerValue = ledgerOutcome.ok ? ledgerOutcome.value : [];

  const fieldImage = fieldImageFor(project, field, plan.auto.field ?? project.link.field);
  const renderOptions: CoreRenderOptions = {
    ...(alliance === undefined ? {} : { alliance }),
    ...(fieldImage === undefined ? {} : { fieldImage }),
  };
  const renderOutcome = tryCore(() => coreRender(plan, estimateValue, findings, ledgerValue, renderOptions));
  if (!renderOutcome.ok) {
    if (options.json === true) process.stdout.write(`${JSON.stringify({ error: renderOutcome.message }, null, 2)}\n`);
    else process.stderr.write(`${renderOutcome.message}\n`);
    return CORE_NOT_LANDED_EXIT_CODE;
  }
  const svgText = renderOutcome.value;

  const written: { path: string; kind: "svg" | "png" }[] = [];
  const outPath = (relativeOrAbsolute: string): string =>
    isAbsolute(relativeOrAbsolute) ? relativeOrAbsolute : resolvePath(cwd, relativeOrAbsolute);

  if (options.svg !== undefined) {
    writeFileSync(outPath(options.svg), svgText, "utf8");
    written.push({ path: options.svg, kind: "svg" });
  }
  if (options.png !== undefined) {
    const { Resvg } = await import("@resvg/resvg-js");
    const png = new Resvg(svgText, { font: { loadSystemFonts: true } }).render().asPng();
    writeFileSync(outPath(options.png), png);
    written.push({ path: options.png, kind: "png" });
  }

  if (options.json === true) {
    process.stdout.write(`${JSON.stringify({ written, findings, seasonWarnings }, null, 2)}\n`);
  } else {
    for (const warning of seasonWarnings) process.stderr.write(`warning: ${autoArg}: ${warning}\n`);
    for (const file of written) process.stdout.write(`written: ${file.path}\n`);
  }
  return 0;
}
