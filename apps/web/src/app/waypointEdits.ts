/**
 * Waypoint editing (issue #134): moving a waypoint pin, making a waypoint from a pose, renaming and
 * deleting one, and whether this project can do any of it. The numbers live in the project's
 * `waypoints.json`, which the store holds as `project.waypoints`; every edit here replaces it, with
 * whatever the edit does to the open auto, as one undo step (`commitWithWaypoints`), and Save writes
 * it back in canonical form (`projectActions.ts`, `saveReadOnly.ts`).
 *
 * Every point that follows a waypoint moves with it at once, because the planner resolves the
 * reference again on every change. A rename points the open auto's references at the new name; a
 * delete gives them a pose of their own, as unlinking does (issue #133). Other autos in the project
 * are never changed from here: the rename and delete dialogs name the ones that follow the waypoint
 * first (`followersOf`).
 */
import {
  addWaypoint,
  EDITOR_PROVENANCE,
  numberedId,
  removeWaypoint,
  renameWaypoint,
  replaceWaypointRefs,
  setWaypoint,
  uniqueId,
  waypointNameProblem,
  waypointUses,
  wrapAngle,
  type WaypointUse,
} from "@horizon36596/zenith-core";
import { isPathAllowed } from "@horizon36596/zenith-github";
import type { Auto, Pose, Waypoint, Waypoints } from "@horizon36596/zenith-schema";
import { commitWithWaypoints, dropWaypointPin, getState, keepStatus, renameWaypointPin, setSelection, setStatus, type State } from "../state/store";
import {
  listed,
  ownerDrawnPose,
  ownerName,
  ownerSource,
  plannedPointHeading,
  pointName,
  unlinkedMessage,
  waypointPose,
  writeOwner,
  type PoseOwner,
  type Unlinked,
} from "./edits";
import { selectionOf } from "../canvas/selection";
import { provenanceAfterTyping, typedNumberWarning, type ReadOffLabel } from "../lib/provenance";
import { moveVerdict, protectedLabel, selectFirstKeyLine, selectFirstLine, type MoveOrigin } from "./pinProtection";
import { editingNumbers, rotateRadians } from "../settings/editingNumbers";
import { autoNameOf, otherAutos } from "./waypointImpact";
import { copyText } from "./copyText";

/**
 * Why the open project's waypoints cannot be edited here, as one sentence, or null when they can.
 * Editing is on wherever Save can write `waypoints.json`: a folder, the desktop app, GitHub mode and
 * the example's (or picked files') Save the full project. Host mode sends back autos only.
 */
export function waypointEditingOff(state: State = getState()): string | null {
  const { project, backend, host } = state;
  if (project === null) return "Open a project first.";
  if (state.review !== null) return "Review mode is read only. Leave the review to edit waypoints.";
  if (project.source.kind === "host") {
    const name = host?.name ?? "the app that opened this auto";
    return `Waypoints are read only here: ${name} takes back only the autos, so a change to waypoints.json could not be saved.`;
  }
  if (project.link.waypoints === undefined || project.waypoints === undefined) {
    return "This project's zenith.json names no waypoints file, so Zenith has nowhere to save waypoints.";
  }
  if (project.source.kind === "desktop" && backend?.writeWaypoints === undefined) {
    return "This version of the desktop app cannot write waypoints.json. Update it, or change the file by hand.";
  }
  if (project.source.kind === "github" && !isPathAllowed(project.link, project.link.waypoints)) {
    return `On GitHub Zenith commits only inside the autos, deploy and codegen folders, and ${project.link.waypoints} is outside them, so change it on a branch by hand.`;
  }
  return null;
}

/** The waypoint called `name` in the open project, or undefined. */
export function waypointNamed(name: string, waypoints: Waypoints | undefined = getState().project?.waypoints): Waypoint | undefined {
  if (waypoints === undefined || !Object.prototype.hasOwnProperty.call(waypoints.waypoints, name)) return undefined;
  return waypoints.waypoints[name];
}

/**
 * Runs one waypoint edit against the open auto and the project's waypoints, and commits both
 * together. Refused, with the reason on the status line, where waypoint editing is off; an edit
 * the format would not accept becomes the status line instead of a crash. True when it went through.
 */
