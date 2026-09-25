import { parseAuto, parseRobot, SCHEMA_ID, type Auto, type Robot, type Step } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { estimate } from "../estimate.js";
import { runLedger } from "../ledger.js";
import { plan } from "../plan.js";
import { resolve } from "../resolve.js";
import { noSeasonRules, type SeasonRules } from "../season.js";
import { testField, testRobot, testWaypoints } from "../testing/fixtures.js";
import type { Plan } from "../types.js";
import { makeBezier, makeLine } from "./curves.js";
import {
  clampBrakingPower,
  diamondVelocity,
  mecanumMaxScaling,
  solveQuadratic,
} from "./follower.js";
import { buildSimPath, normalizeAngle, normalizeSigned } from "./pedroPath.js";
import { simResiduals } from "./residuals.js";
import { resimulate, simPoseAt, simulate, simulateRun } from "./simulate.js";
import type { SimOptions, SimStepRecord, SimTrace } from "./types.js";

/**
 * The instant sim's contract (site/docs/simulation.md): deterministic, fast, in
 * agreement with the kinematic estimate where the two model the same thing, re-simulable from an
 * edited step, and faithful to the runtime's command semantics.
 */

/** The test robot with a capacity, a known-length shot, an unknown command and the conditions. */
const robot: Robot = parseRobot({
  ...testRobot,
  capacity: { elementKind: "pollen", max: 4, provenance: "SPEC: test fixture" },
  commands: [
    { name: "shoot", estimateS: "1.5" },
    { name: "setIntake", estimateS: "0" },
    { name: "mystery", estimateS: "unknown" },
  ],
  conditions: [{ name: "hopperFull" }, { name: "hopperEmpty" }, { name: "tipSeen" }],
});

/**
 * A tuned follower and plant, so the sim is also exercised away from its fallbacks. PLACEHOLDER:
 * round numbers of a plausible size for a tuned mecanum robot, not any real robot's.
 */
const TUNED: SimOptions = {
  follower: {
    forwardTranslationalPowerPerIn: 0.15,
    strafeTranslationalPowerPerIn: 0.15,
    headingPowerPerRad: 2,
    coastPowerPerInPerS: 0,
    coastFeedforwardPowerPerInPerS: 0.012,
    brakeFeedforwardPowerPerInPerS: 0.005,
    maxBrakingPower: 0.3,
    headingDriveRatio: 0,
    cosineScale: false,
    brakeLinearForwardS: 0.05,
    brakeQuadraticForwardS2PerIn: 0.0015,
    brakeLinearStrafeS: 0.05,
    brakeQuadraticStrafeS2PerIn: 0.0015,
    headingBrakeLinearS: 0.04,
    headingBrakeQuadraticS2PerRad: 0.005,
  },
  plant: { wheelResponseRatePerS: 4, leverArmIn: 11 / 2 + 13 / 2 },
};

const autoOf = (steps: unknown[], startX = -50, startY = 0): Auto =>
  parseAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 2,
    name: "sim-fixture",
    alliance: "RED",
    start: { pose: { xIn: startX, yIn: startY, headingRad: 0 } },
    steps,
  });

const planOf = (auto: Auto, r: Robot = robot): Plan => plan(resolve(auto, testWaypoints), r, testField);

const line = (id: string, toX: number, toY: number, extra: Record<string, unknown> = {}): Step =>
  ({
    id,
    kind: "path",
    segments: [{ kind: "line", from: "current", to: { xIn: toX, yIn: toY } }],
    heading: { mode: "constant", headingRad: 0 },
    ...extra,
  }) as Step;

const stepById = (trace: SimTrace, id: string): SimStepRecord => {
  const found = trace.steps.find((step) => step.id === id);
  if (found === undefined) throw new Error(`no step ${id} in the trace`);
  return found;
};

const duration = (step: SimStepRecord): number => step.endS - step.startS;

/** A routine of legs, curves, shots, a marker and waits that runs for about 30 s. */
const longAuto = (): Auto => {
  const steps: unknown[] = [];
  for (let index = 0; index < 8; index += 1) {
    const angle = (index / 8) * Math.PI * 2;
    const x = Math.cos(angle) * 45;
    const y = Math.sin(angle) * 45;
    steps.push(
      index % 2 === 0
        ? {
            id: `leg${String(index)}`,
            kind: "path",
            segments: [{ kind: "line", from: "current", to: { xIn: x, yIn: y } }],
            heading: { mode: "tangent" },
            markers: [{ at: { t: 0.5 }, command: { name: "setIntake" } }],
          }
        : {
            id: `leg${String(index)}`,
            kind: "path",
            segments: [
              {
                kind: "bezier",
                from: "current",
                control: [
                  { xIn: x * 0.4, yIn: y * 1.2 },
                  { xIn: x * 0.9, yIn: y * 0.6 },
                ],
                to: { xIn: x, yIn: y },
              },
            ],
            heading: { mode: "linear", fromRad: 0, toRad: angle },
          },
    );
    steps.push({ id: `shot${String(index)}`, kind: "command", name: "shoot" });
    steps.push({ id: `pause${String(index)}`, kind: "wait", seconds: 0.5 });
  }
  return autoOf(steps, 45, 0);
};

