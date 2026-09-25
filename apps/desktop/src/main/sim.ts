/**
 * The High-fidelity sim button: runs `zenith.json`'s `sim.command` for one auto, streams what it
 * prints, and hands the trace it writes back to the editor (site/docs/simulation.md).
 *
 * The command is built exactly the way `zenith sim` builds it: split into argv by the CLI's own
 * `splitShellWords`, `{auto}` substituted only after `loadAutoAndPlan` has validated `auto.name`
 * against `AUTO_NAME_PATTERN`, the trace path confined to the root, and the argv spawned with
 * `shell: false`. `sim.command` is the team's own string, not attacker input; the auto name is the
 * only part that varies, and it is checked before it is substituted.
 *
 * The argv is turned into an executable by the CLI's `resolveLauncher`, the same one `zenith sim`
 * uses: on Windows it runs a Gradle-wrapper command as `java -classpath gradle/wrapper/gradle-wrapper.jar
 * org.gradle.wrapper.GradleWrapperMain`, the way `gradlew.bat` itself does, because Node refuses to
 * spawn a `.bat` file without a shell.
 */
import { spawn as nodeSpawn, execFile, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { parseTrace } from "@horizon36596/zenith-core";
import type { DesktopSimEvent } from "../../../web/src/project/desktopBridge.js";
import {
  confinePath,
  findJava as cliFindJava,
  hostPlatform,
  LauncherError,
  loadAutoAndPlan,
  MissingToolError as CliMissingToolError,
  resolveLauncher as cliResolveLauncher,
  splitShellWords,
  withRerun,
  type Platform,
  type SimLaunch,
} from "./cli.js";
import { BridgeError, assertAutoFileName } from "./confine.js";
import { autoRelPath, loadDesktopProject } from "./project.js";

/** What a missing tool is, so the message can say what to install. */
export class MissingToolError extends BridgeError {
  constructor(
    readonly tool: "java" | "gradle" | "command",
    message: string,
  ) {
    super(message);
    this.name = "MissingToolError";
  }
}

export type { Platform, SimLaunch };
export { withRerun };

export interface SimPlan {
  root: string;
  autoName: string;
  launch: SimLaunch;
  /** Absolute, confined to the root. */
  tracePath: string;
  /** Relative to the root, with `/`. */
  traceRel: string;
}

/** The CLI's launcher errors, as the bridge errors the renderer is allowed to show. */
function asBridgeError(error: unknown): unknown {
  if (error instanceof CliMissingToolError) return new MissingToolError(error.tool, error.message);
  if (error instanceof LauncherError) return new BridgeError(error.message);
  return error;
}

/** The `java` executable Gradle would use: `JAVA_HOME` first, then the `PATH`. */
export function findJava(host: Platform = hostPlatform()): string {
  try {
    return cliFindJava(host);
  } catch (error) {
    throw asBridgeError(error);
  }
}

/**
 * The CLI's `resolveLauncher` (packages/cli/src/launcher.ts), which `zenith sim` uses too, with its
 * errors turned into bridge errors.
 */
export function resolveLauncher(argv: readonly string[], root: string, host: Platform = hostPlatform()): SimLaunch {
  try {
    return cliResolveLauncher(argv, root, host);
  } catch (error) {
    throw asBridgeError(error);
  }
}

/**
 * Everything the run needs, worked out before anything starts, so a bad auto, a missing sim section
 * or a missing Java is a message rather than a half-started process.
 */
export function buildSimPlan(root: string, fileName: string, host: Platform = hostPlatform()): SimPlan {
  const project = loadDesktopProject(root);
  const rel = autoRelPath(project, assertAutoFileName(fileName));
  const result = loadAutoAndPlan(confinePath(root, rel), project);
  if (!result.ok) {
    const first = result.findings[0]?.message ?? "it does not parse";
    throw new BridgeError(`${fileName} does not load, so it cannot be simulated: ${first}`);
  }
  // loadAutoAndPlan has validated auto.name against AUTO_NAME_PATTERN, so the substitution below can
  // only ever put [A-Za-z0-9._-] into a word.
  const autoName = result.loaded.auto.name;
  const sim = project.link.sim;
  if (sim === undefined) {
    throw new BridgeError('zenith.json has no "sim" section, so there is no sim command to run. Add one with a command and a trace path.');
  }
  const argv = splitShellWords(sim.command).map((word) => word.split("{auto}").join(autoName));
  const traceRel = sim.trace.split("{auto}").join(autoName).split("\\").join("/");
  let tracePath: string;
  try {
    tracePath = confinePath(root, traceRel);
  } catch (error) {
    throw new BridgeError(error instanceof Error ? error.message : String(error));
  }
  return { root, autoName, launch: resolveLauncher(argv, root, host), tracePath, traceRel };
}

/* ---- Running ------------------------------------------------------------- */

/** Colour and cursor escapes, which some Gradle builds print even without a terminal. */
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const TAIL_LINES = 60;

export interface RunnerDeps {
  spawnImpl?: typeof nodeSpawn;
  /** Stops the process and everything it started. */
  killTree?: (child: ChildProcess) => void;
  now?: () => number;
  readTrace?: (path: string) => { text: string; mtimeMs: number } | null;
}

function defaultKillTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    // The wrapper's JVM starts children of its own; /T takes the whole tree down with it.
    execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => undefined);
  } else {
    child.kill("SIGTERM");
  }
}

const defaultReadTrace = (path: string): { text: string; mtimeMs: number } | null => {
  try {
    return { text: readFileSync(path, "utf8"), mtimeMs: statSync(path).mtimeMs };
  } catch {
    return null;
  }
};