function tryWaypointEdit(
  edit: (auto: Auto, waypoints: Waypoints) => { auto: Auto; waypoints: Waypoints },
  options: Parameters<typeof commitWithWaypoints>[2] = {},
): boolean {
  const state = getState();
  const auto = state.auto;
  const waypoints = state.project?.waypoints;
  if (auto === null) return false;
  const off = waypointEditingOff(state);
  if (off !== null || waypoints === undefined) {
    setStatus("error", off ?? "This project has no waypoints.");
    return false;
  }
  try {
    const next = edit(auto, waypoints);
    commitWithWaypoints(next.auto, next.waypoints, options);
    return true;
  } catch (error) {
    setStatus("error", error instanceof Error ? error.message : String(error));
    return false;
  }
}

const requireWaypoint = (waypoints: Waypoints, name: string): Waypoint => {
  const waypoint = waypointNamed(name, waypoints);
  if (waypoint === undefined) throw new Error(`waypoints.json has no waypoint named ${name}.`);
  return waypoint;
};

/** The part of a waypoint's pose a move sets; anything left out is kept. */
export type WaypointPatch = { xIn?: number; yIn?: number; headingRad?: number };

/** What `moveWaypoint` did: whether the pin moved, and the read-off label the move replaced. */
export interface MoveOutcome {
  moved: boolean;
  /** MEASURED or CALIBRATED FROM ROBOT, when the move relabelled a pin that had it; otherwise null. */
  replaced: ReadOffLabel | null;
}

/**
 * Moves or turns waypoint `name`. `change` is the patch, or a function of the waypoint now that
 * returns one. `origin` says where the change came from, and every caller passes one: the canvas's
 * pin drag (`drag`), the arrow and rotate keys on a selected pin (`key`), the inspector's numbers
 * (`typed`) and an accepted proposal (`proposal`). With Protect measured waypoints on, a `drag` or
 * `key` on a pin labelled MEASURED or CALIBRATED FROM ROBOT that is not selected moves nothing: it
 * says so on the status line, and the pin has to be selected first (decision D12, `pinProtection.ts`).
 *
 * A move is the editor's, so the provenance becomes `SET FROM EDITOR` (CLAUDE.md rule 4); a typed
 * number keeps any other label, as before (issue #273). A `typed` or `proposal` move that relabels a
 * read-off pin warns on the status line. Every point that follows the waypoint, in the open auto and
 * wherever else, moves with it.
 */
export function moveWaypoint(
  name: string,
  change: WaypointPatch | ((at: Waypoint) => WaypointPatch),
  origin: MoveOrigin,
  options: { history?: boolean } = {},
): MoveOutcome {
  const state = getState();
  const now = waypointNamed(name);
  if (now !== undefined) {
    const verdict = moveVerdict({ origin, waypoint: now, selected: state.selection.waypoint === name, protect: state.prefs.protectMeasuredPins });
    if (verdict.kind === "selectFirst") {
      setStatus("info", origin === "drag" ? selectFirstLine(name, verdict.label) : selectFirstKeyLine(name, verdict.label));
      return { moved: false, replaced: null };
    }
  }
  const result: MoveOutcome = { moved: false, replaced: null };
  const moved = tryWaypointEdit((auto, waypoints) => {
    const at = requireWaypoint(waypoints, name);
    const patch = typeof change === "function" ? change(at) : change;
    const typed = origin === "typed" ? provenanceAfterTyping(at.provenance) : { provenance: EDITOR_PROVENANCE, replaced: protectedLabel(at) };
    result.replaced = typed.replaced;
    return { auto, waypoints: setWaypoint(waypoints, name, { ...at, ...patch, provenance: typed.provenance }) };
  }, options);
  if (!moved) return { moved: false, replaced: null };
  const { replaced } = result;
  // A drag or a key says what it replaced when it ends (`announceMove`); a number or a proposal says so now.
  if (replaced !== null && (origin === "typed" || origin === "proposal")) setStatus("warn", typedNumberWarning(replaced, `waypoint ${name}`));
  return { moved: true, replaced };
}