describe("Pedro helpers", () => {
  it("solves a quadratic the stable way", () => {
    const [a, b] = solveQuadratic(1, -3, 2);
    expect([a, b].sort()).toEqual([1, 2]);
  });

  it("interpolates the diamond velocity between the forward and strafe maxima", () => {
    expect(diamondVelocity(96, 84, 0)).toBeCloseTo(96, 9);
    expect(diamondVelocity(96, 84, Math.PI / 2)).toBeCloseTo(84, 6);
    expect(diamondVelocity(96, 84, Math.PI / 4)).toBeLessThan(84);
  });

  it("caps only the power that opposes the motion", () => {
    expect(clampBrakingPower(-0.8, 10, 0.3)).toBe(-0.3);
    expect(clampBrakingPower(0.8, 10, 0.3)).toBe(0.8);
  });

  it("scales a delta so no wheel passes full power", () => {
    const scale = mecanumMaxScaling({ forward: 0.6, strafe: 0, turn: 0 }, { forward: 0, strafe: 0, turn: 1 });
    expect(scale).toBeCloseTo(0.4, 9);
  });

  it("normalises angles the way Pedro's Angle does", () => {
    expect(normalizeAngle(-Math.PI / 2)).toBeCloseTo((3 * Math.PI) / 2, 12);
    expect(normalizeSigned(Math.PI)).toBeCloseTo(-Math.PI, 12);
  });

  it("finds the closest point on a line and a Bezier", () => {
    expect(makeLine({ x: 0, y: 0 }, { x: 10, y: 0 }).closestT(4, 3, 0)).toBeCloseTo(0.4, 12);
    const curve = makeBezier([
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 20, y: 0 },
    ]);
    const at = curve.get(curve.closestT(10, 8, 0));
    expect(at.x).toBeCloseTo(10, 1);
    // The chord is 20 in and the curve bulges 5 in: its length is a little under 23 in.
    expect(curve.lengthIn).toBeGreaterThan(22.5);
    expect(curve.lengthIn).toBeLessThan(23.5);
  });

  it("turns a linear heading the short way, as Pedro's Interpolator.linear does", () => {
    const path = buildSimPath(
      [
        [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
        ],
      ],
      { mode: "linear", fromRad: 0, toRad: 3.5 },
      0,
    );
    const segment = path.segments[0];
    if (segment === undefined) throw new Error("no segment");
    // 3.5 rad counter-clockwise is 2.78 rad clockwise, and Pedro takes the short way round.
    expect(normalizeSigned(segment.heading(0.5))).toBeCloseTo(normalizeSigned(3.5 / 2 + Math.PI), 6);
  });
});

describe("determinism", () => {
  it("gives byte-identical trace JSON on repeat runs", () => {
    const planned = planOf(longAuto());
    const first = JSON.stringify(simulate(planned, robot, testField));
    const second = JSON.stringify(simulate(planned, robot, testField));
    expect(second).toBe(first);
    const gradleA = JSON.stringify(simulate(planned, robot, testField, { fidelity: "gradle" }));
    const gradleB = JSON.stringify(simulate(planned, robot, testField, { fidelity: "gradle" }));
    expect(gradleB).toBe(gradleA);
  });
});

describe("performance", () => {
  it("simulates a 30 s routine in under 30 ms", () => {
    const planned = planOf(longAuto());
    const trace = simulate(planned, robot, testField);
    // Warm the JIT, then take the best of several runs: the full suite runs files in parallel, and
    // a run that shares the CPU measures the machine, not the sim.
    for (let run = 0; run < 3; run += 1) simulate(planned, robot, testField);
    let best = Infinity;
    for (let run = 0; run < 15; run += 1) {
      const started = performance.now();
      simulate(planned, robot, testField);
      best = Math.min(best, performance.now() - started);
    }
    // eslint-disable-next-line no-console
    console.log(
      `instant sim: ${trace.simTimeS.toFixed(2)} s of routine (${String(trace.poses.length)} ticks) in ${best.toFixed(1)} ms (budget 30 ms)`,
    );
    expect(trace.simTimeS).toBeGreaterThan(25);
    expect(trace.completed).toBe(true);
    expect(best).toBeLessThan(30);
  });
});

