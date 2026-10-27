import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  canonicalize,
  estimate as coreEstimate,
  hasErrors,
  ledger as coreLedger,
  prBody,
  render as coreRender,
  type Finding,
} from "@horizon36596/zenith-core";
import {
  autoPath,
  fillRenderUrl,
  isPathAllowed,
  openOrUpdatePull,
  RENDER_URL_PLACEHOLDER,
  renderPath,
} from "@horizon36596/zenith-github";
import { resolveSeason } from "@horizon36596/zenith-seasons";
import type { Auto } from "@horizon36596/zenith-schema";
import { loadAutoAndPlan, resolveAutoPath } from "../autoLoad.js";
import { tryCore } from "../coreGate.js";
import { formatFindingsTable, type FileFindings } from "../findings.js";
import { defaultGitHubDeps, Git, GitCommandError, NextStepError, type GitHubDeps } from "../github.js";
import { confinePath, LINK_FILE, loadProject, type Project } from "../project.js";
import { connectGitHub } from "./githubStatus.js";

export interface ProposeOptions {
  cwd?: string;
  project?: string;
  json?: boolean;
  dryRun?: boolean;
  base?: string;
  /** The work branch; default `auto/<autoName>/<login>`. */
  branch?: string;
  /** The commit summary, after `auto(<autoName>): `; default "edit". */
  summary?: string;
  reviewers?: string[];
}

const slash = (path: string): string => path.split("\\").join("/");

/** An auto that validated, rendered, with its pull request body. */
export interface PreparedProposal {
  ok: true;
  project: Project;
  auto: Auto;
  findings: Finding[];
  seasonWarnings: string[];
  svg: string;
  /** The body from `core.prBody`, with `renderUrl` where the picture goes. */
  body: string;
}

/** The auto has an error finding (or could not be read), so nothing can be proposed. */
export interface BlockedProposal {
  ok: false;
  auto: string;
  findings: Finding[];
  errors: number;
  warnings: number;
  next: string;
}

const countOf = (findings: readonly Finding[], severity: Finding["severity"]): number =>
  findings.filter((finding) => finding.severity === severity).length;

/**
 * Step 1 of Propose: validate (an error blocks), then render the SVG and build the body. Throws
 * `NextStepError` when core cannot render, which only a build missing a core feature does.
 */
export function prepareProposal(
  path: string,
  project: Project,
  autoArg: string,
  renderUrlFor: (autoName: string) => string,
): PreparedProposal | BlockedProposal {
  const result = loadAutoAndPlan(path, project);
  const findings = result.ok ? result.loaded.findings : result.findings;
  if (!result.ok || hasErrors(findings)) {
    return {
      ok: false,
      auto: autoArg,
      findings,
      errors: countOf(findings, "error"),
      warnings: countOf(findings, "warning"),
      next: `Fix the error findings first: \`zenith validate ${autoArg} --explain\` (MCP: zenith.validate) says what each means; errors block a proposal, warnings go in its body.`,
    };
  }
  const { auto, plan, robot, field, seasonWarnings } = result.loaded;

  const estimateOutcome = tryCore(() => coreEstimate(plan, robot));
  const ledgerOutcome = tryCore(() => coreLedger(plan, field, resolveSeason(field).rules));
  const renderOutcome = tryCore(() => coreRender(plan, estimateOutcome.ok ? estimateOutcome.value : null, findings, ledgerOutcome.ok ? ledgerOutcome.value : [], {}));

  if (!renderOutcome.ok) {
    const message = [renderOutcome.message, !estimateOutcome.ok ? estimateOutcome.message : null, !ledgerOutcome.ok ? ledgerOutcome.message : null]
      .filter((line): line is string => line !== null)
      .join("\n");
    throw new NextStepError(message, "Update Zenith to a build whose core can render, then run this again.");
  }

  const body = prBody(
    auto,
    estimateOutcome.ok ? estimateOutcome.value : null,
    findings,
    ledgerOutcome.ok ? ledgerOutcome.value : [],
    { periodS: field.periods?.autoS, renderUrl: renderUrlFor(auto.name) },
  );
  return { ok: true, project, auto, findings, seasonWarnings: [...seasonWarnings], svg: renderOutcome.value, body };
}

export interface DryRunProposal {
  render: string;
  body: string;
  seasonWarnings: string[];
}

/**
 * `--dry-run`: validate, write the render to `autosDir/.renders/<name>.svg` and return the body
 * for a human to paste. Nothing touches git or GitHub.
 */
