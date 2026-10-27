import { parseAuto, parseRobot, SCHEMA_ID, type Auto, type Robot } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { driftPoseAt, driftTarget, smoothstep } from "./drift.js";
import { estimate } from "./estimate.js";
import { distance } from "./geometry/vec.js";
import { plan } from "./plan.js";
import { projectShare } from "./projection.js";
import { resolve } from "./resolve.js";
import { idealPoseAt, idealTrajectory } from "./sim/ideal.js";
import { simPoseAt, simulate } from "./sim/simulate.js";
import { testField, testRobot, testWaypoints } from "./testing/fixtures.js";
import type { Plan, PlanStep } from "./types.js";

/**
 * The drift (issue #481): a `movesRobot` command that the next path rejoins moves the robot from
 * where it starts to the rejoin pose inside its own time, in the ideal playback and in the instant
 * sim, so the views agree with the estimate. The fixture is the shape of the owner's demo: drive
 * into the garden, hunt pollen inside an envelope for its 4 s window, then drive back from the
 * rejoin pose.
 */

const robot: Robot = parseRobot({
  ...(JSON.parse(JSON.stringify(testRobot)) as Record<string, unknown>),
  commands: [
    { name: "setIntake", estimateS: "0" },
    { name: "visionCollect", estimateS: "unknown", movesRobot: true, requires: ["drive", "intake"] },
  ],
});

const REJOIN = { xIn: -58, yIn: -60, headingRad: Math.PI };
const GARDEN = { xIn: -40, yIn: -48 };
const WINDOW_S = 4;

const envelope = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  polygon: [
    { xIn: -70, yIn: -70 },
    { xIn: -30, yIn: -70 },
    { xIn: -30, yIn: -38 },
    { xIn: -70, yIn: -38 },
  ],
  maxDurationS: WINDOW_S,
  provenance: "SET BY HAND: test fixture, the hunt stays in the garden",
  ...extra,
});

const toGarden = {
  id: "toGarden",
  kind: "path",
  segments: [{ kind: "line", from: { ref: "startTile" }, to: GARDEN }],
  heading: { mode: "tangent" },
};
const hunt = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "hunt",
  kind: "command",
  name: "visionCollect",
  envelope: envelope(),
  ...extra,
});
const back = (rejoin: boolean, fromRad = Math.PI): Record<string, unknown> => ({
  id: "back",
  kind: "path",
  ...(rejoin ? { rejoinFrom: { ...REJOIN, provenance: "SET BY HAND: test fixture" } } : {}),
  segments: [{ kind: "line", from: "current", to: { xIn: -20, yIn: -20 } }],
  heading: { mode: "linear", fromRad, toRad: Math.PI / 2 },
});

const autoOf = (steps: unknown[]): Auto =>
  parseAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 4,
    name: "drift-fixture",
    alliance: "RED",
    start: { pose: { ref: "startTile" } },
    steps,
  });

const planOf = (steps: unknown[]): Plan => plan(resolve(autoOf(steps), testWaypoints, robot), robot, testField);
const stepOf = (planned: Plan, id: string): PlanStep => planned.steps.find((step) => step.id === id) as PlanStep;

describe("the drift's shape", () => {
  it("eases from rest to rest and turns the short way", () => {
    expect(smoothstep(0)).toBe(0);
    expect(smoothstep(0.5)).toBe(0.5);
    expect(smoothstep(1)).toBe(1);
    const from = { xIn: 0, yIn: 0, headingRad: 3 };
    const to = { xIn: 10, yIn: 0, headingRad: -3 };
    // From 3 rad to -3 rad is 0.28 rad through pi, not 6 rad the long way.
    const mid = driftPoseAt(from, to, 0.5);
    expect(mid.xIn).toBeCloseTo(5, 9);
    expect(Math.abs(mid.headingRad)).toBeCloseTo(Math.PI, 9);
  });

  it("drifts only a movesRobot command that something gave an end of its own", () => {
    const rejoined = planOf([toGarden, hunt(), back(true)]);
    expect(driftTarget(stepOf(rejoined, "hunt"), robot)).toEqual(REJOIN);
    expect(driftTarget(stepOf(rejoined, "toGarden"), robot)).toBeNull();
    // Without a rejoin pose nothing says where the command ends, so it holds.
    expect(driftTarget(stepOf(planOf([toGarden, hunt(), back(false)]), "hunt"), robot)).toBeNull();
    // A command that does not drive the robot never drifts.
    const intake = { id: "intake", kind: "command", name: "setIntake" };
    expect(driftTarget(stepOf(planOf([toGarden, intake, back(true)]), "intake"), robot)).toBeNull();
  });
});

