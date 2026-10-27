/**
 * Save on a read-only project: the bundled example, or files opened on their own (issue #103).
 * Save cannot write those in place, so it asks one small question first:
 *
 * - **Save the full project**, a new project to try Zenith out in: `zenith.json`, the robot, the
 *   field, the waypoints and every auto, as a project that opens as written. From the example, its
 *   `zenith.json` names no sim command, robot class or command library, which belong to a robot
 *   repository (issue #159); files opened on their own keep their own `zenith.json`. In the
 *   desktop app and in a browser with the File System Access API it goes into an empty folder the
 *   person picks, never a robot repository, which then opens as the current, writable project.
 *   Anywhere else it downloads as a zip.
 * - **Save just this auto**, into a project they already have: they pick its folder (the one with
 *   `zenith.json`), and the auto goes into the autos folder `zenith.json` names, never over an auto
 *   already there; that project then opens. Anywhere else the auto file downloads, with a line
 *   saying where it belongs.
 *
 * Since issue #158, the unsaved-edits question's Save (`unsaved.ts`) opens the full project's folder
 * too when what comes next stays in this project (another of its autos, a New auto), so it happens
 * in the folder just written; before another project replaces this one, the folder stays closed.
 * Just this auto reads the picked project's waypoints first, and when some the auto follows are
 * missing or somewhere else there, asks what to do before it writes (`waypointCheck.ts`). Whatever
 * Save writes, the read-only project keeps as its own copy, so the auto opens again with it.
 *
 * And the other half of the same confusion: an auto opened on its own gets a message naming the
 * files it needs, with a way to open it on the example's robot and field.
 */
import { canonicalize, loadLink, loadWaypoints, waypointsUsed } from "@horizon36596/zenith-core";
import type { Auto, Waypoint, Waypoints } from "@horizon36596/zenith-schema";
import { LocalBackend, type ProjectBackend } from "../project/backend";
import { DesktopBackend, desktopBridge, loadDesktopProject } from "../project/desktop";
import type { ZenithDesktopBridge } from "../project/desktopBridge";
import { exampleProjectWith, hasExampleLink } from "../project/example";
import { downloadText } from "../project/fallback";
import {
  ProjectError,
  directoryAt,
  ensureWritable,
  loadProjectFromDirectory,
  pickDirectory,
  readTextAt,
  writeTextAt,
} from "../project/local";
import { fullProjectFolderProblem, newProjectLink, projectFileSet, projectPath, projectZipName, type ProjectFile } from "../project/projectFiles";
import { supportsDirectoryPicker, type Project } from "../project/types";
import { downloadBytes, zipStored } from "../library/zip";
import { countOf } from "../lib/format";
import { derive } from "../state/derived";
import { errorsHidden, hiddenErrorsWhere, type ErrorsHidden } from "../state/features";
import {
  commit,
  currentAllFindings,
  getState,
  keepSavedAutoText,
  markSaved,
  markWaypointsSaved,
  setBusy,
  setStatus,
  waypointsDirty,
  type State,
} from "../state/store";
import { adoptBackend, adoptDirectory, impactOfSave, reportOpenError, say } from "./projectActions";
import { saveImpactSentence } from "./waypointImpact";
import { askSaveChoice, askWaypointCheck, dismissLoneAuto, type SaveChoicePrompt, type WaypointCheckPrompt } from "./saveChoice";
import {
  autoForTarget,
  checkWaypoints,
  missingOf,
  needsAnswer,
  poseLine,
  withAddedWaypoints,
  type WaypointAnswer,
  type WaypointCheck,
} from "./waypointCheck";

/** True when Save cannot write the open auto in place, so it asks where it should go instead. */
export function needsSaveChoice(state: Pick<State, "backend" | "project">): boolean {
  const source = state.project?.source.kind;
  return state.backend?.kind === "local" && (source === "example" || source === "files");
}

/** Whether both choices can write into a folder here, or have to download instead. */
export function saveWhere(): SaveChoicePrompt["where"] {
  const bridge = desktopBridge();
  if (bridge !== null) return bridge.project.saveFullProject !== undefined ? "folder" : "download";
  return supportsDirectoryPicker() ? "folder" : "download";
}

