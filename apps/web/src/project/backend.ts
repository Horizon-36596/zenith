/**
 * One interface over the places a project can live, so the editor shell never asks where it came
 * from. Local mode (a folder, a set of picked files, the bundled example) is here; GitHub mode is
 * `apps/web/src/github/backend.ts` over `packages/github`'s `GitHubProject`
 * (site/docs/github.md); host mode, where another web app hands the project over and takes the
 * saved autos back, is `hostBackend.ts` (site/docs/host-protocol.md).
 *
 * The shell holds exactly one backend at a time and calls it for every read and every write. A
 * backend owns its own `Project`, so opening one twice is the caller's business, not the shell's.
 */
import { canonicalize, loadAuto, loadRobot, loadWaypoints } from "@horizon36596/zenith-core";
import type { Auto, Robot, Waypoints } from "@horizon36596/zenith-schema";
import { linkTextWithCommandLibrary, type CommandLibrary } from "./commandLibrary";
import { downloadText } from "./fallback";
import { loadProjectJson, parseProjectJson } from "./fileErrors";
import { olderFormatOf } from "./formatVersion";
import { ProjectError, autoPath, hasFileAt, listAutoFiles, listFilesIn, readTextAt, writeTextAt } from "./local";
import { isPresetFileName, projectPresetPath, projectPresetsDir } from "./presetPaths";
import type { LoadedAuto, Project } from "./types";

export interface SaveResult {
  /** The canonical text as written, which becomes what "unsaved changes" compares against. */
  text: string;
  /** GitHub mode: the commit this save created. */
  commitSha?: string;
  /** One line for the status strip when the save did something other than write in place. */
  note?: string;
  /** The status line for a save that went through, when "Saved." would not say where it went. */
  savedMessage?: string;
}

export interface ProjectBackend {
  /** `host` is a project another web app handed over in host mode (`hostBackend.ts`). */
  readonly kind: "local" | "github" | "host";
  /** Reads `zenith.json` and everything it names, and lists the autos beside them. */
  open(): Promise<Project>;
  /** Auto file names inside `link.autosDir`, sorted. */
  listAutos(): Promise<string[]>;
  /** One auto, parsed, with the canonical text it was loaded as. */
  readAuto(name: string): Promise<LoadedAuto>;
  /**
   * Whether an auto file of this name is where the project lives now (issue #157). Save asks before
   * the first write of an auto that has never been saved, so a file that appeared after the auto was
   * started is never written over. Absent where a backend cannot tell.
   */
  hasAuto?(name: string): Promise<boolean>;
  /** Writes already-canonical text for `name`. `summary` is the commit message in GitHub mode. */
  save(name: string, text: string, summary?: string): Promise<SaveResult>;
  /** Any other file in the repository, by its path from the root. */
  readText(path: string): Promise<string>;
  /**
   * Sets `deploy.commandLibrary` in the project's `zenith.json` as it is on disk, changing no other
   * key, and resolves with the text written. Absent where a backend can never write it; Settings
   * checks the project's source for the reason first (`settings/codeSettings.ts`).
   */
  setCommandLibrary?(library: CommandLibrary): Promise<string>;
  /**
   * Writes the project's robot file (`link.robot`) from `robot`, in canonical form, and resolves with
   * the text written: the Settings window's Robot and Commands sections. Absent where a backend can
   * never write it; Settings checks the project's source for the reason first (`settings/robotSettings.ts`).
   */
  writeRobot?(robot: Robot): Promise<string>;
  /**
   * Writes the project's waypoints file (`link.waypoints`) from `waypoints`, in canonical form, and
   * resolves with the text written (issue #134). Save calls it before the auto, when the waypoints
   * have unsaved changes; `fileName` and `summary` are the auto's, which GitHub mode commits to the
   * same work branch with the same message. Absent where a backend can never write it; the editor
   * turns waypoint editing off there and says why (`app/waypointEdits.ts`).
   */
  writeWaypoints?(waypoints: Waypoints, fileName: string, summary?: string): Promise<string>;
  /**
   * The preset files in the project's presets folder (`<autosDir>/presets/`, spec 15 section 6.5), as
   * bare names, sorted; none when the folder is missing. Each is read with `readText`. Absent where a
   * backend cannot list a folder.
   */
  listPresetFiles?(): Promise<string[]>;
  /**
   * Writes one preset file into the presets folder, making the folder when it is missing: Add to
   * project. `fileName` is a bare `*.zenith-preset.json` name. Absent where a backend can never write
   * one; Settings checks the project's source for the reason first (`settings/projectPresets.ts`).
   */
  writePresetFile?(fileName: string, text: string): Promise<void>;
  /** Whether this backend can open a pull request; only GitHub mode can (06 section 3). */
  readonly canPropose: boolean;
}

/**
 * Local mode, wrapping what `local.ts`, `example.ts` and `fallback.ts` already did: a folder writes
 * in place, and a read-only source (the example, picked files) downloads the canonical file
 * instead. The shell's Save asks first for a read-only source (`app/saveReadOnly.ts`), so this
 * download is what a direct call gets.
 */
export class LocalBackend implements ProjectBackend {
  readonly kind = "local";
  readonly canPropose = false;
  private project: Project | null = null;

  constructor(private readonly load: () => Promise<Project>) {}

