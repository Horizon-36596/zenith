import { parseAuto, parseRobot, SCHEMA_ID, type Auto, type Robot } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { check } from "./check.js";
import { estimate } from "./estimate.js";
import { angleDelta } from "./geometry/angle.js";
import type { Pose } from "./geometry/vec.js";
import { robotLimits } from "./kinematics.js";
import { plan } from "./plan.js";
import { resolve } from "./resolve.js";
import { idealPoseAt, idealTrajectory } from "./sim/ideal.js";
import { buildSimPath } from "./sim/pedroPath.js";
import { simPoseAt, simulate } from "./sim/simulate.js";
import { testField, testRobot, testWaypoints } from "./testing/fixtures.js";
import {
  defaultTurnTimeoutS,
  holdTurnRad,
  isTurnInPlace,
  TURN_ARRIVED_IN,
  TURN_IN_PLACE_MAX_IN,
  TURN_NEAR_RAD,
  TURN_SETTLED_RAD,
  TURN_STILL_IN,
  TURN_STILL_RAD,
  TURN_STILL_S,
  TURN_TIMEOUT_MARGIN_S,
  TurnSettle,
} from "./turnInPlace.js";
import type { Plan, PlanStep } from "./types.js";

/**
 * A turn on the spot: a path step with no length (decision D10, issue #187). The runtime runs it
 * as `follower.hold` at the step's end heading until `TurnSettle` says it is done, and the plan,
 * the estimate, the ideal level and the instant sim all model that turn.
 */

const omega = robotLimits(testRobot).maxAngularVelRadPerS;

const autoOf = (steps: unknown[], start: Pose): Auto =>
  parseAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 2,
    name: "turn-fixture",
    alliance: "RED",
    start: { pose: start },
    steps,
  });

/** A turn on the spot at `at`, from "current", with a linear heading. */
const turn = (id: string, at: { xIn: number; yIn: number }, fromRad: number, toRad: number): unknown => ({
  id,
  kind: "path",
  segments: [{ kind: "line", from: "current", to: { xIn: at.xIn, yIn: at.yIn } }],
  heading: { mode: "linear", fromRad, toRad },
});

const planOf = (auto: Auto): Plan => plan(resolve(auto, testWaypoints), testRobot, testField);

const stepOf = (planned: Plan, id: string): PlanStep => {
  const found = planned.steps.find((step) => step.id === id);
  if (found === undefined) throw new Error(`no step ${id}`);
  return found;
};

