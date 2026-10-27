/**
 * The browser side of host mode (site/docs/host-protocol.md): another web app opens
 * `<zenith>/?host=<id>` in a popup, and this module is the conversation with it over
 * `window.postMessage`.
 *
 * - On load it posts `ready` to `window.opener` with target origin `"*"` (the message carries
 *   nothing), then waits up to `OPEN_TIMEOUT_MS` for an `open`.
 * - It accepts a message only when `event.source` is the opener and `event.origin` is on the
 *   host's allowlist (`hostOrigins.ts`). The first `open` pins that origin: every later message
 *   must come from it, and everything Zenith posts afterwards is posted to it and nowhere else.
 * - Save goes through `HostBackend`, whose channel is `save` here: it posts `save` and waits for
 *   the host's `saved`. Simulate posts `run` and waits for a `trace`.
 *
 * The session lasts as long as the page, so `startHostSession` runs once and later calls are
 * no-ops; React's development double effect cannot post a second `ready`.
 */
import { canonicalize, parseTrace } from "@horizon36596/zenith-core";
import { adoptBackend, reportOpenError, say } from "../app/projectActions";
import { newPathHeading } from "../app/newPathHeading";
import { confirmReplace } from "../app/unsaved";
import {
  getState,
  openAuto,
  patchHost,
  setHost,
  setStatus,
  setTrace,
  touchProject,
  type HostView,
} from "../state/store";
import { HostBackend, buildHostProject, newHostAuto, type HostChannel } from "./hostBackend";
import {
  hostById,
  hostIdFromSearch,
  isAllowedOrigin,
  outdatedHostLine,
  parseOriginList,
  refusedSaveLine,
  runFailedLine,
  runTimeoutLine,
  type HostInfo,
} from "./hostOrigins";
import {
  byeMessage,
  HOST_PROTOCOL,
  otherOpenProtocol,
  parseHostMessage,
  readyMessage,
  runMessage,
  saveMessage,
  type HostOpenMessage,
  type HostStartPose,
  type HostRunFailedMessage,
  type HostSavedMessage,
  type HostTraceMessage,
  type ZenithMessage,
} from "./hostProtocol";
import { SessionEndedError } from "./errors";
import { ProjectError } from "./local";
import { olderFormatOf, outdatedOpenLine } from "./formatVersion";
import { autoStartTour } from "../tour/store";
import { afterBetaNotice } from "../dialogs/betaNoticeState";

/** How long Zenith waits for the host's `open` before it says nothing came. */
export const OPEN_TIMEOUT_MS = 10_000;
/** How long a `save` waits for its `saved`. */
export const SAVE_TIMEOUT_MS = 5_000;
/** How long a `run` waits for its `trace`. */
export const RUN_TIMEOUT_MS = 60_000;
/** How often the page checks that the host's window is still open. */
export const OPENER_CHECK_MS = 1_000;

/** The `?host=` id this page was opened with, read once, or null outside host mode. */
const HOST_ID: string | null = typeof window === "undefined" ? null : hostIdFromSearch(window.location.search);

/** The build's extra allowed origins, for a host's preview deployments. */
const EXTRA_ORIGINS: readonly string[] = parseOriginList(import.meta.env.VITE_ZENITH_HOST_ORIGINS);

/** True when this page was opened by another web app to edit for it. Fixed for the page's life. */
export const isHostMode = (): boolean => HOST_ID !== null;

/** The host's name in copy ("DSIM"), or null outside host mode. */
export function hostName(): string | null {
  if (HOST_ID === null) return null;
  return hostById(HOST_ID)?.displayName ?? HOST_ID;
}

interface PendingSave {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: number;
}

let started = false;
let host: HostInfo | null = null;
let pinnedOrigin: string | null = null;
let backend: HostBackend | null = null;
/** The start the host offered for new autos in the `open` that is applied now (`newAutoStart`). */
let hostStart: HostStartPose | undefined;
let openTimer: number | null = null;
let runTimer: number | null = null;
/** The `open` being applied, while it is; a `trace` that arrives meanwhile waits for it. */
let opening: Promise<void> | null = null;
const pendingSaves = new Map<string, PendingSave>();

const phase = (): HostView["phase"] | null => getState().host?.phase ?? null;

const displayName = (): string => host?.displayName ?? HOST_ID ?? "the host";