/**
 * A press on the field landed on a protected pin that was not selected (decision D12): select it and
 * say that the next press-drag moves it. Nothing is written, so there is no undo step.
 */
export function pressProtectedPin(name: string): void {
  const label = protectedLabel(waypointNamed(name));
  setSelection({ waypoint: name });
  if (label !== null) setStatus("info", selectFirstLine(name, label));
}

/**
 * What a move does beyond the pin itself (issue #191): the label it replaces, and the other autos
 * that follow the waypoint and move with it. A drag says so when it ends, and a nudge or turn on
 * the keys says so on the first key of a run; a run ends after `RUN_QUIET_MS` without a key, so one
 * line covers a whole press-and-hold. The line offers Ctrl+Z.
 */
const RUN_QUIET_MS = 1200;
const LABEL_SHOWN = 80;
let dragging: { name: string; was: Waypoint } | null = null;
let keyRun: { name: string; timer: ReturnType<typeof setTimeout> } | null = null;

/** The pin drag's move: as `moveWaypoint`, remembering the waypoint as the press found it. */
export function dragWaypoint(name: string, pose: { xIn: number; yIn: number }): void {
  if (dragging === null || dragging.name !== name) {
    const was = waypointNamed(name);
    dragging = was === undefined ? null : { name, was };
  }
  moveWaypoint(name, { xIn: pose.xIn, yIn: pose.yIn }, "drag");
}

/**
 * The pin drag ended, or was cancelled: says what it did when the waypoint is not where the press
 * found it, and forgets the drag either way.
 */
export function endWaypointDrag(): void {
  const drag = dragging;
  dragging = null;
  if (drag !== null) announceMove(drag.name, drag.was);
}

/** The line a move writes, from the label it replaced and the other autos that follow. */
export function moveStatus(name: string, was: Waypoint, others: readonly string[]): string {
  const label = was.provenance;
  const replaced =
    label === undefined || label === EDITOR_PROVENANCE
      ? ""
      : `, which was ${label.length > LABEL_SHOWN ? `${label.slice(0, LABEL_SHOWN - 1)}…` : label}; it is now ${EDITOR_PROVENANCE}`;
  const one = others.length === 1;
  const follow = others.length === 0 ? "" : ` ${listed(others.map(autoNameOf))} ${one ? "follows" : "follow"} it too, so ${one ? "it moves" : "they move"} with it.`;
  return `Moved waypoint ${name}${replaced}.${follow} Ctrl+Z puts it back.`;
}

/** Writes the move's status line once the other autos that follow the waypoint are known. */
function announceMove(name: string, was: Waypoint): void {
  const now = waypointNamed(name);
  if (now === undefined || JSON.stringify(now) === JSON.stringify(was)) return;
  const before = getState().status;
  void followersOf(name).then((followers) => {
    // Something else spoke while the other autos were read: that line is newer.
    if (getState().status !== before) return;
    setStatus("ok", moveStatus(name, was, followers.others));
  });
}

/** The first key of a nudge or turn run on a pin says what it does; the rest of the run is quiet. */
function keyMove(name: string, move: () => void): void {
  const starts = keyRun === null || keyRun.name !== name;
  const was = starts ? waypointNamed(name) : undefined;
  // The rest of the run keeps what its first key said, rather than clearing it as a new edit would.
  if (!starts) keepStatus();
  move();
  if (keyRun !== null) clearTimeout(keyRun.timer);
  keyRun = {
    name,
    timer: setTimeout(() => {
      keyRun = null;
    }, RUN_QUIET_MS),
  };
  if (starts && was !== undefined) announceMove(name, was);
}

/** The arrow keys on a selected pin: one nudge step, or the far step with Shift, as for a point. */
export function nudgeWaypoint(
  name: string,
  dx: number,
  dy: number,
  far: boolean,
  options: { history?: boolean } = {},
): void {
  const numbers = editingNumbers(getState().prefs);
  const step = far ? numbers.nudgeFarIn : numbers.nudgeIn;
  keyMove(name, () => {
    moveWaypoint(name, (at) => ({ xIn: at.xIn + dx * step, yIn: at.yIn + dy * step }), "key", options);
  });
}