export function proposeDryRun(autoArg: string, options: Pick<ProposeOptions, "cwd" | "project">): DryRunProposal | BlockedProposal {
  const cwd = options.cwd ?? process.cwd();
  const project = loadProject(cwd, options.project, autoArg);
  const path = resolveAutoPath(cwd, project, autoArg);
  // No commit happens in a dry run, so there is no raw GitHub URL to point at; the local render path
  // is the closest useful thing to show a human, passed straight in.
  const renderRelativeFor = (name: string): string => `${project.link.autosDir}/.renders/${name}.svg`;
  const prepared = prepareProposal(path, project, autoArg, (name) => slash(renderRelativeFor(name)));
  if (!prepared.ok) return prepared;
  const renderRelative = renderRelativeFor(prepared.auto.name);
  const renderFull = confinePath(project.root, renderRelative);
  mkdirSync(dirname(renderFull), { recursive: true });
  writeFileSync(renderFull, prepared.svg, "utf8");
  return { render: renderRelative, body: prepared.body, seasonWarnings: prepared.seasonWarnings };
}

/** What `zenith propose --json` prints, and `zenith.propose` returns, once the pull request is open. */
export interface GitHubProposal {
  ok: true;
  auto: string;
  repo: string;
  base: string;
  branch: string;
  login: string;
  /** The new commit pushed to `branch`, or `null` when the branch already had these files. */
  commit: string | null;
  /** True when `base` had moved on and was merged into the work branch first. */
  mergedBase: boolean;
  /** The files, relative to the repository, that the push changed on `branch`. */
  files: string[];
  pushed: boolean;
  pullRequest: { number: number; url: string; created: boolean };
  errors: number;
  warnings: number;
  seasonWarnings: string[];
  next: string;
}

interface CommitFile {
  /** The path relative to the project root, which `zenith.json`'s directories are relative to. */
  projectPath: string;
  /** The path relative to the top of the repository. */
  repoPath: string;
  text: string;
}

/**
 * The real Propose, through git and the GitHub API (site/docs/github.md):
 *
 * 1. validate (errors block, warnings go in the body),
 * 2. find or create the work branch, `auto/<autoName>/<login>` unless `branch` is given, from the
 *    local branch, `origin`'s copy, or `origin/<base>`, and merge `base` into it (a conflict stops
 *    here and names the files),
 * 3. commit the canonical auto, the waypoints file if it has local changes, and the render SVG,
 * 4. push the branch (never forced) and open or update the pull request with the generated body.
 *
 * It never writes the base branch, never force-pushes and only commits files under the directories
 * `zenith.json` declares. The commits are built on a private index, so the working tree, the real
 * index and the checked-out branch are left alone, unless the work branch is the one checked out,
 * when it is fast-forwarded like a `git pull`. The token goes only to api.github.com: git pushes with
 * its own credentials and never sees it.
 */
