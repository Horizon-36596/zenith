/**
 * The editor's state: one immutable `Auto` document plus the four files it is read against, the
 * selection, the tool, and the view state. Undo is a stack of canonical strings, so an undo step is
 * exactly the change a `git diff` would show (site/docs/editor.md).
 *
 * A plain observable store rather than a state library: `apps/web/UI_GUIDE.md` section 1 says
 * assume no new dependencies, and React 18's `useSyncExternalStore` is all this needs.
 */
import { useCallback, useSyncExternalStore } from "react";
import { canonicalize, loadAuto } from "@horizon36596/zenith-core";
import type { Auto, Field, Robot } from "@horizon36596/zenith-schema";
import type { Severity, Trace } from "@horizon36596/zenith-core";
import type { Alliance, Selection, Tool } from "../canvas/types";
import { derive, type Derived } from "./derived";
import { DEFAULT_PREFS, applyTheme, loadPrefs, savePrefs, type Prefs, type Theme } from "./prefs";
import type { Project } from "../project/types";
import type { ProjectBackend } from "../project/backend";
import type { GitHubAuth, RepoRef } from "../github/types";
import type { ReviewState } from "../github/reviewModel";
import { emitTourSignal } from "../tour/signals";

export type DialogKind =
  | "open"
  | "simulate"
  | "robot"
  | "meta"
  /** GitHub mode (site/docs/github.md): sign in, commit, propose. */
  | "signIn"
  | "commit"
  | "propose"
  /** The keyboard shortcut and canvas gesture overlay (`?` or F1). */
  | "shortcuts"
  | null;

export interface Status {
  kind: "info" | "ok" | "error";
  message: string;
  /** Wall-clock milliseconds, only ever used to say "validated 12 s ago". */
  at: number;
}

/** The question `app/unsaved.ts` is waiting on: whose edits, and what would replace them. */
export interface UnsavedPrompt {
  fileName: string;
  /** A sentence saying what happens to the edits if the person goes on. */
  next: string;
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
  undo: string[];
  redo: string[];
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
  severityFilter: Severity | null;
  status: Status | null;
  validatedAt: number | null;
  dialog: DialogKind;
  /**
   * Save, Discard or Cancel before the open auto is replaced (QA-12). Separate from `dialog` because
   * it is asked on top of one: the GitHub tab of the open dialog stays open behind it.
   */
  unsavedPrompt: UnsavedPrompt | null;
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
  fileName: null,
  auto: null,
  autoRobot: null,
  autoField: null,
  savedCanonical: null,
  undo: [],
  redo: [],
  selection: {},
  multiSteps: [],
  tool: "select",
  alliance: "RED",
  playbackS: null,
  playing: false,
  trace: null,
  severityFilter: null,
  status: null,
  validatedAt: null,
  dialog: null,
  unsavedPrompt: null,
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

/** The whole state. Panels are small and dense; fine-grained selectors are `useSelector`. */
export const useEditor = (): State => useSyncExternalStore(subscribe, getState, getState);

export function useSelector<T>(select: (value: State) => T): T {
  const snapshot = useCallback(() => select(state), [select]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * The memoised derived view of the current document, against `autoRobot`/`autoField` rather than
 * `project.robot`/`project.field` directly, so an auto's own `robot`/`field` override (finding 23)
 * is what gets checked, the same as the CLI and MCP.
 */
export const useDerived = (): Derived => {
  const { auto, project, autoRobot, autoField } = useEditor();
  return derive(
    auto,
    autoRobot ?? project?.robot ?? null,
    autoField ?? project?.field ?? null,
    project?.waypoints,
  );
};

export const currentDerived = (): Derived =>
  derive(
    state.auto,
    state.autoRobot ?? state.project?.robot ?? null,
    state.autoField ?? state.project?.field ?? null,
    state.project?.waypoints,
  );

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

export const toggleTheme = (): void => {
  const theme: Theme = state.prefs.theme === "dark" ? "light" : "dark";
  setPrefs({ theme });
};

/** Chooses the playback level (site/docs/simulation.md), remembered with the other preferences. */
export const setPlaybackLevel = (playbackLevel: Prefs["playbackLevel"]): void => {
  setPrefs({ playbackLevel });
};

export const toggleSnap = (): void => {
  setPrefs({ snap: !state.prefs.snap });
  emitTourSignal("snapToggled");
};

/* ---- Status ------------------------------------------------------------- */

export const setStatus = (kind: Status["kind"], message: string): void => {
  set({ status: { kind, message, at: Date.now() } });
};

export const clearStatus = (): void => {
  set({ status: null });
};

export const setBusy = (busy: boolean): void => {
  set({ busy });
};

/* ---- Project and document ----------------------------------------------- */

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
    undo: [],
    redo: [],
    selection: {},
    multiSteps: [],
    trace: null,
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
    undo: [],
    redo: [],
    selection: {},
    multiSteps: [],
    trace: null,
  });
};

