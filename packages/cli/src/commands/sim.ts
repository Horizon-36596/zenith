import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { estimate as coreEstimate, ledger as coreLedger, render as coreRender } from "@horizon36596/zenith-core";
import { resolveSeason } from "@horizon36596/zenith-seasons";
import { loadAutoAndPlan, resolveAutoPath } from "../autoLoad.js";
import { tryCore } from "../coreGate.js";
import { formatFindingsTable, type FileFindings } from "../findings.js";
import { hostPlatform, resolveLauncher, type Platform, type SimLaunch } from "../launcher.js";
import { confinePath, loadProject, ProjectError } from "../project.js";
import { buildSimReport, parseTrace, type SimReport, TraceParseError } from "../traceReport.js";

/**
 * Splits a command line into argv words the way a POSIX shell would, without ever handing the
 * string to a shell: single quotes are fully literal, double quotes allow `\"`, `\\`, `` \` `` and
 * `\$` to escape, and an unquoted backslash escapes the next character. `sim.command` in
 * `zenith.json` is the team's own string (not attacker input), so this only needs to parse it the
 * way a person reading it would, not defend against a hostile one; the actual security boundary is
 * that `{auto}` is substituted in only after `auto.name` has already been validated against
 * `AUTO_NAME_PATTERN`, so no token it lands in can ever contain a quote, space or shell
 * metacharacter, and the whole argv array is then spawned with `shell: false`.
 */
export function splitShellWords(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let has = false;
  let i = 0;
  const push = (): void => {
    if (has) words.push(current);
    current = "";
    has = false;
  };
  while (i < command.length) {
    const ch = command[i] as string;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      push();
      i += 1;
      continue;
    }
    if (ch === "'") {
      has = true;
      i += 1;
      while (i < command.length && command[i] !== "'") {
        current += command[i];
        i += 1;
      }
      i += 1;
      continue;
    }
    if (ch === '"') {
      has = true;
      i += 1;
      while (i < command.length && command[i] !== '"') {
        const next = command[i];
        if (next === "\\" && i + 1 < command.length && '"\\$`'.includes(command[i + 1] as string)) {
          current += command[i + 1];
          i += 2;
        } else {
          current += next;
          i += 1;
        }
      }
      i += 1;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      current += command[i + 1];
      i += 2;
      has = true;
      continue;
    }
    current += ch;
    has = true;
    i += 1;
  }
  push();
  return words;
}

export interface SimCommandOptions {
  cwd?: string;
  project?: string;
  json?: boolean;
  open?: boolean;
  /** Seconds. The sim command is killed if it runs longer than this. */
  timeout?: number;
  /** Test seam: replaces `node:child_process.spawn`. */
  spawnFn?: typeof spawn;
  /** Test seam: the host the launcher resolves the command for (`launcher.ts`). */
  host?: Platform;
}

const pad = (text: string, width: number): string => (text.length >= width ? text : text + " ".repeat(width - text.length));

function formatReport(report: SimReport): string {
  const lines: string[] = [];
  const idWidth = Math.max(2, ...report.steps.map((step) => step.id.length));
  lines.push(`${pad("step", idWidth)}  nominal s  actual s  delta s  max cross-track in`);
  for (const step of report.steps) {
    const nominal = step.estimateNominalS === null ? "–" : step.estimateNominalS.toFixed(2);
    const delta = step.deltaS === null ? "–" : (step.deltaS >= 0 ? "+" : "") + step.deltaS.toFixed(2);
    const cross = step.maxCrossTrackIn === null ? "–" : step.maxCrossTrackIn.toFixed(2);
    const interrupted = step.interrupted ? " (interrupted)" : "";
    lines.push(`${pad(step.id, idWidth)}  ${pad(nominal, 9)}  ${pad(step.actualS.toFixed(2), 8)}  ${pad(delta, 7)}  ${cross}${interrupted}`);
  }
  lines.push("");
  lines.push(`total: estimate ${report.totalEstimateS === null ? "unknown" : report.totalEstimateS.toFixed(2)} s, actual ${report.totalActualS.toFixed(2)} s`);
  lines.push(`structure contacts: ${String(report.structureContacts)}, launches: ${String(report.launches)}, held at end: ${report.heldAtEnd === null ? "unknown" : String(report.heldAtEnd)}`);
  if (Object.keys(report.tips).length > 0) {
    lines.push(`tips: ${Object.entries(report.tips).map(([alliance, count]) => `${alliance} ${String(count)}`).join(", ")}`);
  }
  if (report.inert.length > 0) {
    lines.push(`not measured by this sim build: ${report.inert.join(", ")} (https://libraries.horizon36596.org/zenith/simulation/)`);
  }
  return lines.join("\n");
}

