/**
 * What the desktop app adds to the editor, as flows the shell can call: open a repository with the
 * native picker, reopen the last one, reload on external edits, and the three desktop actions —
 * High-fidelity sim, Deploy, and Commit / Push / Open PR (site/docs/editor.md). None of it runs in
 * a browser: every entry point returns early when `desktopBridge()` is null.
 *
 * The progress and results of those actions show in a small panel of their own (`desktopPanel.tsx`),
 * which this module mounts once, so the shell needs no new layout to host them. The shell can also
 * put the actions on its toolbar and palette: `DESKTOP_ACTIONS` below names each one.
 */
import { canonicalize, parseTrace, type Trace } from "@horizon36596/zenith-core";
import {
  getState,
  isDirty,
  openAuto,
  setBusy,
  setDialog,
  setPlayback,
  setPlaybackLevel,
  setPlaying,
  setStatus,
  setTrace,
  subscribeEditor,
  waypointsDirty,
  type State,
} from "../state/store";
import { countOf } from "../lib/format";
import { getSetting } from "../settings/registry";
import { effectiveSimSpeed, simSpeedLimit, type SimSpeed } from "../state/simSpeed";
import type { ProjectBackend } from "./backend";
import { DesktopBackend, desktopBridge } from "./desktop";
import { MENU_KEY_COMMAND } from "./desktopMenuKey";
import { StreamedTrace, settleTrace } from "./desktopTrace";
import { rememberCommit } from "../library/gitCommits";
import { isBetaNoticeOpen } from "../dialogs/betaNoticeState";
import type {
  DesktopDeployResult,
  DesktopFileChange,
  DesktopGitHubStatus,
  DesktopGitStatus,
  DesktopMenuCommand,
  DesktopProjectRef,
  DesktopSimEvent,
  ZenithDesktopBridge,
} from "./desktopBridge";

/**
 * How a project enters the editor: `adoptBackend` from app/projectActions.ts, passed in to keep the
 * import one-way. False when the first auto did not open cleanly; the status line says why.
 */
export type Adopt = (backend: ProjectBackend, preferredAuto?: string) => Promise<boolean>;

const say = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/* ---- The panel's state ---------------------------------------------------- */

export type SimPhase = "confirm" | "running" | "done" | "failed";
/** `confirm` asks to save unsaved edits first, as the sim does, because a deploy copies the files on disk. */
export type DeployPhase = "confirm" | "loading" | "preview" | "running" | "done" | "failed";

export type DesktopPanel =
  | { kind: "none" }
  | {
      kind: "sim";
      phase: SimPhase;
      fileName: string;
      runId: string | null;
      command: string;
      lines: string[];
      startedAt: number;
      message: string | null;
      tail: string[];
      elapsedS: number | null;
      /** How the run is made (`state/simSpeed.ts`); Basic for a project without a sim server. */
      speed: SimSpeed;
      /** What a sim-server run is doing before its rows arrive, or why it fell back to Basic. */
      status: string | null;
      /** How far a streamed run has got, in sim seconds, or null before its first rows. */
      receivedS: number | null;
      /** True when the run played a trace an Ultrafast background run had already made. */
      cached: boolean;
      /** True when the run ended because the person cancelled it, which is not a failure. */
      cancelled: boolean;
    }
  | { kind: "deploy"; phase: DeployPhase; result: DesktopDeployResult | null; message: string | null }
  | {
      kind: "git";
      fileName: string | null;
      status: DesktopGitStatus | null;
      github: DesktopGitHubStatus | null;
      busy: string | null;
      /** One line per step done, newest last. */
      log: string[];
      error: string | null;
      prUrl: string | null;
      /** The editor's saved text when `status` was read, so a later save counts as a change. */
      readAtSaved: string | null;
      /** Commit was pressed with unsaved edits: the panel asks to save first, as the sim does. */
      confirmCommit: boolean;
    };

const LINE_LIMIT = 400;

let panel: DesktopPanel = { kind: "none" };
const listeners = new Set<() => void>();

export const getPanel = (): DesktopPanel => panel;

