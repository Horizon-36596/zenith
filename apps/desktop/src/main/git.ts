/**
 * Commit, push and open a pull request from the desktop app, over the user's own `git`
 * (site/docs/github.md, site/docs/editor.md).
 *
 * The rules, each enforced here rather than trusted to the UI:
 *
 * - `git` is run with an argv array through `execFile`, never a shell string.
 * - Zenith never commits to or pushes the base branch. On the base, a commit first moves to the work
 *   branch `auto/<autoName>/<who>` (06 section 1), and push and pull request refuse outright.
 * - Nothing is ever forced: no `--force`, no `--force-with-lease`, no `+refspec`.
 * - Only the auto, its render and the waypoints file are staged, by path; other changes in the
 *   repository are the user's and are left alone.
 * - The commit message is `auto(<name>): <summary>` with "edit" when the summary is empty (06 section 1).
 * - Hooks run as the repository configures them; Zenith never passes `--no-verify`.
 */
import { execFile } from "node:child_process";
import { lstatSync, mkdirSync, realpathSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { estimate as coreEstimate, hasErrors, ledger as coreLedger, prBody, render as coreRender } from "@horizon36596/zenith-core";
import { resolveSeason } from "@horizon36596/zenith-seasons";
import type {
  DesktopCommitResult,
  DesktopGitFile,
  DesktopGitHubOrigin,
  DesktopGitStatus,
  DesktopPullRequestResult,
  DesktopPushResult,
} from "../../../web/src/project/desktopBridge.js";
import { loadAutoAndPlan, tryCore, type LoadedAuto, type Project } from "./cli.js";
import { BridgeError, assertAutoFileName, confineRelative } from "./confine.js";
import { autoRelPath, loadDesktopProject, writeReplacing } from "./project.js";

export interface GitOutput {
  code: number;
  stdout: string;
  stderr: string;
  /** True when git was stopped for taking longer than the call's time limit. */
  timedOut?: boolean;
}

/** What one git call may set: a time limit, for the calls that wait on the network. */
export interface GitCallOptions {
  timeoutMs?: number;
}

/** Runs `git <args>` in `cwd`. The seam the tests replace. */
export type GitRunner = (args: readonly string[], cwd: string, options?: GitCallOptions) => Promise<GitOutput>;

/**
 * Thrown when there is no `git` to run, so the panel says that instead of "not a git repository",
 * which is what an empty failure would otherwise read as. ghCli.ts says the same of a missing `gh`.
 */
export class GitMissingError extends BridgeError {
  constructor() {
    super("Git is not installed on this computer, so Zenith cannot commit. Install Git for Windows from git-scm.com, then reopen this panel.");
    this.name = "GitMissingError";
  }
}

/**
 * How long a push may wait on the network before Zenith stops it and says so (SET BY HAND: a push of
 * an auto is a few kilobytes, so two minutes is a stalled connection, not a slow one).
 */
export const PUSH_TIMEOUT_MS = 120_000;

export const execGit: GitRunner = (args, cwd, options = {}) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      [...args],
      {
        cwd,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
        // Never let git stop and wait for a password on a terminal nobody can see.
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
      },
      (error, stdout, stderr) => {
        if (error !== null && error.code === "ENOENT") {
          reject(new GitMissingError());
          return;
        }
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        // execFile kills a call that runs past its timeout and reports it as killed.
        const timedOut = error !== null && options.timeoutMs !== undefined && error.killed === true;
        resolve({ code, stdout: String(stdout), stderr: String(stderr), ...(timedOut ? { timedOut } : {}) });
      },
    );
  });

/** Git's words for a remote it could not reach at all: no network, no DNS, a firewall. */
const UNREACHABLE = /Could not resolve host|unable to access|Failed to connect|Connection timed out|Connection refused|Network is unreachable|Could not read from remote repository/i;

const FORCE_FLAGS = new Set(["--force", "-f", "--force-with-lease", "--force-if-includes", "--mirror", "--delete", "-d"]);

/**
 * Every argv this module hands to git goes through here. It is the last line of defence for the
 * "never force" rule: a force flag or a `+` refspec throws before git is started.
 */
