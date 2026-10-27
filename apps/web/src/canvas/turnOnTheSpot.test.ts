/**
 * A turn on the spot on the field (issue #187, sweep finding N33): a path step with no length used to
 * have one plan sample, so the scene left it out and the field drew nothing at its point, with no
 * arrow to drag. Now the plan samples it by angle, the scene carries it, and it has one end arrow.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { estimate, loadAuto, loadField, loadRobot, loadWaypoints, plan, resolve, wrapAngle } from "@horizon36596/zenith-core";
import { describe, expect, it } from "vitest";
import { headingForMode } from "../lib/headingModes";
import { headingHandlesFor } from "./headingHandles";
import { buildScene, poseAtT } from "./scene";

const examples = fileURLToPath(new URL("../../../../examples/starter/autos/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${examples}${relative}`, "utf8"));
const robot = loadRobot(read("robot.json"));
const field = loadField(read("field/biobuzz.field.json"));
const waypoints = loadWaypoints(read("waypoints.json"));

/** first-auto's driveOut, then a turn on the spot where it ends, as Insert > Turn on the spot writes it. */
function turnAfterDriveOut(heading: unknown) {
  const first = read("first-auto.auto.json") as { steps: unknown[] };
  const auto = loadAuto({
    ...first,
    steps: [
      first.steps[0],
      { id: "turn", kind: "path", segments: [{ kind: "line", from: "current", to: { ref: "scoreSouth" } }], heading },
    ],
  });
  const planned = plan(resolve(auto, waypoints), robot, field);
  return { planned, scene: buildScene({ plan: planned, findings: [], estimate: estimate(planned, robot) }) };
}

const arrivalOf = (): number => {
  const { planned } = turnAfterDriveOut({ mode: "tangent" });
  return planned.steps[0]?.endPose?.headingRad ?? NaN;
};

describe("a turn on the spot on the field", () => {
  it("is in the scene at its one point, turning from the arrival heading to its To", () => {
    const arrival = arrivalOf();
    const toRad = wrapAngle(arrival + Math.PI / 2);
    const { scene } = turnAfterDriveOut({ mode: "linear", fromRad: arrival, toRad });
    const step = scene.steps.find((candidate) => candidate.stepId === "turn");
    expect(step).toBeDefined();
    if (step === undefined) return;
    const end = waypoints.waypoints["scoreSouth"];
    expect(poseAtT(step, 1).xIn).toBeCloseTo(end?.xIn ?? NaN, 6);
    expect(poseAtT(step, 1).headingRad).toBeCloseTo(toRad, 6);
    expect(poseAtT(step, 0).headingRad).toBeCloseTo(arrival, 6);
    expect(poseAtT(step, 0.5).headingRad).toBeCloseTo(wrapAngle(arrival + Math.PI / 4), 6);
    // The playback clock spreads the turn over the step's own seconds.
    const times = step.timesS ?? [];
    expect((times[times.length - 1] ?? 0) - (times[0] ?? 0)).toBeGreaterThan(0.05);
  });

  it("has one end arrow, which can be turned, pointing at its To", () => {
    const arrival = arrivalOf();
    const toRad = wrapAngle(arrival + Math.PI / 2);
    const { scene } = turnAfterDriveOut({ mode: "linear", fromRad: arrival, toRad });
    const step = scene.steps.find((candidate) => candidate.stepId === "turn");
    const handles = step === undefined ? [] : headingHandlesFor(step, step.heading);
    expect(handles.map((handle) => [handle.key, handle.editable])).toEqual([["all:end", true]]);
    expect(handles[0]?.poseIn.headingRad).toBeCloseTo(toRad, 9);
  });

  it("shows a tangent turn's read-only end arrow at the heading the plan ends at", () => {
    const { scene, planned } = turnAfterDriveOut({ mode: "tangent" });
    const step = scene.steps.find((candidate) => candidate.stepId === "turn");
    const handles = step === undefined ? [] : headingHandlesFor(step, step.heading);
    expect(handles.map((handle) => handle.key)).toEqual(["all:end"]);
    expect(handles[0]?.poseIn.headingRad).toBeCloseTo(planned.steps[1]?.endPose?.headingRad ?? NaN, 9);
  });

  it("switches Tangent to Linear from the heading the robot arrives with (headingForMode)", () => {
    const arrival = arrivalOf();
    const { planned } = turnAfterDriveOut({ mode: "tangent" });
    const turn = planned.steps[1];
    const heading = headingForMode(
      "linear",
      { mode: "tangent" },
      turn?.endPose === null || turn === undefined ? null : { startRad: turn.startPose.headingRad, endRad: turn.endPose.headingRad },
    );
    expect(heading.mode).toBe("linear");
    if (heading.mode !== "linear") return;
    expect(heading.fromRad).toBeCloseTo(arrival, 9);
    expect(wrapAngle(heading.toRad)).toBeCloseTo(wrapAngle(turn?.endPose?.headingRad ?? NaN), 9);
  });
});
