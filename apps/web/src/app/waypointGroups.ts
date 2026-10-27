/**
 * How the Inspector's Waypoints list is grouped (issue #217). The field draws only the waypoints the
 * open auto follows, so the list leads with those; every other waypoint sits in a collapsed "Other
 * waypoints" group, and one that no auto in the project follows says so. Nothing here deletes a
 * waypoint: an unused one stays in waypoints.json until someone deletes it.
 */
import { waypointsUsed } from "@horizon36596/zenith-core";
import { getState, type State } from "../state/store";
import { otherAutos } from "./waypointImpact";

export interface WaypointGroups {
  /** The waypoints the open auto follows, in the file's order. */
  here: string[];
  /** Every other waypoint, in the file's order. */
  others: string[];
}

/** `names` split into the ones the open auto follows and the rest, each in the order given. */
export function groupWaypoints(names: readonly string[], followedHere: ReadonlySet<string>): WaypointGroups {
  return {
    here: names.filter((name) => followedHere.has(name)),
    others: names.filter((name) => !followedHere.has(name)),
  };
}

/**
 * The waypoints the project's other autos follow, or null when one of them could not be read, since
 * then no waypoint can be called unused.
 */
export async function waypointsUsedElsewhere(state: State = getState()): Promise<ReadonlySet<string> | null> {
  const used = new Set<string>();
  for (const other of await otherAutos(state)) {
    if (other.auto === null) return null;
    for (const name of waypointsUsed(other.auto)) used.add(name);
  }
  return used;
}

/**
 * Whether no auto follows `name`: not the open one (`followedHere`) and not another one
 * (`usedElsewhere`). False while the other autos are still being read (`usedElsewhere` null).
 */
export const unusedByAnyAuto = (
  name: string,
  followedHere: ReadonlySet<string>,
  usedElsewhere: ReadonlySet<string> | null,
): boolean => usedElsewhere !== null && !followedHere.has(name) && !usedElsewhere.has(name);