export interface SaveReadOnlyOptions {
  /**
   * Open the folder written to as the current project. False when the save is the unsaved-edits
   * question's, because whatever the person was opening replaces this project straight after.
   */
  open?: boolean;
  /**
   * The unsaved-edits question is about something that stays in this project: another of its autos,
   * or a New auto (issue #158). Save the full project then opens the folder it wrote even though
   * `open` is false, so what comes next happens there. Just this auto still never opens the other
   * project, which is someone else's.
   */
  sameProject?: boolean;
}

/** Asks where the open auto goes and saves it there. Resolves once it is saved, or the person cancelled. */
export async function saveReadOnly(options: SaveReadOnlyOptions = {}): Promise<void> {
  const { project, auto, fileName, backend } = getState();
  if (project === null || auto === null || fileName === null) return;
  const from: SavingFrom = { fileName, backend };
  const open = options.open ?? true;
  const sameProject = options.sameProject === true;
  // The full project's folder opens on Ctrl S, and from the unsaved-edits question when what comes
  // next stays in this project. Just this auto opens the project it went into only on Ctrl S.
  const opensProject = open || sameProject;
  const opensTarget = open && !sameProject;
  // Changed waypoints go only with the full project: an auto saved alone could follow a waypoint
  // the other project does not have, or has elsewhere (issue #134).
  const waypointsChanged = waypointsDirty();
  const followed = waypointsUsed(auto).length;
  const choice = await askSaveChoice({
    fileName,
    isExample: project.source.kind === "example",
    where: saveWhere(),
    ...(waypointsChanged ? { waypointsChanged } : {}),
    ...(opensProject ? {} : { opensProject: false }),
    ...(followed > 0 ? { waypointsFollowed: followed } : {}),
  });
  if (choice === "cancel" || (choice === "auto" && waypointsChanged)) return;
  setBusy(true);
  try {
    if (choice === "project") await saveFullProject(project, from, canonicalize("auto", auto), opensProject);
    else await saveJustAuto(project, from, auto, opensTarget);
  } catch (error) {
    setStatus("error", say(error));
  } finally {
    setBusy(false);
  }
}

/**
 * The files of the full project: the project as it is open, with the open auto as edited. When its
 * `zenith.json` is the example's, the full project's names no sim command, robot class or command
 * library (issue #159): those name the example's made-up robot repository, and this is a new
 * project for trying Zenith out. Files opened on their own keep their own `zenith.json` as it is.
 */
export function fullProjectOf(project: Project, fileName: string, text: string): ProjectFile[] {
  return projectFileSet({
    link: hasExampleLink(project) ? newProjectLink(project.link) : project.link,
    robot: project.robot,
    field: project.field,
    ...(project.waypoints === undefined ? {} : { waypoints: project.waypoints }),
    autos: { ...project.autoTexts, [fileName]: text },
  });
}

/** The auto a save started on: its file, and the backend of the project it was open in. */
interface SavingFrom {
  fileName: string;
  backend: ProjectBackend | null;
}

/** True while the auto a save started on is still the one open, in the same project. */
const stillOpen = (from: SavingFrom): boolean => {
  const state = getState();
  return state.backend === from.backend && state.fileName === from.fileName;
};

/**
 * Marks the open auto saved with `message`, and keeps `text` as the read-only project's own copy of
 * it, in the store and in its backend, so the auto opens again here with what was saved (issue #158).
 * When another auto or project was opened while the file was written (issue #401), that one is not
 * marked saved: the status line still says what was written, and the project keeps its copy.
 */
function savedHere(from: SavingFrom, text: string, message: string, broken = ""): void {
  const { fileName, backend } = from;
  if (stillOpen(from)) {
    markSaved(text, `${message}${broken}`);
    if (broken !== "") setStatus("warn", `${message}${broken}`);
  } else {
    setStatus(broken === "" ? "ok" : "warn", `${message}${broken}`);
  }
  if (getState().backend === backend) keepSavedAutoText(fileName, text);
  if (backend instanceof LocalBackend) backend.keepSavedText(fileName, text);
}