/** The sentence for a host that opened Zenith and never sent a project. */
const nothingSent = (name: string): string =>
  `Zenith was opened for ${name} but ${name} did not send a project. Open it again from ${name}.`;

/** The sentence for a page opened with `?host=` but not by a window that can send the project. */
const noOpener = (name: string): string =>
  `Zenith was opened for ${name}, but not from a ${name} window, so no project can arrive. Open it again from ${name}. If the browser blocked the pop-up, allow pop-ups for ${name} first.`;

/** The sentence for a host whose `open` names a protocol this build does not speak. */
const otherProtocol = (name: string, protocol: string): string =>
  `${name} sent its project in ${protocol}, and this version of Zenith reads only ${HOST_PROTOCOL}, so the two are out of step. Reload ${name} and open Zenith from it again.`;

function fail(failure: string): void {
  if (openTimer !== null) window.clearTimeout(openTimer);
  openTimer = null;
  patchHost({ phase: "failed", failure });
}

/** The opener, while it is still there to talk to. */
function opener(): Window | null {
  const value = window.opener as Window | null;
  return value === null || value.closed ? null : value;
}

/** Posts to the pinned origin, and only there. Returns false when there is no one to post to. */
function post(message: ZenithMessage): boolean {
  const target = opener();
  if (target === null || pinnedOrigin === null) return false;
  target.postMessage(message, pinnedOrigin);
  return true;
}

/** What ended a closed session, as the start of a sentence: "DSIM closed this session". */
export function closedLine(view: Pick<HostView, "name" | "closedBy">): string {
  return view.closedBy === "window" ? `${view.name}'s window was closed` : `${view.name} closed this session`;
}

/** Why a message to the host cannot be sent now, or null when it can. */
function cannotReach(): string | null {
  const name = displayName();
  const view = getState().host;
  if (view !== null && view.phase === "closed") return `${closedLine(view)}, so there is nowhere to send this auto.`;
  if (opener() === null || pinnedOrigin === null) {
    return `${name}'s window is gone, so there is nowhere to send this auto. Save a copy to downloads keeps it.`;
  }
  return null;
}

/* ---- Save --------------------------------------------------------------- */

/**
 * Says on the bar which save is still waiting for the host's answer, so Save to shows "Saving to"
 * and is off until it comes (or the wait ends). Null once nothing is waiting.
 */
function showSaving(): void {
  const waiting = [...pendingSaves.keys()];
  const name = waiting[waiting.length - 1];
  patchHost({ saving: name === undefined ? null : (backend?.fileNameOf(name) ?? name) });
}

const channel: HostChannel = {
  save(name: string, text: string): Promise<void> {
    const blocked = cannotReach() ?? getState().host?.outdated ?? null;
    if (blocked !== null) return Promise.reject(new ProjectError(blocked));
    // A second save of the same auto before the first is answered replaces it.
    const earlier = pendingSaves.get(name);
    if (earlier !== undefined) {
      window.clearTimeout(earlier.timer);
      earlier.reject(new ProjectError(`A newer save of ${name} replaced this one.`));
      pendingSaves.delete(name);
    }
    return new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        pendingSaves.delete(name);
        showSaving();
        reject(
          new ProjectError(
            `${displayName()} did not answer within ${String(SAVE_TIMEOUT_MS / 1000)} s, so ${name} may not be saved in ${displayName()}.`,
          ),
        );
      }, SAVE_TIMEOUT_MS);
      pendingSaves.set(name, { resolve, reject, timer });
      showSaving();
      setStatus("info", `Saving ${backend?.fileNameOf(name) ?? name} to ${displayName()}…`);
      post(saveMessage(name, text));
    });
  },
};

function onSaved(message: HostSavedMessage): void {
  const pending = pendingSaves.get(message.name);
  const name = displayName();
  if (pending === undefined) {
    // An answer nobody is waiting for (a save that already timed out, say): still worth saying.
    if (message.ok) setStatus("ok", `${name} saved ${message.name}.`);
    else setStatus("error", refusedSaveLine(name, message.name, message.error, "could not save"));
    return;
  }
  window.clearTimeout(pending.timer);
  pendingSaves.delete(message.name);
  showSaving();
  if (message.ok) pending.resolve();
  else pending.reject(new ProjectError(refusedSaveLine(name, message.name, message.error, "did not save")));
}

/* ---- Simulate ------------------------------------------------------------ */

