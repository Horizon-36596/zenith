/**
 * Everything GitHub mode does to the store: sign in and out, open a repository, save to the work
 * branch, propose, and enter or leave review mode
 * (site/docs/github.md).
 *
 * The rule the whole file keeps: the token never leaves `session.ts`, and nothing here writes to
 * the base branch — `GitHubProject.save` refuses that before any request, and the editor disables
 * Save as well so the refusal is never the first the user hears of it.
 */
import { canonicalize, loadWaypoints, prBody } from "@horizon36596/zenith-core";
import {
  GitHubProject,
  RENDER_URL_PLACEHOLDER,
  loadReview,
  propose,
  type ProposeResult,
} from "@horizon36596/zenith-github";
import { adoptBackend, reportOpenError } from "../app/projectActions";
import { desktopBridge, isDesktop } from "../project/desktop";
import type { ZenithDesktopBridge } from "../project/desktopBridge";
import { confirmReplace } from "../app/unsaved";
import {
  closeProject,
  currentAllFindings,
  currentDerived,
  autoFieldOf,
  getState,
  loadedWaypoints,
  openAuto,
  openProject,
  setAuth,
  setBusy,
  setDialog,
  setRepo,
  setReview,
  setStatus,
  waypointsDirty,
} from "../state/store";
import { errorsHidden, hiddenErrorsWhere, turnOnWords } from "../state/features";
import { GitHubBackend, autoNameOf } from "./backend";
import { anchorRows, buildReviewModel, type ReviewState } from "./reviewModel";
import { currentClient, requireClient, restoreSession, signIn, signInWithCli, signOut } from "./session";
import { oauthToken, type OAuthRoute } from "./oauthSignIn";
import type { GitHubAuth, TokenKeep } from "./types";

const say = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/* ---- Sign in ------------------------------------------------------------- */

/** Validates the pasted token and puts the account in the store. Throws for the dialog to show. */
export async function signInWithToken(token: string, keep: TokenKeep): Promise<GitHubAuth> {
  const auth = await signIn(token, keep);
  setAuth(auth);
  await shareWithDesktop((github) => github.setToken(token, keep !== "page"));
  return auth;
}

/**
 * "Sign in with GitHub": gets an OAuth token by the route `oauthSignIn.ts` chose, then keeps it
 * exactly as a pasted token is kept, including the desktop app's encrypted copy for pull requests.
 */
export async function signInWithGitHubOAuth(route: OAuthRoute, keep: TokenKeep): Promise<GitHubAuth> {
  const token = await oauthToken(route);
  const auth = await signIn(token, keep, "oauth");
  setAuth(auth);
  await shareWithDesktop((github) => github.setToken(token, keep !== "page"));
  return auth;
}

/**
 * In the desktop app, the main process opens pull requests with a token of its own, so the one
 * sign-in dialog hands it the same token, or tells it to forget its own on sign-out, and the git
 * panel reads the new state. The page's sign-in already worked, so a failure here is left to the
 * git panel, which says what is wrong when it needs GitHub.
 */
async function shareWithDesktop(step: (github: ZenithDesktopBridge["github"]) => Promise<unknown>): Promise<void> {
  const github = desktopBridge()?.github;
  if (github === undefined) return;
  await step(github).catch(() => undefined);
  const { refreshGitHub } = await import("../project/desktopActions");
  await refreshGitHub();
}

/**
 * Signs in with the GitHub CLI's own sign-in, in the desktop app (issue #213): the main process runs
 * `gh auth token` and hands the token straight to `session.ts`, which keeps it in memory only. Throws
 * a sentence for the dialog when there is no desktop app, no CLI, or GitHub refuses the token.
 */
