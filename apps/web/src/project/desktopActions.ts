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
import { parseTrace } from "@horizon36596/zenith-core";
import { getState, isDirty, openAuto, setBusy, setDialog, setStatus, setTrace } from "../state/store";
import type { ProjectBackend } from "./backend";
import { DesktopBackend, desktopBridge } from "./desktop";
import { settleTrace } from "./desktopTrace";
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

/** How a project enters the editor: `adoptBackend` from app/projectActions.ts, passed in to keep the import one-way. */
export type Adopt = (backend: ProjectBackend, preferredAuto?: string) => Promise<void>;

const say = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/* ---- The panel's state ---------------------------------------------------- */

export type SimPhase = "confirm" | "running" | "done" | "failed";
export type DeployPhase = "loading" | "preview" | "running" | "done" | "failed";

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

export function closePanel(): void {
  if (panel.kind === "sim" && panel.phase === "running") return;
  setPanel({ kind: "none" });
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
async function reportOpen(error: unknown): Promise<void> {
  const { reportOpenError } = await import("../app/projectActions");
  reportOpenError(error);
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

async function adoptDesktop(ref: DesktopProjectRef, adopt: Adopt, preferredAuto?: string): Promise<void> {
  const bridge = desktopBridge();
  if (bridge === null) return;
  await adopt(new DesktopBackend(bridge, ref), preferredAuto);
}

/** File > Open robot repo, and the open-project dialog's button: the native folder picker. */
export async function openDesktopFolder(adopt: Adopt): Promise<void> {
  const bridge = desktopBridge();
  if (bridge === null) return;
  adoptRef = adopt;
  setBusy(true);
  try {
    const ref = await bridge.project.pick();
    if (ref === null) return;
    await adoptDesktop(ref, adopt);
    setDialog(null);
    setStatus("ok", `Opened ${ref.name}. Save writes in place; edits made elsewhere reload by themselves.`);
  } catch (error) {
    await reportOpen(error);
  } finally {
    setBusy(false);
  }
}

export async function openRecentDesktopFolder(root: string, adopt: Adopt): Promise<boolean> {
  const bridge = desktopBridge();
  if (bridge === null) return false;
  try {
    const ref = await bridge.project.reopen(root);
    await adoptDesktop(ref, adopt);
    setDialog(null);
    setStatus("ok", `Opened ${ref.name}.`);
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
    void runMenuCommand(command);
  });
  bridge.project.onChange((change) => {
    void onFileChanged(change);
  });
  bridge.sim.onEvent(onSimEvent);
  // Closing the window or quitting with unsaved edits asks the same Save / Discard / Cancel question
  // as every other way of replacing the open auto (QA-12).
  bridge.onCloseRequest(() => {
    void answerCloseRequest(bridge);
  });
  const { mountDesktopPanel } = await import("./desktopPanel");
  mountDesktopPanel();
  if (getState().project !== null) return true;
  const recent = await bridge.project.recent().catch(() => []);
  const last = recent[0];
  if (last === undefined) return false;
  try {
    const ref = await bridge.project.reopen(last.root);
    await adoptDesktop(ref, adopt);
    return true;
  } catch {
    return false;
  }
}

/* ---- External edits ------------------------------------------------------ */

async function onFileChanged(change: DesktopFileChange): Promise<void> {
  const context = desktopContext();
  const { backend, project, fileName } = getState();
  if (context === null || project === null || change.root !== context.root || !(backend instanceof DesktopBackend)) return;
  const autoPrefix = `${project.link.autosDir.replace(/\/+$/, "")}/`;
  const changedAuto = change.path.startsWith(autoPrefix) ? change.path.slice(autoPrefix.length) : null;
  const dirty = isDirty();

  if (changedAuto !== null && changedAuto === fileName) {
    if (dirty) {
      setStatus("error", `${changedAuto} changed on disk while you have unsaved edits here. Saving now would overwrite the other change.`);
      return;
    }
    try {
      const loaded = await backend.readAuto(changedAuto);
      openAuto(loaded.fileName, loaded.auto, loaded.canonical);
      setStatus("info", `${changedAuto} changed on disk and was reloaded.`);
    } catch (error) {
      setStatus("error", `${changedAuto} changed on disk and could not be read: ${say(error)}`);
    }
    return;
  }

  // The link file, the robot, the field, the waypoints, or another auto appearing or going: reopen
  // the project so everything that depends on them is recomputed, keeping the open auto.
  if (dirty) {
    setStatus("info", `${change.path} changed on disk. Save your edits, and Zenith will pick the change up on the next one.`);
    return;
  }
  if (adoptRef === null) return;
  try {
    await adoptRef(new DesktopBackend(context.bridge, backend.ref), fileName ?? undefined);
    setStatus("info", `${change.path} changed on disk, so the project was reloaded.`);
  } catch (error) {
    setStatus("error", `${change.path} changed on disk and the project could not be reloaded: ${say(error)}`);
  }
}

async function answerCloseRequest(bridge: ZenithDesktopBridge): Promise<void> {
  let ok = false;
  try {
    const { confirmReplace } = await import("../app/unsaved");
    ok = await confirmReplace("Closing Zenith now would lose them.");
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
    setStatus("error", "High-fidelity sim needs a robot repository opened in the desktop app.");
    return;
  }
  if (fileName === null) {
    setStatus("error", "Open an auto first; the sim runs one auto at a time.");
    return;
  }
  if (panel.kind === "sim" && panel.phase === "running") return;
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
  try {
    const runId = await context.bridge.sim.start(context.root, fileName);
    patchPanel("sim", { runId });
  } catch (error) {
    patchPanel("sim", { phase: "failed", message: say(error) });
  }
}

export async function cancelSim(): Promise<void> {
  const bridge = desktopBridge();
  if (bridge === null || panel.kind !== "sim" || panel.runId === null || panel.phase !== "running") return;
  await bridge.sim.cancel(panel.runId);
}

function onSimEvent(event: DesktopSimEvent): void {
  if (panel.kind !== "sim") return;
  // Events can arrive before `sim.start` resolves with the run id, so adopt the first one seen.
  if (panel.runId !== null && event.runId !== panel.runId) return;
  if (panel.runId === null) patchPanel("sim", { runId: event.runId });
  if (panel.kind !== "sim") return;
  switch (event.kind) {
    case "started":
      patchPanel("sim", { command: event.command });
      break;
    case "line": {
      const lines = [...panel.lines, event.text];
      patchPanel("sim", { lines: lines.length > LINE_LIMIT ? lines.slice(-LINE_LIMIT) : lines });
      break;
    }
    case "done":
      try {
        {
          // A pose the localizer overwrote would otherwise draw a line the robot never drove.
          const settled = settleTrace(parseTrace(event.trace));
          setTrace(settled.trace);
          patchPanel("sim", { phase: "done", elapsedS: event.elapsedS });
          const jumps =
            settled.resets.length === 0
              ? ""
              : ` Its pose jumps ${String(settled.resets.length)} time(s) mid-run, where the sim's localizer was reset.`;
          setStatus(
            settled.resets.length === 0 ? "ok" : "info",
            `High-fidelity sim finished in ${event.elapsedS.toFixed(0)} s. Its path is drawn over the plan.${jumps}`,
          );
        }
      } catch (error) {
        patchPanel("sim", { phase: "failed", message: `The trace could not be read: ${say(error)}` });
      }
      break;
    case "failed":
      patchPanel("sim", { phase: "failed", message: event.message, tail: event.tail });
      if (!event.cancelled) setStatus("error", "High-fidelity sim did not finish. The sim panel says why.");
      break;
  }
}

/* ---- Deploy -------------------------------------------------------------- */

/** Shows what a deploy would change, from a dry run; `confirmDeploy` then writes it. */
export async function deployAutos(): Promise<void> {
  const context = desktopContext();
  if (context === null) {
    setStatus("error", "Deploy needs a robot repository opened in the desktop app.");
    return;
  }
  if (isDirty()) await saveOpenAuto();
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
    setStatus(
      result.errors === 0 ? "ok" : "error",
      result.errors === 0
        ? `Deployed into ${result.deployDir}: ${String(result.changed)} file${result.changed === 1 ? "" : "s"} changed.`
        : `Deployed, but ${String(result.errors)} auto${result.errors === 1 ? " was" : "s were"} skipped for validation errors.`,
    );
  } catch (error) {
    patchPanel("deploy", { phase: "failed", message: say(error) });
  }
}