export async function proposeToGitHub(
  autoArg: string,
  options: Omit<ProposeOptions, "json" | "dryRun"> = {},
  deps: GitHubDeps = defaultGitHubDeps(),
): Promise<GitHubProposal | BlockedProposal> {
  const cwd = options.cwd ?? process.cwd();
  const project = loadProject(cwd, options.project, autoArg);
  const path = resolveAutoPath(cwd, project, autoArg);
  const prepared = prepareProposal(path, project, autoArg, () => RENDER_URL_PLACEHOLDER);
  if (!prepared.ok) return prepared;
  const { auto, link } = { auto: prepared.auto, link: project.link };

  const { status, place, session } = await connectGitHub(project.root, deps);
  if (!status.ok || place === null || session === null || status.repo === null || status.defaultBranch === null) {
    throw new NextStepError(status.error ?? "GitHub is not ready.", status.next ?? "Run `zenith github status` to see what is missing.");
  }
  const { owner, repo, fullName } = status.repo;
  const login = session.user.login;
  const base = options.base?.trim() || status.defaultBranch;
  const branch = options.branch?.trim() || `auto/${auto.name}/${login}`;
  if (branch === base) {
    throw new NextStepError(
      `Refusing to write to "${base}": it is the base branch, and Zenith never writes there.`,
      "Leave --branch out to use the auto's own work branch, or give a different branch name.",
    );
  }
  const git = place.git;
  if ((await git.raw(["check-ref-format", "--branch", branch])).code !== 0) {
    throw new NextStepError(`"${branch}" is not a valid branch name.`, "Give --branch a name such as auto/<auto>/<your login>.");
  }

  // Fetch the base, and the work branch when origin has one.
  const baseRef = `refs/remotes/origin/${base}`;
  const remoteRef = `refs/remotes/origin/${branch}`;
  const listed = await git.raw(["ls-remote", "--heads", "origin", `refs/heads/${base}`, `refs/heads/${branch}`]);
  if (listed.code !== 0) throw fetchProblem(listed.stderr, base);
  const onOrigin = new Set(listed.stdout.split(/\r?\n/).map((line) => line.split("\t")[1]?.trim()));
  if (!onOrigin.has(`refs/heads/${base}`)) {
    throw new NextStepError(`origin has no branch called ${base}.`, "Pass --base with the branch pull requests should go into, such as main.");
  }
  const branchOnOrigin = onOrigin.has(`refs/heads/${branch}`);
  const fetched = await git.raw([
    "fetch",
    "--quiet",
    "--no-tags",
    "origin",
    `+refs/heads/${base}:${baseRef}`,
    ...(branchOnOrigin ? [`+refs/heads/${branch}:${remoteRef}`] : []),
  ]);
  if (fetched.code !== 0) throw fetchProblem(fetched.stderr, base);
  const tips = await refTips(git, [baseRef, remoteRef, `refs/heads/${branch}`]);
  const baseTip = tips.get(baseRef);
  if (baseTip === undefined) throw new NextStepError(`git did not fetch ${base} from origin.`, "Run zenith propose again.");
  const remoteTip = branchOnOrigin ? (tips.get(remoteRef) ?? null) : null;
  const localTip = tips.get(`refs/heads/${branch}`) ?? null;

  // The project must already be on the base: propose only writes under zenith.json's directories.
  const linkOnBase = `${place.prefix}${LINK_FILE}`;
  if ((await git.raw(["cat-file", "-e", `${baseTip}:${linkOnBase}`])).code !== 0) {
    throw new NextStepError(
      `${linkOnBase} is not on ${base} yet, and zenith propose only commits files under the autos, deploy and codegen folders.`,
      `Get the Zenith project onto ${base} once: commit ${linkOnBase} and the ${place.prefix}${link.autosDir} folder, push them or open a pull request for them, have it merged, then run zenith propose again.`,
    );
  }

  // Step 2: where the work branch starts.
  let tip: string;
  if (localTip !== null && remoteTip !== null) {
    if (await git.isAncestor(localTip, remoteTip)) tip = remoteTip;
    else if (await git.isAncestor(remoteTip, localTip)) tip = localTip;
    else {
      throw new NextStepError(
        `Your local ${branch} and origin's have both moved on since they last matched.`,
        `Bring them together: \`git switch ${branch}; git pull --no-rebase origin ${branch}\`, then run zenith propose again.`,
      );
    }
  } else {
    tip = localTip ?? remoteTip ?? baseTip;
  }

  const identity = await identityEnv(git, session.user);
  let mergedBase = false;
  if (!(await git.isAncestor(baseTip, tip))) {
    const merged = await git.raw(["merge-tree", "--write-tree", "--name-only", "--no-messages", tip, baseTip]);
    if (merged.code === 1) {
      const files = merged.stdout.split(/\r?\n/).slice(1).map((line) => line.trim()).filter((line) => line.length > 0);
      throw new NextStepError(
        `Merging ${base} into ${branch} conflicts in ${files.join(", ") || "some files"}.`,
        `Resolve it by hand: \`git switch ${branch}; git merge origin/${base}\`, fix those files, commit, then run zenith propose again.`,
        files,
      );
    }
    if (merged.code !== 0) {
      throw new NextStepError(
        `git could not merge ${base} into ${branch}: ${merged.stderr.trim().split(/\r?\n/)[0] ?? ""}`,
        "Update git to 2.38 or later (https://git-scm.com), then run zenith propose again.",
      );
    }
    const tree = merged.stdout.split(/\r?\n/)[0]?.trim() ?? "";
    tip = await git.ok(["commit-tree", tree, "-p", tip, "-p", baseTip, "-m", `Merge ${base} into ${branch}`], { env: identity });
    mergedBase = true;
  }

  // Step 3: the files, each checked against zenith.json's directories before git sees it.
  const files = await filesToCommit(git, place.prefix, project, prepared);
  for (const file of files) {
    if (!isPathAllowed(link, file.projectPath)) {
      throw new NextStepError(
        `${file.projectPath} is outside the autos, deploy and codegen folders zenith.json declares, so zenith propose will not commit it.`,
        `Move it under ${link.autosDir} and update zenith.json, or commit it yourself; then run zenith propose again.`,
      );
    }
  }
  const summary = options.summary?.trim() || "edit";
  const commit = await commitOnto(git, tip, files, `auto(${auto.name}): ${summary}`, identity);
  const newTip = commit ?? tip;
  const changed = (await git.ok(["diff-tree", "--no-commit-id", "--name-only", "-r", remoteTip ?? baseTip, newTip]))
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
  if (await git.isAncestor(newTip, baseTip)) {
    throw new NextStepError(
      `Nothing to propose: ${base} already has ${auto.name} exactly as it is here.`,
      `Edit the auto (MCP: the zenith.edit.* tools), then run zenith propose ${autoArg} again.`,
    );
  }

  // Move the local work branch, never the base.
  if (place.branch === branch) {
    // A file staged at a version that is neither HEAD's nor the working tree's would be replaced
    // by the `git add` below and lost if the fast-forward then fails, so stop before writing.
    for (const file of files) {
      const unstaged = await git.raw(["diff", "--quiet", "--", file.repoPath]);
      const staged = await git.raw(["diff", "--quiet", "--cached", "--", file.repoPath]);
      if (unstaged.code === 1 && staged.code === 1) {
        throw new NextStepError(
          `${file.repoPath} has staged changes that differ from the file on disk, and zenith propose would overwrite them.`,
          `Stage the file as it is (\`git add ${file.repoPath}\`) or unstage it (\`git restore --staged ${file.repoPath}\`), then run zenith propose again.`,
        );
      }
    }
    for (const file of files) writeFileSync(join(place.top, file.repoPath), file.text, "utf8");
    await git.ok(["add", "--", ...files.map((file) => file.repoPath)]);
    const forwarded = await git.raw(["merge", "--ff-only", "--quiet", newTip]);
    if (forwarded.code !== 0) {
      throw new NextStepError(
        `Your checkout of ${branch} has other changes git would overwrite.`,
        "Commit or discard those changes, then run zenith propose again.",
      );
    }
  } else if (localTip !== newTip) {
    // The expected old value makes git refuse if the branch moved meanwhile; "" when it did not
    // exist means it must still not exist, so a concurrent run that created it is not overwritten.
    await git.ok(["update-ref", "-m", "zenith propose", `refs/heads/${branch}`, newTip, localTip ?? ""]);
  }

  // Step 4: push (never forced), then open or update the pull request.
  let pushed = false;
  if (remoteTip !== newTip) {
    // A plain push of the local work branch: no `--force`, no `+`, so git refuses rather than
    // overwrite anything origin has that this commit does not.
    const push = await git.raw(["push", "--porcelain", "--set-upstream", "origin", `refs/heads/${branch}:refs/heads/${branch}`]);
    if (push.code !== 0) throw pushProblem(push.stdout + push.stderr, branch);
    pushed = true;
  }

  const svgPath = `${place.prefix}${renderPath(link, auto.name)}`;
  const body = fillRenderUrl(prepared.body, owner, repo, branch, svgPath);
  let pull;
  try {
    pull = await openOrUpdatePull(session.client, {
      owner,
      repo,
      branch,
      base,
      title: auto.name,
      body,
      reviewers: options.reviewers,
    });
  } catch (error) {
    throw new NextStepError(
      `${branch} was pushed, but GitHub would not open the pull request: ${error instanceof Error ? error.message : String(error)}`,
      `Open it on GitHub from ${branch} into ${base}, or run zenith propose ${autoArg} again.`,
    );
  }

  const warnings = countOf(prepared.findings, "warning");
  return {
    ok: true,
    auto: auto.name,
    repo: fullName,
    base,
    branch,
    login,
    commit,
    mergedBase,
    files: changed,
    pushed,
    pullRequest: { number: pull.pull.number, url: pull.pull.htmlUrl, created: pull.created },
    errors: 0,
    warnings,
    seasonWarnings: prepared.seasonWarnings,
    next: `Ask a teammate to review ${pull.pull.htmlUrl}; merging is a person's job, on GitHub. Run zenith propose ${autoArg} again after more edits to update it.`,
  };
}

