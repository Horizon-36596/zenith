import { parseAuto, SCHEMA_ID, type Auto, type Heading } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { checkTimeouts } from "../checks/schedule.js";
import { estimate } from "../estimate.js";
import { angleDelta } from "../geometry/angle.js";
import type { PathGeometry } from "../geometry/path.js";
import type { Pose } from "../geometry/vec.js";
import { headingAtT, headingFunction } from "../heading.js";
import { robotLimits } from "../kinematics.js";
import { plan } from "../plan.js";
import { resolve } from "../resolve.js";
import { testField, testRobot, testWaypoints } from "../testing/fixtures.js";
import type { Plan, PlanStep } from "../types.js";
import { makeSimCurve } from "./curves.js";
import { idealPoseAt, idealTimeAt, idealTrajectory, type IdealTrajectory } from "./ideal.js";
import { parameterAtFraction } from "./pedroPath.js";

/**
 * The ideal playback level (site/docs/simulation.md): the robot is on the planned geometry exactly,
 * its heading is the heading mode exactly, the clock is the estimate's, and a gap between one step's
 * end and the next one's start is closed by a visible, timed transition.
 */

const autoOf = (steps: unknown[], start: Pose = { xIn: -50, yIn: 0, headingRad: 0 }): Auto =>
  parseAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 2,
    name: "ideal-fixture",
    alliance: "RED",
    start: { pose: start },
    steps,
  });

const planOf = (auto: Auto): Plan => plan(resolve(auto, testWaypoints), testRobot, testField);

const build = (auto: Auto): { planned: Plan; trajectory: IdealTrajectory; totalEstimateS: number } => {
  const planned = planOf(auto);
  const estimated = estimate(planned, testRobot);
  return { planned, trajectory: idealTrajectory(planned, estimated), totalEstimateS: estimated.nominalS ?? 0 };
};

const curve = (id: string, heading: Heading): unknown => ({
  id,
  kind: "path",
  segments: [
    {
      kind: "bezier",
      from: "current",
      control: [
        { xIn: -30, yIn: 30 },
        { xIn: 0, yIn: -30 },
      ],
      to: { xIn: 20, yIn: 10 },
    },
  ],
  heading,
});

const stepOf = (planned: Plan, id: string): PlanStep => {
  const found = planned.steps.find((step) => step.id === id);
  if (found === undefined) throw new Error(`no step ${id}`);
  return found;
};

/** The arc length on the geometry nearest a point: a dense scan, then a golden-section refinement. */
function nearestS(geometry: PathGeometry, point: Pose): { sIn: number; distanceIn: number } {
  const distanceAt = (sIn: number): number => {
    const on = geometry.pointAtDistance(sIn);
    return Math.hypot(on.xIn - point.xIn, on.yIn - point.yIn);
  };
  const stepIn = 0.05;
  let best = 0;
  for (let s = 0; s <= geometry.lengthIn; s += stepIn) if (distanceAt(s) < distanceAt(best)) best = s;
  let lo = Math.max(0, best - stepIn);
  let hi = Math.min(geometry.lengthIn, best + stepIn);
  const ratio = (Math.sqrt(5) - 1) / 2;
  for (let i = 0; i < 80; i += 1) {
    const a = hi - ratio * (hi - lo);
    const b = lo + ratio * (hi - lo);
    if (distanceAt(a) < distanceAt(b)) hi = b;
    else lo = a;
  }
  const sIn = (lo + hi) / 2;
  return { sIn, distanceIn: distanceAt(sIn) };
}

/** Times strictly inside a path step's motion, including ones between plan samples. */
function motionTimes(trajectory: IdealTrajectory, stepId: string, count = 37): number[] {
  const motion = trajectory.segments.find((segment) => segment.kind === "path" && segment.stepId === stepId);
  if (motion === undefined) throw new Error(`no motion for ${stepId}`);
  const out: number[] = [];
  for (let i = 1; i < count; i += 1) out.push(motion.startS + ((motion.endS - motion.startS) * i) / count);
  return out;
}

