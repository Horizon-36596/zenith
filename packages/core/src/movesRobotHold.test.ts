import { parseAuto, parseRobot, SCHEMA_ID, type Auto, type Robot } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { checkMovesRobot } from "./checks/schedule.js";
import { plan } from "./plan.js";
import { resolve } from "./resolve.js";
import { testField, testRobot, testWaypoints } from "./testing/fixtures.js";

/**
 * A step that holds the robot still (a wait, a command that does not drive, a transfer) does not
 * say where a command that drives it left it. The MOVES_ROBOT check and `resolve`'s rejoin both
 * look through such steps to the command before them (issue #375).
 */

const robot: Robot = parseRobot({
  ...(JSON.parse(JSON.stringify(testRobot)) as Record<string, unknown>),
  commands: [
    { name: "setIntake", estimateS: "0" },
    { name: "collectNearestPollen", estimateS: "unknown", movesRobot: true },
  ],
});

const auto = (steps: unknown[]): Auto =>
  parseAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 4,
    name: "moves-robot-hold",
    alliance: "RED",
    start: { pose: { xIn: -40, yIn: -60, headingRad: 0 } },
    steps,
  });

const hunt = { id: "hunt", kind: "command", name: "collectNearestPollen" };
const pause = { id: "pause", kind: "wait", seconds: 1 };
const intakeOn = { id: "intake", kind: "command", name: "setIntake" };
const fixed = {
  id: "fixed",
  kind: "path",
  segments: [{ kind: "line", from: { xIn: -40, yIn: -60 }, to: { xIn: -20, yIn: -60 } }],
  heading: { mode: "tangent" },
};
const fromCurrent = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  kind: "path",
  ...extra,
  segments: [{ kind: "line", from: "current", to: { xIn: -36, yIn: 12, headingRad: 1.5708 } }],
  heading: { mode: "tangent" },
});

const movesRobot = (steps: unknown[]) =>
  checkMovesRobot(plan(resolve(auto(steps), testWaypoints, robot), robot, testField).steps, robot);

describe("MOVES_ROBOT through a step that holds the robot still", () => {
  it("still errors on a path from a fixed pose after a wait", () => {
    const findings = movesRobot([hunt, pause, fixed]);
    expect(findings.map((finding) => finding.stepId)).toEqual(["fixed"]);
    expect(findings[0]?.message).toContain("collectNearestPollen");
  });

  it("still errors after a command that does not drive, and after a transfer", () => {
    const transfer = { id: "partner", kind: "transfer", from: "partner", to: "robot", expectedCount: 1 };
    expect(movesRobot([hunt, intakeOn, transfer, fixed]).map((finding) => finding.stepId)).toEqual(["fixed"]);
  });

  it("is satisfied once a path from current has re-anchored the pose", () => {
    expect(movesRobot([hunt, pause, fromCurrent("back"), fixed])).toEqual([]);
  });
});

describe("rejoinFrom through a step that holds the robot still", () => {
  const rejoinFrom = { xIn: -30, yIn: -30, headingRad: 1.5708, provenance: "SET BY HAND: test" };

  it("rejoins after a wait, and the wait and the command both end at the rejoin pose", () => {
    const resolved = resolve(auto([hunt, pause, fromCurrent("back", { rejoinFrom })]), testWaypoints, robot);
    expect(resolved.findings).toEqual([]);
    const [command, wait, back] = resolved.steps;
    expect(back?.startPose).toEqual({ xIn: -30, yIn: -30, headingRad: 1.5708 });
    expect(wait?.startPose).toEqual({ xIn: -30, yIn: -30, headingRad: 1.5708 });
    expect(wait?.endPose).toEqual({ xIn: -30, yIn: -30, headingRad: 1.5708 });
    expect(command?.endPose).toEqual({ xIn: -30, yIn: -30, headingRad: 1.5708 });
  });

  it("rejoins after a sequence that ends in a wait after the command", () => {
    const group = { id: "group", kind: "sequence", steps: [hunt, pause] };
    const resolved = resolve(auto([group, fromCurrent("back", { rejoinFrom })]), testWaypoints, robot);
    expect(resolved.findings).toEqual([]);
    expect(resolved.steps[1]?.startPose).toEqual({ xIn: -30, yIn: -30, headingRad: 1.5708 });
    expect(resolved.steps[0]?.endPose).toEqual({ xIn: -30, yIn: -30, headingRad: 1.5708 });
  });

  it("still reports an unused rejoinFrom when a path came between", () => {
    const resolved = resolve(
      auto([hunt, fromCurrent("first"), pause, fromCurrent("back", { rejoinFrom })]),
      testWaypoints,
      robot,
    );
    expect(resolved.findings.map((finding) => [finding.code, finding.stepId])).toEqual([["MOVES_ROBOT", "back"]]);
  });
});
