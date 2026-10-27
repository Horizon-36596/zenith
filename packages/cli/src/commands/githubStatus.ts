import { resolve as resolvePath } from "node:path";
import type { TokenSource } from "@horizon36596/zenith-github";
import {
  defaultGitHubDeps,
  describeSource,
  fetchRepo,
  gitPlace,
  NextStepError,
  originRepo,
  signIn,
  type GitHubDeps,
  type GitPlace,
  type GitHubSession,
} from "../github.js";

export interface GitHubStatusOptions {
  cwd?: string;
  project?: string;
  json?: boolean;
}

export interface StatusPullRequest {
  number: number;
  url: string;
  base: string;
  head: string;
}

/** `zenith github status --json` and `zenith.github.status`: every field is `null` until it is known. */
export interface GitHubStatus {
  /** True when an auto can be proposed from here: a GitHub origin, a working sign-in, push access. */
  ok: boolean;
  repo: { owner: string; repo: string; fullName: string; url: string } | null;
  defaultBranch: string | null;
  login: string | null;
  /** Where the sign-in came from: `GH_TOKEN`, `GITHUB_TOKEN` or `gh`. Never the token itself. */
  auth: TokenSource | null;
  canPush: boolean | null;
  /** The checked-out branch, or `null` on a detached HEAD or outside git. */
  branch: string | null;
  /** The open pull request from `branch`, if there is one. */
  pullRequest: StatusPullRequest | null;
  /** What is wrong, when `ok` is false. */
  error: string | null;
  /** The one thing to do next. */
  next: string | null;
}

/** The status plus the live session and git place, for `setup` and `propose` to carry on with. */
export interface GitHubConnection {
  status: GitHubStatus;
  place: GitPlace | null;
  session: GitHubSession | null;
}

function emptyStatus(): GitHubStatus {
  return {
    ok: false,
    repo: null,
    defaultBranch: null,
    login: null,
    auth: null,
    canPush: null,
    branch: null,
    pullRequest: null,
    error: null,
    next: null,
  };
}

/** Never throws for a problem a person can fix; it lands in `error` and `next` instead. */
export async function connectGitHub(dir: string, deps: GitHubDeps = defaultGitHubDeps()): Promise<GitHubConnection> {
  const status = emptyStatus();
  let place: GitPlace | null = null;
  let session: GitHubSession | null = null;
  try {
    place = await gitPlace(dir, deps);
    status.branch = place.branch;
    const origin = await originRepo(place.git);
    status.repo = origin;
    session = await signIn(deps);
    status.login = session.user.login;
    status.auth = session.source;
    const repo = await fetchRepo(session, origin);
    status.defaultBranch = repo.defaultBranch;
    status.canPush = repo.canPush ?? null;
    if (place.branch !== null) {
      const open = await session.client.pulls.listForBranch(origin.owner, origin.repo, place.branch, "open");
      const pull = open[0];
      if (pull !== undefined) {
        status.pullRequest = { number: pull.number, url: pull.htmlUrl, base: pull.base.ref, head: pull.head.ref };
      }
    }
    if (repo.canPush === false) {
      throw new NextStepError(
        `${session.user.login} can read ${origin.fullName} but cannot push to it.`,
        `Ask an admin of ${origin.fullName} to give ${session.user.login} write access, then run this again.`,
      );
    }
    status.ok = true;
    status.next = `Edit an auto, then run \`zenith propose <auto>\` (MCP: zenith.propose) to open a pull request.`;
  } catch (error) {
    status.ok = false;
    if (error instanceof NextStepError) {
      status.error = error.problem;
      status.next = error.next;
    } else {
      status.error = `GitHub returned an error: ${error instanceof Error ? error.message : String(error)}`;
      status.next = "Run this again in a minute; if it keeps failing, check https://www.githubstatus.com.";
    }
  }
  return { status, place, session };
}

export async function githubStatus(
  options: GitHubStatusOptions = {},
  deps: GitHubDeps = defaultGitHubDeps(),
): Promise<GitHubStatus> {
  const dir = resolvePath(options.cwd ?? process.cwd(), options.project ?? ".");
  return (await connectGitHub(dir, deps)).status;
}

/** The terminal form of a status, shared with `zenith setup`. */
export function formatStatus(status: GitHubStatus): string[] {
  const lines = [
    `repo:       ${status.repo === null ? "-" : `${status.repo.fullName} (${status.repo.url})`}`,
    `base:       ${status.defaultBranch ?? "-"}`,
    `signed in:  ${status.login === null ? "-" : `${status.login}${status.auth === null ? "" : `, from ${describeSource(status.auth)}`}`}`,
    `can push:   ${status.canPush === null ? "-" : status.canPush ? "yes" : "no"}`,
    `branch:     ${status.branch ?? "-"}`,
    `pull:       ${status.pullRequest === null ? "none open" : `#${String(status.pullRequest.number)} ${status.pullRequest.url}`}`,
  ];
  if (status.error !== null) lines.push(`problem:    ${status.error}`);
  if (status.next !== null) lines.push(`next:       ${status.next}`);
  return lines;
}

/** `zenith github status`: exit 0 when an auto can be proposed from here, 2 otherwise. */
export async function runGitHubStatus(options: GitHubStatusOptions, deps: GitHubDeps = defaultGitHubDeps()): Promise<number> {
  const status = await githubStatus(options, deps);
  if (options.json === true) process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  else process.stdout.write(`${formatStatus(status).join("\n")}\n`);
  return status.ok ? 0 : 2;
}