/* ---- Git ----------------------------------------------------------------- */

/** Opens the git panel with the branch, the changed autos and who GitHub thinks you are. */
export async function openGitPanel(): Promise<void> {
  const context = desktopContext();
  if (context === null) {
    setStatus("error", "Commit and push need a robot repository opened in the desktop app.");
    return;
  }
  const fileName = getState().fileName;
  setPanel({ kind: "git", fileName, status: null, github: null, busy: "Reading the repository…", log: [], error: null, prUrl: null });
  await refreshGit();
}

async function refreshGit(): Promise<void> {
  const context = desktopContext();
  if (context === null || panel.kind !== "git") return;
  try {
    const [status, github] = await Promise.all([
      context.bridge.git.status(context.root, panel.fileName),
      context.bridge.github.status(),
    ]);
    patchPanel("git", { status, github, busy: null });
  } catch (error) {
    patchPanel("git", { busy: null, error: say(error) });
  }
}

async function gitStep(label: string, step: (context: { bridge: ZenithDesktopBridge; root: string }) => Promise<string>): Promise<boolean> {
  const context = desktopContext();
  if (context === null || panel.kind !== "git") return false;
  patchPanel("git", { busy: label, error: null });
  try {
    const line = await step(context);
    if (panel.kind === "git") patchPanel("git", { log: [...panel.log, line], busy: null });
    await refreshGit();
    return true;
  } catch (error) {
    patchPanel("git", { busy: null, error: say(error) });
    await refreshGit();
    return false;
  }
}

