import { describe, expect, it } from "vitest";
import { parseAuto, SCHEMA_ID, type Auto, type Waypoints } from "@horizon36596/zenith-schema";
import { canonicalize } from "../canonicalize.js";
import { EditError } from "./errors.js";
import { canonicalRoundTrip } from "./testing.js";
import {
  addWaypoint,
  removeWaypoint,
  renameWaypoint,
  replaceWaypointRefs,
  setWaypoint,
  waypointNameProblem,
  waypointUses,
  waypointsUsed,
} from "./waypoints.js";

const file = (): Waypoints => ({
  $schema: SCHEMA_ID.waypoints,
  formatVersion: 1,
  waypoints: {
    start: { xIn: -12, yIn: -63, headingRad: 1.5708, provenance: "MEASURED: start tile" },
    scoreSouth: { xIn: -12, yIn: -36, headingRad: 1.5708 },
    park: { xIn: -40, yIn: -36, headingRad: 3.1416, provenance: "PLACEHOLDER: park" },
  },
});

/** An auto that follows `start` at its start and in a nested path, and `scoreSouth` once. */
function following(): Auto {
  return parseAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 4,
    name: "follows",
    alliance: "RED",
    start: { pose: { ref: "start" } },
    steps: [
      {
        id: "driveOut",
        kind: "path",
        segments: [{ kind: "line", from: { ref: "start" }, to: { ref: "scoreSouth" } }],
        heading: { mode: "tangent" },
      },
      {
        id: "group",
        kind: "sequence",
        steps: [
          {
            id: "back",
            kind: "path",
            segments: [
              { kind: "line", from: "current", to: { xIn: 0, yIn: 0, headingRad: 0 } },
              { kind: "bezier", from: { xIn: 0, yIn: 0 }, control: [{ xIn: 4, yIn: 4 }], to: { ref: "start" } },
            ],
            heading: { mode: "tangent" },
          },
        ],
      },
    ],
  });
}

const names = (waypoints: Waypoints): string[] => Object.keys(waypoints.waypoints);

describe("waypoint names", () => {
  it("accepts a letter followed by letters, digits, _ and -", () => {
    expect(waypointNameProblem("northShoot", file())).toBeNull();
    expect(waypointNameProblem("score_2-left", file())).toBeNull();
  });

  it("says why a name is refused", () => {
    expect(waypointNameProblem("", file())).toMatch(/needs a name/);
    expect(waypointNameProblem("2nd", file())).toMatch(/starts with a letter/);
    expect(waypointNameProblem("north shoot", file())).toMatch(/only letters, digits/);
    expect(waypointNameProblem("a".repeat(65), file())).toMatch(/at most 64/);
    expect(waypointNameProblem("park", file())).toMatch(/already a waypoint named park/);
    // A name inherited from Object.prototype is not taken.
    expect(waypointNameProblem("constructor", file())).toBeNull();
  });

  it("lets a waypoint keep its own name while it is renamed", () => {
    expect(waypointNameProblem("park", file(), "park")).toBeNull();
  });
});

describe("waypoints.json edits", () => {
  it("adds a waypoint after the others and refuses a taken or bad name", () => {
    const added = addWaypoint(file(), "northShoot", { xIn: -40, yIn: 40, headingRad: -1.5708, provenance: "SET FROM EDITOR" });
    expect(names(added)).toEqual(["start", "scoreSouth", "park", "northShoot"]);
    expect(names(file())).toEqual(["start", "scoreSouth", "park"]);
    expect(() => addWaypoint(file(), "park", { xIn: 0, yIn: 0, headingRad: 0 })).toThrow(EditError);
    expect(() => addWaypoint(file(), "bad name", { xIn: 0, yIn: 0, headingRad: 0 })).toThrow(/only letters/);
  });

  it("moves a waypoint in its place and keeps the file valid", () => {
    const moved = setWaypoint(file(), "start", { xIn: -36, yIn: -63, headingRad: 1.5708, provenance: "SET FROM EDITOR" });
    expect(names(moved)).toEqual(["start", "scoreSouth", "park"]);
    expect(moved.waypoints["start"]).toEqual({ xIn: -36, yIn: -63, headingRad: 1.5708, provenance: "SET FROM EDITOR" });
    expect(() => setWaypoint(file(), "nowhere", { xIn: 0, yIn: 0, headingRad: 0 })).toThrow(/no waypoint named nowhere/);
    expect(() => setWaypoint(file(), "start", { xIn: Number.NaN, yIn: 0, headingRad: 0 })).toThrow(/invalid/);
    expect(canonicalize("waypoints", moved)).toContain('"xIn": -36');
  });

  it("renames a waypoint where it stands in the file", () => {
    const renamed = renameWaypoint(file(), "scoreSouth", "southScore");
    expect(names(renamed)).toEqual(["start", "southScore", "park"]);
    expect(renamed.waypoints["southScore"]).toEqual(file().waypoints["scoreSouth"]);
    expect(renameWaypoint(file(), "park", "park")).toEqual(file());
    expect(() => renameWaypoint(file(), "park", "start")).toThrow(/already a waypoint named start/);
    expect(() => renameWaypoint(file(), "nowhere", "here")).toThrow(/no waypoint named nowhere/);
  });

  it("removes a waypoint", () => {
    expect(names(removeWaypoint(file(), "scoreSouth"))).toEqual(["start", "park"]);
    expect(() => removeWaypoint(file(), "nowhere")).toThrow(EditError);
  });
});

describe("where an auto follows a waypoint", () => {
  it("lists the start and every path end that follows one, nested paths included", () => {
    expect(waypointUses(following())).toEqual([
      { ref: "start", at: "start" },
      { ref: "start", at: "point", stepId: "driveOut", segmentIndex: 0, pointKind: "from" },
      { ref: "scoreSouth", at: "point", stepId: "driveOut", segmentIndex: 0, pointKind: "to" },
      { ref: "start", at: "point", stepId: "back", segmentIndex: 1, pointKind: "to" },
    ]);
    expect(waypointUses(following(), "scoreSouth")).toHaveLength(1);
    expect(waypointUses(following(), "park")).toEqual([]);
    expect(waypointsUsed(following())).toEqual(["start", "scoreSouth"]);
  });

  it("points every use at another name for a rename", () => {
    const auto = following();
    const renamed = replaceWaypointRefs(auto, "start", { ref: "home" });
    expect(renamed.start.pose).toEqual({ ref: "home" });
    expect(waypointUses(renamed, "home")).toHaveLength(3);
    expect(waypointUses(renamed, "start")).toEqual([]);
    expect(waypointUses(renamed, "scoreSouth")).toHaveLength(1);
    // The input is untouched.
    expect(waypointUses(auto, "start")).toHaveLength(3);
    canonicalRoundTrip(renamed);
  });

  it("gives every use a pose of its own for a delete", () => {
    const pose = { xIn: -12, yIn: -63, headingRad: 1.5708, provenance: "MEASURED: start tile" };
    const unlinked = replaceWaypointRefs(following(), "start", pose);
    expect(unlinked.start.pose).toEqual(pose);
    const driveOut = unlinked.steps[0];
    expect(driveOut?.kind === "path" ? driveOut.segments[0]?.from : null).toEqual(pose);
    expect(waypointsUsed(unlinked)).toEqual(["scoreSouth"]);
    canonicalRoundTrip(unlinked);
  });

  it("returns an auto that never follows the waypoint as it was", () => {
    const auto = following();
    expect(replaceWaypointRefs(auto, "park", { ref: "elsewhere" })).toBe(auto);
  });
});
