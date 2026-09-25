/**
 * One route, and only one: `#/review/<owner>/<repo>/<number>` opens a pull request in review mode
 * (site/docs/github.md, review links), so a review can be linked to from a PR
 * comment, a chat message or a bookmark. Everything else in the editor is state, not a URL.
 *
 * The hash, never a query string: a pull request number is not sensitive, but keeping the app's
 * one route in the fragment means nothing about what is open is ever sent to the host.
 */
import { getState, setStatus } from "../state/store";
import { canReachGitHub, openReview } from "./actions";
import { openFixtureReview } from "./fixture";

export interface ReviewRoute {
  owner: string;
  repo: string;
  number: number;
}

/** `#/review/example-team/robot/12`, or null when the hash is anything else. */
export function parseReviewHash(hash: string): ReviewRoute | null {
  const match = /^#\/review\/([^/]+)\/([^/]+)\/(\d+)$/.exec(hash.trim());
  if (match === null) return null;
  return {
    owner: decodeURIComponent(match[1] as string),
    repo: decodeURIComponent(match[2] as string),
    number: Number(match[3]),
  };
}

/** The link that opens this review again later. */
export const reviewHash = (route: ReviewRoute): string =>
  `#/review/${route.owner}/${route.repo}/${String(route.number)}`;

function apply(): void {
  // The dev-only fixture: a review of two versions of the bundled example, with no network at all,
  // so the layout can be looked at (and screenshotted) without a repository or a token.
  if (import.meta.env.DEV && new URLSearchParams(window.location.search).get("review") === "fixture") {
    if (getState().review === null) void openFixtureReview();
    return;
  }
  const route = parseReviewHash(window.location.hash);
  if (route === null) return;
  const current = getState().review;
  if (
    current !== null &&
    current.owner === route.owner &&
    current.repo === route.repo &&
    current.number === route.number
  ) {
    return;
  }
  if (!canReachGitHub()) {
    setStatus(
      "error",
      `Sign in to GitHub to review ${route.owner}/${route.repo}#${String(route.number)}.`,
    );
    return;
  }
  void openReview(route.owner, route.repo, route.number);
}

/** Starts listening. Returns the teardown the effect that called it should run. */
export function initRouting(): () => void {
  apply();
  window.addEventListener("hashchange", apply);
  return () => {
    window.removeEventListener("hashchange", apply);
  };
}