  /** A backend for a project that is already in hand, such as the bundled example. */
  static of(project: Project): LocalBackend {
    return new LocalBackend(() => Promise.resolve(project));
  }

  async open(): Promise<Project> {
    const project = await this.load();
    this.project = project;
    return project;
  }

  /**
   * A folder is listed again each time, so a file written since the project opened (by Save, or by
   * anything else) is on the list (issue #157). Other sources have only the autos they came with.
   */
  async listAutos(): Promise<string[]> {
    const project = this.opened();
    if (project.source.kind !== "directory") return project.autoFiles;
    return listAutoFiles(project.source.handle, project.link.autosDir);
  }

  /**
   * In a folder, whether the file is there now; elsewhere, whether the project came with it. A
   * folder that cannot be looked in throws rather than answering "not there" (issue #380).
   */
  async hasAuto(name: string): Promise<boolean> {
    const project = this.opened();
    if (project.source.kind !== "directory") return project.autoFiles.includes(name);
    return hasFileAt(project.source.handle, autoPath(project, name));
  }

  async readAuto(name: string): Promise<LoadedAuto> {
    const project = this.opened();
    const text =
      project.source.kind === "directory"
        ? await readTextAt(project.source.handle, autoPath(project, name))
        : project.autoTexts[name];
    if (text === undefined) throw new ProjectError(`${name} is not loaded in this project.`);
    const path = project.source.kind === "directory" ? autoPath(project, name) : name;
    const json = parseProjectJson(path, text);
    const auto: Auto = loadProjectJson("auto", path, json, loadAuto);
    return { fileName: name, auto, canonical: canonicalize("auto", auto), ...olderFormatOf(json) };
  }

  async save(name: string, text: string): Promise<SaveResult> {
    const project = this.opened();
    if (project.source.kind !== "directory") {
      downloadText(name, text);
      return { text, note: "This project is read only, so the canonical file was downloaded." };
    }
    await writeTextAt(project.source.handle, autoPath(project, name), text);
    return { text };
  }

  /**
   * A read-only source (the example, picked files) keeps `text` as its copy of auto `name` once Save
   * wrote the auto somewhere else (issue #158), so opening it again shows what was saved. A folder
   * reads its autos from disk and has no copy to keep.
   */
  keepSavedText(name: string, text: string): void {
    const project = this.opened();
    if (project.source.kind === "directory") return;
    this.project = { ...project, autoTexts: { ...project.autoTexts, [name]: text } };
  }

  async setCommandLibrary(library: CommandLibrary): Promise<string> {
    const project = this.opened();
    if (project.source.kind !== "directory") {
      throw new ProjectError("This project is read only, so zenith.json cannot be changed here.");
    }
    // From the file as it is now, not the copy opened earlier, so an edit made since is kept.
    const text = linkTextWithCommandLibrary(await readTextAt(project.source.handle, "zenith.json"), library);
    await writeTextAt(project.source.handle, "zenith.json", text);
    return text;
  }

  async writeRobot(robot: Robot): Promise<string> {
    const project = this.opened();
    if (project.source.kind !== "directory") {
      throw new ProjectError("This project is read only, so robot.json cannot be changed here.");
    }
    // Loaded again first, so only a robot the schema accepts is ever written.
    const text = canonicalize("robot", loadRobot(JSON.parse(JSON.stringify(robot))));
    await writeTextAt(project.source.handle, project.link.robot, text);
    return text;
  }

  async writeWaypoints(waypoints: Waypoints): Promise<string> {
    const project = this.opened();
    if (project.source.kind !== "directory") {
      throw new ProjectError("This project is read only, so waypoints.json is saved only with the full project.");
    }
    if (project.link.waypoints === undefined) {
      throw new ProjectError("This project's zenith.json names no waypoints file, so there is nowhere to save waypoints.");
    }
    // Loaded again first, so only waypoints the schema accepts are ever written.
    const text = canonicalize("waypoints", loadWaypoints(JSON.parse(JSON.stringify(waypoints))));
    await writeTextAt(project.source.handle, project.link.waypoints, text);
    return text;
  }

  /** A folder's presets as it has them now; the example and picked files have none. */
  async listPresetFiles(): Promise<string[]> {
    const project = this.opened();
    if (project.source.kind !== "directory") return [];
    return (await listFilesIn(project.source.handle, projectPresetsDir(project.link))).filter(isPresetFileName);
  }

  async writePresetFile(fileName: string, text: string): Promise<void> {
    const project = this.opened();
    if (project.source.kind !== "directory") {
      throw new ProjectError("This project is read only, so a preset cannot be added to it.");
    }
    if (!isPresetFileName(fileName)) {
      throw new ProjectError(`${fileName} is not a preset file name.`);
    }
    await writeTextAt(project.source.handle, projectPresetPath(project.link, fileName), text, { createDirs: true });
  }

  async readText(path: string): Promise<string> {
    const project = this.opened();
    if (project.source.kind !== "directory") {
      throw new ProjectError(`This project cannot read ${path}; it only has the files you picked.`);
    }
    return readTextAt(project.source.handle, path);
  }

  private opened(): Project {
    if (this.project === null) throw new ProjectError("This project has not been opened yet.");
    return this.project;
  }
}