export async function signInWithGitHubCli(): Promise<GitHubAuth> {
  const cliToken = desktopBridge()?.github.cliToken;
  if (cliToken === undefined) throw new Error("Signing in with the GitHub CLI needs the Zenith desktop app.");
  const auth = await signInWithCli(await cliToken());
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
  await shareWithDesktop((github) => github.forgetToken());
  if (getState().project?.source.kind === "github") closeProject();
  setStatus("info", `Signed out of GitHub. The token is gone from ${isDesktop() ? "Zenith" : "this browser"}.`);
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
    const opened = await adoptBackend(
      buildBackend(owner, repo, base, login),
      undefined,
      `Opening ${owner}/${repo} will close it.`,
    );
    setDialog(null);
    if (opened) setStatus("ok", `Opened ${owner}/${repo} at ${base}.`);
  } catch (error) {
    reportOpenError(error, "repo", `${owner}/${repo}`);
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
  // A sentence of its own, since the key's status line shows it without the action's name first
  // (issue #412).
  if (state.backend?.canPropose !== true) return "Propose needs a project opened from GitHub.";
  const derived = currentDerived();
  // Every error counts, a hidden one too, as Validate and the CLI count them; the reason says where
  // a hidden one is, since Problems does not list it.
  const counted = errorsHidden(currentAllFindings(), state.auto, state.prefs.features);
  const { errors, hidden } = counted;
  if (errors > 0) {
    const head = `Validation has ${String(errors)} error${errors === 1 ? "" : "s"}${hiddenErrorsWhere(counted)}`;
    const them = errors === 1 ? "it" : "them";
    if (hidden === 0) return `${head}; fix ${them} and propose again.`;
    if (hidden === errors) return `${head}; fix ${them} or ${turnOnWords(counted.features)}, and propose again.`;
    return `${head}; ${turnOnWords(counted.features)} to see ${hidden === 1 ? "it" : "them"}, fix them all and propose again.`;
  }
  if (derived.staticSvg === null) return "The render is unavailable, and the pull request body needs it.";
  return null;
}

/**
 * The branch a proposal goes from: the one typed in the dialog, or, with the field empty, the branch
 * Save commits to. That is a custom one when the user named it, not always `auto/<auto>/<login>`,
 * and what was saved there is part of the proposal (issue #407). `undefined` leaves the choice to
 * `propose`, which only happens before an auto has named its branch.
 */
export function proposalBranch(typed: string | undefined, workBranch: string, base: string): string | undefined {
  const trimmed = typed?.trim() ?? "";
  if (trimmed.length > 0) return trimmed;
  return workBranch === base ? undefined : workBranch;
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

  // Every warning travels in the body, a hidden one too: the reviewer's settings are not the author's.
  const body = prBody(auto, derived.estimate, currentAllFindings(), derived.ledger, {
    renderUrl: RENDER_URL_PLACEHOLDER,
    // The auto period of the field this auto is planned on, its own when it sets one (issue #403).
    periodS: autoFieldOf(state)?.periods?.autoS,
  });

  // A waypoint change not yet saved goes into the proposal with the auto (issue #134).
  const waypoints = waypointsDirty(state) ? project.waypoints : undefined;
  const branch = proposalBranch(branchName, backend.workBranch, backend.base);
  const result = await propose(requireClient(), backend.githubProject, {
    autoName: autoNameOf(fileName),
    autoText: canonicalize("auto", auto),
    ...(waypoints === undefined ? {} : { waypointsText: canonicalize("waypoints", waypoints) }),
    renderSvg: derived.staticSvg,
    body,
    base: backend.base,
    branchName: branch,
    summary,
    // A file that changed on the branch since it was opened, the merge from base included, is
    // refused rather than written over (issue #407).
    ...(branch === undefined ? {} : { expectedShas: backend.expectedShas(branch) }),
  });
  backend.rememberShas(result.branch, result.shas);
  return result;
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
    const baseText = data.base === null ? null : canonicalize("auto", data.base);
    // A pull request that moves a waypoint is drawn with each side's own waypoints, not the base
    // branch tip's (issue #407); one that leaves the file alone uses the project's.
    const sideWaypoints = (text: string | null | undefined) =>
      text === undefined ? project.waypoints : text === null ? undefined : loadWaypoints(JSON.parse(text));
    const headWaypoints = sideWaypoints(data.waypoints?.head);
    const model = buildReviewModel({
      base: data.base,
      head: data.head,
      robot: project.robot,
      field: project.field,
      waypoints: headWaypoints,
      baseWaypoints: sideWaypoints(data.waypoints?.base),
    });
    await anchorRows(model.rows, path, headText, baseText);

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
    if (data.waypoints !== undefined && headWaypoints !== undefined) loadedWaypoints(headWaypoints);
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
