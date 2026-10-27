/**
 * "New auto" in the standalone editor and the desktop app: a blank auto in the open project,
 * opened unsaved, which Save then writes into the project's autos directory like any other auto.
 * It is the same skeleton host mode's New auto starts from (`project/hostBackend.ts` `newHostAuto`,
 * itself core's `newAutoFromTemplate`, which `zenith new` builds too), so every route to a new auto
 * starts in the same place. Host mode keeps its own action, which also puts the auto on the host's
 * list (`project/hostSession.ts` `createHostAuto`).
 */
import type { Auto } from "@horizon36596/zenith-schema";
import { refreshAutoList } from "./autoList";
import { newPathHeading } from "./newPathHeading";
import { confirmReplace } from "./unsaved";
import { newHostAuto } from "../project/hostBackend";
import { isWritable, type Project } from "../project/types";
import { getState, openAuto, setStatus, type State } from "../state/store";

/** Why New auto cannot run now, or null when it can. */
export function newAutoBlockedReason(state: Pick<State, "project" | "review">): string | null {
  if (state.project === null) return "Open a project first: a new auto is made for its robot and field.";
  if (state.review !== null) return "Review mode is read only.";
  return null;
}

/**
 * The blank auto and its file name. The name is one no auto in the project has, and not the one open
 * now either, so a second New auto before the first is saved does not reuse its name.
 */
export function blankAuto(project: Project, openFileName: string | null): { fileName: string; auto: Auto } {
  const taken = openFileName === null ? project.autoFiles : [...project.autoFiles, openFileName];
  return newHostAuto({ ...project, autoFiles: taken }, newPathHeading);
}

/** What Save will do with the new auto, for the status line. */
export function newAutoSavedLine(project: Project): string {
  return isWritable(project.source)
    ? "Save writes it into the project."
    : "This project is read only, so Save asks where to put it.";
}

/**
 * Starts a blank auto in the open project, asking first when the open auto has unsaved edits. The
 * project's autos are listed again first, so the name skips a file written since it opened
 * (issue #157). The question's Save on the read-only example can open the folder it wrote
 * (issue #158), so the project and the name are worked out again once it has been answered.
 */
export async function createAuto(): Promise<void> {
  const state = getState();
  const blocked = newAutoBlockedReason(state);
  if (blocked !== null || state.project === null) {
    setStatus("error", blocked ?? "Open a project first.");
    return;
  }
  const listed = await refreshAutoList();
  if (listed === null) {
    setStatus("error", "Open a project first.");
    return;
  }
  const asked = blankAuto(listed, getState().fileName).fileName;
  if (!(await confirmReplace(`Starting ${asked} will replace it.`, { sameProject: true }))) {
    setStatus("info", `Kept the unsaved edits in ${getState().fileName ?? "this auto"}.`);
    return;
  }
  const { project, fileName: open } = getState();
  if (project === null) {
    setStatus("error", "Open a project first.");
    return;
  }
  const { fileName, auto } = blankAuto(project, open);
  // An empty saved text makes the new auto count as unsaved until the person saves it.
  openAuto(fileName, auto, "");
  setStatus("info", `Started ${fileName}. ${newAutoSavedLine(project)}`);
}
