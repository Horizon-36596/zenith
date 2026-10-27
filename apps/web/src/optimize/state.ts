/**
 * The Optimize card's state (issue #308): which path step it is open on, its options, the run in
 * progress through the host (`host.ts`), and the result it shows. `OptimizeCard.tsx` draws it, the
 * field draws its preview (`preview.ts`), and Apply writes the pick in one `tryEdit`.
 *
 * The card never writes anything else. The candidate lives here and only here: it never enters the
 * undo history, the saved file or a cloud revision, and Discard leaves the auto at the same object.
 *
 * - **Options.** The margin starts at the robot's clearance (owner ruling D8) and may be changed for
 *   this run only: it is kept here and never saved. Score with, Allow several paths and Allow
 *   heading ranges are the person's remembered choices, read and written through the settings
 *   registry (`optimizer.scorer`, `optimizer.allowSplit`, `optimizer.allowRanges`, and the heading
 *   holds `optimizer.holdStartHeadingIn` and `optimizer.holdEndHeadingIn`, issue #448).
 * - **The margin field re-runs.** Once a run has started, a change to the margin cancels it and
 *   starts another `MARGIN_RERUN_MS` after the last change.
 * - **Staleness.** An edit to the auto, or to a project file it is checked against, while the card is
 *   open cancels the run (the host does that) and marks the result stale: the card says "The auto
 *   changed. Run again." and Apply does nothing.
 * - **Finding actions.** A finding's Route around or Find a faster heading opens the card on its step
 *   and runs at once (`openOptimizeFix`); the card keeps the action's words (issue #309).
 * - **A blocked original** (issue #388). Every run, from any entry point, applies the Route around
 *   rule on its own: when the step as written goes through something (`OptimizeResult.originalBlocked`),
 *   the pick is the fastest clear route even when it is slower, the card's result line is its first
 *   change sentence, which says so, and Optimize every path counts it as cleared, not as time saved.
 * - **The switch.** With Optimize path off the card does not open, and turning it off closes it.
 * - **Add a clear path here** (issue #310). The field's right-click item opens the card on a
 *   draft (`clearPath.ts`): the open auto with a path step added from where the robot is to the
 *   point. The run optimizes the draft in Route around mode; Apply writes the chosen route as one
 *   new step, or, with Extend this chain on, as more paths of the selected chain, in one undo step.
 *   When the straight path is already clear and nothing is faster, Apply adds it as it is.
 * - **Alternatives.** A result's pick and its alternatives, each of which passed the final check,
 *   are the routes the card's switcher steps through (`choice`); the field draws the one shown and
 *   Apply writes it. Every new result starts again from the pick.
 * - **Optimize every path** (issue #366). The same card runs Optimize path on every path step of the
 *   open auto in document order, one after another through the same host, each between its own two
 *   ends and against the auto as it is, and lists each step's result with the total time saved.
 *   Nothing changes until Apply, which writes every accepted pick in one undo step. A safety stop on
 *   one step takes its best so far and goes on to the next; Stop ends the whole run with the results
 *   it has.
 */
import { useSyncExternalStore } from "react";
import {
  joinSteps,
  robotClearanceIn,
  setRoute,
  type Fix,
  type OptimizedRoute,
  type OptimizeMode,
  type OptimizeOptions,
  type OptimizeProgress,
  type OptimizeResult,
} from "@horizon36596/zenith-core";
import type { Auto, Heading, PathStep } from "@horizon36596/zenith-schema";
import { tryEdit, undoWords } from "../app/edits";
import { findEntry, indexSteps } from "../lib/stepOps";
import { getSetting } from "../settings/registry";
import { getState, selectStep, setSelection, setStatus, subscribeEditor, type State } from "../state/store";
import { CLEAR_PATH_LABEL, clearPathBlocked, clearPathDraft, type ClearPathDraft, type ClearPathTarget } from "./clearPath";
import { editsSince } from "./editorEdits";
import { EDITED_REASON, startOptimize, type EditWatch, type OptimizeEvents, type OptimizeRun, type StopReason } from "./host";
import type { OptimizeRequest } from "./protocol";

/** How long after the last change to the margin the card runs again, in milliseconds (SET BY HAND: issue #308). */
export const MARGIN_RERUN_MS = 300;

/** The one-run margin's range and step, in inches (SET BY HAND: spec 16 section 4.1). */
export const MARGIN_MIN_IN = 0;
export const MARGIN_MAX_IN = 6;
export const MARGIN_STEP_IN = 0.25;

/**
 * - `options`: the options, before a run;
 * - `running`: searching, with progress; `stopping`: Stop was sent and the answer is awaited;
 * - `result`: a result is shown (`paused` when it came from a stop, so Continue goes on);
 * - `failed`: no result, and `message` says why.
 */
