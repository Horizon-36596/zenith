/**
 * The editor's state: one immutable `Auto` document plus the four files it is read against, the
 * selection, the tool, and the view state. Undo is a stack of canonical strings, so an undo step is
 * exactly the change a `git diff` would show (site/docs/editor.md).
 *
 * A plain observable store rather than a state library: `apps/web/UI_GUIDE.md` section 1 says
 * assume no new dependencies, and React 18's `useSyncExternalStore` is all this needs.
 */
import { useCallback, useSyncExternalStore } from "react";
import { canonicalize, loadAuto, waypointsUsed } from "@horizon36596/zenith-core";
import type { Auto, Field, Link, Robot, Waypoints } from "@horizon36596/zenith-schema";
import type { Severity, Trace } from "@horizon36596/zenith-core";
import type { Alliance, Selection, Tool } from "../canvas/types";
import { derive, type Derived } from "./derived";
import { DEFAULT_PREFS, applyTheme, loadPrefs, savePrefs, type Prefs, type Theme } from "./prefs";
import { projectKey, type Project } from "../project/types";
import {
  hiddenWaypointNames,
  pinKey,
  prunedForMode,
  shownByMode,
  withPinRenamed,
  withPinOverride,
  withPinShown,
  withoutProjectPins,
  type PinOverride,
  type WaypointPinsMode,
} from "./waypointPins";
import type { ProjectBackend } from "../project/backend";
import type { GitHubAuth, RepoRef } from "../github/types";
import type { ReviewState } from "../github/reviewModel";
import { emitTourSignal } from "../tour/signals";
import { hiddenStepIds, shownFindings, shownSelection, toolShown } from "./features";
import { settingEntry, settingsPatch, type SettingId, type SettingValues } from "../settings/registry";
import { indexSteps, isPathStep } from "../lib/stepOps";

export type DialogKind =
  | "open"
  | "simulate"
  | "meta"
  /** GitHub mode (site/docs/github.md): sign in, commit, propose. */
  | "signIn"
  | "commit"
  | "propose"
  /** The keyboard shortcut and canvas gesture overlay (`?` or F1). */
  | "shortcuts"
  /** Import commands from Java: robot.json's registry read from the robot's own code. */
  | "importCommands"
  /** Report a bug (`report/ReportBugDialog.tsx`), from the help menu or the palette. */
  | "reportBug"
  | null;

export interface Status {
  /** `warn`: it went through, but left something to look at, such as a saved auto with errors (issue #158). */
  kind: "info" | "ok" | "warn" | "error";
  message: string;
  /** The reason or the next step, in a few words, drawn quieter after the message (issue #247). */
  hint?: string;
  /** Wall-clock milliseconds, only ever used to say "validated 12 s ago". */
  at: number;
}

/**
 * Host mode (site/docs/host-protocol.md): which web app opened Zenith to edit an auto for it,
 * and where the session with it stands. Null in every other mode. `project/hostSession.ts` is the
 * only writer; the toolbar, the dialogs and the actions read it, so it lives in the store where a
 * change re-renders them all.
 */
export interface HostView {
  /** The `?host=` id. */
  id: string;
  /** The host's name in the editor's copy: "Save to DSIM". */
  name: string;
  /**
   * `waiting` until the host's `open` arrives, `open` while editing, `failed` when there is no
   * opener, no project came in time or the one that came could not be read, and `closed` once the
   * session is over: the host ended it, or its window went away.
   */
  phase: "waiting" | "open" | "failed" | "closed";
  /** Who ended a `closed` session: the host with its `close`, or the host's window closing. */
  closedBy: "host" | "window" | null;
  /** Why the session failed, as a sentence for the full-page message. */
  failure: string | null;
  /** The host's line for what is being edited, or the robot's name. */
  label: string | null;
  /** The robot comes from the host's own builder. */
  readOnlyRobot: boolean;
  /** The host can simulate an auto and send the trace back. */
  simulate: boolean;
  /** The auto a `run` is waiting on a trace for, or null. */
  running: string | null;
  /**
   * The sentence saying the host is older than this Zenith expects and needs an update (its `open`
   * named a `hostBuild` below the host's `minBuild`), or null. While it is set, Save to and Simulate
   * in the host are off, with this sentence as the reason.
   */
  outdated: string | null;
  /** The auto a `save` is waiting on the host's answer for, or null; absent is none. */
  saving?: string | null;
}

/** The question `app/unsaved.ts` is waiting on: whose edits, and what would replace them. */
/**
 * Delete all or Cancel, asked before a delete takes steps the feature switches hide with it: a
 * group that holds command steps while Commands is off. `ids` are the steps the delete will remove.
 */
export interface DeleteHiddenPrompt {
  ids: string[];
  /** How many hidden steps go with them. */
  hidden: number;
}

export interface UnsavedPrompt {
  fileName: string;
  /** A sentence saying what happens to the edits if the person goes on. */
  next: string;
  /**
   * What is not saved, as a sentence, when that is more than the auto: "waypoints.json has changes
   * that are not saved (2 other autos follow park). Discard puts them back." Unset when it is the
   * auto alone, which the dialog words as "<fileName> has edits that are not saved."
   */
  lead?: string;
  /** The Save button's label when saving is not a plain Save, such as "Save a copy…". */
  saveLabel?: string;
}

/**
 * One undo or redo step: the auto as canonical text, and the project's `waypoints.json` as it was
 * then. Waypoint edits (issue #134) are undone like any other edit, so a step carries both; an edit
 * that changed only the auto carries the waypoints unchanged, the same object.
 */
export interface HistoryEntry {
  auto: string;
  waypoints: Waypoints | undefined;
  /**
   * The selection to bring back when this entry is undone: what a delete removed (issue #183), so
   * Ctrl+Z leaves the step it restored selected. Absent for every other edit, whose undo leaves the
   * selection alone unless it names something the undo removed (issue #315, `reconciledSelection`). Redoing the delete clears the selection again, as the delete itself did.
   * A waypoint delete (issue #232) also carries the status lines its undo and redo put in place
   * of the stale "Deleted waypoint…" one. An add sets `redoSelection`, what redoing it selects,
   * since the add itself selected the pin; without it, redo clears the selection.
   */
  restore?: {
    selection: Selection;
    multiSteps: string[];
    undoStatus?: string;
    redoStatus?: string;
    redoSelection?: { selection: Selection; multiSteps: string[] };
  };
  /**
   * A waypoint rename (issue #236) whose pin override moved with it. The override is a view choice
   * kept in prefs, not in this entry, so undo moves it back from `to` to `from` and redo moves it on
   * again, and a hidden pin stays hidden under whichever name the undo or redo lands on.
   */
  pinRename?: { from: string; to: string };
  /**
   * A waypoint delete whose pin override went with it, so a new waypoint of that name starts with
   * none. Undo puts `value` back on `name` and redo drops it again.
   */
  pinDrop?: { name: string; value: PinOverride };
  /**
   * What the edit said it did: the first sentence of the status line its own action wrote, such as
   * "Added wait2 after leg1." Undo answers "Undid: Added wait2 after leg1." and redo "Redid: …"
   * with it (UI_GUIDE 9.15). Set by the store, never by an edit: see `setStatus`.
   */
  label?: string;
}

