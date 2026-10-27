/**
 * The waypoint the inspector's "a waypoint" picks for the start (issue #133): the one at the spot
 * the start stands on, or else the nearest one, never just the first by name.
 */
import { loadWaypoints } from "@horizon36596/zenith-core";
import { SCHEMA_ID } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { nearestWaypoint } from "./waypoints";

const waypoints = loadWaypoints({
  $schema: SCHEMA_ID.waypoints,
  formatVersion: 1,
  waypoints: {
    alpha: { xIn: 40, yIn: 40, headingRad: 0 },
    start: { xIn: -12, yIn: -63, headingRad: 1.5708 },
    scoreSouth: { xIn: -12, yIn: -36, headingRad: 1.5708 },
    twinFacingDown: { xIn: 10, yIn: 0, headingRad: -1.5708 },
    twinFacingUp: { xIn: 10, yIn: 0, headingRad: 1.5708 },
  },
});

describe("nearestWaypoint", () => {
  it("picks the waypoint at the spot the start stands on", () => {
    expect(nearestWaypoint(waypoints, { xIn: -12, yIn: -63, headingRad: 1.5708 })).toBe("start");
  });

  it("picks the nearest waypoint when none is at that spot, not the first by name", () => {
    expect(nearestWaypoint(waypoints, { xIn: -10, yIn: -40, headingRad: 0 })).toBe("scoreSouth");
  });

  it("breaks a tie by the smaller turn, then by name", () => {
    expect(nearestWaypoint(waypoints, { xIn: 10, yIn: 0, headingRad: 1.5 })).toBe("twinFacingUp");
    expect(nearestWaypoint(waypoints, { xIn: 10, yIn: 0, headingRad: -1.5 })).toBe("twinFacingDown");
    expect(nearestWaypoint(waypoints, { xIn: 10, yIn: 0 })).toBe("twinFacingDown");
  });

  it("is null when there is no waypoint to follow", () => {
    expect(nearestWaypoint(null, { xIn: 0, yIn: 0 })).toBeNull();
    expect(nearestWaypoint(loadWaypoints({ $schema: SCHEMA_ID.waypoints, formatVersion: 1, waypoints: {} }), { xIn: 0, yIn: 0 })).toBeNull();
  });
});