/** The status line of a full project that was written into folder `name` and not opened. */
const savedProjectLine = (name: string): string =>
  `Saved the project to ${name}. Open ${name} later with Open project to keep working in it.`;

async function saveFullProject(project: Project, from: SavingFrom, text: string, open: boolean): Promise<void> {
  const { fileName } = from;
  const files = fullProjectOf(project, fileName, text);
  const bridge = desktopBridge();
  // Changed waypoints go with the project, so the other autos in it follow them: Save says which
  // now have errors (issue #191). Worked out before the waypoints count as saved.
  const impact = await impactOfSave();
  const broken = impact === null ? "" : saveImpactSentence(impact);
  const kind = broken === "" ? "ok" : "warn";
  if (bridge !== null && bridge.project.saveFullProject !== undefined) {
    // The desktop app writes its own zenith.json, so only the other files cross the bridge.
    const at = (path: string) => files.find((file) => file.path === path)?.text;
    const ref = await bridge.project.saveFullProject({
      robot: at(projectPath(project.link.robot)) ?? "",
      field: at(projectPath(project.link.field)) ?? "",
      waypoints: project.link.waypoints === undefined ? null : (at(projectPath(project.link.waypoints)) ?? null),
      autos: Object.entries({ ...project.autoTexts, [fileName]: text }).map(([name, body]) => ({ fileName: name, text: body })),
    });
    if (ref === null) return;
    markWaypointsSaved(project.waypoints);
    savedHere(from, text, open ? `Saved the project to ${ref.name}.` : savedProjectLine(ref.name), broken);
    if (open && (await openSaved(new DesktopBackend(bridge, ref), fileName))) {
      setStatus(kind, `Saved the project to ${ref.name} and opened it. Save now writes there.${broken}`);
    }
    return;
  }
  if (bridge === null && supportsDirectoryPicker()) {
    const handle = await pickDirectory();
    if (handle === null) return;
    if (!(await ensureWritable(handle))) throw new ProjectError("Zenith needs permission to write into that folder.");
    // Only into an empty folder, never a team's robot repository (issue #159).
    const problem = fullProjectFolderProblem(handle.name, await topLevelNames(handle));
    if (problem !== null) throw new ProjectError(problem);
    for (const file of files) await writeTextAt(handle, file.path, file.text, { createDirs: true });
    markWaypointsSaved(project.waypoints);
    savedHere(from, text, open ? `Saved the project to ${handle.name}.` : savedProjectLine(handle.name), broken);
    if (open && (await openSavedFolder(handle, fileName))) {
      setStatus(kind, `Saved the project to ${handle.name} and opened it. Save now writes there.${broken}`);
    }
    return;
  }
  const zipName = projectZipName(project.name);
  downloadBytes(zipName, zipStored(files));
  markWaypointsSaved(project.waypoints);
  savedHere(from, text, `Downloaded ${zipName}.`, broken);
  setStatus(broken === "" ? "info" : "warn", `Downloaded ${zipName}. Unzip it, then open the folder with Open project.${broken}`);
}

/**
 * A project Save just this auto picked, read but not yet written to: a folder in the browser, or one
 * the desktop app's picker returned (issue #158).
 */
interface AutoTarget {
  /** The folder's own name, for the status line. */
  name: string;
  /** Where the auto goes, from the project's root: `autos/collect-and-score.auto.json`. */
  path: string;
  /** The waypoints file its `zenith.json` names, from the root, or null when it names none. */
  waypointsPath: string | null;
  /** Its waypoints as they are now; null when it names none, or the file does not load. */
  waypoints: Waypoints | null;
  /**
   * Writes the auto, after putting `add` into its waypoints file. Never over a file or a waypoint
   * name already there; a refusal writes nothing.
   */
  write(text: string, add: Readonly<Record<string, Waypoint>>): Promise<void>;
  /** Opens the project on the auto. True when it opened cleanly; otherwise the status line says why. */
  open(fileName: string): Promise<boolean>;
  /** Reads the project as it is now, to count the errors the auto has there. */
  load(): Promise<Project>;
}

