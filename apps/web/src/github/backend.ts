/**
 * GitHub mode's `ProjectBackend`: the same five methods the local one has, over
 * `packages/github`'s `GitHubProject` (site/docs/github.md).
 *
 * Reads come from the work branch when it exists and from the base branch otherwise, so opening an
 * auto that has already been edited on a branch shows the edited version. Writes only ever go to
 * the work branch: `GitHubProject.save` throws `BaseBranchWriteError` before any request if they
 * would not, and the editor disables Save as well so the refusal is never the first sign of it.
 */
import { canonicalize, loadAuto, loadField, loadRobot, loadWaypoints } from "@horizon36596/zenith-core";
import {
  BaseBranchWriteError,
  NotFoundError,
  autoPath,
  type GitHubClient,
  type GitHubProject,
} from "@horizon36596/zenith-github";
import type { Auto, Link } from "@horizon36596/zenith-schema";
import type { ProjectBackend, SaveResult } from "../project/backend";
import type { LoadedAuto, Project } from "../project/types";

/** `first-auto.auto.json` -> `first-auto`, which is what every GitHub-side helper is keyed on. */
export const autoNameOf = (fileName: string): string => fileName.replace(/\.auto\.json$/, "");

export interface GitHubBackendOptions {
  client: GitHubClient;
  project: GitHubProject;
  /** The signed-in account, which the default work-branch name is built from. */
  login: string;
  /** Called whenever the branch a Save would commit to changes, so the store can follow it. */
  onBranch?: (branch: string) => void;
}

export class GitHubBackend implements ProjectBackend {
  readonly kind = "github";
  readonly canPropose = true;

  private readonly client: GitHubClient;
  private readonly project: GitHubProject;
  private readonly login: string;
  private readonly onBranch: ((branch: string) => void) | undefined;
  private link: Link | null = null;
  private autos: string[] = [];
  /** The branch a Save commits to. It is the base branch until an auto is opened. */
  private branch: string;
  /** A branch name the user typed, which wins over the `auto/<name>/<login>` default. */
  private custom: string | null = null;

  constructor(options: GitHubBackendOptions) {
    this.client = options.client;
    this.project = options.project;
    this.login = options.login;
    this.onBranch = options.onBranch;
    this.branch = options.project.base;
  }

  get owner(): string {
    return this.project.owner;
  }

  get repo(): string {
    return this.project.repo;
  }

  get base(): string {
    return this.project.base;
  }

  /** The bound `GitHubProject`, for `propose` and `loadReview`, which take it directly. */
  get githubProject(): GitHubProject {
    return this.project;
  }

  /** The branch a Save would commit to right now. */
  get workBranch(): string {
    return this.branch;
  }

  /** The name a work branch would take for `autoName`, before anything is created. */
  branchFor(autoName: string): string {
    return this.project.workBranchName(autoName, this.login, this.custom ?? undefined);
  }

  /** Lets the user name the branch themselves; an empty string goes back to the default. */
  setBranch(name: string, autoName?: string): void {
    const trimmed = name.trim();
    this.custom = trimmed.length === 0 ? null : trimmed;
    this.branch =
      this.custom ?? (autoName === undefined ? this.base : this.project.workBranchName(autoName, this.login));
    this.onBranch?.(this.branch);
  }

  async open(): Promise<Project> {
    const opened = await this.project.open();
    this.link = opened.link;
    this.autos = opened.autos.map((auto) => `${auto.name}.auto.json`).sort((a, b) => a.localeCompare(b));
    return {
      source: {
        kind: "github",
        owner: this.owner,
        repo: this.repo,
        base: this.base,
        branch: this.branch,
        login: this.login,
      },
      name: `${this.owner}/${this.repo}`,
      link: opened.link,
      robot: loadRobot(JSON.parse(opened.robotText)),
      field: loadField(JSON.parse(opened.fieldText)),
      waypoints:
        opened.waypointsText === null ? undefined : loadWaypoints(JSON.parse(opened.waypointsText)),
      autoFiles: this.autos,
      autoTexts: {},
    };
  }

  async listAutos(): Promise<string[]> {
    return this.autos;
  }

  async readAuto(fileName: string): Promise<LoadedAuto> {
    const name = autoNameOf(fileName);
    const path = autoPath(this.requireLink(), name);
    const text = await this.readFromWorkBranchOrBase(path);
    const auto: Auto = loadAuto(JSON.parse(text));
    // Opening an auto is what names its work branch (06 section 1), unless the user named one.
    this.branch = this.branchFor(name);
    this.onBranch?.(this.branch);
    return { fileName, auto, canonical: canonicalize("auto", auto) };
  }

  async save(fileName: string, text: string, summary?: string): Promise<SaveResult> {
    const name = autoNameOf(fileName);
    // The guard first, before any request: creating or reading a branch is not worth doing when
    // the write that follows would be refused anyway (06 section 7).
    if (this.branchFor(name) === this.base) throw new BaseBranchWriteError(this.base);
    const branch = await this.project.workBranch(name, this.login, this.custom ?? undefined);
    this.branch = branch;
    this.onBranch?.(branch);
    const result = await this.project.save(
      branch,
      name,
      autoPath(this.requireLink(), name),
      text,
      summary,
    );
    return {
      text,
      commitSha: result.commitSha,
      note: `Committed ${result.commitSha.slice(0, 7)} to ${branch}.`,
    };
  }

  async readText(path: string): Promise<string> {
    return this.readFromWorkBranchOrBase(path);
  }

  /** The work branch's copy when there is one, the base branch's otherwise. */
  private async readFromWorkBranchOrBase(path: string): Promise<string> {
    if (this.branch !== this.base) {
      try {
        return (await this.client.contents.get(this.owner, this.repo, path, this.branch)).text;
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
      }
    }
    return (await this.client.contents.get(this.owner, this.repo, path, this.base)).text;
  }

  private requireLink(): Link {
    if (this.link === null) throw new Error("This repository has not been opened yet.");
    return this.link;
  }
}
