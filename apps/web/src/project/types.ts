/**
 * A project is one robot repository as the editor sees it: the link file, the robot, the field, the
 * waypoints and the list of autos beside them (site/docs/github.md).
 * Local mode and GitHub mode are two sources of the same shape; `backend.ts` is the interface the
 * shell reads and writes them through.
 */
import type { Auto, Field, Link, Robot, Waypoints } from "@horizon36596/zenith-schema";

export type ProjectSource =
  /** The bundled `examples/starter`, so the app demos with no folder at all. Read only. */
  | { kind: "example" }
  /** A folder the user picked with the File System Access API. Save writes in place. */
  | { kind: "directory"; handle: FileSystemDirectoryHandle }
  /** A folder opened in the desktop app (`desktop.ts`). Save writes in place through its bridge. */
  | { kind: "desktop"; root: string }
  /** Files picked one at a time on a browser without the API. Save downloads. */
  | { kind: "files" }
  /** A repository read over the Contents API. Save commits to `branch`, never to `base`. */
  | {
      kind: "github";
      owner: string;
      repo: string;
      base: string;
      branch: string;
      /** The signed-in account, which is what the work-branch name is built from. */
      login: string;
    };

export interface Project {
  source: ProjectSource;
  /** What the toolbar shows: the folder's name, or `examples/starter`. */
  name: string;
  link: Link;
  robot: Robot;
  field: Field;
  waypoints?: Waypoints;
  /** File names inside `link.autosDir`, sorted, e.g. `first-auto.auto.json`. */
  autoFiles: string[];
  /** The text of each auto, for sources that cannot re-read a file on demand. */
  autoTexts: Record<string, string>;
}

export interface LoadedAuto {
  fileName: string;
  auto: Auto;
  /** Canonical text as loaded, which is what "unsaved changes" compares against. */
  canonical: string;
}

export const isWritable = (source: ProjectSource): boolean =>
  source.kind === "directory" ||
  source.kind === "desktop" ||
  (source.kind === "github" && source.branch !== source.base);

/** True when this browser can open a folder and write back into it. */
export const supportsDirectoryPicker = (): boolean =>
  typeof window !== "undefined" && "showDirectoryPicker" in window;
