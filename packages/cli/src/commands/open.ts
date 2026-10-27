import type { Command } from "commander";
import { openInDesktop, type DesktopAppEnv, type Launcher } from "../desktopApp.js";

export interface OpenOptions {
  auto?: string;
  json?: boolean;
  cwd?: string;
  /** Test seams: where the app is looked for, and how it is started. */
  host?: DesktopAppEnv;
  launch?: Launcher;
}

/**
 * `zenith open [dir] [--auto <name>] [--json]`: opens a project in the Zenith desktop app, starting
 * it or reaching the copy already running (site/docs/cli-reference.md). Exit 0 when the app was
 * started with the project, 2 when the project, the auto or the app itself is missing.
 */
export async function runOpen(dir: string | undefined, options: OpenOptions): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  try {
    const plan = await openInDesktop(
      { cwd, ...(dir === undefined ? {} : { dir }), ...(options.auto === undefined ? {} : { auto: options.auto }) },
      { ...(options.host === undefined ? {} : { host: options.host }), ...(options.launch === undefined ? {} : { launch: options.launch }) },
    );
    if (options.json === true) {
      process.stdout.write(`${JSON.stringify({ opened: true, root: plan.root, auto: plan.auto, app: plan.app }, null, 2)}\n`);
    } else {
      process.stdout.write(`Opened ${plan.root}${plan.auto === null ? "" : `, ${plan.auto}`} in the Zenith desktop app.\n`);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json === true) process.stdout.write(`${JSON.stringify({ opened: false, error: message }, null, 2)}\n`);
    else process.stderr.write(`zenith open: ${message}\n`);
    return 2;
  }
}

/** Adds `zenith open` to the program, kept here so the verb lives in one file. */
export function registerOpen(program: Command): void {
  program
    .command("open")
    .description("Open a project, and optionally one auto, in the Zenith desktop app; starts the app or reaches the running one.")
    .argument("[dir]", "the project folder, or a folder inside it (default: the working directory)")
    .option("--auto <name>", "the auto to open first, by name or file name")
    .option("--json", "print what was opened as JSON")
    .action(async (dir: string | undefined, options: { auto?: string; json?: boolean }) => {
      process.exitCode = await runOpen(dir, options);
    });
}