describe("the ideal playback drifts a rejoined movesRobot command", () => {
  const planned = planOf([toGarden, hunt(), back(true)]);
  const est = estimate(planned, robot);
  const ideal = idealTrajectory(planned, est);
  const span = ideal.spans.find((candidate) => candidate.stepId === "hunt");

  it("is on the rejoin pose when the window ends, with no transition before the next path", () => {
    expect(span).toBeDefined();
    if (span === undefined) return;
    expect(span.endS - span.startS).toBeCloseTo(WINDOW_S, 9);
    const end = idealPoseAt(ideal, span.endS);
    expect(distance(end, REJOIN)).toBeLessThan(1e-9);
    expect(Math.cos(end.headingRad - REJOIN.headingRad)).toBeCloseTo(1, 9);
    expect(ideal.transitions.filter((transition) => transition.stepId === "back")).toEqual([]);
    expect(ideal.spans.find((candidate) => candidate.stepId === "back")?.transitionS).toBe(0);
    // It moves while the window is open, from where the path before it ended.
    const start = idealPoseAt(ideal, span.startS);
    expect(distance(start, GARDEN)).toBeLessThan(1e-6);
    const mid = idealPoseAt(ideal, (span.startS + span.endS) / 2);
    expect(distance(mid, { xIn: (GARDEN.xIn + REJOIN.xIn) / 2, yIn: (GARDEN.yIn + REJOIN.yIn) / 2 })).toBeLessThan(1e-6);
    expect(ideal.segments.filter((segment) => segment.kind === "drift").map((segment) => segment.stepId)).toEqual(["hunt"]);
  });

  it("lasts as long as the estimate says, so the ideal total is the estimate's", () => {
    expect(est.nominalS).not.toBeNull();
    expect(ideal.totalS).toBeCloseTo(est.nominalS ?? 0, 9);
  });

  it("still agrees with the estimate when the path after it starts facing another way", () => {
    // The path starts on the rejoin pose facing pi/2, so it first turns in place, which the
    // estimate counts as the path's own joint turn.
    const turned = planOf([toGarden, hunt(), back(true, Math.PI / 2)]);
    const turnedEstimate = estimate(turned, robot);
    expect(turnedEstimate.byStepId["back"]?.turnS ?? 0).toBeGreaterThan(0);
    expect(idealTrajectory(turned, turnedEstimate).totalS).toBeCloseTo(turnedEstimate.nominalS ?? 0, 9);
  });

  it("drifts the mover of a sequence, and the wait after it stands on the rejoin pose", () => {
    const pause = { id: "pause", kind: "wait", seconds: 0.5 };
    const grouped = planOf([toGarden, { id: "collect", kind: "sequence", steps: [hunt(), pause] }, back(true)]);
    const groupedEstimate = estimate(grouped, robot);
    const groupedIdeal = idealTrajectory(grouped, groupedEstimate);
    expect(groupedIdeal.segments.filter((segment) => segment.kind === "drift").map((segment) => segment.stepId)).toEqual(["hunt"]);
    const pauseSpan = groupedIdeal.spans.find((candidate) => candidate.stepId === "pause");
    if (pauseSpan === undefined) throw new Error("no span");
    expect(distance(idealPoseAt(groupedIdeal, (pauseSpan.startS + pauseSpan.endS) / 2), REJOIN)).toBeLessThan(1e-9);
    expect(groupedIdeal.transitions.filter((transition) => transition.stepId === "back")).toEqual([]);
    expect(groupedIdeal.totalS).toBeCloseTo(groupedEstimate.nominalS ?? 0, 9);
  });

  it("holds the robot still without a rejoin pose, as before", () => {
    const held = planOf([toGarden, hunt(), back(false)]);
    const heldIdeal = idealTrajectory(held, estimate(held, robot));
    const heldSpan = heldIdeal.spans.find((candidate) => candidate.stepId === "hunt");
    expect(heldIdeal.segments.some((segment) => segment.kind === "drift")).toBe(false);
    if (heldSpan === undefined) throw new Error("no span");
    expect(distance(idealPoseAt(heldIdeal, heldSpan.endS), GARDEN)).toBeLessThan(1e-6);
  });

  it("has nothing to drift when the step takes no time", () => {
    // No envelope and no estimate: the step counts as zero, so the next path closes the gap.
    const instant = planOf([toGarden, { id: "hunt", kind: "command", name: "visionCollect" }, back(true)]);
    const instantIdeal = idealTrajectory(instant, estimate(instant, robot));
    expect(instantIdeal.segments.some((segment) => segment.kind === "drift")).toBe(false);
    expect(instantIdeal.transitions.some((transition) => transition.stepId === "back")).toBe(true);
  });
});

