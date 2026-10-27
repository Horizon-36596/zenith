import { readFileSync } from "node:fs";
import { parseAuto, type Auto, type Field, type Robot, type Waypoints } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { estimate } from "./estimate.js";
import { createLiveRun, type LiveBelief } from "./live/liveRun.js";
import { loadField, loadRobot, loadWaypoints } from "./load.js";
import { plan } from "./plan.js";
import { resolve } from "./resolve.js";
import { idealTrajectory } from "./sim/ideal.js";
import { plantParams } from "./sim/params.js";
import { MecanumPlant } from "./sim/plant.js";
import { simulate } from "./sim/simulate.js";
import type { SimTrace } from "./sim/types.js";
import type { Plan } from "./types.js";

/**
 * The joint between two path steps, the second chained from `"current"`: the report was "there is
 * a pause between paths".
 *
 * What the robot does there (ADR 0003, `robot/auto-runtime/.../FollowPath.java`): each path step is
 * its own `follower.follow(path)`, and `FollowPath` finishes on `!follower.following()`, which goes
 * false once the follower passes t = 0.975 of the path's last segment, still moving. The next step's
 * `follow` starts in the same scheduler pass. It never waits for Pedro's end constraints. Pedro does
 * brake into the end of every path it is given, so the robot slows into the joint; a path step with
 * several segments is one `Paths.path(...)` and hands over between segments without braking.
 *
 * So the previews must not sit at the joint (the estimate used to add `settleS` there and the ideal
 * playback held the pose for it), and the instant sim and the live run must slow into it without
 * stopping. Measured on the starter robot, 40 in then 40 in in a straight line: the separate steps
 * dip from about 41 in/s to about 14 in/s at the joint with no dwell; the same line as one step with
 * two segments stays above 45 in/s.
 */

const examples = new URL("../../../examples/starter/autos/", import.meta.url);
const read = (relative: string): unknown => JSON.parse(readFileSync(new URL(relative, examples), "utf8"));
const robot: Robot = loadRobot(read("robot.json"));
const field: Field = loadField(read("field/biobuzz.field.json"));
const waypoints: Waypoints = loadWaypoints(read("waypoints.json"));

const START = { xIn: -60, yIn: -36, headingRad: 0 };
const JOINT = { xIn: -20, yIn: -36, headingRad: 0 };
const END = { xIn: 20, yIn: -36, headingRad: 0 };
const TICK_S = 0.01;

const autoOf = (steps: Record<string, unknown>[]): Auto =>
  parseAuto({
    formatVersion: 3,
    name: "path-joint",
    alliance: "RED",
    start: { pose: START, holds: { pollen: 0 } },
    steps,
  });

const legA = { id: "a", kind: "path", segments: [{ kind: "line", from: START, to: JOINT }], heading: { mode: "tangent" } };
const legB = { id: "b", kind: "path", segments: [{ kind: "line", from: "current", to: END }], heading: { mode: "tangent" } };

const oneStep = (): Auto =>
  autoOf([
    {
      id: "a",
      kind: "path",
      segments: [
        { kind: "line", from: START, to: JOINT },
        { kind: "line", from: JOINT, to: END },
      ],
      heading: { mode: "tangent" },
    },
  ]);

const planOf = (auto: Auto): Plan => plan(resolve(auto, waypoints), robot, field);

/** The lowest speed the robot had between `fromS` and `toS`, in in/s. */
const slowest = (trace: SimTrace, fromS: number, toS: number): number => {
  let lowest = Infinity;
  for (const [t, vx, vy] of trace.velocities) {
    if (t >= fromS && t <= toS) lowest = Math.min(lowest, Math.hypot(vx, vy));
  }
  return lowest;
};

const stepOf = (trace: SimTrace, id: string): { startS: number; endS: number } => {
  const step = trace.steps.find((candidate) => candidate.id === id);
  if (step === undefined || step.endS === null || step.endS === undefined) throw new Error(`no finished step ${id}`);
  return { startS: step.startS, endS: step.endS };
};