describe("agreement with the estimate", () => {
  /**
   * On a cruise-dominated straight line the two models describe the same motion and agree inside
   * the band. At higher speed fractions the sim is shorter: Pedro ends a path step once the closest
   * point passes t = 0.975, still moving, while the estimate runs the profile to rest and adds
   * `settleS`. That direction is asserted too, so a change that made the sim longer than the
   * estimate's upper bound would fail.
   */
  const lengths = [24, 36, 60, 96, 120];

  it("agrees within the band on straight lines at cruise-limited speeds", () => {
    for (const lengthIn of lengths) {
      for (const speedFraction of [0.3, 0.4]) {
        const planned = planOf(autoOf([line("leg", -50 + lengthIn, 0, { speedFraction })]));
        const timing = estimate(planned, robot);
        const nominal = timing.steps[0]?.nominalS ?? NaN;
        const simS = duration(stepById(simulate(planned, robot, testField), "leg"));
        expect(Math.abs(simS - nominal)).toBeLessThanOrEqual(timing.bandFraction * nominal);
      }
    }
  });

  it("is never slower than the estimate's upper bound at any speed", () => {
    for (const lengthIn of lengths) {
      for (const speedFraction of [0.3, 0.5, 0.7, 0.9, 1]) {
        const planned = planOf(autoOf([line("leg", -50 + lengthIn, 0, { speedFraction })]));
        const high = estimate(planned, robot).steps[0]?.highS ?? NaN;
        const simS = duration(stepById(simulate(planned, robot, testField), "leg"));
        expect(simS).toBeLessThanOrEqual(high);
      }
    }
  });

  it("ends a line near its end and holds there", () => {
    const planned = planOf(autoOf([line("leg", 10, 0), { id: "rest", kind: "wait", seconds: 2 }]));
    for (const options of [{}, TUNED]) {
      const trace = simulate(planned, robot, testField, options);
      const last = trace.poses[trace.poses.length - 1];
      expect(Math.abs((last?.[1] ?? 0) - 10)).toBeLessThan(0.5);
      expect(Math.abs(last?.[2] ?? 1)).toBeLessThan(0.5);
    }
  });
});

describe("resimulate", () => {
  it("gives exactly what a full run gives, from the edited step", () => {
    const original = longAuto();
    const first = simulateRun(planOf(original), robot, testField);
    expect(first.checkpoints.length).toBeGreaterThan(10);

    const editedIndex = 9;
    const edited = parseAuto({
      ...original,
      steps: original.steps.map((step, index) =>
        index === editedIndex && step.kind === "path"
          ? { ...step, segments: [{ kind: "line", from: "current", to: { xIn: 20, yIn: 30 } }] }
          : step,
      ),
    });
    const planned = planOf(edited);
    const again = resimulate(first, planned, robot, testField, {}, editedIndex);
    expect(again.resumedFromStep).toBe(editedIndex);
    expect(JSON.stringify(again.trace)).toBe(JSON.stringify(simulate(planned, robot, testField)));

    // Without the hint it finds the same checkpoint from the keys alone.
    const found = resimulate(first, planned, robot, testField);
    expect(found.resumedFromStep).toBe(editedIndex);
    expect(JSON.stringify(found.trace)).toBe(JSON.stringify(again.trace));

    // And a run resumed after an edit carries checkpoints a later resume can use.
    const third = resimulate(again, planned, robot, testField, {}, 20);
    expect(third.resumedFromStep).toBe(20);
    expect(JSON.stringify(third.trace)).toBe(JSON.stringify(again.trace));
  });

  it("starts over when an input every step depends on changes", () => {
    const planned = planOf(longAuto());
    const first = simulateRun(planned, robot, testField);
    const again = resimulate(first, planned, robot, testField, { tickS: 0.005 });
    expect(again.resumedFromStep).toBe(0);
  });
});

