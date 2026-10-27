/**
 * The GitHub CLI's own sign-in, read with `gh auth token` (site/docs/github.md, issue #213).
 *
 * Two things use it: the Commit panel's pull requests (github.ts), and the sign-in dialog's "Sign in
 * with the GitHub CLI", which hands the token to the page's GitHub mode. The rules for the second:
 *
 * - `gh` runs with an argv array through `execFile`, never a shell, and only ever as
 *   `gh auth token --hostname github.com`, so the token is always github.com's and never an
 *   enterprise host's.
 * - Nothing here stores, caches or logs the token. Each call asks `gh` again, so signing out of the
 *   CLI is felt at once, and the page keeps what it was given in memory only.
 * - The page can ask only whether the CLI is ready, and for the token, through two named calls
 *   (ipc.ts). There is no way for it to run any other command.
 */
import { execFile } from "node:child_process";
import type { DesktopGhCliStatus } from "../../../web/src/project/desktopBridge.js";
import { BridgeError } from "./confine.js";

export interface GhOutput {
  /** The exit code, or "missing" when there is no `gh` to run. */
  code: number | "missing";
  stdout: string;
}

/** Runs `gh <args>`. The seam the tests replace with a fake `gh`. */
export type GhRunner = (args: readonly string[]) => Promise<GhOutput>;

/** The only argv Zenith ever hands to `gh`. */
export const GH_TOKEN_ARGV: readonly string[] = ["auth", "token", "--hostname", "github.com"];

/** How `execFile` reports a program that is not on the PATH. */
const isMissing = (error: { code?: unknown } | null): boolean => error !== null && error.code === "ENOENT";

/** Runs `file` with `prefix` before the `gh` arguments: `gh` itself, or a fake under test. */
export function ghRunner(file: string, prefix: readonly string[] = [], env?: NodeJS.ProcessEnv): GhRunner {
  return (args) =>
    new Promise((resolve) => {
      execFile(
        file,
        [...prefix, ...args],
        // Never let gh stop and wait on a terminal nobody can see.
        { windowsHide: true, timeout: 10_000, env: { ...(env ?? process.env), GH_PROMPT_DISABLED: "1" } },
        (error, stdout) => {
          if (isMissing(error)) {
            resolve({ code: "missing", stdout: "" });
            return;
          }
          const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
          resolve({ code, stdout: String(stdout) });
        },
      );
    });
}

/** The real `gh` on the PATH. */
export const execGh: GhRunner = ghRunner("gh");

/**
 * The runner for a test: `ZENITH_TEST_GH` names a Node script that stands in for `gh`, run with
 * Electron's own Node. Honoured only in a windowless test run (`ZENITH_HEADLESS=1`), so an installed
 * copy always runs the real `gh`.
 */
export function ghRunnerFromEnv(env: NodeJS.ProcessEnv, headless: boolean, execPath: string): GhRunner {
  const fake = env["ZENITH_TEST_GH"];
  if (!headless || fake === undefined || fake === "") return execGh;
  return ghRunner(execPath, [fake], { ...env, ELECTRON_RUN_AS_NODE: "1" });
}

/**
 * What a GitHub token looks like: the gho, ghp and github_pat prefixes, each followed by an underscore,
 * and the classic 40 hex digits are all letters, digits and underscores. Anything else `gh` prints (a
 * warning, an error) is not one.
 */
const TOKEN_SHAPE = /^[A-Za-z0-9_]{20,255}$/;

/** The CLI's state and, when it is signed in, its token. Never throws. */
export async function readGhCli(run: GhRunner): Promise<{ status: DesktopGhCliStatus; token: string | null }> {
  let out: GhOutput;
  try {
    out = await run(GH_TOKEN_ARGV);
  } catch {
    return { status: { state: "missing" }, token: null };
  }
  if (out.code === "missing") return { status: { state: "missing" }, token: null };
  const token = out.stdout.trim();
  if (out.code !== 0 || !TOKEN_SHAPE.test(token)) return { status: { state: "signed-out" }, token: null };
  return { status: { state: "ready" }, token };
}

/** Whether the sign-in dialog can offer the CLI. The token itself stays here. */
export async function ghCliStatus(run: GhRunner): Promise<DesktopGhCliStatus> {
  return (await readGhCli(run)).status;
}

/** The CLI's token, for GitHub mode in the page, or a sentence saying why there is none. */
export async function ghCliToken(run: GhRunner): Promise<string> {
  const { status, token } = await readGhCli(run);
  if (token !== null) return token;
  throw new BridgeError(
    status.state === "missing"
      ? "The GitHub CLI (gh) is not installed on this computer. Install it from cli.github.com, or paste a personal access token."
      : "The GitHub CLI is not signed in to github.com. Run gh auth login in a terminal, then try again, or paste a personal access token.",
  );
}
