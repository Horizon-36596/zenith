import { parseAuto, parseRobot, SCHEMA_ID, type Auto } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { checkTimeBudget } from "./checks/schedule.js";
import { commandSeconds, estimate, jointTurnS, sampleCapInPerS, totalBound, transitionProfile } from "./estimate.js";
import { lateralAccelLimitInPerS2, robotLimits, velocityCapInPerS } from "./kinematics.js";
import { flattenSteps, plan } from "./plan.js";
import { resolve } from "./resolve.js";
import { idealTrajectory } from "./sim/ideal.js";
import { testField, testRobot, testWaypoints } from "./testing/fixtures.js";
import type { StepEstimate } from "./types.js";

const auto = (steps: unknown[]): Auto =>
  parseAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 1,
    name: "estimate-fixture",
    alliance: "RED",
    start: { pose: { xIn: 0, yIn: -60, headingRad: 0 } },
    steps,
  });

const timeOf = (steps: unknown[]): ReturnType<typeof estimate> =>
  estimate(plan(resolve(auto(steps), testWaypoints), testRobot, testField), testRobot);

const straight = (speedFraction: number, mode: Record<string, unknown> = { mode: "tangent" }) => [
  {
    id: "leg",
    kind: "path",
    segments: [
      { kind: "line", from: { xIn: 0, yIn: -60, headingRad: 0 }, to: { xIn: 60, yIn: -60 } },
    ],
    heading: mode,
    speedFraction,
  },
];