/**
 * Turn's key (`R` and Shift `R`, or the person's own) on a selected pin: turns it by the Rotate
 * setting, as for a point, keeping the heading in (-180, 180] (#318).
 */
export function rotateWaypoint(name: string, direction: 1 | -1, options: { history?: boolean } = {}): void {
  keyMove(name, () => {
    moveWaypoint(
      name,
      (at) => ({ headingRad: wrapAngle(at.headingRad + direction * rotateRadians(getState().prefs)) }),
      "key",
      options,
    );
  });
}

/**
 * A number typed into the inspector for waypoint `name`. As for a point's typed numbers, the label
 * it had is kept, except that MEASURED and CALIBRATED FROM ROBOT become SET FROM EDITOR with a
 * warning on the status line (owner ruling 2026-10-10, issue #273); the chip beside the numbers sets
 * the label back in one step. A waypoint that had no label gets the editor's. Returns the label the
 * number replaced, or null when the label stayed or the edit was refused.
 */
export function writeWaypointNumbers(name: string, patch: WaypointPatch): ReadOffLabel | null {
  return moveWaypoint(name, patch, "typed").replaced;
}

/** Sets a waypoint's provenance by hand, from the chip beside its numbers, and keeps the numbers. */
export function writeWaypointProvenance(name: string, provenance: string): void {
  tryWaypointEdit((auto, waypoints) => ({
    auto,
    waypoints: setWaypoint(waypoints, name, { ...requireWaypoint(waypoints, name), provenance }),
  }));
}

/**
 * How far apart, in radians, a planned heading and a pose's own heading may be and still count as
 * the same number. A file writes radians to 4 decimals (spec 02), so this is half of that step.
 */
const SAME_HEADING_RAD = 0.00005;

/**
 * The pose a new waypoint made from the owner takes: the owner's own numbers and provenance when it
 * is a pose of its own, or where the planner draws it, with the editor's provenance, when it is the
 * last step's end. A path point's heading is the one the plan gives the robot there. When that is
 * not the heading the pose holds, or the pose holds none, the editor worked the heading out, so the
 * waypoint gets the editor's provenance instead of the pose's (CLAUDE.md rule 4). Null, with the
 * reason, when there is nothing to make one from.
 */
function poseForWaypoint(owner: PoseOwner): { pose: Waypoint } | { problem: string } {
  const auto = getState().auto;
  const source = auto === null ? undefined : ownerSource(auto, owner);
  if (source === undefined) return { problem: `There is no ${ownerName(owner)} to make a waypoint from.` };
  if (source !== "current" && "ref" in source) {
    return { problem: `${capitalised(ownerName(owner))} already follows waypoint ${source.ref}.` };
  }
  const drawn = ownerDrawnPose(owner);
  // A path point's own headingRad turns nothing, so the waypoint takes the heading the plan gives
  // the robot there (issue #147). The start's own heading is the one the robot sets up at.
  const planned = owner === "start" ? null : plannedPointHeading(owner.stepId, owner.point);
  if (source === "current") {
    const headingRad = planned ?? drawn?.headingRad;
    if (drawn === null || headingRad === undefined) {
      return { problem: `Zenith cannot work out where ${ownerName(owner)} is yet, so there is no pose to save.` };
    }
    return { pose: { xIn: drawn.xIn, yIn: drawn.yIn, headingRad, provenance: EDITOR_PROVENANCE } };
  }
  const own = source.headingRad;
  // The pose's provenance labels its own heading. It carries over only when the waypoint keeps that
  // heading, so a MEASURED or SET BY HAND label never covers a heading the editor worked out.
  if (own !== undefined && (planned === null || Math.abs(wrapAngle(planned - own)) <= SAME_HEADING_RAD)) {
    return { pose: { xIn: source.xIn, yIn: source.yIn, headingRad: own, provenance: source.provenance ?? EDITOR_PROVENANCE } };
  }
  const headingRad = planned ?? drawn?.headingRad;
  if (headingRad === undefined) {
    return { problem: `${capitalised(ownerName(owner))} has no heading yet, and a waypoint needs one.` };
  }
  return { pose: { xIn: source.xIn, yIn: source.yIn, headingRad, provenance: EDITOR_PROVENANCE } };
}