describe("two chained path steps", () => {
  it("cost no settle time at the joint, and the ideal playback does not hold there", () => {
    const planned = planOf(autoOf([legA, legB]));
    const timing = estimate(planned, robot);
    const ideal = idealTrajectory(planned, timing);
    const a = ideal.segments.find((segment) => segment.kind === "path" && segment.stepId === "a");
    const b = ideal.segments.find((segment) => segment.kind === "path" && segment.stepId === "b");
    expect(a).toBeDefined();
    expect(b?.startS).toBe(a?.endS);
    expect(ideal.segments.filter((segment) => segment.kind === "hold" && segment.stepId === "a")).toEqual([]);
    // The last path still settles: nothing replaces its hold.
    expect(ideal.segments.filter((segment) => segment.kind === "hold" && segment.stepId === "b")).toHaveLength(1);

    // The two legs are the same length from rest to rest, so they differ by exactly the settle.
    const settleS = robot.kinematics.settleS?.value ?? 0.25;
    expect((timing.byStepId["a"]?.nominalS as number) + settleS).toBeCloseTo(
      timing.byStepId["b"]?.nominalS as number,
      9,
    );
  });

  it("agree whether the second path is in a sequence or not", () => {
    const flat = estimate(planOf(autoOf([legA, legB])), robot);
    const grouped = estimate(planOf(autoOf([legA, { id: "grp", kind: "sequence", steps: [legB] }])), robot);
    expect(grouped.byStepId["a"]?.nominalS).toBeCloseTo(flat.byStepId["a"]?.nominalS as number, 9);
    expect(grouped.nominalS).toBeCloseTo(flat.nominalS as number, 9);
  });

  it("still settle before a step that is not a path", () => {
    const planned = planOf(autoOf([legA, { id: "w", kind: "wait", seconds: 0.5 }]));
    const ideal = idealTrajectory(planned, estimate(planned, robot));
    expect(ideal.segments.filter((segment) => segment.kind === "hold" && segment.stepId === "a")).toHaveLength(1);
  });

  it("slow into the joint in the instant sim without stopping or dwelling", () => {
    const trace = simulate(planOf(autoOf([legA, legB])), robot, field, { tickS: TICK_S });
    expect(trace.completed).toBe(true);
    const a = stepOf(trace, "a");
    const b = stepOf(trace, "b");
    // The second path starts on the loop the first one ends: no dead time.
    expect(b.startS).toBe(a.endS);

    const cruise = slowest(trace, a.endS - 0.6, a.endS - 0.5);
    const joint = slowest(trace, a.endS - 0.3, a.endS + 0.3);
    expect(joint).toBeGreaterThan(5);
    // Pedro brakes into the end of each path it is given, so the dip is real robot behaviour.
    expect(joint).toBeLessThan(0.6 * cruise);

    // One step with both segments is one Pedro path, and hands over without braking.
    const merged = simulate(planOf(oneStep()), robot, field, { tickS: TICK_S });
    expect(slowest(merged, a.endS - 0.3, a.endS + 0.3)).toBeGreaterThan(0.9 * cruise);
    expect(stepOf(merged, "a").endS).toBeLessThan(b.endS);
  });

  it("slow into the joint in a live run the same way", () => {
    const planned = planOf(autoOf([legA, legB]));
    const start = planned.startPose;
    const plant = new MecanumPlant(plantParams(robot, field, "robot", {}), start.xIn, start.yIn, start.headingRad);
    const run = createLiveRun(planned, robot, field, {}, { tickS: TICK_S });
    for (let i = 0; i < 10_000 && !run.finished; i += 1) {
      const m = plant.motion();
      const belief: LiveBelief = {
        xIn: m.x,
        yIn: m.y,
        headingRad: m.heading,
        vxInPerS: m.vx,
        vyInPerS: m.vy,
        omegaRadPerS: m.omega,
        twistForwardInPerS: m.twistX,
        twistLeftInPerS: m.twistY,
      };
      const result = run.tick(belief);
      if (result.finished) break;
      plant.drive(result.powers);
      plant.update(TICK_S);
    }
    expect(run.finished).toBe(true);
    const trace = run.trace();
    const a = stepOf(trace, "a");
    expect(stepOf(trace, "b").startS).toBe(a.endS);
    expect(slowest(trace, a.endS - 0.3, a.endS + 0.3)).toBeGreaterThan(5);
  });
});
