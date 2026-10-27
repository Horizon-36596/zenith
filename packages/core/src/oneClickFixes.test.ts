import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseAuto, parseWaypoints, SCHEMA_ID, type Auto, type PathStep, type Robot } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { check } from "./check.js";
import { estimate } from "./estimate.js";
import { applyFix } from "./fix.js";
import { loadAuto, loadField, loadRobot, loadWaypoints } from "./load.js";
import { plan } from "./plan.js";
import { EDITOR_PROVENANCE } from "./provenance.js";
import { resolve } from "./resolve.js";
import { testField, testRobot, testWaypoints } from "./testing/fixtures.js";
import type { Finding, FindingCode, Fix } from "./types.js";

/**
 * The one-click fixes the help text and spec 05 promised but no check offered (issue #186, sweep
 * finding N52): split a turn of over half a circle (HEADING), start from where the robot is
 * (CONTINUITY at a step's start, MOVES_ROBOT), and push a path's end back from a wall or an obstacle
 * (PERIMETER, STRUCTURE).
 */

const root = fileURLToPath(new URL("../../../examples/starter/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${root}${relative}`, "utf8"));

const starterRobot = loadRobot(read("autos/robot.json"));
const starterField = loadField(read("autos/field/biobuzz.field.json"));
const starterWaypoints = loadWaypoints(read("autos/waypoints.json"));

/** collect-and-score with its top-level steps rewritten. */
function starter(rewrite: (steps: Record<string, unknown>[]) => Record<string, unknown>[]): Auto {
  const raw = read("autos/collect-and-score.auto.json") as { steps: Record<string, unknown>[] };
  return loadAuto({ ...raw, steps: rewrite(raw.steps.map((step) => ({ ...step }))) });
}

function runStarter(auto: Auto, robot: Robot = starterRobot): Finding[] {
  const planned = plan(resolve(auto, starterWaypoints), robot, starterField);
  return check(planned, estimate(planned, robot), robot, starterField);
}

const on = (findings: readonly Finding[], code: FindingCode, stepId: string): Finding[] =>
  findings.filter((finding) => finding.code === code && finding.stepId === stepId);

const fixOf = (finding: Finding | undefined, kind: Fix["kind"]): Fix => {
  const fix = finding?.fixes?.find((candidate) => candidate.kind === kind);
  if (fix === undefined) throw new Error(`expected a ${kind} fix on ${finding?.code ?? "no finding"}`);
  return fix;
};

const pathStep = (auto: Auto, id: string): PathStep => {
  const step = auto.steps.find((candidate) => candidate.id === id);
  if (step?.kind !== "path") throw new Error(`no path ${id}`);
  return step;
};

describe("HEADING offers a split", () => {
  const longTurn = (): Auto =>
    starter((steps) =>
      steps.map((step) => (step["id"] === "toGarden" ? { ...step, heading: { mode: "linear", fromRad: 0, toRad: 4.4 } } : step)),
    );

  it("on toGarden with a linear heading from 0 to 4.4 rad, and applying it clears HEADING though toGarden starts from current", () => {
    const auto = longTurn();
    const heading = on(runStarter(auto), "HEADING", "toGarden");
    expect(heading).toHaveLength(1);
    const fix = fixOf(heading[0], "splitSegment");
    expect(fix.stepId).toBe("toGarden");
    expect(fix.label).toBe("Split the path in two");

    const fixed = applyFix(auto, fix);
    const step = pathStep(fixed, "toGarden");
    expect(step.segments).toHaveLength(2);
    expect(step.segments[0]?.from).toBe("current");
    expect(step.segments[1]?.to).toEqual({ ref: "gardenSweepStart" });
    // The new point is the editor's, and the curve's new handles say so too.
    expect(step.segments[0]?.to).toMatchObject({ provenance: EDITOR_PROVENANCE });
    for (const half of step.segments) {
      if (half.kind === "bezier") for (const control of half.control) expect(control.provenance).toBe(EDITOR_PROVENANCE);
    }
    // The heading is still the one sweep, so the robot faces where it always would have at the cut.
    expect(step.heading).toEqual({ mode: "linear", fromRad: 0, toRad: 4.4 });
    expect(on(runStarter(fixed), "HEADING", "toGarden")).toEqual([]);
  });

  it("splits into as many pieces as it takes to keep each under half a turn", () => {
    const auto = starter((steps) =>
      steps.map((step) => (step["id"] === "toGarden" ? { ...step, heading: { mode: "linear", fromRad: 0, toRad: 7 } } : step)),
    );
    const fix = fixOf(on(runStarter(auto), "HEADING", "toGarden")[0], "splitSegment");
    expect(fix.label).toBe("Split the path into 3");
    const fixed = applyFix(auto, fix);
    expect(pathStep(fixed, "toGarden").segments).toHaveLength(3);
    expect(on(runStarter(fixed), "HEADING", "toGarden")).toEqual([]);
  });

  it("on a piecewise range over half a turn, splits the range", () => {
    const auto = starter((steps) =>
      steps.map((step) =>
        step["id"] === "toGarden"
          ? {
              ...step,
              heading: {
                mode: "piecewise",
                ranges: [
                  { startT: 0, endT: 0.5, heading: { mode: "constant", headingRad: 0 } },
                  { startT: 0.5, endT: 1, heading: { mode: "linear", fromRad: 0, toRad: 4.4 } },
                ],
              },
            }
          : step,
      ),
    );
    const heading = on(runStarter(auto), "HEADING", "toGarden");
    expect(heading).toHaveLength(1);
    const fix = fixOf(heading[0], "splitHeadingRange");
    expect(fix.label).toBe("Split range 2 in two");
    const fixed = applyFix(auto, fix);
    const step = pathStep(fixed, "toGarden");
    expect(step.segments).toHaveLength(1);
    expect(step.heading).toEqual({
      mode: "piecewise",
      ranges: [
        { startT: 0, endT: 0.5, heading: { mode: "constant", headingRad: 0 } },
        { startT: 0.5, endT: 0.75, heading: { mode: "linear", fromRad: 0, toRad: 2.2 } },
        { startT: 0.75, endT: 1, heading: { mode: "linear", fromRad: 2.2, toRad: 4.4 } },
      ],
    });
    expect(on(runStarter(fixed), "HEADING", "toGarden")).toEqual([]);
  });
});

describe("Start from where the robot is", () => {
  it("is offered on MOVES_ROBOT for toOtherSide from a fixed pose after a movesRobot command, and clears it", () => {
    const robot = loadRobot({
      ...(read("autos/robot.json") as Record<string, unknown>),
      commands: [
        ...((read("autos/robot.json") as { commands: unknown[] }).commands),
        { name: "huntPollen", estimateS: "unknown", requires: ["drive"], movesRobot: true },
      ],
    });
    const auto = starter((steps) =>
      steps.flatMap((step) => {
        if (step["id"] !== "toOtherSide") return [step];
        const [segment, ...rest] = step["segments"] as Record<string, unknown>[];
        return [
          { id: "hunt", kind: "command", name: "huntPollen" },
          {
            ...step,
            segments: [{ ...segment, from: { xIn: -12, yIn: -20, provenance: "SET BY HAND: test" } }, ...rest],
          },
        ];
      }),
    );
    const moves = on(runStarter(auto, robot), "MOVES_ROBOT", "toOtherSide");
    expect(moves).toHaveLength(1);
    const fix = fixOf(moves[0], "startFromCurrent");
    expect(fix.label).toBe("Start from where the robot is");
    const fixed = applyFix(auto, fix);
    expect(pathStep(fixed, "toOtherSide").segments[0]?.from).toBe("current");
    expect(on(runStarter(fixed, robot), "MOVES_ROBOT", "toOtherSide")).toEqual([]);
  });

  it("is offered on CONTINUITY where a step starts away from the robot, and clears it", () => {
    const auto = starter((steps) =>
      steps.map((step) => {
        if (step["id"] !== "toOtherSide") return step;
        const [segment, ...rest] = step["segments"] as Record<string, unknown>[];
        return { ...step, segments: [{ ...segment, from: { xIn: -30, yIn: -20, provenance: "SET BY HAND: test" } }, ...rest] };
      }),
    );
    const gap = on(runStarter(auto), "CONTINUITY", "toOtherSide");
    expect(gap).toHaveLength(1);
    const fix = fixOf(gap[0], "startFromCurrent");
    const fixed = applyFix(auto, fix);
    expect(on(runStarter(fixed), "CONTINUITY", "toOtherSide")).toEqual([]);
  });

  it("leaves a document whose step is gone as it was", () => {
    const auto = starter((steps) => steps);
    const fixed = applyFix(auto, { kind: "startFromCurrent", stepId: "nowhere", label: "x", params: {} });
    expect(fixed).toBe(auto);
  });
});

/** The test robot is 18 in along its nose and 14 in across; the test field runs from -72 to 72. */
const fixture = (steps: unknown[]): Auto =>
  parseAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 1,
    name: "push-back",
    alliance: "RED",
    start: { pose: { xIn: -40, yIn: -40, headingRad: 0 } },
    steps,
  });