export async function commitAuto(summary: string): Promise<boolean> {
  if (panel.kind !== "git" || panel.fileName === null) return false;
  const fileName = panel.fileName;
  if (isDirty() && getState().fileName === fileName) await saveOpenAuto();
  return gitStep("Committing…", async ({ bridge, root }) => {
    const result = await bridge.git.commit(root, { fileName, summary });
    return `${result.createdBranch ? `Created ${result.branch}. ` : ""}Committed ${result.sha.slice(0, 7)} on ${result.branch}: ${result.message}`;
  });
}

export async function pushBranch(): Promise<boolean> {
  return gitStep("Pushing…", async ({ bridge, root }) => {
    const result = await bridge.git.push(root);
    return `Pushed ${result.branch} to ${result.remote}.`;
  });
}

export async function openPullRequest(): Promise<boolean> {
  if (panel.kind !== "git" || panel.fileName === null) return false;
  const fileName = panel.fileName;
  return gitStep("Opening the pull request…", async ({ bridge, root }) => {
    const result = await bridge.git.openPullRequest(root, { fileName });
    patchPanel("git", { prUrl: result.url });
    return `${result.created ? "Opened" : "Updated"} pull request #${String(result.number)}.`;
  });
}

export async function setGitHubToken(token: string): Promise<void> {
  const bridge = desktopBridge();
  if (bridge === null || panel.kind !== "git") return;
  patchPanel("git", { busy: "Checking the token with GitHub…", error: null });
  try {
    const github = await bridge.github.setToken(token);
    patchPanel("git", { github, busy: null });
  } catch (error) {
    patchPanel("git", { busy: null, error: say(error) });
  }
}

export async function forgetGitHubToken(): Promise<void> {
  const bridge = desktopBridge();
  if (bridge === null || panel.kind !== "git") return;
  const github = await bridge.github.forgetToken();
  patchPanel("git", { github });
}

/* ---- The native menu ----------------------------------------------------- */

/** The desktop actions, for the shell's toolbar and palette. Each is a no-op outside the desktop app. */
export const DESKTOP_ACTIONS = [
  { id: "desktop.sim", label: "Run high-fidelity sim", run: () => runHighFidelitySim() },
  { id: "desktop.deploy", label: "Deploy autos into the robot repo", run: () => deployAutos() },
  { id: "desktop.git", label: "Commit, push and open a pull request", run: () => openGitPanel() },
] as const;

async function runMenuCommand(command: DesktopMenuCommand): Promise<void> {
  switch (command.action) {
    case "desktop.sim":
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
  if (!isEnabled(action, getState())) {
    setStatus("info", action.hint?.(getState()) ?? `${action.label} is not available right now.`);
    return;
  }
  await action.run();
}