describe("command semantics", () => {
  it("times commands by their estimateS and waits to the millisecond", () => {
    const trace = simulate(
      planOf(
        autoOf([
          { id: "shot", kind: "command", name: "shoot" },
          { id: "pause", kind: "wait", seconds: 1.25 },
          { id: "odd", kind: "command", name: "mystery" },
        ]),
      ),
      robot,
      testField,
      { unknownCommandS: 0.5 },
    );
    expect(duration(stepById(trace, "shot"))).toBeCloseTo(1.5, 9);
    expect(duration(stepById(trace, "pause"))).toBeCloseTo(1.25, 9);
    const odd = stepById(trace, "odd");
    expect(duration(odd)).toBeCloseTo(0.5, 9);
    expect(odd.unknown).toBe(true);
    expect(stepById(trace, "shot").unknown).toBe(false);
  });

  it("runs a sequence like the same steps at the top level", () => {
    const trace = simulate(
      planOf(
        autoOf([
          {
            id: "grp",
            kind: "sequence",
            steps: [
              { id: "a", kind: "command", name: "shoot" },
              { id: "b", kind: "wait", seconds: 0.5 },
            ],
          },
        ]),
      ),
      robot,
      testField,
    );
    const a = stepById(trace, "a");
    const b = stepById(trace, "b");
    expect(a.parentId).toBe("grp");
    expect(b.startS).toBeCloseTo(a.endS, 9);
    expect(duration(stepById(trace, "grp"))).toBeCloseTo(2, 9);
  });

  it("ends a parallel group per its mode", () => {
    const group = (mode: string, deadline?: string): Step =>
      ({
        id: "grp",
        kind: "parallel",
        mode,
        ...(deadline === undefined ? {} : { deadline }),
        steps: [line("drive", 40, 0), { id: "hold", kind: "wait", seconds: 0.5 }],
      }) as Step;
    const all = simulate(planOf(autoOf([group("all")])), robot, testField);
    const race = simulate(planOf(autoOf([group("race")])), robot, testField);
    const deadline = simulate(planOf(autoOf([group("deadline", "hold")])), robot, testField);

    const driveS = duration(stepById(all, "drive"));
    expect(driveS).toBeGreaterThan(1);
    expect(duration(stepById(all, "grp"))).toBeCloseTo(driveS, 9);
    expect(duration(stepById(race, "grp"))).toBeCloseTo(0.5, 9);
    expect(stepById(race, "drive").interrupted).toBe(true);
    expect(duration(stepById(deadline, "grp"))).toBeCloseTo(0.5, 9);
    expect(stepById(deadline, "drive").interrupted).toBe(true);
  });

  it("times a step out with its timeoutS", () => {
    const trace = simulate(planOf(autoOf([line("leg", 60, 0, { timeoutS: 0.4 })])), robot, testField);
    const leg = stepById(trace, "leg");
    expect(leg.timedOut).toBe(true);
    expect(duration(leg)).toBeCloseTo(0.4, 9);
    expect(trace.events.some((event) => event.kind === "timedOut")).toBe(true);
  });

  it("fires markers at their arc-length position", () => {
    const trace = simulate(
      planOf(
        autoOf([
          line("leg", 30, 0, {
            markers: [
              { at: { t: 0.5 }, command: { name: "setIntake" } },
              { at: { distanceIn: 0 }, command: { name: "shoot" } },
              { at: { distanceFromEndIn: 0 }, command: { name: "setIntake" } },
            ],
          }),
        ]),
      ),
      robot,
      testField,
    );
    const fired = trace.events.filter((event) => event.kind === "markerFired");
    expect(fired.map((event) => event.command)).toEqual(["shoot", "setIntake", "setIntake"]);
    const leg = stepById(trace, "leg");
    expect(fired[0]?.timeS).toBe(leg.startS);
    const halfway = simPoseAt(trace, fired[1]?.timeS ?? 0);
    // Halfway along 80 in is x = -10; the runner reads the follower after one tick of motion.
    expect(Math.abs((halfway?.xIn ?? 0) - -10)).toBeLessThan(2);
    // The marker at the very end fires on the tick the follower passes the last segment, one tick
    // before the follower hands over to the hold and the step ends.
    expect(fired[2]?.timeS).toBeCloseTo(leg.endS - trace.tickS, 9);
  });
});

