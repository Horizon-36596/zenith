import { parseAuto, parseField, parseRobot, SCHEMA_ID, type Auto, type Field, type Robot } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { check } from "./check.js";
import { DEFAULT_CLEARANCE_IN, DEFAULT_CLEARANCE_PROVENANCE, robotClearanceIn, robotClearanceProvenance } from "./kinematics.js";
import { plan } from "./plan.js";
import { resolve } from "./resolve.js";
import type { Finding } from "./types.js";
import { testField, testRobot, testWaypoints } from "./testing/fixtures.js";

/**
 * CLEARANCE (owner ruling D8): a warning where the swept footprint comes within the robot's clearance
 * of a structure without touching it. The margin is `footprint.clearanceIn` in robot.json, or 1 in when
 * that is absent, and never the follower's `translationalDeviationToleranceIn`. Walls and keep-out
 * zones are not covered, and contact stays the STRUCTURE error.
 *
 * The test robot is 18 in along the nose and 14 in across, so driving east at y puts its south edge
 * at y - 7. `hiveRedBase` ends at y 6, so y 13.5 passes 0.5 in from it and y 14.5 passes 1.5 in.
 */
function eastAt(yIn: number): Auto {
  return parseAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 4,
    name: "past-the-hive",
    alliance: "RED",
    start: { pose: { xIn: -40, yIn, headingRad: 0 } },
    steps: [
      {
        id: "pastTheHive",
        kind: "path",
        segments: [{ kind: "line", from: "current", to: { xIn: 10, yIn, headingRad: 0 } }],
        heading: { mode: "tangent" },
      },
    ],
  });
}

const findingsFor = (auto: Auto, robot: Robot = testRobot, field: Field = testField): Finding[] =>
  check(plan(resolve(auto, testWaypoints), robot, field), null, robot, field);

const clearance = (findings: readonly Finding[]): Finding[] => findings.filter((finding) => finding.code === "CLEARANCE");

const withClearance = (value: number, provenance = "SET BY HAND: test fixture"): Robot =>
  parseRobot({ ...testRobot, footprint: { ...testRobot.footprint, clearanceIn: { value, provenance } } });

