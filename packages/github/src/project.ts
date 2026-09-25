import type { Link } from "@horizon36596/zenith-schema";
import { parseLink } from "@horizon36596/zenith-schema";
import { assertPathAllowed } from "./allowlist.js";
import type { GitHubClient } from "./client.js";
import { BaseBranchWriteError, NotFoundError } from "./errors.js";
import type { PutResult } from "./types.js";

export interface GitHubProjectOptions {
  owner: string;
  repo: string;
  base: string;
}

export interface AutoListing {
  name: string;
  path: string;
}

export interface OpenedProject {
  link: Link;
  robotText: string;
  fieldText: string;
  waypointsText: string | null;
  autos: AutoListing[];
}

/**
 * The robot-repository-shaped view on top of `GitHubClient`: bound to one `{owner, repo, base}`,
 * it knows `zenith.json`'s layout, the work-branch naming convention, the never-write-base guard
 * and the path allowlist (site/docs/github.md).
 */
export class GitHubProject {
  readonly owner: string;
  readonly repo: string;
  readonly base: string;
  private readonly client: GitHubClient;
  private linkCache: Link | null = null;

  constructor(client: GitHubClient, options: GitHubProjectOptions) {
    this.client = client;
    this.owner = options.owner;
    this.repo = options.repo;
    this.base = options.base;
  }

  /** `zenith.json`, parsed and cached after the first read (by `open` or any write). */
  async link(): Promise<Link> {
    return this.getLink();
  }

  /**
   * Reads `zenith.json`, the robot, field and waypoint files, and lists `autosDir/*.auto.json`,
   * all at `base` (06 §1). Auto file text is not fetched here; the caller loads what it needs
   * through `contents.get`, and `loadReview` loads the two sides of a changed auto for review.
   */
  async open(): Promise<OpenedProject> {
    const link = await this.getLink();
    const [robotFile, fieldFile] = await Promise.all([
      this.client.contents.get(this.owner, this.repo, link.robot, this.base),
      this.client.contents.get(this.owner, this.repo, link.field, this.base),
    ]);
    const waypointsFile = link.waypoints
      ? await this.client.contents.get(this.owner, this.repo, link.waypoints, this.base)
      : null;
    const entries = await this.client.contents.list(this.owner, this.repo, link.autosDir, this.base);
    const autos = entries
      .filter((entry) => entry.type === "file" && entry.name.endsWith(".auto.json"))
      .map((entry) => ({ name: entry.name.slice(0, -".auto.json".length), path: entry.path }));
    return {
      link,
      robotText: robotFile.text,
      fieldText: fieldFile.text,
      waypointsText: waypointsFile?.text ?? null,
      autos,
    };
  }

  /** `auto/<autoName>/<login>`, or `custom` when the user typed a branch name (06 §1). */
  workBranchName(autoName: string, login: string, custom?: string): string {
    return custom && custom.trim().length > 0 ? custom : `auto/${autoName}/${login}`;
  }

  /** Ensures the work branch exists, creating it from `base` if it does not, and returns its name. */
  async workBranch(autoName: string, login: string, custom?: string): Promise<string> {
    const name = this.workBranchName(autoName, login, custom);
    try {
      await this.client.branches.get(this.owner, this.repo, name);
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
      await this.client.branches.create(this.owner, this.repo, name, { branch: this.base });
    }
    return name;
  }

  /**
   * Commits `text` (already canonical — `GitHubProject` does not canonicalize) to `path` on
   * `branch`, with message `auto(<autoName>): <summary or "edit">` (06 §1). Refuses a path outside
   * the allowlist (`PathNotAllowedError`) and refuses `branch === base` (`BaseBranchWriteError`),
   * both before any network call.
   */
  async save(branch: string, autoName: string, path: string, text: string, summary?: string): Promise<PutResult> {
    if (branch === this.base) throw new BaseBranchWriteError(branch);
    const link = await this.getLink();
    assertPathAllowed(link, path);
    const message = `auto(${autoName}): ${summary && summary.trim().length > 0 ? summary : "edit"}`;
    const sha = await this.currentSha(path, branch);
    // The checks above are a fast, network-free refusal; the guard passed here makes the same two
    // checks live inside GitHubClient.contents.put itself too, so they hold even for a caller that
    // reaches the client directly instead of through this method (finding 12).
    return this.client.contents.put(this.owner, this.repo, path, text, message, branch, sha, {
      base: this.base,
      link,
    });
  }

  private async getLink(): Promise<Link> {
    if (this.linkCache) return this.linkCache;
    const file = await this.client.contents.get(this.owner, this.repo, "zenith.json", this.base);
    const link = parseLink(JSON.parse(file.text));
    this.linkCache = link;
    return link;
  }

  private async currentSha(path: string, branch: string): Promise<string | undefined> {
    try {
      const file = await this.client.contents.get(this.owner, this.repo, path, branch);
      return file.sha;
    } catch (error) {
      if (error instanceof NotFoundError) return undefined;
      throw error;
    }
  }
}
