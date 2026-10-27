import { parseAuto, parseRobot, SCHEMA_ID, type Auto, type Robot } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { check } from "./check.js";
import { intakeTimeline } from "./checks/intake.js";
import { mouthLeadingStretches } from "./checks/motion.js";
import { estimate } from "./estimate.js";
import { plan } from "./plan.js";
import { resolve } from "./resolve.js";
import { testField, testRobot, testWaypoints } from "./testing/fixtures.js";
import type { Finding, FindingCode } from "./types.js";

/**
 * Which mouths run where (issue #375): a marker that stops the intake ends it there rather than
 * erasing it from the whole path, a branch's arms each start from the state the branch was entered
 * with, and the heading of a stretch is averaged the short way round across +-pi.
 */

const robot: Robot = parseRobot({
  ...(JSON.parse(JSON.stringify(testRobot)) as Record<string, unknown>),
  mouths: [
    {
      id: "front",
      side: "FRONT",
      offsetIn: { xIn: 8, yIn: 0 },
      widthIn: 14,
      depthIn: 4,
      provenance: "PLACEHOLDER: test fixture",
    },
  ],
  commands: [
    {
      name: "setIntake",
      params: {
        side: { type: "enum", values: ["FRONT", "BACK", "BOTH"] },
        state: { type: "enum", values: ["STOP", "FORWARD", "REVERSE"] },
      },
      estimateS: "0",
      requires: ["intake"],
    },
  ],
});

const auto = (steps: unknown[]): Auto =>
  parseAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 1,
    name: "intake-intervals",
    alliance: "RED",
    start: { pose: { xIn: -40, yIn: -60, headingRad: 0 } },
    steps,
  });

const planOf = (steps: unknown[]) => plan(resolve(auto(steps), testWaypoints), robot, testField);
const run = (steps: unknown[]): Finding[] => {
  const planned = planOf(steps);
  return check(planned, estimate(planned, robot), robot, testField);
};
const of = (findings: readonly Finding[], code: FindingCode): Finding[] =>
  findings.filter((finding) => finding.code === code);

const intake = (id: string, state: string) => ({
  id,
  kind: "command",
  name: "setIntake",
  args: { side: "FRONT", state },
});
const stopAt = (t: number) => ({ at: { t }, command: { name: "setIntake", args: { side: "FRONT", state: "STOP" } } });
const startAt = (t: number) => ({ at: { t }, command: { name: "setIntake", args: { side: "FRONT", state: "FORWARD" } } });

/** Drives north, too fast for a sweep, with the robot facing west: the front mouth leads nothing. */
const sideways = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind: "path",
  segments: [{ kind: "line", from: "current", to: { xIn: -40, yIn: -20 } }],
  heading: { mode: "constant", headingRad: Math.PI },
  speedFraction: 0.9,
  ...extra,
});

describe("a marker that stops the intake part way along a path", () => {
  it("ends the running stretch at its t instead of erasing the intake from the whole path", () => {
    const timeline = intakeTimeline(planOf([intake("on", "FORWARD"), sideways("sweep", { markers: [stopAt(0.9)] })]).steps, robot);
    expect(timeline.byStepId.get("sweep")?.get("front")).toEqual([{ fromT: 0, toT: 0.9 }]);
  });

  it("still raises MOUTH_LEADING and SWEEP_SPEED for the stretch before the stop", () => {
    const findings = run([intake("on", "FORWARD"), sideways("sweep", { markers: [stopAt(0.9)] })]);
    expect(of(findings, "MOUTH_LEADING")).toHaveLength(1);
    expect(of(findings, "SWEEP_SPEED")).toHaveLength(1);
  });

  it("takes the markers in path order, whatever order the file lists them in", () => {
    const timeline = intakeTimeline(planOf([sideways("sweep", { markers: [stopAt(0.8), startAt(0.2)] })]).steps, robot);
    expect(timeline.byStepId.get("sweep")?.get("front")).toEqual([{ fromT: 0.2, toT: 0.8 }]);
    const after = intakeTimeline(planOf([sideways("sweep", { markers: [stopAt(0.8), startAt(0.2)] }), sideways("next")]).steps, robot);
    expect(after.byStepId.get("next")?.has("front")).toBe(false);
  });

  it("does not count the mouth on a path where it stops at the very start", () => {
    const findings = run([intake("on", "FORWARD"), sideways("sweep", { markers: [stopAt(0)] })]);
    expect(of(findings, "SWEEP_SPEED")).toEqual([]);
    expect(of(findings, "MOUTH_LEADING")).toEqual([]);
  });

  it("keeps a mouth that stops and starts again as two stretches", () => {
    const timeline = intakeTimeline(
      planOf([intake("on", "FORWARD"), sideways("sweep", { markers: [stopAt(0.3), startAt(0.6)] })]).steps,
      robot,
    );
    expect(timeline.byStepId.get("sweep")?.get("front")).toEqual([
      { fromT: 0, toT: 0.3 },
      { fromT: 0.6, toT: Number.POSITIVE_INFINITY },
    ]);
  });
});

describe("a branch's arms", () => {
  it("each start from the intake state the branch was entered with, and the paths after see either", () => {
    const branch = {
      id: "maybe",
      kind: "branch",
      condition: "hopperFull",
      then: [intake("on", "FORWARD")],
      else: [intake("off", "STOP")],
    };
    const findings = run([branch, sideways("after")]);
    expect(of(findings, "SWEEP_SPEED").map((finding) => finding.stepId)).toEqual(["after"]);
  });

  it("does not let the then arm's stop leak into the else arm", () => {
    const branch = {
      id: "maybe",
      kind: "branch",
      condition: "hopperFull",
      then: [intake("off", "STOP")],
      else: [sideways("other")],
    };
    const findings = run([intake("on", "FORWARD"), branch]);
    expect(of(findings, "SWEEP_SPEED").map((finding) => finding.stepId)).toEqual(["other"]);
  });

  it("keeps the intake on after a branch with no else that turns it on", () => {
    const branch = { id: "maybe", kind: "branch", condition: "hopperFull", then: [intake("on", "FORWARD")] };
    const findings = run([branch, sideways("after")]);
    expect(of(findings, "SWEEP_SPEED").map((finding) => finding.stepId)).toEqual(["after"]);
  });
});

describe("the heading of a stretch", () => {
  it("is the short-way mean of its two samples, so headings either side of pi average to pi", () => {
    const west = {
      id: "west",
      kind: "path",
      segments: [{ kind: "line", from: "current", to: { xIn: -60, yIn: -60 } }],
      heading: { mode: "tangent" },
    };
    const planned = planOf([intake("on", "FORWARD"), west]);
    const step = planned.steps[1];
    if (step === undefined) throw new Error("no path step");
    const wobbly = {
      ...step,
      samples: step.samples.map((sample, index) => ({
        ...sample,
        pose: { ...sample.pose, headingRad: index % 2 === 0 ? 3.1241 : -3.1241 },
      })),
    };
    const stretches = mouthLeadingStretches(wobbly, robot, intakeTimeline(planned.steps, robot).byStepId.get("west"));
    expect(stretches.length).toBeGreaterThan(0);
    for (const stretch of stretches) expect(stretch.deviationRad).toBeLessThan(0.05);
  });
});
