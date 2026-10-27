/**
 * The little shapes GitHub mode puts in the store. They are here rather than in `state/store.ts`
 * so the store keeps its one import from this directory to a type-only one, and nothing in
 * `apps/web/src/github/` has to be loaded for the editor to run in local mode.
 *
 * The token is deliberately not among them: it lives in `session.ts`, in memory and, as the person
 * chose, in `sessionStorage` or `localStorage`, and never in the store, in a URL or in a log
 * (site/docs/github.md).
 */

/** Who the pasted token belongs to, as `validateToken` reports it. */
export interface GitHubAuth {
  login: string;
  /**
   * OAuth scopes from `x-oauth-scopes`. A fine-grained PAT does not echo its permissions, so an
   * empty list is normal and is shown as "fine-grained", not as "no access".
   */
  scopes: string[];
  /**
   * How the session signed in: a pasted token, "Sign in with GitHub" (an OAuth token), or the
   * GitHub CLI's own sign-in in the desktop app (issue #213). Absent means a pasted token.
   */
  via?: "token" | "oauth" | "cli";
  /** Where the token is remembered (`TokenKeep`). Absent for the GitHub CLI, which is never kept. */
  keep?: TokenKeep;
}

/**
 * Where the page keeps the token between visits, the person's choice at sign-in: only in this
 * page's memory ("page"), until the tab closes ("tab", `sessionStorage`), or in this browser until
 * they sign out ("browser", `localStorage`). The desktop app keeps its own encrypted copy instead.
 */
export type TokenKeep = "page" | "tab" | "browser";

/** The repository, the branch it was opened from, and the branch edits are committed to. */
export interface RepoRef {
  owner: string;
  repo: string;
  /** Never written to (06 section 7). */
  base: string;
  branch: string;
}

export const repoLabel = (ref: RepoRef): string =>
  `${ref.owner}/${ref.repo}@${ref.branch}`;

/** Initials for the status chip, so no avatar is fetched and no image is embedded. */
export const initialsOf = (login: string): string => {
  const parts = login.split(/[-_.]/).filter((part) => part.length > 0);
  const first = parts[0]?.[0] ?? login[0] ?? "?";
  const second = parts[1]?.[0] ?? parts[0]?.[1] ?? "";
  return `${first}${second}`.toUpperCase();
};