export function guardArgv(args: readonly string[]): readonly string[] {
  if (args[0] === "push") {
    for (const arg of args.slice(1)) {
      if (FORCE_FLAGS.has(arg) || arg.startsWith("--force") || arg.startsWith("+") || arg.includes(":+")) {
        throw new BridgeError("Zenith never force-pushes.");
      }
    }
  }
  if (args.includes("--no-verify")) throw new BridgeError("Zenith never skips the repository's hooks.");
  return args;
}

/** The argv builders, one per git call, so the tests can pin every command Zenith runs. */
export const gitArgv = {
  isRepo: (): string[] => ["rev-parse", "--is-inside-work-tree"],
  topLevel: (): string[] => ["rev-parse", "--show-toplevel"],
  prefix: (): string[] => ["rev-parse", "--show-prefix"],
  currentBranch: (): string[] => ["symbolic-ref", "--quiet", "--short", "HEAD"],
  originHead: (): string[] => ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
  branchExists: (branch: string): string[] => ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
  checkRefFormat: (branch: string): string[] => ["check-ref-format", "--branch", branch],
  remoteUrl: (): string[] => ["remote", "get-url", "origin"],
  status: (): string[] => ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
  /** Commits on HEAD that origin's copy of `branch` lacks; fails when origin has no copy yet. */
  ahead: (branch: string): string[] => ["rev-list", "--count", `refs/remotes/origin/${branch}..HEAD`],
  userName: (): string[] => ["config", "user.name"],
  createBranch: (branch: string): string[] => ["switch", "-c", branch],
  switchBranch: (branch: string): string[] => ["switch", branch],
  add: (paths: readonly string[]): string[] => ["add", "--", ...paths],
  stagedChanges: (paths: readonly string[]): string[] => ["diff", "--cached", "--quiet", "--", ...paths],
  commit: (message: string, paths: readonly string[]): string[] => ["commit", "-m", message, "--", ...paths],
  head: (): string[] => ["rev-parse", "HEAD"],
  tracked: (path: string): string[] => ["cat-file", "-e", `HEAD:${path}`],
  push: (branch: string): string[] => ["push", "--set-upstream", "origin", `refs/heads/${branch}:refs/heads/${branch}`],
};

/** `auto(<name>): <summary>`, one line, "edit" when the summary is empty (06 section 1). */
export function commitMessage(autoName: string, summary: string): string {
  const line = summary.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  return `auto(${autoName}): ${line === "" ? "edit" : line}`;
}

/** Lower-case letters, digits and single hyphens: safe inside a branch name. */
export const slugWho = (who: string): string =>
  who
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "zenith";

/** `auto/<autoName>/<who>`, the work branch of 06 section 1. */
export const workBranchName = (autoName: string, who: string): string => `auto/${autoName}/${slugWho(who)}`;

/** Throws when `branch` is the base or no branch at all; the one check every write path makes. */
export function assertNotBase(branch: string | null, base: string): string {
  if (branch === null) {
    throw new BridgeError("The repository is not on a branch (HEAD is detached). Switch to a branch first.");
  }
  if (branch === base) {
    throw new BridgeError(`Zenith never commits to or pushes ${base}, the base branch. Commit first; it moves the work to its own branch.`);
  }
  return branch;
}

/** `github.com/owner/repo` from an https or ssh remote URL, or null for anything else. */
export function parseGitHubRemote(url: string): { owner: string; repo: string } | null {
  const trimmed = url.trim();
  const match =
    /^https:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(trimmed) ??
    /^(?:ssh:\/\/)?git@github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(trimmed);
  if (match === null) return null;
  return { owner: match[1] as string, repo: match[2] as string };
}

/** Parses `git status --porcelain=v1 -z`; a rename's second entry (the old path) is skipped. */
export function parsePorcelain(output: string): DesktopGitFile[] {
  const files: DesktopGitFile[] = [];
  const entries = output.split("\0");
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i] as string;
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    files.push({ status, path: entry.slice(3) });
    if (status.startsWith("R") || status.startsWith("C")) i += 1;
  }
  return files;
}

