import { autoPath, renderPath } from "./allowlist.js";
import type { GitHubClient } from "./client.js";
import type { GitHubProject } from "./project.js";

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
}

export interface ProposeResult {
  url: string;
  number: number;
  branch: string;
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
  await project.save(branch, input.autoName, autoPath(link, input.autoName), input.autoText, summary);
  if (input.waypointsText !== undefined && link.waypoints) {
    await project.save(branch, input.autoName, link.waypoints, input.waypointsText, summary);
  }
  const svgPath = renderPath(link, input.autoName);
  await project.save(branch, input.autoName, svgPath, input.renderSvg, summary);

  const rawSvgUrl = `https://raw.githubusercontent.com/${project.owner}/${project.repo}/${branch}/${svgPath}`;
  const body = input.body.split(RENDER_URL_PLACEHOLDER).join(rawSvgUrl);

  const existing = await client.pulls.listForBranch(project.owner, project.repo, branch, "open");
  const pull =
    existing[0] ??
    (await client.pulls.create(project.owner, project.repo, {
      title: input.autoName,
      head: branch,
      base: project.base,
      body,
    }));
  const updated =
    existing[0] === undefined
      ? pull
      : await client.pulls.update(project.owner, project.repo, pull.number, { body });

  if (input.reviewers && input.reviewers.length > 0) {
    await client.pulls.requestReviewers(project.owner, project.repo, updated.number, input.reviewers);
  }

  return { url: updated.htmlUrl, number: updated.number, branch };
}
