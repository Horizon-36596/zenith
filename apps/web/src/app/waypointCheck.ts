/**
 * Save just this auto into another project (issue #158) checks the waypoints first. An auto follows
 * waypoints by name, so the same file in another project follows that project's `waypoints.json`:
 * a name it lacks is an error there, and a name it has somewhere else moves the robot without a
 * word. This module sorts every name the auto follows into the same, somewhere else, or missing,
 * and works out the auto (and the waypoints to add) for each answer the person can give. It is
 * pure, with no store and no files; `saveReadOnly.ts` asks and writes.
 */
import { EDITOR_PROVENANCE, addWaypoint, replaceWaypointRefs, waypointsUsed } from "@horizon36596/zenith-core";
import type { Auto, Pose, Waypoint, Waypoints } from "@horizon36596/zenith-schema";
import { degrees, inches } from "../lib/format";

/** How the other project has a waypoint the auto follows. */
export type WaypointMatch = "same" | "differs" | "missing";

export interface WaypointCompared {
  name: string;
  match: WaypointMatch;
  /** The waypoint as the project the auto is saved from has it. */
  here: Waypoint;
  /** As the other project has it; absent when it has no waypoint of this name. */
  there?: Waypoint;
}

export interface WaypointCheck {
  /** Every name the auto follows, each once, in the order it first follows them. */
  used: string[];
  /**
   * The names this project has a pose for, in `used` order. A name this project lacks is already an
   * error here, and there is no pose to give it, so it is left as it is.
   */
  compared: WaypointCompared[];
}

/**
 * What the person chose for the names that are not the same: `own` gives every such point the pose
 * it has here; `add` writes the missing waypoints into the other project's file and gives the ones
 * that differ their own poses; `follow` lets the ones that differ follow the other project's and
 * gives the missing ones their own poses.
 */
export type WaypointAnswer = "own" | "add" | "follow";

const has = (waypoints: Waypoints | undefined, name: string): boolean =>
  waypoints !== undefined && Object.prototype.hasOwnProperty.call(waypoints.waypoints, name);

/**
 * Two poses are the same when the editor shows the same numbers for them: inches to two places and
 * degrees to one, as the inspector and this check's dialog print them. A difference too small to see
 * there would be one the person could not judge either.
 */
export const samePose = (a: Waypoint, b: Waypoint): boolean =>
  inches(a.xIn) === inches(b.xIn) && inches(a.yIn) === inches(b.yIn) && degrees(a.headingRad) === degrees(b.headingRad);

/** Sorts every waypoint `auto` follows by how `there` (the other project's file, if any) has it. */
export function checkWaypoints(auto: Auto, here: Waypoints | undefined, there: Waypoints | undefined): WaypointCheck {
  const used = waypointsUsed(auto);
  const compared: WaypointCompared[] = [];
  for (const name of used) {
    if (here === undefined || !has(here, name)) continue;
    const mine = here.waypoints[name] as Waypoint;
    if (there === undefined || !has(there, name)) {
      compared.push({ name, match: "missing", here: mine });
      continue;
    }
    const theirs = there.waypoints[name] as Waypoint;
    compared.push({ name, match: samePose(mine, theirs) ? "same" : "differs", here: mine, there: theirs });
  }
  return { used, compared };
}

/** True when some name is missing or differs, so the person is asked before anything is written. */
export const needsAnswer = (check: WaypointCheck): boolean => check.compared.some((entry) => entry.match !== "same");

export const missingOf = (check: WaypointCheck): WaypointCompared[] => check.compared.filter((entry) => entry.match === "missing");
export const differingOf = (check: WaypointCheck): WaypointCompared[] => check.compared.filter((entry) => entry.match === "differs");

/** The pose a point takes when it stops following waypoint `name`: the waypoint's, with its provenance. */
export function ownPose(name: string, waypoint: Waypoint): Pose {
  return {
    xIn: waypoint.xIn,
    yIn: waypoint.yIn,
    headingRad: waypoint.headingRad,
    provenance: waypoint.provenance ?? `${EDITOR_PROVENANCE}: copied from waypoint ${name}`,
  };
}

export interface AutoForTarget {
  /** The auto to write, which is `auto` itself when the answer changes nothing in it. */
  auto: Auto;
  /** Waypoints to add to the other project's file, by name; empty unless the answer is `add`. */
  add: Record<string, Waypoint>;
  /** The names whose points were given poses of their own, in `used` order. */
  ownPoses: string[];
}

/** The auto, and the waypoints to add, for one answer to the check. */
export function autoForTarget(auto: Auto, check: WaypointCheck, answer: WaypointAnswer): AutoForTarget {
  const add: Record<string, Waypoint> = {};
  const ownPoses: string[] = [];
  let next = auto;
  for (const entry of check.compared) {
    if (entry.match === "same") continue;
    if (entry.match === "missing" && answer === "add") {
      add[entry.name] = { ...entry.here };
      continue;
    }
    if (entry.match === "differs" && answer === "follow") continue;
    next = replaceWaypointRefs(next, entry.name, ownPose(entry.name, entry.here));
    ownPoses.push(entry.name);
  }
  return { auto: next, add, ownPoses };
}

/**
 * The other project's waypoints with `add` put after its own. A name the file already has is never
 * written over: core's `addWaypoint` refuses it, and so the whole save.
 */
export function withAddedWaypoints(waypoints: Waypoints, add: Readonly<Record<string, Waypoint>>): Waypoints {
  return Object.entries(add).reduce((next, [name, waypoint]) => addWaypoint(next, name, waypoint), waypoints);
}

/** A pose as the dialog prints it: `x -12.00 in, y -63.00 in, 90.0°`. */
export const poseLine = (waypoint: Waypoint): string =>
  `x ${inches(waypoint.xIn)} in, y ${inches(waypoint.yIn)} in, ${degrees(waypoint.headingRad)}°`;