describe("the ideal trajectory on a path", () => {
  it("puts the robot on the planned geometry exactly, between samples too", () => {
    const { planned, trajectory } = build(autoOf([curve("sweep", { mode: "tangent" })]));
    const step = stepOf(planned, "sweep");
    const geometry = step.geometry as PathGeometry;
    for (const atS of motionTimes(trajectory, "sweep")) {
      const pose = idealPoseAt(trajectory, atS);
      const { distanceIn } = nearestS(geometry, pose);
      expect(distanceIn, `off the path by ${distanceIn.toExponential(2)} in at ${atS.toFixed(3)} s`).toBeLessThan(1e-6);
    }
  });

  it("is at each plan sample's pose at that sample's estimated time", () => {
    const { planned, trajectory } = build(autoOf([curve("sweep", { mode: "tangent" })]));
    const step = stepOf(planned, "sweep");
    const estimated = estimate(planned, testRobot);
    const times = estimated.byStepId["sweep"]?.timeAtSampleS ?? [];
    expect(times.length).toBe(step.samples.length);
    // The curve's first tangent is not the start heading, so a turn in place comes first.
    const offsetS = trajectory.transitions[0]?.endS ?? 0;
    expect(offsetS).toBeGreaterThan(0);
    for (const [index, sample] of step.samples.entries()) {
      const pose = idealPoseAt(trajectory, offsetS + (times[index] as number));
      expect(pose.xIn).toBeCloseTo(sample.pose.xIn, 9);
      expect(pose.yIn).toBeCloseTo(sample.pose.yIn, 9);
      expect(Math.abs(angleDelta(pose.headingRad, sample.pose.headingRad))).toBeLessThan(1e-9);
    }
  });

  it("times the run with the estimate, the turn before the first path included", () => {
    const auto = autoOf([curve("sweep", { mode: "tangent" }), { id: "pause", kind: "wait", seconds: 0.5 }], {
      xIn: -50,
      yIn: 0,
      headingRad: 0,
    });
    const { trajectory, totalEstimateS } = build(auto);
    // The tangent at the start of the curve is not heading 0, so a turn opens the run. The estimate
    // counts it as the path's joint turn, so the ideal run plays it inside the step's own time.
    const turn = trajectory.transitions[0];
    if (turn === undefined) throw new Error("no turn");
    expect(turn.translateIn).toBe(0);
    const turnS = estimate(planOf(auto), testRobot).byStepId["sweep"]?.turnS ?? 0;
    expect(turn.endS - turn.startS).toBeCloseTo(turnS, 12);
    expect(trajectory.totalS).toBeCloseTo(totalEstimateS, 9);
    expect(trajectory.spans.find((span) => span.stepId === "sweep")?.transitionS).toBe(0);
  });

  const modes: Array<[string, Heading]> = [
    ["tangent", { mode: "tangent" }],
    ["tangentReversed", { mode: "tangentReversed" }],
    ["constant", { mode: "constant", headingRad: 1.2 }],
    ["linear", { mode: "linear", fromRad: 0, toRad: 2.5 }],
    ["facePoint", { mode: "facePoint", xIn: 40, yIn: 50 }],
    [
      "piecewise",
      {
        mode: "piecewise",
        ranges: [
          { startT: 0, endT: 0.3, heading: { mode: "tangent" } },
          { startT: 0.3, endT: 0.6, heading: { mode: "constant", headingRad: 1.2 } },
          { startT: 0.6, endT: 0.85, heading: { mode: "linear", fromRad: 1.2, toRad: 2.5 } },
          { startT: 0.85, endT: 1, heading: { mode: "facePoint", xIn: 40, yIn: 50 } },
        ],
      },
    ],
  ];
  for (const [name, heading] of modes) {
    it(`follows the ${name} heading interpolation exactly`, () => {
      const { planned, trajectory } = build(autoOf([curve("sweep", heading)]));
      const step = stepOf(planned, "sweep");
      const geometry = step.geometry as PathGeometry;
      const headingAt = headingFunction(heading, geometry);
      for (const atS of motionTimes(trajectory, "sweep")) {
        const pose = idealPoseAt(trajectory, atS);
        const { sIn } = nearestS(geometry, pose);
        const expected = headingAt(geometry.tAtDistance(sIn));
        const error = Math.abs(angleDelta(pose.headingRad, expected));
        expect(error, `${name} heading off by ${error.toExponential(2)} rad at ${atS.toFixed(3)} s`).toBeLessThan(1e-5);
      }
    });
  }

  it("takes a piecewise heading from headingAtT, the one heading-at-t every playback level shares", () => {
    const heading: Heading = {
      mode: "piecewise",
      ranges: [
        { startT: 0, endT: 0.5, heading: { mode: "constant", headingRad: 0.4 } },
        { startT: 0.5, endT: 1, heading: { mode: "linear", fromRad: 0.4, toRad: 1.9 } },
      ],
    };
    const { planned, trajectory } = build(autoOf([curve("sweep", heading)]));
    const geometry = stepOf(planned, "sweep").geometry as PathGeometry;
    for (const t of [0.1, 0.49, 0.5, 0.75, 0.99]) {
      const atS = idealTimeAt(trajectory, "sweep", t) as number;
      const pose = idealPoseAt(trajectory, atS);
      expect(Math.abs(angleDelta(pose.headingRad, headingAtT(heading, geometry, t)))).toBeLessThan(1e-6);
    }
    expect(idealPoseAt(trajectory, idealTimeAt(trajectory, "sweep", 0.25) as number).headingRad).toBeCloseTo(0.4, 6);
    // On this cubic the linear range turns linearly in the curve's own t, as the runtime turns it
    // (OPT-01), so three quarters of the way along is not the arc-length midpoint of the turn, 1.15.
    const { u } = geometry.segmentAt(0.75 * geometry.lengthIn);
    const runtimeCurve = makeSimCurve((geometry.curves[0]?.points ?? []).map((point) => ({ x: point.xIn, y: point.yIn })));
    const rangeStartU = parameterAtFraction(runtimeCurve, 0.5);
    const runtimeRad = 0.4 + 1.5 * ((u - rangeStartU) / (1 - rangeStartU));
    expect(runtimeRad).not.toBeCloseTo(1.15, 2);
    expect(idealPoseAt(trajectory, idealTimeAt(trajectory, "sweep", 0.75) as number).headingRad).toBeCloseTo(runtimeRad, 6);
  });

  it("gives the time at a point on a path, which puts the robot back at that point", () => {
    const { planned, trajectory } = build(autoOf([curve("sweep", { mode: "tangent" })]));
    const step = stepOf(planned, "sweep");
    const geometry = step.geometry as PathGeometry;
    for (const t of [0.1, 0.37, 0.5, 0.81]) {
      const atS = idealTimeAt(trajectory, "sweep", t) as number;
      const pose = idealPoseAt(trajectory, atS);
      const point = geometry.pointAt(t);
      expect(pose.xIn).toBeCloseTo(point.xIn, 9);
      expect(pose.yIn).toBeCloseTo(point.yIn, 9);
    }
    expect(idealTimeAt(trajectory, "nothing", 0.5)).toBeNull();
  });
});

