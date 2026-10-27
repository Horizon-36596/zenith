/**
 * Set up Zenith in a robot repository that has no `zenith.json` yet (issue #159). Open folder on
 * such a folder used to stop at "Could not read zenith.json in this folder."; now it asks:
 *
 * 1. It reads the Java and Kotlin under TeamCode and plans what to prefill (`setupPlan.ts`): the
 *    command library only from an import that names one, the robot class from the class that
 *    implements `ZenithRobot`, and `robot.json`'s commands and conditions from the registrations.
 * 2. Set up writes `zenith.json`, `robot.json`, `waypoints.json`, the season's field and one
 *    skeleton auto (`project/setupFiles.ts`), never over a file already there. `zenith.json` has no
 *    `sim` section, and a `codegen` section only when a robot class was given.
 * 3. The folder opens as the current, writable project, and the dialog shows the Gradle lines.
 *
 * In a browser the folder is the File System Access handle Open folder picked. In the desktop app
 * the main process reads the code and writes the files (`apps/desktop/src/main/setupProject.ts`),
 * building `zenith.json` itself from the library and the robot class.
 *
 * Loaded on demand, like the rest of the read-only save path, so the season's field stays out of
 * the first bundle.
 */
import { loadField, type CommandLibrary } from "@horizon36596/zenith-core";
import type { SourceFile } from "@horizon36596/zenith-import";
import type { Robot } from "@horizon36596/zenith-schema";
import fieldText from "../../../../packages/season-biobuzz/field/biobuzz.field.json?raw";
import type { DesktopProjectRef, ZenithDesktopBridge } from "../project/desktopBridge";
import { openRecentDesktopFolder } from "../project/desktopActions";
import { ProjectError, directoryAt, writeTextAt } from "../project/local";
import {
  findExistingProject,
  inPlaceFileSet,
  inPlacePaths,
  robotClassProblem,
  searchesInto,
  SETUP_AUTO,
  SETUP_PATHS,
  SETUP_SEARCH_DEPTH,
  setupFileSet,
  setupTakenLine,
  type ExistingProject,
} from "../project/setupFiles";
import { appVersion } from "../report/setup";
import { clearStatus, getState, setBusy, setStatus } from "../state/store";
import { adoptBackend, adoptDirectory, reportOpenError, say } from "./projectActions";
import { gradleLines, planSetup, SETUP_SCAN_DIR } from "./setupPlan";
import { getSetupView, hideSetup, setSetupProblem, showSetup, showSetupDone } from "./setupView";
import { sourcesFromDirectory } from "./commandImport";

/** A folder Set up reads and writes: a browser's picked folder, or one the desktop app's picker granted. */
interface SetupTarget {
  name: string;
  /**
   * TeamCode's Java and Kotlin, the autos already in the folder (issue #496), and which of the files
   * Set up would write are already there. Writes nothing.
   */
  scan(): Promise<{ teamCode: boolean; sources: SourceFile[]; taken: string[]; existing: ExistingProject | null }>;
  /**
   * Writes the five files, or with `existing` only `zenith.json` and what the folder lacks, never over
   * one already there; a refusal writes nothing. Resolves with what it wrote.
   */
  write(choices: {
    commandLibrary: CommandLibrary | null;
    robotClass: string | null;
    robot: Robot;
    existing: ExistingProject | null;
  }): Promise<string[]>;
  /** Opens the folder as the current project, on the skeleton auto if Set up wrote one. True when it opened cleanly. */
  open(existing: ExistingProject | null): Promise<boolean>;
}

/** The folder the question is about, while it shows. */
let current: SetupTarget | null = null;

/* ---- A browser's folder ----------------------------------------------------- */

/** Whether the folder has a file at `path`. */
async function hasFile(root: FileSystemDirectoryHandle, path: string): Promise<boolean> {
  const parts = path.split("/");
  const file = parts.pop() ?? "";
  try {
    await (await directoryAt(root, parts)).getFileHandle(file);
    return true;
  } catch {
    return false;
  }
}

async function takenIn(root: FileSystemDirectoryHandle, paths: readonly string[] = SETUP_PATHS): Promise<string[]> {
  const taken: string[] = [];
  for (const path of paths) if (await hasFile(root, path)) taken.push(path);
  return taken;
}

/** The files a project already in the folder may have, which is all the search for one keeps. */
const projectFile = (name: string): boolean =>
  name.endsWith(".auto.json") || name.endsWith(".field.json") || name === "robot.json" || name === "waypoints.json";

/** The paths of the project files in the folder, to `SETUP_SEARCH_DEPTH`, skipping build output and hidden folders. */
async function projectFilePaths(root: FileSystemDirectoryHandle): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: FileSystemDirectoryHandle, prefix: string, level: number): Promise<void> => {
    for await (const [name, entry] of dir.entries()) {
      const path = prefix === "" ? name : `${prefix}/${name}`;
      if (entry.kind === "file") {
        if (projectFile(name)) found.push(path);
      } else if (level < SETUP_SEARCH_DEPTH && searchesInto(name)) {
        await walk(entry as FileSystemDirectoryHandle, path, level + 1);
      }
    }
  };
  await walk(root, "", 1);
  return found;
}

