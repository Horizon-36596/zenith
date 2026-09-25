/**
 * Everything GitHub mode does to the store: sign in and out, open a repository, save to the work
 * branch, propose, and enter or leave review mode
 * (site/docs/github.md).
 *
 * The rule the whole file keeps: the token never leaves `session.ts`, and nothing here writes to
 * the base branch — `GitHubProject.save` refuses that before any request, and the editor disables
 * Save as well so the refusal is never the first the user hears of it.
 */
import { canonicalize, prBody } from "@horizon36596/zenith-core";
import {
  GitHubProject,
  RENDER_URL_PLACEHOLDER,
  diffAnchor,
  loadReview,
  propose,
  type ProposeResult,
} from "@horizon36596/zenith-github";
import { adoptBackend, reportOpenError } from "../app/projectActions";
import { confirmReplace } from "../app/unsaved";
import {
  closeProject,
  currentDerived,
  getState,
  openAuto,
  openProject,
  setAuth,
  setBusy,
  setDialog,
  setRepo,
  setReview,
  setStatus,
} from "../state/store";
import { GitHubBackend, autoNameOf } from "./backend";
import { buildReviewModel, type ReviewState } from "./reviewModel";
import { currentClient, requireClient, restoreSession, signIn, signOut } from "./session";
import type { GitHubAuth } from "./types";

const say = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/* ---- Sign in ------------------------------------------------------------- */

/** Validates the pasted token and puts the account in the store. Throws for the dialog to show. */
export async function signInWithToken(token: string, remember: boolean): Promise<GitHubAuth> {
  const auth = await signIn(token, remember);
  setAuth(auth);
  return auth;
}

/**
 * Forgets the token and closes a GitHub project, since it can no longer be read or written. With
 * unsaved edits in a GitHub project, asks first, since signing out would throw them away.
 */
export async function signOutOfGitHub(): Promise<void> {
  if (
    getState().project?.source.kind === "github" &&
    !(await confirmReplace("Signing out of GitHub will close it."))
  ) {
    return;
  }
  signOut();
  setAuth(null);
  setRepo(null);
  if (getState().project?.source.kind === "github") closeProject();
  setStatus("info", "Signed out of GitHub. The token is gone from this tab.");
}

/** Picks a remembered session back up on load. Silent when there is nothing to pick up. */
export async function restoreGitHubSession(): Promise<void> {
  try {
    const auth = await restoreSession();
    if (auth !== null) setAuth(auth);
  } catch (error) {
    setStatus("error", say(error));
  }
}

/* ---- Opening a repository ------------------------------------------------ */

/** The GitHub backend the store holds, or null when the open project is a local one. */
export function currentGitHubBackend(): GitHubBackend | null {
  const backend = getState().backend;
  return backend instanceof GitHubBackend ? backend : null;
}

function buildBackend(owner: string, repo: string, base: string, login: string): GitHubBackend {
  const client = requireClient();
  return new GitHubBackend({
    client,
    project: new GitHubProject(client, { owner, repo, base }),
    login,
    onBranch: (branch) => {
      const current = getState().repo;
      setRepo(current === null ? { owner, repo, base, branch } : { ...current, branch });
    },
  });
}

/** Reads `zenith.json` and everything it names at `base`, and opens the first auto. */
export async function openFromGitHub(owner: string, repo: string, base: string): Promise<void> {
  setBusy(true);
  try {
    const login = getState().auth?.login ?? (await requireClient().users.me()).login;
    await adoptBackend(
      buildBackend(owner, repo, base, login),
      undefined,
      `Opening ${owner}/${repo} will close it.`,
    );
    setDialog(null);
    setStatus("ok", `Opened ${owner}/${repo} at ${base}.`);
  } catch (error) {
    reportOpenError(error);
  } finally {
    setBusy(false);
  }
}

/** Names the work branch by hand. An empty name goes back to `auto/<auto>/<login>`. */
export function setWorkBranch(name: string, fileName: string | null): void {
  const backend = currentGitHubBackend();
  if (backend === null) return;
  backend.setBranch(name, fileName === null ? undefined : autoNameOf(fileName));
}

/* ---- Propose ------------------------------------------------------------- */

/** Errors block a proposal; warnings are listed in the body instead (06 section 3 step 1). */
export function proposeBlockedReason(state = getState()): string | null {
  if (state.review !== null) return "Review mode is read only; open the auto from its branch to edit it.";
  if (state.auto === null) return "No auto is open.";
  if (state.backend?.canPropose !== true) {
    return "Propose opens a pull request, so it needs a project opened from GitHub.";
  }
  const derived = currentDerived();
  const errors = derived.findings.filter((finding) => finding.severity === "error").length;
  if (errors > 0) {
    return `Validation has ${String(errors)} error${errors === 1 ? "" : "s"}; fix them and propose again.`;
  }
  if (derived.staticSvg === null) return "The render is unavailable, and the pull request body needs it.";
  return null;
}

