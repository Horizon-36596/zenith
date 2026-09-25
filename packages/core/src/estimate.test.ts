import { parseAuto, parseRobot, SCHEMA_ID, type Auto } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { commandSeconds, estimate, totalBound } from "./estimate.js";
import { plan } from "./plan.js";
import { resolve } from "./resolve.js";
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
    // The cost in seconds is the difference against the same leg driven nose-first.
    expect(sideways.steps[0]?.strafeCostS as number).toBeCloseTo(
      (sideways.nominalS as number) - (tangent.nominalS as number),
      6,
    );
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