describe("a turn on the spot (decision D10)", () => {
  it("is recognised by its length, and the runtime's limit is the estimate's 2 in", () => {
    const planned = planOf(autoOf([turn("turn", { xIn: 0, yIn: -40 }, 0, Math.PI / 2)], { xIn: 0, yIn: -40, headingRad: 0 }));
    expect(isTurnInPlace(stepOf(planned, "turn"))).toBe(true);
    expect(TURN_IN_PLACE_MAX_IN).toBe(2);
    expect(TURN_SETTLED_RAD).toBeCloseTo((2 * Math.PI) / 180, 12);
    expect(TURN_ARRIVED_IN).toBe(0.5);
  });

  it("is planned by angle at one point, ending at the heading resolve gives the next step", () => {
    const auto = autoOf(
      [
        turn("turn", { xIn: 0, yIn: -40 }, Math.PI / 2, (3 * Math.PI) / 4),
        {
          id: "after",
          kind: "path",
          segments: [{ kind: "line", from: "current", to: { xIn: -20, yIn: -20 } }],
          heading: { mode: "constant", headingRad: (3 * Math.PI) / 4 },
        },
      ],
      { xIn: 0, yIn: -40, headingRad: Math.PI / 2 },
    );
    const resolved = resolve(auto, testWaypoints);
    const planned = plan(resolved, testRobot, testField);
    const step = stepOf(planned, "turn");
    expect(step.samples.length).toBeGreaterThan(2);
    for (const sample of step.samples) {
      expect(sample.pose.xIn).toBeCloseTo(0, 9);
      expect(sample.pose.yIn).toBeCloseTo(-40, 9);
      expect(sample.sIn).toBe(0);
    }
    // The sweep goes from the way the robot arrives to the end heading, a sample at least every 5°.
    expect(step.samples[0]?.pose.headingRad).toBeCloseTo(Math.PI / 2, 9);
    for (let i = 1; i < step.samples.length; i += 1) {
      const turned = angleDelta(step.samples[i - 1]?.pose.headingRad ?? 0, step.samples[i]?.pose.headingRad ?? 0);
      expect(Math.abs(turned)).toBeLessThanOrEqual((5 * Math.PI) / 180 + 1e-9);
    }
    expect(step.endPose?.headingRad).toBeCloseTo((3 * Math.PI) / 4, 9);
    expect(step.endPose?.headingRad).toBeCloseTo(resolved.steps[0]?.endPose.headingRad ?? NaN, 9);
    expect(resolved.steps[1]?.startPose.headingRad).toBeCloseTo((3 * Math.PI) / 4, 9);
  });

  it("costs |Δh| / ω in the estimate, and the ideal level plays it in exactly that time", () => {
    const planned = planOf(autoOf([turn("turn", { xIn: 0, yIn: -40 }, 0, Math.PI / 2)], { xIn: 0, yIn: -40, headingRad: 0 }));
    const estimated = estimate(planned, testRobot);
    const turnS = Math.PI / 2 / omega;
    expect(estimated.byStepId["turn"]?.nominalS).toBeCloseTo(turnS, 9);
    expect(estimated.nominalS).toBeCloseTo(turnS, 9);

    const ideal = idealTrajectory(planned, estimated);
    expect(ideal.totalS).toBeCloseTo(turnS, 9);
    const span = ideal.spans.find((candidate) => candidate.stepId === "turn");
    expect(span?.startS).toBeCloseTo(0, 9);
    expect(span?.endS).toBeCloseTo(turnS, 9);
    expect(span?.transitionS).toBe(0);
    // A pure turn: half way through its span the robot is on the spot, half way round.
    const middle = idealPoseAt(ideal, turnS / 2);
    expect(middle.xIn).toBeCloseTo(0, 9);
    expect(middle.yIn).toBeCloseTo(-40, 9);
    expect(middle.headingRad).toBeCloseTo(Math.PI / 4, 6);
  });

  it("gives a path of 2 in or less at least |Δh| / ω for its heading change", () => {
    const planned = planOf(
      autoOf(
        [
          {
            id: "nudge",
            kind: "path",
            segments: [{ kind: "line", from: "current", to: { xIn: 1.5, yIn: -40 } }],
            heading: { mode: "linear", fromRad: 0, toRad: Math.PI },
          },
        ],
        { xIn: 0, yIn: -40, headingRad: 0 },
      ),
    );
    const estimated = estimate(planned, testRobot);
    expect(estimated.byStepId["nudge"]?.nominalS ?? 0).toBeGreaterThanOrEqual(Math.PI / omega - 1e-9);
  });

  it("raises PERIMETER on the turn when a 90° to 180° turn flush on the south wall swings a corner off the field", () => {
    // 18 in along the nose: facing 90° the back is flush on the south wall at y = -72.
    const at = { xIn: 0, yIn: -63 };
    const planned = planOf(autoOf([turn("turn", at, Math.PI / 2, Math.PI)], { ...at, headingRad: Math.PI / 2 }));
    const findings = check(planned, estimate(planned, testRobot), testRobot, testField);
    const perimeter = findings.filter((finding) => finding.code === "PERIMETER");
    expect(perimeter.map((finding) => finding.stepId)).toEqual(["turn"]);
    const finding = perimeter[0];
    expect(finding?.message).toMatch(/^The robot leaves the field past the south wall by \d+\.\d\d in while it turns on the spot/);
    // The turn-while-driving fix makes no sense for a step that does not drive.
    expect(finding?.fixes?.some((fix) => fix.kind === "linearHeading") ?? false).toBe(false);
  });

  it("is held by the instant sim until it ends at the To heading", () => {
    const toRad = Math.PI / 2;
    const planned = planOf(autoOf([turn("turn", { xIn: 0, yIn: -40 }, 0, toRad)], { xIn: 0, yIn: -40, headingRad: 0 }));
    const trace = simulate(planned, testRobot, testField);
    const record = trace.steps.find((step) => step.id === "turn");
    expect(record).toBeDefined();
    const endS = record?.endS ?? 0;
    // It takes at least the turn at the angular limit, so it did not end on its first loop.
    expect(endS - (record?.startS ?? 0)).toBeGreaterThan(0.1);
    const end = simPoseAt(trace, endS);
    expect(end).not.toBeNull();
    expect(Math.abs(angleDelta(end?.headingRad ?? 0, toRad))).toBeLessThanOrEqual(2 * TURN_SETTLED_RAD);
    expect(Math.hypot((end?.xIn ?? 0) - 0, (end?.yIn ?? 0) + 40)).toBeLessThan(0.5);
  });

  it("is held by the instant sim until a short drive with no turn has arrived, not ended on its first loop", () => {
    // A deliberate 1.5 in nudge with a Constant heading: the runtime holds it, so the heading is
    // settled from the first loop, and only the position says whether the robot has got there.
    const to = { xIn: 0, yIn: -38.5 };
    const planned = planOf(
      autoOf(
        [
          {
            id: "nudge",
            kind: "path",
            segments: [{ kind: "line", from: "current", to }],
            heading: { mode: "constant", headingRad: Math.PI / 2 },
          },
        ],
        { xIn: 0, yIn: -40, headingRad: Math.PI / 2 },
      ),
    );
    const estimated = estimate(planned, testRobot);
    const trace = simulate(planned, testRobot, testField);
    const record = trace.steps.find((step) => step.id === "nudge");
    expect(record).toBeDefined();
    const startS = record?.startS ?? 0;
    const endS = record?.endS ?? 0;
    expect(endS - startS).toBeGreaterThan(0.05);
    const end = simPoseAt(trace, endS);
    expect(end).not.toBeNull();
    expect(Math.hypot((end?.xIn ?? 0) - to.xIn, (end?.yIn ?? 0) - to.yIn)).toBeLessThan(TURN_ARRIVED_IN);
    expect(Math.abs(angleDelta(end?.headingRad ?? 0, Math.PI / 2))).toBeLessThan(TURN_SETTLED_RAD);
    // The estimate and the sim tell the same story: both give the nudge real time.
    expect(estimated.byStepId["nudge"]?.nominalS ?? 0).toBeGreaterThan(0);
  });

  it("is held by the instant sim until a robot that arrives short has reached the spot and turned", () => {
    // The turn is written from "current" at (0, -40), but the robot starts 1.5 in short of it.
    const planned = planOf(autoOf([turn("turn", { xIn: 0, yIn: -40 }, 0, Math.PI / 2)], { xIn: -1.5, yIn: -40, headingRad: 0 }));
    const trace = simulate(planned, testRobot, testField);
    const record = trace.steps.find((step) => step.id === "turn");
    const end = simPoseAt(trace, record?.endS ?? 0);
    expect(end).not.toBeNull();
    expect(Math.hypot(end?.xIn ?? 0, (end?.yIn ?? 0) + 40)).toBeLessThan(TURN_ARRIVED_IN);
    expect(Math.abs(angleDelta(end?.headingRad ?? 0, Math.PI / 2))).toBeLessThan(TURN_SETTLED_RAD);
  });

  it("is a sim path with a turn target and no Pedro segments when it has no length", () => {
    const path = buildSimPath([[{ x: 3, y: 4 }, { x: 3, y: 4 }]], { mode: "linear", fromRad: 0, toRad: 2 }, 0);
    expect(path.turn).toEqual({ x: 3, y: 4, heading: 2 });
    expect(path.segments).toHaveLength(0);
    const driven = buildSimPath([[{ x: 0, y: 0 }, { x: 30, y: 0 }]], { mode: "tangent" }, 0);
    expect(driven.turn).toBeNull();
  });
});