/** The auto (canonical), its render, and the waypoints file when it has local changes. */
async function filesToCommit(git: Git, prefix: string, project: Project, prepared: PreparedProposal): Promise<CommitFile[]> {
  const { link } = project;
  const file = (projectPath: string, text: string): CommitFile => ({ projectPath, repoPath: `${prefix}${slash(projectPath)}`, text });
  const files = [
    file(autoPath(link, prepared.auto.name), canonicalize("auto", prepared.auto)),
    file(renderPath(link, prepared.auto.name), prepared.svg),
  ];
  if (link.waypoints !== undefined) {
    const full = confinePath(project.root, link.waypoints);
    if (existsSync(full)) {
      const repoPath = `${prefix}${slash(link.waypoints).replace(/^\.\//, "")}`;
      // Only a waypoints file the person changed goes in: compared with the checkout, not with the
      // branch, so a stale clone never reverts what the base did to the file since.
      const changed = (await git.ok(["status", "--porcelain=v1", "--", repoPath])).length > 0;
      if (changed) files.push(file(link.waypoints, readFileSync(full, "utf8")));
    }
  }
  return files;
}

/** The commit each of `refs` points at, in one call; a ref that does not exist is left out. */
async function refTips(git: Git, refs: readonly string[]): Promise<Map<string, string>> {
  const listed = await git.ok(["for-each-ref", "--format=%(refname) %(objectname)", ...refs]);
  const tips = new Map<string, string>();
  for (const line of listed.split(/\r?\n/)) {
    const [ref, sha] = line.trim().split(" ");
    if (ref !== undefined && sha !== undefined && refs.includes(ref)) tips.set(ref, sha);
  }
  return tips;
}

