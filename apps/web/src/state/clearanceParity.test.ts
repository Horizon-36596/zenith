import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadAuto, loadField, loadRobot, loadWaypoints, type Finding } from "@horizon36596/zenith-core";
import { describe, expect, it } from "vitest";
import { derive } from "./derived";

/**
 * Owner ruling D8: the editor's CLEARANCE findings come from robot.json alone, so they match what
 * `zenith validate` reports for the same file. `packages/cli/src/commands/validateClearance.test.ts`
 * pins the same two findings from the CLI; this pins them from `derive()`, the editor's one caller
 * of `check()`. No person's setting enters: `derive()` takes no preferences.
 *
 * The fixture is the starter's toGarden as it was before issue #365, from the scoring spot north of
 * the hive on x = -9 south under the hive, between the hive frame's legs: it passes within the
 * robot's clearance of both west legs without touching either. The starter itself now goes round
 * the west of the frame, because that route also crosses the centre line, and has no CLEARANCE.
 */
const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const read = (path: string): unknown => JSON.parse(readFileSync(`${repo}examples/starter/${path}`, "utf8")) as unknown;

/** The starter's toGarden as it was before issue #365, alone, from the scoring spot north of the hive on x = -9. */
const NEAR_THE_LEGS = {
  $schema: "https://libraries.horizon36596.org/zenith/schema/v1/auto.json",
  formatVersion: 4,
  name: "near-the-legs",
  robot: "autos/robot.json",
  field: "autos/field/biobuzz.field.json",
  alliance: "RED",
  start: { pose: { xIn: -9, yIn: 36, headingRad: -1.5708, provenance: "SET BY HAND: test fixture" } },
  steps: [
    {
      id: "toGarden",
      kind: "path",
      segments: [
        {
          kind: "bezier",
          from: "current",
          control: [
            { xIn: -5, yIn: -56, provenance: "SET BY HAND: test fixture" },
            { xIn: -16, yIn: -62, provenance: "SET BY HAND: test fixture" },
          ],
          to: { ref: "gardenSweepStart" },
        },
      ],
      heading: { mode: "tangent" },
    },
  ],
};

const clearance = (findings: readonly Finding[]) =>
  findings
    .filter((finding) => finding.code === "CLEARANCE")
    .map((finding) => ({ severity: finding.severity, stepId: finding.stepId, obstacleId: finding.geometry?.obstacleId, message: finding.message }));

describe("the editor's CLEARANCE findings (D8)", () => {
  const robot = loadRobot(read("autos/robot.json"));
  const field = loadField(read("autos/field/biobuzz.field.json"));
  const waypoints = loadWaypoints(read("autos/waypoints.json"));
  const auto = loadAuto(NEAR_THE_LEGS);

  it("are none on the shipped starter, whose toGarden goes around the hive frame", () => {
    const shipped = loadAuto(read("autos/collect-and-score.auto.json"));
    expect(clearance(derive(shipped, robot, field, waypoints).findings)).toEqual([]);
  });

  it("are the two the CLI reports for a route between the hive frame's legs", () => {
    const found = clearance(derive(auto, robot, field, waypoints).findings);
    // The same messages, word for word, as validateClearance.test.ts pins for `zenith validate`.
    expect(found).toEqual([
      {
        severity: "warning",
        stepId: "toGarden",
        obstacleId: "frameLegNorthWest",
        message:
          "The robot passes 0.69 in from the north-west leg of the hive frame (frameLegNorthWest) at t 0.21, within 1 in (Zenith's default; set it in Settings, Robot).",
      },
      {
        severity: "warning",
        stepId: "toGarden",
        obstacleId: "frameLegSouthWest",
        message:
          "The robot passes 0.47 in from the south-west leg of the hive frame (frameLegSouthWest) at t 0.38, within 1 in (Zenith's default; set it in Settings, Robot).",
      },
    ]);
  });

  it("follow footprint.clearanceIn in the robot file", () => {
    const set = { ...robot, footprint: { ...robot.footprint, clearanceIn: { value: 0.5, provenance: "SET BY HAND: test fixture" } } };
    const found = clearance(derive(loadAuto(NEAR_THE_LEGS), set, field, waypoints).findings);
    expect(found.map((finding) => finding.obstacleId)).toEqual(["frameLegSouthWest"]);
    expect(found[0]?.message).toContain("within 0.5 in (robot.json, SET BY HAND)");
  });
});
