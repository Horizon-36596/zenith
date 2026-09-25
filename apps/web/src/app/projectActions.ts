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
import { downloadText, projectFromFiles, projectFromZip } from "../project/fallback";
import { forgetDirectory, recallDirectory, rememberDirectory } from "../project/idb";
import { ProjectError, ensureWritable, loadProjectFromDirectory, pickDirectory } from "../project/local";
import { resolveAutoOverrides } from "../project/overrides";
import { openDesktopFolder, startDesktop } from "../project/desktopActions";
import { isDesktop } from "../project/desktop";
import { KeptUnsavedEdits, confirmReplace, requireReplace } from "./unsaved";
import { parseTrace } from "@horizon36596/zenith-core";
import {
  getState,
  markSaved,
  markValidated,
  openAuto,
  openProject,
  setAutoOverrides,
  setBusy,
  setDialog,
  setStatus,
  setTrace,
} from "../state/store";

export const say = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Puts a failed open on the status line; an open the person cancelled is not an error. */
export function reportOpenError(error: unknown): void {
  setStatus(error instanceof KeptUnsavedEdits ? "info" : "error", say(error));
}

/**
 * The one way a project enters the editor: open the backend, put it and its project in the store,
 * and open an auto. GitHub mode calls this with its own backend. `preferredAuto` opens that file
 * instead of `autoFiles[0]` when the project carries it, which is how `loadExample` picks the
 * richer of the two bundled autos rather than whichever sorts first; every other caller leaves it
 * unset and gets the alphabetically-first file, same as before.
 *
 * The project is read before anything is replaced, so a folder that fails to open costs nothing.
 * Then, when the open auto has unsaved edits, the person is asked (QA-12); on Cancel this throws
 * `KeptUnsavedEdits` and the old project stays. `next` is what the question says will happen.
 */
export async function adoptBackend(
  backend: ProjectBackend,
  preferredAuto?: string,
  next = "Opening another project will close it.",
): Promise<void> {
  const project = await backend.open();
  await requireReplace(next);
  openProject(project, backend);
  const first =
    preferredAuto !== undefined && project.autoFiles.includes(preferredAuto)
      ? preferredAuto
      : project.autoFiles[0];
  if (first !== undefined) await loadAutoNamed(first);
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
  try {
    await adoptBackend(
      LocalBackend.of(loadExampleProject()),
      "collect-and-score.auto.json",
      "Opening the example will close it.",
    );
    setDialog(null);
    setStatus("info", "Loaded the bundled example. Save downloads a copy; it is read only.");
  } catch (error) {
    reportOpenError(error);
  } finally {
    setBusy(false);
  }
}

export async function openFolder(): Promise<void> {
  if (isDesktop()) return openDesktopFolder(adoptBackend);
  setBusy(true);
  try {
    const handle = await pickDirectory();
    if (handle === null) return;
    await adoptDirectory(handle);
  } catch (error) {
    reportOpenError(error);
  } finally {
    setBusy(false);
  }
}

async function adoptDirectory(handle: FileSystemDirectoryHandle): Promise<void> {
  if (!(await ensureWritable(handle))) {
    throw new ProjectError("Zenith needs permission to write into that folder to save autos.");
  }
  await adoptBackend(
    new LocalBackend(() => loadProjectFromDirectory(handle)),
    undefined,
    `Opening ${handle.name} will close it.`,
  );
  await rememberDirectory(handle);
  setDialog(null);
  setStatus("ok", `Opened ${getState().project?.name ?? handle.name}.`);
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
    await adoptBackend(
      new LocalBackend(async () =>
        zip === undefined ? projectFromFiles(files) : projectFromZip(zip),
      ),
      undefined,
      "Opening those files will close it.",
    );
    setDialog(null);
    setStatus("info", "Opened from files. Save downloads the canonical file.");
  } catch (error) {
    reportOpenError(error);
  } finally {
    setBusy(false);
  }
}

/** Switches to another auto in the open project, asking first when this one has unsaved edits. */
export async function openAutoNamed(fileName: string): Promise<void> {
  const current = getState().fileName;
  const next =
    current === fileName
      ? `Opening ${fileName} again will put back the saved version.`
      : `Opening ${fileName} will replace it.`;
  if (!(await confirmReplace(next))) {
    setStatus("info", `Kept the unsaved edits in ${current ?? "this auto"}.`);
    return;
  }
  await loadAutoNamed(fileName);
}

/** Reads an auto and opens it, with no question: the caller has already asked. */
async function loadAutoNamed(fileName: string): Promise<void> {
  const backend = getState().backend;
  const project = getState().project;
  if (backend === null || project === null) return;
  try {
    const loaded = await backend.readAuto(fileName);
    openAuto(loaded.fileName, loaded.auto, loaded.canonical);
    // openAuto already set autoRobot/autoField to the project's own, synchronously; this resolves
    // auto.robot/auto.field (finding 23) and replaces them once that read comes back.
    const overrides = await resolveAutoOverrides(project, backend, loaded.auto);
    if (getState().fileName !== loaded.fileName) return; // a second open beat this one to it
    setAutoOverrides(overrides.robot, overrides.field);
    if (overrides.error !== null) setStatus("error", overrides.error);
  } catch (error) {
    setStatus("error", say(error));
  }
}

/** Writes the canonical file wherever the backend puts it: in place, a download, or a commit. */
export async function save(summary?: string): Promise<void> {
  const { backend, auto, fileName } = getState();
  if (backend === null || auto === null || fileName === null) return;
  setBusy(true);
  try {
    const result = await backend.save(fileName, canonicalize("auto", auto), summary);
    markSaved(result.text);
    if (result.note !== undefined) setStatus("info", result.note);
  } catch (error) {
    setStatus("error", say(error));
  } finally {
    setBusy(false);
  }
}

/** Always downloads, whatever the project's source: the button the Playwright smoke drives. */
export function saveCopy(): void {
  const { auto, fileName } = getState();
  if (auto === null) return;
  downloadText(fileName ?? "untitled.auto.json", canonicalize("auto", auto));
}

/** Re-runs the checks and focuses the findings panel. The checks themselves are already live. */
export function validate(): void {
  markValidated();
  const errors = document.querySelector<HTMLElement>("[data-findings-panel]");
  errors?.focus();
}

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

export async function loadTraceFile(file: File): Promise<void> {
  try {
    setTrace(parseTrace(JSON.parse(await file.text())));
    setStatus("ok", `Loaded ${file.name}.`);
  } catch (error) {
    setStatus("error", say(error));
  }
}