export interface State {
  prefs: Prefs;
  project: Project | null;
  /** How the project is read and written. Null until one is opened. */
  backend: ProjectBackend | null;
  /** Who is signed in to GitHub, or null in local mode. The token itself is never here. */
  auth: GitHubAuth | null;
  /** The repository and the work branch, when the project came from GitHub. */
  repo: RepoRef | null;
  /** The pull request being reviewed, which makes the editor read only. */
  review: ReviewState | null;
  /** The web app this editor was opened for, in host mode; null otherwise. */
  host: HostView | null;
  fileName: string | null;
  auto: Auto | null;
  /**
   * The robot and field the open auto is actually checked against: `project.robot`/`project.field`
   * until `auto.robot`/`auto.field` resolves to something else (finding 23,
   * `apps/web/src/project/overrides.ts`). `openAuto` sets these to the project's own as a synchronous
   * default; `setAutoOverrides` updates them once the async resolution finishes.
   */
  autoRobot: Robot | null;
  autoField: Field | null;
  /** The canonical text as last loaded or saved: what "unsaved changes" compares against. */
  savedCanonical: string | null;
  /**
   * `project.waypoints` as last loaded or saved, which unsaved waypoint changes compare against
   * (issue #134). The project's own copy is the one the editor reads and edits.
   */
  savedWaypoints: Waypoints | undefined;
  undo: HistoryEntry[];
  redo: HistoryEntry[];
  selection: Selection;
  /**
   * Steps picked together in the step list with Shift- or Ctrl-click, for "wrap in a group". Empty
   * means only `selection.stepId`. Any single selection clears it.
   */
  multiSteps: string[];
  tool: Tool;
  alliance: Alliance;
  playbackS: number | null;
  playing: boolean;
  trace: Trace | null;
  /**
   * True while `trace` is a Full sim run still streaming in from the desktop app's sim server: it
   * holds the rows received so far, the playhead waits at its end, and the timeline says Simulating.
   */
  traceStreaming: boolean;
  severityFilter: Severity | null;
  status: Status | null;
  validatedAt: number | null;
  dialog: DialogKind;
  /**
   * Save, Discard or Cancel before the open auto is replaced (QA-12). Separate from `dialog` because
   * it is asked on top of one: the GitHub tab of the open dialog stays open behind it.
   */
  unsavedPrompt: UnsavedPrompt | null;
  deleteHiddenPrompt: DeleteHiddenPrompt | null;
  paletteOpen: boolean;
  busy: boolean;
}

const HISTORY_LIMIT = 200;

let state: State = {
  prefs: DEFAULT_PREFS,
  project: null,
  backend: null,
  auth: null,
  repo: null,
  review: null,
  host: null,
  fileName: null,
  auto: null,
  autoRobot: null,
  autoField: null,
  savedCanonical: null,
  savedWaypoints: undefined,
  undo: [],
  redo: [],
  selection: {},
  multiSteps: [],
  tool: "select",
  alliance: "RED",
  playbackS: null,
  playing: false,
  trace: null,
  traceStreaming: false,
  severityFilter: null,
  status: null,
  validatedAt: null,
  dialog: null,
  unsavedPrompt: null,
  deleteHiddenPrompt: null,
  paletteOpen: false,
  busy: false,
};

const listeners = new Set<() => void>();

export const getState = (): State => state;

/**
 * `state.backend` reaches a `GitHubBackend` -> `GitHubClient` -> `HttpClient` -> `PatAuth`, and the
 * PAT is an ordinary field on that last object (finding 36). Nothing in this app serialises the
 * store today, but `set` rebuilds `state` by spreading on every patch, so a plain field would be one
 * `JSON.stringify(getState())` away from writing the token out. Defined non-enumerable instead: dot
 * access (`state.backend`, `getState().backend`) is unaffected, but `{...state}`, `Object.keys` and
 * `JSON.stringify` all skip it, so `backend` has to be re-attached this way on every patch rather
 * than left to the spread.
 */
