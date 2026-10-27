import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { check, loadField, loadRobot, plan, resolve } from "@horizon36596/zenith-core";
import { parseAuto } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { biobuzzObstacleLabel, biobuzzRules } from "./rules.js";

/**
 * Issue #152: a STRUCTURE message names the obstacle in words a student can find on the field, and
 * keeps the field file's id after it. `frameBarWest` is a 2 in wide foot bar of the hive frame, drawn
 * as a thin strip, and nothing on the field carries its id; nor does a leg of the frame.
 */
const field = loadField(JSON.parse(readFileSync(fileURLToPath(new URL("../field/biobuzz.field.json", import.meta.url)), "utf8")));
const robot = loadRobot(
  JSON.parse(readFileSync(fileURLToPath(new URL("../../../examples/starter/autos/robot.json", import.meta.url)), "utf8")),
);

describe("biobuzzObstacleLabel", () => {
  it("names the frame's base bars, the hives and the flowers' feet", () => {
    expect(biobuzzObstacleLabel("frameBarWest")).toBe("the west base bar of the hive frame");
    expect(biobuzzObstacleLabel("frameBarEast")).toBe("the east base bar of the hive frame");
    expect(biobuzzObstacleLabel("hiveRedPivotBar")).toBe("the RED hive");
    expect(biobuzzObstacleLabel("hiveBluePivotBar")).toBe("the BLUE hive");
    expect(biobuzzObstacleLabel("flower1Foot")).toBe("the foot of flower1");
  });

  it("names the four legs of the hive frame (issue #229)", () => {
    expect(biobuzzObstacleLabel("frameLegNorthEast")).toBe("the north-east leg of the hive frame");
    expect(biobuzzObstacleLabel("frameLegSouthEast")).toBe("the south-east leg of the hive frame");
    expect(biobuzzObstacleLabel("frameLegNorthWest")).toBe("the north-west leg of the hive frame");
    expect(biobuzzObstacleLabel("frameLegSouthWest")).toBe("the south-west leg of the hive frame");
    expect(biobuzzObstacleLabel("frameLegNorth")).toBeNull();
  });

  it("says which wall a flower's foot stands against, from the field file", () => {
    expect(biobuzzObstacleLabel("flower0Foot", field)).toBe("the foot of flower0 on the west wall");
    expect(biobuzzObstacleLabel("flower1Foot", field)).toBe("the foot of flower1 on the north wall");
    expect(biobuzzObstacleLabel("flower2Foot", field)).toBe("the foot of flower2 on the east wall");
    expect(biobuzzObstacleLabel("flower3Foot", field)).toBe("the foot of flower3 on the south wall");
  });

  it("gives every obstacle in the field file a label, and none to an id it does not know", () => {
    for (const obstacle of field.obstacles ?? []) expect(biobuzzObstacleLabel(obstacle.id, field), obstacle.id).not.toBeNull();
    expect(biobuzzObstacleLabel("somethingElse", field)).toBeNull();
    expect(biobuzzRules.obstacleLabel?.("frameBarWest", field)).toBe("the west base bar of the hive frame");
  });
});

describe("the STRUCTURE message with the BIOBUZZ rules", () => {
  it("names frameBarWest as the west base bar and keeps its id", () => {
    // North along the bar's centre line, x = -23.65: the 18 in robot straddles the 2.22 in bar, so
    // it has to move 10.11 in sideways to clear it.
    const structure = alongTheWestBar();
    const bar = structure.filter((finding) => finding.geometry?.obstacleId === "frameBarWest");
    expect(bar).toHaveLength(1);
    const message = bar[0]?.message ?? "";
    expect(message).toContain("base bar");
    expect(message).toContain("(frameBarWest)");
    expect(message).toBe(
      "The robot drives into the west base bar of the hive frame (frameBarWest) for about 56 in (t 0.15 to 0.85), up to 10.11 in deep.",
    );
  });

  it("names the two west legs the same run drives into, with the robot's height (issue #229)", () => {
    const legs = alongTheWestBar().filter((finding) => finding.geometry?.obstacleId?.startsWith("frameLeg") === true);
    expect(legs.map((finding) => finding.geometry?.obstacleId).sort()).toEqual(["frameLegNorthWest", "frameLegSouthWest"]);
    const names = legs.map((finding) => finding.message);
    expect(names.some((each) => each.includes("the north-west leg of the hive frame (frameLegNorthWest)"))).toBe(true);
    expect(names.some((each) => each.includes("the south-west leg of the hive frame (frameLegSouthWest)"))).toBe(true);
    for (const each of names) expect(each).toMatch(/with the robot 18 in tall \(placeholder\)\.$/);
  });
});

/** The starter robot driving north along the west foot bar's centre line. */
function alongTheWestBar(): ReturnType<typeof check> {
  const auto = parseAuto({
    formatVersion: 1,
    name: "along-the-bar",
    alliance: "RED",
    start: { pose: { xIn: -23.65, yIn: -40, headingRad: Math.PI / 2 } },
    steps: [
      {
        id: "alongTheBar",
        kind: "path",
        segments: [{ kind: "line", from: "current", to: { xIn: -23.65, yIn: 40 } }],
        heading: { mode: "tangent" },
      },
    ],
  });
  const planned = plan(resolve(auto, { formatVersion: 1, waypoints: {} }), robot, field);
  return check(planned, null, robot, field, biobuzzRules).filter((finding) => finding.code === "STRUCTURE");
}