export type CardPhase = "options" | "running" | "stopping" | "result" | "failed";

/**
 * What a finding asked for, when the card was opened by one (spec 16 section 8.3): the button's own
 * words, and whether the run routes around a collision. Find a faster heading is not a route around,
 * it keeps the segments, so its `routeAround` is false and its mode is `headingOnly`.
 */
export interface OptimizeAction {
  label: string;
  routeAround: boolean;
}

export interface OptimizeCardState {
  /** The path step the card is open on. */
  stepId: string;
  mode: OptimizeMode;
  /** The finding action that opened the card, or null when the palette or the Inspector did. */
  action: OptimizeAction | null;
  phase: CardPhase;
  /** The margin for this run, in inches: the robot's clearance until changed here. Never saved. */
  marginIn: number;
  /** The robot's own clearance, which the field starts at. */
  robotMarginIn: number;
  progress: OptimizeProgress | null;
  result: OptimizeResult | null;
  /** True while a stopped run waits: Continue goes on from where it stopped. */
  paused: boolean;
  /** Why the shown result stopped: the person's Stop or the safety stop's time box; null when the search ended on its own. */
  stopReason: StopReason | null;
  /** True once Search longer has run, so a later time box says it searched more, not for the first time. */
  continued: boolean;
  /** True once the auto changed since the shown run started: Apply does nothing. */
  stale: boolean;
  /** Why the card has no result, or that the result is stale; null for none. */
  message: string | null;
  /** The clear path the card was opened on (Add a clear path here), or null for a step of the open auto. */
  draft: ClearPathDraft | null;
  /** Which of the result's routes is shown and would be applied: 0 for the pick, then each alternative. */
  choice: number;
  /** Optimize every path's run, or null when the card is on one step. */
  all: OptimizeAllState | null;
}

/** One step's outcome in Optimize every path. */
export interface OptimizeAllStep {
  stepId: string;
  /** The step's result, or null when its run failed, and then `message` says why. */
  result: OptimizeResult | null;
  message: string | null;
  /** Whether Apply writes this step's pick. Only a step with a pick can be accepted. */
  accepted: boolean;
  /** Why this step's search stopped: the safety stop's time box or the person's Stop; null when it ended on its own or failed. */
  stopReason?: StopReason | null;
}

/** Optimize every path (issue #366): the path steps in document order, which one runs, and the results so far. */
export interface OptimizeAllState {
  stepIds: string[];
  /** The step running now, as an index into `stepIds`. */
  index: number;
  results: OptimizeAllStep[];
  /** The step Try again runs once more on its own, whose result replaces its row; null for the whole run. */
  retry?: string | null;
}

/** Starts a run: the host's `startOptimize`, or a test's stand-in. */
export type OptimizeStarter = (
  request: OptimizeRequest,
  options: OptimizeOptions,
  events: OptimizeEvents,
  host: { edits?: EditWatch },
) => OptimizeRun;

const hostStarter: OptimizeStarter = (request, options, events, host) => startOptimize(request, options, events, host);

let starter: OptimizeStarter = hostStarter;
let card: OptimizeCardState | null = null;
let run: OptimizeRun | null = null;
/** Bumped for every run and every cancel, so a late event from an old run changes nothing. */
let token = 0;
/** The watch on the document the shown run started on; null before a run. */
let watch: EditWatch | null = null;
let rerun: ReturnType<typeof setTimeout> | null = null;
let unsubscribeEditor: (() => void) | null = null;

const listeners = new Set<() => void>();

const emit = (): void => {
  for (const listener of listeners) listener();
};

const patch = (next: Partial<OptimizeCardState>): void => {
  if (card === null) return;
  card = { ...card, ...next };
  emit();
};

/** The card now, outside React; null while it is closed. */
export const getOptimizeCard = (): OptimizeCardState | null => card;