/**
 * The document a transaction (`beginTransaction`/`endTransaction`) started from, canonicalized, or
 * `null` when there is no transaction open. Every `commit` while one is open behaves like
 * `history: false`; `endTransaction` is what turns the whole span into a single undo entry.
 */
let transactionBase: string | null = null;

/**
 * Opens a transaction: every `commit` up to the matching `endTransaction` becomes part of one undo
 * step instead of one each, which is what makes a canvas drag a single undo entry regardless of how
 * long it runs or how many pointer-move frames it produces (unlike the old time-window coalescing,
 * which produced a new entry whenever two edits landed more than `DRAG_WINDOW_MS` apart). Nested
 * calls are a no-op: only the outermost pair matters.
 */
export function beginTransaction(): void {
  if (state.auto === null || transactionBase !== null) return;
  transactionBase = canonicalize("auto", state.auto);
}

/** Closes the transaction, pushing one undo entry for the whole span, or none if nothing changed. */
export function endTransaction(): void {
  const base = transactionBase;
  transactionBase = null;
  if (base === null || state.auto === null) return;
  if (canonicalize("auto", state.auto) === base) return;
  const undo = [...state.undo, base].slice(-HISTORY_LIMIT);
  set({ undo, redo: [] });
  // A transaction that changed something is a drag on the canvas: what the tour's first stop asks for.
  emitTourSignal("pointDragged");
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
  if (options.history === false || transactionBase !== null) {
    set({ auto: next, redo: [] });
    return;
  }
  const undo = [...state.undo, canonicalize("auto", current)].slice(-HISTORY_LIMIT);
  set({ auto: next, undo, redo: [] });
}

export function undo(): void {
  const previous = state.undo[state.undo.length - 1];
  if (previous === undefined || state.auto === null) return;
  const redo = [...state.redo, canonicalize("auto", state.auto)].slice(-HISTORY_LIMIT);
  set({ auto: loadAuto(JSON.parse(previous)), undo: state.undo.slice(0, -1), redo });
}

export function redo(): void {
  const next = state.redo[state.redo.length - 1];
  if (next === undefined || state.auto === null) return;
  const undoStack = [...state.undo, canonicalize("auto", state.auto)].slice(-HISTORY_LIMIT);
  set({ auto: loadAuto(JSON.parse(next)), undo: undoStack, redo: state.redo.slice(0, -1) });
}

export const markSaved = (canonical: string): void => {
  set({ savedCanonical: canonical, status: { kind: "ok", message: "Saved.", at: Date.now() } });
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

/**
 * True when the document differs from the bytes on disk. Everything that would replace the open
 * auto asks first when this is true (`app/unsaved.ts`).
 */
export const isDirty = (value: State = state): boolean =>
  value.auto !== null && canonicalize("auto", value.auto) !== value.savedCanonical;

/* ---- View state --------------------------------------------------------- */

export const setSelection = (selection: Selection): void => {
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

export const setTrace = (trace: Trace | null): void => {
  set({ trace });
};

export const setSeverityFilter = (severityFilter: Severity | null): void => {
  set({ severityFilter });
};

export const setDialog = (dialog: DialogKind): void => {
  set({ dialog, paletteOpen: false });
  if (dialog === "shortcuts") emitTourSignal("shortcutsOpened");
};

export const setUnsavedPrompt = (unsavedPrompt: UnsavedPrompt | null): void => {
  set({ unsavedPrompt });
};

export const setPaletteOpen = (paletteOpen: boolean): void => {
  set({ paletteOpen });
  if (paletteOpen) emitTourSignal("paletteOpened");
};

export const markValidated = (): void => {
  set({ validatedAt: Date.now() });
};