const capitalised = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Why the owner cannot be saved as a waypoint, or null when it can: editing is off, the owner
 * follows a waypoint already, or it has no pose yet. The inspector greys its button out with this.
 */
export function whyNoWaypointFrom(owner: PoseOwner): string | null {
  const off = waypointEditingOff();
  if (off !== null) return off;
  const made = poseForWaypoint(owner);
  return "problem" in made ? made.problem : null;
}

/**
 * A name for a waypoint made from the owner that the format accepts and no waypoint has: `start`
 * for the start, the step's id and `End` for a path's end (never the bare id, which reads as a
 * step), made to fit the naming rule, then `-2`, `-3` and so on when it is taken.
 */
export function suggestedWaypointName(owner: PoseOwner): string {
  const base = owner === "start" ? "start" : owner.point.pointKind === "to" ? `${owner.stepId}End` : `${owner.stepId}From`;
  const cleaned = base.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^[^A-Za-z]+/, "").slice(0, 56);
  const taken = new Set(Object.keys(getState().project?.waypoints?.waypoints ?? {}));
  return uniqueId(cleaned === "" ? "waypoint" : cleaned, taken);
}

/**
 * "Save as waypoint…" from the start or a path's end: a new waypoint called `name` at the pose the
 * point stands at, and the point follows it from then on, so the robot does not move. One undo step
 * takes both back. True when it went through; otherwise the status line says why.
 */
export function addWaypointFrom(owner: PoseOwner, name: string): boolean {
  const made = poseForWaypoint(owner);
  if ("problem" in made) {
    setStatus("error", made.problem);
    return false;
  }
  const done = tryWaypointEdit((auto, waypoints) => ({
    waypoints: addWaypoint(waypoints, name, made.pose),
    auto: writeOwner(auto, owner, { ref: name }),
  }));
  if (done) setStatus("ok", `Saved ${ownerName(owner)} as waypoint ${name}. ${capitalised(ownerName(owner))} now follows it.`);
  return done;
}

/** A spot on the field for a new waypoint: where an Add path click would put its point, and the pin it snapped onto. */
export interface WaypointSpot {
  xIn: number;
  yIn: number;
  headingRad: number;
  waypoint?: string;
}

/**
 * Why a waypoint cannot be added at the spot, or null when it can: waypoint editing is off, the
 * spot is not on the field, or it snapped onto a pin that is there already.
 */
export function whyNoWaypointAt(spot: WaypointSpot | undefined): string | null {
  const off = waypointEditingOff();
  if (off !== null) return off;
  if (spot === undefined) return "There is no spot on the field here.";
  return spot.waypoint === undefined ? null : `Waypoint ${spot.waypoint} is already here.`;
}

/** A name for a new waypoint that no waypoint has: `waypoint1`, `waypoint2` and so on. */
export function suggestedNewWaypointName(): string {
  return numberedId("waypoint", new Set(Object.keys(getState().project?.waypoints?.waypoints ?? {})));
}

/**
 * "Add waypoint here": a new waypoint called `name` at the spot, with the heading an Add path click
 * there would give, labelled as the editor's (CLAUDE.md rule 4). The auto does not change, because
 * nothing follows the new pin yet. The pin is selected, and one undo step takes it away. True when it
 * went through; otherwise the status line says why.
 */
export function addWaypointAt(spot: WaypointSpot, name: string): boolean {
  const before = getState();
  const message = `Added waypoint ${name}.`;
  const done = tryWaypointEdit(
    (auto, waypoints) => ({
      auto,
      waypoints: addWaypoint(waypoints, name, { xIn: spot.xIn, yIn: spot.yIn, headingRad: spot.headingRad, provenance: EDITOR_PROVENANCE }),
    }),
    {
      restore: {
        selection: before.selection,
        multiSteps: before.multiSteps,
        undoStatus: `Removed waypoint ${name}.`,
        redoStatus: message,
        redoSelection: { selection: { waypoint: name }, multiSteps: [] },
      },
    },
  );
  if (!done) return false;
  setSelection({ waypoint: name });
  setStatus("ok", message);
  return true;
}

