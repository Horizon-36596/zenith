/**
 * The open project's list of autos, kept in step with the folder it lives in (issue #157). The list
 * is read when the project opens; after that, an auto that Save writes into a folder for the first
 * time is put on it here, and New auto and an import list the folder again before they choose a
 * name, so a file written since the project opened is never reused as a new auto's name. The
 * Ctrl+O list, the palette's Open list and the waypoint rename and delete followers all read it.
 */
import type { Project } from "../project/types";
import { getState, touchProject } from "../state/store";

const byName = (a: string, b: string): number => a.localeCompare(b);

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((name, index) => name === b[index]);

/** True for the sources whose Save writes the file in place: a folder, or one the desktop app opened. */
export const savesInPlace = (project: Project): boolean =>
  project.source.kind === "directory" || project.source.kind === "desktop";

/**
 * Asks the backend for the project's autos again and publishes the list when it changed. Resolves
 * with the project as it stands afterwards. A listing that fails leaves the list as it was: the
 * first save of a new auto still checks the folder before it writes (`projectActions.save`).
 */
export async function refreshAutoList(): Promise<Project | null> {
  const { backend, project } = getState();
  if (backend === null || project === null) return project;
  // A copy, because the desktop backend writes the new list into its own project object.
  const before = [...project.autoFiles];
  let listed: string[];
  try {
    listed = await backend.listAutos();
  } catch {
    return getState().project;
  }
  const now = getState().project;
  // Another project opened while the folder was listed: its own list stands.
  if (now === null || getState().backend !== backend) return now;
  if (sameList(before, listed) && sameList(now.autoFiles, listed)) return now;
  touchProject({ ...now, autoFiles: [...listed] });
  return getState().project;
}

/**
 * Puts an auto that is now a file in the project's folder on the list, in sorted order, when it is
 * not on it yet. Only a folder or the desktop app writes files in place; every other source keeps
 * its own list.
 */
export function listAuto(fileName: string): void {
  const project = getState().project;
  if (project === null || !savesInPlace(project) || project.autoFiles.includes(fileName)) return;
  touchProject({ ...project, autoFiles: [...project.autoFiles, fileName].sort(byName) });
}