function folderTarget(handle: FileSystemDirectoryHandle): SetupTarget {
  return {
    name: handle.name,
    async scan() {
      // No TeamCode folder: nothing to prefill, and Set up still writes the files. A TeamCode that
      // cannot be read is an error to report, not an empty scan.
      const teamCode = await handle.getDirectoryHandle(SETUP_SCAN_DIR).then(
        () => true,
        () => false,
      );
      const sources = teamCode ? await sourcesFromDirectory(handle, SETUP_SCAN_DIR) : [];
      const existing = findExistingProject(await projectFilePaths(handle));
      const taken = await takenIn(handle, existing === null ? SETUP_PATHS : inPlacePaths(existing));
      return { teamCode, sources, existing, taken };
    },
    async write({ existing, ...choices }) {
      const field = loadField(JSON.parse(fieldText));
      const files = existing === null ? setupFileSet({ ...choices, field }) : inPlaceFileSet(existing, { ...choices, field });
      // Checked again, since the folder could have changed while the person decided.
      const taken = await takenIn(handle, files.map((file) => file.path));
      if (taken.length > 0) throw new ProjectError(setupTakenLine(handle.name, taken));
      for (const file of files) await writeTextAt(handle, file.path, file.text, { createDirs: true });
      return files.map((file) => file.path);
    },
    open: (existing) => adoptDirectory(handle, existing === null ? SETUP_AUTO : undefined),
  };
}

/* ---- The desktop app's folder ----------------------------------------------- */

function desktopTarget(bridge: ZenithDesktopBridge, ref: DesktopProjectRef): SetupTarget {
  return {
    name: ref.name,
    async scan() {
      if (bridge.project.setupScan === undefined) throw new ProjectError(`${ref.name} has no zenith.json, and this desktop app cannot set one up.`);
      const scan = await bridge.project.setupScan(ref.root);
      return { ...scan, existing: scan.existing ?? null };
    },
    async write({ existing, ...choices }) {
      if (bridge.project.setup === undefined) throw new ProjectError("This desktop app cannot set a project up.");
      // Main finds the autos itself and builds zenith.json from them: the page only asks for it.
      const result = await bridge.project.setup(ref.root, existing === null ? choices : { ...choices, inPlace: true });
      return result.written;
    },
    async open() {
      await openRecentDesktopFolder(ref.root, adoptBackend);
      return getState().project?.name === ref.name && getState().status?.kind !== "error";
    },
  };
}

/* ---- The flow --------------------------------------------------------------- */

/** Reads the folder's code and asks. Nothing is written until the person presses Set up. */
async function offer(target: SetupTarget): Promise<void> {
  setBusy(true);
  try {
    const { teamCode, sources, taken, existing } = await target.scan();
    current = target;
    // An error left over from an earlier open is not about this folder.
    if (getState().status?.kind === "error") clearStatus();
    showSetup({ folder: target.name, teamCode, plan: planSetup(target.name, sources), taken, existing, problem: null });
  } catch (error) {
    setStatus("error", say(error));
  } finally {
    setBusy(false);
  }
}

/** Open folder picked `handle`, which has no zenith.json: offer to set Zenith up there. */
export const offerFolderSetup = (handle: FileSystemDirectoryHandle): Promise<void> => offer(folderTarget(handle));

/** The desktop app's Open folder picked `ref`, which has no zenith.json: offer to set Zenith up there. */
export const offerDesktopSetup = (bridge: ZenithDesktopBridge, ref: DesktopProjectRef): Promise<void> =>
  offer(desktopTarget(bridge, ref));

/** What the person chose in the dialog. An empty robot class leaves it out. */
export interface SetupAnswer {
  robotClass: string;
  library: CommandLibrary | null;
}

/**
 * Set up: writes the files, shows the Gradle lines, and opens the folder. When anything stops it
 * before the files are written, nothing is, and the question stays open saying why.
 */
export async function runSetup(answer: SetupAnswer): Promise<void> {
  const target = current;
  const prompt = getSetupView().prompt;
  if (target === null || prompt === null) return;
  const typed = answer.robotClass.trim();
  const robotClass = typed === "" ? null : typed;
  const problem = robotClass === null ? null : robotClassProblem(robotClass);
  if (problem !== null) {
    setSetupProblem(problem, "robotClass");
    return;
  }
  setBusy(true);
  let written: string[];
  try {
    written = await target.write({ commandLibrary: answer.library, robotClass, robot: prompt.plan.robot, existing: prompt.existing });
  } catch (error) {
    setSetupProblem(say(error));
    setBusy(false);
    return;
  }
  current = null;
  showSetupDone({
    folder: target.name,
    written,
    library: answer.library,
    robotClass,
    gradle: gradleLines(answer.library, appVersion()),
  });
  try {
    if (await target.open(prompt.existing)) setStatus("ok", setUpLine(target.name, prompt.existing, written));
  } catch (error) {
    reportOpenError(error, "folder", target.name);
  } finally {
    setBusy(false);
  }
}

/** What the status line says once Set up has written and the folder opened. */
function setUpLine(folder: string, existing: ExistingProject | null, written: readonly string[]): string {
  if (existing === null) return `Set Zenith up in ${folder} and opened it. Save writes there.`;
  return `Wrote ${written.join(" and ")} in ${folder}, pointing at the autos in ${existing.autosDir}, and opened it. Nothing was moved.`;
}

/** Cancel on the question: nothing is written. */
export function cancelSetup(): void {
  const prompt = getSetupView().prompt;
  current = null;
  hideSetup();
  if (prompt !== null) setStatus("info", `Nothing was written to ${prompt.folder}.`);
}