/** The test waypoints and one past the south wall, which a path can end on. */
const waypoints = parseWaypoints({
  ...testWaypoints,
  waypoints: {
    ...testWaypoints.waypoints,
    pastWall: { xIn: -40, yIn: -68, headingRad: 0, provenance: "SET BY HAND: test, 3 in past the south wall" },
  },
});

const runFixture = (auto: Auto): Finding[] => {
  const planned = plan(resolve(auto, waypoints), testRobot, testField);
  return check(planned, estimate(planned, testRobot), testRobot, testField);
};

const drive = (id: string, to: unknown, control?: unknown[]): Record<string, unknown> => ({
  id,
  kind: "path",
  segments: [control === undefined ? { kind: "line", from: "current", to } : { kind: "bezier", from: "current", control, to }],
  heading: { mode: "constant", headingRad: 0 },
});

describe("Push back", () => {
  it("is not offered where the robot leaves the field in the middle of a path", () => {
    const auto = fixture([
      drive("dip", { xIn: -20, yIn: -40, provenance: "SET BY HAND: test" }, [{ xIn: -30, yIn: -100 }]),
    ]);
    const perimeter = on(runFixture(auto), "PERIMETER", "dip");
    expect(perimeter).toHaveLength(1);
    expect(perimeter[0]?.t).toBeGreaterThan(0.2);
    expect(perimeter[0]?.t).toBeLessThan(0.8);
    expect((perimeter[0]?.fixes ?? []).filter((fix) => fix.kind === "pushBack")).toEqual([]);
  });

  it("is offered where a path ends on an inline pose past the wall, and clears PERIMETER", () => {
    const auto = fixture([drive("toWall", { xIn: -40, yIn: -68, headingRad: 0, provenance: "SET BY HAND: test" })]);
    const perimeter = on(runFixture(auto), "PERIMETER", "toWall");
    expect(perimeter).toHaveLength(1);
    expect(perimeter[0]?.t).toBe(1);
    const fix = fixOf(perimeter[0], "pushBack");
    expect(fix.label).toBe("Push the end back from the wall");
    expect(fix.params).not.toHaveProperty("clearOf");
    const fixed = applyFix(auto, fix);
    const end = pathStep(fixed, "toWall").segments[0]?.to as { xIn: number; yIn: number; headingRad: number; provenance: string };
    expect(end.xIn).toBe(-40);
    expect(end.yIn).toBeGreaterThan(-65.01);
    expect(end.yIn).toBeLessThan(-64.8);
    expect(end.headingRad).toBe(0);
    expect(end.provenance).toBe(EDITOR_PROVENANCE);
    expect(on(runFixture(fixed), "PERIMETER", "toWall")).toEqual([]);
  });

  /** toWall ends past the south wall at (-40, -68), and away leaves from there. */
  const toWallThenAway = (from: unknown): Auto =>
    fixture([
      drive("toWall", { xIn: -40, yIn: -68, headingRad: 0, provenance: "SET BY HAND: test" }),
      {
        id: "away",
        kind: "path",
        segments: [{ kind: "line", from, to: { xIn: -20, yIn: -40, headingRad: 0, provenance: "SET BY HAND: test" } }],
        heading: { mode: "constant", headingRad: 0 },
      },
    ]);

  it("is not offered where the next step is written to start at the old end, which the move would leave behind", () => {
    const auto = toWallThenAway({ xIn: -40, yIn: -68, headingRad: 0, provenance: "SET BY HAND: test" });
    const findings = runFixture(auto);
    expect(on(findings, "CONTINUITY", "away")).toEqual([]);
    const perimeter = on(findings, "PERIMETER", "toWall");
    expect(perimeter).toHaveLength(1);
    expect((perimeter[0]?.fixes ?? []).filter((fix) => fix.kind === "pushBack")).toEqual([]);
    // Moving the end as the fix would have opens a jump at away's start: that is what it must not offer.
    const moved = applyFix(auto, { kind: "pushBack", stepId: "toWall", label: "x", params: { xIn: -40, yIn: -64.9 } });
    expect(on(runFixture(moved), "CONTINUITY", "away")).toHaveLength(1);
  });

  it("is not offered either where a wait in a sequence comes between the end and the step that starts there", () => {
    const [toWall, away] = toWallThenAway({ xIn: -40, yIn: -68, headingRad: 0, provenance: "SET BY HAND: test" }).steps;
    const auto = fixture([{ id: "group", kind: "sequence", steps: [toWall, { id: "pause", kind: "wait", seconds: 0.5 }] }, away]);
    const perimeter = on(runFixture(auto), "PERIMETER", "toWall");
    expect(perimeter).toHaveLength(1);
    expect((perimeter[0]?.fixes ?? []).filter((fix) => fix.kind === "pushBack")).toEqual([]);
  });

  it("is offered where the next step starts from current, and the fixed auto re-checks clean on both steps", () => {
    const auto = toWallThenAway("current");
    const before = runFixture(auto);
    const fix = fixOf(on(before, "PERIMETER", "toWall")[0], "pushBack");
    const after = runFixture(applyFix(auto, fix));
    expect(on(after, "PERIMETER", "toWall")).toEqual([]);
    for (const code of ["CONTINUITY", "PERIMETER", "STRUCTURE"] as const) expect(on(after, code, "away")).toEqual([]);
    const errors = (findings: readonly Finding[]): string[] =>
      findings.filter((finding) => finding.severity === "error").map((finding) => `${finding.code}@${finding.stepId ?? ""}`);
    expect(errors(after).filter((error) => !errors(before).includes(error))).toEqual([]);
  });

  it("is not offered where the end is a waypoint", () => {
    const auto = fixture([drive("toTile", { ref: "pastWall" })]);
    const perimeter = on(runFixture(auto), "PERIMETER", "toTile");
    expect(perimeter).toHaveLength(1);
    expect((perimeter[0]?.fixes ?? []).filter((fix) => fix.kind === "pushBack")).toEqual([]);
  });

  it("is offered where a path ends inside an obstacle, and clears STRUCTURE", () => {
    // hiveRedBase runs x -16.75 to -8.75, y -6 to 6, and the robot's nose is 9 in ahead of its centre.
    const auto = fixture([
      { ...drive("approach", { xIn: -40, yIn: 0, headingRad: 0, provenance: "SET BY HAND: test" }) },
      drive("intoHive", { xIn: -24, yIn: 0, headingRad: 0, provenance: "SET BY HAND: test" }),
    ]);
    const structure = on(runFixture(auto), "STRUCTURE", "intoHive");
    expect(structure).toHaveLength(1);
    const fix = fixOf(structure[0], "pushBack");
    expect(fix.label).toBe("Push the end clear of hiveRedBase");
    expect(fix.params).toMatchObject({ clearOf: "hiveRedBase" });
    const fixed = applyFix(auto, fix);
    const end = pathStep(fixed, "intoHive").segments[0]?.to as { xIn: number; yIn: number };
    // Pushed to a tenth of an inch past the robot's 1 in clearance, so CLEARANCE does not appear at once (W2-5).
    expect(end.xIn).toBeLessThan(-26.75);
    expect(end.xIn).toBeGreaterThan(-27);
    expect(end.yIn).toBe(0);
    const after = runFixture(fixed);
    expect(on(after, "STRUCTURE", "intoHive")).toEqual([]);
    expect(on(after, "CLEARANCE", "intoHive")).toEqual([]);
  });

  it("offers no Route around on a CLEARANCE whose closest point is the path's own end (0.1.2 UX sweep W2-4)", () => {
    // The nose stops 0.5 in short of hiveRedBase's west face, x = -16.75.
    const auto = fixture([drive("short", { xIn: -26.25, yIn: 0, headingRad: 0, provenance: "SET BY HAND: test" })]);
    const clearance = on(runFixture(auto), "CLEARANCE", "short");
    expect(clearance).toHaveLength(1);
    expect(clearance[0]?.t).toBe(1);
    expect((clearance[0]?.fixes ?? []).filter((fix) => fix.kind === "optimizeRoute")).toEqual([]);
  });

  it("falls back to a tenth of an inch clear when no spot the robot's clearance away re-checks clean", () => {
    const wide: Robot = { ...testRobot, footprint: { ...testRobot.footprint, clearanceIn: { value: 60, provenance: "SET BY HAND: test" } } };
    const auto = fixture([
      { ...drive("approach", { xIn: -40, yIn: 0, headingRad: 0, provenance: "SET BY HAND: test" }) },
      drive("intoHive", { xIn: -24, yIn: 0, headingRad: 0, provenance: "SET BY HAND: test" }),
    ]);
    const planned = plan(resolve(auto, waypoints), wide, testField);
    const structure = on(check(planned, estimate(planned, wide), wide, testField), "STRUCTURE", "intoHive");
    const end = pathStep(applyFix(auto, fixOf(structure[0], "pushBack")), "intoHive").segments[0]?.to as { xIn: number; yIn: number };
    expect(end.xIn).toBeLessThan(-25.75);
    expect(end.xIn).toBeGreaterThan(-26);
  });
});