/**
 * Builds one commit on top of `parent` that changes only `files`, on a private index file, so the
 * person's own index and working tree are not touched. Returns `null` when nothing changed.
 */
async function commitOnto(
  git: Git,
  parent: string,
  files: CommitFile[],
  message: string,
  env: Record<string, string>,
): Promise<string | null> {
  const scratch = mkdtempSync(join(tmpdir(), "zenith-propose-"));
  try {
    const indexEnv = { ...env, GIT_INDEX_FILE: join(scratch, "index") };
    await git.ok(["read-tree", parent], { env: indexEnv });
    // The exact bytes, with no line-ending or other filter: canonical text is LF on every OS.
    const sources = files.map((file, index) => {
      const source = join(scratch, `file${String(index)}`);
      writeFileSync(source, file.text, "utf8");
      return source;
    });
    const blobs = (await git.ok(["hash-object", "-w", "--no-filters", "--", ...sources])).split(/\r?\n/);
    const entries = files.map((file, index) => `100644 blob ${blobs[index] ?? ""}\t${file.repoPath}`);
    await git.ok(["update-index", "--add", "--index-info"], { env: indexEnv, input: `${entries.join("\n")}\n` });
    const tree = await git.ok(["write-tree"], { env: indexEnv });
    const parentTree = await git.ok(["rev-parse", `${parent}^{tree}`]);
    if (tree === parentTree) return null;
    return await git.ok(["commit-tree", tree, "-p", parent, "-m", message], { env: indexEnv });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * git's own name and email when it has them; otherwise the GitHub account's, with GitHub's
 * no-reply address, so a fresh machine can still commit without a setup step.
 */
async function identityEnv(git: Git, user: { login: string; id: number; name: string | null }): Promise<Record<string, string>> {
  const configured = (await git.maybe(["config", "--get-regexp", "^user\\.(name|email)$"])) ?? "";
  const value = (key: string): string | null => {
    const line = configured.split(/\r?\n/).find((candidate) => candidate.toLowerCase().startsWith(`${key} `));
    return line === undefined ? null : line.slice(key.length + 1).trim() || null;
  };
  const name = value("user.name");
  const email = value("user.email");
  if (name && email) return {};
  const fallbackName = name || user.name || user.login;
  const fallbackEmail = email || `${String(user.id)}+${user.login}@users.noreply.github.com`;
  return {
    GIT_AUTHOR_NAME: fallbackName,
    GIT_AUTHOR_EMAIL: fallbackEmail,
    GIT_COMMITTER_NAME: fallbackName,
    GIT_COMMITTER_EMAIL: fallbackEmail,
  };
}

const AUTH_FAILURE =
  /authentication failed|could not read username|permission denied|403|terminal prompts disabled|invalid username or password|publickey|repository .*not found/i;

function fetchProblem(stderr: string, ref: string): NextStepError {
  const detail = new GitCommandError(["fetch"], { code: 1, stdout: "", stderr }).message;
  if (AUTH_FAILURE.test(stderr)) {
    return new NextStepError(`git could not read ${ref} from origin (${detail}).`, "Run `gh auth setup-git` so git uses your GitHub CLI sign-in, then run zenith propose again.");
  }
  if (/couldn't find remote ref/i.test(stderr)) {
    return new NextStepError(`origin has no branch called ${ref}.`, "Pass --base with the branch pull requests should go into, such as main.");
  }
  return new NextStepError(`git could not read ${ref} from origin (${detail}).`, "Check the internet connection, then run zenith propose again.");
}

function pushProblem(output: string, branch: string): NextStepError {
  const detail = new GitCommandError(["push"], { code: 1, stdout: "", stderr: output }).message;
  if (/rejected|non-fast-forward|fetch first|stale info/i.test(output)) {
    return new NextStepError(`origin's ${branch} moved while Zenith was proposing, and Zenith never force-pushes.`, "Run zenith propose again; it merges what is there first.");
  }
  if (AUTH_FAILURE.test(output)) {
    return new NextStepError(`git could not push ${branch} (${detail}).`, "Run `gh auth setup-git` so git pushes with your GitHub CLI sign-in, then run zenith propose again.");
  }
  return new NextStepError(`git could not push ${branch} (${detail}).`, "Check the message above, then run zenith propose again.");
}

/**
 * `zenith propose <auto>`: with `--dry-run`, validate, render and print the body; without it, the
 * whole Propose through git and GitHub. Exit 0 on success, 1 when the auto has an error finding,
 * 2 when something else stops it (the JSON then has `error` and `next`).
 */
export async function runPropose(autoArg: string, options: ProposeOptions, deps?: GitHubDeps): Promise<number> {
  if (options.dryRun === true) return runProposeDryRun(autoArg, options);

  let result: GitHubProposal | BlockedProposal;
  try {
    result = await proposeToGitHub(autoArg, options, deps ?? defaultGitHubDeps());
  } catch (error) {
    if (!(error instanceof NextStepError)) throw error;
    if (options.json === true) {
      process.stdout.write(
        `${JSON.stringify({ error: error.problem, next: error.next, ...(error.files.length > 0 ? { files: error.files } : {}) }, null, 2)}\n`,
      );
    } else {
      process.stderr.write(`zenith: ${error.problem}\nnext: ${error.next}\n`);
    }
    return 2;
  }
  if (!result.ok) return printBlocked(autoArg, result, options.json === true);
  if (options.json === true) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    for (const warning of result.seasonWarnings) process.stderr.write(`warning: ${autoArg}: ${warning}\n`);
    const verb = result.pullRequest.created ? "Opened" : "Updated";
    process.stdout.write(
      [
        `${verb} pull request #${String(result.pullRequest.number)}: ${result.pullRequest.url}`,
        `branch:   ${result.branch} -> ${result.base}${result.mergedBase ? ` (merged ${result.base} in first)` : ""}`,
        `commit:   ${result.commit ?? "none needed; the branch already had these files"}`,
        `files:    ${result.files.length > 0 ? result.files.join(", ") : "-"}`,
        `findings: 0 errors, ${String(result.warnings)} warnings`,
        `next:     ${result.next}`,
      ].join("\n") + "\n",
    );
  }
  return 0;
}

/** `zenith propose <auto> --dry-run`, which needs neither git nor GitHub, so it stays synchronous. */
export function runProposeDryRun(autoArg: string, options: Omit<ProposeOptions, "dryRun">): number {
  let result: DryRunProposal | BlockedProposal;
  try {
    result = proposeDryRun(autoArg, options);
  } catch (error) {
    if (!(error instanceof NextStepError)) throw error;
    if (options.json === true) process.stdout.write(`${JSON.stringify({ error: error.problem, next: error.next }, null, 2)}\n`);
    else process.stderr.write(`${error.problem}\n`);
    return 2;
  }
  if ("ok" in result) return printBlocked(autoArg, result, options.json === true);
  if (options.json === true) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    for (const warning of result.seasonWarnings) process.stderr.write(`warning: ${autoArg}: ${warning}\n`);
    process.stdout.write(`${result.body}\n`);
  }
  return 0;
}

function printBlocked(autoArg: string, blocked: BlockedProposal, json: boolean): number {
  const files: FileFindings[] = [{ path: autoArg, findings: blocked.findings }];
  if (json) process.stdout.write(`${JSON.stringify({ files }, null, 2)}\n`);
  else process.stdout.write(`${formatFindingsTable(files)}\n`);
  return 1;
}