describe("the instant sim drifts it too", () => {
  const planned = planOf([toGarden, hunt(), back(true)]);
  const trace = simulate(planned, robot, testField);
  const record = trace.steps.find((step) => step.id === "hunt");
  const next = trace.steps.find((step) => step.id === "back");

  it("has the robot within an inch of the rejoin pose when the next path starts", () => {
    expect(record).toBeDefined();
    expect(next).toBeDefined();
    if (record === undefined || next === undefined) return;
    expect(record.endS - record.startS).toBeCloseTo(WINDOW_S, 6);
    const at = simPoseAt(trace, next.startS);
    expect(at).not.toBeNull();
    if (at === null) return;
    expect(distance(at, REJOIN)).toBeLessThan(1);
    expect(Math.cos(at.headingRad - REJOIN.headingRad)).toBeGreaterThan(Math.cos(0.02));
  });

  it("keeps the step marked as one it does not predict, saying why", () => {
    expect(record?.unknown).toBe(true);
    expect(record?.unknownReason).toContain("rejoin pose");
  });

  it("moves the robot while the window is open, and the partner's projection shows it", () => {
    if (record === undefined) throw new Error("no record");
    const early = simPoseAt(trace, record.startS + 0.5);
    const late = simPoseAt(trace, record.endS - 0.5);
    if (early === null || late === null) throw new Error("no poses");
    expect(distance(early, late)).toBeGreaterThan(10);

    const projection = projectShare({ plan: planned, trace, robot, field: testField }, { level: "view" });
    const rate = projection.trajectory.rateHz;
    const row = (atS: number): [number, number, number] =>
      projection.trajectory.poses[Math.round(atS * rate)] as [number, number, number];
    const first = row(record.startS + 0.5);
    const last = row(record.endS - 0.5);
    expect(Math.hypot(first[0] - last[0], first[1] - last[1])).toBeGreaterThan(10);
  });

  it("is deterministic", () => {
    expect(JSON.stringify(simulate(planned, robot, testField))).toBe(JSON.stringify(trace));
  });
});

describe("a what-if run time (actualDurationS)", () => {
  const planned = planOf([toGarden, hunt({ envelope: envelope({ actualDurationS: 1.5 }) }), back(true)]);
  const est = estimate(planned, robot);

  it("times the step in the estimate, the ideal playback and the instant sim", () => {
    expect(est.byStepId["hunt"]?.nominalS).toBe(1.5);
    expect(est.byStepId["hunt"]?.fromEnvelope).toBe(true);
    expect(est.byStepId["hunt"]?.fromActualDuration).toBe(true);
    const ideal = idealTrajectory(planned, est);
    const span = ideal.spans.find((candidate) => candidate.stepId === "hunt");
    expect((span?.endS ?? 0) - (span?.startS ?? 0)).toBeCloseTo(1.5, 9);
    expect(ideal.totalS).toBeCloseTo(est.nominalS ?? 0, 9);
    const trace = simulate(planned, robot, testField);
    const record = trace.steps.find((step) => step.id === "hunt");
    expect((record?.endS ?? 0) - (record?.startS ?? 0)).toBeCloseTo(1.5, 6);
    expect(record?.unknownReason).toContain("what-if actualDurationS");
  });

  it("leaves a partner's envelope window at maxDurationS, the promise", () => {
    const trace = simulate(planned, robot, testField);
    const record = trace.steps.find((step) => step.id === "hunt");
    const projection = projectShare({ plan: planned, trace, robot, field: testField }, { level: "view" });
    expect(projection.envelopes).toHaveLength(1);
    expect((projection.envelopes[0]?.endS ?? 0) - (record?.startS ?? 0)).toBeCloseTo(WINDOW_S, 2);
  });
});
