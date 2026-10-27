/**
 * GitHub mode's `ProjectBackend`: the same five methods the local one has, over
 * `packages/github`'s `GitHubProject` (site/docs/github.md).
 *
 * Reads come from the work branch when it exists and from the base branch otherwise, so opening an
 * auto that has already been edited on a branch shows the edited version. Writes only ever go to
 * the work branch: `GitHubProject.save` throws `BaseBranchWriteError` before any request if they
 * would not, and the editor disables Save as well so the refusal is never the first sign of it.
 *
 * Every file read for the editor remembers the blob sha it was read at, per work branch, and a Save
 * to that branch passes it on, so a commit made since (from another tab, another computer, or a
 * merge from base) is refused rather than written over (issue #407).
 */
import { canonicalize, loadAuto, loadField, loadRobot, loadWaypoints } from "@horizon36596/zenith-core";
import {
  BaseBranchWriteError,
  assertPathAllowed,
  NotFoundError,
  autoPath,
  type ContentEntry,
  type GitHubClient,
  type GitHubProject,
  type ProposeInput,
} from "@horizon36596/zenith-github";
import type { Auto, Link, Waypoints } from "@horizon36596/zenith-schema";
import type { ProjectBackend, SaveResult } from "../project/backend";
import { loadProjectFile, loadProjectJson, parseProjectJson } from "../project/fileErrors";
import { isPresetFileName, projectPresetsDir } from "../project/presetPaths";
import { olderFormatOf } from "../project/formatVersion";
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
  /** The blob sha each file was opened or last committed at, keyed by work branch, then path. */
  private readonly shas = new Map<string, Map<string, string>>();

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

  /**
   * Lets the user name the branch themselves; an empty string goes back to the default. So does the
   * open auto's own default name: leaving the field as it was must not pin `auto/<auto>/<login>` as
   * a custom name, which every other auto opened afterwards would then share (issue #407).
   */
  setBranch(name: string, autoName?: string): void {
    const trimmed = name.trim();
    const isDefault = autoName !== undefined && trimmed === this.project.workBranchName(autoName, this.login);
    this.custom = trimmed.length === 0 || isDefault ? null : trimmed;
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
      robot: loadProjectFile("robot", opened.link.robot, opened.robotText, loadRobot),
      field: loadProjectFile("field", opened.link.field, opened.fieldText, loadField),
      waypoints:
        opened.waypointsText === null || opened.link.waypoints === undefined
          ? undefined
          : loadProjectFile("waypoints", opened.link.waypoints, opened.waypointsText, loadWaypoints),
      autoFiles: this.autos,
      autoTexts: {},
    };
  }

  async listAutos(): Promise<string[]> {
    return this.autos;
  }

  async readAuto(fileName: string): Promise<LoadedAuto> {
    const name = autoNameOf(fileName);
    const link = this.requireLink();
    const path = autoPath(link, name);
    // Opening an auto is what names its work branch (06 section 1), unless the user named one. The
    // auto is read from that branch, not from whichever branch the last auto left behind, so what
    // opens is what a Save would write over (issue #407).
    const branch = this.branchFor(name);
    const text = await this.readTracked(path, branch);
    const json = parseProjectJson(path, text);
    const auto: Auto = loadProjectJson("auto", path, json, loadAuto);
    // Save commits a waypoint change to the same work branch as the auto (issue #134), so the
    // waypoints the auto is drawn against come from there too when the branch has its own copy.
    const waypoints =
      link.waypoints === undefined
        ? undefined
        : loadProjectFile("waypoints", link.waypoints, await this.readTracked(link.waypoints, branch), loadWaypoints);
    this.branch = branch;
    this.onBranch?.(this.branch);
    return {
      fileName,
      auto,
      canonical: canonicalize("auto", auto),
      ...olderFormatOf(json),
      ...(waypoints === undefined ? {} : { waypoints }),
    };
  }

  async save(fileName: string, text: string, summary?: string): Promise<SaveResult> {
    const name = autoNameOf(fileName);
    // The guard first, before any request: creating or reading a branch is not worth doing when
    // the write that follows would be refused anyway (06 section 7).
    if (this.branchFor(name) === this.base) throw new BaseBranchWriteError(this.base);
    const branch = await this.project.workBranch(name, this.login, this.custom ?? undefined);
    this.branch = branch;
    this.onBranch?.(branch);
    const path = autoPath(this.requireLink(), name);
    const result = await this.project.save(branch, name, path, text, summary, this.expected(branch, path));
    this.remember(branch, path, result.sha);
    return {
      text,
      commitSha: result.commitSha,
      note: `Committed ${result.commitSha.slice(0, 7)} to ${branch}.`,
    };
  }

  /**
   * Commits the project's waypoints file to the open auto's work branch, as `save` commits the auto,
   * with the same message (issue #134). The path allowlist applies as for any write, so a waypoints
   * file outside the autos, deploy and codegen folders is refused before any request; the editor
   * turns waypoint editing off for such a project first (`app/waypointEdits.ts`).
   */
  async writeWaypoints(waypoints: Waypoints, fileName: string, summary?: string): Promise<string> {
    const link = this.requireLink();
    if (link.waypoints === undefined) throw new Error("This project's zenith.json names no waypoints file.");
    const name = autoNameOf(fileName);
    // Both refusals come before any request, as for an auto.
    assertPathAllowed(link, link.waypoints);
    if (this.branchFor(name) === this.base) throw new BaseBranchWriteError(this.base);
    const text = canonicalize("waypoints", loadWaypoints(JSON.parse(JSON.stringify(waypoints))));
    const branch = await this.project.workBranch(name, this.login, this.custom ?? undefined);
    this.branch = branch;
    this.onBranch?.(branch);
    const result = await this.project.save(branch, name, link.waypoints, text, summary, this.expected(branch, link.waypoints));
    this.remember(branch, link.waypoints, result.sha);
    return text;
  }

  /** The blob shas the open files were read at on `branch`, for `propose`'s `expectedShas`. */
  expectedShas(branch: string): NonNullable<ProposeInput["expectedShas"]> {
    return Object.fromEntries(this.shas.get(branch) ?? []);
  }

  /** Records what `propose` committed, so the next Save checks against it. */
  rememberShas(branch: string, shas: Record<string, string>): void {
    for (const [path, sha] of Object.entries(shas)) this.remember(branch, path, sha);
  }

  async readText(path: string): Promise<string> {
    return this.readFromWorkBranchOrBase(path);
  }

  /**
   * One directory's entries, from the work branch when it exists and the base branch otherwise,
   * like `readText`. Import commands from Java walks the repository's sources with it.
   */
  async listDirectory(path: string): Promise<ContentEntry[]> {
    if (this.branch !== this.base) {
      try {
        return await this.client.contents.list(this.owner, this.repo, path, this.branch);
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
      }
    }
    return this.client.contents.list(this.owner, this.repo, path, this.base);
  }

  /**
   * The project's preset files (spec 15 section 6.5), from the work branch or the base as
   * `listDirectory` reads; none when the folder is missing. GitHub mode reads them and never writes
   * one: it commits only autos and waypoints.
   */
  async listPresetFiles(): Promise<string[]> {
    let entries: ContentEntry[];
    try {
      entries = await this.listDirectory(projectPresetsDir(this.requireLink()));
    } catch (error) {
      if (error instanceof NotFoundError) return [];
      throw error;
    }
    return entries
      .filter((entry) => entry.type === "file" && isPresetFileName(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  }

  /** The work branch's copy when there is one, the base branch's otherwise. */
  private async readFromWorkBranchOrBase(path: string): Promise<string> {
    return (await this.getFromWorkBranchOrBase(path, this.branch)).text;
  }

  /**
   * As `readFromWorkBranchOrBase`, remembering the sha it read for a Save to `branch` to check. A
   * copy read from the base is what a new work branch starts with, so its sha is the right one to
   * expect there too.
   */
  private async readTracked(path: string, branch: string): Promise<string> {
    const file = await this.getFromWorkBranchOrBase(path, branch);
    this.remember(branch, path, file.sha);
    return file.text;
  }

  private async getFromWorkBranchOrBase(path: string, branch: string): Promise<{ text: string; sha: string }> {
    if (branch !== this.base) {
      try {
        return await this.client.contents.get(this.owner, this.repo, path, branch);
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
      }
    }
    return this.client.contents.get(this.owner, this.repo, path, this.base);
  }

  private remember(branch: string, path: string, sha: string): void {
    const known = this.shas.get(branch) ?? new Map<string, string>();
    known.set(path, sha);
    this.shas.set(branch, known);
  }

  private expected(branch: string, path: string): { expectedSha?: string } {
    const sha = this.shas.get(branch)?.get(path);
    return sha === undefined ? {} : { expectedSha: sha };
  }

  private requireLink(): Link {
    if (this.link === null) throw new Error("This repository has not been opened yet.");
    return this.link;
  }
}
