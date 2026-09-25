/**
 * @horizon36596/zenith-github: an isomorphic (browser + Node), `fetch`-based GitHub client — no Octokit, no
 * Node-only APIs. Covers PAT auth behind an `AuthProvider` seam, the Contents/branches/pulls REST
 * surface, and the project-shaped operations (`propose`, `loadReview`).
 *
 * Pure protocol and orchestration: this package never canonicalizes a file (that is
 * `core.canonicalize`) and never diffs one (`core.diff`); it moves already-canonical text to and
 * from GitHub (site/docs/github.md).
 */
export {
  AuthError,
  BaseBranchWriteError,
  ConflictError,
  GitHubError,
  MergeConflictError,
  NotFoundError,
  PathNotAllowedError,
  RateLimitError,
} from "./errors.js";
export { BrowserTokenStore, MemoryTokenStore, NodeTokenStore, PatAuth, validateToken } from "./auth.js";
export type { AuthProvider, TokenInfo, TokenStore } from "./auth.js";
export { HttpClient } from "./http.js";
export type { HttpOptions, RateLimitSnapshot, RequestOptions } from "./http.js";
export { GitHubClient } from "./client.js";
export type { ContentWriteGuard, GitHubClientOptions, MergeWriteGuard } from "./client.js";
export type {
  Branch,
  ContentEntry,
  ContentFile,
  MergeResult,
  PullFile,
  PullRequest,
  PutResult,
  Repo,
  RepoSummary,
  User,
} from "./types.js";
export { assertPathAllowed, autoPath, isPathAllowed, renderPath } from "./allowlist.js";
export { GitHubProject } from "./project.js";
export type { AutoListing, GitHubProjectOptions, OpenedProject } from "./project.js";
export { propose, RENDER_URL_PLACEHOLDER } from "./propose.js";
export type { ProposeInput, ProposeResult } from "./propose.js";
export { diffAnchor, diffFileHash, lineAnchor, loadReview } from "./review.js";
export type { ReviewData } from "./review.js";