/** The review's repro: start at (0, -40) facing 90°, a turn from "current" there, then a 0.1 s wait. */
const turnThenWait = (heading: unknown, extra: Record<string, unknown> = {}): Auto =>
  autoOf(
    [
      {
        id: "turn",
        kind: "path",
        segments: [{ kind: "line", from: "current", to: { xIn: 0, yIn: -40 } }],
        heading,
        ...extra,
      },
      { id: "after", kind: "wait", seconds: 0.1 },
    ],
    { xIn: 0, yIn: -40, headingRad: Math.PI / 2 },
  );

/** The fixture robot with a weaker hold: a heading P of 0.4 per rad leaves it at rest over 2° off. */
const weakHold: Robot = parseRobot({
  ...testRobot,
  kinematics: {
    ...testRobot.kinematics,
    follower: {
      ...testRobot.kinematics.follower,
      headingPowerPerRad: { value: 0.4, provenance: "PLACEHOLDER: test fixture, a weak heading P" },
    },
  },
});

/** Runs a turn then the wait in the instant sim, and says how the turn went. */
const runTurn = (auto: Auto, robot: Robot = testRobot) => {
  const planned = plan(resolve(auto, testWaypoints), robot, testField);
  const trace = simulate(planned, robot, testField);
  const record = trace.steps.find((step) => step.id === "turn");
  const after = trace.steps.find((step) => step.id === "after");
  const end = simPoseAt(trace, record?.endS ?? 0);
  const held = planned.steps.find((step) => step.id === "turn")?.endPose?.headingRad ?? NaN;
  return {
    planned,
    record,
    after,
    seconds: (record?.endS ?? Infinity) - (record?.startS ?? 0),
    errorRad: Math.abs(holdTurnRad(end?.headingRad ?? NaN, held)),
  };
};

