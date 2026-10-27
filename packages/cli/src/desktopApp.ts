/**
 * Starting the Zenith desktop app on a project, for `zenith open` and the MCP tool `zenith.app.open`
 * (site/docs/cli-reference.md, site/docs/agents-mcp.md).
 *
 * The app is started with two switches, `--zenith-open=<folder>` and `--zenith-auto=<name>`. When it
 * is already running, the new launch hands the folder to the running window and quits, so a second
 * window never opens. Everything is checked here first, so a mistake is reported to whoever ran the
 * command instead of on the app's status line: the folder must hold a `zenith.json` that loads and
 * the auto, when one is named, must be in its autos folder. The app checks both again.
 */
import { spawn as spawnProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve as resolvePath, win32 } from "node:path";
import { AUTO_NAME_PATTERN } from "./autoLoad.js";
import { loadProject } from "./project.js";

/** The switch naming the folder to open; the desktop app reads exactly this. */
export const OPEN_SWITCH = "--zenith-open=";
/** The switch naming the auto to open first, as a bare name or a file name. */
export const AUTO_SWITCH = "--zenith-auto=";

/** A refusal written for the person or agent that asked: not installed, no project, no such auto. */
export class DesktopAppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesktopAppError";
  }
}

export interface DesktopAppEnv {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  exists: (path: string) => boolean;
}

const hostEnv = (): DesktopAppEnv => ({ env: process.env, platform: process.platform, exists: existsSync });

const NOT_INSTALLED =
  "The Zenith desktop app is not installed on this computer, so there is nothing to open the project in. " +
  "Install Zenith for Windows (Zenith-Setup-<version>.exe), or set ZENITH_DESKTOP to the full path of Zenith.exe " +
  "if it is installed somewhere else. The web app opens a folder from its own Open project dialog.";

/**
 * Where the desktop app's executable is: `ZENITH_DESKTOP` when it is set, else the folders the
 * Windows installer offers (just for this user, the default, or for everyone). Null when none has it.
 * The app is built for Windows only, so elsewhere only `ZENITH_DESKTOP` can name one. The install
 * folders are Windows paths whatever the host, so they are joined with `win32` rules.
 */
export function findDesktopApp(host: DesktopAppEnv = hostEnv()): string | null {
  const named = host.env["ZENITH_DESKTOP"];
  if (named !== undefined && named !== "") {
    if (!host.exists(named)) throw new DesktopAppError(`ZENITH_DESKTOP names ${named}, and there is no file there.`);
    return named;
  }
  if (host.platform !== "win32") return null;
  const candidates = [
    host.env["LOCALAPPDATA"] === undefined ? null : win32.join(host.env["LOCALAPPDATA"], "Programs", "Zenith", "Zenith.exe"),
    host.env["ProgramFiles"] === undefined ? null : win32.join(host.env["ProgramFiles"], "Zenith", "Zenith.exe"),
    host.env["ProgramFiles(x86)"] === undefined ? null : win32.join(host.env["ProgramFiles(x86)"], "Zenith", "Zenith.exe"),
  ];
  return candidates.find((path): path is string => path !== null && host.exists(path)) ?? null;
}

export interface DesktopOpenInput {
  /** The project folder, or a folder inside it; the working directory when absent. */
  dir?: string;
  /** The auto to open first: `close-cycle` or `close-cycle.auto.json`. */
  auto?: string;
  cwd: string;
}

export interface DesktopOpenPlan {
  /** The executable that will be started. */
  app: string;
  /** The folder holding `zenith.json`. */
  root: string;
  /** The auto's file name in the autos folder, or null for the app's usual first auto. */
  auto: string | null;
  /** The arguments the app is started with. */
  args: string[];
}

/** Checks the project and the auto, finds the app, and says how it would be started. Throws a sentence. */
export function planDesktopOpen(input: DesktopOpenInput, host: DesktopAppEnv = hostEnv()): DesktopOpenPlan {
  const from = input.dir === undefined ? input.cwd : resolvePath(input.cwd, input.dir);
  const project = loadProject(from);
  let auto: string | null = null;
  if (input.auto !== undefined && input.auto !== "") {
    const name = input.auto.endsWith(".auto.json") ? input.auto.slice(0, -".auto.json".length) : input.auto;
    if (!AUTO_NAME_PATTERN.test(name) || name.startsWith(".")) {
      throw new DesktopAppError(`"${input.auto}" is not an auto name: use letters, digits, ".", "_" and "-".`);
    }
    auto = `${name}.auto.json`;
    if (!host.exists(join(project.root, project.link.autosDir, auto))) {
      throw new DesktopAppError(`There is no auto called ${name} in ${join(project.root, project.link.autosDir)}.`);
    }
  }
  const app = findDesktopApp(host);
  if (app === null) throw new DesktopAppError(NOT_INSTALLED);
  return {
    app,
    root: project.root,
    auto,
    args: [`${OPEN_SWITCH}${project.root}`, ...(auto === null ? [] : [`${AUTO_SWITCH}${auto}`])],
  };
}

/** Starts a program on its own, not tied to this process; resolves once it has started. The tests' seam. */
export type Launcher = (file: string, args: readonly string[]) => Promise<void>;

export const launchDetached: Launcher = (file, args) =>
  new Promise((resolve, reject) => {
    const child = spawnProcess(file, [...args], { detached: true, stdio: "ignore", windowsHide: false });
    child.once("error", (error) => {
      reject(new DesktopAppError(`Could not start ${file}: ${error.message}`));
    });
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });

/**
 * `zenith open`'s and `zenith.app.open`'s whole job: plan, then start the app. A running app gets
 * the folder through its single-instance lock and the new launch quits by itself.
 */
export async function openInDesktop(
  input: DesktopOpenInput,
  deps: { host?: DesktopAppEnv; launch?: Launcher } = {},
): Promise<DesktopOpenPlan> {
  const plan = planDesktopOpen(input, deps.host);
  await (deps.launch ?? launchDetached)(plan.app, plan.args);
  return plan;
}
