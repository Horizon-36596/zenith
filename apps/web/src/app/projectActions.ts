/**
 * Opening a project, opening an auto, and saving, in whichever mode the project came from. Every
 * read and write goes through the `ProjectBackend` the store holds, so this module is the same
 * five steps for a local folder and for a GitHub repository (site/docs/github.md);
 * `apps/web/src/github/` builds the second
 * backend and the sign-in, propose and review flows around it.
 */
import { canonicalize } from "@horizon36596/zenith-core";
import { LocalBackend, type ProjectBackend } from "../project/backend";
import { loadExampleProject } from "../project/example";
import { projectFromFiles, projectFromZip, saveFileAs } from "../project/fallback";
import { forgetDirectory, recallDirectory, rememberDirectory } from "../project/idb";
import { SessionEndedError } from "../project/errors";
import { NoProjectLinkError, ProjectError, autoPath, ensureWritable, loadProjectFromDirectory, pickDirectory } from "../project/local";
import { listAuto, savesInPlace } from "./autoList";
import { ProjectFileError, unreadableJsonMessage } from "../project/fileErrors";
import { olderFormatLine } from "../project/formatVersion";
import { LoneAutoError } from "../project/projectFiles";
import { showLoneAuto } from "./saveChoice";
import { clearOpenProblem, setOpenProblem, type OpenKind } from "./openProblem";
import type { SaveReadOnlyOptions } from "./saveReadOnly";
import { resolveAutoOverrides } from "../project/overrides";
import { openDesktopFolder, startDesktop } from "../project/desktopActions";
import { isDesktop } from "../project/desktop";
import { KeptUnsavedEdits, confirmReplace, requireReplace } from "./unsaved";
import { changedWaypointNames, forgetOtherAuto, saveImpactSentence, waypointImpact, waypointsFileName, type Impact } from "./waypointImpact";
import { rememberCommit } from "../library/gitCommits";
import { showProblemsTab } from "../panels/bottomTab";
import { problemsListed } from "../panels/findingRows";
import { severityCounts, sortFindings } from "../state/derived";
import { parseTrace, TraceError } from "@horizon36596/zenith-core";
import {
  getState,
  loadedWaypoints,
  markSaved,
  markValidated,
  markWaypointsSaved,
  openAuto,
  openProject,
  clearStatus,
  currentDerived,
  isDirty,
  setAutoOverrides,
  setBusy,
  setDialog,
  setStatus,
  setTrace,
  waypointsDirty,
} from "../state/store";
import { focusForInput } from "../components/inputModality";