describe("a turn on the spot always finishes (PR #206 review)", () => {
  const boundS = defaultTurnTimeoutS(robotLimits(testRobot));

  it("ends for every whole degree of target from -180° to 180°, before the default timeout", () => {
    const stuck: string[] = [];
    for (let degrees = -180; degrees <= 180; degrees += 1) {
      const run = runTurn(turnThenWait({ mode: "constant", headingRad: (degrees * Math.PI) / 180 }));
      const fine =
        run.record !== undefined &&
        !run.record.interrupted &&
        !run.record.timedOut &&
        run.after !== undefined &&
        run.seconds < boundS &&
        run.errorRad < TURN_SETTLED_RAD;
      if (!fine) stuck.push(`${String(degrees)}°: ${run.seconds.toFixed(2)} s, ${run.errorRad.toFixed(4)} rad`);
    }
    expect(stuck).toEqual([]);
  });

  it("ends for the targets the review found stuck, and for Facing point targets", () => {
    const headings: unknown[] = [
      ...[62, 63, 63.43, 64, 118].map((degrees) => ({ mode: "constant", headingRad: (degrees * Math.PI) / 180 })),
      { mode: "facePoint", xIn: 20, yIn: 0 },
      { mode: "facePoint", xIn: -20, yIn: 0 },
      { mode: "facePoint", xIn: 0, yIn: -72 },
      { mode: "facePoint", xIn: 50, yIn: -41 },
      { mode: "facePoint", xIn: -3, yIn: -10 },
    ];
    for (const heading of headings) {
      const label = JSON.stringify(heading);
      const run = runTurn(turnThenWait(heading));
      expect(run.record?.interrupted, label).toBe(false);
      expect(run.after, label).toBeDefined();
      expect(run.seconds, label).toBeLessThan(boundS);
      expect(run.errorRad, label).toBeLessThan(TURN_SETTLED_RAD);
    }
  });

  it("ends on a hold that comes to rest outside the tolerance, once the robot has been still", () => {
    const weakBoundS = defaultTurnTimeoutS(robotLimits(weakHold));
    const outside: number[] = [];
    for (let degrees = -180; degrees <= 180; degrees += 5) {
      const label = `${String(degrees)}°`;
      const run = runTurn(turnThenWait({ mode: "constant", headingRad: (degrees * Math.PI) / 180 }), weakHold);
      expect(run.record?.interrupted, label).toBe(false);
      expect(run.after, label).toBeDefined();
      expect(run.seconds, label).toBeLessThan(weakBoundS);
      expect(run.errorRad, label).toBeLessThan(TURN_NEAR_RAD);
      if (run.errorRad >= TURN_SETTLED_RAD) outside.push(degrees);
    }
    // The weak hold really does rest outside the tolerance, so the still rule is what ends these.
    expect(outside.length).toBeGreaterThan(10);
  });

  it("is not cut short by the default timeout an inserted turn gets, and the estimate is unchanged by it", () => {
    expect(boundS).toBeCloseTo(Math.ceil((Math.PI / omega + TURN_TIMEOUT_MARGIN_S) * 10 - 1e-9) / 10, 12);
    expect(boundS).toBeGreaterThan(Math.PI / omega + TURN_TIMEOUT_MARGIN_S - 1e-9);
    const heading = { mode: "constant", headingRad: (63.43 * Math.PI) / 180 };
    const bare = runTurn(turnThenWait(heading));
    const timed = runTurn(turnThenWait(heading, { timeoutS: boundS }));
    expect(timed.record?.timedOut).toBe(false);
    expect(timed.record?.endS).toBeCloseTo(bare.record?.endS ?? NaN, 9);
    const bareEstimate = estimate(bare.planned, testRobot);
    const timedEstimate = estimate(timed.planned, testRobot);
    expect(timedEstimate.byStepId["turn"]?.nominalS).toBeCloseTo(bareEstimate.byStepId["turn"]?.nominalS ?? NaN, 12);
    expect(idealTrajectory(timed.planned, timedEstimate).totalS).toBeCloseTo(timedEstimate.nominalS ?? NaN, 9);
  });
});

