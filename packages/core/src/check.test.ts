import { DEFAULT_ROBOT_HEIGHT_IN, parseAuto, parseField, SCHEMA_ID, type Auto, type Heading } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { check } from "./check.js";
import { applyFix, turnWhileDrivingFix } from "./fix.js";
import { fieldBounds } from "./footprint.js";
import { polygonOutsideBox, polygonOverlapsBox } from "./geometry/sat.js";
import type { Vec2 } from "./geometry/vec.js";
import { robotHeightIn } from "./kinematics.js";
import { plan } from "./plan.js";
import { resolve } from "./resolve.js";
import type { Finding, FindingCode, PlanSample } from "./types.js";
import { testField, testRobot, testWaypoints } from "./testing/fixtures.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadAuto, loadField, loadRobot, loadWaypoints } from "./load.js";
import { noSeasonRules } from "./season.js";

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

  it("names the robot's height and its provenance for a raised box the height decided", () => {
    const tall = { ...testRobot, heightIn: { value: 30, provenance: "PLACEHOLDER: test fixture" } };
    const hit = findingsFor(lineAcrossTheHive(-16), tall).find(
      (finding) => finding.geometry?.obstacleId === "hiveRedPivotBar",
    );
    expect(hit?.message).toMatch(/with the robot 30 in tall \(placeholder\)\.$/);
  });
});

/** The starter project's own files, so a test can move one point of a real routine. */
const starter = (() => {
  const root = fileURLToPath(new URL("../../../examples/starter/autos/", import.meta.url));
  const read = (relative: string): unknown => JSON.parse(readFileSync(`${root}${relative}`, "utf8"));
  return {
    read,
    robot: loadRobot(read("robot.json")),
    field: loadField(read("field/biobuzz.field.json")),
    waypoints: loadWaypoints(read("waypoints.json")),
  };
})();

/** collect-and-score with one path step's single segment ending at `to` instead of its waypoint. */
function collectAndScoreWith(stepId: string, to: { xIn: number; yIn: number }): Auto {
  const json = starter.read("collect-and-score.auto.json") as { steps: Array<Record<string, unknown>> };
  const steps = json.steps.map((step) => {
    if (step["id"] !== stepId) return step;
    const segments = step["segments"] as Array<Record<string, unknown>>;
    return { ...step, segments: [{ ...segments[0], to }] };
  });
  return loadAuto({ ...json, steps });
}

const starterFindings = (auto: Auto): Finding[] => {
  const planned = plan(resolve(auto, starter.waypoints), starter.robot, starter.field);
  return check(planned, null, starter.robot, starter.field);
};

/**
 * Issue #229's contract, and why the starter left it (issue #365): an 18 in robot under the RED hive
 * clears the hive frame's west legs only east of about x = -9. The starter's old route under the hive,
 * its scoring spot on x = -9 and its curve controls on x = -5, cleared the legs and went over the
 * centre line, which OPPONENT_SIDE now reports (`packages/season-biobuzz/src/opponentSide.test.ts`
 * runs the kept corridor fixture under the BIOBUZZ season and finds it); moved back to the old
 * x = -12, it drives into both west legs. The starter now goes round the west side of the frame instead.
 */
describe("issue #229: a route under the hive and the frame's legs", () => {
  /** The old toOtherSide alone, from the scoring spot south of the hive on `spotXIn`, under the hive on `controlXIn`. */
  const structureOn = (spotXIn: number, controlXIn: number): Finding[] => {
    const auto = parseAuto({
      $schema: SCHEMA_ID.auto,
      formatVersion: 4,
      name: "under-the-hive",
      alliance: "RED",
      start: { pose: { xIn: spotXIn, yIn: -36, headingRad: Math.PI / 2 } },
      steps: [
        {
          id: "toOtherSide",
          kind: "path",
          segments: [
            {
              kind: "bezier",
              from: "current",
              control: [
                { xIn: controlXIn, yIn: 10 },
                { xIn: controlXIn, yIn: 40 },
                { xIn: -24, yIn: 34 },
              ],
              to: { xIn: -24, yIn: 46 },
            },
          ],
          heading: { mode: "tangent" },
        },
      ],
    });
    return check(plan(resolve(auto), starter.robot, starter.field), null, starter.robot, starter.field).filter(
      (finding) => finding.code === "STRUCTURE",
    );
  };

  it("clears the legs on the starter's old line, x = -9 and -5", () => {
    expect(structureOn(-9, -5)).toEqual([]);
  });

  it("drives into frameLegNorthWest and frameLegSouthWest when moved back to x = -12", () => {
    const legs = new Set(structureOn(-12, -12).map((finding) => finding.geometry?.obstacleId));
    expect(legs.has("frameLegNorthWest")).toBe(true);
    expect(legs.has("frameLegSouthWest")).toBe(true);
  });

  it("is not where the starter goes any more: its collect-and-score touches no structure", () => {
    const findings = starterFindings(loadAuto(starter.read("collect-and-score.auto.json")));
    expect(findings.filter((finding) => finding.code === "STRUCTURE")).toEqual([]);
  });
});

