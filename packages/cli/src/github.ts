import { spawn } from "node:child_process";
import {
  AuthError,
  findSignIn,
  GitHubClient,
  NoSignInError,
  NotFoundError,
  parseGitHubRemote,
  rejectedTokenNext,
  remoteHost,
  type CommandOptions,
  type CommandResult,
  type CommandRunner,
  type Repo,
  type TokenSource,
  type User,
} from "@horizon36596/zenith-github";

/**
 * What `zenith setup`, `zenith github status` and `zenith propose` need from the outside world:
 * a way to run `git` and `gh`, the environment (for `GH_TOKEN`/`GITHUB_TOKEN` and git's own
 * settings) and `fetch` for `api.github.com`. Tests pass their own, so nothing in a test reaches
 * real GitHub or the real GitHub CLI.
 */
export interface GitHubDeps {
  run: CommandRunner;
  env: Readonly<Record<string, string | undefined>>;
  fetchImpl?: typeof fetch;
}

/** Runs a program with no shell, never on a console window of its own. */
export const nodeRunner: CommandRunner = (command, args, options: CommandOptions = {}) =>
  new Promise<CommandResult>((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: (options.env ?? process.env) as NodeJS.ProcessEnv,
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
    child.stdin.on("error", () => {
      // A program that exits before reading its input closes the pipe; its exit code says enough.
    });
    child.stdin.end(options.input ?? "");
  });

export function defaultGitHubDeps(): GitHubDeps {
  return { run: nodeRunner, env: process.env };
}

/**
 * A failure that a person or an agent can fix, with the one thing to do about it in `next`. The
 * message ends with the same step, so a caller that shows only the message still shows it.
 */
export class NextStepError extends Error {
  constructor(
    readonly problem: string,
    readonly next: string,
    readonly files: string[] = [],
  ) {
    super(`${problem} Next: ${next}`);
    this.name = "NextStepError";
  }
}

/** Hides credentials a remote URL may carry (`https://user:secret@host/...`) in text git printed. */
export function redactCredentials(text: string): string {
  return text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, "$1***@");
}

function firstLines(text: string, count = 3): string {
  return redactCredentials(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, count)
    .join(" ");
}

export class GitCommandError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly result: CommandResult,
  ) {
    super(`git ${args[0] ?? ""} failed: ${firstLines(result.stderr) || `exit ${String(result.code)}`}`);
    this.name = "GitCommandError";
  }
}

/**
 * `git` in one working tree, never interactive: a credential prompt would hang an MCP server or a
 * CI job, so git is told to fail instead of asking (`GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`,
 * and ssh in batch mode unless the person set their own ssh command).
 */
export class Git {
  readonly env: Record<string, string | undefined>;

  constructor(
    private readonly runner: CommandRunner,
    readonly cwd: string,
    baseEnv: Readonly<Record<string, string | undefined>>,
  ) {
    this.env = {
      ...baseEnv,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
      ...(baseEnv.GIT_SSH_COMMAND === undefined && baseEnv.GIT_SSH === undefined
        ? { GIT_SSH_COMMAND: "ssh -o BatchMode=yes" }
        : {}),
    };
  }

  /** Runs git and returns the result whatever the exit code. Throws only when git cannot start. */
  async raw(args: readonly string[], options: { input?: string; env?: Record<string, string | undefined> } = {}): Promise<CommandResult> {
    try {
      return await this.runner("git", args, {
        cwd: this.cwd,
        input: options.input,
        env: options.env === undefined ? this.env : { ...this.env, ...options.env },
      });
    } catch {
      throw new NextStepError("git is not installed, or is not on PATH.", "Install git from https://git-scm.com and run this again.");
    }
  }

  /** Runs git and returns its trimmed stdout, or throws `GitCommandError` on a non-zero exit. */
  async ok(args: readonly string[], options: { input?: string; env?: Record<string, string | undefined> } = {}): Promise<string> {
    const result = await this.raw(args, options);
    if (result.code !== 0) throw new GitCommandError(args, result);
    return result.stdout.trim();
  }

  /** Trimmed stdout on success, `null` on any non-zero exit. */
  async maybe(args: readonly string[]): Promise<string | null> {
    const result = await this.raw(args);
    return result.code === 0 ? result.stdout.trim() : null;
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    const result = await this.raw(["merge-base", "--is-ancestor", ancestor, descendant]);
    if (result.code === 0) return true;
    if (result.code === 1) return false;
    throw new GitCommandError(["merge-base"], result);
  }
}

/** Where a working directory sits in git: the top of the repository and the current branch. */
export interface GitPlace {
  git: Git;
  top: string;
  /** The directory's path inside the repository, with a trailing slash, or "" at the top. */
  prefix: string;
  /** The checked-out branch, or `null` on a detached HEAD. */
  branch: string | null;
}