/** Why "Simulate in <host>" cannot run now, or null when it can. */
export function hostRunBlockedReason(): string | null {
  const state = getState();
  const view = state.host;
  if (view === null) return "This is not a host session.";
  if (!view.simulate) return `${view.name} did not offer to simulate autos.`;
  // A host too old to read this Zenith's autos would refuse the run inside its own window.
  if (view.phase === "open" && view.outdated !== null) return view.outdated;
  if (state.auto === null || state.fileName === null) return "Open an auto first.";
  if (view.running !== null) return `Waiting for ${view.name} to send the trace back.`;
  return cannotReach();
}

/** Posts the open auto as `run`; the host answers with `trace`, which `onTrace` lays over the plan. */
export function runInHost(): void {
  const blocked = hostRunBlockedReason();
  if (blocked !== null) {
    setStatus("info", blocked);
    return;
  }
  const { auto, fileName } = getState();
  if (auto === null || fileName === null || backend === null) return;
  const name = backend.hostNameOf(fileName);
  post(runMessage(name, canonicalize("auto", auto)));
  if (runTimer !== null) window.clearTimeout(runTimer);
  runTimer = window.setTimeout(() => {
    runTimer = null;
    patchHost({ running: null });
    setStatus("error", runTimeoutLine(displayName(), RUN_TIMEOUT_MS / 1000));
  }, RUN_TIMEOUT_MS);
  patchHost({ running: name });
  setStatus("info", `Sent ${fileName} to ${displayName()} to simulate. Its recorded drive will be laid over the plan.`);
}

function onTrace(message: HostTraceMessage): void {
  if (backend === null) return;
  const name = displayName();
  const fileName = backend.fileNameOf(message.auto);
  const view = getState().host;
  if (view !== null && view.running !== null && backend.fileNameOf(view.running) === fileName) {
    if (runTimer !== null) window.clearTimeout(runTimer);
    runTimer = null;
    patchHost({ running: null });
  }
  let trace;
  try {
    trace = parseTrace(message.trace);
  } catch (error) {
    setStatus("error", `${name} sent a trace Zenith could not read: ${say(error)}`);
    return;
  }
  if (getState().fileName !== fileName) {
    setStatus("info", `${name} sent a trace of ${fileName}, which is not the open auto, so it was not laid over this one.`);
    return;
  }
  setTrace(trace);
  setStatus("ok", `Laid ${name}'s recorded run of ${fileName} over the plan.`);
}

/**
 * The host could not run an auto (`runFailed`, optional for a host to send). The run it answers
 * stops waiting and the host's reason goes on the status line, instead of a 60 s wait that ends
 * with no reason (sweep W4-2).
 */
function onRunFailed(message: HostRunFailedMessage): void {
  const running = getState().host?.running ?? null;
  const fileNameOf = (auto: string): string => backend?.fileNameOf(auto) ?? auto;
  if (!runFailedAnswers(running, message.auto, fileNameOf) || running === null) return;
  if (runTimer !== null) window.clearTimeout(runTimer);
  runTimer = null;
  patchHost({ running: null });
  setStatus("error", runFailedLine(displayName(), fileNameOf(running), message.reason));
}

/**
 * Whether a `runFailed` answers the run Zenith is waiting on. With no run waiting (none was sent,
 * a trace already came, or the wait timed out) it answers nothing, and neither does one that names
 * another auto, so a late or stray failure never paints over a finished trace. A `runFailed`
 * without an auto answers the run that is waiting.
 */
export function runFailedAnswers(
  running: string | null,
  auto: string | undefined,
  fileNameOf: (auto: string) => string,
): boolean {
  if (running === null) return false;
  return auto === undefined || auto === running || fileNameOf(auto) === fileNameOf(running);
}

/**
 * The open auto's name, and the older format the host sent it in when it did: what the
 * older-format notice said before the out-of-date line replaced it. Null when no auto is open.
 */
function openedFormat(message: HostOpenMessage, opened: HostBackend): { fileName: string; fromFormatVersion?: number } | null {
  const fileName = getState().fileName;
  if (fileName === null) return null;
  const text = message.project.autos[opened.hostNameOf(fileName)];
  if (text === undefined) return { fileName };
  try {
    return { fileName, ...olderFormatOf(JSON.parse(text) as unknown) };
  } catch {
    return { fileName };
  }
}

/* ---- Open and close ------------------------------------------------------- */