describe("transitions where the poses do not match", () => {
  const legTo = (id: string, from: unknown, to: { xIn: number; yIn: number }, heading: Heading): unknown => ({
    id,
    kind: "path",
    segments: [{ kind: "line", from, to }],
    heading,
  });

  it("drives and turns in a straight line to a path that starts somewhere else", () => {
    const { trajectory, totalEstimateS } = build(
      autoOf([
        legTo("first", "current", { xIn: -20, yIn: 0 }, { mode: "constant", headingRad: 0 }),
        legTo("second", { xIn: -10, yIn: 20 }, { xIn: 10, yIn: 20 }, { mode: "constant", headingRad: 0.8 }),
      ]),
    );
    expect(trajectory.transitions.length).toBe(1);
    const transition = trajectory.transitions[0];
    if (transition === undefined) throw new Error("no transition");
    expect(transition.stepId).toBe("second");
    expect(transition.translateIn).toBeCloseTo(Math.hypot(10, 20), 9);
    expect(transition.turnRad).toBeCloseTo(0.8, 9);
    expect(transition.endS).toBeGreaterThan(transition.startS);
    // The gap costs time: the ideal run is the estimate plus the transition.
    expect(trajectory.totalS).toBeCloseTo(totalEstimateS + (transition.endS - transition.startS), 9);

    // It starts where the first path ended and ends where the second begins.
    const start = idealPoseAt(trajectory, transition.startS);
    expect(start.xIn).toBeCloseTo(-20, 9);
    expect(start.yIn).toBeCloseTo(0, 9);
    const end = idealPoseAt(trajectory, transition.endS);
    expect(end.xIn).toBeCloseTo(-10, 9);
    expect(end.yIn).toBeCloseTo(20, 9);
    expect(end.headingRad).toBeCloseTo(0.8, 9);

    // In between it is on the straight line, and the heading has turned by the share driven.
    for (const f of [0.2, 0.5, 0.8]) {
      const atS = transition.startS + (transition.endS - transition.startS) * f;
      const pose = idealPoseAt(trajectory, atS);
      const along = ((pose.xIn + 20) * 10 + pose.yIn * 20) / (10 * 10 + 20 * 20);
      expect(pose.xIn).toBeCloseTo(-20 + 10 * along, 9);
      expect(pose.yIn).toBeCloseTo(20 * along, 9);
      expect(pose.headingRad).toBeCloseTo(0.8 * along, 9);
    }
    const span = trajectory.spans.find((row) => row.stepId === "second");
    expect(span?.transitionS).toBeCloseTo(transition.endS - transition.startS, 9);
  });

  it("turns in place when only the heading differs, at the angular velocity limit", () => {
    const { trajectory, totalEstimateS } = build(
      autoOf([
        legTo("east", "current", { xIn: -20, yIn: 0 }, { mode: "constant", headingRad: 0 }),
        legTo("north", "current", { xIn: -20, yIn: 30 }, { mode: "tangent" }),
      ]),
    );
    expect(trajectory.transitions.length).toBe(1);
    const turn = trajectory.transitions[0];
    if (turn === undefined) throw new Error("no turn");
    expect(turn.translateIn).toBe(0);
    expect(turn.turnRad).toBeCloseTo(Math.PI / 2, 9);
    expect(turn.endS - turn.startS).toBeCloseTo(Math.PI / 2 / robotLimits(testRobot).maxAngularVelRadPerS, 9);
    const mid = idealPoseAt(trajectory, (turn.startS + turn.endS) / 2);
    expect(mid.xIn).toBeCloseTo(-20, 9);
    expect(mid.yIn).toBeCloseTo(0, 9);
    expect(mid.headingRad).toBeCloseTo(Math.PI / 4, 9);
    // The turn is the estimate's own joint turn (issue #153): it is played out of the step's time,
    // not added on top, so the ideal run takes exactly as long as the estimate.
    expect(trajectory.totalS).toBeCloseTo(totalEstimateS, 9);
    const north = trajectory.spans.find((span) => span.stepId === "north");
    expect(north?.transitionS).toBe(0);
    expect(north?.startS).toBeCloseTo(turn.startS, 12);
    // The path's motion starts when the turn ends, and its settle hold ends the step.
    const motion = trajectory.segments.find((segment) => segment.kind === "path" && segment.stepId === "north");
    expect(motion?.startS).toBeCloseTo(turn.endS, 12);
    expect(north?.endS).toBeCloseTo(trajectory.totalS, 9);
  });

  it("adds only the drive beyond the estimate when a path starts somewhere else and facing another way", () => {
    const { trajectory, totalEstimateS } = build(
      autoOf([
        legTo("east", "current", { xIn: -20, yIn: 0 }, { mode: "constant", headingRad: 0 }),
        legTo("away", { xIn: -10, yIn: 10 }, { xIn: -10, yIn: 40 }, { mode: "tangent" }),
      ]),
    );
    const transition = trajectory.transitions[0];
    if (transition === undefined) throw new Error("no transition");
    expect(transition.translateIn).toBeGreaterThan(0);
    const gapS = transition.endS - transition.startS;
    expect(trajectory.spans.find((span) => span.stepId === "away")?.transitionS).toBeCloseTo(gapS, 9);
    expect(trajectory.totalS).toBeCloseTo(totalEstimateS + gapS, 9);
  });

  it("adds not even a rounding error of transition at the joints of a zigzag", () => {
    // Every leg starts facing another way from how the last one ended, so each opens with a turn in
    // place that the estimate counts; none of them may leave a sliver of transition on the timeline.
    const legs = Array.from({ length: 21 }, (_, i) =>
      legTo(`leg${String(i + 1)}`, "current", { xIn: -48 + 3 * (i + 1), yIn: i % 2 === 0 ? 10 : -12 }, { mode: "tangent" }),
    );
    const { trajectory, totalEstimateS } = build(autoOf(legs));
    expect(trajectory.transitions.length).toBeGreaterThan(10);
    expect(trajectory.spans.filter((span) => span.transitionS !== 0).map((span) => span.stepId)).toEqual([]);
    expect(trajectory.totalS).toBeCloseTo(totalEstimateS, 9);
  });

  it("adds nothing when the next path starts where the last one ended", () => {
    const { trajectory, totalEstimateS } = build(
      autoOf([
        legTo("east", "current", { xIn: -20, yIn: 0 }, { mode: "constant", headingRad: 0 }),
        legTo("further", "current", { xIn: 0, yIn: 0 }, { mode: "constant", headingRad: 0 }),
      ]),
    );
    expect(trajectory.transitions).toEqual([]);
    expect(trajectory.totalS).toBeCloseTo(totalEstimateS, 9);
  });
});