/** Calls `listener` after every change to the card. Returns the unsubscribe. */
export function subscribeOptimize(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The card, for a component; it draws again on every change. */
export const useOptimizeCard = (): OptimizeCardState | null => useSyncExternalStore(subscribeOptimize, getOptimizeCard, getOptimizeCard);

/** For tests: replaces the host. Null puts the real one back. */
export function setOptimizeStarter(next: OptimizeStarter | null): void {
  starter = next ?? hostStarter;
}

const robotOf = (state: State) => state.autoRobot ?? state.project?.robot ?? null;
const fieldOf = (state: State) => state.autoField ?? state.project?.field ?? null;

/** Whether `stepId` names a path step of the open auto, at any depth. */
function isPathStep(state: State, stepId: string | undefined): stepId is string {
  if (state.auto === null || stepId === undefined) return false;
  return findEntry(state.auto, stepId)?.step.kind === "path";
}

/**
 * The routes a result offers, in the switcher's order: the pick, then each alternative. Every one
 * passed the final check; an alternative the gate between models labels "Faster in the instant
 * sim, slower in the estimate" is one the person may still choose, never the default. A result
 * with no pick offers none, so such an alternative is never the only route Apply could write.
 */
export function optimizeRoutes(value: OptimizeCardState | null): OptimizedRoute[] {
  const result = value?.result ?? null;
  if (result === null || result.pick === null) return [];
  return [result.pick, ...result.alternatives];
}

/** The route the card shows and Apply writes, or null when the result has none. */
export function chosenRoute(value: OptimizeCardState | null): OptimizedRoute | null {
  const routes = optimizeRoutes(value);
  return routes[Math.min(value?.choice ?? 0, routes.length - 1)] ?? null;
}

/**
 * The path step Apply would write: the chosen route, or, on a clear path whose straight line is
 * already clear and nothing is faster, the draft step as it is. Null when there is none.
 */
export function stepToApply(value: OptimizeCardState | null): PathStep | null {
  const route = chosenRoute(value);
  if (route !== null) return route.step;
  const draft = value?.draft ?? null;
  if (draft === null || value?.result?.status !== "noBetter") return null;
  const step = findEntry(draft.auto, draft.stepId)?.step;
  return step?.kind === "path" ? step : null;
}

/** Shows route `index` of the result: 0 for the pick, then each alternative. Out of range does nothing. */
export function chooseOptimizeRoute(index: number): void {
  if (card === null || !Number.isInteger(index) || index < 0 || index >= optimizeRoutes(card).length) return;
  patch({ choice: index });
}

/** The next route (1) or the one before (-1), round from the last to the pick and back. */
export function stepOptimizeRoute(delta: 1 | -1): void {
  const count = optimizeRoutes(card).length;
  if (card === null || count < 2) return;
  patch({ choice: (card.choice + delta + count) % count });
}

/** Why Optimize path cannot open now, or null when it can: the palette's and the button's reason. */
export function optimizeBlockedReason(state: State): string | null {
  if (state.auto === null) return "Open an auto first.";
  if (state.review !== null) return "Review mode is read only.";
  if (!isPathStep(state, state.selection.stepId)) return "Select a path step first.";
  // The search runs against the auto's robot; with none known there is nothing to run it with.
  if (robotOf(state) === null) return "Open a project with a robot first.";
  return null;
}

const cancelRun = (): void => {
  token += 1;
  run?.cancel();
  run = null;
  if (rerun !== null) clearTimeout(rerun);
  rerun = null;
};

/** After every change to the editor: a closed switch closes the card, and an edit makes its result stale. */
function onEditorChange(): void {
  if (card === null) return;
  if (!getState().prefs.features.optimizer) {
    // The switch going off closes the card; its own setting's line is the answer, not "Discarded".
    closeCard();
    return;
  }
  if (!card.stale && watch !== null && watch.changed()) patch({ stale: true, message: EDITED_REASON });
}

/**
 * Opens the card on `stepId`, the selected step by default. With `withOptions` it shows the options
 * first; without, it runs at once. False, with a status line, when the step is not a path, and
 * false with nothing said while the Optimize path switch is off.
 */
export function openOptimize(options: { stepId?: string; withOptions?: boolean; mode?: OptimizeMode; action?: OptimizeAction } = {}): boolean {
  const state = getState();
  if (!state.prefs.features.optimizer) return false;
  const stepId = options.stepId ?? state.selection.stepId;
  const robot = robotOf(state);
  if (!isPathStep(state, stepId) || robot === null || state.review !== null) {
    setStatus("info", optimizeBlockedReason({ ...state, selection: { stepId } }) ?? "Select a path step first.");
    return false;
  }
  cancelRun();
  watch = null;
  const marginIn = robotClearanceIn(robot);
  card = {
    stepId,
    mode: options.mode ?? "routeAndHeading",
    action: options.action ?? null,
    phase: "options",
    marginIn,
    robotMarginIn: marginIn,
    progress: null,
    result: null,
    paused: false,
    stopReason: null,
    continued: false,
    stale: false,
    message: null,
    draft: null,
    choice: 0,
    all: null,
  };
  unsubscribeEditor ??= subscribeEditor(onEditorChange);
  emit();
  if (options.withOptions !== true) runOptimizeCard();
  return true;
}

/**
 * Add a clear path here (issue #310): opens the card on a draft path from where the robot is to
 * `target`, or from the end of the selected chain with Extend this chain on, and runs at once in
 * Route around mode with both ends fixed. The open auto is not touched. False, with a status line
 * saying why, when there can be no draft, and false with nothing said while the switch is off.
 */
export function openClearPath(target: ClearPathTarget): boolean {
  const state = getState();
  if (!state.prefs.features.optimizer) return false;
  const robot = robotOf(state);
  const draft = clearPathDraft(target);
  if (typeof draft === "string" || robot === null) {
    setStatus("info", typeof draft === "string" ? draft : "Open a project with a robot first.");
    return false;
  }
  // A spot no route can reach clear is refused at once, not after a search (0.1.2 UX review).
  const blocked = clearPathBlocked(draft);
  if (blocked !== null) {
    setStatus("warn", blocked);
    return false;
  }
  cancelRun();
  watch = null;
  const marginIn = robotClearanceIn(robot);
  card = {
    stepId: draft.stepId,
    mode: "routeAndHeading",
    action: { label: CLEAR_PATH_LABEL, routeAround: true },
    phase: "options",
    marginIn,
    robotMarginIn: marginIn,
    progress: null,
    result: null,
    paused: false,
    stopReason: null,
    continued: false,
    stale: false,
    message: null,
    draft,
    choice: 0,
    all: null,
  };
  unsubscribeEditor ??= subscribeEditor(onEditorChange);
  emit();
  runOptimizeCard();
  return true;
}

/**
 * A finding's `optimizeRoute` fix (spec 16 section 8.3): selects the step, then opens the card on it
 * and runs at once. Without `mode` that is Route around, which accepts a clear route whatever its
 * time when the step collides; `mode: "headingOnly"` is Find a faster heading, which keeps the
 * segments. False, with nothing opened, for any other fix, for a step that is not a path, and while
 * the Optimize path switch is off (the finding does not show the button then either).
 */
export function openOptimizeFix(fix: Fix): boolean {
  if (fix.kind !== "optimizeRoute") return false;
  const state = getState();
  if (!state.prefs.features.optimizer || !isPathStep(state, fix.stepId)) return false;
  const headingOnly = fix.params.mode === "headingOnly";
  selectStep(fix.stepId);
  return openOptimize({
    stepId: fix.stepId,
    mode: headingOnly ? "headingOnly" : "routeAndHeading",
    action: { label: fix.label, routeAround: !headingOnly },
  });
}

/** A clear path's draft built again on the open auto as it is now, for the same point; null when it cannot be. */
function redraft(draft: ClearPathDraft): ClearPathDraft | null {
  const next = clearPathDraft(draft.target);
  return typeof next === "string" ? null : next;
}

/** The heading holds the person last chose (issue #448), each only when it is on, so a run without them keeps its key. */
function holdOptions(state: State): Pick<OptimizeOptions, "holdStartHeadingIn" | "holdEndHeadingIn"> {
  const startIn = getSetting(state.prefs, "optimizer.holdStartHeadingIn");
  const endIn = getSetting(state.prefs, "optimizer.holdEndHeadingIn");
  return { ...(startIn > 0 ? { holdStartHeadingIn: startIn } : {}), ...(endIn > 0 ? { holdEndHeadingIn: endIn } : {}) };
}

/** The run's options: the card's margin and mode, and the person's remembered choices. */
function optionsOf(state: State, value: OptimizeCardState): OptimizeOptions {
  return {
    marginIn: value.marginIn,
    scorer: getSetting(state.prefs, "optimizer.scorer"),
    mode: value.mode,
    allowSplit: getSetting(state.prefs, "optimizer.allowSplit"),
    allowRanges: getSetting(state.prefs, "optimizer.allowRanges"),
    ...holdOptions(state),
    ...(value.action?.routeAround === true ? { routeAround: true } : {}),
  };
}

/** The ids of every path step of `auto`, at any depth, in document order. */
export const pathStepIds = (auto: Auto): string[] => indexSteps(auto).filter((entry) => entry.step.kind === "path").map((entry) => entry.id);

/** Why Optimize every path cannot open now, or null when it can. */
export function optimizeAllBlockedReason(state: State): string | null {
  if (state.auto === null) return "Open an auto first.";
  if (state.review !== null) return "Review mode is read only.";
  if (robotOf(state) === null) return "Open a project with a robot first.";
  if (pathStepIds(state.auto).length === 0) return "This auto has no path step.";
  return null;
}

/**
 * Optimize every path (issue #366): opens the card on every path step of the open auto and runs
 * them one after another at once. False, with a status line saying why, when it cannot run, and
 * false with nothing said while the Optimize path switch is off.
 */
export function openOptimizeAll(): boolean {
  const state = getState();
  if (!state.prefs.features.optimizer) return false;
  const robot = robotOf(state);
  const why = optimizeAllBlockedReason(state);
  if (why !== null || robot === null || state.auto === null) {
    setStatus("info", why ?? "Open an auto first.");
    return false;
  }
  cancelRun();
  watch = null;
  const stepIds = pathStepIds(state.auto);
  const marginIn = robotClearanceIn(robot);
  card = {
    stepId: stepIds[0] ?? "",
    mode: "routeAndHeading",
    action: null,
    phase: "options",
    marginIn,
    robotMarginIn: marginIn,
    progress: null,
    result: null,
    paused: false,
    stopReason: null,
    continued: false,
    stale: false,
    message: null,
    draft: null,
    choice: 0,
    all: { stepIds, index: 0, results: [] },
  };
  unsubscribeEditor ??= subscribeEditor(onEditorChange);
  emit();
  runOptimizeCard();
  return true;
}

/** Starts Optimize every path again from its first step, on the open auto as it is now. */
function startAll(): void {
  const state = getState();
  if (card === null || state.auto === null) return;
  cancelRun();
  const stepIds = pathStepIds(state.auto);
  watch = null;
  patch({ all: { stepIds, index: 0, results: [] }, stale: false, message: null, result: null, paused: false, stopReason: null, continued: false });
  runAllStep();
}

/** Ends Optimize every path's run with the results it has. */
function finishAll(message: string | null = null, stale = false): void {
  cancelRun();
  patch({ phase: "result", progress: null, paused: false, stopReason: null, message, stale: stale || card?.stale === true });
}

/**
 * Records the result of the step that ran and starts the next one, or ends the run after the last.
 * A Try again's result replaces its step's row, and the run ends there.
 */
function recordAll(result: OptimizeResult | null, message: string | null, next: boolean, stopReason: StopReason | null = null): void {
  const all = card?.all ?? null;
  if (all === null) return;
  const stepId = all.stepIds[all.index] ?? "";
  const row: OptimizeAllStep = { stepId, result, message, accepted: result?.pick != null, stopReason };
  if (all.retry != null) {
    const retried = all.retry;
    const results = all.results.map((step) => (step.stepId === retried ? row : step));
    patch({ all: { ...all, index: all.stepIds.length, results, retry: null } });
    finishAll();
    return;
  }
  const results = [...all.results, row];
  patch({ all: { ...all, index: all.index + 1, results } });
  if (next) runAllStep();
  else finishAll();
}

/** Whether Try again can run `stepId`'s row of Optimize every path now: a failed row, on a result that is not stale. */
export function canRetryOptimizeStep(value: OptimizeCardState | null, stepId: string): boolean {
  const step = value?.all?.results.find((row) => row.stepId === stepId);
  return value !== null && value.phase === "result" && !value.stale && step !== undefined && step.result === null;
}

/**
 * Try again on one failed row of Optimize every path (0.1.2 UX review): runs that step alone against
 * the open auto, and its result replaces the row. The other rows and their ticks stay as they are.
 */
export function retryOptimizeStep(stepId: string): void {
  const all = card?.all ?? null;
  if (card === null || all === null || !canRetryOptimizeStep(card, stepId)) return;
  const index = all.stepIds.indexOf(stepId);
  if (index < 0) return;
  patch({ all: { ...all, index, retry: stepId }, message: null });
  runAllStep();
}

/** Runs the step of Optimize every path that is next, against the open auto. */
function runAllStep(): void {
  const all = card?.all ?? null;
  if (card === null || all === null) return;
  const state = getState();
  const robot = robotOf(state);
  const field = fieldOf(state);
  const stepId = all.stepIds[all.index];
  if (stepId === undefined) {
    finishAll();
    return;
  }
  if (state.auto === null || robot === null || field === null) {
    cancelRun();
    patch({ phase: "failed", message: "Open an auto first.", progress: null });
    return;
  }
  if (watch !== null && watch.changed()) {
    finishAll(EDITED_REASON, true);
    return;
  }
  cancelRun();
  const request: OptimizeRequest = {
    auto: state.auto,
    robot,
    field,
    ...(state.project?.waypoints === undefined ? {} : { waypoints: state.project.waypoints }),
    stepId,
    withSeason: true,
  };
  // One watch for the whole run, on the auto it started on: any edit after that makes it stale.
  watch ??= editsSince(request);
  const mine = token;
  const current = (): boolean => mine === token && card?.all !== null && card !== null;
  patch({ phase: "running", stepId, progress: null });
  run = starter(request, optionsOf(state, card), {
    progress: (progress) => {
      if (current()) patch({ progress });
    },
    stopped: (result, why) => {
      if (!current()) return;
      // A safety stop takes this step's best so far and goes on; the person's Stop ends the run.
      recordAll(result, null, why === "safety", why);
    },
    done: (result) => {
      if (!current()) return;
      run = null;
      recordAll(result, null, true);
    },
    failed: (message) => {
      if (!current()) return;
      run = null;
      recordAll(null, message, true);
    },
    cancelled: (reason) => {
      if (!current()) return;
      run = null;
      finishAll(reason, reason === EDITED_REASON);
    },
  }, { edits: watch });
}

/** The steps of Optimize every path that Apply would write: accepted, with a pick. */
const acceptedSteps = (value: OptimizeCardState | null): OptimizeAllStep[] =>
  value?.all?.results.filter((step) => step.accepted && step.result?.pick != null) ?? [];

/**
 * Whether a step's run went round an original that `check()` finds going through something (issue
 * #388): its pick is a fix, the fastest clear route, and its time against the blocked original is
 * not a saving.
 */
const isCleared = (step: OptimizeAllStep): boolean => step.result?.pick != null && step.result.originalBlocked !== null;

/** Seconds a step's pick saves, under the model its run was scored with; 0 for a cleared step, which is a fix, not a saving. */
export function savedS(step: OptimizeAllStep): number {
  const result = step.result;
  if (result === null || result.pick === null || isCleared(step)) return 0;
  const { before, after } = timesOf(result, result.pick);
  return before - after;
}

/** The total time the accepted steps save, in seconds. */
export const totalSavedS = (value: OptimizeCardState | null): number => acceptedSteps(value).reduce((sum, step) => sum + savedS(step), 0);

/** How many accepted steps clear an original that went through something (issue #388). */
export const clearedCount = (value: OptimizeCardState | null): number => acceptedSteps(value).filter(isCleared).length;

const blockedPaths = (count: number): string => `${String(count)} blocked ${count === 1 ? "path" : "paths"}`;

/** Optimize every path's last line: how many paths it searched, the time the ticked ones save, and how many blocked paths they clear. */
export function allTotalLine(value: OptimizeCardState | null): string {
  const all = value?.all ?? null;
  // A row whose run failed has no result, so it was not searched: it is counted apart, with Try again.
  const failed = all?.results.filter((step) => step.result === null).length ?? 0;
  const done = (all?.results.length ?? 0) - failed;
  const searched = `${String(done)} of ${String(all?.stepIds.length ?? 0)} paths searched${failed === 0 ? "" : `, ${String(failed)} failed`}.`;
  const cleared = clearedCount(value);
  // With no pick anywhere every box is disabled and nothing is ticked, so a total of 0.00 s for "the
  // ticked ones" says nothing (W2-13): say that no faster route was found.
  if (all !== null && !all.results.some((step) => step.result?.pick != null)) {
    // With every path failed nothing was searched, so there is nothing to say was not found.
    return done === 0 ? searched : `${searched} No faster routes found.`;
  }
  return `${searched} The ticked ones save ${totalSavedS(value).toFixed(2)} s in all${cleared === 0 ? "" : ` and clear ${blockedPaths(cleared)}`}.`;
}

/** Accepts or leaves out one step's pick in Optimize every path's result. A step without a pick stays out. */
export function setOptimizeAllAccepted(stepId: string, accepted: boolean): void {
  const all = card?.all ?? null;
  if (all === null) return;
  const results = all.results.map((step) => (step.stepId === stepId ? { ...step, accepted: accepted && step.result?.pick != null } : step));
  patch({ all: { ...all, results } });
}

/** Runs, or runs again, with the card's options on the open auto as it is now. */
export function runOptimizeCard(): void {
  if (card === null) return;
  if (card.all !== null) {
    startAll();
    return;
  }
  const state = getState();
  const robot = robotOf(state);
  const field = fieldOf(state);
  // A clear path runs again on a fresh draft of the same point, so it follows any edit made since.
  const wasDraft = card.draft !== null;
  const draft = card.draft === null || card.draft.base === state.auto ? card.draft : redraft(card.draft);
  if (wasDraft && draft === null) {
    cancelRun();
    patch({ phase: "failed", message: "A clear path cannot be added here now.", result: null, progress: null });
    return;
  }
  if (draft !== card.draft && draft !== null) patch({ draft, stepId: draft.stepId });
  const target = draft === null ? state.auto : draft.auto;
  const valid = draft === null ? isPathStep(state, card.stepId) : findEntry(draft.auto, draft.stepId)?.step.kind === "path";
  if (target === null || robot === null || field === null || !valid) {
    cancelRun();
    patch({ phase: "failed", message: "The step is no longer a path in this auto.", result: null, progress: null });
    return;
  }
  cancelRun();
  const request: OptimizeRequest = {
    auto: target,
    robot,
    field,
    ...(state.project?.waypoints === undefined ? {} : { waypoints: state.project.waypoints }),
    stepId: card.stepId,
    // The season rules field.json names, as the editor's own preview runs with.
    withSeason: true,
  };
  const options = optionsOf(state, card);
  const mine = token;
  const current = (): boolean => mine === token && card !== null;
  watch = editsSince(request, draft?.base ?? target);
  patch({ phase: "running", progress: null, result: null, paused: false, stopReason: null, continued: false, stale: false, message: null });
  run = starter(request, options, {
    progress: (progress) => {
      if (current()) patch({ progress });
    },
    stopped: (result, why) => {
      if (current()) patch({ phase: "result", result, paused: true, stopReason: why, choice: 0 });
    },
    done: (result) => {
      if (!current()) return;
      run = null;
      patch({ phase: "result", result, paused: false, stopReason: null, choice: 0 });
    },
    failed: (message) => {
      if (!current()) return;
      run = null;
      patch({ phase: "failed", message, paused: false });
    },
    cancelled: (reason) => {
      if (!current()) return;
      run = null;
      patch({ phase: card?.result === null ? "failed" : "result", stale: reason === EDITED_REASON || card?.stale === true, message: reason, paused: false });
    },
  }, { edits: watch });
}

/** Asks for the best so far and pauses there. */
export function stopOptimize(): void {
  if (card?.phase !== "running" || run === null) return;
  run.stop();
  patch({ phase: "stopping" });
}

/** Goes on after a stop, from where it stopped. */
export function continueOptimize(): void {
  if (card === null || !card.paused || run === null || card.stale) return;
  run.continue();
  patch({ phase: "running", paused: false, stopReason: null, continued: true });
}

/** The margin for this run, kept to 0 to 6 in by 0.25 in. Once a run has started, it runs again after the debounce. */
export function setOptimizeMargin(marginIn: number): void {
  if (card === null || !Number.isFinite(marginIn)) return;
  const kept = Math.min(MARGIN_MAX_IN, Math.max(MARGIN_MIN_IN, Math.round(marginIn / MARGIN_STEP_IN) * MARGIN_STEP_IN));
  if (card.phase === "options") {
    patch({ marginIn: kept });
    return;
  }
  // The old run and its result are for the old margin: they go now, not when the new run starts.
  cancelRun();
  rerun = setTimeout(() => {
    rerun = null;
    runOptimizeCard();
  }, MARGIN_RERUN_MS);
  patch({ marginIn: kept, phase: "running", progress: null, result: null, paused: false, stopReason: null, continued: false, stale: false, message: null });
}

const headingOf = (heading: Heading | undefined): Heading => heading ?? { mode: "tangent" };

/** The route's times under the model the run was scored with, and that model's name. */
function timesOf(result: OptimizeResult, route: OptimizedRoute): { before: number; after: number; model: string } {
  const sim = result.scorer === "sim" && route.t1 !== null;
  const times = sim && route.t1 !== null ? route.t1 : route.t0;
  return { before: times.before.ownS, after: times.after.ownS, model: sim ? "instant sim" : "estimate" };
}

/**
 * "Optimized toOtherSide: 2.59 s → 2.48 s (instant sim).", by the times the run was scored with,
 * for `route`, the pick unless the switcher shows another. Round an original that went through
 * something (issue #388) it says "Routed toOtherSide clear of the west base bar of the hive frame:
 * 3.18 s → 3.86 s (estimate).", since the new route may be slower.
 */
export function appliedLine(result: OptimizeResult, route: OptimizedRoute | null = result.pick): string | null {
  if (route === null) return null;
  const { before, after, model } = timesOf(result, route);
  const what = result.originalBlocked === null ? `Optimized ${result.stepId}` : `Routed ${result.stepId} clear of ${result.originalBlocked.label}`;
  return `${what}: ${before.toFixed(2)} s → ${after.toFixed(2)} s (${model}).`;
}

/**
 * The status line for a clear path: "Added path3, a clear path to here: 2.41 s (instant sim).", or
 * "Added 2 paths to driveOut, …" when it extends a chain. A straight path that was already clear
 * says so instead of a time.
 */
export function clearPathLine(draft: ClearPathDraft, result: OptimizeResult, route: OptimizedRoute | null, pathCount: number): string {
  const what = draft.chainId === null ? `Added ${draft.stepId}` : `Added ${String(pathCount)} ${pathCount === 1 ? "path" : "paths"} to ${draft.chainId}`;
  if (route === null) return `${what}, a clear path to here: the straight path is already clear, and nothing was faster.`;
  const { after, model } = timesOf(result, route);
  return `${what}, a clear path to here: ${after.toFixed(2)} s (${model}).`;
}

/** Whether Apply would write something now: a route, on a result that is not stale. */
export const canApply = (value: OptimizeCardState | null): boolean =>
  value !== null &&
  value.phase === "result" &&
  !value.stale &&
  (value.all === null ? stepToApply(value) !== null : acceptedSteps(value).length > 0);

/**
 * "Optimized 3 paths: 1.20 s faster in all.", for Optimize every path's accepted steps, or null for
 * none. Paths that went through something and are now clear are counted apart (issue #388):
 * "Optimized 3 paths: 1.20 s faster in all, and 1 blocked path cleared.", or "Optimized 1 path: 1
 * blocked path cleared." when they are all there is.
 */
export function appliedAllLine(value: OptimizeCardState | null): string | null {
  const count = acceptedSteps(value).length;
  if (count === 0) return null;
  const cleared = clearedCount(value);
  const faster = `${totalSavedS(value).toFixed(2)} s faster in all`;
  const parts = cleared === 0 ? faster : cleared === count ? `${blockedPaths(cleared)} cleared` : `${faster}, and ${blockedPaths(cleared)} cleared`;
  return `Optimized ${String(count)} ${count === 1 ? "path" : "paths"}: ${parts}.`;
}

/**
 * An Apply line with how to undo it, in the person's own Undo key, as the one-click fixes' lines
 * end (0.1.2 UX sweep W2-22): "... (estimate). Press Ctrl Z to undo."
 */
function withUndo(line: string): string {
  const undo = undoWords();
  return `${line} ${undo.charAt(0).toUpperCase()}${undo.slice(1)}.`;
}

/** Apply on Optimize every path: every accepted pick, written in one undo step. */
function applyAll(): void {
  const steps = acceptedSteps(card);
  const line = appliedAllLine(card);
  const before = getState().auto;
  closeCard();
  tryEdit((auto: Auto) =>
    steps.reduce((next, step) => {
      const pick = step.result?.pick;
      return pick == null ? next : setRoute(next, step.stepId, pick.step.segments, headingOf(pick.step.heading));
    }, auto),
  );
  if (getState().auto !== before && line !== null) setStatus("ok", withUndo(line));
}

/** Writes the route the card shows in one undo step, closes the card and says so on the status line. */
export function applyOptimize(): void {
  if (card === null || !canApply(card)) return;
  if (card.all !== null) {
    applyAll();
    return;
  }
  const result = card.result as OptimizeResult;
  const step = stepToApply(card);
  if (step === null) return;
  const route = chosenRoute(card);
  const draft = card.draft;
  if (draft !== null) {
    applyClearPath(draft, result, route, step);
    return;
  }
  const stepId = card.stepId;
  const before = getState().auto;
  closeCard();
  tryEdit((auto: Auto) => setRoute(auto, stepId, step.segments, headingOf(step.heading)));
  const line = appliedLine(result, route);
  if (getState().auto !== before && line !== null) setStatus("ok", withUndo(line));
}

/**
 * Apply on a clear path: the draft with the route written into it becomes the open auto, in one
 * undo step. With Extend this chain the draft step is then joined onto the chain (core's
 * `joinSteps`), so the route is more paths of that chain and no step is added.
 */
function applyClearPath(draft: ClearPathDraft, result: OptimizeResult, route: OptimizedRoute | null, step: PathStep): void {
  const state = getState();
  if (state.auto !== draft.base) return;
  const robot = robotOf(state);
  const field = fieldOf(state);
  const context = {
    ...(state.project?.waypoints === undefined ? {} : { waypoints: state.project.waypoints }),
    ...(robot === null ? {} : { robot }),
    ...(field === null ? {} : { field }),
  };
  // The edit is worked out before the card closes, so a refusal leaves the card and its result open.
  let next: Auto;
  try {
    const routed = setRoute(draft.auto, draft.stepId, step.segments, headingOf(step.heading));
    next = draft.chainId === null ? routed : joinSteps(routed, draft.chainId, draft.stepId, context).auto;
  } catch (error) {
    setStatus("error", error instanceof Error ? error.message : String(error));
    return;
  }
  closeCard();
  tryEdit(() => next);
  const after = getState().auto;
  if (after === draft.base || after === null) return;
  if (draft.chainId === null) {
    selectStep(draft.stepId);
  } else {
    const chain = findEntry(after, draft.chainId)?.step;
    const chainPaths = chain?.kind === "path" ? chain.segments.length : 1;
    setSelection({ stepId: draft.chainId, point: { segmentIndex: chainPaths - 1, pointKind: "to" } });
  }
  setStatus("ok", clearPathLine(draft, result, route, step.segments.length));
}

function closeCard(): void {
  cancelRun();
  watch = null;
  unsubscribeEditor?.();
  unsubscribeEditor = null;
  if (card === null) return;
  card = null;
  emit();
}

/**
 * Closes the card and cancels its run. The auto is not touched, and when a route was showing the
 * status line says so (UI_GUIDE 9.15), since Esc and Discard both close the card without a word.
 */
export function discardOptimize(): void {
  const shown = card !== null && card.result !== null;
  closeCard();
  if (shown) setStatus("info", "Discarded the route. The auto is unchanged.");
}

/** Whether the card is open, for Escape. */
export const optimizeOpen = (): boolean => card !== null;
