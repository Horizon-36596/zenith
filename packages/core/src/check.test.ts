import { parseAuto, SCHEMA_ID, type Auto } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { check } from "./check.js";
import { robotHeightIn } from "./kinematics.js";
import { plan } from "./plan.js";
import { resolve } from "./resolve.js";
import type { Finding, FindingCode } from "./types.js";
import { testField, testRobot, testWaypoints } from "./testing/fixtures.js";

/**
 * A one-path auto that drives straight along +x at a given y, nose along travel.
 *
 * The robot is 18 in along the nose and 14 in across, so driving east at y = 12 puts the
 * footprint's south edge at y = 5, one inch inside `hiveRedBase` (minYIn -6, maxYIn 6). Driving at
 * y = 14 puts it at y = 7, one inch clear. That pair was the first acceptance test the checks had
 * to pass.
 */
function lineAcrossTheHive(yIn: number): Auto {
  return parseAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 1,
    name: "hive-line",
    alliance: "RED",
    start: { pose: { xIn: -40, yIn, headingRad: 0 } },
    steps: [
      {
        id: "acrossTheHive",
        kind: "path",
        segments: [{ kind: "line", from: "current", to: { xIn: 10, yIn, headingRad: 0 } }],
        heading: { mode: "tangent" },
      },
    ],
  });
}

const findingsFor = (auto: Auto, robot = testRobot): Finding[] =>
  check(plan(resolve(auto, testWaypoints), robot, testField), null, robot, testField);

const codes = (findings: readonly Finding[]): FindingCode[] => findings.map((f) => f.code);

/**
 * The codes that stop a file being accepted. These are the M0 Contract's tests, and they are about
 * errors and warnings; M1 added PROVENANCE, an info that fires on every inline pose by design and
 * would otherwise appear in every list below. `provenance.test.ts` is where that one is asserted.
 */
const problems = (findings: readonly Finding[]): FindingCode[] =>
  findings.filter((finding) => finding.severity !== "info").map((finding) => finding.code);

describe("the M0 Contract", () => {
  it("reports STRUCTURE for a line through the RED hive", () => {
    const findings = findingsFor(lineAcrossTheHive(12));
    const structure = findings.filter((finding) => finding.code === "STRUCTURE");
    expect(structure).toHaveLength(1);
    expect(structure[0]?.severity).toBe("error");
    expect(structure[0]?.stepId).toBe("acrossTheHive");
    expect(structure[0]?.geometry?.obstacleId).toBe("hiveRedBase");
    expect(structure[0]?.geometry?.penetrationIn).toBeCloseTo(1, 6);
  });

  it("passes for the same line moved 1 in clear", () => {
    expect(problems(findingsFor(lineAcrossTheHive(14)))).toEqual([]);
  });
});

describe("the STRUCTURE z gate", () => {
  it("lets an 18 in robot drive under the hive's pivot bar", () => {
    // The bar's underside is at z 25.5 in and the default robot height is 18 in, so a line right
    // through the bar's footprint raises nothing. This is why the contract above needs a
    // ground-level box: the real bar alone cannot be hit.
    const findings = findingsFor(lineAcrossTheHive(-16));
    expect(findings.filter((finding) => finding.geometry?.obstacleId === "hiveRedPivotBar")).toEqual(
      [],
    );
  });

  it("stops a robot tall enough to reach it", () => {
    const tall = { ...testRobot, heightIn: { value: 30, provenance: "PLACEHOLDER: test fixture" } };
    const hits = findingsFor(lineAcrossTheHive(-16), tall).filter(
      (finding) => finding.geometry?.obstacleId === "hiveRedPivotBar",
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.code).toBe("STRUCTURE");
  });
});

