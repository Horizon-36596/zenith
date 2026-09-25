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
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { estimate as coreEstimate, hasErrors, ledger as coreLedger, prBody, render as coreRender } from "@horizon36596/zenith-core";
import { resolveSeason } from "@horizon36596/zenith-seasons";
import type {
  DesktopCommitResult,
  DesktopGitFile,
  DesktopGitStatus,
  DesktopPullRequestResult,
  DesktopPushResult,
} from "../../../web/src/project/desktopBridge.js";
import { confinePath, loadAutoAndPlan, tryCore, type LoadedAuto, type Project } from "./cli.js";
import { BridgeError, assertAutoFileName } from "./confine.js";
import { autoRelPath, loadDesktopProject } from "./project.js";

export interface GitOutput {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `git <args>` in `cwd`. The seam the tests replace. */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<GitOutput>;

export const execGit: GitRunner = (args, cwd) =>
  new Promise((resolve) => {
    execFile(
      "git",
      [...args],
      {
        cwd,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        // Never let git stop and wait for a password on a terminal nobody can see.
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
      },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

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
  currentBranch: (): string[] => ["symbolic-ref", "--quiet", "--short", "HEAD"],
  originHead: (): string[] => ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
  branchExists: (branch: string): string[] => ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
  checkRefFormat: (branch: string): string[] => ["check-ref-format", "--branch", branch],
  remoteUrl: (): string[] => ["remote", "get-url", "origin"],
  status: (): string[] => ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
  ahead: (): string[] => ["rev-list", "--count", "@{upstream}..HEAD"],
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

  private async git(root: string, args: readonly string[]): Promise<GitOutput> {
    return this.run(guardArgv(args), root);
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
    const files = parsePorcelain(await this.gitOk(root, gitArgv.status(), "Reading the git status"));
    const autosDir = slash(project.link.autosDir).replace(/\/+$/, "");
    const changedAutos = files.filter((file) => file.path.startsWith(`${autosDir}/`) && file.path.endsWith(".auto.json"));
    const hasRemote = (await this.git(root, gitArgv.remoteUrl())).code === 0;
    const aheadOut = await this.git(root, gitArgv.ahead());
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
      ahead: aheadOut.code === 0 ? Number(aheadOut.stdout.trim()) : null,
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

    const autoRel = autoRelPath(project, fileName);
    const paths = [autoRel];
    const renderRel = writeRender(project, loaded);
    if (renderRel !== null) paths.push(renderRel);
    if (project.link.waypoints !== undefined) {
      const waypoints = slash(project.link.waypoints);
      const changed = parsePorcelain((await this.git(root, gitArgv.status())).stdout).some((file) => file.path === waypoints);
      if (changed) paths.push(waypoints);
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
    if ((await this.git(root, gitArgv.remoteUrl())).code !== 0) {
      throw new BridgeError("This repository has no remote called origin, so there is nowhere to push.");
    }
    const out = await this.git(root, gitArgv.push(branch));
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
      throw new BridgeError(`The push failed.\n${detail.split("\n").slice(-6).join("\n")}`);
    }
    return { branch, remote: "origin" };
  }

  /**
   * Opens (or updates) the pull request for the current work branch (06 section 3): validation
   * errors block it, the branch is pushed first when the remote is behind, and the body is
   * `core.prBody` with the committed render's raw URL.
   */
  async openPullRequest(root: string, fileName: string, deps: PullRequestDeps): Promise<DesktopPullRequestResult> {
    const project = loadDesktopProject(root);
    const loaded = loadForGit(project, fileName);
    const errors = loaded.findings.filter((finding) => finding.severity === "error").length;
    if (hasErrors(loaded.findings)) {
      throw new BridgeError(`Validation has ${String(errors)} error${errors === 1 ? "" : "s"}; fix them before opening a pull request.`);
    }
    const base = await this.baseBranch(root);
    const branch = assertNotBase(await this.currentBranch(root), base);

    const remote = parseGitHubRemote((await this.gitOk(root, gitArgv.remoteUrl(), "Reading the origin remote")).trim());
    if (remote === null) throw new BridgeError("The origin remote is not a GitHub repository, so Zenith cannot open a pull request there.");

    const ahead = await this.git(root, gitArgv.ahead());
    if (ahead.code !== 0 || Number(ahead.stdout.trim()) > 0) await this.push(root);

    const renderRel = `${slash(project.link.autosDir).replace(/\/+$/, "")}/.renders/${loaded.auto.name}.svg`;
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
  const result = loadAutoAndPlan(confinePath(project.root, autoRelPath(project, fileName)), project);
  if (!result.ok) {
    throw new BridgeError(`${fileName} does not load: ${result.findings[0]?.message ?? "it does not parse"}`);
  }
  return result.loaded;
}

/** Writes `autosDir/.renders/<name>.svg`, the render the PR body shows (06 section 3). */
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
  const rel = `${slash(project.link.autosDir).replace(/\/+$/, "")}/.renders/${loaded.auto.name}.svg`;
  const full = confinePath(project.root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, renderOutcome.value, "utf8");
  return rel;
}