export const say = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Puts a failed open on the status line; an open the person cancelled is not an error. A failure is
 * also kept for the empty canvas, which says what did not open (the `kind`, and its `name` when
 * known) and why, and offers to open another of the same kind (issue #502).
 */
export function reportOpenError(error: unknown, kind: OpenKind, name: string | null = null): void {
  if (error instanceof KeptUnsavedEdits) {
    setStatus("info", say(error));
    return;
  }
  setStatus("error", say(error));
  setOpenProblem({ kind, name, message: say(error) });
}

/**
 * The one way a project enters the editor: open the backend, put it and its project in the store,
 * and open an auto. GitHub mode calls this with its own backend. `preferredAuto` opens that file
 * instead of `autoFiles[0]` when the project carries it, which is how `loadExample` picks the
 * richer of the two bundled autos rather than whichever sorts first; every other caller leaves it
 * unset and gets the alphabetically-first file, same as before.
 *
 * An auto that does not load does not leave the project without one (the 0.1.2 UX sweep, W3-3):
 * the next auto in the list that does load opens instead, and the status line names the broken
 * file and what is wrong with it. When none loads, the canvas lists the project's autos. With
 * `onlyPreferred` (host mode), a `preferredAuto` that does not load opens nothing else.
 *
 * The project is read before anything is replaced, so a folder that fails to open costs nothing.
 * Then, when the open auto has unsaved edits, the person is asked (QA-12); on Cancel this throws
 * `KeptUnsavedEdits` and the old project stays. `next` is what the question says will happen.
 */
export async function adoptBackend(
  backend: ProjectBackend,
  preferredAuto?: string,
  next = "Opening another project will close it.",
  onlyPreferred = false,
): Promise<boolean> {
  const project = await backend.open();
  await requireReplace(next);
  openProject(project, backend);
  clearOpenProblem();
  const first =
    preferredAuto !== undefined && project.autoFiles.includes(preferredAuto)
      ? preferredAuto
      : project.autoFiles[0];
  if (first === undefined) return true;
  // The auto a host asked for is the only one it may get: another would be saved back as if asked for.
  const hostPick = onlyPreferred && first === preferredAuto;
  const order = hostPick ? [first] : [first, ...project.autoFiles.filter((name) => name !== first)];
  const broken: string[] = [];
  for (const fileName of order) {
    const ticket = opensStarted + 1;
    const result = await openAutoFile(fileName);
    // A later open, or another project, began while this auto was read: that one says what happened.
    if (opensStarted !== ticket || getState().backend !== backend) return false;
    if (result === "failed") {
      broken.push(getState().status?.message ?? `Cannot open ${fileName}.`);
      continue;
    }
    if (broken.length === 0) return result === "clean";
    // A "noted" open that did not put this auto on screen leaves its own line.
    if (getState().fileName !== fileName) return false;
    // The broken file comes first; a note the open auto left (an older format) follows it.
    const note = result === "noted" ? getState().status?.message : undefined;
    setStatus("error", `${brokenLine(broken)} Opened ${fileName} instead.${note === undefined ? "" : ` ${note}`}`);
    return false;
  }
  setStatus("error", hostPick ? brokenLine(broken) : `None of the autos in ${project.name} opened. ${brokenLine(broken)}`);
  return false;
}

/** The first auto that did not open, and how many more did not. */
function brokenLine(broken: readonly string[]): string {
  const more = broken.length - 1;
  if (more === 0) return broken[0] ?? "";
  return `${broken[0] ?? ""} ${String(more)} more ${more === 1 ? "auto" : "autos"} did not open either.`;
}

/**
 * Opens the bundled `examples/starter` and `collect-and-score.auto.json`, so the app demos with no
 * folder. `collect-and-score` is the one that shows the most at a glance (a marker, a parallel
 * deadline group and a sequence), which the full tour's stops point at; `first-auto.auto.json`,
 * the one the getting-started guide walks through, and `all-step-kinds.auto.json` are one click
 * away through the same picker every other auto in a project opens through.
 */
export async function loadExample(): Promise<void> {
  setBusy(true);
  // The example is another way in: a folder that did not open is no longer what the canvas is about.
  clearOpenProblem();
  try {
    const opened = await adoptBackend(
      LocalBackend.of(loadExampleProject()),
      "collect-and-score.auto.json",
      "Opening the example will close it.",
    );
    setDialog(null);
    if (opened) setStatus("info", "Example loaded, read only.", "Save makes your own copy.");
  } catch (error) {
    reportOpenError(error, "example");
  } finally {
    setBusy(false);
  }
}

/**
 * Open folder: the folder picker, then the folder as the project. With `setUp`, the palette's Set up
 * Zenith asked, so a folder that is set up already says so when it opens (issue #502).
 */
export async function openFolder(options: { setUp?: boolean } = {}): Promise<void> {
  if (isDesktop()) return openDesktopFolder(adoptBackend, options);
  setBusy(true);
  let folder: string | null = null;
  try {
    const handle = await pickDirectory();
    if (handle === null) return;
    folder = handle.name;
    await adoptDirectory(handle, undefined, options);
  } catch (error) {
    reportOpenError(error, "folder", folder);
  } finally {
    setBusy(false);
  }
}

/** The palette's Set up Zenith: Open folder, which sets up a folder with no zenith.json first. */
export const setUpFolder = (): Promise<void> => openFolder({ setUp: true });

/** What the status line says when a folder opened, or when Set up found it set up already. */
export const openedLine = (name: string, setUp: boolean): string =>
  setUp ? `${name} is already set up. Opened it.` : `Opened ${name}.`;

/**
 * Opens a folder the person picked as the current project. `preferredAuto` opens that auto rather
 * than the first, which is how a folder Save just wrote to opens on the auto that was saved. A folder
 * with no `zenith.json` yet opens Set up for it instead (issue #159), and this resolves false.
 */
export async function adoptDirectory(
  handle: FileSystemDirectoryHandle,
  preferredAuto?: string,
  options: { setUp?: boolean } = {},
): Promise<boolean> {
  if (!(await ensureWritable(handle))) {
    throw new ProjectError("Zenith needs permission to write into that folder to save autos.");
  }
  let opened: boolean;
  try {
    opened = await adoptBackend(
      new LocalBackend(() => loadProjectFromDirectory(handle)),
      preferredAuto,
      `Opening ${handle.name} will close it.`,
    );
  } catch (error) {
    if (!(error instanceof NoProjectLinkError)) throw error;
    // Not a failure to report: nothing was replaced, and the folder can be set up (issue #159).
    setDialog(null);
    const { offerFolderSetup } = await import("./setupProject");
    await offerFolderSetup(handle);
    return false;
  }
  await rememberDirectory(handle);
  setDialog(null);
  if (opened) setStatus("ok", openedLine(getState().project?.name ?? handle.name, options.setUp === true));
  return opened;
}

/** Reopens the folder from the last session, if the browser still grants it. */
export async function reopenLastFolder(): Promise<boolean> {
  if (isDesktop()) return startDesktop(adoptBackend);
  const handle = await recallDirectory();
  if (handle === null) return false;
  const granted = (await handle.queryPermission?.({ mode: "readwrite" })) ?? "prompt";
  if (granted !== "granted") return false;
  try {
    await adoptBackend(
      new LocalBackend(() => loadProjectFromDirectory(handle)),
      undefined,
      `Reopening ${handle.name} will close it.`,
    );
    return true;
  } catch (error) {
    if (error instanceof KeptUnsavedEdits) return false;
    await forgetDirectory();
    return false;
  }
}

export async function openPickedFiles(files: readonly File[]): Promise<void> {
  setBusy(true);
  try {
    const zip = files.find((file) => file.name.endsWith(".zip"));
    const opened = await adoptBackend(
      new LocalBackend(async () =>
        zip === undefined ? projectFromFiles(files) : projectFromZip(zip),
      ),
      undefined,
      "Opening those files will close it.",
    );
    setDialog(null);
    if (opened) setStatus("info", "Opened from files. They are read only, so Save asks where to put the auto.");
  } catch (error) {
    if (error instanceof LoneAutoError) {
      // Not a failure to report: the message says which files are missing and offers the example.
      setDialog(null);
      showLoneAuto({ autoTexts: error.autoTexts });
      return;
    }
    reportOpenError(error, "files");
  } finally {
    setBusy(false);
  }
}

/**
 * Switches to another auto in the open project, asking first when this one has unsaved edits. The
 * question's Save on the read-only example can open the folder it wrote (issue #158), and the auto
 * then opens from that folder.
 */
export async function openAutoNamed(fileName: string): Promise<void> {
  const current = getState().fileName;
  const next =
    current === fileName
      ? `Opening ${fileName} again will put back the saved version.`
      : `Opening ${fileName} will replace it.`;
  const dirty = isDirty();
  if (!(await confirmReplace(next, { sameProject: true }))) {
    setStatus("info", `Kept the unsaved edits in ${current ?? "this auto"}.`);
    return;
  }
  // Still dirty after the question: the person chose Discard, not Save.
  const discarded = dirty && isDirty() ? (current ?? "this auto") : null;
  const said = getState().status;
  if (!(await loadAutoNamed(fileName))) return;
  // A line the open itself led to (the alliance view's "Your start offset is 0 s for …") is the
  // answer; otherwise a clean open says so, which also takes away a line an earlier action left
  // (UI_GUIDE 9.15).
  const now = getState().status;
  if (now !== null && now !== said) return;
  const opened = getState().fileName ?? fileName;
  setStatus("ok", discarded === null ? `Opened ${opened}.` : `Discarded the edits to ${discarded}. Opened ${opened}.`);
}

/** How many opens `loadAutoNamed` has started, so a read can tell whether a later one began. */
let opensStarted = 0;

/**
 * Reads an auto and opens it, with no question: the caller has already asked. True when it opened
 * cleanly; when it could not, or its own robot or field file could not be used, the status line says
 * why, and the caller leaves that there rather than covering it with "Opened".
 * An error left over from an earlier open is cleared once this one succeeds, so it never reads as
 * being about the auto now on screen. An auto written in an older format opens with a line saying
 * that saving writes the new one, and this returns false so the caller does not cover that line.
 *
 * A read that lands after another open began is dropped, and so is one that lands after the auto
 * it would replace was edited or replaced (issue #401): the question about unsaved edits was asked
 * about the auto as it was when the read began, so it does not cover what changed since.
 */
async function loadAutoNamed(fileName: string): Promise<boolean> {
  return (await openAutoFile(fileName)) === "clean";
}

/**
 * `loadAutoNamed`'s work, saying how it went: "clean" when the auto opened with nothing to say,
 * "noted" when the status line says something the caller should not cover (or another open took
 * over), and "failed" when the auto could not be read or did not load, with the reason on the
 * status line.
 */
async function openAutoFile(fileName: string): Promise<"clean" | "noted" | "failed"> {
  const backend = getState().backend;
  const project = getState().project;
  if (backend === null || project === null) return "noted";
  opensStarted += 1;
  const ticket = opensStarted;
  const replacing = getState().auto;
  try {
    const loaded = await backend.readAuto(fileName);
    // A later open is under way, or another project is open: that one says what happened.
    if (ticket !== opensStarted || getState().backend !== backend) return "noted";
    if (getState().auto !== replacing) {
      setStatus("info", `Did not open ${fileName}: the auto on screen changed while it was loading. Open it again to replace it.`);
      return "noted";
    }
    openAuto(loaded.fileName, loaded.auto, loaded.canonical);
    // GitHub mode: the waypoints as this auto's work branch has them (issue #134).
    if (loaded.waypoints !== undefined) loadedWaypoints(loaded.waypoints);
    if (getState().status?.kind === "error") clearStatus();
    // openAuto already set autoRobot/autoField to the project's own, synchronously; this resolves
    // auto.robot/auto.field (finding 23) and replaces them once that read comes back.
    const overrides = await resolveAutoOverrides(project, backend, loaded.auto);
    // A second open began while the overrides were read: that one says what happened, and this
    // one writes nothing over it.
    if (ticket !== opensStarted || getState().fileName !== loaded.fileName) return "noted";
    setAutoOverrides(overrides.robot, overrides.field);
    if (overrides.error !== null) {
      setStatus("error", overrides.error);
      return "noted";
    }
    if (loaded.fromFormatVersion === undefined) return "clean";
    setStatus("info", olderFormatLine(loaded.fileName, loaded.fromFormatVersion, getState().host));
    return "noted";
  } catch (error) {
    // A later open, or another project, says what happened instead.
    if (ticket !== opensStarted || getState().backend !== backend) return "noted";
    // A project file error already names the file and says what to do.
    setStatus("error", error instanceof ProjectFileError ? error.message : `Cannot open ${fileName}: ${say(error)}`);
    return "failed";
  }
}

/**
 * Writes the canonical file wherever the backend puts it: in place, or a commit. A read-only
 * project (the example, picked files) first asks whether to save the full project or just this
 * auto (`saveReadOnly.ts`, issue #103); `options` passes through to it. In a folder or the desktop
 * app, the first save of a new auto refuses when its file is already there, and puts it on the
 * project's list once it is written (issue #157).
 */
export async function save(summary?: string, options: SaveReadOnlyOptions = {}): Promise<void> {
  const { backend, auto, fileName } = getState();
  if (backend === null || auto === null || fileName === null) return;
  const readOnly = await import("./saveReadOnly");
  if (readOnly.needsSaveChoice(getState())) {
    await readOnly.saveReadOnly(options);
    return;
  }
  setBusy(true);
  try {
    if (await alreadyOnDisk(backend, fileName)) return;
    // What the changed waypoints do to the other autos is worked out before they are marked saved.
    const impact = await impactOfSave();
    const writesWaypoints = waypointsDirty();
    if (!(await saveWaypoints(backend, fileName, summary))) return;
    const result = await backend.save(fileName, canonicalize("auto", auto), summary);
    markSaved(result.text, result.savedMessage);
    forgetOtherAuto(fileName);
    // A new auto written into a folder is on the project's list from now on (issue #157).
    listAuto(fileName);
    if (result.commitSha !== undefined) rememberCommit(fileName, result.text, result.commitSha);
    // Save names waypoints.json when it wrote it, and the other autos the change broke (issue #191).
    const broken = impact === null ? "" : saveImpactSentence(impact);
    if (result.note !== undefined) setStatus("info", `${result.note}${broken}`);
    else if (writesWaypoints) {
      setStatus(broken === "" ? "ok" : "warn", `${result.savedMessage ?? `Saved ${fileName} and ${waypointsFileName()}.`}${broken}`);
    }
  } catch (error) {
    // A host session that ended mid-save already said so, on the bar and the status line.
    if (!(error instanceof SessionEndedError)) setStatus("error", say(error));
  } finally {
    setBusy(false);
  }
}

/**
 * What the unsaved waypoints do to the project's other autos, for the line Save writes (issue #191):
 * each follower checked with the saved waypoints and with these. Null when no waypoint changed, or
 * when the other autos could not be checked, which never stops Save.
 */
export async function impactOfSave(): Promise<Impact | null> {
  if (!waypointsDirty()) return null;
  try {
    return await waypointImpact(changedWaypointNames(), true);
  } catch {
    return null;
  }
}

/**
 * Before the first write of an auto that has never been saved (New auto, an import), in a folder or
 * the desktop app (issue #157): true, with the reason on the status line, when a file of its name is
 * already in the project's autos folder, which this Save would replace. Nothing is written, not even
 * the waypoints. The file appeared after the auto was started, so it goes on the list, where it can
 * be opened.
 */
async function alreadyOnDisk(backend: ProjectBackend, fileName: string): Promise<boolean> {
  const { project, savedCanonical } = getState();
  if (savedCanonical !== "" || project === null || !savesInPlace(project) || backend.hasAuto === undefined) return false;
  if (!(await backend.hasAuto(fileName))) return false;
  listAuto(fileName);
  setStatus(
    "error",
    `${project.name} already has ${autoPath(project, fileName)}, so nothing was written: saving this new auto would replace it. Open that auto from the list, or use Save a copy to downloads to keep this one.`,
  );
  return true;
}

/**
 * Writes the project's `waypoints.json` when its waypoints have unsaved changes (issue #134), before
 * the auto, so a saved auto never follows a waypoint the saved file does not have. Resolves false,
 * with the reason on the status line, when they could not be written; the auto is then not saved
 * either.
 */
async function saveWaypoints(backend: ProjectBackend, fileName: string, summary: string | undefined): Promise<boolean> {
  const state = getState();
  const waypoints = state.project?.waypoints;
  if (!waypointsDirty(state) || waypoints === undefined) return true;
  try {
    if (backend.writeWaypoints === undefined) throw new ProjectError("This project cannot write waypoints.json.");
    await backend.writeWaypoints(waypoints, fileName, summary);
    markWaypointsSaved(waypoints);
    return true;
  } catch (error) {
    setStatus("error", `waypoints.json was not saved, so ${fileName} was not saved either: ${say(error)}`);
    return false;
  }
}

/**
 * Saves a copy, whatever the project's source: a download in a browser (the button the Playwright
 * smoke drives), the Save As dialog in the desktop app. The status line says what happened, and
 * nothing is claimed when the dialog was cancelled.
 */
export async function saveCopy(): Promise<void> {
  const { auto, fileName } = getState();
  if (auto === null) return;
  const name = fileName ?? "untitled.auto.json";
  try {
    const saved = await saveFileAs(name, canonicalize("auto", auto));
    if (saved === null) setStatus("info", "Save a copy cancelled. Nothing was saved.");
    else setStatus("ok", `${saved.how === "saved" ? "Saved" : "Downloaded"} ${saved.name}.`);
  } catch (error) {
    setStatus("error", `${name} was not saved: ${say(error)}`);
  }
}

/**
 * Re-runs the checks and focuses the findings panel. The checks themselves are already live, so what
 * the click adds is the answer (UI_GUIDE 9.15): "No problems found." or the counts, with the worst
 * problem opened.
 */
export async function validate(): Promise<void> {
  markValidated();
  showProblemsTab();
  const errors = document.querySelector<HTMLElement>("[data-findings-panel]");
  focusForInput(errors);
  const listed = sortFindings(problemsListed(currentDerived().findings));
  const counts = severityCounts(listed);
  const first = listed[0];
  if (first === undefined || counts.error + counts.warning === 0) {
    setStatus("ok", "No problems found.", counts.info === 0 ? undefined : `${counted(counts.info, "note", "notes")} in Problems.`);
    return;
  }
  const found = [counted(counts.error, "error", "errors"), counted(counts.warning, "warning", "warnings")].filter((part) => !part.startsWith("0 "));
  setStatus("info", `${found.join(" and ")}.`, `Opened the first ${first.severity}.`);
  // The panel's module is loaded only here, so opening a project does not wait for it.
  const { openFinding } = await import("../panels/FindingsPanel");
  openFinding(first);
}

/** "1 error", "3 warnings". */
const counted = (count: number, one: string, many: string): string => `${String(count)} ${count === 1 ? one : many}`;

/** `zenith.json.sim.command` with `{auto}` substituted, which is what Simulate offers to copy. */
export function simCommand(): string | null {
  const { project, fileName } = getState();
  const command = project?.link.sim?.command;
  if (command === undefined || fileName === null) return null;
  return command.replaceAll("{auto}", fileName.replace(/\.auto\.json$/, ""));
}

/** The path `zenith.json` says the sim writes its trace to. */
export function tracePath(): string | null {
  const { project, fileName } = getState();
  const trace = project?.link.sim?.trace;
  if (trace === undefined || fileName === null) return null;
  return trace.replaceAll("{auto}", fileName.replace(/\.auto\.json$/, ""));
}

/** What to do about a trace that cannot be read (UI_GUIDE section 9.19). */
const TRACE_AGAIN = "Run the sim again, then load the trace it writes.";

/**
 * Why a picked trace file did not load, as one sentence that names it and says what to do. The
 * parser's own words never appear; a trace's own problem is said in Zenith's words.
 */
export function traceFailureMessage(name: string, text: string, error: unknown): string {
  if (error instanceof SyntaxError) return unreadableJsonMessage(name, text, error, TRACE_AGAIN);
  if (error instanceof TraceError) {
    if (/must be a JSON object/.test(error.message)) return `${name} is not a sim trace. ${TRACE_AGAIN}`;
    const what = error.message.replace(/^A trace file /, "it ");
    return `${name} is a damaged sim trace: ${what.charAt(0).toLowerCase()}${what.slice(1)} ${TRACE_AGAIN}`;
  }
  return `${name} could not be read. ${TRACE_AGAIN}`;
}

/**
 * Loads a sim trace the person picked. Resolves to null when it loaded, or to the sentence about
 * why not, which the Simulate dialog shows beside its Load trace button: the dialog is in front of
 * the status line, so a failure said only there would be hidden behind it.
 */
export async function loadTraceFile(file: File): Promise<string | null> {
  let text = "";
  try {
    text = await file.text();
    setTrace(parseTrace(JSON.parse(text)));
    setStatus("ok", `Loaded ${file.name}.`);
    return null;
  } catch (error) {
    return traceFailureMessage(file.name, text, error);
  }
}