/** Runs the sim command and resolves with its exit code and the interleaved output it printed. */
function runCommand(
  spawnImpl: typeof spawn,
  launch: SimLaunch,
  cwd: string,
  timeoutS: number | undefined,
): Promise<{ code: number; output: string; timedOut: boolean }> {
  return new Promise((resolvePromise, reject) => {
    // No shell: the argv array is spawned directly, so nothing in `command` (or in `{auto}`, which
    // is substituted in only after auto.name has already been validated) is ever interpreted for
    // metacharacters, quoting or redirection (finding 1). `resolveLauncher` has already turned a
    // Gradle wrapper or a Windows batch file into something that starts without one.
    const child: ChildProcess = spawnImpl(launch.file, launch.args, { cwd, shell: false, windowsHide: true });
    const chunks: string[] = [];
    let timedOut = false;
    const timer =
      timeoutS === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill();
          }, timeoutS * 1000);

    child.stdout?.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
      chunks.push(chunk.toString());
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      chunks.push(chunk.toString());
    });
    child.on("error", (error) => {
      if (timer !== undefined) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (timer !== undefined) clearTimeout(timer);
      resolvePromise({ code: code ?? 1, output: chunks.join(""), timedOut });
    });
  });
}

/**
 * `zenith sim <auto> [--open] [--timeout <s>]`: runs `zenith.json.sim.command`, reads the trace it
 * writes, and prints estimate vs actual per step (site/docs/simulation.md).
 */
export async function runSim(autoArg: string, options: SimCommandOptions): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const project = loadProject(cwd, options.project, autoArg);
  const path = resolveAutoPath(cwd, project, autoArg);
  const result = loadAutoAndPlan(path, project);
  if (!result.ok) {
    const files: FileFindings[] = [{ path: autoArg, findings: result.findings }];
    process.stdout.write(options.json === true ? `${JSON.stringify({ files }, null, 2)}\n` : `${formatFindingsTable(files)}\n`);
    return 1;
  }
  // loadAutoAndPlan (result.ok) already validated auto.name against AUTO_NAME_PATTERN, so every
  // {auto} substitution below is guaranteed to contain only [A-Za-z0-9._-] — no path separator, no
  // ".." segment, and (for the sim command) no shell metacharacter of any kind.
  const { auto, plan, robot, field, seasonWarnings } = result.loaded;

  const simConfig = project.link.sim;
  if (simConfig === undefined) {
    throw new ProjectError('zenith.json has no "sim" section (command and trace); add one before running zenith sim.');
  }

  const argv = splitShellWords(simConfig.command).map((word) => word.split("{auto}").join(auto.name));
  const tracePath = confinePath(project.root, simConfig.trace.replaceAll("{auto}", auto.name));

  const launch = resolveLauncher(argv, project.root, options.host ?? hostPlatform());
  const { code, output, timedOut } = await runCommand(options.spawnFn ?? spawn, launch, project.root, options.timeout);
  if (code !== 0) {
    const tail = output.split("\n").slice(-40).join("\n");
    const reason = timedOut ? `timed out after ${String(options.timeout)} s` : `exit code ${String(code)}`;
    process.stderr.write(`sim command failed (${reason}):\n${tail}\n`);
    return 2;
  }

  if (!existsSync(tracePath)) {
    process.stderr.write(`the sim command exited 0 but did not write a trace at ${tracePath}\n`);
    return 2;
  }
  let trace;
  try {
    trace = parseTrace(JSON.parse(readFileSync(tracePath, "utf8")) as unknown);
  } catch (error) {
    const message = error instanceof TraceParseError || error instanceof Error ? error.message : String(error);
    process.stderr.write(`could not read the trace at ${tracePath}: ${message}\n`);
    return 2;
  }

  const estimateOutcome = tryCore(() => coreEstimate(plan, robot));
  const report = buildSimReport(trace, plan, estimateOutcome.ok ? estimateOutcome.value : null);

  let renderedPath: string | null = null;
  if (options.open === true) {
    const ledgerOutcome = tryCore(() => coreLedger(plan, field, resolveSeason(field).rules));
    const renderOutcome = tryCore(() =>
      coreRender(plan, estimateOutcome.ok ? estimateOutcome.value : null, result.loaded.findings, ledgerOutcome.ok ? ledgerOutcome.value : [], {}),
    );
    if (renderOutcome.ok) {
      const relative = `${project.link.autosDir}/.renders/${auto.name}.sim.svg`;
      const full = confinePath(project.root, relative);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, renderOutcome.value, "utf8");
      renderedPath = relative;
    }
  }

  if (options.json === true) {
    process.stdout.write(
      `${JSON.stringify({ report, estimateAvailable: estimateOutcome.ok, render: renderedPath, seasonWarnings }, null, 2)}\n`,
    );
  } else {
    for (const warning of seasonWarnings) process.stderr.write(`warning: ${autoArg}: ${warning}\n`);
    process.stdout.write(`${formatReport(report)}\n`);
    if (!estimateOutcome.ok) process.stdout.write(`\n${estimateOutcome.message}\n`);
    if (options.open === true) {
      process.stdout.write(
        renderedPath === null ? "\n--open: render is not available yet (core M1 not landed).\n" : `\nopen: ${renderedPath}\n`,
      );
    }
  }
  return 0;
}