/** A use of a waypoint, mid-sentence, as the status line and the dialogs name it. */
export const waypointUseName = (use: WaypointUse): string =>
  use.at === "start" ? "the start" : pointName(use.stepId, { segmentIndex: use.segmentIndex, pointKind: use.pointKind });

/**
 * Renames waypoint `from` to `to`, keeping its place in the file, and points every place in the open
 * auto that followed it at the new name. One undo step. The selection follows a selected pin.
 */
export function renameWaypointTo(from: string, to: string): boolean {
  const auto = getState().auto;
  if (auto === null) return false;
  const here = waypointUses(auto, from).length;
  const undoTop = getState().undo.at(-1);
  const done = tryWaypointEdit((current, waypoints) => ({
    waypoints: renameWaypoint(waypoints, from, to),
    auto: replaceWaypointRefs(current, from, { ref: to }),
  }));
  if (!done) return false;
  // A pin hidden or shown on its own stays so under its new name (issue #236).
  renameWaypointPin(from, to, undoTop);
  if (getState().selection.waypoint === from) setSelection({ waypoint: to });
  const follows = here === 0 ? "" : ` ${here === 1 ? "The point in this auto that followed it follows" : `The ${String(here)} points in this auto that followed it follow`} ${to} now.`;
  setStatus("ok", `Renamed waypoint ${from} to ${to}.${follows}`);
  return true;
}

/**
 * Deletes waypoint `name`. Every place in the open auto that followed it gets a pose of its own at
 * the waypoint's spot, with its numbers and provenance, as unlinking does (issue #133), and the
 * status line names them. One undo step brings the waypoint back and links them again.
 */
export function deleteWaypointNamed(name: string): boolean {
  const auto = getState().auto;
  if (auto === null) return false;
  const uses = waypointUses(auto, name);
  const unlinked: Unlinked[] = uses.map((use) => ({ what: waypointUseName(use), waypoint: name }));
  const message = `Deleted waypoint ${name}. ${unlinked.length === 0 ? "Undo brings it back." : unlinkedMessage(unlinked)}`;
  const undoTop = getState().undo.at(-1);
  const done = tryWaypointEdit(
    (current, waypoints) => {
      requireWaypoint(waypoints, name);
      const pose: Pose = waypointPose(name, null);
      return { waypoints: removeWaypoint(waypoints, name), auto: replaceWaypointRefs(current, name, pose) };
    },
    // Undo selects the pin again and says so, in place of the "Deleted…" line above (issue #232).
    { restore: { selection: { waypoint: name }, multiSteps: [], undoStatus: `Waypoint ${name} is back.`, redoStatus: message } },
  );
  if (!done) return false;
  // Its pin's override goes with it, so a new waypoint of the same name starts with none.
  dropWaypointPin(name, undoTop);
  if (getState().selection.waypoint === name) setSelection({});
  setStatus("ok", message);
  return true;
}

/** Who follows a waypoint: in the open auto, and in the project's other autos. */
export interface Followers {
  /** The places in the open auto that follow it, mid-sentence: "the start", "point 1 of driveOut". */
  here: string[];
  /** The project's other autos that follow it, by file name, sorted. */
  others: string[];
  /** Autos Zenith could not read, so it cannot say whether they follow it. */
  unreadable: string[];
}

/**
 * Which autos in the project follow waypoint `name`, for the rename and delete dialogs: the open
 * auto as it is now, unsaved edits included, and every other auto as it is saved. An auto the
 * project holds as text (the example, picked files) is read from there; any other is read through
 * the backend, from the folder, the desktop app or GitHub.
 */
export async function followersOf(name: string, state: State = getState()): Promise<Followers> {
  const { project, auto } = state;
  const here = auto === null ? [] : waypointUses(auto, name).map(waypointUseName);
  const others: string[] = [];
  const unreadable: string[] = [];
  if (project === null) return { here, others, unreadable };
  // Each other auto is read and parsed once per project (`waypointImpact.ts`).
  for (const other of await otherAutos(state)) {
    if (other.auto === null) unreadable.push(other.file);
    else if (waypointUses(other.auto, name).length > 0) others.push(other.file);
  }
  others.sort((a, b) => a.localeCompare(b));
  return { here, others, unreadable };
}

