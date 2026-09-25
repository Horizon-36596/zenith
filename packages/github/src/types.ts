/** The subset of GitHub's REST responses this client actually reads. */

export interface RepoSummary {
  owner: string;
  repo: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

export interface Repo extends RepoSummary {
  htmlUrl: string;
}

export interface Branch {
  name: string;
  sha: string;
  protected: boolean;
}

export interface ContentFile {
  path: string;
  sha: string;
  text: string;
}

export interface ContentEntry {
  name: string;
  path: string;
  sha: string;
  type: "file" | "dir" | "symlink" | "submodule";
}

export interface PutResult {
  /** The blob sha of the file as written, for the next `contents.put` call's `sha` argument. */
  sha: string;
  commitSha: string;
}

export interface MergeResult {
  /** `null` when the base already contained the head (nothing to merge). */
  commitSha: string | null;
  merged: boolean;
}

export interface PullRequest {
  number: number;
  url: string;
  htmlUrl: string;
  state: "open" | "closed";
  title: string;
  body: string | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
}

export interface PullFile {
  filename: string;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
  sha: string;
  patch?: string;
}

export interface User {
  login: string;
  id: number;
  name: string | null;
}