describe("issue #152: one collision is reported once, on the step that drove into it", () => {
  it("collectFlower ending 0.9 in into flower1's foot gives one STRUCTURE, on collectFlower", () => {
    // The robot stands there through waitForFull and stopIntake, and toScoreNorth starts there: on
    // main those were three more copies of the same error.
    const structure = starterFindings(collectAndScoreWith("collectFlower", { xIn: -24, yIn: 59 })).filter(
      (finding) => finding.code === "STRUCTURE",
    );
    expect(structure.map((finding) => finding.stepId)).toEqual(["collectFlower"]);
    expect(structure[0]?.geometry?.obstacleId).toBe("flower1Foot");
    expect(structure[0]?.geometry?.penetrationIn).toBeCloseTo(0.9, 6);
  });

  it("sweepGarden ending 1 in through the west wall gives one PERIMETER, on sweepGarden", () => {
    const findings = starterFindings(collectAndScoreWith("sweepGarden", { xIn: -64, yIn: -62 }));
    const perimeter = findings.filter((finding) => finding.code === "PERIMETER");
    expect(perimeter.map((finding) => finding.stepId)).toEqual(["sweepGarden"]);
    // Nothing on stopGardenIntake, nor on returnToScore's members: driveBack starts where the sweep
    // ended, with the same heading, and the sequence beside it stands there too.
    const later = ["stopGardenIntake", "returnToScore", "driveBack", "clearThenSpinUp", "clearGarden", "readyLauncher"];
    expect(findings.filter((finding) => later.includes(finding.stepId) && finding.severity === "error")).toEqual([]);
  });

  it("still reports a command that stands at a start pose clipping the wall", () => {
    // The auto's start counts as not checked yet, so the first step to stand there reports it. The
    // path after it starts there with the same heading and drives clear, so it reports nothing.
    const auto = parseAuto({
      formatVersion: 1,
      name: "clipping-start",
      alliance: "RED",
      start: { pose: { xIn: 0, yIn: -64, headingRad: Math.PI / 2 } },
      steps: [
        { id: "spin", kind: "command", name: "setIntake" },
        {
          id: "away",
          kind: "path",
          segments: [{ kind: "line", from: "current", to: { xIn: 0, yIn: -30 } }],
          heading: { mode: "constant", headingRad: Math.PI / 2 },
        },
      ],
    });
    const perimeter = findingsFor(auto).filter((finding) => finding.code === "PERIMETER");
    expect(perimeter.map((finding) => finding.stepId)).toEqual(["spin"]);
    expect(perimeter[0]?.message).toContain("1.00 in");
  });

  it("keeps the turn-at-start message for a tangent path that turns at a wall start after a command", () => {
    // The command stands flush with the wall, which is legal. The path's first sample is the same
    // spot turned 42 degrees, which is a new pose, so it is still checked and still explained.
    const auto = parseAuto({
      formatVersion: 1,
      name: "turn-at-the-wall",
      alliance: "RED",
      start: { pose: { xIn: 0, yIn: -63, headingRad: Math.PI / 2 } },
      steps: [
        { id: "spin", kind: "command", name: "setIntake" },
        {
          id: "offTheWall",
          kind: "path",
          segments: [{ kind: "line", from: "current", to: { xIn: -30, yIn: -30, headingRad: Math.PI / 2 } }],
          heading: { mode: "tangent" },
        },
      ],
    });
    const perimeter = findingsFor(auto).filter((finding) => finding.code === "PERIMETER");
    expect(perimeter.map((finding) => finding.stepId)).toEqual(["offTheWall"]);
    expect(perimeter[0]?.message).toContain("the robot turns while it is still against the wall");
  });
});