/** A waypoints file's text as waypoints, or null when there is none or it does not load. */
function waypointsFrom(text: string | null): Waypoints | null {
  if (text === null) return null;
  try {
    return loadWaypoints(JSON.parse(text));
  } catch {
    return null;
  }
}

async function saveJustAuto(project: Project, from: SavingFrom, auto: Auto, open: boolean): Promise<void> {
  const { fileName } = from;
  const text = canonicalize("auto", auto);
  const bridge = desktopBridge();
  if (bridge !== null && (bridge.project.pickAutoTarget === undefined || bridge.project.writeAutoInto === undefined)) {
    await saveJustAutoOnOlderDesktop(bridge, from, text, open);
    return;
  }
  if (bridge === null && !supportsDirectoryPicker()) {
    downloadText(fileName, text);
    savedHere(from, text, `Downloaded ${fileName}.`);
    setStatus("info", `Downloaded ${fileName}. It belongs in the autos folder of your project.`);
    return;
  }
  const target = bridge === null ? await pickFolderTarget(fileName) : await pickDesktopTarget(bridge, fileName);
  if (target === null) return;

  const check = checkWaypoints(auto, project.waypoints, target.waypoints ?? undefined);
  let answer: WaypointAnswer = "own";
  if (needsAnswer(check)) {
    // Nothing is busy while the person reads the waypoints and decides.
    setBusy(false);
    const given = await askWaypointCheck(waypointCheckPrompt(fileName, check, target));
    setBusy(true);
    if (given === "cancel") {
      setStatus("info", `Nothing was written to ${target.name}.`);
      return;
    }
    answer = given;
  }

  const fixed = autoForTarget(auto, check, answer);
  const written = canonicalize("auto", fixed.auto);
  await target.write(written, fixed.add);
  // The editor shows what was written: a point given a pose of its own has it here too. Only while
  // the auto is still open as the save found it: never into another auto opened during the write,
  // nor over an edit made meanwhile (issue #401).
  if (fixed.auto !== auto && stillOpen(from) && getState().auto === auto) commit(fixed.auto);
  const where = `${target.name}/${target.path}`;
  const added = Object.keys(fixed.add).length;
  const addedTo = added === 0 ? "" : `, added ${countOf(added, "waypoint")} to ${target.name}/${target.waypointsPath ?? ""}`;
  const own = fixed.ownPoses.length === 0 ? "" : ` It keeps the poses of ${countOf(fixed.ownPoses.length, "waypoint")} as its own.`;
  savedHere(from, written, `Saved ${where}${addedTo}.`);
  if (open) {
    if (await target.open(fileName)) {
      const counted = errorsInOpenAuto();
      // A hidden error is not in the Problems tab, so the line says where it is instead.
      const listed = counted.hidden === 0 ? ", which the Problems tab lists" : hiddenErrorsWhere(counted);
      sayHowItSaved(`Saved ${where}${addedTo} and opened ${target.name}.${own}`, counted.errors, `there${listed}`);
    }
    return;
  }
  sayHowItSaved(`Saved ${where}${addedTo}.${own}`, await errorsIn(target, fixed.auto), `in ${target.name}; open it there to see them`);
}

/**
 * The status line once Just this auto wrote the auto: green when the checks find no error in it
 * where it went, and a warning that counts them when they do (issue #158), since "Saved" alone would
 * read as all being well.
 */
function sayHowItSaved(line: string, errors: number | null, where: string): void {
  if (errors === null || errors === 0) setStatus("ok", line);
  else setStatus("warn", `${line} It has ${countOf(errors, "error")} ${where}.`);
}

const errorCount = (findings: ReadonlyArray<{ severity: string }>): number =>
  findings.filter((finding) => finding.severity === "error").length;

/**
 * Every error the open auto has, and which of them the feature switches hide from the Problems tab.
 * A hidden error counts, as it does for Validate and the CLI.
 */
const errorsInOpenAuto = (): ErrorsHidden => {
  const { auto, prefs } = getState();
  return errorsHidden(currentAllFindings(), auto, prefs.features);
};

