import type { Link } from "@horizon36596/zenith-schema";
import type { AuthProvider } from "./auth.js";
import { assertPathAllowed } from "./allowlist.js";
import { decodeBase64Utf8, encodeBase64Utf8 } from "./base64.js";
import { BaseBranchWriteError, MergeConflictError, NotFoundError } from "./errors.js";
import { HttpClient, type HttpOptions } from "./http.js";
import type {
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

export type GitHubClientOptions = HttpOptions;

interface RawRepo {
  name: string;
  full_name: string;
  owner: { login: string };
  default_branch: string;
  private: boolean;
  html_url: string;
  permissions?: { push?: boolean };
}

interface RawBranch {
  name: string;
  commit: { sha: string };
  protected: boolean;
}

interface RawContentFile {
  type: "file";
  path: string;
  sha: string;
  content: string;
  encoding: string;
}

interface RawContentEntry {
  name: string;
  path: string;
  sha: string;
  type: "file" | "dir" | "symlink" | "submodule";
}

interface RawCommitRef {
  sha: string;
}

interface RawCompare {
  merge_base_commit: RawCommitRef;
  files?: { filename: string }[];
}

interface RawMerge {
  sha: string;
}

interface RawPull {
  number: number;
  url: string;
  html_url: string;
  state: "open" | "closed";
  title: string;
  body: string | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
}

interface RawPullFile {
  filename: string;
  status: string;
  sha: string;
  patch?: string;
}

interface RawUser {
  login: string;
  id: number;
  name: string | null;
}

function toRepo(raw: RawRepo): Repo {
  return {
    owner: raw.owner.login,
    repo: raw.name,
    fullName: raw.full_name,
    defaultBranch: raw.default_branch,
    private: raw.private,
    htmlUrl: raw.html_url,
  };
}

function toBranch(raw: RawBranch): Branch {
  return { name: raw.name, sha: raw.commit.sha, protected: raw.protected };
}

function toPull(raw: RawPull): PullRequest {
  return {
    number: raw.number,
    url: raw.url,
    htmlUrl: raw.html_url,
    state: raw.state,
    title: raw.title,
    body: raw.body,
    head: { ref: raw.head.ref, sha: raw.head.sha },
    base: { ref: raw.base.ref, sha: raw.base.sha },
  };
}

function toPullFile(raw: RawPullFile): PullFile {
  return { filename: raw.filename, status: raw.status as PullFile["status"], sha: raw.sha, patch: raw.patch };
}

/**
 * Bounds a write `GitHubClient.contents.put`/`deleteFile` may make: `base` is the branch a write
 * must never target, and `link` is `zenith.json`'s own allowlist of directories a path must fall
 * under. Passed by `GitHubProject` on every call it makes, so the guard lives in the client method
 * itself — not only in `GitHubProject.save`'s own pre-check — and a raw `GitHubClient` call that
 * passes the same guard is refused exactly the same way. The guard used to sit above the client,
 * which let a direct client call around it.
 */
export interface ContentWriteGuard {
  base: string;
  link: Link;
}

/** The lighter guard `repos.merge` needs: it has no path, only a branch that must never be the
 * merge's write target. */
export interface MergeWriteGuard {
  base: string;
}

/**
 * An isomorphic (browser + Node), `fetch`-based GitHub client: no Octokit, no Node-only APIs. One
 * instance is bound to an `AuthProvider`, not to a repository — `GitHubProject` is the layer bound
 * to `{owner, repo, base}` (site/docs/github.md).
 */
export class GitHubClient {
  private readonly http: HttpClient;

  constructor(auth: AuthProvider, options: GitHubClientOptions = {}) {
    this.http = new HttpClient(auth, options);
  }

  /** The most recent `x-ratelimit-*` snapshot seen, or `null` before the first request. */
  get rateLimit() {
    return this.http.rateLimit;
  }

  readonly repos = {
    /** Repositories the authenticated account can push to, across personal and org affiliation. */
    listWritable: async (): Promise<RepoSummary[]> => {
      const repos = await this.paginate<RawRepo>("/user/repos", {
        affiliation: "owner,collaborator,organization_member",
        per_page: 100,
      });
      return repos.filter((repo) => repo.permissions?.push).map(toRepo);
    },

    get: async (owner: string, repo: string): Promise<Repo> => {
      const raw = await this.http.request<RawRepo>(`/repos/${owner}/${repo}`);
      return toRepo(raw);
    },

    /**
     * Merges `head` into `base` (`POST /repos/{owner}/{repo}/merges`) — the "update the work
     * branch from the base branch" step of propose (06 §3 step 2). On conflict, recovers the
     * files in play by comparing both branches against their merge base; see `MergeConflictError`.
     * `guard`, when given, refuses the call outright when `base` (the ref the merge commit lands
     * on) is the project's protected base branch (finding 12).
     */
    merge: async (owner: string, repo: string, base: string, head: string, guard?: MergeWriteGuard): Promise<MergeResult> => {
      if (guard !== undefined && base === guard.base) {
        throw new BaseBranchWriteError(base);
      }
      try {
        const raw = await this.http.request<RawMerge | null>(`/repos/${owner}/${repo}/merges`, {
          method: "POST",
          body: { base, head, commit_message: `Merge ${head} into ${base}` },
        });
        if (raw === null) return { commitSha: null, merged: false };
        return { commitSha: raw.sha, merged: true };
      } catch (error) {
        if (error instanceof Error && error.name === "ConflictError") {
          const files = await this.conflictingFiles(owner, repo, base, head);
          throw new MergeConflictError(
            `"${head}" cannot be merged into "${base}" without a conflict in ${files.join(", ") || "an unknown file"}.`,
            files,
          );
        }
        throw error;
      }
    },
  };

  readonly branches = {
    list: async (owner: string, repo: string): Promise<Branch[]> => {
      const raw = await this.paginate<RawBranch>(`/repos/${owner}/${repo}/branches`, { per_page: 100 });
      return raw.map(toBranch);
    },

    get: async (owner: string, repo: string, branch: string): Promise<Branch> => {
      const raw = await this.http.request<RawBranch>(
        `/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`,
      );
      return toBranch(raw);
    },

    /** Creates `name` pointing at `from`'s current sha. Never touches an existing ref (no force-push). */
    create: async (owner: string, repo: string, name: string, from: { branch: string }): Promise<Branch> => {
      const source = await this.branches.get(owner, repo, from.branch);
      await this.http.request(`/repos/${owner}/${repo}/git/refs`, {
        method: "POST",
        body: { ref: `refs/heads/${name}`, sha: source.sha },
      });
      return { name, sha: source.sha, protected: false };
    },
  };

  readonly contents = {
    get: async (owner: string, repo: string, path: string, ref: string): Promise<ContentFile> => {
      const raw = await this.http.request<RawContentFile>(`/repos/${owner}/${repo}/contents/${encodePath(path)}`, {
        query: { ref },
      });
      if (raw.type !== "file") {
        throw new NotFoundError(`"${path}" at ${ref} is a ${raw.type}, not a file.`);
      }
      return { path: raw.path, sha: raw.sha, text: decodeBase64Utf8(raw.content) };
    },

    /** `guard`, when given, refuses a write to the base branch or to a path outside `link`'s
     * allowlist before any network call (finding 12). `GitHubProject.save` always passes one; a
     * raw `GitHubClient` caller that cares about the same protection can pass one too. */
    put: async (
      owner: string,
      repo: string,
      path: string,
      text: string,
      message: string,
      branch: string,
      sha?: string,
      guard?: ContentWriteGuard,
    ): Promise<PutResult> => {
      if (guard !== undefined) {
        if (branch === guard.base) throw new BaseBranchWriteError(branch);
        assertPathAllowed(guard.link, path);
      }
      const raw = await this.http.request<{ content: { sha: string }; commit: { sha: string } }>(
        `/repos/${owner}/${repo}/contents/${encodePath(path)}`,
        {
          method: "PUT",
          body: {
            message,
            content: encodeBase64Utf8(text),
            branch,
            ...(sha === undefined ? {} : { sha }),
          },
        },
      );
      return { sha: raw.content.sha, commitSha: raw.commit.sha };
    },

    list: async (owner: string, repo: string, dir: string, ref: string): Promise<ContentEntry[]> => {
      const raw = await this.http.request<RawContentEntry[]>(`/repos/${owner}/${repo}/contents/${encodePath(dir)}`, {
        query: { ref },
      });
      return raw.map((entry) => ({ name: entry.name, path: entry.path, sha: entry.sha, type: entry.type }));
    },

    /** Same guard as `put` (site/docs/github.md): the "never write base, only inside
     * the allowlist" rule covers a delete exactly as much as it covers a write. */
    deleteFile: async (
      owner: string,
      repo: string,
      path: string,
      message: string,
      branch: string,
      sha: string,
      guard?: ContentWriteGuard,
    ): Promise<void> => {
      if (guard !== undefined) {
        if (branch === guard.base) throw new BaseBranchWriteError(branch);
        assertPathAllowed(guard.link, path);
      }
      await this.http.request(`/repos/${owner}/${repo}/contents/${encodePath(path)}`, {
        method: "DELETE",
        body: { message, sha, branch },
      });
    },
  };

  readonly git = {
    /** The commit both `base` and `head` descend from, via the compare API's `merge_base_commit`. */
    mergeBase: async (owner: string, repo: string, base: string, head: string): Promise<string | null> => {
      try {
        const raw = await this.http.request<RawCompare>(
          `/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
        );
        return raw.merge_base_commit.sha;
      } catch (error) {
        if (error instanceof NotFoundError) return null;
        throw error;
      }
    },
  };

  readonly pulls = {
    create: async (
      owner: string,
      repo: string,
      input: { title: string; head: string; base: string; body: string },
    ): Promise<PullRequest> => {
      const raw = await this.http.request<RawPull>(`/repos/${owner}/${repo}/pulls`, {
        method: "POST",
        body: { title: input.title, head: input.head, base: input.base, body: input.body },
      });
      return toPull(raw);
    },

    update: async (
      owner: string,
      repo: string,
      number: number,
      input: { title?: string; body?: string; state?: "open" | "closed" },
    ): Promise<PullRequest> => {
      const raw = await this.http.request<RawPull>(`/repos/${owner}/${repo}/pulls/${number}`, {
        method: "PATCH",
        body: input,
      });
      return toPull(raw);
    },

    get: async (owner: string, repo: string, number: number): Promise<PullRequest> => {
      const raw = await this.http.request<RawPull>(`/repos/${owner}/${repo}/pulls/${number}`);
      return toPull(raw);
    },

    listForBranch: async (
      owner: string,
      repo: string,
      branch: string,
      state: "open" | "closed" | "all" = "open",
    ): Promise<PullRequest[]> => {
      const raw = await this.paginate<RawPull>(`/repos/${owner}/${repo}/pulls`, {
        head: `${owner}:${branch}`,
        state,
        per_page: 100,
      });
      return raw.map(toPull);
    },

    files: async (owner: string, repo: string, number: number): Promise<PullFile[]> => {
      const raw = await this.paginate<RawPullFile>(`/repos/${owner}/${repo}/pulls/${number}/files`, {
        per_page: 100,
      });
      return raw.map(toPullFile);
    },

    requestReviewers: async (owner: string, repo: string, number: number, reviewers: string[]): Promise<void> => {
      if (reviewers.length === 0) return;
      await this.http.request(`/repos/${owner}/${repo}/pulls/${number}/requested_reviewers`, {
        method: "POST",
        body: { reviewers },
      });
    },
  };

  readonly users = {
    me: async (): Promise<User> => {
      const raw = await this.http.request<RawUser>("/user");
      return { login: raw.login, id: raw.id, name: raw.name };
    },
  };

  /** Follows `Link: rel="next"` headers to collect every page. */
  private async paginate<T>(path: string, query: Record<string, string | number | undefined>): Promise<T[]> {
    const results: T[] = [];
    let next: string | undefined = path;
    let nextQuery: Record<string, string | number | undefined> | undefined = query;
    while (next) {
      const { body, headers } = await this.http.requestRaw(next, { query: nextQuery });
      results.push(...(body as T[]));
      next = nextLinkFrom(headers.get("link"));
      nextQuery = undefined;
    }
    return results;
  }

  /** Files touched on both sides since the merge base: a conservative guess at the conflict set. */
  private async conflictingFiles(owner: string, repo: string, base: string, head: string): Promise<string[]> {
    const mergeBase = await this.git.mergeBase(owner, repo, base, head);
    if (mergeBase === null) return [];
    const [baseSide, headSide] = await Promise.all([
      this.comparedFiles(owner, repo, mergeBase, base),
      this.comparedFiles(owner, repo, mergeBase, head),
    ]);
    return [...baseSide].filter((path) => headSide.has(path));
  }

  private async comparedFiles(owner: string, repo: string, from: string, to: string): Promise<Set<string>> {
    const raw = await this.http.request<RawCompare>(
      `/repos/${owner}/${repo}/compare/${encodeURIComponent(from)}...${encodeURIComponent(to)}`,
    );
    return new Set((raw.files ?? []).map((file) => file.filename));
  }
}

function encodePath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function nextLinkFrom(header: string | null): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(",")) {
    const match = /<([^>]+)>;\s*rel="next"/.exec(part.trim());
    if (match) return match[1];
  }
  return undefined;
}