describe("TurnSettle, the rule the sim and both runtimes share", () => {
  const held = { x: 0, y: 0, heading: 1 };

  it("is done at once inside the heading and position tolerances", () => {
    expect(new TurnSettle(held).done({ x: 0.4, y: 0, heading: 1 + 0.9 * TURN_SETTLED_RAD }, 0)).toBe(true);
    expect(new TurnSettle(held).done({ x: 0.6, y: 0, heading: 1 }, 0)).toBe(false);
    expect(new TurnSettle(held).done({ x: 0, y: 0, heading: 1 + 1.1 * TURN_SETTLED_RAD }, 0)).toBe(false);
  });

  it("is done once the robot has been still near the held pose for TURN_STILL_S, and not before", () => {
    const settle = new TurnSettle(held);
    const resting = { x: 0.3, y: 0.2, heading: 1 + 0.05 };
    expect(settle.done(resting, 10)).toBe(false);
    expect(settle.done(resting, 10 + TURN_STILL_S / 2)).toBe(false);
    // Asking twice in one loop changes nothing.
    expect(settle.done(resting, 10 + TURN_STILL_S / 2)).toBe(false);
    // Creeping inside the still band does not restart the wait.
    const crept = { x: 0.3 + TURN_STILL_IN / 2, y: 0.2, heading: 1 + 0.05 + TURN_STILL_RAD / 2 };
    expect(settle.done(crept, 10 + TURN_STILL_S - 1e-6)).toBe(false);
    expect(settle.done(crept, 10 + TURN_STILL_S)).toBe(true);
  });

  it("starts the wait again when the robot moves, and never ends a robot at rest far from the turn", () => {
    const settle = new TurnSettle(held);
    expect(settle.done({ x: 0, y: 0, heading: 1.05 }, 0)).toBe(false);
    expect(settle.done({ x: 0, y: 0, heading: 1.05 + 2 * TURN_STILL_RAD }, 0.2)).toBe(false);
    expect(settle.done({ x: 0, y: 0, heading: 1.05 + 2 * TURN_STILL_RAD }, 0.3)).toBe(false);
    expect(settle.done({ x: 0, y: 0, heading: 1.05 + 2 * TURN_STILL_RAD }, 0.2 + TURN_STILL_S)).toBe(true);

    // At rest before the turn has begun, a quarter turn away: still for a long time, never done.
    const far = new TurnSettle(held);
    for (let t = 0; t <= 5; t += 0.02) expect(far.done({ x: 0, y: 0, heading: 1 - Math.PI / 2 }, t)).toBe(false);
    const away = new TurnSettle(held);
    for (let t = 0; t <= 5; t += 0.02) expect(away.done({ x: TURN_IN_PLACE_MAX_IN + 0.1, y: 0, heading: 1 }, t)).toBe(false);
  });
});