const slash = (path: string): string => path.split("\\").join("/").replace(/^\.\//, "");

/** Two folder paths name the same folder, as the operating system compares them (git prints `/`). */
export function samePath(a: string, b: string): boolean {
  const key = (path: string): string => {
    let full = resolve(path);
    try {
      full = realpathSync.native(full);
    } catch {
      // A folder that is not there keeps its spelling; it then matches nothing that is.
    }
    full = full.replace(/[\\/]+$/, "");
    return process.platform === "win32" ? full.toLowerCase() : full;
  };
  return a !== "" && key(a) === key(b);
}

export interface GitDeps {
  run?: GitRunner;
  /** The signed-in GitHub login, for the work branch name; null falls back to git's user.name. */
  login?: () => Promise<string | null>;
}

export interface PullRequestDeps {
  /** A bearer token for api.github.com; throws when there is none. */
  token: () => Promise<string>;
  /** Opens or updates the pull request. Injected so the tests never reach GitHub. */
  openOrUpdate: (input: {
    token: string;
    owner: string;
    repo: string;
    head: string;
    base: string;
    title: string;
    body: string;
  }) => Promise<DesktopPullRequestResult>;
}

export class GitService {
  private readonly run: GitRunner;
  private readonly login: () => Promise<string | null>;

  constructor(deps: GitDeps = {}) {
    this.run = deps.run ?? execGit;
    this.login = deps.login ?? (() => Promise.resolve(null));
  }

  private async git(root: string, args: readonly string[], options?: GitCallOptions): Promise<GitOutput> {
    return options === undefined ? this.run(guardArgv(args), root) : this.run(guardArgv(args), root, options);
  }

  private async gitOk(root: string, args: readonly string[], what: string): Promise<string> {
    const out = await this.git(root, args);
    if (out.code !== 0) {
      const detail = (out.stderr || out.stdout).trim().split("\n").slice(-6).join("\n");
      throw new BridgeError(`${what} failed.${detail === "" ? "" : `\n${detail}`}`);
    }
    return out.stdout;
  }

  async currentBranch(root: string): Promise<string | null> {
    const out = await this.git(root, gitArgv.currentBranch());
    return out.code === 0 ? out.stdout.trim() : null;
  }

  /** The branch pull requests go into: the remote's default, else `main` or `master` if one exists. */
  async baseBranch(root: string): Promise<string> {
    const head = await this.git(root, gitArgv.originHead());
    if (head.code === 0 && head.stdout.trim() !== "") return head.stdout.trim().replace(/^origin\//, "");
    for (const candidate of ["main", "master"]) {
      if ((await this.git(root, gitArgv.branchExists(candidate))).code === 0) return candidate;
    }
    return "main";
  }

  private async who(root: string): Promise<string> {
    const login = await this.login();
    if (login !== null && login !== "") return login;
    const name = await this.git(root, gitArgv.userName());
    return name.code === 0 && name.stdout.trim() !== "" ? name.stdout.trim() : "zenith";
  }

  /**
   * The project folder's path inside the repository as git prints paths (`planner/`, or "" when
   * `zenith.json` is at the top). `git status` lists paths from the top of the repository and
   * `HEAD:<path>` names one from there, so a project in a subfolder needs this to match its own
   * project-relative paths (issue #406).
   */
  private async prefix(root: string): Promise<string> {
    return (await this.gitOk(root, gitArgv.prefix(), "Finding the project in the repository")).trim();
  }

  /**
   * The GitHub repository the folder is a clone of, and the base to open it at in GitHub mode
   * (issue #213), or null when the folder is not a repository or `origin` is not on github.com.
   * Read only: it runs `rev-parse`, `remote get-url` and `symbolic-ref`, nothing that writes.
   */
  async githubOrigin(root: string): Promise<DesktopGitHubOrigin | null> {
    try {
      return await this.readGitHubOrigin(root);
    } catch (error) {
      // Without git there is no clone to offer GitHub mode for; the open dialog just does not offer it.
      if (error instanceof GitMissingError) return null;
      throw error;
    }
  }

  private async readGitHubOrigin(root: string): Promise<DesktopGitHubOrigin | null> {
    if ((await this.git(root, gitArgv.isRepo())).code !== 0) return null;
    // GitHub mode reads zenith.json at the top of the repository, so a project in a subfolder of
    // one cannot be opened there.
    const top = await this.git(root, gitArgv.topLevel());
    if (top.code !== 0 || !samePath(top.stdout.trim(), root)) return null;
    const url = await this.git(root, gitArgv.remoteUrl());
    if (url.code !== 0) return null;
    const remote = parseGitHubRemote(url.stdout);
    if (remote === null) return null;
    return { ...remote, base: await this.baseBranch(root) };
  }

  async status(root: string, fileName: string | null): Promise<DesktopGitStatus> {
    const isRepo = (await this.git(root, gitArgv.isRepo())).code === 0;
    if (!isRepo) {
      return {
        isRepo: false,
        branch: null,
        base: "main",
        onBase: false,
        workBranch: null,
        changedAutos: [],
        otherChanges: 0,
        hasRemote: false,
        ahead: null,
      };
    }
    const project = loadDesktopProject(root);
    const [branch, base] = [await this.currentBranch(root), await this.baseBranch(root)];
    const prefix = await this.prefix(root);
    const files = parsePorcelain(await this.gitOk(root, gitArgv.status(), "Reading the git status"));
    const autosDir = `${prefix}${slash(project.link.autosDir).replace(/\/+$/, "")}`;
    const changedAutos = files
      .filter((file) => file.path.startsWith(`${autosDir}/`) && file.path.endsWith(".auto.json"))
      .map((file) => ({ ...file, path: file.path.slice(prefix.length) }));
    const hasRemote = (await this.git(root, gitArgv.remoteUrl())).code === 0;
    const aheadOut = branch === null ? null : await this.git(root, gitArgv.ahead(branch));
    let workBranch: string | null = branch;
    if (branch === base && fileName !== null) {
      const autoName = assertAutoFileName(fileName).replace(/\.auto\.json$/, "");
      workBranch = workBranchName(autoName, await this.who(root));
    }
    return {
      isRepo,
      branch,
      base,
      onBase: branch === base,
      workBranch,
      changedAutos,
      otherChanges: files.length - changedAutos.length,
      hasRemote,
      ahead: aheadOut !== null && aheadOut.code === 0 ? Number(aheadOut.stdout.trim()) : null,
    };
  }

  /**
   * Commits one auto, its render and the waypoints file (when it changed) with the 06 message. On
   * the base branch it first switches to the work branch, creating it when it does not exist; git's
   * own refusal to switch over conflicting changes is reported as it is.
   */
  async commit(root: string, fileName: string, summary: string): Promise<DesktopCommitResult> {
    const project = loadDesktopProject(root);
    const loaded = loadForGit(project, fileName);
    const autoName = loaded.auto.name;
    const autoRel = autoRelPath(project, fileName);
    // Refused before anything moves: with the auto unchanged, the commit would hold only its render.
    // Status paths are from the top of the repository; the paths staged below are from the project.
    const prefix = await this.prefix(root);
    const changed = parsePorcelain(await this.gitOk(root, gitArgv.status(), "Reading the git status"));
    if (!changed.some((file) => file.path === `${prefix}${autoRel}`)) {
      throw new BridgeError(`Nothing to commit: ${fileName} is the same as in the last commit. Save your edits first.`);
    }
    const base = await this.baseBranch(root);
    let branch = await this.currentBranch(root);
    if (branch === null) {
      throw new BridgeError("The repository is not on a branch (HEAD is detached). Switch to a branch first.");
    }

    let createdBranch = false;
    if (branch === base) {
      const target = workBranchName(autoName, await this.who(root));
      await this.gitOk(root, gitArgv.checkRefFormat(target), `Checking the branch name ${target}`);
      const exists = (await this.git(root, gitArgv.branchExists(target))).code === 0;
      await this.gitOk(
        root,
        exists ? gitArgv.switchBranch(target) : gitArgv.createBranch(target),
        `Moving to the work branch ${target}`,
      );
      createdBranch = !exists;
      branch = await this.currentBranch(root);
    }
    // Checked again after the switch: whatever happened above, the commit below never lands on base.
    const onto = assertNotBase(branch, base);

    const paths = [autoRel];
    const renderRel = writeRender(project, loaded);
    if (renderRel !== null) paths.push(renderRel);
    if (project.link.waypoints !== undefined) {
      const waypoints = slash(project.link.waypoints);
      if (changed.some((file) => file.path === `${prefix}${waypoints}`)) paths.push(waypoints);
    }

    await this.gitOk(root, gitArgv.add(paths), "Staging the auto");
    if ((await this.git(root, gitArgv.stagedChanges(paths))).code === 0) {
      throw new BridgeError(`Nothing to commit: ${fileName} is the same as in the last commit. Save your edits first.`);
    }
    const message = commitMessage(autoName, summary);
    await this.gitOk(root, gitArgv.commit(message, paths), "The commit");
    const sha = (await this.gitOk(root, gitArgv.head(), "Reading the new commit")).trim();
    return { branch: onto, createdBranch, sha, message, files: paths };
  }

  async push(root: string): Promise<DesktopPushResult> {
    const branch = assertNotBase(await this.currentBranch(root), await this.baseBranch(root));
    const url = await this.git(root, gitArgv.remoteUrl());
    if (url.code !== 0) {
      throw new BridgeError("This repository has no remote called origin, so there is nowhere to push.");
    }
    const where = parseGitHubRemote(url.stdout) === null ? "the origin remote" : "GitHub";
    const out = await this.git(root, gitArgv.push(branch), { timeoutMs: PUSH_TIMEOUT_MS });
    if (out.timedOut === true) {
      throw new BridgeError("The push took too long, so Zenith stopped it. Check the connection and try again.");
    }
    if (out.code !== 0) {
      const detail = out.stderr.trim();
      if (/rejected|non-fast-forward|fetch first/i.test(detail)) {
        throw new BridgeError(
          `GitHub has commits on ${branch} that this computer does not. Pull them first (git pull), then push again. Zenith never force-pushes.`,
        );
      }
      if (/Authentication failed|could not read Username|Permission denied|403/i.test(detail)) {
        throw new BridgeError(
          "GitHub refused the push: this computer is not signed in to git for that repository, or the account cannot push to it. Sign in with GitHub Desktop, Git Credential Manager or `gh auth login`, then push again.",
        );
      }
      if (UNREACHABLE.test(detail)) {
        throw new BridgeError(`Could not reach ${where}. Check the connection and try again.`);
      }
      throw new BridgeError(`The push failed.\n${detail.split("\n").slice(-6).join("\n")}`);
    }
    return { branch, remote: "origin" };
  }

  /**
   * Opens (or updates) the pull request for the current work branch (06 section 3): validation
   * errors block it, the branch is pushed first when origin's copy is behind, and the body is
   * `core.prBody` with the committed render's raw URL.
   *
   * The pull request holds the branch's commits, while the check and the body read the auto on
   * disk, so an auto that differs from the last commit (a save since the commit, or never
   * committed) is refused: both then describe exactly what is pushed (issue #406).
   */
  async openPullRequest(root: string, fileName: string, deps: PullRequestDeps): Promise<DesktopPullRequestResult> {
    const project = loadDesktopProject(root);
    const autoRel = autoRelPath(project, fileName);
    const prefix = await this.prefix(root);
    const files = parsePorcelain(await this.gitOk(root, gitArgv.status(), "Reading the git status"));
    if (files.some((file) => file.path === `${prefix}${autoRel}`)) {
      throw new BridgeError(
        `${fileName} has changes that are not committed, and a pull request holds only commits. Commit it first, then open the pull request.`,
      );
    }
    const loaded = loadForGit(project, fileName);
    const errors = loaded.findings.filter((finding) => finding.severity === "error").length;
    if (hasErrors(loaded.findings)) {
      throw new BridgeError(`Validation has ${String(errors)} error${errors === 1 ? "" : "s"}; fix them before opening a pull request.`);
    }
    const base = await this.baseBranch(root);
    const branch = assertNotBase(await this.currentBranch(root), base);

    const remote = parseGitHubRemote((await this.gitOk(root, gitArgv.remoteUrl(), "Reading the origin remote")).trim());
    if (remote === null) throw new BridgeError("The origin remote is not a GitHub repository, so Zenith cannot open a pull request there.");

    const ahead = await this.git(root, gitArgv.ahead(branch));
    if (ahead.code !== 0 || Number(ahead.stdout.trim()) > 0) await this.push(root);

    // From the top of the repository: both `HEAD:<path>` and the raw URL name the file from there.
    const renderRel = `${prefix}${renderRelPath(project, loaded.auto.name)}`;
    const renderCommitted = (await this.git(root, gitArgv.tracked(renderRel))).code === 0;
    const renderUrl = renderCommitted
      ? `https://raw.githubusercontent.com/${remote.owner}/${remote.repo}/${branch}/${renderRel}`
      : undefined;
    const estimateOutcome = tryCore(() => coreEstimate(loaded.plan, loaded.robot));
    const ledgerOutcome = tryCore(() => coreLedger(loaded.plan, loaded.field, resolveSeason(loaded.field).rules));
    const body = prBody(
      loaded.auto,
      estimateOutcome.ok ? estimateOutcome.value : null,
      loaded.findings,
      ledgerOutcome.ok ? ledgerOutcome.value : [],
      { periodS: loaded.field.periods?.autoS, ...(renderUrl === undefined ? {} : { renderUrl }) },
    );
    return deps.openOrUpdate({
      token: await deps.token(),
      owner: remote.owner,
      repo: remote.repo,
      head: branch,
      base,
      title: loaded.auto.name,
      body,
    });
  }
}

function loadForGit(project: Project, fileName: string): LoadedAuto {
  const result = loadAutoAndPlan(confineRelative(project.root, autoRelPath(project, fileName)), project);
  if (!result.ok) {
    throw new BridgeError(`${fileName} does not load: ${result.findings[0]?.message ?? "it does not parse"}`);
  }
  return result.loaded;
}

/** The project-relative path of an auto's render, `autosDir/.renders/<name>.svg`. */
const renderRelPath = (project: Project, autoName: string): string =>
  `${slash(project.link.autosDir).replace(/\/+$/, "")}/.renders/${autoName}.svg`;

const isLink = (path: string): boolean => {
  try {
    // Node reports a Windows junction as a symbolic link too.
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

/**
 * Writes `autosDir/.renders/<name>.svg`, the render the PR body shows (06 section 3). Both paths are
 * confined through links like every other write, and a `.renders` that is itself a link is refused,
 * so a link committed to the repository cannot lead the write out of it (issue #406). A link at the
 * render's own name is removed, never followed, once its folder is known to be a plain one inside
 * the project, so the render replaces it. That has to happen before the file's path is confined:
 * the confinement resolves links, and would otherwise read the link's target as the render's place
 * and refuse the commit instead of replacing the link (issue #453).
 */
function writeRender(project: Project, loaded: LoadedAuto): string | null {
  const estimateOutcome = tryCore(() => coreEstimate(loaded.plan, loaded.robot));
  const ledgerOutcome = tryCore(() => coreLedger(loaded.plan, loaded.field, resolveSeason(loaded.field).rules));
  const renderOutcome = tryCore(() =>
    coreRender(
      loaded.plan,
      estimateOutcome.ok ? estimateOutcome.value : null,
      loaded.findings,
      ledgerOutcome.ok ? ledgerOutcome.value : [],
      {},
    ),
  );
  if (!renderOutcome.ok) return null;
  const rel = renderRelPath(project, loaded.auto.name);
  const dirRel = dirname(rel);
  const dir = confineRelative(project.root, dirRel);
  if (isLink(dir)) {
    throw new BridgeError(`${dirRel} is a link, so Zenith will not write the render through it. Make it a plain folder, then commit again.`);
  }
  mkdirSync(dir, { recursive: true });
  // lstat, not stat: a file symlink, a directory symlink and a Windows junction are each unlinked
  // themselves, and nothing at their target is touched.
  const own = join(dir, basename(rel));
  if (isLink(own)) unlinkSync(own);
  writeReplacing(confineRelative(project.root, rel), renderOutcome.value);
  return rel;
}