export async function gitPlace(cwd: string, deps: GitHubDeps): Promise<GitPlace> {
  const git = new Git(deps.run, cwd, deps.env);
  // One call for all three; `--abbrev-ref HEAD` prints "HEAD" on a detached HEAD.
  const described = await git.raw(["rev-parse", "--show-toplevel", "--show-prefix", "--abbrev-ref", "HEAD"]);
  const lines = described.stdout.split(/\r?\n/);
  let top = described.code === 0 ? lines[0]?.trim() : undefined;
  let prefix = lines[1]?.trim() ?? "";
  let branch: string | null = lines[2]?.trim() ?? null;
  if (described.code !== 0) {
    // A repository with no commit yet has no HEAD to name, so ask for the rest on its own.
    top = (await git.maybe(["rev-parse", "--show-toplevel"])) ?? undefined;
    prefix = (await git.maybe(["rev-parse", "--show-prefix"])) ?? "";
    branch = await git.maybe(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  }
  if (top === undefined || top.length === 0) {
    throw new NextStepError(
      `${cwd} is not inside a git repository.`,
      "Run this inside a clone of your robot repository (`gh repo clone <owner>/<repo>`), or pass the clone's folder as --project.",
    );
  }
  if (branch === "HEAD" || branch === "") branch = null;
  return { git: new Git(deps.run, top, deps.env), top, prefix, branch };
}

export interface OriginRepo {
  owner: string;
  repo: string;
  fullName: string;
  url: string;
}

/** `origin`, as a github.com repository, or a `NextStepError` saying how to point it at one. */
export async function originRepo(git: Git): Promise<OriginRepo> {
  const url = await git.maybe(["config", "--get", "remote.origin.url"]);
  if (url === null || url.length === 0) {
    throw new NextStepError(
      "This repository has no remote called origin.",
      "Add your GitHub repository as origin: `git remote add origin https://github.com/<owner>/<repo>.git`.",
    );
  }
  const parsed = parseGitHubRemote(url);
  if (parsed === null) {
    const host = remoteHost(url);
    throw new NextStepError(
      `origin is not a github.com repository${host === null ? "" : ` (its host is ${host})`}.`,
      "Point origin at the robot repository on github.com: `git remote set-url origin https://github.com/<owner>/<repo>.git`.",
    );
  }
  return {
    ...parsed,
    fullName: `${parsed.owner}/${parsed.repo}`,
    url: `https://github.com/${parsed.owner}/${parsed.repo}`,
  };
}

export interface GitHubSession {
  client: GitHubClient;
  source: TokenSource;
  user: User;
}

/** Finds a sign-in and checks it with GitHub, turning every failure into a `NextStepError`. */
export async function signIn(deps: GitHubDeps): Promise<GitHubSession> {
  let found;
  try {
    found = await findSignIn({ env: deps.env, run: deps.run });
  } catch (error) {
    if (error instanceof NoSignInError) {
      throw new NextStepError(error.message.replace(/ Next: .*$/s, ""), error.next);
    }
    throw error;
  }
  const client = new GitHubClient(found.auth, { fetchImpl: deps.fetchImpl });
  try {
    const user = await client.users.me();
    return { client, source: found.source, user };
  } catch (error) {
    if (error instanceof AuthError) {
      throw new NextStepError(`GitHub refused the token from ${describeSource(found.source)}.`, rejectedTokenNext(found.source));
    }
    throw networkProblem(error);
  }
}

export function describeSource(source: TokenSource): string {
  return source === "gh" ? "the GitHub CLI (gh auth token)" : source;
}

/** The repository as GitHub sees it for this sign-in, or a `NextStepError` saying why it cannot. */
export async function fetchRepo(session: GitHubSession, origin: OriginRepo): Promise<Repo> {
  try {
    return await session.client.repos.get(origin.owner, origin.repo);
  } catch (error) {
    if (error instanceof NotFoundError || error instanceof AuthError) {
      throw new NextStepError(
        `GitHub says ${origin.fullName} does not exist, or ${session.user.login} cannot see it.`,
        session.source === "gh"
          ? `Check that origin is right, or sign in as an account with access to ${origin.fullName}: \`gh auth login\`.`
          : `Check that origin is right, or give the token in ${session.source} access to ${origin.fullName}.`,
      );
    }
    throw networkProblem(error);
  }
}

function networkProblem(error: unknown): Error {
  if (error instanceof NextStepError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new NextStepError(
    `Could not reach GitHub: ${message}`,
    "Check the internet connection (and https://www.githubstatus.com), then run this again.",
  );
}
