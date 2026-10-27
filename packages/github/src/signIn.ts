import { PatAuth, type AuthProvider } from "./auth.js";
import { AuthError } from "./errors.js";

/**
 * Finding a GitHub sign-in the way the GitHub CLI's own tools do, for a host that can run a
 * program: the CLI, the MCP server, the desktop app's main process. This module stays isomorphic
 * (no Node APIs), so the host passes in the one thing it needs, a way to run `gh`.
 *
 * Order: `GH_TOKEN`, then `GITHUB_TOKEN`, then `gh auth token --hostname github.com` when the
 * GitHub CLI is installed and signed in. The token goes into a `PatAuth`, whose private field keeps
 * it out of `JSON.stringify` and logs; it is never written anywhere and only ever sent to
 * `api.github.com` by `GitHubClient`.
 */

export interface CommandResult {
  /** The exit code, or `null` when the program was ended by a signal. */
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  cwd?: string;
  /** Written to the program's standard input, which is then closed. */
  input?: string;
  /** The program's whole environment. Left out, the host's own. */
  env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Runs a program without a shell and collects its output. Rejects only when the program could not
 * be started at all (for example, it is not installed); a non-zero exit resolves with its `code`.
 */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  options?: CommandOptions,
) => Promise<CommandResult>;

export type TokenSource = "GH_TOKEN" | "GITHUB_TOKEN" | "gh";

export interface SignInLookup {
  /** The environment to read `GH_TOKEN` and `GITHUB_TOKEN` from. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Runs `gh`. Without one, the GitHub CLI is not tried. */
  run?: CommandRunner;
}

export interface SignIn {
  source: TokenSource;
  auth: AuthProvider;
}

const PAT_STEPS =
  "or set GH_TOKEN to a fine-grained personal access token with Contents and Pull requests set to Read and write on this repository";

/**
 * No sign-in could be found. `next` is the one thing to do about it, in words a person or an agent
 * can act on; `message` says what was tried and ends with the same step.
 */
export class NoSignInError extends AuthError {
  constructor(
    message: string,
    readonly next: string,
    readonly ghInstalled: boolean,
  ) {
    super(message);
    this.name = "NoSignInError";
  }
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? null : trimmed;
}

/**
 * Finds a GitHub sign-in, in the order above, or throws `NoSignInError` naming the next step.
 * Never prints, logs or stores the token.
 */
export async function findSignIn(lookup: SignInLookup = {}): Promise<SignIn> {
  const env = lookup.env ?? {};
  const fromGh = nonEmpty(env.GH_TOKEN);
  if (fromGh !== null) return { source: "GH_TOKEN", auth: new PatAuth(fromGh) };
  const fromGithub = nonEmpty(env.GITHUB_TOKEN);
  if (fromGithub !== null) return { source: "GITHUB_TOKEN", auth: new PatAuth(fromGithub) };

  let ghInstalled = false;
  if (lookup.run !== undefined) {
    try {
      const result = await lookup.run("gh", ["auth", "token", "--hostname", "github.com"], { env: lookup.env });
      ghInstalled = true;
      const token = result.code === 0 ? nonEmpty(result.stdout) : null;
      if (token !== null) return { source: "gh", auth: new PatAuth(token) };
    } catch {
      ghInstalled = false;
    }
  }

  const next = ghInstalled
    ? `Run \`gh auth login\` to sign the GitHub CLI in to github.com, ${PAT_STEPS}.`
    : `Install the GitHub CLI from https://cli.github.com and run \`gh auth login\`, ${PAT_STEPS}.`;
  const tried = ghInstalled
    ? "GH_TOKEN and GITHUB_TOKEN are not set, and the GitHub CLI is not signed in to github.com."
    : "GH_TOKEN and GITHUB_TOKEN are not set, and the GitHub CLI (gh) is not installed.";
  throw new NoSignInError(`No GitHub sign-in found: ${tried} Next: ${next}`, next, ghInstalled);
}

/** The one next step when GitHub refuses a token that `findSignIn` found. */
export function rejectedTokenNext(source: TokenSource): string {
  return source === "gh"
    ? "Run `gh auth login` again (or `gh auth refresh`) so the GitHub CLI has a working sign-in."
    : `Set ${source} to a working fine-grained personal access token (Contents and Pull requests set to Read and write on this repository), or unset it to use the GitHub CLI's sign-in.`;
}

export interface GitHubRemote {
  owner: string;
  repo: string;
}

const GITHUB_HOSTS = new Set(["github.com", "www.github.com", "ssh.github.com"]);
const NAME = /^[A-Za-z0-9_.-]+$/;

function ownerRepo(path: string): GitHubRemote | null {
  const parts = path
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split("/");
  if (parts.length !== 2) return null;
  const [owner, repo] = parts as [string, string];
  if (!NAME.test(owner) || !NAME.test(repo) || repo === "." || repo === "..") return null;
  return { owner, repo };
}

/**
 * The owner and repository of a git remote URL on github.com, or `null` for any other host or
 * shape. Accepts `https://github.com/o/r(.git)`, `git@github.com:o/r(.git)` and
 * `ssh://git@github.com/o/r(.git)`. A URL carrying credentials still parses, but callers must never
 * print the URL itself: show `https://github.com/<owner>/<repo>` instead.
 */
export function parseGitHubRemote(url: string): GitHubRemote | null {
  const trimmed = url.trim();
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(trimmed);
  if (scp !== null && !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    const [, host, path] = scp as unknown as [string, string, string];
    return GITHUB_HOSTS.has(host.toLowerCase()) ? ownerRepo(path) : null;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (!["https:", "http:", "ssh:", "git:", "git+ssh:", "ssh+git:"].includes(parsed.protocol)) return null;
  if (!GITHUB_HOSTS.has(parsed.hostname.toLowerCase())) return null;
  return ownerRepo(decodeURIComponent(parsed.pathname));
}

/** Only the host of a remote URL, safe to print even when the URL carries credentials. */
export function remoteHost(url: string): string | null {
  const trimmed = url.trim();
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)/.exec(trimmed);
  if (scp !== null && !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return scp[1] ?? null;
  try {
    return new URL(trimmed).hostname || null;
  } catch {
    return null;
  }
}