describe("steps that do not drive", () => {
  it("hold the pose for the step's estimated seconds", () => {
    const { trajectory } = build(
      autoOf([
        {
          id: "east",
          kind: "path",
          segments: [{ kind: "line", from: "current", to: { xIn: -20, yIn: 0 } }],
          heading: { mode: "constant", headingRad: 0 },
        },
        { id: "pause", kind: "wait", seconds: 1.25 },
        { id: "intake", kind: "command", name: "setIntake" },
      ]),
    );
    const pause = trajectory.spans.find((span) => span.stepId === "pause");
    if (pause === undefined) throw new Error("no pause span");
    expect(pause.endS - pause.startS).toBeCloseTo(1.25, 9);
    for (const f of [0, 0.3, 0.99]) {
      const pose = idealPoseAt(trajectory, pause.startS + (pause.endS - pause.startS) * f);
      expect(pose).toEqual({ xIn: -20, yIn: 0, headingRad: 0 });
    }
    expect(idealPoseAt(trajectory, trajectory.totalS + 5)).toEqual({ xIn: -20, yIn: 0, headingRad: 0 });
    expect(idealPoseAt(trajectory, -1)).toEqual({ xIn: -50, yIn: 0, headingRad: 0 });
  });

  it("drives the path member of a parallel group for as long as the group lasts", () => {
    const { planned, trajectory } = build(
      autoOf([
        {
          id: "together",
          kind: "parallel",
          mode: "all",
          steps: [
            { id: "spin", kind: "wait", seconds: 0.1 },
            {
              id: "drive",
              kind: "path",
              segments: [{ kind: "line", from: "current", to: { xIn: -20, yIn: 0 } }],
              heading: { mode: "constant", headingRad: 0 },
            },
          ],
        },
      ]),
    );
    const group = trajectory.spans.find((span) => span.stepId === "together");
    const drive = trajectory.spans.find((span) => span.stepId === "drive");
    expect(group?.startS).toBe(0);
    expect(drive?.startS).toBe(0);
    expect(group?.endS).toBeCloseTo(drive?.endS ?? Number.NaN, 9);
    expect(trajectory.totalS).toBeCloseTo(group?.endS ?? Number.NaN, 9);
    const geometry = (planned.steps[0]?.children?.[1] as PlanStep).geometry as PathGeometry;
    const mid = idealPoseAt(trajectory, (drive?.endS ?? 0) / 3);
    expect(nearestS(geometry, mid).distanceIn).toBeLessThan(1e-6);
    expect(mid.xIn).toBeGreaterThan(-50);
  });
});