describe("estimate", () => {
  it("times a 60 in nose-first leg at something a robot could actually do", () => {
    const result = timeOf(straight(1));
    const leg = result.steps[0];
    expect(leg?.unknown).toBe(false);
    // 60 in at up to 96.7 in/s, accelerating at 90 and braking at 89.4, plus 0.25 s of settle.
    expect(leg?.nominalS as number).toBeGreaterThan(1);
    expect(leg?.nominalS as number).toBeLessThan(2.5);
    expect(leg?.strafeFraction).toBeCloseTo(0, 6);
    expect(leg?.strafeCostS).toBeCloseTo(0, 6);
  });

  it("puts the band at plus or minus 20 per cent of nominal by default", () => {
    const result = timeOf(straight(1));
    expect(result.bandFraction).toBe(0.2);
    expect(result.lowS as number).toBeCloseTo((result.nominalS as number) * 0.8, 9);
    expect(result.highS as number).toBeCloseTo((result.nominalS as number) * 1.2, 9);
  });

  it("is monotone in speedFraction", () => {
    let previous = Infinity;
    for (const fraction of [0.2, 0.4, 0.6, 0.8, 1]) {
      const seconds = timeOf(straight(fraction)).nominalS as number;
      expect(seconds).toBeLessThanOrEqual(previous + 1e-9);
      previous = seconds;
    }
  });

  it("charges a constant heading across the direction of travel as a full strafe", () => {
    const tangent = timeOf(straight(1));
    const sideways = timeOf(straight(1, { mode: "constant", headingRad: Math.PI / 2 }));
    expect(sideways.steps[0]?.strafeFraction).toBeCloseTo(1, 6);
    expect(sideways.steps[0]?.strafeCostS as number).toBeGreaterThan(0);
    expect(sideways.nominalS as number).toBeGreaterThan(tangent.nominalS as number);
    // The cost in seconds is the difference against the same leg driven nose-first, like for like:
    // the sideways leg opens with a quarter turn in place from the start heading, which the
    // nose-first leg, already facing along it, does not need, so the turn is part of the cost.
    const turnS = sideways.steps[0]?.turnS ?? 0;
    expect(turnS).toBeCloseTo(Math.PI / 2 / robotLimits(testRobot).maxAngularVelRadPerS, 9);
    expect(sideways.steps[0]?.strafeCostS as number).toBeCloseTo((sideways.nominalS as number) - (tangent.nominalS as number), 6);
  });

  it("counts the turn a nose-first leg would need first in the strafe cost (0.1.2 UX sweep W2-3)", () => {
    // Starting facing +x, a constant +x heading on a northward leg needs no turn on the spot; the
    // nose-first leg turns a quarter turn first, which a short leg does not win back.
    const leg = (heading: unknown): unknown[] => [
      { id: "s", kind: "path", segments: [{ kind: "line", from: "current", to: { xIn: 0, yIn: -48 } }], heading },
    ];
    const sideways = timeOf(leg({ mode: "constant", headingRad: 0 }));
    const noseFirst = timeOf(leg({ mode: "tangent" }));
    expect(sideways.steps[0]?.strafeFraction).toBeCloseTo(1, 6);
    expect(noseFirst.nominalS as number).toBeGreaterThan(sideways.nominalS as number);
    expect(sideways.steps[0]?.strafeCostS).toBe(0);
  });

  it("reads a command's duration out of its estimateS expression", () => {
    // shootAll is `0.6 + count * cadence`; the test robot has no cadence table, so an enum
    // argument leaves the expression with a name it cannot resolve.
    expect(commandSeconds("shootAll", { count: 3 }, testRobot)).toBeNull();
    expect(commandSeconds("setIntake", {}, testRobot)).toBe(0);
    expect(commandSeconds("noSuchCommand", {}, testRobot)).toBeNull();
  });

  it("marks a step it cannot time as unknown and leaves it out of the total", () => {
    const result = timeOf([
      { id: "shoot", kind: "command", name: "shootAll", args: { count: 3 } },
      ...straight(1),
    ]);
    expect(result.steps[0]?.unknown).toBe(true);
    expect(result.steps[0]?.nominalS).toBeNull();
    expect(result.hasUnknown).toBe(true);
    expect(result.nominalS as number).toBeCloseTo(result.steps[1]?.nominalS as number, 9);
  });

  it("costs a wait exactly, and a wait for a condition not at all", () => {
    const result = timeOf([
      { id: "pause", kind: "wait", seconds: 1.5 },
      { id: "untilFull", kind: "wait", until: "hopperFull" },
    ]);
    expect(result.steps[0]?.nominalS).toBe(1.5);
    expect(result.steps[1]?.unknown).toBe(true);
  });

  it("costs a parallel group by its mode", () => {
    const legs = (id: string, toXIn: number): Record<string, unknown> => ({
      id,
      kind: "path",
      segments: [
        { kind: "line", from: { xIn: 0, yIn: -60, headingRad: 0 }, to: { xIn: toXIn, yIn: -60 } },
      ],
      heading: { mode: "tangent" },
    });
    const group = (mode: string, deadline?: string): unknown[] => [
      {
        id: "group",
        kind: "parallel",
        mode,
        ...(deadline === undefined ? {} : { deadline }),
        steps: [legs("short", 10), legs("long", 60)],
      },
    ];
    const all = timeOf(group("all"));
    const race = timeOf(group("race"));
    const deadline = timeOf(group("deadline", "short"));
    expect(all.steps[0]?.nominalS as number).toBeCloseTo(
      all.byStepId["long"]?.nominalS as number,
      9,
    );
    expect(race.steps[0]?.nominalS as number).toBeCloseTo(
      race.byStepId["short"]?.nominalS as number,
      9,
    );
    expect(deadline.steps[0]?.nominalS as number).toBeCloseTo(
      deadline.byStepId["short"]?.nominalS as number,
      9,
    );
  });

  it("explains itself in full sentences", () => {
    const result = timeOf(straight(1));
    expect(result.explain).toBe(result.assumptions);
    expect(result.explain.length).toBeGreaterThan(6);
    for (const sentence of result.explain) {
      expect(sentence.endsWith(".")).toBe(true);
      expect(sentence[0]).toBe(sentence[0]?.toUpperCase());
    }
  });

  it("is deterministic", () => {
    const first = timeOf(straight(0.8));
    const second = timeOf(straight(0.8));
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

describe("a deadline group whose deadline names no child", () => {
  const legs = (id: string, toXIn: number): Record<string, unknown> => ({
    id,
    kind: "path",
    segments: [
      { kind: "line", from: { xIn: 0, yIn: -60, headingRad: 0 }, to: { xIn: toXIn, yIn: -60 } },
    ],
    heading: { mode: "tangent" },
  });
  const group = (deadline?: string): unknown[] => [
    {
      id: "group",
      kind: "parallel",
      mode: "deadline",
      ...(deadline === undefined ? {} : { deadline }),
      steps: [legs("short", 10), legs("long", 60)],
    },
  ];

  it("finding 6: keeps the members' time in the total instead of dropping it", () => {
    const orphaned = timeOf(group("gone"));
    const longest = orphaned.byStepId["long"]?.nominalS as number;
    expect(orphaned.steps[0]?.nominalS as number).toBeCloseTo(longest, 9);
    expect(orphaned.nominalS as number).toBeCloseTo(longest, 9);
    expect(orphaned.steps[0]?.unknown).toBe(true);
    expect(orphaned.hasUnknown).toBe(true);
  });

  it("finding 6: does the same when there is no deadline key at all", () => {
    const none = timeOf(group());
    expect(none.nominalS as number).toBeCloseTo(none.byStepId["long"]?.nominalS as number, 9);
    expect(none.hasUnknown).toBe(true);
  });
});

describe("a path step that ends on a condition", () => {
  const untilFull = (endCondition: boolean): unknown[] => [
    {
      id: "collect",
      kind: "path",
      segments: [
        { kind: "line", from: { xIn: 0, yIn: -60, headingRad: 0 }, to: { xIn: 60, yIn: -60 } },
      ],
      heading: { mode: "tangent" },
      ...(endCondition ? { endCondition: { condition: "hopperFull" } } : {}),
    },
  ];

  it("finding 18: keeps the seconds as an upper bound and marks them unknown", () => {
    const bounded = timeOf(untilFull(true));
    const firm = timeOf(untilFull(false));
    expect(bounded.steps[0]?.nominalS as number).toBeCloseTo(firm.steps[0]?.nominalS as number, 9);
    expect(bounded.steps[0]?.unknown).toBe(true);
    expect(bounded.hasUnknown).toBe(true);
    expect(firm.steps[0]?.unknown).toBe(false);
    expect(firm.hasUnknown).toBe(false);
  });
});

describe("the velocity carried into a group's members", () => {
  /** A robot whose follower does not hold the end pose, so a leg hands its speed on. */
  const rolling = parseRobot({
    ...(JSON.parse(JSON.stringify(testRobot)) as Record<string, unknown>),
    kinematics: {
      ...(JSON.parse(JSON.stringify(testRobot.kinematics)) as Record<string, unknown>),
      follower: { ...testRobot.kinematics.follower, holdEnd: false },
    },
  });

  const legs = (id: string, fromXIn: number, toXIn: number): Record<string, unknown> => ({
    id,
    kind: "path",
    segments: [
      {
        kind: "line",
        from: { xIn: fromXIn, yIn: -60, headingRad: 0 },
        to: { xIn: toXIn, yIn: -60 },
      },
    ],
    heading: { mode: "tangent" },
  });

  const rollingTimeOf = (steps: unknown[]): ReturnType<typeof estimate> =>
    estimate(plan(resolve(auto(steps), testWaypoints), rolling, testField), rolling);

  it("finding 38: two paths in a parallel both start from the group's entry speed", () => {
    const alone = rollingTimeOf([legs("solo", 0, 30)]);
    const group = rollingTimeOf([
      {
        id: "group",
        kind: "parallel",
        mode: "all",
        steps: [legs("first", 0, 30), legs("second", 0, 30)],
      },
    ]);
    // The second member used to start from the first's exit speed and so come in faster.
    expect(group.byStepId["second"]?.nominalS as number).toBeCloseTo(
      group.byStepId["first"]?.nominalS as number,
      9,
    );
    expect(group.byStepId["first"]?.nominalS as number).toBeCloseTo(
      alone.byStepId["solo"]?.nominalS as number,
      9,
    );
  });

  it("finding 38: a branch's else side starts where the branch did, not where then ended", () => {
    const branch = rollingTimeOf([
      {
        id: "maybe",
        kind: "branch",
        condition: "hopperFull",
        then: [legs("thenLeg", 0, 30)],
        else: [legs("elseLeg", 0, 30)],
      },
    ]);
    expect(branch.byStepId["elseLeg"]?.nominalS as number).toBeCloseTo(
      branch.byStepId["thenLeg"]?.nominalS as number,
      9,
    );
  });
});

/**
 * Issue #153 (sweep finding N8): where a tangent path starts facing a different way from how the
 * last one ended, the robot turns before it drives. The ideal level always played that turn, but the
 * estimate did not time it, so the headline and TIME_BUDGET read a 32 s routine as 25.8 s.
 */
describe("the turn at a path joint", () => {
  /** Clicks on the field the way the editor's Add path tool makes them: tangent lines from "current". */
  const zigzag = (legs: number, startHeadingRad = 0): Auto =>
    parseAuto({
      $schema: SCHEMA_ID.auto,
      formatVersion: 2,
      name: "zigzag",
      alliance: "RED",
      start: { pose: { xIn: -60, yIn: -20, headingRad: startHeadingRad } },
      steps: Array.from({ length: legs }, (_, index) => ({
        id: `path${String(index + 1)}`,
        kind: "path",
        segments: [
          { kind: "line", from: "current", to: { xIn: -60 + 5 * (index + 1), yIn: index % 2 === 0 ? 20 : -20 } },
        ],
        heading: { mode: "tangent" },
      })),
    });

  const planOf = (source: Auto) => plan(resolve(source, testWaypoints), testRobot, testField);
  const turnsOf = (result: ReturnType<typeof estimate>): number =>
    Object.values(result.byStepId).reduce((sum, row) => sum + (row.turnS ?? 0), 0);

  it("for the 20-click zigzag of 21 tangent paths, equals the ideal run within 0.01 s", () => {
    const planned = planOf(zigzag(21));
    const result = estimate(planned, testRobot);
    const ideal = idealTrajectory(planned, result);
    expect(planned.steps).toHaveLength(21);
    expect(Math.abs((result.nominalS as number) - ideal.totalS)).toBeLessThan(0.01);
    // Every joint turns, and so does the first path, which leaves the start pose facing another way.
    for (const step of result.steps) expect(step.turnS as number).toBeGreaterThan(0);
  });

  it("raises a TIME_BUDGET warning for an auto that passes 30 s only once its turns are counted", () => {
    const result = estimate(planOf(zigzag(18)), testRobot);
    const withoutTurnsS = (result.nominalS as number) - turnsOf(result);
    expect(withoutTurnsS).toBeLessThan(30);
    expect(result.nominalS as number).toBeGreaterThan(30);
    const findings = checkTimeBudget(result, testField);
    expect(findings.map((finding) => `${finding.severity} ${finding.code} ${finding.stepId}`)).toEqual([
      "warning TIME_BUDGET total",
    ]);
  });

  it("leaves a straight chain with no heading gaps exactly as it was", () => {
    const leg = (id: string, xIn: number): unknown => ({
      id,
      kind: "path",
      segments: [{ kind: "line", from: "current", to: { xIn, yIn: -60 } }],
      heading: { mode: "tangent" },
    });
    const result = estimate(
      planOf(
        parseAuto({
          $schema: SCHEMA_ID.auto,
          formatVersion: 2,
          name: "straight",
          alliance: "RED",
          start: { pose: { xIn: -60, yIn: -60, headingRad: 0 } },
          steps: [leg("leg1", -40), leg("leg2", -20), { id: "pause", kind: "wait", seconds: 0.5 }, leg("leg3", 0), leg("leg4", 20)],
        }),
      ),
      testRobot,
    );
    // The total this chain had before joint turns were counted, pinned to the last digit.
    expect(result.nominalS as number).toBeCloseTo(4.84773058123, 9);
    expect(turnsOf(result)).toBe(0);
    for (const row of Object.values(result.byStepId)) expect(row.turnS ?? 0).toBe(0);
  });

  it("times a turn in place at maxAngularVelRadPerS, inside the step's nominal and its band", () => {
    const steps = [
      {
        id: "east",
        kind: "path",
        segments: [{ kind: "line", from: { xIn: 0, yIn: -60, headingRad: 0 }, to: { xIn: 30, yIn: -60 } }],
        heading: { mode: "tangent" },
      },
      {
        id: "north",
        kind: "path",
        segments: [{ kind: "line", from: "current", to: { xIn: 30, yIn: -30 } }],
        heading: { mode: "tangent" },
      },
    ];
    const result = timeOf(steps);
    const north = result.byStepId["north"] as StepEstimate;
    const expectedS = Math.PI / 2 / robotLimits(testRobot).maxAngularVelRadPerS;
    expect(north.turnS as number).toBeCloseTo(expectedS, 9);
    expect(result.byStepId["east"]?.turnS ?? 0).toBe(0);
    // The same leg on its own, starting where the robot already faces north, is the step less its turn.
    const alone = estimate(
      plan(
        resolve(
          parseAuto({
            $schema: SCHEMA_ID.auto,
            formatVersion: 1,
            name: "estimate-fixture",
            alliance: "RED",
            start: { pose: { xIn: 30, yIn: -60, headingRad: Math.PI / 2 } },
            steps: [steps[1]],
          }),
          testWaypoints,
        ),
        testRobot,
        testField,
      ),
      testRobot,
    );
    expect(alone.byStepId["north"]?.turnS ?? 0).toBe(0);
    expect(north.nominalS as number).toBeCloseTo((alone.byStepId["north"]?.nominalS as number) + expectedS, 9);
    expect(north.lowS as number).toBeCloseTo((north.nominalS as number) * 0.8, 9);
    expect(north.highS as number).toBeCloseTo((north.nominalS as number) * 1.2, 9);
  });

  it("does not count a literal-pose gap, which the ideal level drives across itself", () => {
    const result = timeOf([
      {
        id: "east",
        kind: "path",
        segments: [{ kind: "line", from: { xIn: 0, yIn: -60, headingRad: 0 }, to: { xIn: 30, yIn: -60 } }],
        heading: { mode: "tangent" },
      },
      {
        id: "elsewhere",
        kind: "path",
        segments: [{ kind: "line", from: { xIn: 40, yIn: -50 }, to: { xIn: 40, yIn: -20 } }],
        heading: { mode: "tangent" },
      },
    ]);
    expect(result.byStepId["elsewhere"]?.turnS ?? 0).toBe(0);
  });

  it("gives the shared helper's turn for two poses on the same spot, and none otherwise", () => {
    const limits = robotLimits(testRobot);
    expect(jointTurnS({ xIn: 0, yIn: 0, headingRad: 0 }, { xIn: 0, yIn: 0, headingRad: -Math.PI / 2 }, limits)).toBeCloseTo(
      Math.PI / 2 / limits.maxAngularVelRadPerS,
      12,
    );
    // The short way round: from just under pi to just over minus pi is a small turn.
    expect(jointTurnS({ xIn: 0, yIn: 0, headingRad: 3.1 }, { xIn: 0, yIn: 0, headingRad: -3.1 }, limits)).toBeCloseTo(
      (2 * Math.PI - 6.2) / limits.maxAngularVelRadPerS,
      12,
    );
    expect(jointTurnS({ xIn: 0, yIn: 0, headingRad: 0 }, { xIn: 0, yIn: 0, headingRad: 0.0005 }, limits)).toBe(0);
    expect(jointTurnS({ xIn: 0, yIn: 0, headingRad: 0 }, { xIn: 5, yIn: 0, headingRad: 1 }, limits)).toBe(0);
  });
});

describe("totalBound", () => {
  const base = { steps: [], nominalS: 1, lowS: 1, highS: 1, bandFraction: 0.2, assumptions: [], explain: [] };
  const row = (unknown: boolean, nominalS: number | null) =>
    ({ stepId: "s", kind: "path", nominalS, lowS: nominalS, highS: nominalS, strafeFraction: null, strafeCostS: null, unknown, exitVelocityInPerS: 0 }) satisfies StepEstimate;

  it("is null when every step is predicted", () => {
    expect(totalBound({ ...base, hasUnknown: false, byStepId: { a: row(false, 1) } })).toBeNull();
  });
  it("is an upper bound when a path ends on a condition", () => {
    expect(totalBound({ ...base, hasUnknown: true, byStepId: { a: row(true, 2) } })).toBe("upper");
  });
  it("is a lower bound when a step has no duration at all, even beside a condition-ended path", () => {
    expect(totalBound({ ...base, hasUnknown: true, byStepId: { a: row(true, 2), b: row(true, null) } })).toBe("lower");
  });
});

describe("sampleCapInPerS", () => {
  /**
   * The caps exactly as `profileSamples` computed them inline before they were factored out for the
   * optimizer's heading dynamic program. Kept here word for word, so the factored function is held
   * to the same floating-point operations in the same order and `estimate()` stays byte-identical.
   */
  const inline = (speedFraction: number, phiRad: number, headingRatePerIn: number, curvaturePerIn: number): number => {
    const limits = robotLimits(testRobot);
    let cap = speedFraction * velocityCapInPerS(limits, phiRad);
    if (headingRatePerIn > 1e-9) cap = Math.min(cap, limits.maxAngularVelRadPerS / headingRatePerIn);
    if (curvaturePerIn > 1e-9) cap = Math.min(cap, Math.sqrt(lateralAccelLimitInPerS2(limits) / curvaturePerIn));
    return cap;
  };

  it("is bit for bit the cap profileSamples computed inline, over a fixed grid", () => {
    const limits = robotLimits(testRobot);
    const fractions = [0.3, 0.8, 1];
    const phis = [-Math.PI, -2, -Math.PI / 2, -0.4, 0, 1e-10, 0.4, Math.PI / 2, 2.5, Math.PI];
    const rates = [0, 1e-10, 1e-9, 2e-9, 0.01, 0.1, 0.5, 3];
    for (const speedFraction of fractions) {
      for (const phiRad of phis) {
        for (const headingRatePerIn of rates) {
          for (const curvaturePerIn of rates) {
            const factored = sampleCapInPerS(limits, speedFraction, phiRad, headingRatePerIn, curvaturePerIn);
            expect(Object.is(factored, inline(speedFraction, phiRad, headingRatePerIn, curvaturePerIn))).toBe(true);
          }
        }
      }
    }
  });
});

/** Issue #374: the code review of main 1fb0d62 on the estimate and TIME_BUDGET. */
describe("issue #374", () => {
  const planOf = (steps: unknown[]) => plan(resolve(auto(steps), testWaypoints), testRobot, testField);
  const budget = (steps: unknown[]) => {
    const planned = planOf(steps);
    const result = estimate(planned, testRobot);
    return { result, planned, findings: checkTimeBudget(result, testField, flattenSteps(planned.steps)) };
  };
  const severities = (findings: readonly { severity: string; code: string }[]): string[] =>
    findings.filter((finding) => finding.code === "TIME_BUDGET").map((finding) => finding.severity);

  it("finding 1: a race ends by the timeout of a member that has no estimate", () => {
    const { result, findings } = budget([
      {
        id: "race",
        kind: "parallel",
        mode: "race",
        steps: [
          { id: "listen", kind: "wait", until: "hopperFull", timeoutS: 1 },
          { id: "long", kind: "wait", seconds: 60 },
        ],
      },
    ]);
    expect(result.steps[0]?.nominalS).toBe(1);
    expect(result.nominalS).toBe(1);
    expect(severities(findings)).not.toContain("error");
    expect(severities(findings)).not.toContain("warning");
  });

  it("finding 2: a branch arm with an unknown step keeps the time of its known steps", () => {
    const { result, findings } = budget([
      {
        id: "maybe",
        kind: "branch",
        condition: "hopperFull",
        then: [
          { id: "thenWait", kind: "wait", seconds: 40 },
          { id: "listen", kind: "wait", until: "hopperFull" },
        ],
        else: [{ id: "elseWait", kind: "wait", seconds: 40 }],
      },
    ]);
    expect(result.steps[0]?.nominalS).toBe(40);
    expect(result.steps[0]?.unknown).toBe(true);
    expect(result.nominalS).toBe(40);
    expect(severities(findings)).toContain("error");
  });

  it("finding 2: a branch with an unknown arm still costs the longer known arm", () => {
    const { result } = budget([
      {
        id: "maybe",
        kind: "branch",
        condition: "hopperFull",
        then: [{ id: "listen", kind: "wait", until: "hopperFull" }],
        else: [{ id: "elseWait", kind: "wait", seconds: 5 }],
      },
    ]);
    expect(result.steps[0]?.nominalS).toBe(5);
    expect(result.steps[0]?.unknown).toBe(true);
  });

  const collect = {
    id: "collect",
    kind: "path",
    segments: [{ kind: "line", from: { xIn: 0, yIn: -60, headingRad: 0 }, to: { xIn: 60, yIn: -60 } }],
    heading: { mode: "tangent" },
    endCondition: { condition: "hopperFull" },
  };

  it("finding 3: a path that ends on a condition is left out of the optimistic end", () => {
    const { result, findings } = budget([{ id: "pause", kind: "wait", seconds: 37 }, collect]);
    // The band's low end is over the period only because of the path, which may stop at once.
    expect(result.lowS as number).toBeGreaterThan(30);
    expect(37 * (1 - result.bandFraction)).toBeLessThan(30);
    expect(severities(findings)).toEqual(["warning", "info"]);
    const note = findings.find((finding) => finding.severity === "info");
    expect(note?.stepIds).toEqual(["collect"]);
    expect(note?.message).toContain("upper bound");
  });

  it("finding 3: the known steps alone over the optimistic end are still an error", () => {
    const { findings } = budget([{ id: "pause", kind: "wait", seconds: 40 }, collect]);
    const error = findings.find((finding) => finding.severity === "error");
    expect(error?.message).toContain("32.0 s");
    expect(severities(findings)).toEqual(["error", "info"]);
  });

  it("finding 3: without a condition path the optimistic end is the band's low end, as before", () => {
    const { result, findings } = budget([{ id: "pause", kind: "wait", seconds: 40 }]);
    expect(findings[0]?.message).toContain(`${(result.lowS as number).toFixed(1)} s`);
  });

  it("finding 4: a race that a known member caps is an upper bound, not a lower one", () => {
    const planned = planOf([
      {
        id: "race",
        kind: "parallel",
        mode: "race",
        steps: [
          { id: "pause", kind: "wait", seconds: 10 },
          { id: "listen", kind: "wait", until: "hopperFull" },
        ],
      },
    ]);
    const result = estimate(planned, testRobot);
    expect(result.nominalS).toBe(10);
    expect(totalBound(result, planned)).toBe("upper");
  });

  it("finding 4: a race that a member's timeout caps is an upper bound", () => {
    const planned = planOf([
      {
        id: "race",
        kind: "parallel",
        mode: "race",
        steps: [
          { id: "listen", kind: "wait", until: "hopperFull", timeoutS: 1 },
          { id: "pause", kind: "wait", seconds: 60 },
        ],
      },
    ]);
    expect(totalBound(estimate(planned, testRobot), planned)).toBe("upper");
  });

  it("finding 4: an open step outside a race keeps the total a lower bound", () => {
    const planned = planOf([
      { id: "listen", kind: "wait", until: "hopperFull" },
      {
        id: "race",
        kind: "parallel",
        mode: "race",
        steps: [
          { id: "pause", kind: "wait", seconds: 10 },
          { id: "other", kind: "wait", until: "hopperFull" },
        ],
      },
    ]);
    expect(totalBound(estimate(planned, testRobot), planned)).toBe("lower");
  });

  it("finding 5: a transition shorter than one profile interval takes time", () => {
    const limits = robotLimits(testRobot);
    const short = transitionProfile({ xIn: 0, yIn: 0, headingRad: 0 }, { xIn: 1, yIn: 0, headingRad: 0 }, limits);
    const shortS = short.timesS[short.timesS.length - 1] as number;
    // From rest to rest over 1 in: accelerate, then brake, never near the speed cap.
    const accel = limits.accelInPerS2;
    const decel = limits.forwardDecelInPerS2;
    const peak = Math.sqrt((2 * 1 * accel * decel) / (accel + decel));
    expect(shortS).toBeCloseTo(peak / accel + peak / decel, 9);
    expect(short.timesS[0]).toBe(0);
    const longer = transitionProfile({ xIn: 0, yIn: 0, headingRad: 0 }, { xIn: 3, yIn: 0, headingRad: 0 }, limits);
    expect(shortS).toBeLessThan(longer.timesS[longer.timesS.length - 1] as number);
  });

  it("finding 5: a transition's time is continuous across a multiple of the sample spacing", () => {
    const limits = robotLimits(testRobot);
    const accel = limits.accelInPerS2;
    const decel = limits.forwardDecelInPerS2;
    const closedForm = (lengthIn: number): number => {
      const peak = Math.sqrt((2 * lengthIn * accel * decel) / (accel + decel));
      return peak / accel + peak / decel;
    };
    const seconds = [2, 2.01, 2.5, 4].map((lengthIn) => {
      const profile = transitionProfile({ xIn: 0, yIn: 0, headingRad: 0 }, { xIn: lengthIn, yIn: 0, headingRad: 0 }, limits);
      return profile.timesS[profile.timesS.length - 1] as number;
    });
    for (let index = 1; index < seconds.length; index += 1) {
      expect(seconds[index] as number).toBeGreaterThan(seconds[index - 1] as number);
    }
    // Rest to rest over a few inches never nears the speed cap, so each is close to the triangle.
    [2, 2.01, 2.5, 4].forEach((lengthIn, index) => {
      expect(Math.abs((seconds[index] as number) - closedForm(lengthIn))).toBeLessThan(0.02 * closedForm(lengthIn));
    });
  });

  it("finding 5: a short transition that turns is held to the heading rate", () => {
    const limits = robotLimits(testRobot);
    const turning = transitionProfile({ xIn: 0, yIn: 0, headingRad: 0 }, { xIn: 1, yIn: 0, headingRad: Math.PI / 2 }, limits);
    const seconds = turning.timesS[turning.timesS.length - 1] as number;
    expect(seconds).toBeGreaterThanOrEqual(Math.PI / 2 / limits.maxAngularVelRadPerS - 1e-9);
  });
});