export function subscribePanel(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function setPanel(next: DesktopPanel): void {
  panel = next;
  for (const listener of listeners) listener();
}

function patchPanel<K extends DesktopPanel["kind"]>(
  kind: K,
  patch: Partial<Extract<DesktopPanel, { kind: K }>>,
): void {
  if (panel.kind !== kind) return;
  setPanel({ ...panel, ...patch } as DesktopPanel);
}

/**
 * Whether the panel's close (its X and Esc) is offered now. A running sim or deploy keeps the panel,
 * because its own Cancel is the way out; a git step does not, since a push can wait on the network
 * for a long time and the step still reports on the status line once the panel is gone.
 */
export function panelClosable(current: DesktopPanel = panel): boolean {
  if (current.kind === "sim") return current.phase !== "running";
  if (current.kind === "deploy") return current.phase !== "running";
  return true;
}

export function closePanel(): void {
  if (!panelClosable()) return;
  setPanel({ kind: "none" });
}

/* ---- The panel's questions ------------------------------------------------ */

/**
 * A question the desktop module asks in a modal of its own (UI_GUIDE 9.14): one sentence, the
 * secondary choice on the left, which Esc picks, and the specific verb as the one primary on the
 * right. Used where the answer decides what happens to the person's work: closing while a sim or a
 * push runs, and a file that changed on disk under unsaved edits.
 */
export interface DesktopQuestion {
  title: string;
  text: string;
  /** The secondary button, and what Esc does. */
  cancel: string;
  /** The primary button. */
  confirm: string;
  testId: string;
}

let question: { ask: DesktopQuestion; resolve: (ok: boolean) => void } | null = null;

export const getQuestion = (): DesktopQuestion | null => question?.ask ?? null;

/** Shows the question and resolves true for the primary, false for the secondary or Esc. */
export function askDesktop(ask: DesktopQuestion): Promise<boolean> {
  // A second question replaces the first, whose caller is told no.
  question?.resolve(false);
  return new Promise((resolve) => {
    question = { ask, resolve };
    for (const listener of listeners) listener();
  });
}

export function answerQuestion(ok: boolean): void {
  const open = question;
  question = null;
  for (const listener of listeners) listener();
  open?.resolve(ok);
}

/** The git step running now, kept apart from the panel because it goes on after the panel is closed. */
let gitWork: string | null = null;

/**
 * What the desktop app is in the middle of, as a sentence, or null when nothing would be cut short by
 * closing the window: a sim, a deploy, or a commit, push or pull request.
 */
export function busyWork(current: DesktopPanel = panel): string | null {
  if (current.kind === "sim" && current.phase === "running") return "A sim is running. Closing Zenith stops it.";
  if (current.kind === "deploy" && current.phase === "running") return "A deploy is running. Closing Zenith now can leave it half written.";
  if (gitWork !== null) return `${gitWork} Closing Zenith now can leave it unfinished.`;
  return null;
}

/* ---- Where the open project is -------------------------------------------- */

function desktopContext(): { bridge: ZenithDesktopBridge; root: string } | null {
  const bridge = desktopBridge();
  const project = getState().project;
  if (bridge === null || project === null || project.source.kind !== "desktop") return null;
  return { bridge, root: project.source.root };
}

/**
 * An open that failed goes on the status line the way every other open's does: one the person
 * cancelled at the unsaved-edits question (QA-12) is information, anything else an error.
 */
async function reportOpen(error: unknown, folder: string | null = null): Promise<void> {
  const { reportOpenError } = await import("../app/projectActions");
  reportOpenError(error, "folder", folder);
}

/** Saves the open auto in place, as Save does, and says so. */
async function saveOpenAuto(): Promise<void> {
  const { backend, auto, fileName } = getState();
  if (backend === null || auto === null || fileName === null) return;
  const { save } = await import("../app/projectActions");
  await save();
}

/* ---- Opening ------------------------------------------------------------- */

let adoptRef: Adopt | null = null;

/**
 * The one line every way of opening a robot repository writes (the folder picker, File > Open
 * Recent, `zenith open`), with what saving does here as its quieter reason (UI_GUIDE 9.15).
 */
export function sayOpened(projectName: string, auto: string | null = null): void {
  setStatus(
    "ok",
    auto === null ? `Opened ${projectName}.` : `Opened ${auto} in ${projectName}.`,
    "Save writes in place, and edits made elsewhere reload by themselves.",
  );
}

async function adoptDesktop(ref: DesktopProjectRef, adopt: Adopt, preferredAuto?: string): Promise<boolean> {
  const bridge = desktopBridge();
  if (bridge === null) return false;
  return adopt(new DesktopBackend(bridge, ref), preferredAuto);
}

/** File > Open a folder, and the open-project dialog's button: the native folder picker. */
export async function openDesktopFolder(adopt: Adopt, options: { setUp?: boolean } = {}): Promise<void> {
  const bridge = desktopBridge();
  if (bridge === null) return;
  adoptRef = adopt;
  setBusy(true);
  let folder: string | null = null;
  try {
    const ref = await bridge.project.pick();
    if (ref === null) return;
    folder = ref.name;
    if (ref.needsSetup === true) {
      // A folder with no zenith.json yet: offer to set Zenith up there, rather than fail (issue #159).
      setDialog(null);
      const { offerDesktopSetup } = await import("../app/setupProject");
      await offerDesktopSetup(bridge, { root: ref.root, name: ref.name });
      return;
    }
    const opened = await adoptDesktop(ref, adopt);
    setDialog(null);
    // Set up Zenith on a folder that has zenith.json says it was set up already (issue #502).
    if (opened && options.setUp === true) setStatus("ok", `${ref.name} is already set up. Opened it.`);
    else if (opened) sayOpened(ref.name);
  } catch (error) {
    await reportOpen(error, folder);
  } finally {
    setBusy(false);
  }
}

export async function openRecentDesktopFolder(root: string, adopt: Adopt): Promise<boolean> {
  const bridge = desktopBridge();
  if (bridge === null) return false;
  try {
    const ref = await bridge.project.reopen(root);
    const opened = await adoptDesktop(ref, adopt);
    setDialog(null);
    if (opened) sayOpened(ref.name);
    return true;
  } catch (error) {
    await reportOpen(error);
    return false;
  }
}

let starting: Promise<boolean> | null = null;

/**
 * Called at start-up in the desktop app, in place of the browser's "reopen the last folder": wires
 * the native menu, file watching and sim progress to the editor, mounts the actions panel, and
 * reopens the most recent repository. Resolves true when a project was opened. Calling it again
 * (React runs start-up effects twice in development) returns the first call's promise.
 */
export function startDesktop(adopt: Adopt): Promise<boolean> {
  adoptRef = adopt;
  starting ??= startOnce(adopt);
  return starting;
}

async function startOnce(adopt: Adopt): Promise<boolean> {
  const bridge = desktopBridge();
  if (bridge === null) return false;
  bridge.onMenu((command) => {
    hearMenuCommand(command);
  });
  bridge.project.onChange((change) => {
    void onFileChanged(change);
  });
  bridge.sim.onEvent(onSimEvent);
  // The main process keeps the open project's sim server to the person's Full sim speed.
  startSimConfigure(bridge);
  // Closing the window or quitting with unsaved edits asks the same Save / Discard / Cancel question
  // as every other way of replacing the open auto (QA-12).
  bridge.onCloseRequest(() => {
    void answerCloseRequest(bridge);
  });
  // `zenith open` (issue #213): a folder asked for while the app runs opens when it arrives.
  bridge.openRequests?.onRequest(() => {
    void openRequested(bridge, adopt);
  });
  const { mountDesktopPanel } = await import("./desktopPanel");
  mountDesktopPanel();
  // The native menu follows the person's keys and switches, from now on (spec 15 section 8.5).
  const { startMenuKeys } = await import("./menuKeysSync");
  startMenuKeys(bridge);
  const opened = await openAtStart(bridge, adopt);
  // After a crash and Reload, the edits the main process kept come back as unsaved edits; from now
  // on it keeps the page's unsaved edits for the next one (desktopDraft.ts).
  const { restoreDraft, startDraftSync } = await import("./desktopDraft");
  await restoreDraft(bridge);
  startDraftSync(bridge);
  void announceUpdate(bridge);
  return opened;
}

/** How long an info line stays on the status bar before it clears itself (UI_GUIDE 9.15). */
const STATUS_LIFETIME_MS = 6000;

/**
 * Says once, at start-up, when a newer Zenith is out, and where the Help menu offers it. Exported
 * for tests.
 */
export async function announceUpdate(bridge: ZenithDesktopBridge): Promise<void> {
  const update = await bridge.updates?.check().catch(() => null);
  if (update === undefined || update === null) return;
  // Opening a project wrote its own line first; this one waits until the bar has cleared that one,
  // which it does by itself after 6 s (UI_GUIDE 9.15, `App.tsx`).
  const before = getState().status;
  window.setTimeout(() => {
    // A line written since, or an error or warning that stays until dismissed, is newer news.
    const now = getState().status;
    if (now !== null && (now !== before || now.kind === "error" || now.kind === "warn")) return;
    setStatus("info", `Zenith ${update.version} is out.`, `Help > Get Zenith ${update.version} opens the download page.`);
  }, STATUS_LIFETIME_MS);
}

/** Opens the folder `zenith open` asked for, or else the repository open last time. */
async function openAtStart(bridge: ZenithDesktopBridge, adopt: Adopt): Promise<boolean> {
  // A folder this launch was started for wins over the one open last time.
  if (await openRequested(bridge, adopt)) return true;
  if (getState().project !== null) return true;
  const recent = await bridge.project.recent().catch(() => []);
  const last = recent[0];
  if (last === undefined) return false;
  try {
    const ref = await bridge.project.reopen(last.root);
    await adoptDesktop(ref, adopt);
    return true;
  } catch (error) {
    // The main process has already taken the folder off the recent list; say so, or the project
    // the person had open last time is simply gone with no word about why.
    setStatus("error", `Could not reopen ${last.name} from last time, so it was taken off File > Open Recent. ${say(error)}`);
    return false;
  }
}

/**
 * Opens the folder `zenith open` asked for, when one is waiting (issue #213). The main process has
 * already checked it holds a `zenith.json` and granted it, so it opens like a recent folder, asking
 * first about unsaved edits as every open does. Resolves true when a request was taken.
 */
export async function openRequested(bridge: ZenithDesktopBridge, adopt: Adopt): Promise<boolean> {
  const request = await bridge.openRequests?.take().catch(() => null);
  if (request === undefined || request === null) return false;
  if ("error" in request) {
    setStatus("error", request.error);
    return true;
  }
  try {
    const opened = await adopt(new DesktopBackend(bridge, request.project), request.auto ?? undefined);
    setDialog(null);
    if (opened) sayOpened(request.project.name, request.auto ?? null);
  } catch (error) {
    await reportOpen(error);
  }
  return true;
}

/* ---- External edits ------------------------------------------------------ */

/**
 * A file in the open project changed on disk (the main process's watcher). Exported for its tests.
 */
export async function onFileChanged(change: DesktopFileChange): Promise<void> {
  const context = desktopContext();
  const { backend, project, fileName } = getState();
  if (context === null || project === null || change.root !== context.root || !(backend instanceof DesktopBackend)) return;
  const autoPrefix = `${project.link.autosDir.replace(/\/+$/, "")}/`;
  const changedAuto = change.path.startsWith(autoPrefix) ? change.path.slice(autoPrefix.length) : null;
  const dirty = isDirty();

  if (changedAuto !== null && changedAuto === fileName) {
    if (dirty) {
      await askAboutChangedAuto(backend, changedAuto);
      return;
    }
    try {
      const loaded = await backend.readAuto(changedAuto);
      // The read is a round trip to the main process; the person may have edited the auto or
      // opened another one meanwhile (issue #380). Reload only what is still open and unedited.
      const now = getState();
      if (now.backend !== backend || now.fileName !== changedAuto) return;
      if (isDirty()) {
        await askAboutChangedAuto(backend, changedAuto);
        return;
      }
      openAuto(loaded.fileName, loaded.auto, loaded.canonical);
      setStatus("info", `Reloaded ${changedAuto}: it changed on disk.`);
    } catch (error) {
      setStatus("error", `${changedAuto} changed on disk and could not be read: ${say(error)}`);
    }
    return;
  }

  // The link file, the robot, the field, the waypoints, or another auto appearing or going: reopen
  // the project so everything that depends on them is recomputed, keeping the open auto.
  const editedHere = (): void => {
    setStatus("info", `${change.path} changed on disk while you have unsaved edits here.`, "Save them, and the next change on disk reloads the project.");
  };
  if (dirty) {
    editedHere();
    return;
  }
  if (adoptRef === null) return;
  try {
    const reloaded = new DesktopBackend(context.bridge, backend.ref);
    const read = await reloaded.open();
    // The read is a round trip to the main process, like the auto's above (issue #394): reload only
    // the project that is still open, and only when nothing was edited meanwhile.
    if (getState().backend !== backend) return;
    if (isDirty()) {
      editedHere();
      return;
    }
    // Handed over already read, so the reload reads nothing more before it replaces the project.
    await adoptRef(reloaded.withProject(read), fileName ?? undefined);
    setStatus("info", `Reloaded ${backend.ref.name}: ${change.path} changed on disk.`);
  } catch (error) {
    setStatus("error", `${change.path} changed on disk and the project could not be reloaded: ${say(error)}`);
  }
}

/** Sets what reopens a project, as opening a folder does. For tests of the reload above. */
export function setAdoptForTests(adopt: Adopt | null): void {
  adoptRef = adopt;
}

/** The changed auto the question below is open for, so a second change event does not ask twice. */
let askingAbout: string | null = null;

/**
 * The open auto changed on disk while it has unsaved edits here: Reload from disk or Keep mine.
 * Keep mine is the secondary choice and what Esc does, since it loses
 * nothing; the next Save then writes over the other change, which the status line says.
 */
async function askAboutChangedAuto(backend: DesktopBackend, changedAuto: string): Promise<void> {
  if (askingAbout === changedAuto) return;
  askingAbout = changedAuto;
  let reload: boolean;
  try {
    reload = await askDesktop({
      title: `${changedAuto} changed on disk`,
      text: `Another program changed ${changedAuto} while you have unsaved edits here. Reload from disk drops your edits. Keep mine keeps them, and your next Save writes over the other change.`,
      cancel: "Keep mine",
      confirm: "Reload from disk",
      testId: "desktop-file-conflict",
    });
  } finally {
    askingAbout = null;
  }
  const still = (): boolean => getState().backend === backend && getState().fileName === changedAuto;
  if (!still()) return;
  if (!reload) {
    setStatus("info", `Kept your edits to ${changedAuto}.`, "Save writes over the change made on disk.");
    return;
  }
  try {
    const loaded = await backend.readAuto(changedAuto);
    // Asked again after the read: another auto may have been opened while it was in flight.
    if (!still()) return;
    openAuto(loaded.fileName, loaded.auto, loaded.canonical);
    setStatus("info", `Reloaded ${changedAuto} from disk. Your edits were dropped.`);
  } catch (error) {
    setStatus("error", `${changedAuto} could not be read from disk, so your edits are still here: ${say(error)}`);
  }
}

/**
 * True when the open auto cannot be saved in place: the bundled example, or files opened on their
 * own, whose Save in a browser is a download.
 */
export function savesOnlyACopy(state: Pick<State, "backend" | "project">): boolean {
  const source = state.project?.source.kind;
  return state.backend?.kind === "local" && (source === "example" || source === "files");
}

/**
 * The close question's Save for a read-only auto (sweep D4): the native Save As dialog, through
 * the bridge, so the close waits until the copy is on disk. A download would let the window close
 * before its own Save As dialog could be answered, and the edits would be gone.
 */
async function saveCopyBeforeClose(bridge: ZenithDesktopBridge): Promise<boolean> {
  const { auto, fileName } = getState();
  if (auto === null) return true;
  if (waypointsDirty()) {
    // A copy of the auto alone would leave the waypoint changes behind (issue #134).
    setStatus("info", "Your waypoint changes are saved only with the full project, so Zenith stayed open. Use Save, then Full project.");
    return false;
  }
  try {
    const saved = await bridge.saveCopy(fileName ?? "untitled.auto.json", canonicalize("auto", auto));
    if (saved === null) {
      setStatus("info", "The copy was not saved, so Zenith stayed open with your edits.");
      return false;
    }
    setStatus("ok", `Saved a copy as ${saved}.`);
    return true;
  } catch (error) {
    setStatus("error", `The copy could not be saved, so Zenith stayed open with your edits. ${say(error)}`);
    return false;
  }
}

/** Answers the desktop app's "may this window close?" with the Save, Discard, Cancel question. */
export async function answerCloseRequest(bridge: ZenithDesktopBridge): Promise<void> {
  let ok = false;
  try {
    // Work in progress is asked about first: closing would stop a sim or cut a push short, silently.
    const work = busyWork();
    if (
      work !== null &&
      !(await askDesktop({ title: "Close Zenith?", text: work, cancel: "Cancel", confirm: "Close anyway", testId: "desktop-close-busy" }))
    ) {
      return;
    }
    const { confirmReplace } = await import("../app/unsaved");
    ok = savesOnlyACopy(getState())
      ? await confirmReplace(
          "Closing Zenith now would lose them. This project is read only, so Save a copy… writes them to a file you choose.",
          { saveLabel: "Save a copy…", save: () => saveCopyBeforeClose(bridge) },
        )
      : await confirmReplace("Closing Zenith now would lose them.");
  } finally {
    await bridge.answerClose(ok);
  }
}

/* ---- High-fidelity sim --------------------------------------------------- */

/** Runs the robot repository's own sim for the open auto, and overlays its trace when it finishes. */
export async function runHighFidelitySim(options: { saveFirst?: boolean } = {}): Promise<void> {
  const context = desktopContext();
  const { fileName } = getState();
  if (context === null) {
    setStatus("error", "High-fidelity sim runs in a robot repository. Open yours first with File > Open a folder…");
    return;
  }
  if (fileName === null) {
    setStatus("error", "Open an auto first; the sim runs one auto at a time.");
    return;
  }
  if (panel.kind === "sim" && panel.phase === "running") return;
  const speed = currentSimSpeed(getState());
  // A faster speed chosen in Settings, but a project with no sim server: the panel says why it runs Basic.
  const limit = speed === "basic" && getSetting(getState().prefs, "sim.speed") !== "basic" ? simSpeedLimit(getState().project?.link) : null;
  const base = {
    kind: "sim" as const,
    fileName,
    runId: null,
    command: getState().project?.link.sim?.command ?? "",
    lines: [],
    startedAt: Date.now(),
    message: null,
    tail: [],
    elapsedS: null,
    speed,
    status: limit,
    receivedS: null,
    cached: false,
    cancelled: false,
  };
  if (isDirty()) {
    if (options.saveFirst !== true) {
      setPanel({ ...base, phase: "confirm" });
      return;
    }
    await saveOpenAuto();
    if (isDirty()) return;
  }
  setPanel({ ...base, phase: "running" });
  endStream(true);
  cancelWanted = false;
  try {
    const runId = await context.bridge.sim.start(context.root, fileName, { speed });
    patchPanel("sim", { runId });
    // Cancel pressed before the run had an id: it is cancelled now that it has one.
    if (cancelWanted) void cancelSim();
  } catch (error) {
    patchPanel("sim", { phase: "failed", message: say(error) });
  }
}

/** Cancel pressed while the run was still starting, before the main process gave it an id. */
let cancelWanted = false;

/** Robot > Cancel the sim, and the panel's Cancel the sim. Says so when there is nothing to cancel. */
export async function cancelSim(): Promise<void> {
  const bridge = desktopBridge();
  if (bridge === null) return;
  if (panel.kind !== "sim" || panel.phase !== "running") {
    setStatus("info", "No sim is running.");
    return;
  }
  if (panel.runId === null) {
    cancelWanted = true;
    return;
  }
  cancelWanted = false;
  await bridge.sim.cancel(panel.runId);
}

/**
 * The Full sim speed a run goes at: the person's choice, Basic for a project without a sim server,
 * and Basic while Full sim is switched off (nothing runs then, and nothing should stay warm).
 */
export function currentSimSpeed(state: Pick<State, "prefs" | "project">): SimSpeed {
  if (!state.prefs.features.fullSim) return "basic";
  return effectiveSimSpeed(getSetting(state.prefs, "sim.speed"), state.project?.link);
}

let configured: { root: string | null; speed: SimSpeed } | null = null;

/** Tells the main process the open project and the speed whenever either changes (`sim.configure`). */
function startSimConfigure(bridge: ZenithDesktopBridge): void {
  const configure = bridge.sim.configure;
  if (configure === undefined) return;
  const sync = (): void => {
    const state = getState();
    const root = state.project?.source.kind === "desktop" ? state.project.source.root : null;
    const speed = currentSimSpeed(state);
    if (configured !== null && configured.root === root && configured.speed === speed) return;
    configured = { root, speed };
    void configure.call(bridge.sim, root, speed).catch(() => undefined);
  };
  subscribeEditor(sync);
  sync();
}

/**
 * The streamed run being drawn, while a sim-server run sends its rows: the run it belongs to, the
 * trace so far, and the trace that was loaded before, which comes back if the run does not finish.
 */
let stream: { runId: string; trace: StreamedTrace; before: Trace | null } | null = null;

/** Ends the streamed run; `restore` puts back the trace that was loaded before it, stopped. */
function endStream(restore: boolean): void {
  if (stream === null) return;
  const before = stream.before;
  stream = null;
  if (!restore) return;
  setTrace(before);
  setPlaying(false);
}

/** Whether the open auto is still the one the sim panel runs; another one opened has its own trace. */
function onPanelFile(): boolean {
  return panel.kind === "sim" && getState().fileName === panel.fileName;
}

/** The streamed run's rows, drawn: the Full sim level plays them as they arrive. */
function drawStream(): void {
  if (stream === null) return;
  const settled = stream.trace.settled();
  setTrace(settled.trace, true);
  const last = settled.trace.poses[settled.trace.poses.length - 1];
  patchPanel("sim", { receivedS: last?.[0] ?? 0, status: null });
}

/** Plays the Full sim level from its start: a sim-server run plays as soon as it has rows. */
function playFullSim(): void {
  setPlaybackLevel("full");
  setPlayback(0);
  setPlaying(true);
}

/** Exported for its tests, which drive it with the events the main process sends. */
export function onSimEvent(event: DesktopSimEvent): void {
  if (panel.kind !== "sim") return;
  // Events can arrive before `sim.start` resolves with the run id, so adopt the first one seen.
  if (panel.runId !== null && event.runId !== panel.runId) return;
  if (panel.runId === null) {
    patchPanel("sim", { runId: event.runId });
    if (cancelWanted && panel.kind === "sim" && panel.phase === "running") void cancelSim();
  }
  if (panel.kind !== "sim") return;
  // The run has ended here already: a batch that could not be read failed it and asked main to
  // cancel. Main's answer to that cancel, or a done that crossed it, must not replace the reason.
  if (panel.phase !== "running") return;
  // Rows of an earlier run are never drawn over this one.
  if (stream !== null && stream.runId !== event.runId) endStream(true);
  // Another auto was opened while the run streamed: its rows, and the trace from before, are not that auto's.
  if (stream !== null && !onPanelFile()) endStream(false);
  switch (event.kind) {
    case "started":
      patchPanel("sim", { command: event.command, ...(event.speed === undefined ? {} : { speed: event.speed }) });
      break;
    case "line": {
      const lines = [...panel.lines, event.text];
      patchPanel("sim", { lines: lines.length > LINE_LIMIT ? lines.slice(-LINE_LIMIT) : lines });
      break;
    }
    case "status":
      if (event.status === "fallback") {
        // The server gave up on this run; the sim command runs it from the start, so its rows are void.
        endStream(true);
        patchPanel("sim", { speed: "basic", status: event.message, receivedS: null });
        setStatus("info", event.message);
      } else {
        patchPanel("sim", { status: event.message });
      }
      break;
    case "traceStart":
      if (!onPanelFile()) break;
      try {
        const before = stream?.before ?? getState().trace;
        stream = { runId: event.runId, trace: new StreamedTrace(event.header), before };
        drawStream();
        playFullSim();
      } catch (error) {
        failStream(`The sim server's trace could not be read: ${say(error)}`);
      }
      break;
    case "rows":
      if (stream === null) break;
      try {
        stream.trace.append(event.rows);
        drawStream();
      } catch (error) {
        failStream(`The sim server's trace could not be read: ${say(error)}`);
      }
      break;
    case "done":
      try {
        {
          // A pose the localizer overwrote would otherwise draw a line the robot never drove.
          const settled = settleTrace(parseTrace(event.trace));
          endStream(false);
          // Another auto opened while it ran keeps its own trace; the panel still has the result.
          const drawn = onPanelFile();
          if (drawn) {
            setTrace(settled.trace);
            if (event.cached === true) playFullSim();
          }
          // A Basic run keeps the line that says why it ran Basic; a server run's progress line is done with.
          patchPanel("sim", {
            phase: "done",
            elapsedS: event.elapsedS,
            cached: event.cached === true,
            status: panel.kind === "sim" && panel.speed === "basic" ? panel.status : null,
          });
          const jumps =
            settled.resets.length === 0
              ? ""
              : ` Its pose jumps ${countOf(settled.resets.length, "time")} mid-run, where the sim's localizer was reset.`;
          const where = drawn ? "Its path is drawn over the plan." : `Open ${panel.fileName} and run it again to see its path.`;
          setStatus(
            settled.resets.length === 0 ? "ok" : "info",
            event.cached === true
              ? `Played the full sim run made when ${panel.fileName} was last saved. ${where}${jumps}`
              : `High-fidelity sim finished in ${event.elapsedS.toFixed(0)} s. ${where}${jumps}`,
          );
        }
      } catch (error) {
        endStream(true);
        patchPanel("sim", { phase: "failed", message: `The trace could not be read: ${say(error)}` });
      }
      break;
    case "failed":
      endStream(true);
      cancelWanted = false;
      patchPanel("sim", { phase: "failed", message: event.message, tail: event.tail, cancelled: event.cancelled === true });
      // A cancel is the person's own choice: a plain line, not an error (UI_GUIDE 9.15).
      if (event.cancelled === true) setStatus("info", "Sim cancelled.");
      else setStatus("error", "High-fidelity sim did not finish. The sim panel says why.");
      break;
  }
}

/** A streamed run whose rows cannot be read: stop it, and put the earlier trace back. */
function failStream(message: string): void {
  const runId = panel.kind === "sim" ? panel.runId : null;
  endStream(true);
  patchPanel("sim", { phase: "failed", message });
  if (runId !== null) void desktopBridge()?.sim.cancel(runId).catch(() => undefined);
}

/** Forgets the streamed run and the speed last sent, for tests. */
export function resetSimStateForTests(): void {
  stream = null;
  configured = null;
  cancelWanted = false;
}

/* ---- Deploy -------------------------------------------------------------- */

/**
 * Shows what a deploy would change, from a dry run; `confirmDeploy` then writes it. With unsaved
 * edits it first asks to save, as the sim does, because a deploy copies the files on disk: nothing
 * is written before the person says so (`saveFirst` is that answer).
 */
export async function deployAutos(options: { saveFirst?: boolean } = {}): Promise<void> {
  const context = desktopContext();
  if (context === null) {
    setStatus("error", "Deploy writes into a robot repository. Open yours first with File > Open a folder…");
    return;
  }
  if (panel.kind === "deploy" && panel.phase === "running") return;
  if (isDirty()) {
    if (options.saveFirst !== true) {
      setPanel({ kind: "deploy", phase: "confirm", result: null, message: null });
      return;
    }
    await saveOpenAuto();
    if (isDirty()) return;
  }
  setPanel({ kind: "deploy", phase: "loading", result: null, message: null });
  try {
    const result = await context.bridge.deploy.run(context.root, { dryRun: true });
    patchPanel("deploy", { phase: "preview", result });
  } catch (error) {
    patchPanel("deploy", { phase: "failed", message: say(error) });
  }
}

export async function confirmDeploy(): Promise<void> {
  const context = desktopContext();
  if (context === null || panel.kind !== "deploy") return;
  patchPanel("deploy", { phase: "running" });
  try {
    const result = await context.bridge.deploy.run(context.root, { dryRun: false });
    patchPanel("deploy", { phase: "done", result });
    // A deploy that skipped autos still deployed the rest: a warning with the next step, not an error.
    if (result.errors === 0) {
      setStatus("ok", `Deployed into ${result.deployDir}: ${countOf(result.changed, "file")} changed.`, "Check the changes in git.");
    } else {
      setStatus(
        "warn",
        `Deployed into ${result.deployDir}, but skipped ${countOf(result.errors, "auto")} with errors.`,
        `Open ${result.errors === 1 ? "it" : "each one"} and see Problems, then deploy again.`,
      );
    }
  } catch (error) {
    patchPanel("deploy", { phase: "failed", message: say(error) });
    setStatus("error", "The deploy did not finish. The deploy panel says why.");
  }
}

/* ---- Git ----------------------------------------------------------------- */

type GitPanel = Extract<DesktopPanel, { kind: "git" }>;

/** Opens the git panel with the branch, the changed autos and who GitHub thinks you are. */
export async function openGitPanel(): Promise<void> {
  const context = desktopContext();
  if (context === null) {
    setStatus("error", "Commit and push work in a robot repository. Open yours first with File > Open a folder…");
    return;
  }
  const fileName = getState().fileName;
  setPanel({
    kind: "git",
    fileName,
    status: null,
    github: null,
    busy: "Reading the repository…",
    log: [],
    error: null,
    prUrl: null,
    readAtSaved: getState().savedCanonical,
    confirmCommit: false,
  });
  await refreshGit();
}

async function refreshGit(): Promise<void> {
  const context = desktopContext();
  if (context === null || panel.kind !== "git") return;
  const readAtSaved = getState().savedCanonical;
  try {
    const [status, github] = await Promise.all([
      context.bridge.git.status(context.root, panel.fileName),
      context.bridge.github.status(),
    ]);
    patchPanel("git", { status, github, busy: null, readAtSaved });
  } catch (error) {
    patchPanel("git", { busy: null, error: say(error) });
  }
}

/** The panel's Check again: reads the repository and the GitHub sign-in afresh. */
export async function checkGitAgain(): Promise<void> {
  if (panel.kind !== "git" || panel.busy !== null) return;
  patchPanel("git", { busy: "Reading the repository…", error: null });
  await refreshGit();
}

/** Reads the GitHub sign-in again, after the sign-in dialog signed in or out. */
export async function refreshGitHub(): Promise<void> {
  const bridge = desktopBridge();
  if (bridge === null || panel.kind !== "git") return;
  try {
    const github = await bridge.github.status();
    patchPanel("git", { github });
  } catch {
    // The row keeps what it showed; the next step that needs GitHub says what is wrong.
  }
}

/**
 * Runs one git step. Its line goes in the panel's log, and on the status line as well when the panel
 * was closed while it ran, so a push that ends after the panel is gone still says how it went.
 */
async function gitStep(
  label: string,
  work: string,
  step: (context: { bridge: ZenithDesktopBridge; root: string }) => Promise<string>,
): Promise<boolean> {
  const context = desktopContext();
  if (context === null || panel.kind !== "git") return false;
  patchPanel("git", { busy: label, error: null, confirmCommit: false });
  gitWork = work;
  try {
    const line = await step(context);
    if (panel.kind === "git") patchPanel("git", { log: [...panel.log, line], busy: null });
    else setStatus("ok", line);
    await refreshGit();
    return true;
  } catch (error) {
    if (panel.kind === "git") patchPanel("git", { busy: null, error: say(error) });
    else setStatus("error", say(error));
    await refreshGit();
    return false;
  } finally {
    gitWork = null;
  }
}

/**
 * Why Commit cannot run for the git panel's auto, or null when it can (sweep D8). With the auto the
 * same as in the last commit, a commit would hold only its render, so the panel says "Nothing to
 * commit" instead of offering one. Unsaved edits, or a save since the status was read, count as a
 * change: Commit saves first, and the main process checks again before it commits.
 */
export function commitBlockedReason(
  git: GitPanel,
  state: Pick<State, "auto" | "fileName" | "savedCanonical">,
): string | null {
  if (git.fileName === null) return "Open an auto to commit it.";
  const status = git.status;
  if (status === null || !status.isRepo) return null;
  const editing = state.fileName === git.fileName;
  const unsaved = state.auto !== null && canonicalize("auto", state.auto) !== state.savedCanonical;
  if (editing && (unsaved || state.savedCanonical !== git.readAtSaved)) return null;
  const changed = status.changedAutos.some((file) => file.path.split("/").pop() === git.fileName);
  return changed ? null : `Nothing to commit: ${git.fileName} is the same as in the last commit.`;
}

/** The git panel's three buttons: why each one is off (null when it is on), and which is the next step. */
export interface GitButtons {
  commit: string | null;
  push: string | null;
  pr: string | null;
  /** The one primary button: the next step, Commit, then Open pull request, then Push. */
  primary: "commit" | "push" | "pr";
}

/**
 * Works out the git panel's buttons from what it knows (UI_GUIDE 9.9): each disabled one has a
 * reason the panel shows under the row, and the primary follows the next step rather than always
 * being Open pull request. Exported for its test.
 */
export function gitButtons(git: GitPanel, state: Pick<State, "auto" | "fileName" | "savedCanonical">): GitButtons {
  const status = git.status;
  if (status === null || !status.isRepo) {
    const why = status === null ? "Zenith is still reading the repository." : "This folder is not a git repository.";
    return { commit: why, push: why, pr: why, primary: "pr" };
  }
  const commit = commitBlockedReason(git, state);
  const branch = status.branch;
  const pushWhy =
    branch === null
      ? "The repository is not on a branch (HEAD is detached). Switch to a branch first."
      : status.onBase
        ? `You are on ${status.base}, the base branch, which Zenith never pushes. Commit first; it moves your work to its own branch.`
        : !status.hasRemote
          ? "This repository has no remote called origin, so there is nowhere to push."
          : null;
  const push = pushWhy ?? (status.ahead === 0 ? `${branch ?? "This branch"} is already pushed: there is nothing new to push.` : null);
  const pr =
    git.fileName === null
      ? "Open an auto to open a pull request for it."
      : (pushWhy ??
        (commit === null
          ? `Commit ${git.fileName} first: a pull request holds only commits.`
          : git.github !== null && git.github.source === null
            ? "Sign in to GitHub to open the pull request."
            : null));
  const primary = commit === null ? "commit" : pr === null ? "pr" : push === null ? "push" : "pr";
  return { commit, push, pr, primary };
}

/**
 * Commit, from the git panel. With unsaved edits it asks first, as the sim and deploy do, because a
 * commit takes the file on disk; `saveFirst` is the person's yes.
 */
export async function commitAuto(summary: string, options: { saveFirst?: boolean } = {}): Promise<boolean> {
  if (panel.kind !== "git" || panel.fileName === null) return false;
  const fileName = panel.fileName;
  if (isDirty() && getState().fileName === fileName) {
    if (options.saveFirst !== true) {
      patchPanel("git", { confirmCommit: true });
      return false;
    }
    await saveOpenAuto();
    if (isDirty()) return false;
  }
  return gitStep("Committing…", "A commit is running.", async ({ bridge, root }) => {
    const result = await bridge.git.commit(root, { fileName, summary });
    // The commit holds the file as saved, which is the editor's saved text while it is open.
    const saved = getState();
    if (saved.fileName === fileName && saved.savedCanonical !== null) rememberCommit(fileName, saved.savedCanonical, result.sha);
    return `${result.createdBranch ? `Created ${result.branch}. ` : ""}Committed ${result.sha.slice(0, 7)} on ${result.branch}: ${result.message}`;
  });
}

/** The commit question's Cancel: nothing is saved or committed. */
export function cancelCommit(): void {
  patchPanel("git", { confirmCommit: false });
}

export async function pushBranch(): Promise<boolean> {
  return gitStep("Pushing…", "A push is running.", async ({ bridge, root }) => {
    const result = await bridge.git.push(root);
    return `Pushed ${result.branch} to ${result.remote}.`;
  });
}

export async function openPullRequest(): Promise<boolean> {
  if (panel.kind !== "git" || panel.fileName === null) return false;
  const fileName = panel.fileName;
  return gitStep("Pushing the branch and opening the pull request…", "A pull request is being opened.", async ({ bridge, root }) => {
    const result = await bridge.git.openPullRequest(root, { fileName });
    patchPanel("git", { prUrl: result.url });
    return `${result.created ? "Opened" : "Updated"} pull request #${String(result.number)}.`;
  });
}

/**
 * The git panel's Sign in to GitHub: the same dialog as the toolbar's, so there is one sign-in. In
 * the desktop app the dialog hands a pasted token to the main process too (github/actions.ts), which
 * is what Open pull request uses.
 */
export function signInFromGitPanel(): void {
  setDialog("signIn");
}

/** The git panel's Sign out: the toolbar's sign-out, which also forgets the token the main process kept. */
export async function signOutFromGitPanel(): Promise<void> {
  const { signOutOfGitHub } = await import("../github/actions");
  await signOutOfGitHub();
}

/* ---- The native menu ----------------------------------------------------- */

/** The desktop actions, for the shell's toolbar and palette. Each is a no-op outside the desktop app. */
export const DESKTOP_ACTIONS = [
  { id: "desktop.sim", label: "Run high-fidelity sim", run: () => runHighFidelitySim() },
  { id: "desktop.deploy", label: "Deploy autos into the robot repo", run: () => deployAutos() },
  { id: "desktop.git", label: "Commit, push and open a pull request", run: () => openGitPanel() },
] as const;

/**
 * Opens the native menu under the title bar's menu button, as a click on it does: F10 and the
 * click put it in the same place (desktopPanel.tsx draws the button).
 */
export function openMenuAtButton(): void {
  const bridge = desktopBridge();
  const button = document.querySelector<HTMLElement>("[data-desktop-menu-button]");
  if (bridge === null || button === null) return;
  const rect = button.getBoundingClientRect();
  void bridge.showMenu(rect.left, rect.bottom);
}

/**
 * A native menu command as it arrives over IPC. While the beta notice is open it does nothing, as a
 * key does nothing behind it (`app/useKeyboard.ts`): the notice comes first and alone, so Help's
 * tour, Open or Settings never start under it. Closing the window is not a menu command and still
 * works. Returns whether the command ran.
 */
export function hearMenuCommand(command: DesktopMenuCommand, run: (command: DesktopMenuCommand) => Promise<void> = runMenuCommand): boolean {
  // F10 only opens the menu, which is no more than a click on its button, so it works behind the notice too.
  if (command.action === MENU_KEY_COMMAND) {
    openMenuAtButton();
    return true;
  }
  if (isBetaNoticeOpen()) return false;
  void run(command);
  return true;
}

async function runMenuCommand(command: DesktopMenuCommand): Promise<void> {
  switch (command.action) {
    case "desktop.sim":
      // The native menu leaves the item out while Full sim is switched off (issue #207); this covers a stray command.
      if (!getState().prefs.features.fullSim) return;
      return runHighFidelitySim();
    case "desktop.simCancel":
      return cancelSim();
    case "desktop.deploy":
      return deployAutos();
    case "desktop.git":
      return openGitPanel();
    case "desktop.openRecent":
      if (command.arg !== undefined && adoptRef !== null) await openRecentDesktopFolder(command.arg, adoptRef);
      return;
    default:
      break;
  }
  // Everything else is one of the web build's own actions, so the menu runs exactly what the
  // toolbar, palette and shortcuts run. Loaded on demand to keep this module's imports one-way.
  const { actionById, isEnabled } = await import("../app/actions");
  const action = actionById(command.action);
  if (action === undefined) {
    setStatus("error", `The menu item "${command.action}" is not available in this build.`);
    return;
  }
  const { actionShown, getFeatures } = await import("../state/features");
  if (!actionShown(action.id, getFeatures())) {
    setStatus("info", `${action.label} is part of a feature that is off. Turn it on in Settings, General.`);
    return;
  }
  if (!isEnabled(action, getState())) {
    setStatus("info", action.hint?.(getState()) ?? `${action.label} is not available right now.`);
    return;
  }
  await action.run();
}