/** A hint for the failures people actually hit, found in what Gradle printed. */
export function explainFailure(code: number | null, tail: readonly string[]): string {
  const text = tail.join("\n");
  if (/Unsupported class file major version|requires Java \d+|Android Gradle plugin requires Java/i.test(text)) {
    return "The robot code needs a different Java version from the one Zenith found. Install the JDK the robot repository asks for (usually Java 17) and set JAVA_HOME to it.";
  }
  if (/SDK location not found|ANDROID_HOME|sdk\.dir/i.test(text)) {
    return "Gradle could not find the Android SDK. Open the robot repository once in Android Studio so it writes local.properties, then run the sim again.";
  }
  if (/Could not resolve|Could not GET|Could not download|UnknownHostException/i.test(text)) {
    return "Gradle could not download something it needs. Check the internet connection and run the sim again; the first run downloads the most.";
  }
  if (/No tests found for given includes/i.test(text)) {
    return "Gradle found no sim test to run. Check that the headless test named in zenith.json's sim.command exists in the robot repository (the Simulation page of the Zenith docs shows how to set one up).";
  }
  if (/There were failing tests|tests completed, \d+ failed/i.test(text)) {
    return "The sim ran, but its test failed. The lines below say which assertion; the auto may stall in the sim or hit something.";
  }
  return `The sim command stopped with exit code ${String(code)}. The last lines it printed are below.`;
}

interface Run {
  child: ChildProcess;
  cancelled: boolean;
}

/**
 * Runs one sim at a time and reports it through `emit` as `DesktopSimEvent`s: a start, every line
 * printed, and then either the parsed trace or a failure worded for a person.
 */
export class SimRunner {
  private readonly runs = new Map<string, Run>();
  private readonly spawnImpl: typeof nodeSpawn;
  private readonly killTree: (child: ChildProcess) => void;
  private readonly now: () => number;
  private readonly readTrace: NonNullable<RunnerDeps["readTrace"]>;

  constructor(
    private readonly emit: (event: DesktopSimEvent) => void,
    deps: RunnerDeps = {},
  ) {
    this.spawnImpl = deps.spawnImpl ?? nodeSpawn;
    this.killTree = deps.killTree ?? defaultKillTree;
    this.now = deps.now ?? Date.now;
    this.readTrace = deps.readTrace ?? defaultReadTrace;
  }

  get running(): boolean {
    return this.runs.size > 0;
  }

  start(plan: SimPlan): string {
    if (this.running) throw new BridgeError("A sim is already running. Wait for it or cancel it first.");
    const runId = randomUUID();
    const startedAt = this.now();
    const tail: string[] = [];
    let settled = false;

    const fail = (message: string, cancelled: boolean): void => {
      if (settled) return;
      settled = true;
      this.runs.delete(runId);
      this.emit({ runId, kind: "failed", message, tail: [...tail], cancelled });
    };

    const child = this.spawnImpl(plan.launch.file, plan.launch.args, {
      cwd: plan.root,
      shell: false,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const run: Run = { child, cancelled: false };
    this.runs.set(runId, run);
    this.emit({ runId, kind: "started", command: plan.launch.display, autoName: plan.autoName });

    const partial = { stdout: "", stderr: "" };
    const onChunk = (stream: "stdout" | "stderr") => (chunk: Buffer | string) => {
      const lines = (partial[stream] + chunk.toString()).split(/\r?\n|\r/);
      partial[stream] = lines.pop() ?? "";
      for (const raw of lines) this.line(runId, stream, raw, tail);
    };
    const flush = (): void => {
      for (const stream of ["stdout", "stderr"] as const) {
        if (partial[stream] !== "") this.line(runId, stream, partial[stream], tail);
        partial[stream] = "";
      }
    };
    child.stdout?.on("data", onChunk("stdout"));
    child.stderr?.on("data", onChunk("stderr"));

    child.on("error", (error: NodeJS.ErrnoException) => {
      fail(
        error.code === "ENOENT"
          ? `Could not start ${plan.launch.file}: it is not installed or not on the PATH.`
          : `Could not start the sim command: ${error.message}`,
        false,
      );
    });

    child.on("close", (code) => {
      if (settled) return;
      flush();
      if (run.cancelled) {
        fail("The sim was cancelled.", true);
        return;
      }
      if (code !== 0) {
        fail(explainFailure(code, tail), false);
        return;
      }
      const read = this.readTrace(plan.tracePath);
      if (read === null) {
        fail(`The sim finished but wrote no trace at ${plan.traceRel}. Check zenith.json's sim.trace path.`, false);
        return;
      }
      // A trace older than this run is the previous run's, and overlaying it would be a quiet lie.
      if (read.mtimeMs < startedAt - 2000) {
        fail(`The sim finished but did not write a new trace; ${plan.traceRel} is from an earlier run.`, false);
        return;
      }
      let trace: unknown;
      try {
        trace = JSON.parse(read.text) as unknown;
        parseTrace(trace);
      } catch (error) {
        fail(`The trace at ${plan.traceRel} could not be read: ${error instanceof Error ? error.message : String(error)}`, false);
        return;
      }
      settled = true;
      this.runs.delete(runId);
      this.emit({ runId, kind: "done", trace, tracePath: plan.traceRel, elapsedS: (this.now() - startedAt) / 1000 });
    });

    return runId;
  }

  cancel(runId: string): void {
    const run = this.runs.get(runId);
    if (run === undefined) return;
    run.cancelled = true;
    this.killTree(run.child);
  }

  cancelAll(): void {
    for (const runId of [...this.runs.keys()]) this.cancel(runId);
  }

  private line(runId: string, stream: "stdout" | "stderr", raw: string, tail: string[]): void {
    const text = raw.replace(ANSI, "");
    tail.push(text);
    if (tail.length > TAIL_LINES) tail.shift();
    this.emit({ runId, kind: "line", stream, text });
  }
}
