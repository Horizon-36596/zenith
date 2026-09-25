import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalize, flattenSteps } from "@horizon36596/zenith-core";
import { parseRobot, type PathStep } from "@horizon36596/zenith-schema";
import { loadAutoAndPlan } from "../autoLoad.js";
import { fitCalibration, type CalibrationSample } from "../calibrateFit.js";
import { loadProject, ProjectError, readJsonFile, type Project } from "../project.js";
import { parseTrace } from "../traceReport.js";

export interface CalibrateOptions {
  cwd?: string;
  project?: string;
  json?: boolean;
  traces?: string;
  write?: boolean;
  /** Overrides the provenance date; the CLI reads the clock, `core` never does (CLAUDE.md rule 1). */
  date?: string;
}

/** `TeamCode/build/sim/{auto}.trace.json` -> `TeamCode/build/sim`. `null` when the template has no
 * directory part to strip, so the caller falls back to something else. */
function traceDirFromTemplate(template: string): string | null {
  const slash = template.lastIndexOf("/");
  return slash === -1 ? null : template.slice(0, slash);
}

function defaultTracesDir(project: Project): string | null {
  if (existsSync(join(project.root, "traces"))) return "traces";
  return project.link.sim === undefined ? null : traceDirFromTemplate(project.link.sim.trace);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `zenith calibrate [--traces <dir>] [--write]`: fits `accel`, `settleS` and a per heading-mode
 * scale against every trace it can find (site/docs/simulation.md).
 * `--write` updates the two existing `robot.json.kinematics` fields the schema already has
 * (`accelInPerS2`, `settleS`); the per-mode scale has no field there yet (`@horizon36596/zenith-schema` is not
 * this package's to extend), so it is reported but not persisted.
 */
export function runCalibrate(options: CalibrateOptions): number {
  const cwd = options.cwd ?? process.cwd();
  const project = loadProject(cwd, options.project);

  const tracesDirRel = options.traces ?? defaultTracesDir(project);
  if (tracesDirRel === null) {
    throw new ProjectError(
      "no traces directory to calibrate from: pass --traces <dir>, commit a traces/ directory, or set zenith.json's sim.trace.",
    );
  }
  const tracesDirFull = join(project.root, tracesDirRel);
  if (!existsSync(tracesDirFull)) throw new ProjectError(`no such directory: ${tracesDirRel}`);

  const traceFileNames = readdirSync(tracesDirFull).filter((name) => name.endsWith(".trace.json")).sort();
  const samples: CalibrationSample[] = [];
  const usedTraces: string[] = [];
  const skipped: { file: string; reason: string }[] = [];

  for (const fileName of traceFileNames) {
    let trace;
    try {
      trace = parseTrace(JSON.parse(readFileSync(join(tracesDirFull, fileName), "utf8")) as unknown);
    } catch (error) {
      skipped.push({ file: fileName, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const autoPath = join(project.root, project.link.autosDir, `${trace.auto}.auto.json`);
    if (!existsSync(autoPath)) {
      skipped.push({ file: fileName, reason: `no ${trace.auto}.auto.json in ${project.link.autosDir}` });
      continue;
    }
    const loaded = loadAutoAndPlan(autoPath, project);
    if (!loaded.ok) {
      skipped.push({ file: fileName, reason: `${trace.auto}.auto.json does not load` });
      continue;
    }
    const planSteps = flattenSteps(loaded.loaded.plan.steps);
    let matched = 0;
    for (const traceStep of trace.steps) {
      const planStep = planSteps.find((candidate) => candidate.id === traceStep.id);
      if (planStep === undefined || planStep.kind !== "path") continue;
      const heading = (planStep.step as PathStep).heading?.mode ?? "none";
      samples.push({
        stepId: traceStep.id,
        headingMode: heading,
        lengthIn: planStep.lengthIn,
        actualS: traceStep.endS - traceStep.startS,
      });
      matched += 1;
    }
    if (matched > 0) usedTraces.push(fileName);
  }

  const fit = fitCalibration(samples, project.robot.kinematics.maxForwardVelInPerS.value);

  let written: string | null = null;
  if (options.write === true && fit.sampleCount > 0) {
    const date = options.date ?? new Date().toISOString().slice(0, 10);
    const provenance = `CALIBRATED FROM SIM ${date} (${String(fit.sampleCount)} steps)`;
    const robotRelative = project.link.robot;
    const robotFull = join(project.root, robotRelative);
    const raw = readJsonFile(robotFull);
    if (!isRecord(raw) || !isRecord(raw.kinematics)) {
      throw new ProjectError(`${robotRelative} has no "kinematics" object to write the calibration into.`);
    }
    raw.kinematics.accelInPerS2 = { value: Number(fit.accelInPerS2.toFixed(4)), provenance };
    raw.kinematics.settleS = { value: Number(fit.settleS.toFixed(4)), provenance };
    writeFileSync(robotFull, canonicalize("robot", parseRobot(raw)), "utf8");
    written = robotRelative;
  }

  if (options.json === true) {
    process.stdout.write(
      `${JSON.stringify({ tracesDir: tracesDirRel, usedTraces, skipped, fit, written }, null, 2)}\n`,
    );
    return 0;
  }

  process.stdout.write(`traces: ${tracesDirRel} (${String(usedTraces.length)} used, ${String(skipped.length)} skipped)\n`);
  if (fit.sampleCount === 0) {
    process.stdout.write("no path-step samples to fit; nothing was written.\n");
    return 0;
  }
  process.stdout.write(`accelInPerS2: ${fit.accelInPerS2.toFixed(2)}\n`);
  process.stdout.write(`settleS: ${fit.settleS.toFixed(3)}\n`);
  process.stdout.write("scale by heading mode (reported, not written - robot.json has no field for it yet):\n");
  for (const [mode, scale] of Object.entries(fit.scaleByMode)) {
    process.stdout.write(`  ${mode}: ${scale.toFixed(3)}\n`);
  }
  process.stdout.write(
    `residual band: ${(fit.residualLowFraction * 100).toFixed(0)}% to +${(fit.residualHighFraction * 100).toFixed(0)}% (${String(fit.sampleCount)} steps)\n`,
  );
  process.stdout.write(written === null ? "not written (pass --write)\n" : `written: ${written}\n`);
  return 0;
}