function set(patch: Partial<State>): void {
  const backend = "backend" in patch ? (patch.backend ?? null) : state.backend;
  const rest: Partial<State> = { ...patch };
  delete rest.backend;
  const next = { ...state, ...rest } as State;
  Object.defineProperty(next, "backend", {
    value: backend,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  state = next;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Calls `listener` after every change to the editor's state, outside React. Returns the unsubscribe. */
export const subscribeEditor = subscribe;

/** The whole state. Panels are small and dense; fine-grained selectors are `useSelector`. */
export const useEditor = (): State => useSyncExternalStore(subscribe, getState, getState);

export function useSelector<T>(select: (value: State) => T): T {
  const snapshot = useCallback(() => select(state), [select]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * The robot the open auto is planned and checked with: its own `robot` override, else the project's
 * (finding 23). A panel that reads `project.robot` directly disagrees with the findings for an auto
 * that sets its own robot (issue #403).
 */
export const autoRobotOf = (value: Pick<State, "autoRobot" | "project">): Robot | null =>
  value.autoRobot ?? value.project?.robot ?? null;

/** The field the open auto is planned and checked on: its own `field` override, else the project's. */
export const autoFieldOf = (value: Pick<State, "autoField" | "project">): Field | null =>
  value.autoField ?? value.project?.field ?? null;

const selectAuto = (value: State): State["auto"] => value.auto;
const selectProject = (value: State): State["project"] => value.project;
const selectAutoRobot = (value: State): State["autoRobot"] => value.autoRobot;
const selectAutoField = (value: State): State["autoField"] => value.autoField;
const selectFeatures = (value: State): Prefs["features"] => value.prefs.features;

/**
 * The memoised derived view of the current document, against `autoRobot`/`autoField` rather than
 * `project.robot`/`project.field` directly, so an auto's own `robot`/`field` override (finding 23)
 * is what gets checked, the same as the CLI and MCP.
 */
export const useDerived = (): Derived => {
  // Only what the derived view reads, so a caller that subscribes to nothing else (the step list)
  // does not draw again on every frame of playback.
  const auto = useSelector(selectAuto);
  const project = useSelector(selectProject);
  const autoRobot = useSelector(selectAutoRobot);
  const autoField = useSelector(selectAutoField);
  const features = useSelector(selectFeatures);
  return shown(
    derive(auto, autoRobotOf({ autoRobot, project }), autoFieldOf({ autoField, project }), project?.waypoints),
    auto,
    features,
  );
};

/**
 * Every finding, including the ones the feature switches hide. The Code tab counts errors from
 * these, because `zenith codegen` refuses an auto with an error in a hidden command step too.
 */
export const useAllFindings = (): Derived["findings"] => {
  const { auto, project, autoRobot, autoField } = useEditor();
  return derive(auto, autoRobot ?? project?.robot ?? null, autoField ?? project?.field ?? null, project?.waypoints)
    .findings;
};

export const currentDerived = (): Derived =>
  shown(
    derive(
      state.auto,
      state.autoRobot ?? state.project?.robot ?? null,
      state.autoField ?? state.project?.field ?? null,
      state.project?.waypoints,
    ),
    state.auto,
    state.prefs.features,
  );

/**
 * Every finding of the open auto, outside React, including the ones the feature switches hide, as
 * `useAllFindings` is for a component. Propose, Save and the share file are held to these, because
 * the CLI refuses an auto with an error in a hidden feature too.
 */
export const currentAllFindings = (): Derived["findings"] =>
  derive(
    state.auto,
    state.autoRobot ?? state.project?.robot ?? null,
    state.autoField ?? state.project?.field ?? null,
    state.project?.waypoints,
  ).findings;

/**
 * The derived view with the findings the feature switches hide taken out (`features.ts`), so the
 * problems panel, the step list and the field all agree. The last answer is kept, so it is the same
 * object while neither the document nor the switches change, as `derive`'s own answer is.
 */
let lastShown: { input: Derived; features: Prefs["features"]; output: Derived } | null = null;
function shown(input: Derived, auto: Auto | null, features: Prefs["features"]): Derived {
  if (lastShown !== null && lastShown.input === input && lastShown.features === features) return lastShown.output;
  const hidden = hiddenStepIds(auto, features);
  const findings = shownFindings(input.findings, features, hidden);
  const output = findings.length === input.findings.length ? input : { ...input, findings };
  lastShown = { input, features, output };
  return output;
}

/* ---- Preferences -------------------------------------------------------- */

export function initPrefs(): void {
  const prefs = loadPrefs();
  applyTheme(prefs.theme);
  set({ prefs });
}

export function setPrefs(patch: Partial<Prefs>): void {
  const prefs = { ...state.prefs, ...patch };
  if (patch.theme !== undefined) applyTheme(patch.theme);
  savePrefs(prefs);
  set({ prefs });
}

/**
 * Changes registered settings (`settings/registry.ts`): the one way any of them is written, from
 * Settings, the palette, a key or `setFeature`. Values are stored flat in `zenith.ui` under their
 * existing names. When a feature switch changes, what it now hides cannot stay selected, and a tool it
 * hides cannot stay picked.
 */
export function setSettings(values: Partial<SettingValues>): void {
  const ids = Object.keys(values) as SettingId[];
  if (ids.length === 0) return;
  setPrefs(settingsPatch(state.prefs, values));
  if (ids.some((id) => settingEntry(id).kind === "feature")) {
    setSelection(state.selection);
    if (!toolShown(state.tool, state.prefs.features)) setTool("select");
  }
}

/** Changes one registered setting (`setSettings`). */
export function setSetting<Id extends SettingId>(id: Id, value: SettingValues[Id]): void {
  setSettings({ [id]: value } as Partial<SettingValues>);
}

export const toggleTheme = (): void => {
  const theme: Theme = state.prefs.theme === "dark" ? "light" : "dark";
  setSetting("display.theme", theme);
};

/** Chooses the playback level (site/docs/simulation.md), remembered with the other preferences. */
export const setPlaybackLevel = (playbackLevel: Prefs["playbackLevel"]): void => {
  setPrefs({ playbackLevel });
};

/** Shows or hides the clip ghosts: the robot drawn in red where a path clips (`canvas/clipGhosts.ts`). */
export const toggleClipGhosts = (): void => {
  setSetting("display.clipGhosts", !state.prefs.clipGhosts);
};

/**
 * Shows or hides the dashed outlines of structure the robot passes under (`canvas/structureLayer.ts`).
 * The band of a hive frame leg the robot runs into stays either way.
 */
export const toggleOverheadOutlines = (): void => {
  setPrefs({ overheadOutlines: !state.prefs.overheadOutlines });
};

/**
 * Which waypoint pins the field shows (`state/waypointPins.ts`). Overrides the new mode makes say
 * nothing go, so changing the mode leaves no clutter. A view choice: no undo step, nothing unsaved.
 */
export function setWaypointPins(mode: WaypointPinsMode): void {
  setPrefs({
    ...settingsPatch(state.prefs, { "display.waypointPins": mode }),
    waypointPinOverrides: prunedForMode(state.prefs.waypointPinOverrides, mode),
  });
}

/** The open project's key for per-person view choices, or null with no project (`projectKey`). */
export const openProjectKey = (current: State = state): string | null =>
  current.project === null ? null : projectKey(current.project);

/** The names of the waypoints whose pins the field hides now (`hiddenWaypointNames`). */
export function hiddenWaypoints(current: State = state): Set<string> {
  return hiddenWaypointNames({
    waypoints: current.project?.waypoints,
    auto: current.auto,
    mode: current.prefs.waypointPins,
    overrides: current.prefs.waypointPinOverrides,
    projectKey: openProjectKey(current),
  });
}

/**
 * Shows or hides one waypoint's pin in the open project, whatever the mode says, storing the choice
 * only where it differs from the mode. Hiding the selected pin clears the selection, so the pin goes
 * from the field at once. Never touches waypoints.json, the undo history or the unsaved state.
 */
export function setWaypointPinShown(name: string, shown: boolean): void {
  const key = openProjectKey();
  if (key === null) return;
  const used = new Set(state.auto === null ? [] : waypointsUsed(state.auto));
  const byMode = shownByMode(state.prefs.waypointPins, name, used);
  setPrefs({ waypointPinOverrides: withPinShown(state.prefs.waypointPinOverrides, pinKey(key, name), shown, byMode) });
  if (!shown && state.selection.waypoint === name) set({ selection: {}, multiSteps: [] });
}

/**
 * The Waypoints list's Show all (issue #245): forgets every pin of the open project shown or hidden
 * on its own, so each one follows the show mode again. Other projects keep theirs. A view choice: no
 * undo step, nothing unsaved.
 */
export function showAllWaypointPins(): void {
  const key = openProjectKey();
  if (key === null) return;
  const next = withoutProjectPins(state.prefs.waypointPinOverrides, key);
  if (next !== state.prefs.waypointPinOverrides) setPrefs({ waypointPinOverrides: next });
}

/**
 * Moves a waypoint's pin override to its new name, so a hidden pin stays hidden through a rename.
 * `undoTop` is the top of the undo stack before the rename: when the rename pushed a step of its
 * own, that step notes the move so undo and redo carry the override back and forth with the name.
 */
export function renameWaypointPin(from: string, to: string, undoTop?: HistoryEntry): void {
  movePinOverride(from, to);
  const last = state.undo[state.undo.length - 1];
  if (last === undefined || last === undoTop) return;
  set({ undo: [...state.undo.slice(0, -1), { ...last, pinRename: { from, to } }] });
}

/**
 * Drops a deleted waypoint's pin override, so a later waypoint of the same name does not inherit it.
 * `undoTop` is as for `renameWaypointPin`: the delete's own undo step notes the drop, so undo brings
 * the override back with the waypoint and redo drops it again.
 */
export function dropWaypointPin(name: string, undoTop?: HistoryEntry): void {
  const key = openProjectKey();
  if (key === null) return;
  const value = state.prefs.waypointPinOverrides[pinKey(key, name)];
  if (value === undefined) return;
  setPinOverride(name, undefined);
  const last = state.undo[state.undo.length - 1];
  if (last === undefined || last === undoTop) return;
  set({ undo: [...state.undo.slice(0, -1), { ...last, pinDrop: { name, value } }] });
}

/** Sets the open project's pin override for `name`, or removes it when `value` is undefined. */
function setPinOverride(name: string, value: PinOverride | undefined): void {
  const key = openProjectKey();
  if (key === null) return;
  const next = withPinOverride(state.prefs.waypointPinOverrides, pinKey(key, name), value);
  if (next !== state.prefs.waypointPinOverrides) setPrefs({ waypointPinOverrides: next });
}

/** Moves the open project's pin override for `from` to `to`, if there is one. */
function movePinOverride(from: string, to: string): void {
  const key = openProjectKey();
  if (key === null) return;
  const next = withPinRenamed(state.prefs.waypointPinOverrides, key, from, to);
  if (next !== state.prefs.waypointPinOverrides) setPrefs({ waypointPinOverrides: next });
}

export const toggleLedgerCounts = (): void => {
  setSetting("display.ledgerCounts", !state.prefs.ledgerCounts);
};

/** Chooses how much of a row's description is drawn (issue #238): Labels only or With descriptions. */
export const setDescriptions = (descriptions: Prefs["descriptions"]): void => {
  setPrefs({ descriptions });
};

export const toggleDescriptions = (): void => {
  setDescriptions(state.prefs.descriptions === "full" ? "compact" : "full");
};

export const toggleSnap = (): void => {
  setSetting("editing.snap", !state.prefs.snap);
  emitTourSignal("snapToggled");
};

/** Extend this chain (issue #204): the add-path tool appends to the selected path step's chain. */
export const toggleAddPathExtends = (): void => {
  setSetting("editing.addPathExtends", !state.prefs.addPathExtends);
};

/* ---- Status ------------------------------------------------------------- */

/** How long a refused edit's error stays on the status line before it goes by itself (issue #411). */
export const REFUSED_EDIT_STATUS_MS = 8000;

/**
 * Whether the status line was set during the action now running. An action that sets its message
 * before it commits keeps it; one set by an earlier action is stale once the next edit lands. The
 * flag is cleared on the next microtask, which is after the synchronous action that set it.
 */
let statusFresh = false;

/** The status lines that go by themselves: a refused edit's error is one, a failed save's is not. */
const expiring = new WeakSet<Status>();

function markStatusFresh(): void {
  if (statusFresh) return;
  statusFresh = true;
  queueMicrotask(() => {
    statusFresh = false;
  });
}

/**
 * Sets the status line. `expireMs` makes the message go by itself after that long, unless another
 * one has replaced it by then: a refused edit's error does, a failed save's does not (issue #411).
 */
export const setStatus = (
  kind: Status["kind"],
  message: string,
  hint?: string,
  options: { expireMs?: number } = {},
): void => {
  const status: Status = { kind, message, ...(hint === undefined ? {} : { hint }), at: Date.now() };
  set({ status, ...labelledTop(status) });
  markStatusFresh();
  if (options.expireMs !== undefined) {
    expiring.add(status);
    setTimeout(() => {
      if (state.status === status) set({ status: null });
    }, options.expireMs);
  }
};

export const clearStatus = (): void => {
  set({ status: null });
};

/**
 * Clears a line an earlier action left, when something new takes the person's attention: a dialog,
 * a sheet or Settings opening, or the tour ending (UI_GUIDE 9.15). A line this same action set stays,
 * and so does an error that does not go by itself, as at an edit.
 */
export const clearStaleStatus = (): void => {
  const stale = staleStatusCleared();
  if ("status" in stale) set(stale);
};

/**
 * Whether the undo entry on top was pushed by the action now running, so the status line that action
 * writes names it (`HistoryEntry.label`). Cleared on the next microtask, as `statusFresh` is.
 */
let topEntryFresh = false;

function markTopEntryFresh(): void {
  if (topEntryFresh) return;
  topEntryFresh = true;
  queueMicrotask(() => {
    topEntryFresh = false;
  });
}

/** The first sentence of a status line, which is what an undo line repeats: not its "Ctrl Z puts it back". */
export const firstSentence = (message: string): string => /^.*?[.!?](?=\s+\S|$)/.exec(message.trim())?.[0] ?? message.trim();

/** The label a status line gives an undo entry, or none for an error, which says what did not happen. */
const labelOf = (status: Status | null): string | undefined =>
  status === null || status.kind === "error" ? undefined : firstSentence(status.message);

/**
 * The undo stack with its top entry named by `status`, when this action pushed that entry and
 * nothing named it yet: an edit that writes its line after it commits (UI_GUIDE 9.15).
 */
function labelledTop(status: Status): Partial<State> {
  if (!topEntryFresh) return {};
  const top = state.undo[state.undo.length - 1];
  const label = labelOf(status);
  if (top === undefined || top.label !== undefined || label === undefined) return {};
  return { undo: [...state.undo.slice(0, -1), { ...top, label }] };
}

/** `entry` named by the line this action already wrote, for an edit that writes its line before it commits. */
function pushedEntry(entry: HistoryEntry, status: Status | null = statusFresh ? state.status : null): HistoryEntry {
  markTopEntryFresh();
  const label = labelOf(status);
  return label === undefined ? entry : { ...entry, label };
}

/**
 * Keeps the status line through the edit that runs next in this action: for the rest of a run of
 * keys whose first key said what the run does, which is still true (issue #411).
 */
export const keepStatus = (): void => {
  if (state.status !== null) markStatusFresh();
};

/**
 * What an edit, an undo or a redo does to the status line: a message an earlier action set is no
 * longer true once the document changed again, so it goes, unless this same action set it (issue #411).
 * An error that does not go by itself, such as a failed save, stays until it is dismissed: the next
 * edit has not made it any less true.
 */
const staleStatusCleared = (): Partial<State> => {
  const status = state.status;
  if (statusFresh || status === null) return {};
  if (status.kind === "error" && !expiring.has(status)) return {};
  return { status: null };
};

export const setBusy = (busy: boolean): void => {
  set({ busy });
};

/* ---- Project and document ----------------------------------------------- */

/**
 * The open project's `zenith.json` after Zenith wrote it (the Settings window's command library),
 * so everything that reads the link sees the new value without opening the project again.
 */
export function replaceProjectLink(link: Link): void {
  if (state.project === null) return;
  set({ project: { ...state.project, link } });
}

export function openProject(project: Project, backend: ProjectBackend): void {
  transactionBase = null;
  set({
    project,
    backend,
    repo:
      project.source.kind === "github"
        ? {
            owner: project.source.owner,
            repo: project.source.repo,
            base: project.source.base,
            branch: project.source.branch,
          }
        : null,
    review: null,
    fileName: null,
    auto: null,
    autoRobot: project.robot,
    autoField: project.field,
    savedCanonical: null,
    savedWaypoints: project.waypoints,
    undo: [],
    redo: [],
    selection: {},
    multiSteps: [],
    trace: null,
    traceStreaming: false,
    validatedAt: null,
    playbackS: null,
    playing: false,
  });
}

/**
 * Opens an auto. `alliance`, the alliance being viewed, starts on the auto's own `alliance`: a
 * file's poses are in that alliance's frame, so the default view draws them unmirrored, where the
 * robot drives them, and an edit there stores what was drawn. The toggle then shows the file as the
 * other alliance (`shouldMirror`).
 * `autoRobot`/`autoField` reset to the project's own as a synchronous default; a caller that knows
 * the auto carries `robot`/`field` overrides follows up with `setAutoOverrides` once those resolve.
 */
export function openAuto(fileName: string, auto: Auto, canonical: string): void {
  transactionBase = null;
  set({
    // Waypoint changes are part of the edits the person was asked about before this auto replaced
    // the last one, so they go back to the saved file too, with the undo history that held them.
    project: withWaypoints(state.savedWaypoints),
    fileName,
    auto,
    autoRobot: state.project?.robot ?? null,
    autoField: state.project?.field ?? null,
    savedCanonical: canonical,
    undo: [],
    redo: [],
    selection: {},
    multiSteps: [],
    trace: null,
    traceStreaming: false,
    playbackS: null,
    playing: false,
    severityFilter: null,
    validatedAt: Date.now(),
    alliance: auto.alliance,
  });
}

/** Resolves what `openAuto` could not resolve synchronously: `auto.robot`/`auto.field` overrides. */
export const setAutoOverrides = (robot: Robot, field: Field): void => {
  set({ autoRobot: robot, autoField: field });
};

export const closeProject = (): void => {
  transactionBase = null;
  set({
    project: null,
    backend: null,
    repo: null,
    review: null,
    fileName: null,
    auto: null,
    autoRobot: null,
    autoField: null,
    savedCanonical: null,
    savedWaypoints: undefined,
    undo: [],
    redo: [],
    selection: {},
    multiSteps: [],
    trace: null,
    traceStreaming: false,
  });
};

/**
 * The document a transaction (`beginTransaction`/`endTransaction`) started from, as an undo step, or
 * `null` when there is no transaction open. Every `commit` while one is open behaves like
 * `history: false`; `endTransaction` is what turns the whole span into a single undo entry.
 */
let transactionBase: HistoryEntry | null = null;
/**
 * What `cancelTransaction` puts back (issue #148): the auto object and the redo stack as the open
 * transaction found them, which its commits replace and empty. `null` with no transaction open.
 */
let transactionStart: { auto: Auto; redo: HistoryEntry[] } | null = null;

/**
 * The document the open transaction started from (issue #150), so a drag's edit can say what the
 * whole drag did since the press, not only its last frame. Null with no transaction open.
 */
export const transactionStartAuto = (): Auto | null => transactionStart?.auto ?? null;

/** The open project with `waypoints` in place of its own, the same object when they already are. */
function withWaypoints(waypoints: Waypoints | undefined): Project | null {
  const project = state.project;
  if (project === null || project.waypoints === waypoints) return project;
  return { ...project, waypoints };
}

/** True when two copies of `waypoints.json` would be written the same. */
export function sameWaypoints(a: Waypoints | undefined, b: Waypoints | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return canonicalize("waypoints", a) === canonicalize("waypoints", b);
}

/** The undo step for the editor as it is now, with `auto` as the document. */
const entryOf = (auto: Auto): HistoryEntry => ({ auto: canonicalize("auto", auto), waypoints: state.project?.waypoints });

/**
 * Opens a transaction: every `commit` up to the matching `endTransaction` becomes part of one undo
 * step instead of one each, which is what makes a canvas drag a single undo entry regardless of how
 * long it runs or how many pointer-move frames it produces (unlike the old time-window coalescing,
 * which produced a new entry whenever two edits landed more than `DRAG_WINDOW_MS` apart). Nested
 * calls are a no-op: only the outermost pair matters.
 */
export function beginTransaction(): void {
  if (state.auto === null || transactionBase !== null) return;
  transactionBase = entryOf(state.auto);
  transactionStart = { auto: state.auto, redo: state.redo };
  statusAtTransactionStart = state.status;
}

/** The status line as a drag began, so a drag that changed something clears it if nothing replaced it. */
let statusAtTransactionStart: Status | null = null;

/**
 * Closes the transaction, pushing one undo entry for the whole span, or none if nothing changed.
 * `tourSignal: false` is for a transaction that is not a drag on the field, such as a number
 * field's scrub, which the tour's "drag one of the dots" stop must not count.
 */
export function endTransaction(options: { tourSignal?: boolean } = {}): void {
  const base = transactionBase;
  const start = transactionStart;
  transactionBase = null;
  transactionStart = null;
  if (base === null || state.auto === null) return;
  if (canonicalize("auto", state.auto) === base.auto && sameWaypoints(state.project?.waypoints, base.waypoints)) {
    // A drag that ended where it began is no edit: the redo stack its commits emptied comes back
    // (issue #401), as `cancelTransaction` puts it back.
    if (start !== null) set({ redo: start.redo });
    return;
  }
  // A line the drag itself wrote, on any frame, names it; one an earlier action left goes, as at any
  // edit (issue #411).
  const said = state.status !== statusAtTransactionStart ? state.status : null;
  const undo = [...state.undo, pushedEntry(base, said)].slice(-HISTORY_LIMIT);
  const stale = state.status !== null && state.status === statusAtTransactionStart ? staleStatusCleared() : {};
  set({ undo, redo: [], ...stale });
  // A transaction that changed something is a drag on the canvas: what the tour's first stop asks for.
  if (options.tourSignal !== false) emitTourSignal("pointDragged");
}

/**
 * Closes the transaction and takes back everything it did (issue #148): Escape during a canvas
 * drag, or a pointer the browser cancelled. The auto, the project's waypoints and the redo stack go
 * back to where `beginTransaction` found them. It pushes no undo entry and sends the tour nothing,
 * since in the end nothing was dragged. With no transaction open it does nothing.
 */
export function cancelTransaction(): void {
  const base = transactionBase;
  const start = transactionStart;
  transactionBase = null;
  transactionStart = null;
  if (base === null || start === null || state.auto === null) return;
  set({ auto: start.auto, project: withWaypoints(base.waypoints), redo: start.redo });
}

/**
 * Replaces the document. `history: false` is for a change that is already part of the previous one,
 * so a drag with no transaction open is still one undo step and not sixty; while a transaction is
 * open (`beginTransaction`) every commit behaves the same way regardless of this option, because
 * `endTransaction` is what will push the single entry for the whole span.
 */
export function commit(next: Auto, options: { history?: boolean } = {}): void {
  const current = state.auto;
  if (current === null) return;
  // Part of the edit before it (a held key's repeat, a drag's move): what the line says of that
  // edit is still true, so it stays.
  if (options.history === false || transactionBase !== null) {
    set({ auto: next, redo: [] });
    return;
  }
  const entry = entryOf(current);
  // A commit that would write the same file is no edit (issue #314): a count typed as 3.6 that
  // rounds back to the 4 it holds, or a range end typed past its neighbour a second time. It leaves
  // the undo and redo stacks alone, so the next Ctrl+Z undoes a real change.
  if (canonicalize("auto", next) === entry.auto) {
    set({ auto: next });
    return;
  }
  const undo = [...state.undo, pushedEntry(entry)].slice(-HISTORY_LIMIT);
  set({ auto: next, undo, redo: [], ...staleStatusCleared() });
}

/**
 * Replaces the document and the project's `waypoints.json` together, as one edit (issue #134): a
 * waypoint moved, added, renamed or deleted, with whatever that did to the open auto. Undo puts
 * both back. History works as `commit`'s does. `restore` is for a waypoint delete (issue #232):
 * undoing it selects the pin again and replaces the status line, and no other entry in the
 * history does either.
 */
export function commitWithWaypoints(
  next: Auto,
  waypoints: Waypoints,
  options: { history?: boolean; restore?: NonNullable<HistoryEntry["restore"]> } = {},
): void {
  const current = state.auto;
  if (current === null || state.project === null) return;
  const project = withWaypoints(waypoints);
  if (options.history === false || transactionBase !== null) {
    set({ auto: next, project, redo: [] });
    return;
  }
  const entry = entryOf(current);
  const undo = [...state.undo, pushedEntry(options.restore === undefined ? entry : { ...entry, restore: options.restore })].slice(-HISTORY_LIMIT);
  set({ auto: next, project, undo, redo: [], ...staleStatusCleared() });
}

/**
 * Notes on the edit just made that undoing it should select `restore` again (issue #183). Does
 * nothing unless the edit changed `before` and pushed an undo step of its own, so a refused edit or
 * one inside a transaction never decorates an older entry.
 */
export function rememberSelectionForUndo(
  before: Auto | null,
  undoDepth: number,
  restore: { selection: Selection; multiSteps: string[] },
): void {
  if (before === null || state.auto === before || state.undo.length !== undoDepth + 1) return;
  const last = state.undo[state.undo.length - 1]!;
  set({ undo: [...state.undo.slice(0, -1), { ...last, restore }] });
}

/** The selection an undo puts back, checked against the document it lands on. */
function restoredSelection(restore: HistoryEntry["restore"], auto: Auto): Partial<State> {
  if (restore === undefined) return {};
  const hidden = hiddenStepIds(auto, state.prefs.features);
  const multiSteps = restore.multiSteps.filter((id) => !hidden.has(id));
  return { selection: shownSelection(restore.selection, auto, state.prefs.features), multiSteps: multiSteps.length > 1 ? multiSteps : [] };
}

/**
 * The selection and multi-selection checked against the documents an undo or redo just landed on
 * (issue #315). Most edits note no selection to restore, so without this an undo that removed the
 * selected step (an Add path click) or a waypoint's new name (a rename) left the selection naming
 * something the file no longer has. A step that is gone, a point or marker past the end of its
 * step, and a waypoint not in `waypoints` are dropped. `renamed` is the waypoint rename the entry
 * carried, as the move this undo or redo made, so a selected pin follows its name back and forth.
 */
function reconciledSelection(
  selection: Selection,
  multiSteps: string[],
  auto: Auto,
  waypoints: Waypoints | undefined,
  renamed: { from: string; to: string } | undefined,
): Pick<State, "selection" | "multiSteps"> {
  const steps = new Map(indexSteps(auto).map((entry) => [entry.id, entry.step]));
  const pointFits = (stepId: string, point: Selection["point"]): boolean => {
    const step = steps.get(stepId);
    return step !== undefined && (point === undefined || (isPathStep(step) && point.segmentIndex < step.segments.length));
  };
  const next: Selection = { ...selection };
  if (next.stepId !== undefined && !pointFits(next.stepId, next.point)) {
    if (steps.has(next.stepId)) delete next.point;
    else {
      delete next.stepId;
      delete next.point;
      delete next.markerIndex;
    }
  }
  if (next.stepId !== undefined && next.markerIndex !== undefined) {
    const step = steps.get(next.stepId);
    if (step === undefined || !isPathStep(step) || next.markerIndex >= (step.markers ?? []).length) delete next.markerIndex;
  }
  if (next.points !== undefined) {
    const points = next.points.filter((member) => pointFits(member.stepId, member.point));
    if (points.length > 1) next.points = points;
    else delete next.points;
  }
  if (next.waypoint !== undefined) {
    const named = waypoints?.waypoints ?? {};
    const name = renamed !== undefined && next.waypoint === renamed.from ? renamed.to : next.waypoint;
    if (Object.prototype.hasOwnProperty.call(named, name)) next.waypoint = name;
    else delete next.waypoint;
  }
  const kept = multiSteps.filter((id) => steps.has(id));
  const changed =
    next.stepId !== selection.stepId ||
    next.point !== selection.point ||
    next.markerIndex !== selection.markerIndex ||
    next.points !== selection.points ||
    next.waypoint !== selection.waypoint;
  return {
    selection: changed ? next : selection,
    multiSteps: kept.length === multiSteps.length ? multiSteps : kept.length > 1 ? kept : [],
  };
}

/**
 * The status line an undo or redo puts in place of the stale one (UI_GUIDE 9.15): the entry's own
 * message when it carries one (`restore.undoStatus`), else "Undid: " or "Redid: " and what the edit
 * said it did (`label`), else "Undid the last change." An error that does not go by itself, such as a
 * failed save, stays: the undo has not made it any less true.
 */
function statusFrom(message: string | undefined, verb: "Undid" | "Redid", label: string | undefined): Partial<State> {
  topEntryFresh = false;
  const status = state.status;
  if (status !== null && status.kind === "error" && !expiring.has(status) && !statusFresh) return {};
  const said = message ?? (label === undefined ? `${verb} the last change.` : `${verb}: ${label}`);
  return { status: { kind: "ok", message: said, at: Date.now() } };
}

export function undo(): void {
  const previous = state.undo[state.undo.length - 1];
  if (previous === undefined || state.auto === null) return;
  const redo = [...state.redo, { ...entryOf(state.auto), restore: previous.restore, pinRename: previous.pinRename, pinDrop: previous.pinDrop, label: previous.label }].slice(-HISTORY_LIMIT);
  const auto = loadAuto(JSON.parse(previous.auto));
  const restored = { selection: state.selection, multiSteps: state.multiSteps, ...restoredSelection(previous.restore, auto) };
  const renamed = previous.pinRename === undefined ? undefined : { from: previous.pinRename.to, to: previous.pinRename.from };
  set({
    auto,
    project: withWaypoints(previous.waypoints),
    undo: state.undo.slice(0, -1),
    redo,
    ...reconciledSelection(restored.selection, restored.multiSteps, auto, previous.waypoints, renamed),
    ...statusFrom(previous.restore?.undoStatus, "Undid", previous.label),
  });
  if (previous.pinRename !== undefined) movePinOverride(previous.pinRename.to, previous.pinRename.from);
  if (previous.pinDrop !== undefined) setPinOverride(previous.pinDrop.name, previous.pinDrop.value);
}

export function redo(): void {
  const next = state.redo[state.redo.length - 1];
  if (next === undefined || state.auto === null) return;
  const undoStack = [...state.undo, { ...entryOf(state.auto), restore: next.restore, pinRename: next.pinRename, pinDrop: next.pinDrop, label: next.label }].slice(-HISTORY_LIMIT);
  const auto = loadAuto(JSON.parse(next.auto));
  // Redoing a delete removes the steps it had selected, so nothing stays selected. Redoing an add
  // selects the pin again, as the add did.
  const restored = {
    selection: state.selection,
    multiSteps: state.multiSteps,
    ...(next.restore === undefined
      ? {}
      : next.restore.redoSelection === undefined
        ? { selection: {}, multiSteps: [] }
        : restoredSelection(next.restore.redoSelection, auto)),
  };
  set({
    auto,
    project: withWaypoints(next.waypoints),
    undo: undoStack,
    redo: state.redo.slice(0, -1),
    ...reconciledSelection(restored.selection, restored.multiSteps, auto, next.waypoints, next.pinRename),
    ...statusFrom(next.restore?.redoStatus, "Redid", next.label),
  });
  if (next.pinRename !== undefined) movePinOverride(next.pinRename.from, next.pinRename.to);
  if (next.pinDrop !== undefined) setPinOverride(next.pinDrop.name, undefined);
}

/** `message` is the status line's; host mode says where the auto went ("Saved to DSIM."). */
export const markSaved = (canonical: string, message = "Saved."): void => {
  set({ savedCanonical: canonical, status: { kind: "ok", message, at: Date.now() } });
};

/**
 * A read-only project's own copy of an auto (the example, picked files) after Save wrote it
 * somewhere else (issue #158), so the auto opens again here with what was saved rather than the text
 * the project came with. The backend's copy is the caller's to update too (`LocalBackend.keepSavedText`).
 */
export const keepSavedAutoText = (fileName: string, canonical: string): void => {
  if (state.project === null) return;
  set({ project: { ...state.project, autoTexts: { ...state.project.autoTexts, [fileName]: canonical } } });
};

/**
 * The project's `waypoints.json` was just written as `written`, the project's own copy unless the
 * caller says otherwise, so those waypoints have no unsaved changes.
 */
export const markWaypointsSaved = (written: Waypoints | undefined = state.project?.waypoints): void => {
  set({ savedWaypoints: written });
};

/**
 * Puts a `waypoints.json` just read in place of the project's, as saved: GitHub mode reads it from
 * the open auto's work branch, which may hold a waypoint change the base branch does not.
 */
export const loadedWaypoints = (waypoints: Waypoints): void => {
  if (state.project === null) return;
  set({ project: { ...state.project, waypoints }, savedWaypoints: waypoints });
};

/* ---- Host mode ---------------------------------------------------------- */

/** Sets or patches the host session's view (`project/hostSession.ts`). */
export const setHost = (host: HostView | null): void => {
  set({ host });
};

export const patchHost = (patch: Partial<HostView>): void => {
  if (state.host === null) return;
  set({ host: { ...state.host, ...patch } });
};

/**
 * Re-publishes the open project after its list of autos changed: host mode's New auto, which passes
 * the backend's own copy, and a folder or desktop project whose first Save of a new auto wrote a
 * file, or whose folder was listed again before New auto or an import chose a name (issue #157,
 * `app/autoList.ts`), which pass the store's project with the new list. Nothing else about the
 * editor is reset.
 */
export const touchProject = (project: Project): void => {
  if (state.project === null) return;
  set({ project: { ...project, autoFiles: [...project.autoFiles] } });
};

/**
 * Puts a new `robot.json` in place of the project's, after Import commands from Java. The open
 * auto is checked against it at once, unless the auto names a robot file of its own.
 */
export const replaceProjectRobot = (robot: Robot): void => {
  if (state.project === null) return;
  const followsProject = state.autoRobot === state.project.robot;
  set({ project: { ...state.project, robot }, ...(followsProject ? { autoRobot: robot } : {}) });
};

/* ---- GitHub mode -------------------------------------------------------- */

export const setAuth = (auth: GitHubAuth | null): void => {
  set({ auth });
};

export const setRepo = (repo: RepoRef | null): void => {
  set({ repo });
};

/** Entering review mode; `null` leaves it. The editor is read only while it is set. */
export const setReview = (review: ReviewState | null): void => {
  set({ review });
};

/** True while a pull request is open: the inspector and every edit are read only (06 section 4). */
export const isReadOnly = (value: State = state): boolean => value.review !== null;

/** True when the project's `waypoints.json` has changes that are not saved (issue #134). */
export const waypointsDirty = (value: State = state): boolean =>
  value.project !== null && !sameWaypoints(value.project.waypoints, value.savedWaypoints);

/**
 * True when the document, or the project's `waypoints.json`, differs from the bytes on disk.
 * Everything that would replace the open auto asks first when this is true (`app/unsaved.ts`).
 */
export const isDirty = (value: State = state): boolean =>
  (value.auto !== null && canonicalize("auto", value.auto) !== value.savedCanonical) || waypointsDirty(value);

/* ---- View state --------------------------------------------------------- */

export const setSelection = (wanted: Selection): void => {
  // A step or marker a feature switch hides is never selected (`features.ts`).
  const selection = shownSelection(wanted, state.auto, state.prefs.features);
  const changedStep = selection.stepId !== undefined && selection.stepId !== state.selection.stepId;
  set({ selection, multiSteps: [] });
  if (changedStep) emitTourSignal("stepSelected");
};

export const selectStep = (stepId: string | undefined): void => {
  setSelection(stepId === undefined ? {} : { stepId });
};

/**
 * Shift- or Ctrl-click in the step list: adds the step to the multi-selection, or takes it out,
 * keeping the one clicked last as the primary selection.
 */
export const toggleMultiStep = (stepId: string): void => {
  const current =
    state.multiSteps.length > 0
      ? state.multiSteps
      : state.selection.stepId === undefined
        ? []
        : [state.selection.stepId];
  const next = current.includes(stepId)
    ? current.filter((id) => id !== stepId)
    : [...current, stepId];
  const primary = next[next.length - 1];
  set({
    selection: primary === undefined ? {} : { stepId: primary },
    multiSteps: next.length > 1 ? next : [],
  });
};

/**
 * Shift-click in the step list: selects `ids`, a run of rows, with `primary`, the one clicked, as
 * the primary selection (issue #505).
 */
export const selectStepRange = (ids: readonly string[], primary: string): void => {
  set({ selection: { stepId: primary }, multiSteps: ids.length > 1 ? [...ids] : [] });
};

export const setTool = (tool: Tool): void => {
  const changed = tool !== state.tool;
  set({ tool });
  if (changed) emitTourSignal("toolChanged");
};

export const setAlliance = (alliance: Alliance): void => {
  set({ alliance });
};

export const toggleAlliance = (): void => {
  set({ alliance: state.alliance === "RED" ? "BLUE" : "RED" });
  emitTourSignal("allianceToggled");
};

export const setPlayback = (playbackS: number | null): void => {
  set({ playbackS });
};

export const setPlaying = (playing: boolean): void => {
  const changed = playing !== state.playing;
  set({ playing });
  if (changed && playing) emitTourSignal("playToggled");
};

/** Loads a trace, or clears it; `streaming` while it is a Full sim run still arriving (`traceStreaming`). */
export const setTrace = (trace: Trace | null, streaming = false): void => {
  set({ trace, traceStreaming: trace !== null && streaming });
};

export const setSeverityFilter = (severityFilter: Severity | null): void => {
  set({ severityFilter });
};

/**
 * Opening a dialog closes the palette that led to it, and an old status line. Clearing one leaves the palette alone: Open
 * folder shows the project, then awaits the browser's database before it clears its dialog, and a
 * palette the person opened in between must not be taken away by that late clear.
 */
export const setDialog = (dialog: DialogKind): void => {
  set(dialog === null ? { dialog } : { dialog, paletteOpen: false });
  // A line an earlier action left would read as the answer to opening this (UI_GUIDE 9.15).
  if (dialog !== null) clearStaleStatus();
  if (dialog === "shortcuts") emitTourSignal("shortcutsOpened");
};

export const setUnsavedPrompt = (unsavedPrompt: UnsavedPrompt | null): void => {
  set({ unsavedPrompt });
};

export const setDeleteHiddenPrompt = (deleteHiddenPrompt: DeleteHiddenPrompt | null): void => {
  set({ deleteHiddenPrompt });
};

export const setPaletteOpen = (paletteOpen: boolean): void => {
  set({ paletteOpen });
  if (paletteOpen) emitTourSignal("paletteOpened");
};

export const markValidated = (): void => {
  set({ validatedAt: Date.now() });
};