describe("conditions", () => {
  /** A season that counts what the robot holds, so the ledger can say when the hopper fills. */
  const counting: SeasonRules = {
    ...noSeasonRules,
    id: "counting",
    initialState: () => ({ held: 0 }),
    onCollect: (state, _id, count) => ({ held: (state["held"] as number) + count }),
    onLaunch: (state, _target, count) => ({ held: Math.max(0, (state["held"] as number) - count) }),
    holds: (state) => ({ pollen: state["held"] as number }),
  };

  const collecting = (condition: string): Auto =>
    autoOf([
      line("sweep", 50, 0, {
        speedFraction: 0.5,
        endCondition: { condition },
        expect: { collectFrom: "flowers", count: 4 },
      }),
    ]);

  it("fires hopperFull where the ledger says the hopper fills", () => {
    const planned = planOf(collecting("hopperFull"));
    const ledger = runLedger(planned, testField, counting);
    const trace = simulate(planned, robot, testField, { ledger, season: counting });
    const sweep = stepById(trace, "sweep");
    expect(sweep.conditionFired).toBe(true);
    expect(sweep.unknown).toBe(false);
    expect(sweep.interrupted).toBe(false);
    const fired = trace.events.find((event) => event.kind === "conditionFired");
    // Four pieces evenly along 100 in, the fourth at the middle of its share: 87.5 in, x = 37.5.
    const at = simPoseAt(trace, fired?.timeS ?? 0);
    expect(Math.abs((at?.xIn ?? 0) - 37.5)).toBeLessThan(3);
    const full = simulate(planOf(collecting("hopperFull")), robot, testField);
    expect(duration(sweep)).toBeLessThan(duration(stepById(full, "sweep")));
    expect(trace.ledger.length).toBe(1);
    expect(trace.ledger[0]?.held).toBe(4);
  });

  it("takes a condition as never firing when it has no ledger, and says so", () => {
    const trace = simulate(planOf(collecting("hopperFull")), robot, testField);
    const sweep = stepById(trace, "sweep");
    expect(sweep.conditionFired).toBe(false);
    expect(sweep.unknown).toBe(true);
    expect(sweep.unknownReason).toMatch(/ledger/);
  });

  it("takes a sensor it cannot see as never firing", () => {
    const planned = planOf(collecting("tipSeen"));
    const trace = simulate(planned, robot, testField, {
      ledger: runLedger(planned, testField, counting),
      season: counting,
    });
    const sweep = stepById(trace, "sweep");
    expect(sweep.conditionFired).toBe(false);
    expect(sweep.unknown).toBe(true);
  });

  it("lets the caller resolve a condition", () => {
    const trace = simulate(planOf(collecting("tipSeen")), robot, testField, {
      conditions: (query) => (query.kind === "endCondition" ? 0.25 : undefined),
    });
    expect(stepById(trace, "sweep").conditionFired).toBe(true);
  });

  it("takes a branch's then side when it cannot tell, and runs only that side", () => {
    const trace = simulate(
      planOf(
        autoOf([
          {
            id: "fork",
            kind: "branch",
            condition: "tipSeen",
            then: [{ id: "yes", kind: "wait", seconds: 0.3 }],
            else: [{ id: "no", kind: "wait", seconds: 0.6 }],
          },
        ]),
      ),
      robot,
      testField,
    );
    expect(stepById(trace, "fork").unknown).toBe(true);
    expect(trace.steps.some((step) => step.id === "yes")).toBe(true);
    expect(trace.steps.some((step) => step.id === "no")).toBe(false);
  });

  it("waits until a condition the ledger already reads true without waiting", () => {
    const planned = planOf(
      autoOf([
        line("sweep", 0, 0, { expect: { collectFrom: "flowers", count: 4 } }),
        { id: "gate", kind: "wait", until: "hopperFull" },
      ]),
    );
    const trace = simulate(planned, robot, testField, {
      ledger: runLedger(planned, testField, counting),
      season: counting,
    });
    const gate = stepById(trace, "gate");
    expect(gate.conditionFired).toBe(true);
    expect(duration(gate)).toBeCloseTo(0.01, 9);
  });
});

describe("fidelity and residuals", () => {
  it("reproduces the Gradle harness's tick and quantisation", () => {
    const trace = simulate(planOf(autoOf([line("leg", 0, 10)])), robot, testField, { fidelity: "gradle" });
    expect(trace.tickS).toBe(0.02);
    expect(trace.truthPoses.length).toBe(trace.poses.length);
    for (const row of trace.poses) {
      const mm = row[1] * 25.4;
      expect(Math.abs(mm - Math.round(mm))).toBeLessThan(0.01);
    }
  });

  it("has no residual against itself and matches every step against the Gradle fidelity", () => {
    const planned = planOf(longAuto());
    const preview = simulate(planned, robot, testField);
    const self = simResiduals(preview, preview);
    expect(self.stepDurationMaxAbsS).toBe(0);
    expect(self.positionMaxIn).toBe(0);

    const gradle = simulate(planned, robot, testField, { fidelity: "gradle" });
    const residuals = simResiduals(preview, gradle);
    expect(residuals.missingInSim).toEqual([]);
    expect(residuals.missingInGradle).toEqual([]);
    expect(residuals.steps.length).toBe(gradle.steps.length);
    expect(residuals.poseSamples).toBeGreaterThan(100);
    expect(residuals.positionRmsIn).toBeGreaterThan(0);
  });
});