/** The errors `auto` has in the target project, or null when that project cannot be read. */
async function errorsIn(target: AutoTarget, auto: Auto): Promise<number | null> {
  try {
    const there = await target.load();
    return errorCount(derive(auto, there.robot, there.field, there.waypoints).findings);
  } catch {
    return null;
  }
}

/** The waypoint step's question: each name that is missing or elsewhere, with both poses. */
function waypointCheckPrompt(fileName: string, check: WaypointCheck, target: AutoTarget): WaypointCheckPrompt {
  const rows: WaypointCheckPrompt["rows"] = [];
  for (const entry of check.compared) {
    if (entry.match === "same") continue;
    rows.push({ name: entry.name, match: entry.match, here: poseLine(entry.here), there: entry.there === undefined ? null : poseLine(entry.there) });
  }
  const canAdd = target.waypointsPath !== null && target.waypoints !== null && missingOf(check).length > 0;
  return {
    fileName,
    project: target.name,
    followed: check.used.length,
    rows,
    addTo: canAdd ? `${target.name}/${target.waypointsPath ?? ""}` : null,
  };
}

/** Asks for a project folder in the browser and reads where the auto would go, writing nothing. */
async function pickFolderTarget(fileName: string): Promise<AutoTarget | null> {
  const handle = await pickDirectory();
  if (handle === null) return null;
  if (!(await ensureWritable(handle))) throw new ProjectError("Zenith needs permission to write into that folder.");
  const { path, waypointsPath } = await autoPathIn(handle, fileName);
  const waypoints = waypointsPath === null ? null : waypointsFrom(await readTextAt(handle, waypointsPath).catch(() => null));
  return {
    name: handle.name,
    path,
    waypointsPath,
    waypoints,
    async write(text, add) {
      // Checked again, since the folder could have changed while the person decided.
      if ((await firstTaken(handle, [{ path, text: "" }])) !== null) {
        throw new ProjectError(`${handle.name} already has ${path}, so nothing was written. Open ${handle.name} to change that auto there.`);
      }
      if (Object.keys(add).length > 0) {
        if (waypointsPath === null) {
          throw new ProjectError(`${handle.name}'s zenith.json names no waypoints file, so nothing was written.`);
        }
        let next: string;
        try {
          next = canonicalize("waypoints", withAddedWaypoints(loadWaypoints(JSON.parse(await readTextAt(handle, waypointsPath))), add));
        } catch (error) {
          throw new ProjectError(`${handle.name}/${waypointsPath} cannot take the missing waypoints, so nothing was written: ${say(error)}`);
        }
        await writeTextAt(handle, waypointsPath, next);
      }
      await writeTextAt(handle, path, text);
    },
    open: (name) => openSavedFolder(handle, name),
    load: () => loadProjectFromDirectory(handle),
  };
}

/**
 * Asks the desktop app for a project folder and reads where the auto would go, writing nothing: the
 * pick and the write are two bridge calls, so the editor sees the project's waypoints in between.
 */
async function pickDesktopTarget(bridge: ZenithDesktopBridge, fileName: string): Promise<AutoTarget | null> {
  const pick = bridge.project.pickAutoTarget;
  const writeInto = bridge.project.writeAutoInto;
  if (pick === undefined || writeInto === undefined) return null;
  const picked = await pick(fileName);
  if (picked === null) return null;
  let ref = picked.project;
  return {
    name: ref.name,
    path: picked.path,
    waypointsPath: picked.waypointsPath,
    waypoints: waypointsFrom(picked.waypoints),
    async write(text, add) {
      const saved = await writeInto(ref.root, fileName, text, Object.keys(add).length === 0 ? null : { ...add });
      ref = saved.project;
    },
    open: (name) => openSaved(new DesktopBackend(bridge, ref), name),
    load: () => loadDesktopProject(bridge, ref),
  };
}