async function onOpen(message: HostOpenMessage): Promise<void> {
  if (host === null) return;
  if (openTimer !== null) window.clearTimeout(openTimer);
  openTimer = null;
  const name = host.displayName;
  const first = phase() === "waiting";

  let build;
  try {
    build = buildHostProject(message, host);
  } catch (error) {
    const reason = `${name} sent a project Zenith could not read. ${say(error)}`;
    if (first) fail(reason);
    else setStatus("error", reason);
    return;
  }

  const next = new HostBackend(build.project, build.hostNames, channel, name);
  // Known before the auto loads, so an older-format notice can say that this host cannot read the
  // format Save would write.
  const outdated = outdatedHostLine(host, message.hostBuild);
  const before = getState().host?.outdated ?? null;
  patchHost({ outdated });
  let opened: boolean;
  try {
    // The auto the host asked for, or none: never another one the host would get back on Save.
    opened = await adoptBackend(next, build.preferred, `${name} sent another project, which will close it.`, true);
  } catch (error) {
    // The project that stays open is the one the earlier `open` sent, so its answer stays too.
    patchHost({ outdated: before });
    if (first) fail(`${name} sent a project Zenith could not open. ${say(error)}`);
    else reportOpenError(error, "host", name);
    return;
  }
  backend = next;
  hostStart = message.newAutoStart;
  const label = message.project.hostLabel ?? build.project.robot.name ?? message.project.name;
  patchHost({
    phase: "open",
    closedBy: null,
    failure: null,
    label,
    readOnlyRobot: message.readOnlyRobot === true,
    simulate: message.capabilities?.simulate === true,
    running: null,
    outdated,
  });
  // A host asks for a new auto with `newAuto`, and sends its other autos with it so the new one
  // gets a name none of them uses. Without the flag a new auto starts only when none came.
  if (message.newAuto === true || build.project.autoFiles.length === 0) await createHostAuto();
  // A status an auto's own load left (a bad override, an auto that failed to parse, an older
  // format that Save will change) is worth more.
  else if (opened && getState().status?.kind !== "error") setStatus("info", `Opened ${label} from ${name}.`);
  // Last, so nothing above replaces it: a host that cannot read this Zenith's autos is the thing to
  // know before editing, since Save to it is off.
  if (outdated !== null) setStatus("error", outdatedOpenLine(outdated, name, openedFormat(message, next)));
  // Most people first meet Zenith here, opened from a host, so a first visit gets the tour now that
  // there is an auto to point at. The standalone first run never happens in host mode. The beta
  // notice, which shows in a host's window too, comes first: the tour waits for it to close.
  if (first) afterBetaNotice(autoStartTour);
}

/**
 * Ends the session: the host sent `close`, or its window went away. Anything still waiting on the
 * host fails, Save turns off, and the bar and the status line say which of the two happened.
 */
function endSession(closedBy: "host" | "window"): void {
  const name = displayName();
  const line = closedLine({ name, closedBy });
  for (const [autoName, pending] of pendingSaves) {
    window.clearTimeout(pending.timer);
    pending.reject(new SessionEndedError(`${line} before the save of ${autoName} was answered.`));
  }
  pendingSaves.clear();
  showSaving();
  if (runTimer !== null) window.clearTimeout(runTimer);
  runTimer = null;
  if (phase() === "waiting") {
    fail(nothingSent(name));
    return;
  }
  patchHost({ phase: "closed", closedBy, running: null });
  // The bar says what ended the session; the status line says only what is left to do, so the
  // sentence is not on the screen twice.
  setStatus("warn", `Save to ${name} is off. Save a copy keeps your edits.`);
}

function onClose(): void {
  endSession("host");
}

/**
 * Notices the host's window closing, which it cannot say itself: without this the bar would go on
 * offering Save to a window that is gone until a Save failed. Checked on a timer and whenever this
 * window gets the focus back, which is when a person who closed the host tab looks here again.
 */
function checkOpener(): void {
  if (phase() === "open" && opener() === null) endSession("window");
}

/* ---- New auto --------------------------------------------------------------- */

/** Why "New auto" cannot run now, or null when it can. */
export function newAutoBlockedReason(): string | null {
  const view = getState().host;
  if (view === null) return "New autos are made in the robot repository, with zenith new.";
  if (view.phase === "closed") return `${closedLine(view)}.`;
  if (view.phase !== "open" || backend === null) return `Waiting for ${view.name} to send the project.`;
  return null;
}