describe("the other M0 checks", () => {
  it("reports PERIMETER when the footprint leaves the field", () => {
    const auto = parseAuto({
      formatVersion: 1,
      name: "off-the-field",
      alliance: "RED",
      start: { pose: { xIn: 60, yIn: 60, headingRad: 0 } },
      steps: [
        {
          id: "intoTheWall",
          kind: "path",
          segments: [{ kind: "line", from: "current", to: { xIn: 70, yIn: 60 } }],
          heading: { mode: "tangent" },
        },
      ],
    });
    const perimeter = findingsFor(auto).filter((finding) => finding.code === "PERIMETER");
    expect(perimeter).toHaveLength(1);
    expect(perimeter[0]?.message).toContain("leaves the field");
  });

  it("reports HEADING_MISSING for a path step with no heading mode", () => {
    const auto = parseAuto({
      formatVersion: 1,
      name: "no-heading",
      alliance: "RED",
      start: { pose: { xIn: 0, yIn: 40, headingRad: 0 } },
      steps: [
        {
          id: "drift",
          kind: "path",
          segments: [{ kind: "line", from: "current", to: { xIn: 20, yIn: 40 } }],
        },
      ],
    });
    expect(codes(findingsFor(auto))).toContain("HEADING_MISSING");
  });

  it("reports CONTINUITY for a gap over half an inch", () => {
    const auto = parseAuto({
      formatVersion: 1,
      name: "gap",
      alliance: "RED",
      start: { pose: { xIn: 0, yIn: 40, headingRad: 0 } },
      steps: [
        {
          id: "twoLegs",
          kind: "path",
          segments: [
            { kind: "line", from: "current", to: { xIn: 20, yIn: 40 } },
            { kind: "line", from: { xIn: 22, yIn: 40 }, to: { xIn: 30, yIn: 40 } },
          ],
          heading: { mode: "tangent" },
        },
      ],
    });
    const continuity = findingsFor(auto).filter((finding) => finding.code === "CONTINUITY");
    expect(continuity).toHaveLength(1);
    expect(continuity[0]?.message).toContain("2.00 in");
  });

  it("accepts a gap under half an inch", () => {
    const auto = parseAuto({
      formatVersion: 1,
      name: "tiny-gap",
      alliance: "RED",
      start: { pose: { xIn: 0, yIn: 40, headingRad: 0 } },
      steps: [
        {
          id: "twoLegs",
          kind: "path",
          segments: [
            { kind: "line", from: "current", to: { xIn: 20, yIn: 40 } },
            { kind: "line", from: { xIn: 20.25, yIn: 40 }, to: { xIn: 30, yIn: 40 } },
          ],
          heading: { mode: "tangent" },
        },
      ],
    });
    expect(problems(findingsFor(auto))).toEqual([]);
  });

  it("reports SCHEMA for a command the registry does not know", () => {
    const auto = parseAuto({
      formatVersion: 1,
      name: "unknown-command",
      alliance: "RED",
      start: { pose: { xIn: 0, yIn: 40, headingRad: 0 } },
      steps: [{ id: "volley", kind: "command", name: "launchTheWorks" }],
    });
    const schema = findingsFor(auto).filter((finding) => finding.code === "SCHEMA");
    expect(schema).toHaveLength(1);
    expect(schema[0]?.message).toContain("launchTheWorks");
  });

  it("reports SCHEMA for a waypoint reference that does not resolve", () => {
    const auto = parseAuto({
      formatVersion: 1,
      name: "unknown-waypoint",
      alliance: "RED",
      start: { pose: { ref: "nowhere" } },
      steps: [{ id: "volley", kind: "command", name: "shootAll", args: { count: 1 } }],
    });
    expect(codes(findingsFor(auto))).toContain("SCHEMA");
  });

  it("resolves a waypoint reference that does", () => {
    const auto = parseAuto({
      formatVersion: 1,
      name: "known-waypoint",
      alliance: "RED",
      start: { pose: { ref: "startTile" } },
      steps: [{ id: "volley", kind: "command", name: "shootAll", args: { count: 1 } }],
    });
    const planned = plan(resolve(auto, testWaypoints), testRobot, testField);
    expect(planned.startPose).toEqual({ xIn: -40, yIn: -63, headingRad: 1.5708 });
    expect(problems(check(planned, null, testRobot, testField))).toEqual([]);
  });

  it("threads current through the plan, so the second leg starts where the first ended", () => {
    const auto = parseAuto({
      formatVersion: 1,
      name: "two-steps",
      alliance: "RED",
      start: { pose: { xIn: -40, yIn: 40, headingRad: 0 } },
      steps: [
        {
          id: "east",
          kind: "path",
          segments: [{ kind: "line", from: "current", to: { xIn: -20, yIn: 40 } }],
          heading: { mode: "tangent" },
        },
        {
          id: "north",
          kind: "path",
          segments: [{ kind: "line", from: "current", to: { xIn: -20, yIn: 60 } }],
          heading: { mode: "tangent" },
        },
      ],
    });
    const planned = plan(resolve(auto, testWaypoints), testRobot, testField);
    expect(planned.steps[1]?.startPose.xIn).toBeCloseTo(-20, 9);
    expect(planned.steps[1]?.startPose.yIn).toBeCloseTo(40, 9);
    expect(planned.steps[1]?.endPose?.headingRad).toBeCloseTo(Math.PI / 2, 6);
    expect(problems(check(planned, null, testRobot, testField))).toEqual([]);
  });

  it("runs START_ILLEGAL through the season hook", () => {
    const auto = lineAcrossTheHive(14);
    const season = {
      id: "test",
      initialState: () => ({}),
      onLaunch: (state: Readonly<Record<string, unknown>>) => state,
      onCollect: (state: Readonly<Record<string, unknown>>) => state,
      currentTarget: () => null,
      legalApproach: () => true,
      startLegal: (): Finding[] => [
        {
          severity: "error" as const,
          stepId: "start",
          code: "START_ILLEGAL" as const,
          message: "The start pose is not touching a wall.",
        },
      ],
      summary: () => [],
    };
    const planned = plan(resolve(auto, testWaypoints), testRobot, testField);
    expect(problems(check(planned, null, testRobot, testField, season))).toEqual(["START_ILLEGAL"]);
  });
});

