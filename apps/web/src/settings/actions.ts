/**
 * What the Settings window does to the open project's files: write the command library into its
 * `zenith.json` (`codeSettings.ts` says why it is the project's and not the person's), and write its
 * `robot.json` from the Robot and Commands sections (`robotSettings.ts`, issue #100).
 */
import { loadLink, loadRobot } from "@horizon36596/zenith-core";
import type { Robot } from "@horizon36596/zenith-schema";
import { ensureWritable } from "../project/local";
import { getState, replaceProjectLink, replaceProjectRobot } from "../state/store";
import { LIBRARY_LABEL, codeSettingsOf, type CommandLibrary } from "./codeSettings";
import { robotProblem, robotReadOnlyReason } from "./robotSettings";

export interface WriteOutcome {
  ok: boolean;
  /** One sentence for the row: what was saved, or what went wrong. */
  message: string;
}

/** Writes `library` into the open project's `zenith.json` and updates the open project to match. */
export async function setProjectCommandLibrary(library: CommandLibrary): Promise<WriteOutcome> {
  const { project, backend } = getState();
  if (project === null || backend === null) return { ok: false, message: "Open a project first." };
  const set = backend.setCommandLibrary?.bind(backend);
  const why = codeSettingsOf(project, set !== undefined).whyCannotChange;
  if (why !== null || set === undefined) return { ok: false, message: why ?? "This project cannot write zenith.json." };
  try {
    // The backend changes the one key in the file on disk; the open project takes what it wrote.
    replaceProjectLink(loadLink(JSON.parse(await set(library))));
  } catch (error) {
    return { ok: false, message: `zenith.json was not changed: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { ok: true, message: `Saved. zenith.json now names ${LIBRARY_LABEL[library]}.` };
}

/**
 * Writes `robot` as the open project's `robot.json` and puts it in the editor, so the checks, the
 * insert menu and the field use it at once. Nothing is written when the project is read only or the
 * robot would not load.
 */
export async function saveProjectRobot(robot: Robot, what = "robot.json"): Promise<WriteOutcome> {
  const { project, backend, host } = getState();
  if (project === null || backend === null) return { ok: false, message: "Open a project first." };
  const write = backend.writeRobot?.bind(backend);
  const why = robotReadOnlyReason(project, host, write !== undefined);
  if (why !== null || write === undefined) return { ok: false, message: why ?? "This project cannot write robot.json." };
  const problem = robotProblem(robot);
  if (problem !== null) return { ok: false, message: `robot.json was not changed: ${problem}` };
  try {
    if (project.source.kind === "directory" && !(await ensureWritable(project.source.handle))) {
      return { ok: false, message: "The browser did not allow writing to this folder, so robot.json was not changed." };
    }
    replaceProjectRobot(loadRobot(JSON.parse(await write(robot))));
  } catch (error) {
    return { ok: false, message: `robot.json was not changed: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { ok: true, message: `Saved ${what} to ${project.link.robot}.` };
}