/** A desktop app from before issue #158: one bridge call picks and writes, with no waypoint check. */
async function saveJustAutoOnOlderDesktop(bridge: ZenithDesktopBridge, from: SavingFrom, text: string, open: boolean): Promise<void> {
  const { fileName } = from;
  if (bridge.project.saveAutoInto === undefined) {
    // An older desktop app still: the native Save As dialog, as closing with the example open uses.
    const saved = await bridge.saveCopy(fileName, text);
    if (saved !== null) savedHere(from, text, `Saved a copy as ${saved}.`);
    return;
  }
  const saved = await bridge.project.saveAutoInto(fileName, text);
  if (saved === null) return;
  const where = `${saved.project.name}/${saved.path}`;
  savedHere(from, text, `Saved ${where}.`);
  if (open && (await openSaved(new DesktopBackend(bridge, saved.project), fileName))) {
    setStatus("ok", `Saved ${where} and opened ${saved.project.name}.`);
  }
}

/**
 * Where the auto goes in the project folder the person picked: the autos folder its `zenith.json`
 * names, which must exist, and a name no auto there has yet. Also the waypoints file it names.
 */
async function autoPathIn(handle: FileSystemDirectoryHandle, fileName: string): Promise<{ path: string; waypointsPath: string | null }> {
  let linkText: string;
  try {
    linkText = await readTextAt(handle, "zenith.json");
  } catch {
    throw new ProjectError(
      `${handle.name} has no zenith.json, so it is not a project. Pick the folder that has zenith.json at its top, or open ${handle.name} with Open project, and Zenith offers to set it up.`,
    );
  }
  let autosDir: string;
  let waypointsPath: string | null;
  try {
    const link = loadLink(JSON.parse(linkText));
    autosDir = projectPath(link.autosDir);
    waypointsPath = link.waypoints === undefined ? null : projectPath(link.waypoints);
  } catch (error) {
    throw new ProjectError(`${handle.name}'s zenith.json does not load, so nothing was written: ${say(error)}`);
  }
  try {
    await directoryAt(handle, autosDir.split("/"));
  } catch {
    throw new ProjectError(`The autos folder ${autosDir} does not exist in ${handle.name}, so nothing was written.`);
  }
  const path = `${autosDir}/${fileName}`;
  if ((await firstTaken(handle, [{ path, text: "" }])) !== null) {
    throw new ProjectError(`${handle.name} already has ${path}, so nothing was written. Open ${handle.name} to change that auto there.`);
  }
  return { path, waypointsPath };
}

/** The names at the top of the folder. */
async function topLevelNames(handle: FileSystemDirectoryHandle): Promise<string[]> {
  const names: string[] = [];
  for await (const [name] of handle.entries()) names.push(name);
  return names;
}

/** The first of the files that already exists in the folder, or null when none does. */
async function firstTaken(handle: FileSystemDirectoryHandle, files: readonly ProjectFile[]): Promise<string | null> {
  for (const file of files) {
    try {
      await readTextAt(handle, file.path);
      return file.path;
    } catch {
      // Not there, which is what a save into this folder needs.
    }
  }
  return null;
}

/** Opens a folder just written to as the current project, on the auto just saved. True when it opened cleanly. */
async function openSavedFolder(handle: FileSystemDirectoryHandle, fileName: string): Promise<boolean> {
  try {
    return await adoptDirectory(handle, fileName);
  } catch (error) {
    reportOpenError(error, "folder", handle.name);
    return false;
  }
}

async function openSaved(backend: DesktopBackend, fileName: string): Promise<boolean> {
  try {
    return await adoptBackend(backend, fileName, "Opening the saved project will close it.");
  } catch (error) {
    reportOpenError(error, "folder");
    return false;
  }
}

/* ---- An auto opened on its own -------------------------------------------- */

/**
 * Opens autos that came without their project on the example's robot, field and waypoints, read
 * only, and says so: their own project's robot and field may differ.
 */
export async function openOnExample(autoTexts: Readonly<Record<string, string>>): Promise<void> {
  dismissLoneAuto();
  setBusy(true);
  try {
    const project = exampleProjectWith(autoTexts);
    const opened = await adoptBackend(LocalBackend.of(project), undefined, "Opening the auto will close it.");
    const name = getState().fileName ?? project.autoFiles[0] ?? "The auto";
    if (opened) {
      setStatus("info", `Opened ${name} on the example robot and field, read only. Its own project's robot and field may differ.`);
    }
  } catch (error) {
    reportOpenError(error, "files");
  } finally {
    setBusy(false);
  }
}