/**
 * The sentences the rename and delete dialogs show: who follows waypoint `name`, then what the
 * change does to them. Other autos are never changed from here, so they are named, with what they
 * will show until someone changes them.
 */
export function followersLines(name: string, followers: Followers, action: "rename" | "delete"): string[] {
  const lines: string[] = [];
  const { here, others, unreadable } = followers;
  if (here.length === 0 && others.length === 0) {
    lines.push(`No auto in this project follows ${name}.`);
  } else {
    if (here.length > 0) {
      const many = here.length > 3 ? `${String(here.length)} points` : listed(here);
      lines.push(`In this auto, ${many} ${here.length === 1 ? "follows" : "follow"} ${name}.`);
      lines.push(
        action === "rename"
          ? `${here.length === 1 ? "It follows" : "They follow"} the new name once you rename it.`
          : `${here.length === 1 ? "It keeps" : "They keep"} the waypoint's pose as ${here.length === 1 ? "its" : "their"} own.`,
      );
    }
    if (others.length > 0) {
      const one = others.length === 1;
      lines.push(
        `${listed(others)} ${one ? "follows" : "follow"} ${name} too, and ${one ? "is" : "are"} not changed here: ${
          action === "rename" ? `${one ? "it keeps" : "they keep"} the old name` : `${one ? "it still names" : "they still name"} it`
        } and ${one ? "shows" : "show"} an error until ${one ? "it is" : "each is"} opened and changed.`,
      );
    }
  }
  if (unreadable.length > 0) {
    lines.push(`Zenith could not read ${listed(unreadable)}, so it cannot say whether ${unreadable.length === 1 ? "it follows" : "they follow"} ${name}.`);
  }
  return lines;
}

const round4 = (value: number): number => Math.round(value * 10000) / 10000;

/**
 * A waypoint's pose as the project's files write it, to paste into JSON or a prompt (issue #233):
 * `{"xIn":-40,"yIn":-36,"headingRad":3.1416}`, inches and radians to four places. Null for a name
 * `waypoints.json` does not have.
 */
export function waypointPoseText(name: string): string | null {
  const at = waypointNamed(name);
  if (at === undefined) return null;
  return JSON.stringify({ xIn: round4(at.xIn), yIn: round4(at.yIn), headingRad: round4(at.headingRad) });
}

/** "Copy position" on a pin's menu: puts `waypointPoseText` on the clipboard and says so. */
export async function copyWaypointPosition(name: string): Promise<void> {
  const text = waypointPoseText(name);
  if (text === null) {
    setStatus("error", `waypoints.json has no waypoint named ${name}.`);
    return;
  }
  // Nothing on screen holds the text to select, so a refused copy gives it in the line instead.
  await copyText(`the position of ${name}`, text, { shown: text });
}

/** Why no point of the open auto follows waypoint `name`, or null when some do. */
export function whyNoFollowers(name: string): string | null {
  const auto = getState().auto;
  return auto !== null && waypointUses(auto, name).length > 0 ? null : `Nothing in this auto follows ${name}.`;
}

/**
 * "Select the points that follow it": every path point of the open auto that follows waypoint
 * `name`, across steps, as one selection the arrow keys and the Inspector then act on. Where only
 * the start follows it, the start is selected.
 */
export function selectFollowersOf(name: string): boolean {
  const auto = getState().auto;
  const uses = auto === null ? [] : waypointUses(auto, name);
  const points = uses.flatMap((use) =>
    use.at === "point" ? [{ stepId: use.stepId, point: { segmentIndex: use.segmentIndex, pointKind: use.pointKind } }] : [],
  );
  if (points.length > 0) setSelection(selectionOf(points));
  else if (uses.length > 0) setSelection({ start: true });
  else {
    setStatus("info", whyNoFollowers(name) ?? "");
    return false;
  }
  return true;
}

export { waypointNameProblem };
