import { parseAuto, SCHEMA_ID, type Auto, type Heading } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
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
import { idealPoseAt, idealTimeAt, idealTrajectory, type IdealTrajectory } from "./ideal.js";

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

  it("times the run with the estimate, plus only the transitions", () => {
    const { trajectory, totalEstimateS } = build(
      autoOf([curve("sweep", { mode: "tangent" }), { id: "pause", kind: "wait", seconds: 0.5 }], {
        xIn: -50,
        yIn: 0,
        headingRad: 0,
      }),
    );
    // The tangent at the start of the curve is not heading 0, so a turn opens the run.
    const turn = trajectory.transitions[0]?.endS ?? 0;
    expect(trajectory.totalS).toBeCloseTo(totalEstimateS + turn, 9);
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
    expect(idealPoseAt(trajectory, idealTimeAt(trajectory, "sweep", 0.75) as number).headingRad).toBeCloseTo(1.15, 6);
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
    const { trajectory } = build(
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