describe("a timeout that cuts a path short", () => {
  // A straight drive east from the start, facing the way it drives, so it opens with no turn.
  const east = (timeoutS?: number): unknown => ({
    id: "east",
    kind: "path",
    segments: [{ kind: "line", from: "current", to: { xIn: 20, yIn: 0 } }],
    heading: { mode: "constant", headingRad: 0 },
    ...(timeoutS === undefined ? {} : { timeoutS }),
  });
  const uncappedS = (): number => estimate(planOf(autoOf([east()])), testRobot).byStepId["east"]?.nominalS ?? 0;

  it("stops the robot where the timeout runs out, so the ideal total is the estimate's", () => {
    const timeoutS = uncappedS() / 2;
    const auto = autoOf([east(timeoutS), { id: "pause", kind: "wait", seconds: 0.5 }]);
    const planned = planOf(auto);
    const estimated = estimate(planned, testRobot);
    expect(estimated.byStepId["east"]?.uncappedS).toBeCloseTo(timeoutS * 2, 9);
    const trajectory = idealTrajectory(planned, estimated);

    expect(trajectory.totalS).toBeCloseTo(estimated.nominalS ?? Number.NaN, 9);
    const span = trajectory.spans.find((row) => row.stepId === "east");
    expect((span?.endS ?? 0) - (span?.startS ?? 0)).toBeCloseTo(timeoutS, 9);
    expect(span?.transitionS).toBe(0);

    // It is on the path, part of the way along, and it stays there through the wait that follows.
    const stop = idealPoseAt(trajectory, timeoutS);
    const geometry = stepOf(planned, "east").geometry as PathGeometry;
    expect(nearestS(geometry, stop).distanceIn).toBeLessThan(1e-6);
    expect(stop.xIn).toBeGreaterThan(-50);
    expect(stop.xIn).toBeLessThan(20);
    for (const atS of [timeoutS + 0.01, timeoutS + 0.25, trajectory.totalS + 1]) {
      expect(idealPoseAt(trajectory, atS)).toEqual(stop);
    }

    // The end of the path is never reached, and the place TIMEOUT_TIGHT names is where it stops.
    expect(idealTimeAt(trajectory, "east", 1)).toBeNull();
    const finding = checkTimeouts(planned.steps, estimated).find((row) => row.stepId === "east");
    expect(finding?.severity).toBe("warning");
    expect(idealTimeAt(trajectory, "east", finding?.t ?? Number.NaN)).toBeCloseTo(timeoutS, 6);
  });

  it("closes the gap it leaves with a transition into the next path, which the timeline shows", () => {
    const timeoutS = uncappedS() / 2;
    const { planned, trajectory, totalEstimateS } = build(
      autoOf([
        east(timeoutS),
        {
          id: "north",
          kind: "path",
          segments: [{ kind: "line", from: "current", to: { xIn: 20, yIn: 30 } }],
          heading: { mode: "constant", headingRad: 0 },
        },
      ]),
    );
    expect(trajectory.transitions.map((transition) => transition.stepId)).toEqual(["north"]);
    const transition = trajectory.transitions[0];
    if (transition === undefined) throw new Error("no transition");
    expect(transition.startS).toBeCloseTo(timeoutS, 9);
    expect(transition.fromPose.xIn).toBeLessThan(20);
    expect(transition.toPose).toEqual(stepOf(planned, "north").startPose);
    const gapS = transition.endS - transition.startS;
    expect(gapS).toBeGreaterThan(0);
    expect(trajectory.spans.find((span) => span.stepId === "north")?.transitionS).toBeCloseTo(gapS, 9);
    expect(trajectory.totalS).toBeCloseTo(totalEstimateS + gapS, 9);
  });

  it("stops a joint turn part of the way round when the timeout is shorter than the turn", () => {
    const north = (timeoutS?: number): unknown => ({
      id: "north",
      kind: "path",
      segments: [{ kind: "line", from: "current", to: { xIn: -50, yIn: 30 } }],
      heading: { mode: "tangent" },
      ...(timeoutS === undefined ? {} : { timeoutS }),
    });
    const turnS = estimate(planOf(autoOf([north()])), testRobot).byStepId["north"]?.turnS ?? 0;
    expect(turnS).toBeGreaterThan(0);
    const { trajectory, totalEstimateS } = build(autoOf([north(turnS / 2)]));
    expect(trajectory.totalS).toBeCloseTo(totalEstimateS, 9);
    expect(trajectory.totalS).toBeCloseTo(turnS / 2, 9);
    expect(trajectory.segments.some((segment) => segment.kind === "path")).toBe(false);
    const stop = idealPoseAt(trajectory, trajectory.totalS + 1);
    expect(stop.xIn).toBeCloseTo(-50, 9);
    expect(stop.yIn).toBeCloseTo(0, 9);
    expect(stop.headingRad).toBeCloseTo(Math.PI / 4, 9);
  });

  it("turns on the spot from the heading a cut-short turn left, not the planned one", () => {
    const turn = (id: string, headingRad: number, timeoutS?: number): unknown => ({
      id,
      kind: "path",
      segments: [{ kind: "line", from: "current", to: { xIn: -50, yIn: 0 } }],
      heading: { mode: "constant", headingRad },
      ...(timeoutS === undefined ? {} : { timeoutS }),
    });
    // A half turn goes the negative way round (`holdTurnRad`); the timeout stops it at -0.9 rad.
    const halfS = estimate(planOf(autoOf([turn("half", Math.PI)])), testRobot).byStepId["half"]?.nominalS ?? 0;
    expect(halfS).toBeGreaterThan(0);
    const { trajectory } = build(autoOf([turn("half", Math.PI, (halfS * 0.9) / Math.PI), turn("back", 0)]));
    const cutS = (halfS * 0.9) / Math.PI;
    expect(idealPoseAt(trajectory, cutS).headingRad).toBeCloseTo(-0.9, 6);
    // The second turn goes straight from -0.9 to 0, never back round through the planned pi first.
    for (let atS = cutS; atS <= trajectory.totalS + 0.2; atS += 0.01) {
      const headingRad = idealPoseAt(trajectory, atS).headingRad;
      expect(headingRad).toBeGreaterThanOrEqual(-0.9 - 1e-6);
      expect(headingRad).toBeLessThanOrEqual(1e-6);
    }
    expect(idealPoseAt(trajectory, trajectory.totalS + 1).headingRad).toBeCloseTo(0, 9);
  });
});

describe("determinism", () => {
  it("gives the same trajectory and the same poses for the same plan", () => {
    const auto = autoOf([
      curve("sweep", { mode: "linear", fromRad: 0, toRad: 2 }),
      { id: "pause", kind: "wait", seconds: 0.5 },
      {
        id: "back",
        kind: "path",
        segments: [{ kind: "line", from: { xIn: 0, yIn: 0 }, to: { xIn: -40, yIn: -20 } }],
        heading: { mode: "tangent" },
      },
    ]);
    const a = build(auto).trajectory;
    const b = build(auto).trajectory;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    for (let atS = 0; atS <= a.totalS + 0.5; atS += 0.037) {
      expect(idealPoseAt(a, atS)).toEqual(idealPoseAt(b, atS));
    }
    expect(a.transitions.length).toBeGreaterThan(0);
  });
});
