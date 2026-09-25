/**
 * One interface over the places a project can live, so the editor shell never asks where it came
 * from. Local mode (a folder, a set of picked files, the bundled example) is here; GitHub mode is
 * `apps/web/src/github/backend.ts` over `packages/github`'s `GitHubProject`
 * (site/docs/github.md).
 *
 * The shell holds exactly one backend at a time and calls it for every read and every write. A
 * backend owns its own `Project`, so opening one twice is the caller's business, not the shell's.
 */
import { canonicalize, loadAuto } from "@horizon36596/zenith-core";
import type { Auto } from "@horizon36596/zenith-schema";
import { downloadText } from "./fallback";
import { ProjectError, autoPath, readTextAt, writeTextAt } from "./local";
import type { LoadedAuto, Project } from "./types";

export interface SaveResult {
  /** The canonical text as written, which becomes what "unsaved changes" compares against. */
  text: string;
  /** GitHub mode: the commit this save created. */
  commitSha?: string;
  /** One line for the status strip when the save did something other than write in place. */
  note?: string;
}

export interface ProjectBackend {
  readonly kind: "local" | "github";
  /** Reads `zenith.json` and everything it names, and lists the autos beside them. */
  open(): Promise<Project>;
  /** Auto file names inside `link.autosDir`, sorted. */
  listAutos(): Promise<string[]>;
  /** One auto, parsed, with the canonical text it was loaded as. */
  readAuto(name: string): Promise<LoadedAuto>;
  /** Writes already-canonical text for `name`. `summary` is the commit message in GitHub mode. */
  save(name: string, text: string, summary?: string): Promise<SaveResult>;
  /** Any other file in the repository, by its path from the root. */
  readText(path: string): Promise<string>;
  /** Whether this backend can open a pull request; only GitHub mode can (06 section 3). */
  readonly canPropose: boolean;
}

/**
 * Local mode, wrapping what `local.ts`, `example.ts` and `fallback.ts` already did: a folder writes
 * in place, and a read-only source (the example, picked files) downloads the canonical file
 * instead. Nothing about that behaviour changes by going through this interface.
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

  async listAutos(): Promise<string[]> {
    return this.opened().autoFiles;
  }

  async readAuto(name: string): Promise<LoadedAuto> {
    const project = this.opened();
    const text =
      project.source.kind === "directory"
        ? await readTextAt(project.source.handle, autoPath(project, name))
        : project.autoTexts[name];
    if (text === undefined) throw new ProjectError(`${name} is not loaded in this project.`);
    const auto: Auto = loadAuto(JSON.parse(text));
    return { fileName: name, auto, canonical: canonicalize("auto", auto) };
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