/**
 * `Propose`: renders the routine, builds the body with `core.prBody`, and opens or updates the
 * pull request against the base branch (06 section 3). The caller has already checked
 * `proposeBlockedReason`; anything thrown here is for the dialog to show, including
 * `MergeConflictError` with the files in play.
 */
export async function proposeCurrent(summary: string, branchName?: string): Promise<ProposeResult> {
  const state = getState();
  const backend = currentGitHubBackend();
  const { auto, project, fileName } = state;
  if (backend === null || auto === null || project === null || fileName === null) {
    throw new Error("Propose needs an auto open in a project from GitHub.");
  }
  const derived = currentDerived();
  if (derived.staticSvg === null) throw new Error("The render is unavailable.");

  const body = prBody(auto, derived.estimate, derived.findings, derived.ledger, {
    renderUrl: RENDER_URL_PLACEHOLDER,
    periodS: project.field.periods?.autoS,
  });

  return propose(requireClient(), backend.githubProject, {
    autoName: autoNameOf(fileName),
    autoText: canonicalize("auto", auto),
    renderSvg: derived.staticSvg,
    body,
    base: backend.base,
    branchName: branchName !== undefined && branchName.trim().length > 0 ? branchName : undefined,
    summary,
  });
}

/* ---- Review -------------------------------------------------------------- */

/** `https://github.com/owner/repo/pull/12`, or `owner/repo#12`, or a number for the open repo. */
export function parsePrReference(
  input: string,
  fallback: { owner: string; repo: string } | null,
): { owner: string; repo: string; number: number } {
  const trimmed = input.trim();
  const url = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(trimmed);
  if (url) return { owner: url[1] as string, repo: url[2] as string, number: Number(url[3]) };
  const short = /^([^/\s]+)\/([^#\s]+)#(\d+)$/.exec(trimmed);
  if (short) return { owner: short[1] as string, repo: short[2] as string, number: Number(short[3]) };
  const bare = /^#?(\d+)$/.exec(trimmed);
  if (bare && fallback !== null) {
    return { owner: fallback.owner, repo: fallback.repo, number: Number(bare[1]) };
  }
  throw new Error(`"${input}" is not a pull request URL, owner/repo#number, or a number.`);
}

/** Loads a pull request into review mode: base ghosted under head, with the changed steps listed. */
export async function openReview(owner: string, repo: string, number: number): Promise<void> {
  if (!(await confirmReplace(`Opening ${owner}/${repo}#${String(number)} will close it.`))) {
    setStatus("info", `Kept the unsaved edits in ${getState().fileName ?? "this auto"}.`);
    return;
  }
  setBusy(true);
  try {
    const client = requireClient();
    const login = getState().auth?.login ?? (await client.users.me()).login;
    const meta = await client.pulls.get(owner, repo, number);
    const backend = buildBackend(owner, repo, meta.base.ref, login);
    const project = await backend.open();
    openProject(project, backend);

    const data = await loadReview(client, backend.githubProject, number);
    const path =
      data.files.find((file) => file.endsWith(".auto.json")) ??
      `${project.link.autosDir}/${data.head.name}.auto.json`;
    const headText = canonicalize("auto", data.head);
    const model = buildReviewModel({
      base: data.base,
      head: data.head,
      robot: project.robot,
      field: project.field,
      waypoints: project.waypoints,
    });
    for (const row of model.rows) {
      row.anchor = await diffAnchor(path, headText, row.stepId, row.kind === "removed" ? "base" : "head");
    }

    const review: ReviewState = {
      owner,
      repo,
      number,
      htmlUrl: data.prMeta.htmlUrl,
      title: data.prMeta.title,
      path,
      baseRef: data.prMeta.base.ref,
      headRef: data.prMeta.head.ref,
      files: data.files,
      head: data.head,
      base: data.base,
      model,
    };
    openAuto(`${data.head.name}.auto.json`, data.head, headText);
    setReview(review);
    setDialog(null);
    setStatus("info", `Reviewing ${owner}/${repo}#${String(number)}. The editor is read only.`);
  } catch (error) {
    setStatus("error", say(error));
  } finally {
    setBusy(false);
  }
}

/** The dialog's and the palette's entry point: whatever the user pasted. */
export async function openReviewFromUrl(input: string): Promise<void> {
  const state = getState();
  try {
    const reference = parsePrReference(
      input,
      state.repo === null ? null : { owner: state.repo.owner, repo: state.repo.repo },
    );
    await openReview(reference.owner, reference.repo, reference.number);
  } catch (error) {
    setStatus("error", say(error));
  }
}

/** Leaves review mode, keeping the repository open so the auto can be opened for editing. */
export function closeReview(): void {
  setReview(null);
  if (window.location.hash.startsWith("#/review/")) window.location.hash = "";
  setStatus("info", "Left review mode.");
}

/** True when a client exists, which is what the review route needs before it can load anything. */
export const canReachGitHub = (): boolean => currentClient() !== null;