describe("CLEARANCE: within the margin of a structure without contact (D8)", () => {
  it("warns about a sweep 0.5 in from an obstacle, naming 1 in as Zenith's default", () => {
    const found = clearance(findingsFor(eastAt(13.5)));
    expect(found).toHaveLength(1);
    const [finding] = found;
    expect(finding?.severity).toBe("warning");
    expect(finding?.stepId).toBe("pastTheHive");
    expect(finding?.geometry?.obstacleId).toBe("hiveRedBase");
    expect(finding?.geometry?.gapIn).toBeCloseTo(0.5, 6);
    expect(finding?.message).toContain("0.50 in from hiveRedBase");
    expect(finding?.message).toContain("within 1 in (Zenith's default; set it in Settings, Robot)");
    expect(finding?.geometry?.poseIn?.yIn).toBeCloseTo(13.5, 6);
    expect(finding?.geometry?.footprintIn?.length).toBeGreaterThan(0);
  });

  it("raises nothing for a sweep 1.5 in away", () => {
    expect(clearance(findingsFor(eastAt(14.5)))).toEqual([]);
  });

  it("raises nothing at exactly the margin, so the M0 contract's 1 in clear line stays clean", () => {
    expect(clearance(findingsFor(eastAt(14)))).toEqual([]);
  });

  it("leaves contact to the existing STRUCTURE error and adds no CLEARANCE for that obstacle", () => {
    const findings = findingsFor(eastAt(12));
    const structure = findings.filter((finding) => finding.code === "STRUCTURE");
    expect(structure).toHaveLength(1);
    expect(structure[0]?.severity).toBe("error");
    expect(structure[0]?.geometry?.obstacleId).toBe("hiveRedBase");
    expect(clearance(findings)).toEqual([]);
  });

  it("reads the margin from footprint.clearanceIn and names its provenance", () => {
    const found = clearance(findingsFor(eastAt(14.5), withClearance(2)));
    expect(found).toHaveLength(1);
    expect(found[0]?.geometry?.gapIn).toBeCloseTo(1.5, 6);
    expect(found[0]?.message).toContain("within 2 in (robot.json, SET BY HAND)");
  });

  it("is off at a clearance of 0", () => {
    expect(clearance(findingsFor(eastAt(13.5), withClearance(0)))).toEqual([]);
  });

  it("never reads the margin from follower.translationalDeviationToleranceIn", () => {
    const robot = parseRobot({
      ...testRobot,
      kinematics: {
        ...testRobot.kinematics,
        follower: {
          ...testRobot.kinematics.follower,
          translationalDeviationToleranceIn: { value: 2.5, provenance: "CARRIED OVER: Pedro's default" },
        },
      },
    });
    expect(robotClearanceIn(robot)).toBe(DEFAULT_CLEARANCE_IN);
    // 1.5 in clear is inside 2.5 in but outside 1 in: nothing fires.
    expect(clearance(findingsFor(eastAt(14.5), robot))).toEqual([]);
    // 0.5 in clear fires, and the message names the 1 in default, not 2.5 in.
    const found = clearance(findingsFor(eastAt(13.5), robot));
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain("within 1 in (Zenith's default");
    expect(found[0]?.message).not.toContain("2.5");
  });

  it("does not cover the perimeter wall: riding the wall raises no CLEARANCE", () => {
    // The field's south wall is at y -72; the robot's south edge at y -71.5 is 0.5 in from it.
    expect(clearance(findingsFor(eastAt(-64.5)))).toEqual([]);
  });

  it("covers only solid obstacles below the robot's top", () => {
    const soft = parseField({
      ...testField,
      obstacles: (testField.obstacles ?? []).map((obstacle) => ({ ...obstacle, solidToRobot: false })),
    });
    expect(clearance(findingsFor(eastAt(13.5), testRobot, soft))).toEqual([]);
    // The pivot bar starts at z 25.5 in, above the 18 in robot: driving 0.5 in beside its footprint
    // is driving under nothing at all.
    const barOnly = parseField({
      ...testField,
      obstacles: (testField.obstacles ?? []).filter((obstacle) => obstacle.id === "hiveRedPivotBar"),
    });
    expect(clearance(findingsFor(eastAt(26.08), testRobot, barOnly))).toEqual([]);
  });

  it("warns about a footprint flush against a structure, at a gap of 0 and without a STRUCTURE error", () => {
    // The robot is 14 in across, so at heading 0 and y 13 its south face lies exactly on y 6, where
    // hiveRedBase ends. That is touching without overlapping, the closest a robot can come.
    const auto = parseAuto({
      $schema: SCHEMA_ID.auto,
      formatVersion: 4,
      name: "flush-with-the-hive",
      alliance: "RED",
      start: { pose: { xIn: -12.75, yIn: 13, headingRad: 0 } },
      steps: [{ id: "pause", kind: "wait", seconds: 1 }],
    });
    const findings = findingsFor(auto);
    expect(findings.filter((finding) => finding.code === "STRUCTURE")).toEqual([]);
    const found = clearance(findings);
    expect(found).toHaveLength(1);
    expect(found[0]?.geometry?.obstacleId).toBe("hiveRedBase");
    expect(found[0]?.geometry?.gapIn).toBeCloseTo(0, 6);
    expect(found[0]?.message).toContain("stands 0.00 in from hiveRedBase");
  });

  it("names the middle of a stretch held at one gap, not its first or last sample", () => {
    // Driving east at y 13.5 the robot is 0.5 in from hiveRedBase (x -16.75 to -8.75) at every
    // sample whose 18 in body overlaps those x values, which is a robot x from -25.75 to 0.25. The
    // middle of that stretch is the middle of the obstacle, x -12.75.
    const [finding] = clearance(findingsFor(eastAt(13.5)));
    const x = finding?.geometry?.poseIn?.xIn as number;
    expect(Math.abs(x - -12.75)).toBeLessThan(1);
    expect(finding?.t).toBeGreaterThan(0.3);
    expect(finding?.t).toBeLessThan(0.7);
  });

  it("warns where the robot stands for a step, not only along a path", () => {
    const auto = parseAuto({
      $schema: SCHEMA_ID.auto,
      formatVersion: 4,
      name: "beside-the-hive",
      alliance: "RED",
      start: { pose: { xIn: -12.75, yIn: 13.5, headingRad: 0 } },
      steps: [{ id: "pause", kind: "wait", seconds: 1 }],
    });
    const found = clearance(findingsFor(auto));
    expect(found.map((finding) => finding.stepId)).toEqual(["pause"]);
    expect(found[0]?.message).toContain("stands 0.50 in from hiveRedBase");
  });
});

describe("the clearance robot.json gives, and the default", () => {
  it("is 1 in, SET BY HAND under the owner's ruling, when robot.json leaves it out", () => {
    expect(DEFAULT_CLEARANCE_IN).toBe(1);
    expect(DEFAULT_CLEARANCE_PROVENANCE).toBe("SET BY HAND: owner ruling 2026-10-08 (D8)");
    expect(robotClearanceIn(testRobot)).toBe(1);
    expect(robotClearanceProvenance(testRobot)).toBe(DEFAULT_CLEARANCE_PROVENANCE);
  });

  it("is the file's value and provenance when it gives one", () => {
    const robot = withClearance(2.25, "MEASURED: test fixture");
    expect(robotClearanceIn(robot)).toBe(2.25);
    expect(robotClearanceProvenance(robot)).toBe("MEASURED: test fixture");
  });
});
