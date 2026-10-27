import { autoPath, renderPath } from "./allowlist.js";
import type { GitHubClient } from "./client.js";
import type { GitHubProject } from "./project.js";
import type { PullRequest } from "./types.js";

/**
 * The token `core.prBody` is expected to leave in the body wherever the rendered SVG's URL goes.
 * `propose` replaces it with the raw GitHub URL of the SVG once it has actually been committed to
 * the head branch (06 §3 step 4) — the two sides of this contract must agree on the token.
 */
export const RENDER_URL_PLACEHOLDER = "{{renderUrl}}";

export interface ProposeInput {
  autoName: string;
  /** Canonical text for `<autosDir>/<autoName>.auto.json`. Already canonicalized by the caller. */
  autoText: string;
  /** Canonical text for the waypoints file, only when it changed. */
  waypointsText?: string;
  /** The rendered field SVG, committed to `<autosDir>/.renders/<autoName>.svg`. */
  renderSvg: string;
  /** The PR body from `core.prBody`, containing `RENDER_URL_PLACEHOLDER` in place of the image URL. */
  body: string;
  base: string;
  reviewers?: string[];
  /** Overrides the work branch name; defaults to `auto/<autoName>/<login>`. */
  branchName?: string;
  /** Commit summary for the auto/waypoints commit; defaults to "edit". */
  summary?: string;
  /**
   * The blob sha each file was opened at, keyed by path, as `GitHubProject.save`'s `expectedSha`:
   * a file that changed on the work branch since then, including through the merge from base just
   * before, is refused instead of written over (issue #407).
   */
  expectedShas?: Record<string, string>;
}

export interface ProposeResult {
  url: string;
  number: number;
  branch: string;
  /** The blob sha each committed file now has, keyed by path, for the next save's check. */
  shas: Record<string, string>;
}

/**
 * `Propose`: a pull request that reviews itself (06 §3). Ensures the work branch exists and is
 * current with `base`, commits the auto (and waypoints, and the render SVG), then opens or updates
 * the PR against `base`. The caller has already run `zenith validate` and built `body` with
 * `core.prBody` — `propose` only wires the GitHub side together.
 */
export async function propose(
  client: GitHubClient,
  project: GitHubProject,
  input: ProposeInput,
): Promise<ProposeResult> {
  if (input.base !== project.base) {
    throw new Error(
      `propose was called with base "${input.base}" but this project is bound to base "${project.base}".`,
    );
  }

  const link = await project.link();
  const me = await client.users.me();
  const branch = await project.workBranch(input.autoName, me.login, input.branchName);

  // Step 2 of 06 §3: bring the work branch up to date with base before writing to it. On a real
  // conflict this throws MergeConflictError, naming the files, and propose stops here. The guard
  // refuses outright if `branch` (the merge's write target) were ever somehow the base itself
  // (finding 12) — project.save's own guard covers every write after this, but this call happens
  // before any of those.
  await client.repos.merge(project.owner, project.repo, branch, project.base, { base: project.base });

  const summary = input.summary ?? "edit";
  const shas: Record<string, string> = {};
  const commit = async (path: string, text: string): Promise<void> => {
    const expectedSha = input.expectedShas?.[path];
    const result = await project.save(
      branch,
      input.autoName,
      path,
      text,
      summary,
      expectedSha === undefined ? {} : { expectedSha },
    );
    shas[path] = result.sha;
  };
  await commit(autoPath(link, input.autoName), input.autoText);
  if (input.waypointsText !== undefined && link.waypoints) {
    await commit(link.waypoints, input.waypointsText);
  }
  const svgPath = renderPath(link, input.autoName);
  await commit(svgPath, input.renderSvg);

  const body = fillRenderUrl(input.body, project.owner, project.repo, branch, svgPath);
  const { pull } = await openOrUpdatePull(client, {
    owner: project.owner,
    repo: project.repo,
    branch,
    base: project.base,
    title: input.autoName,
    body,
    reviewers: input.reviewers,
  });
  return { url: pull.htmlUrl, number: pull.number, branch, shas };
}

/** The raw GitHub URL of a file committed on `branch`, which needs no hosting to show in a PR body. */
export function rawFileUrl(owner: string, repo: string, branch: string, path: string): string {
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
}

/** Replaces `RENDER_URL_PLACEHOLDER` in a `core.prBody` body with the committed SVG's raw URL. */
export function fillRenderUrl(body: string, owner: string, repo: string, branch: string, svgPath: string): string {
  return body.split(RENDER_URL_PLACEHOLDER).join(rawFileUrl(owner, repo, branch, svgPath));
}

export interface PullInput {
  owner: string;
  repo: string;
  /** The head branch, in the same repository. */
  branch: string;
  base: string;
  title: string;
  body: string;
  reviewers?: string[];
}

/**
 * Step 4 of Propose: updates the body of the open pull request from `branch` into `base`, or opens
 * one against `base` when there is none. A pull request from the same branch into another base is
 * left alone (issue #407). Shared by `propose` (the app, which commits through the Contents API)
 * and the CLI's `zenith propose` (which commits and pushes with git).
 */
export async function openOrUpdatePull(
  client: GitHubClient,
  input: PullInput,
): Promise<{ pull: PullRequest; created: boolean }> {
  const existing = await client.pulls.listForBranch(input.owner, input.repo, input.branch, "open", input.base);
  const open = existing.find((pull) => pull.base.ref === input.base);
  const pull =
    open === undefined
      ? await client.pulls.create(input.owner, input.repo, {
          title: input.title,
          head: input.branch,
          base: input.base,
          body: input.body,
        })
      : await client.pulls.update(input.owner, input.repo, open.number, { body: input.body });

  if (input.reviewers && input.reviewers.length > 0) {
    await client.pulls.requestReviewers(input.owner, input.repo, pull.number, input.reviewers);
  }
  return { pull, created: open === undefined };
}