/**
 * Starts a new auto from core's template and opens it. It is on the project's list at once, but
 * it exists only in this window, and shows as unsaved, until Save sends it to the host.
 */
export async function createHostAuto(): Promise<void> {
  if (backend === null || newAutoBlockedReason() !== null) return;
  const project = backend.current();
  const { fileName, auto } = newHostAuto(project, newPathHeading, hostStart, displayName());
  if (!(await confirmReplace(`Starting ${fileName} will replace it.`))) {
    setStatus("info", `Kept the unsaved edits in ${getState().fileName ?? "this auto"}.`);
    return;
  }
  backend.addAuto(fileName, canonicalize("auto", auto), { unsent: true });
  touchProject(project);
  // An empty saved text: the new auto is unsaved until the host has it, so Save is what sends it.
  openAuto(fileName, auto, "");
  setStatus("info", `Started ${fileName}. It stays in this window until you save it to ${displayName()}.`);
}

/* ---- The message pump ------------------------------------------------------- */

function onMessage(event: MessageEvent): void {
  if (host === null) return;
  // Only the window that opened this one may speak, and only from an origin the host is allowed.
  if (event.source === null || event.source !== (window.opener as Window | null)) return;
  if (pinnedOrigin === null ? !isAllowedOrigin(host, event.origin, EXTRA_ORIGINS) : event.origin !== pinnedOrigin) {
    return;
  }
  const message = parseHostMessage(event.data);
  if (message === null) {
    // A project in a protocol this build does not speak: say so now rather than, ten seconds later,
    // that nothing came. After the pin it only reaches the status line.
    const protocol = otherOpenProtocol(event.data);
    if (protocol !== null && host !== null) {
      if (phase() === "waiting") fail(otherProtocol(host.displayName, protocol));
      else setStatus("error", otherProtocol(host.displayName, protocol));
    }
    return;
  }
  if (pinnedOrigin === null) {
    // Nothing is trusted before the project arrives; the `open` is what pins the origin.
    if (message.type !== "open") return;
    pinnedOrigin = event.origin;
  }
  if (message.type === "open") {
    const run = onOpen(message).finally(() => {
      if (opening === run) opening = null;
    });
    opening = run;
  } else if (message.type === "saved") onSaved(message);
  // A trace posted right behind its `open` (a host sending a recorded run with the project) waits
  // for the open to finish, which is async; handled at once it would find no backend and vanish.
  else if (message.type === "trace") {
    if (opening !== null) void opening.then(() => onTrace(message));
    else onTrace(message);
  } else if (message.type === "runFailed") onRunFailed(message);
  else onClose();
}

/** Best effort: the host may use it to tell a closed editor from a slow one. */
function onPageHide(): void {
  post(byeMessage());
}

/**
 * Starts the session when the page was opened in host mode: posts `ready`, listens, and starts
 * the clock on the host's `open`. Returns a teardown for the effect that called it, which does
 * nothing: the session lasts as long as the page.
 */
export function startHostSession(): () => void {
  if (HOST_ID === null || started) return () => undefined;
  started = true;
  host = hostById(HOST_ID);
  setHost({
    id: HOST_ID,
    name: displayName(),
    phase: "waiting",
    closedBy: null,
    failure: null,
    label: null,
    readOnlyRobot: false,
    simulate: false,
    running: null,
    outdated: null,
  });
  if (host === null) {
    fail(`Zenith was opened for a host called "${HOST_ID}", which it does not know, so it cannot take a project from it.`);
    return () => undefined;
  }
  const target = opener();
  if (target === null) {
    fail(noOpener(host.displayName));
    return () => undefined;
  }
  window.addEventListener("message", onMessage);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("focus", checkOpener);
  window.setInterval(checkOpener, OPENER_CHECK_MS);
  // `ready` carries nothing, and the host's origin is not known yet, so it goes to any origin.
  target.postMessage(readyMessage(), "*");
  openTimer = window.setTimeout(() => {
    openTimer = null;
    if (phase() === "waiting" && host !== null) fail(nothingSent(host.displayName));
  }, OPEN_TIMEOUT_MS);
  return () => undefined;
}

/** "Continue to Zenith": the same address without `?host=`, which is the usual start screen. */
export function leaveHostMode(): void {
  window.location.replace(import.meta.env.BASE_URL);
}