/** A parallel group holding one path and one command, with the deadline named by the caller. */
function groupWith(deadline: string | undefined): Auto {
  return parseAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 1,
    name: "deadline-group",
    alliance: "RED",
    start: { pose: { xIn: -40, yIn: 14, headingRad: 0 } },
    steps: [
      {
        id: "park",
        kind: "parallel",
        mode: "deadline",
        ...(deadline === undefined ? {} : { deadline }),
        steps: [
          {
            id: "drive",
            kind: "path",
            segments: [{ kind: "line", from: "current", to: { xIn: -20, yIn: 14 } }],
            heading: { mode: "tangent" },
          },
          { id: "spinDown", kind: "command", name: "setIntake" },
        ],
      },
    ],
  });
}

describe("a deadline parallel group", () => {
  it("finding 6: is accepted when its deadline names a direct child", () => {
    expect(problems(findingsFor(groupWith("drive")))).toEqual([]);
  });

  it("finding 6: raises SCHEMA when the deadline names no child", () => {
    const schema = findingsFor(groupWith("missing")).filter((f) => f.code === "SCHEMA");
    expect(schema).toHaveLength(1);
    expect(schema[0]?.severity).toBe("error");
    expect(schema[0]?.stepId).toBe("park");
    expect(schema[0]?.message).toContain('"missing"');
  });

  it("finding 6: raises SCHEMA when there is no deadline at all", () => {
    const schema = findingsFor(groupWith(undefined)).filter((f) => f.code === "SCHEMA");
    expect(schema).toHaveLength(1);
    expect(schema[0]?.stepId).toBe("park");
  });
});

describe("duplicate step ids", () => {
  /** Two command steps carrying the same explicit id, which the schema alone accepts. */
  const twice = (): Auto =>
    parseAuto({
      $schema: SCHEMA_ID.auto,
      formatVersion: 1,
      name: "duplicate-ids",
      alliance: "RED",
      start: { pose: { xIn: -40, yIn: 14, headingRad: 0 } },
      steps: [
        { id: "volley", kind: "command", name: "shootAll", args: { count: 1 } },
        { id: "volley", kind: "command", name: "shootAll", args: { count: 2 } },
      ],
    });

  it("finding 8: raise SCHEMA naming the repeated id", () => {
    const schema = findingsFor(twice()).filter((finding) => finding.code === "SCHEMA");
    expect(schema).toHaveLength(1);
    expect(schema[0]?.severity).toBe("error");
    expect(schema[0]?.stepId).toBe("volley");
    expect(schema[0]?.message).toContain('"volley"');
  });

  it("finding 8: a nested repeat of a top-level id is caught too", () => {
    const auto = parseAuto({
      $schema: SCHEMA_ID.auto,
      formatVersion: 1,
      name: "duplicate-ids-nested",
      alliance: "RED",
      start: { pose: { xIn: -40, yIn: 14, headingRad: 0 } },
      steps: [
        { id: "spin", kind: "command", name: "setIntake" },
        {
          id: "group",
          kind: "parallel",
          mode: "all",
          steps: [{ id: "spin", kind: "command", name: "setIntake" }],
        },
      ],
    });
    const schema = findingsFor(auto).filter((finding) => finding.code === "SCHEMA");
    expect(schema.map((finding) => finding.stepId)).toEqual(["spin"]);
  });
});

describe("the robot height the z gate reads", () => {
  it("finding 30: reads the root heightIn's value, wrapper and all", () => {
    expect(robotHeightIn({ ...testRobot, heightIn: { value: 30, provenance: "MEASURED" } })).toBe(30);
  });

  it("finding 30: falls back to the footprint's labelled height, then the default", () => {
    const footprint = { ...testRobot.footprint, heightIn: { value: 26, provenance: "PLACEHOLDER" } };
    expect(robotHeightIn({ ...testRobot, footprint })).toBe(26);
    expect(robotHeightIn(testRobot)).toBe(18);
  });
});
