/**
 * Typed errors for the GitHub client (site/docs/github.md).
 *
 * Every network or protocol failure the client can distinguish gets its own class so callers (the
 * CLI, the MCP server, the editor) can branch on `instanceof` instead of parsing messages.
 */

/** Base class for anything the GitHub API itself reported. Carries the HTTP status when known. */
export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

/** 401, or 403 for a reason that is not a rate limit: the token is missing, bad or lacks scope. */
export class AuthError extends GitHubError {
  constructor(message: string, status?: number, body?: unknown) {
    super(message, status, body);
    this.name = "AuthError";
  }
}

/** 404: the repository, branch, path or pull request does not exist, or the token cannot see it. */
export class NotFoundError extends GitHubError {
  constructor(message: string, status?: number, body?: unknown) {
    super(message, status, body);
    this.name = "NotFoundError";
  }
}

/** 409, or 422 for a stale `sha`: someone else moved the ref or the file since we last read it. */
export class ConflictError extends GitHubError {
  constructor(message: string, status?: number, body?: unknown) {
    super(message, status, body);
    this.name = "ConflictError";
  }
}

/** 429, or 403 with `x-ratelimit-remaining: 0` / a secondary-rate-limit message, after retries. */
export class RateLimitError extends GitHubError {
  constructor(
    message: string,
    readonly retryAfterMs: number | undefined,
    status?: number,
    body?: unknown,
  ) {
    super(message, status, body);
    this.name = "RateLimitError";
  }
}

/**
 * The work branch could not be brought up to date with the base branch because the two sides
 * touched the same lines. `files` names the paths in conflict so the caller can tell the user
 * exactly what to resolve (06 §3 step 2).
 *
 * GitHub's merge API (`POST /repos/{owner}/{repo}/merges`) reports a 409 on conflict but does not
 * itself enumerate the files involved. `GitHubClient.repos.merge` recovers the list by comparing
 * both branches against their merge base and intersecting the changed paths — a conservative
 * superset of the true conflicts, not an exact diff3 result.
 */
export class MergeConflictError extends GitHubError {
  constructor(
    message: string,
    readonly files: string[],
    status?: number,
    body?: unknown,
  ) {
    super(message, status, body);
    this.name = "MergeConflictError";
  }
}

/**
 * A write targeted a path outside `zenith.json`'s `autosDir`, `deploy.dir` or `codegen.dir`
 * (site/docs/github.md). Never sent to GitHub.
 */
export class PathNotAllowedError extends Error {
  constructor(readonly path: string) {
    super(`"${path}" is outside the allowed autos/deploy/codegen directories; refusing to write it.`);
    this.name = "PathNotAllowedError";
  }
}

/**
 * A write targeted the base branch. The app never writes to base (06 §7); this guard makes that a
 * thrown error instead of a silent commit. Never sent to GitHub.
 */
export class BaseBranchWriteError extends Error {
  constructor(readonly branch: string) {
    super(`Refusing to write to "${branch}": it is the base branch, and Zenith never writes there.`);
    this.name = "BaseBranchWriteError";
  }
}