describe("issue #155: a path that turns against the wall it starts on offers Turn while driving", () => {
  /**
   * collect-and-score as "Move the start to the nearest legal spot" left it on main (sweep finding
   * N25): the start and driveOut's first point at (-42, -63) against the south wall, facing 90
   * degrees. driveOut is a tangent line to scoreSouth at (-13, -36), so the robot turns about 47
   * degrees while it is still flush with the wall.
   */
  const againstTheWall = (): Auto => {
    const json = starter.read("collect-and-score.auto.json") as {
      start: Record<string, unknown>;
      steps: Array<Record<string, unknown>>;
    };
    const pose = { xIn: -42, yIn: -63, headingRad: 1.5708, provenance: "SET FROM EDITOR: test" };
    const steps = json.steps.map((step) => {
      if (step["id"] !== "driveOut") return step;
      const segments = step["segments"] as Array<Record<string, unknown>>;
      return { ...step, segments: [{ ...segments[0], from: pose }] };
    });
    return loadAuto({ ...json, start: { ...json.start, pose }, steps });
  };
  const perimeterOn = (findings: readonly Finding[], stepId: string): Finding[] =>
    findings.filter((finding) => finding.code === "PERIMETER" && finding.stepId === stepId);
  const errors = (findings: readonly Finding[]): string[] =>
    findings.filter((finding) => finding.severity === "error").map((finding) => `${finding.code} ${finding.stepId}`);

  it("carries a linearHeading fix from the heading the robot has to the one the path ends with", () => {
    const [perimeter] = perimeterOn(starterFindings(againstTheWall()), "driveOut");
    expect(perimeter?.message).toContain("the robot turns while it is still against the wall");
    // Turn while driving, then Route around the field wall (issue #309).
    expect(perimeter?.fixes?.map((fix) => fix.kind)).toEqual(["linearHeading", "optimizeRoute"]);
    const fix = perimeter?.fixes?.[0];
    expect(fix).toMatchObject({ kind: "linearHeading", stepId: "driveOut", label: "Turn while driving" });
    if (fix?.kind !== "linearHeading") throw new Error("no linearHeading fix");
    expect(fix.params.fromRad).toBe(1.5708);
    // The tangent of the line from (-42, -63) to (-13, -36), which is where the path ends facing.
    expect(fix.params.toRad).toBeCloseTo(Math.atan2(27, 29), 4);
  });

  it("clears the PERIMETER finding once applied, and adds no other error", () => {
    const before = starterFindings(againstTheWall());
    const fix = perimeterOn(before, "driveOut")[0]?.fixes?.[0];
    if (fix === undefined) throw new Error("no fix");
    const after = starterFindings(applyFix(againstTheWall(), fix));
    expect(perimeterOn(after, "driveOut")).toEqual([]);
    expect(errors(after)).toEqual(errors(before).filter((error) => error !== "PERIMETER driveOut"));
    const driveOut = applyFix(againstTheWall(), fix).steps.find((step) => step.id === "driveOut");
    expect(driveOut?.kind === "path" ? driveOut.heading : null).toEqual({ mode: "linear", ...fix.params });
  });

  it("turns the short way round when the end heading is across the half turn", () => {
    expect(turnWhileDrivingFix("leg", 3, -3).params).toEqual({ fromRad: 3, toRad: 3.2832 });
    expect(turnWhileDrivingFix("leg", -3, 3).params).toEqual({ fromRad: -3, toRad: -3.2832 });
  });

  it("offers the same fix on a STRUCTURE the robot hits by turning on the spot as a path starts (N62)", () => {
    // Facing east just south of the test hive, 1 in clear of it. The tangent line south-west turns
    // the robot about 136 degrees where it stands, and its corner swings into the hive.
    const auto = parseAuto({
      formatVersion: 1,
      name: "turn-beside-the-hive",
      alliance: "RED",
      start: { pose: { xIn: -12.75, yIn: -14, headingRad: 0 } },
      steps: [
        {
          id: "away",
          kind: "path",
          segments: [{ kind: "line", from: "current", to: { xIn: -40, yIn: -40 } }],
          heading: { mode: "tangent" },
        },
      ],
    });
    const structure = findingsFor(auto).filter((finding) => finding.code === "STRUCTURE");
    expect(structure.map((finding) => finding.stepId)).toEqual(["away"]);
    const fix = structure[0]?.fixes?.[0];
    expect(fix).toMatchObject({ kind: "linearHeading", stepId: "away", label: "Turn while driving", params: { fromRad: 0 } });
    if (fix === undefined) throw new Error("no fix");
    expect(problems(findingsFor(applyFix(auto, fix)))).toEqual([]);
  });

  it("is not offered on a PERIMETER that is not a turn where the path starts", () => {
    // sweepGarden ends 1 in through the west wall, driving straight along it.
    const perimeter = perimeterOn(starterFindings(collectAndScoreWith("sweepGarden", { xIn: -64, yIn: -62 })), "sweepGarden");
    expect(perimeter).toHaveLength(1);
    expect(perimeter[0]?.message).not.toContain("turns while it is still against the wall");
    // Its end is an inline pose, so it offers the push-back fix of issue #186 instead.
    expect(perimeter[0]?.fixes?.map((fix) => fix.kind)).toEqual(["pushBack", "optimizeRoute"]);
  });
});

