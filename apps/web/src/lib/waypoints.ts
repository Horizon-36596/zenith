/**
 * Small helpers over the project's `waypoints.json`, for the editor.
 */
import type { Waypoints } from "@horizon36596/zenith-schema";

/** Distances and turns closer than this count as equal, so a tie falls through to the next rule. */
const TIE = 1e-9;

/** How far a heading turns to reach another, in radians, the short way round. */
const turnBetween = (fromRad: number, toRad: number): number => {
  const delta = toRad - fromRad;
  return Math.abs(Math.atan2(Math.sin(delta), Math.cos(delta)));
};

/**
 * The name of the waypoint at `at`, or else the nearest one to it: the inspector's "a waypoint" for
 * the start (issue #133). Nearest is the shortest move of the robot's centre; between waypoints
 * equally far, the one that turns the robot least wins, and then the first by name, the order the
 * inspector lists them in. Null when there is no waypoint to follow.
 */
export function nearestWaypoint(
  waypoints: Waypoints | null | undefined,
  at: { xIn: number; yIn: number; headingRad?: number },
): string | null {
  let best: { name: string; distanceIn: number; turnRad: number } | null = null;
  for (const [name, waypoint] of Object.entries(waypoints?.waypoints ?? {})) {
    const distanceIn = Math.hypot(waypoint.xIn - at.xIn, waypoint.yIn - at.yIn);
    const turnRad = at.headingRad === undefined ? 0 : turnBetween(at.headingRad, waypoint.headingRad);
    const better =
      best === null ||
      distanceIn < best.distanceIn - TIE ||
      (Math.abs(distanceIn - best.distanceIn) <= TIE &&
        (turnRad < best.turnRad - TIE || (Math.abs(turnRad - best.turnRad) <= TIE && name.localeCompare(best.name) < 0)));
    if (better) best = { name, distanceIn, turnRad };
  }
  return best?.name ?? null;
}
