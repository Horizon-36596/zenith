/**
 * The three waypoint questions of issue #134, as view state apart from the editor store (like
 * `saveChoice.ts`): the name for "Save as waypoint…", the new name for a rename, and whether to go
 * on with a delete, each asked after Zenith has said which autos follow the waypoint.
 * `waypointEdits.ts` does the edits; `dialogs/WaypointDialog.tsx` shows the questions.
 */
import { useSyncExternalStore } from "react";
import { featureLabel, getFeatures } from "../state/features";
import { getState, setStatus, subscribeEditor, type State } from "../state/store";
import { getUi, startWaypointPlacement, stopWaypointPlacement } from "../state/ui";
import type { PoseOwner } from "./edits";
import { waypointEditingOff, waypointNamed, whyNoWaypointAt, whyNoWaypointFrom, type WaypointSpot } from "./waypointEdits";

export type WaypointQuestion =
  | { kind: "add"; owner: PoseOwner }
  | { kind: "addAt"; pose: WaypointSpot }
  | { kind: "rename"; name: string }
  | { kind: "delete"; name: string };

let question: WaypointQuestion | null = null;
const listeners = new Set<() => void>();

const show = (next: WaypointQuestion | null): void => {
  question = next;
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const getQuestion = (): WaypointQuestion | null => question;

/** The question showing now, or null, for the dialog. */
export const useWaypointQuestion = (): WaypointQuestion | null => useSyncExternalStore(subscribe, getQuestion, getQuestion);

/** The question showing now, outside React. */
export const getWaypointQuestion = (): WaypointQuestion | null => question;

/** The dialog's Cancel and Escape, and what an answer does once it is acted on. */
export const closeWaypointQuestion = (): void => {
  show(null);
};

/** "Save as waypoint…" for the start or a path's end; the status line says why when it cannot be. */
export function askAddWaypoint(owner: PoseOwner): void {
  const why = whyNoWaypointFrom(owner);
  if (why !== null) {
    setStatus("error", why);
    return;
  }
  show({ kind: "add", owner });
}

/**
 * "Add waypoint here" and a click while placing: asks for the name of a new waypoint at the spot. The
 * status line says why when it cannot be, as where the spot snapped onto a pin that is there already
 * or where there is no spot (undefined: a click too close to the path end).
 */
export function askAddWaypointAt(spot: WaypointSpot | undefined): void {
  const why = whyNoWaypointAt(spot);
  if (why !== null || spot === undefined) {
    setStatus("error", why ?? "There is no spot on the field here.");
    return;
  }
  stopWaypointPlacement();
  show({ kind: "addAt", pose: { xIn: spot.xIn, yIn: spot.yIn, headingRad: spot.headingRad } });
}

/**
 * The palette's Add waypoint: the next click on the field picks the spot, then the same question as
 * "Add waypoint here". Escape cancels. One shot, so a click that cannot place one keeps it armed.
 */
export function armWaypointPlacement(): void {
  const off = waypointEditingOff();
  if (off !== null) {
    setStatus("error", off);
    return;
  }
  startWaypointPlacement();
  watchPlacement();
  setStatus("info", "Click the field to place the waypoint. Esc cancels.");
}

let stopWatching: (() => void) | null = null;

/**
 * Keeps the armed placement from outliving what it was armed for: picking another tool, opening
 * another auto or project, or anything that turns waypoint editing off (review mode, for one)
 * disarms it, so the next click does what the field shows rather than opening Add waypoint.
 */
function watchPlacement(): void {
  stopWatching?.();
  const armed = placementContext(getState());
  const stop = subscribeEditor(() => {
    if (!getUi().placingWaypoint) {
      stop();
      if (stopWatching === stop) stopWatching = null;
      return;
    }
    const state = getState();
    const now = placementContext(state);
    if (now.tool === armed.tool && now.fileName === armed.fileName && now.link === armed.link && waypointEditingOff(state) === null) return;
    stop();
    if (stopWatching === stop) stopWatching = null;
    stopWaypointPlacement();
  });
  stopWatching = stop;
}

const placementContext = (state: State): { tool: State["tool"]; fileName: string | null; link: unknown } => ({
  tool: state.tool,
  fileName: state.fileName,
  link: state.project?.link,
});

function askAbout(kind: "rename" | "delete", name: string): void {
  // The Waypoints switch takes away renaming and deleting a waypoint (spec 15 section 4.1), from
  // every way in: F2, Del, the menus, the Inspector and a double-click on a pin.
  if (!getFeatures().waypoints) {
    setStatus("error", `${featureLabel("waypoints")} is off in your settings. Turn it on in Settings, General to ${kind} a waypoint.`);
    return;
  }
  const off = waypointEditingOff();
  if (off !== null) {
    setStatus("error", off);
    return;
  }
  if (waypointNamed(name) === undefined) {
    setStatus("error", `waypoints.json has no waypoint named ${name}.`);
    return;
  }
  // The same question is already showing (a held Del repeats): leave it, so it does not refetch.
  if (question?.kind === kind && question.name === name) return;
  show({ kind, name });
}

/** Rename…: asks for the new name, after saying which autos follow the waypoint. */
export const askRenameWaypoint = (name: string): void => {
  askAbout("rename", name);
};

/** Delete…: says which autos follow the waypoint and what happens to them, then asks. */
export const askDeleteWaypoint = (name: string): void => {
  askAbout("delete", name);
};