describe("issue #152: STRUCTURE reports how deep the robot really goes, and for how long", () => {
  /** One bar shaped like frameBarWest before issue #229: 1 in wide, 38.8 in long, at floor level. */
  const barField = parseField({
    ...testField,
    obstacles: [
      {
        id: "thinBar",
        kind: "box",
        minXIn: -25,
        maxXIn: -24,
        minYIn: -19.4,
        maxYIn: 19.4,
        minZIn: 0,
        maxZIn: 2,
        solidToRobot: true,
        provenance: "PLACEHOLDER: test fixture, the shape of the old frameBarWest",
      },
    ],
  });
  const throughTheBar = parseAuto({
    formatVersion: 1,
    name: "through-the-bar",
    alliance: "RED",
    start: { pose: { xIn: -24.5, yIn: -40, headingRad: Math.PI / 2 } },
    steps: [
      {
        id: "alongTheBar",
        kind: "path",
        segments: [{ kind: "line", from: "current", to: { xIn: -24.5, yIn: 40 } }],
        heading: { mode: "tangent" },
      },
    ],
  });

  it("says the robot drives into the bar 7.5 in deep for 56 in, at the middle of the run", () => {
    // The 14 in wide robot straddles the 1 in bar, so it has to move 7.5 in sideways to clear it,
    // from y = -28 to y = 28 on the 2 in samples. Every sample with |y| up to 20.9 is that deep,
    // so the worst one is the middle of that stretch, at y = 0, not the first one reached.
    const finding = check(plan(resolve(throughTheBar, testWaypoints), testRobot, barField), null, testRobot, barField).find(
      (candidate) => candidate.code === "STRUCTURE",
    );
    expect(finding?.geometry?.penetrationIn).toBeCloseTo(7.5, 6);
    expect(finding?.geometry?.contactIn).toBeCloseTo(56, 6);
    expect(finding?.geometry?.tRange?.[0]).toBeCloseTo(0.15, 6);
    expect(finding?.geometry?.tRange?.[1]).toBeCloseTo(0.85, 6);
    expect(finding?.t).toBeCloseTo(0.5, 6);
    expect(finding?.geometry?.poseIn?.yIn).toBeCloseTo(0, 6);
    expect(finding?.message).toBe("The robot drives into thinBar for about 56 in (t 0.15 to 0.85), up to 7.50 in deep.");
  });

  it("names the obstacle the way the season plugin does, keeping its id", () => {
    const season = { ...noSeasonRules, obstacleLabel: (id: string) => (id === "thinBar" ? "the thin bar" : null) };
    const planned = plan(resolve(throughTheBar, testWaypoints), testRobot, barField);
    const finding = check(planned, null, testRobot, barField, season).find((candidate) => candidate.code === "STRUCTURE");
    expect(finding?.message).toContain("drives into the thin bar (thinBar) for about 56 in");
  });

  it("names the obstacle once when the season's label is its id, never as thinBar (thinBar)", () => {
    const season = { ...noSeasonRules, obstacleLabel: (id: string) => id };
    const planned = plan(resolve(throughTheBar, testWaypoints), testRobot, barField);
    const finding = check(planned, null, testRobot, barField, season).find((candidate) => candidate.code === "STRUCTURE");
    expect(finding?.message).toBe("The robot drives into thinBar for about 56 in (t 0.15 to 0.85), up to 7.50 in deep.");
  });

  it("says where the robot stands for a command that overlaps an obstacle", () => {
    const auto = parseAuto({
      formatVersion: 1,
      name: "stand-on-the-bar",
      alliance: "RED",
      start: { pose: { xIn: -24.5, yIn: 0, headingRad: Math.PI / 2 } },
      steps: [{ id: "spin", kind: "command", name: "setIntake" }],
    });
    const finding = check(plan(resolve(auto, testWaypoints), testRobot, barField), null, testRobot, barField).find(
      (candidate) => candidate.code === "STRUCTURE",
    );
    expect(finding?.stepId).toBe("spin");
    expect(finding?.message).toBe("The footprint overlaps thinBar by 7.50 in where the robot stands for this step.");
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
    expect(perimeter[0]?.message).not.toContain("turns");
    // Which wall and where along the path, as STRUCTURE says (0.1.2 UX sweep W2-15).
    expect(perimeter[0]?.message).toMatch(/^The robot leaves the field past the east wall by \d+\.\d\d in, t 0\.\d\d to 1\.00\.$/);
    const range = perimeter[0]?.geometry?.tRange;
    expect(range?.[1]).toBe(1);
    expect(range?.[0]).toBeGreaterThan(0);
    expect(range?.[0]).toBeLessThan(1);
  });

  it("says the robot turns against the wall when PERIMETER is at a path's start", () => {
    // Flush against the audience wall, nose into the field: a tangent path off the diagonal turns
    // the robot about 42 deg before it has moved, and a corner swings through the wall.
    const offTheWall = (heading: Heading): Auto =>
      parseAuto({
        formatVersion: 1,
        name: "off-the-wall",
        alliance: "RED",
        start: { pose: { xIn: 0, yIn: -63, headingRad: Math.PI / 2 } },
        steps: [
          {
            id: "offTheWall",
            kind: "path",
            segments: [{ kind: "line", from: "current", to: { xIn: -30, yIn: -30, headingRad: Math.PI / 2 } }],
            heading,
          },
        ],
      });
    const tangent = findingsFor(offTheWall({ mode: "tangent" })).filter((finding) => finding.code === "PERIMETER");
    expect(tangent).toHaveLength(1);
    expect(tangent[0]?.message).toContain("the robot turns while it is still against the wall");
    const constant = findingsFor(offTheWall({ mode: "constant", headingRad: Math.PI / 2 }));
    expect(constant.filter((finding) => finding.code === "PERIMETER")).toHaveLength(0);
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

/**
 * A footprint finding carries the pose where it is worst, so the editor can draw the robot there:
 * a path that looks fine at both ends can still clip in the middle, and the ghost has to be there,
 * not at the start. Each case checks the carried polygon against every sample the check swept.
 */
describe("the worst pose on a footprint finding", () => {
  const planFor = (auto: Auto, field = testField) => plan(resolve(auto, testWaypoints), testRobot, field);
  const polygonsOf = (sample: PlanSample): Vec2[][] => [sample.footprintIn, ...sample.mouthsIn];

  it("puts PERIMETER at the far end of an out-and-back leg, not at either end", () => {
    const auto = parseAuto({
      formatVersion: 1,
      name: "out-and-back",
      alliance: "RED",
      start: { pose: { xIn: 40, yIn: 0, headingRad: 0 } },
      steps: [
        {
          id: "outAndBack",
          kind: "path",
          segments: [
            { kind: "line", from: "current", to: { xIn: 68, yIn: 0 } },
            { kind: "line", from: { xIn: 68, yIn: 0 }, to: { xIn: 40, yIn: 0 } },
          ],
          heading: { mode: "constant", headingRad: 0 },
        },
      ],
    });
    const planned = planFor(auto);
    const finding = check(planned, null, testRobot, testField).find((f) => f.code === "PERIMETER");
    const geometry = finding?.geometry;
    expect(geometry?.poseIn?.xIn).toBeCloseTo(68, 1);
    expect(finding?.t).toBeCloseTo(0.5, 2);
    expect(geometry?.poseIn?.headingRad).toBe(0);

    const bounds = fieldBounds(testField);
    const polygon = geometry?.footprintIn?.[geometry.worstPolygonIndex ?? -1];
    expect(polygon).toBeDefined();
    const carried = polygonOutsideBox(polygon as Vec2[], bounds).worstIn;
    expect(finding?.message).toContain(`${carried.toFixed(2)} in`);
    const samples = planned.steps[0]?.samples ?? [];
    for (const sample of samples) {
      for (const each of polygonsOf(sample)) {
        expect(polygonOutsideBox(each, bounds).worstIn).toBeLessThanOrEqual(carried + 1e-9);
      }
    }
  });

  it("puts STRUCTURE where a diagonal pass goes deepest into the hive", () => {
    const auto = parseAuto({
      formatVersion: 1,
      name: "diagonal-hive",
      alliance: "RED",
      start: { pose: { xIn: -40, yIn: 20, headingRad: 0 } },
      steps: [
        {
          id: "diagonal",
          kind: "path",
          segments: [{ kind: "line", from: "current", to: { xIn: 10, yIn: 4 } }],
          heading: { mode: "constant", headingRad: 0 },
        },
      ],
    });
    const planned = planFor(auto);
    const finding = check(planned, null, testRobot, testField).find(
      (f) => f.code === "STRUCTURE" && f.geometry?.obstacleId === "hiveRedBase",
    );
    const geometry = finding?.geometry;
    const box = { minXIn: -16.75, maxXIn: -8.75, minYIn: -6, maxYIn: 6 };
    const polygon = geometry?.footprintIn?.[geometry.worstPolygonIndex ?? -1] as Vec2[];
    const carried = polygonOverlapsBox(polygon, box).penetrationIn;
    expect(carried).toBeCloseTo(geometry?.penetrationIn ?? Number.NaN, 9);

    const samples = planned.steps[0]?.samples ?? [];
    const at = samples.find((sample) => sample.t === finding?.t);
    expect(at?.pose).toEqual(geometry?.poseIn);
    let deepestIn = 0;
    for (const sample of samples) {
      for (const each of polygonsOf(sample)) {
        const overlap = polygonOverlapsBox(each, box);
        if (overlap.overlaps) deepestIn = Math.max(deepestIn, overlap.penetrationIn);
      }
    }
    expect(carried).toBeCloseTo(deepestIn, 9);
    // Not either end: the deepest point of a diagonal pass is somewhere in the middle.
    expect(finding?.t).toBeGreaterThan(0);
    expect(finding?.t).toBeLessThan(1);
  });

  it("carries the same worst pose on KEEPOUT", () => {
    const field = parseField({
      ...testField,
      zones: [
        { id: "noGo", kind: "rect", minXIn: 20, maxXIn: 30, minYIn: -40, maxYIn: 2, appliesInAuto: true },
      ],
    });
    const auto = parseAuto({
      formatVersion: 1,
      name: "through-the-zone",
      alliance: "RED",
      start: { pose: { xIn: 0, yIn: 30, headingRad: 0 } },
      steps: [
        {
          id: "dip",
          kind: "path",
          segments: [{ kind: "bezier", from: "current", control: [{ xIn: 20, yIn: -10 }, { xIn: 30, yIn: -10 }], to: { xIn: 50, yIn: 30 } }],
          heading: { mode: "constant", headingRad: 0 },
        },
      ],
    });
    const planned = planFor(auto, field);
    const finding = check(planned, null, testRobot, field).find((f) => f.code === "KEEPOUT");
    const geometry = finding?.geometry;
    expect(geometry?.zoneId).toBe("noGo");
    const polygon = geometry?.footprintIn?.[geometry.worstPolygonIndex ?? -1] as Vec2[];
    const zone = { minXIn: 20, maxXIn: 30, minYIn: -40, maxYIn: 2 };
    let deepestIn = 0;
    for (const sample of planned.steps[0]?.samples ?? []) {
      for (const each of polygonsOf(sample)) {
        const overlap = polygonOverlapsBox(each, zone);
        if (overlap.overlaps) deepestIn = Math.max(deepestIn, overlap.penetrationIn);
      }
    }
    expect(polygonOverlapsBox(polygon, zone).penetrationIn).toBeCloseTo(deepestIn, 9);
    expect(geometry?.poseIn?.xIn).toBeGreaterThan(15);
    expect(geometry?.poseIn?.xIn).toBeLessThan(35);
  });
});

/**
 * Issue #228's contract: a slanted hive-frame leg blocks more of the floor the taller the robot
 * is. The fixture field holds the four legs of one hive frame, point-mirrored from one leg's
 * end-face centres, and nothing else, so only the legs can raise STRUCTURE.
 */
describe("issue #228: STRUCTURE against a slanted strut's shadow at the robot's height", () => {
  const leg = (id: string, sx: number, sy: number) => ({
    id,
    kind: "strut",
    fromIn: { xIn: sx * 23.81, yIn: sy * 18.56, zIn: 0.53 },
    toIn: { xIn: sx * 12.74, yIn: sy * 0.51, zIn: 41.09 },
    radiusIn: 0.78,
    solidToRobot: true,
    provenance: "PLACEHOLDER: test fixture, the shape of one hive-frame leg",
  });
  const strutField = parseField({
    ...testField,
    formatVersion: 3,
    obstacles: [
      leg("frameLegNorthEast", 1, 1),
      leg("frameLegSouthEast", 1, -1),
      leg("frameLegNorthWest", -1, 1),
      leg("frameLegSouthWest", -1, -1),
      {
        id: "crossbar",
        kind: "strut",
        fromIn: { xIn: -12.74, yIn: -0.51, zIn: 41.09 },
        toIn: { xIn: -12.74, yIn: 0.51, zIn: 41.09 },
        radiusIn: 0.5,
        solidToRobot: true,
        provenance: "PLACEHOLDER: test fixture, a level bar between the west legs' tops, far above any robot",
      },
    ],
  });
  /** An 18 by 18 in robot with a labelled height, so the message can name both. */
  const squareRobot = (heightIn: number) => ({
    ...testRobot,
    footprint: {
      ...testRobot.footprint,
      startIn: { lengthIn: 18, widthIn: 18, provenance: "PLACEHOLDER: test fixture" },
      expandedIn: { lengthIn: 18, widthIn: 18, provenance: "PLACEHOLDER: test fixture" },
    },
    heightIn: { value: heightIn, provenance: "PLACEHOLDER: test fixture" },
  });
  /** Straight north under the RED hive on one x. */
  const northOn = (xIn: number): Auto =>
    parseAuto({
      $schema: SCHEMA_ID.auto,
      formatVersion: 4,
      name: "under-the-hive",
      alliance: "RED",
      start: { pose: { xIn, yIn: -50, headingRad: Math.PI / 2 } },
      steps: [
        {
          id: "underTheHive",
          kind: "path",
          segments: [{ kind: "line", from: "current", to: { xIn, yIn: 50, headingRad: Math.PI / 2 } }],
          heading: { mode: "tangent" },
        },
      ],
    });
  const structure = (xIn: number, heightIn: number): Finding[] => {
    const robot = squareRobot(heightIn);
    return check(plan(resolve(northOn(xIn), testWaypoints), robot, strutField), null, robot, strutField).filter(
      (finding) => finding.code === "STRUCTURE",
    );
  };

  it("stops an 18 in robot on x = -12 at both west legs", () => {
    const hits = structure(-12, 18);
    expect(hits.map((finding) => finding.geometry?.obstacleId).sort()).toEqual(["frameLegNorthWest", "frameLegSouthWest"]);
    for (const finding of hits) {
      expect(finding.severity).toBe("error");
      expect(finding.stepId).toBe("underTheHive");
      expect(finding.geometry?.penetrationIn).toBeGreaterThan(3);
    }
  });

  it("gives the robot height it used and that height's provenance label", () => {
    for (const finding of structure(-12, 18)) {
      expect(finding.message).toContain("18 in");
      expect(finding.message).toContain("(placeholder)");
      expect(finding.message).toMatch(/with the robot 18 in tall \(placeholder\)\.$/);
    }
  });

  it("lets a 6 in robot drive the same route", () => {
    expect(structure(-12, 6)).toEqual([]);
  });

  it("lets the 18 in robot through on x = -7", () => {
    expect(structure(-7, 18)).toEqual([]);
  });

  it("never reports a strut whose whole envelope is above the robot", () => {
    // The crossbar lies right over the route at z 41, and even a 29 in robot is far below it.
    for (const heightIn of [6, 18, 29]) {
      expect(structure(-12, heightIn).filter((finding) => finding.geometry?.obstacleId === "crossbar")).toEqual([]);
    }
  });

  it("offers a push-back off a strut, measured on the box around its shadow, that re-checks clean", () => {
    // The robot drives east and stops with its nose in the north-west leg's band at 18 in.
    const robot = squareRobot(18);
    const auto = parseAuto({
      $schema: SCHEMA_ID.auto,
      formatVersion: 4,
      name: "into-the-leg",
      alliance: "RED",
      start: { pose: { xIn: -50, yIn: 14, headingRad: 0 } },
      steps: [
        {
          id: "intoTheLeg",
          kind: "path",
          segments: [{ kind: "line", from: "current", to: { xIn: -28, yIn: 14, headingRad: 0, provenance: "SET BY HAND: test" } }],
          heading: { mode: "tangent" },
        },
      ],
    });
    const run = (candidate: Auto): Finding[] =>
      check(plan(resolve(candidate, testWaypoints), robot, strutField), null, robot, strutField).filter(
        (finding) => finding.code === "STRUCTURE",
      );
    const before = run(auto);
    expect(before.map((finding) => finding.geometry?.obstacleId)).toEqual(["frameLegNorthWest"]);
    const fix = (before[0]?.fixes ?? []).find((candidate) => candidate.kind === "pushBack");
    expect(fix?.label).toBe("Push the end clear of frameLegNorthWest");
    expect(run(applyFix(auto, fix as NonNullable<typeof fix>))).toEqual([]);
  });

  it("leaves a ground-level box's message as it was: the height did not decide it", () => {
    const finding = findingsFor(lineAcrossTheHive(12)).find((candidate) => candidate.code === "STRUCTURE");
    expect(finding?.message).not.toContain("tall");
  });
});

/**
 * Issue #272, ruled by the owner on #200: STRUCTURE decides clipping against a strut from the robot's
 * optional `heightIn` in robot.json, the key the z gate reads (`robotHeightIn`), and from no second
 * key. These tests pin that for the strut check itself, so a later change that gave struts their
 * own height, or lost the default, fails here and not on a field.
 */
describe("issue #272: the strut check reads the robot's heightIn and nothing else", () => {
  const leg = (id: string, sx: number, sy: number) => ({
    id,
    kind: "strut",
    fromIn: { xIn: sx * 23.81, yIn: sy * 18.56, zIn: 0.53 },
    toIn: { xIn: sx * 12.74, yIn: sy * 0.51, zIn: 41.09 },
    radiusIn: 0.78,
    solidToRobot: true,
    provenance: "PLACEHOLDER: test fixture, the shape of one hive-frame leg",
  });
  const legsField = parseField({
    ...testField,
    formatVersion: 3,
    obstacles: [leg("frameLegNorthWest", -1, 1), leg("frameLegSouthWest", -1, -1)],
  });
  const squareFootprint = {
    ...testRobot.footprint,
    startIn: { lengthIn: 18, widthIn: 18, provenance: "PLACEHOLDER: test fixture" },
    expandedIn: { lengthIn: 18, widthIn: 18, provenance: "PLACEHOLDER: test fixture" },
  };
  const northOnX = parseAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 4,
    name: "under-the-hive",
    alliance: "RED",
    start: { pose: { xIn: -12, yIn: -50, headingRad: Math.PI / 2 } },
    steps: [
      {
        id: "underTheHive",
        kind: "path",
        segments: [{ kind: "line", from: "current", to: { xIn: -12, yIn: 50, headingRad: Math.PI / 2 } }],
        heading: { mode: "tangent" },
      },
    ],
  });
  /** The STRUCTURE findings for one robot driving north on x = -12, through both west legs. */
  const structureFor = (robot: typeof testRobot): Finding[] =>
    check(plan(resolve(northOnX, testWaypoints), robot, legsField), null, robot, legsField).filter(
      (finding) => finding.code === "STRUCTURE",
    );
  const depthOn = (findings: readonly Finding[], obstacleId: string): number =>
    findings.find((finding) => finding.geometry?.obstacleId === obstacleId)?.geometry?.penetrationIn ?? 0;
  const labelled = (heightIn: number) => ({ value: heightIn, provenance: "MEASURED: test fixture" });

  it("takes the part of a leg the robot hits from heightIn: a taller robot hits more of it", () => {
    const at = (heightIn: number) =>
      structureFor({ ...testRobot, footprint: squareFootprint, heightIn: labelled(heightIn) });
    expect(at(6)).toEqual([]);
    const shorter = depthOn(at(14), "frameLegNorthWest");
    const taller = depthOn(at(26), "frameLegNorthWest");
    expect(shorter).toBeGreaterThan(0);
    expect(taller).toBeGreaterThan(shorter);
  });

  it("uses the default height, and says it is the default, when robot.json gives no heightIn", () => {
    const absent = { ...testRobot, footprint: squareFootprint };
    expect(absent.heightIn).toBeUndefined();
    const explicit = structureFor({ ...absent, heightIn: labelled(DEFAULT_ROBOT_HEIGHT_IN) });
    const defaulted = structureFor(absent);
    expect(defaulted.length).toBe(2);
    expect(defaulted.map((finding) => finding.geometry)).toEqual(explicit.map((finding) => finding.geometry));
    for (const finding of defaulted) {
      expect(finding.message).toMatch(new RegExp(`with the robot ${String(DEFAULT_ROBOT_HEIGHT_IN)} in tall \\(placeholder\\)\\.$`));
    }
    for (const finding of explicit) {
      expect(finding.message).toMatch(new RegExp(`with the robot ${String(DEFAULT_ROBOT_HEIGHT_IN)} in tall \\(measured\\)\\.$`));
    }
  });

  it("reads the same key the z gate reads: the root heightIn wins, then the footprint's", () => {
    const footprint = { ...squareFootprint, heightIn: { value: 6, provenance: "MEASURED: test fixture" } };
    // The footprint's 6 in alone clears the legs, as heightIn 6 does.
    expect(structureFor({ ...testRobot, footprint })).toEqual([]);
    // A root heightIn of 26 wins over it, and robotHeightIn says 26, the number the strut check used.
    const robot = { ...testRobot, footprint, heightIn: labelled(26) };
    expect(robotHeightIn(robot)).toBe(26);
    const hits = structureFor(robot);
    expect(hits.map((finding) => finding.geometry?.obstacleId).sort()).toEqual(["frameLegNorthWest", "frameLegSouthWest"]);
    for (const finding of hits) expect(finding.message).toContain("with the robot 26 in tall (measured)");
  });
});
