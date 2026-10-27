import { parseAuto, parseRobot, SCHEMA_ID, type Auto, type PathStep, type Robot, type Step } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { estimate } from "../estimate.js";
import { flattenSteps, plan } from "../plan.js";
import { resolve } from "../resolve.js";
import { simulate } from "../sim/simulate.js";
import type { ConditionResolver, SimStepRecord } from "../sim/types.js";
import { testField, testRobot } from "../testing/fixtures.js";
import { canonicalAuto, canonicalPathStep } from "./candidate.js";
import {
  createObjective,
  OBJECTIVE_BARRIER_S,
  rerankFinalists,
  scoringWindowShape,
  type ObjectiveOptions,
  type ScoredCandidate,
} from "./objective.js";

/**
 * The objective's contract (issue #298): J of the original under the instant sim is the window's end in
 * a plain full simulation; a path off the critical path ranks by its own time; an endCondition is
 * scored to the end of the path and a timeout is a hard limit; a routine the sim cannot run falls back
 * to the estimate with a reason; and the penalty is 0 for a clear route and grows continuously into the
 * margin. Every fixture is a fixed value.
 */

/** The test robot with two mouths, an intake, a slow stationary command and one that moves the robot. */
const robot: Robot = parseRobot({
  ...(JSON.parse(JSON.stringify(testRobot)) as Record<string, unknown>),
  mouths: [
    { id: "front", side: "FRONT", offsetIn: { xIn: 8, yIn: 0 }, widthIn: 14, depthIn: 4, provenance: "PLACEHOLDER: test fixture" },
    { id: "back", side: "BACK", offsetIn: { xIn: -8, yIn: 0 }, widthIn: 14, depthIn: 4, provenance: "PLACEHOLDER: test fixture" },
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
    { name: "spin", estimateS: "3", stationary: true },
    { name: "blip", estimateS: "0.05", stationary: true },
    { name: "grab", estimateS: "1", requires: ["drive"], movesRobot: true },
  ],
  conditions: [{ name: "hopperFull" }],
});

/** The same robot with `holdEnd` off, so every step hands its speed on. */
const flowingRobot: Robot = parseRobot({
  ...(JSON.parse(JSON.stringify(robot)) as Record<string, unknown>),
  kinematics: {
    ...(JSON.parse(JSON.stringify(robot.kinematics)) as Record<string, unknown>),
    follower: { ...robot.kinematics.follower, holdEnd: false },
  },
});

const MARGIN: ObjectiveOptions = { marginIn: 1 };

const autoOf = (steps: unknown[], start = { xIn: -50, yIn: 30, headingRad: 0 }): Auto =>
  canonicalAuto(
    parseAuto({
      $schema: SCHEMA_ID.auto,
      formatVersion: 4,
      name: "objective-fixture",
      alliance: "RED",
      start: { pose: start },
      steps,
    }),
  ).auto;

const line = (id: string, xIn: number, yIn: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  kind: "path",
  segments: [{ kind: "line", from: "current", to: { xIn, yIn } }],
  heading: { mode: "tangent" },
  ...extra,
});

/** The lead-in, the route under test (from (-30, 30) to (30, 30)) and what follows it. */
const routeAuto = (after: unknown[], route: Record<string, unknown> = {}): Auto =>
  autoOf([line("lead", -30, 30), line("route", 30, 30, route), ...after]);

const planOf = (auto: Auto, r: Robot = robot) => plan(resolve(auto, undefined, r), r, testField);

const findStepIn = (auto: Auto, id: string): PathStep => {
  const found = flattenSteps(planOf(auto).steps).find((step) => step.id === id);
  if (found === undefined || found.step.kind !== "path") throw new Error(`no path ${id}`);
  return found.step;
};

/** The route bowed off its chord by `bowIn` through one control point, ends and heading kept. */
const bowed = (step: PathStep, bowIn: number): PathStep => {
  const [first] = step.segments;
  if (first === undefined) throw new Error("no segment");
  return canonicalPathStep({
    ...step,
    segments: [{ kind: "bezier", from: first.from, control: [{ xIn: 0, yIn: 30 + bowIn }], to: first.to }],
  });
};

const record = (records: readonly SimStepRecord[], id: string): SimStepRecord => {
  const found = records.find((r) => r.id === id);
  if (found === undefined) throw new Error(`no record ${id}`);
  return found;
};

const doneS = (r: SimStepRecord): number => r.settledS ?? r.endS;

describe("the scoring window", () => {
  it("holds the next step when it starts with a path, and only the step itself before a wait", () => {
    const auto = routeAuto([line("after", 30, -30), { id: "rest", kind: "wait", seconds: 0.5 }]);
    const planned = planOf(auto);
    expect(scoringWindowShape(planned, robot, "route")).toMatchObject({
      topIndex: 1,
      endIndex: 2,
      stepIds: ["route", "after"],
      includesNext: true,
      nested: false,
    });
    expect(scoringWindowShape(planned, robot, "after")).toMatchObject({ stepIds: ["after"], includesNext: false });
    // With holdEnd off every exit carries, so the wait joins the window.
    expect(scoringWindowShape(plan(resolve(auto), flowingRobot, testField), flowingRobot, "after")).toMatchObject({
      stepIds: ["after", "rest"],
      includesNext: true,
    });
  });

  it("starts at the enclosing top-level step for a path at any depth", () => {
    const auto = autoOf([
      line("lead", -30, 30),
      { id: "group", kind: "sequence", steps: [{ id: "tap", kind: "command", name: "blip" }, line("route", 30, 30)] },
      { id: "rest", kind: "wait", seconds: 0.5 },
    ]);
    expect(scoringWindowShape(planOf(auto), robot, "route")).toMatchObject({
      topIndex: 1,
      stepIds: ["group"],
      nested: true,
    });
  });

  it("refuses a step that is not a path", () => {
    const auto = routeAuto([{ id: "rest", kind: "wait", seconds: 0.5 }]);
    expect(() => scoringWindowShape(planOf(auto), robot, "rest")).toThrow(/only a path/);
    expect(() => scoringWindowShape(planOf(auto), robot, "nope")).toThrow(/No step/);
  });
});

describe("J under the instant sim", () => {
  const reference = (auto: Auto, id: string, r: Robot = robot, conditions?: ConditionResolver): number =>
    doneS(record(simulate(planOf(auto, r), r, testField, conditions === undefined ? {} : { conditions }).steps, id));

  it("equals the window's end in a full simulation, for the original, to within 1e-9 s", () => {
    const cases: { auto: Auto; stepId: string; last: string; r?: Robot }[] = [
      { auto: routeAuto([line("after", 30, -30), { id: "rest", kind: "wait", seconds: 0.5 }]), stepId: "route", last: "after" },
      { auto: routeAuto([line("after", 30, -30), { id: "rest", kind: "wait", seconds: 0.5 }]), stepId: "after", last: "after" },
      { auto: routeAuto([{ id: "rest", kind: "wait", seconds: 0.5 }]), stepId: "route", last: "route" },
      { auto: routeAuto([]), stepId: "route", last: "route" },
      {
        auto: routeAuto([line("after", 30, -30), { id: "rest", kind: "wait", seconds: 0.5 }]),
        stepId: "after",
        last: "rest",
        r: flowingRobot,
      },
      {
        auto: autoOf([
          line("lead", -30, 30),
          { id: "group", kind: "sequence", steps: [{ id: "tap", kind: "command", name: "blip" }, line("route", 30, 30)] },
          line("after", 30, -30),
        ]),
        stepId: "route",
        last: "after",
      },
    ];
    for (const { auto, stepId, last, r = robot } of cases) {
      const objective = createObjective({ auto, robot: r, field: testField, stepId }, MARGIN);
      expect(objective.scorer).toBe("sim");
      expect(objective.scoringWindow.stepIds[objective.scoringWindow.stepIds.length - 1]).toBe(last);
      const original = objective.original;
      expect(original.status).toBe("scored");
      expect(original.scoredBy).toBe("sim");
      expect(original.penalty.totalS).toBe(0);
      expect(Math.abs((original.t1?.windowEndS ?? NaN) - reference(auto, last, r))).toBeLessThan(1e-9);
      expect(Math.abs(original.j - reference(auto, last, r))).toBeLessThan(1e-9);
      // The estimate's window end is the routine's estimate through the window's last step.
      const estimated = estimate(planOf(auto, r), r);
      const through = estimated.steps.slice(0, objective.scoringWindow.endIndex + 1);
      expect(original.t0?.windowEndS).toBeCloseTo(through.reduce((sum, row) => sum + (row.nominalS ?? 0), 0), 12);
    }
  });

  it("scores a candidate by its own window, and is the same on every run", () => {
    const auto = routeAuto([line("after", 30, -30)]);
    const input = { auto, robot, field: testField, stepId: "route" };
    const objective = createObjective(input, MARGIN);
    const candidate = bowed(findStepIn(auto, "route"), 20);
    const scored = objective.evaluate(candidate);
    expect(scored.status).toBe("scored");
    expect(scored.scoredBy).toBe("sim");
    // A bowed route is longer, so it is slower than the straight original under both models.
    expect(scored.j).toBeGreaterThan(objective.original.j);
    expect(scored.t0?.windowEndS ?? 0).toBeGreaterThan(objective.original.t0?.windowEndS ?? Infinity);
    // The candidate's T1 is the full simulation of the auto with that route.
    const edited = scored.scored?.auto as Auto;
    expect(Math.abs((scored.t1?.windowEndS ?? NaN) - reference(edited, "after"))).toBeLessThan(1e-9);
    expect(createObjective(input, MARGIN).evaluate(candidate)).toEqual(scored);
  });

  it("hands the hard final check the sim's poses over the route and after it, and none under the estimate", () => {
    const auto = routeAuto([line("after", 30, -30)]);
    const objective = createObjective({ auto, robot, field: testField, stepId: "route" }, MARGIN);
    const poses = objective.simulatedPoses(objective.originalStep);
    expect(poses).not.toBeNull();
    // The route runs from (-30, 30) to (30, 30), and the path after it from there to (30, -30).
    const path = poses?.path ?? [];
    const after = poses?.after ?? [];
    expect(Math.abs((path[0]?.pose.xIn ?? NaN) + 30)).toBeLessThan(3);
    expect(Math.abs((path[path.length - 1]?.pose.xIn ?? NaN) - 30)).toBeLessThan(3);
    expect(after.length).toBeGreaterThan(0);
    expect(Math.abs((after[after.length - 1]?.pose.yIn ?? NaN) + 30)).toBeLessThan(3);
    // The two runs meet where the route is done, and the footprints are the robot's.
    expect(after[0]?.pose.xIn).toBeCloseTo(path[path.length - 1]?.pose.xIn ?? NaN, 6);
    expect(path[0]?.footprintIn).toHaveLength(4);

    // With nothing after the route in the window, there is no second run.
    const alone = createObjective({ auto: routeAuto([]), robot, field: testField, stepId: "route" }, MARGIN);
    expect(alone.simulatedPoses(alone.originalStep)?.after).toEqual([]);

    const estimated = createObjective({ auto, robot, field: testField, stepId: "route" }, { ...MARGIN, scorer: "estimate" });
    expect(estimated.simulatedPoses(estimated.originalStep)).toBeNull();
  });

  it("refuses a route that moves an end, without scoring it", () => {
    const auto = routeAuto([]);
    const objective = createObjective({ auto, robot, field: testField, stepId: "route" }, MARGIN);
    const original = findStepIn(auto, "route");
    const moved: PathStep = { ...original, segments: [{ kind: "line", from: "current", to: { xIn: 20, yIn: 30 } }] };
    const result = objective.evaluate(moved);
    expect(result.status).toBe("infeasible");
    expect(result.reason).toMatch(/keeps both ends/);
    expect(result.j).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("a path off the critical path", () => {
  const parallelAuto = (command: string): Auto =>
    autoOf([
      line("lead", -30, 30),
      {
        id: "together",
        kind: "parallel",
        mode: "all",
        steps: [line("route", 30, 30), { id: "work", kind: "command", name: command }],
      },
      { id: "rest", kind: "wait", seconds: 0.5 },
    ]);

  it("reports notCriticalPath inside a parallel that waits on a slower command, and ranks by the path's own time", () => {
    const auto = parallelAuto("spin");
    const objective = createObjective({ auto, robot, field: testField, stepId: "route" }, MARGIN);
    expect(objective.scoringWindow.notCriticalPath).toBe(true);
    expect(objective.scoringWindow.notes).toContain("This path is not on the critical path. Candidates are ranked by the path's own time.");

    const trace = simulate(planOf(auto), robot, testField);
    const path = record(trace.steps, "route");
    const original = objective.original;
    expect(Math.abs((original.t1?.ownS ?? NaN) - (doneS(path) - path.startS))).toBeLessThan(1e-9);
    expect(original.j).toBeCloseTo(original.t1?.ownS ?? NaN, 12);

    // A slower route leaves the window's end where the 3 s command puts it, and still ranks lower.
    const slower = objective.evaluate(bowed(findStepIn(auto, "route"), 15));
    expect(slower.t1?.windowEndS).toBeCloseTo(original.t1?.windowEndS ?? NaN, 9);
    expect(slower.t1?.ownS ?? 0).toBeGreaterThan(original.t1?.ownS ?? Infinity);
    expect(slower.j).toBeGreaterThan(original.j);

    // The estimate reads it the same way.
    const byEstimate = createObjective({ auto, robot, field: testField, stepId: "route" }, { ...MARGIN, scorer: "estimate" });
    expect(byEstimate.scoringWindow.notCriticalPath).toBe(true);
    expect(byEstimate.original.j).toBeCloseTo(estimate(planOf(auto), robot).byStepId["route"]?.nominalS ?? NaN, 12);
  });

  it("is on the critical path when the path is the slowest member", () => {
    const objective = createObjective({ auto: parallelAuto("blip"), robot, field: testField, stepId: "route" }, MARGIN);
    expect(objective.scoringWindow.notCriticalPath).toBe(false);
    expect(objective.original.j).toBeCloseTo(objective.original.t1?.windowEndS ?? NaN, 12);
  });

  it("is off the critical path in a deadline group whose deadline is another member", () => {
    const auto = autoOf([
      line("lead", -30, 30),
      {
        id: "together",
        kind: "parallel",
        mode: "deadline",
        deadline: "work",
        steps: [line("route", 30, 30), { id: "work", kind: "command", name: "blip" }],
      },
    ]);
    expect(createObjective({ auto, robot, field: testField, stepId: "route" }, MARGIN).scoringWindow.notCriticalPath).toBe(true);
  });
});

describe("endCondition and timeoutS", () => {
  it("scores a path that ends on a condition to the end of its path", () => {
    const withCondition = routeAuto([{ id: "rest", kind: "wait", seconds: 0.5 }], { endCondition: { condition: "hopperFull" } });
    const without = routeAuto([{ id: "rest", kind: "wait", seconds: 0.5 }]);
    // A resolver that would end the path a third of the way along: the objective overrides it.
    const early: ConditionResolver = (query) => (query.kind === "endCondition" ? 0.3 : undefined);
    const fires = record(simulate(planOf(withCondition), robot, testField, { conditions: early }).steps, "route");
    expect(fires.conditionFired).toBe(true);

    const objective = createObjective(
      { auto: withCondition, robot, field: testField, stepId: "route" },
      { ...MARGIN, conditions: early },
    );
    expect(objective.scoringWindow.endCondition).toBe(true);
    expect(objective.scoringWindow.notes.some((note) => note.includes("may end early"))).toBe(true);
    const plain = createObjective({ auto: without, robot, field: testField, stepId: "route" }, MARGIN);
    expect(Math.abs((objective.original.t1?.windowEndS ?? NaN) - (plain.original.t1?.windowEndS ?? NaN))).toBeLessThan(1e-9);
    expect(objective.original.t1?.windowEndS ?? 0).toBeGreaterThan(doneS(fires));
    // The estimate already drives the whole path for a step that ends on a condition.
    expect(objective.original.t0?.windowEndS).toBeCloseTo(plain.original.t0?.windowEndS ?? NaN, 12);
  });

  it("makes a candidate past the step's timeout infeasible", () => {
    const tight = routeAuto([{ id: "rest", kind: "wait", seconds: 0.5 }], { timeoutS: 0.5 });
    const objective = createObjective({ auto: tight, robot, field: testField, stepId: "route" }, MARGIN);
    expect(objective.scoringWindow.timeoutS).toBe(0.5);
    expect(objective.original.status).toBe("infeasible");
    expect(objective.original.reason).toMatch(/timeout/);
    expect(objective.original.j).toBeGreaterThan(OBJECTIVE_BARRIER_S);

    const roomy = routeAuto([{ id: "rest", kind: "wait", seconds: 0.5 }], { timeoutS: 10 });
    const fine = createObjective({ auto: roomy, robot, field: testField, stepId: "route" }, MARGIN);
    expect(fine.original.status).toBe("scored");
    // A candidate that would need longer than a timeout set just above the original is infeasible.
    const justAbove = Math.ceil(((fine.original.t0?.ownS ?? 0) + 0.05) * 100) / 100;
    const edge = routeAuto([{ id: "rest", kind: "wait", seconds: 0.5 }], { timeoutS: justAbove });
    const atEdge = createObjective({ auto: edge, robot, field: testField, stepId: "route" }, MARGIN);
    expect(atEdge.original.status).toBe("scored");
    expect(atEdge.evaluate(bowed(findStepIn(edge, "route"), 30)).status).toBe("infeasible");
  });

  it("makes a candidate infeasible when the instant sim runs past the timeout the estimate fits in", () => {
    // Wheels slow to respond make the sim's run of a long curve much slower than the estimate's.
    const sluggish: Robot = parseRobot({
      ...(JSON.parse(JSON.stringify(robot)) as Record<string, unknown>),
      kinematics: {
        ...(JSON.parse(JSON.stringify(robot.kinematics)) as Record<string, unknown>),
        drivetrain: { wheelResponseRatePerS: { value: 0.5, provenance: "PLACEHOLDER: test fixture" } },
      },
    });
    const timeoutS = 3;
    const auto = routeAuto([{ id: "rest", kind: "wait", seconds: 0.5 }], { timeoutS });
    const objective = createObjective({ auto, robot: sluggish, field: testField, stepId: "route" }, MARGIN);
    expect(objective.scorer).toBe("sim");
    expect(objective.original.status).toBe("scored");

    const curve = bowed(findStepIn(auto, "route"), 30);
    // Unlimited, the estimate fits the curve inside the timeout and the sim does not.
    const roomy = routeAuto([{ id: "rest", kind: "wait", seconds: 0.5 }], { timeoutS: 10 });
    const unlimited = createObjective({ auto: roomy, robot: sluggish, field: testField, stepId: "route" }, MARGIN).evaluate(
      bowed(findStepIn(roomy, "route"), 30),
    );
    expect(unlimited.t0?.ownS ?? Infinity).toBeLessThan(timeoutS);
    expect(unlimited.t1?.ownS ?? 0).toBeGreaterThan(timeoutS);

    const late = objective.evaluate(curve);
    expect(late.status).toBe("infeasible");
    expect(late.scoredBy).toBe("sim");
    expect(late.reason).toBe(`The route runs past the step's ${String(timeoutS)} s timeout in the instant sim.`);
    expect(late.t1).not.toBeNull();
    expect(late.j).toBeGreaterThan(OBJECTIVE_BARRIER_S);
  });

  it("makes a candidate infeasible when a later step of the window times out and did not before", () => {
    // The next step is a path, so it is in the window. A route that arrives moving the wrong way
    // makes it slower; without the rule its timeout would cut the window short and read as a gain.
    const withAfter = (extra: Record<string, unknown>): Auto => routeAuto([line("after", 30, -30, extra)]);
    const free = createObjective({ auto: withAfter({}), robot, field: testField, stepId: "route" }, MARGIN);
    const curve = (auto: Auto): PathStep => bowed(findStepIn(auto, "route"), -30);
    const afterOwn = (stepId: "route", auto: Auto, step: PathStep): number => {
      const scored = createObjective({ auto, robot, field: testField, stepId }, MARGIN).evaluate(step);
      const run = simulate(planOf(scored.scored?.auto as Auto), robot, testField);
      const after = record(run.steps, "after");
      return after.endS - after.startS;
    };
    const originalAfterS = afterOwn("route", withAfter({}), findStepIn(withAfter({}), "route"));
    const curveAfterS = afterOwn("route", withAfter({}), curve(withAfter({})));
    expect(curveAfterS - originalAfterS).toBeGreaterThan(0.1);
    expect(free.evaluate(curve(withAfter({}))).status).toBe("scored");

    // A timeout on the next step halfway between the two: the original fits, the curve does not.
    const timeoutS = Math.round(((originalAfterS + curveAfterS) / 2) * 100) / 100;
    const auto = withAfter({ timeoutS });
    const objective = createObjective({ auto, robot, field: testField, stepId: "route" }, MARGIN);
    expect(objective.scorer).toBe("sim");
    expect(objective.original.status).toBe("scored");
    const late = objective.evaluate(curve(auto));
    expect(late.status).toBe("infeasible");
    // The estimate carries the speed on as well, so it sees the timeout before the sim runs.
    expect(late.reason).toBe(`Step "after" runs past its ${String(timeoutS)} s timeout by the estimate with this route.`);
    expect(late.j).toBeGreaterThan(OBJECTIVE_BARRIER_S);
    // The instant sim's own run sees it too: the final check's sim poses refuse the route, since
    // its window is not the one the original runs.
    expect(objective.simulatedPoses(curve(auto))).toBeNull();
    expect(objective.simulatedPoses(objective.originalStep)).not.toBeNull();
  });

  it("makes a candidate infeasible when only the instant sim runs a later step past its timeout", () => {
    // Wheels slow to respond make the sim's runs slower than the estimate's, so the estimate fits.
    const sluggish: Robot = parseRobot({
      ...(JSON.parse(JSON.stringify(robot)) as Record<string, unknown>),
      kinematics: {
        ...(JSON.parse(JSON.stringify(robot.kinematics)) as Record<string, unknown>),
        drivetrain: { wheelResponseRatePerS: { value: 0.5, provenance: "PLACEHOLDER: test fixture" } },
      },
    });
    const withAfter = (extra: Record<string, unknown>): Auto => routeAuto([line("after", 30, -30, extra)]);
    const curve = (auto: Auto): PathStep => bowed(findStepIn(auto, "route"), -30);
    const afterTimes = (step: (auto: Auto) => PathStep): { simS: number; estimateS: number } => {
      const auto = withAfter({});
      const scored = createObjective({ auto, robot: sluggish, field: testField, stepId: "route" }, MARGIN).evaluate(step(auto));
      const planned = planOf(scored.scored?.auto as Auto, sluggish);
      const after = record(simulate(planned, sluggish, testField).steps, "after");
      return { simS: after.endS - after.startS, estimateS: estimate(planned, sluggish).byStepId["after"]?.nominalS ?? NaN };
    };
    const original = afterTimes((auto) => findStepIn(auto, "route"));
    const bent = afterTimes(curve);
    const timeoutS = Math.round(((original.simS + bent.simS) / 2) * 100) / 100;
    expect(timeoutS - original.simS).toBeGreaterThan(0.02);
    expect(bent.simS - timeoutS).toBeGreaterThan(0.02);
    expect(Math.max(original.estimateS, bent.estimateS)).toBeLessThan(timeoutS);

    const auto = withAfter({ timeoutS });
    const objective = createObjective({ auto, robot: sluggish, field: testField, stepId: "route" }, MARGIN);
    expect(objective.scorer).toBe("sim");
    expect(objective.original.status).toBe("scored");
    const late = objective.evaluate(curve(auto));
    expect(late.status).toBe("infeasible");
    expect(late.scoredBy).toBe("sim");
    expect(late.reason).toBe(`Step "after" runs past its ${String(timeoutS)} s timeout in the instant sim with this route.`);
    expect(late.j).toBeGreaterThan(OBJECTIVE_BARRIER_S);
    expect(objective.simulatedPoses(curve(auto))).toBeNull();
  });
});

describe("a candidate whose own run does not finish the window", () => {
  it("gets the barrier when the base run finishes inside the time and the candidate does not", () => {
    // How long the sim runs before the time runs out, read off a run that never finishes.
    const maxTimeS = simulate(planOf(autoOf([line("lead", -30, 30), { id: "long", kind: "wait", seconds: 60 }])), robot, testField).simTimeS;
    const withWait = (seconds: number): Auto => autoOf([line("lead", -30, 30), { id: "hold", kind: "wait", seconds }, line("route", 30, 30)]);

    // With a short wait, the original and a long bowed curve both finish, the curve later.
    const short = createObjective({ auto: withWait(1), robot, field: testField, stepId: "route" }, MARGIN);
    const curveShort = short.evaluate(bowed(findStepIn(withWait(1), "route"), 30));
    const baseEnd = short.original.t1?.windowEndS ?? NaN;
    const curveEnd = curveShort.t1?.windowEndS ?? NaN;
    expect(curveEnd - baseEnd).toBeGreaterThan(0.2);

    // A wait that puts the time limit halfway between the two ends.
    const seconds = Math.round((1 + maxTimeS - (baseEnd + curveEnd) / 2) * 100) / 100;
    const auto = withWait(seconds);
    const objective = createObjective({ auto, robot, field: testField, stepId: "route" }, MARGIN);
    expect(objective.scorer).toBe("sim");
    expect(objective.scorerReason).toBeNull();
    expect(objective.original.status).toBe("scored");

    const result = objective.evaluate(bowed(findStepIn(auto, "route"), 30));
    expect(result.status).toBe("barrier");
    expect(result.reason).toBe('The instant sim ran out of time before step "route" ended.');
    expect(result.scoredBy).toBe("estimate");
    expect(result.t1).toBeNull();
    expect(result.j).toBeGreaterThanOrEqual(OBJECTIVE_BARRIER_S + (result.t0?.windowEndS ?? NaN));
  });
});

describe("the fallback to the estimate", () => {
  const expectFallback = (auto: Auto, stepId: string, reason: RegExp): void => {
    const objective = createObjective({ auto, robot, field: testField, stepId }, MARGIN);
    expect(objective.scorer).toBe("estimate");
    expect(objective.searchScorer).toBe("estimate");
    expect(objective.scorerReason).toMatch(/^Scored by the estimate: the instant sim could not run this routine \(.+\)\.$/);
    expect(objective.scorerReason).toMatch(reason);
    expect(objective.original.scoredBy).toBe("estimate");
    expect(objective.original.t1).toBeNull();
    expect(objective.original.j).toBeCloseTo(objective.original.t0?.windowEndS ?? NaN, 12);
    // A request to score with the sim is still scored by the estimate.
    expect(objective.evaluate(objective.originalStep, { scoreWith: "sim" }).scoredBy).toBe("estimate");
  };

  it("uses the estimate, with a reason, for a routine with a command the sim does not drive", () => {
    const auto = autoOf([
      line("lead", -30, 30),
      { id: "pick", kind: "command", name: "grab" },
      line("route", 30, 30, { rejoinFrom: { xIn: -30, yIn: 30, headingRad: 0, provenance: "SET BY HAND: test fixture" } }),
    ]);
    expectFallback(auto, "route", /"pick" runs "grab", which moves the robot/);
  });

  it("uses the estimate when the time runs out before the window ends", () => {
    const auto = autoOf([line("lead", -30, 30), { id: "long", kind: "wait", seconds: 40 }, line("route", 30, 30)]);
    expectFallback(auto, "route", /time ran out before step "route" ended/);
  });

  it("uses the estimate when the sim never drives the path", () => {
    const auto = autoOf([
      line("lead", -30, 30),
      { id: "fork", kind: "branch", condition: "hopperFull", then: [line("other", -30, 0)], else: [line("route", 30, 30)] },
    ]);
    expectFallback(auto, "route", /never drives step "route", which is on a branch side/);
  });

  it("uses the estimate without a fallback sentence when Estimate is chosen", () => {
    const objective = createObjective(
      { auto: routeAuto([]), robot, field: testField, stepId: "route" },
      { ...MARGIN, scorer: "estimate" },
    );
    expect(objective.scorer).toBe("estimate");
    expect(objective.scorerReason).toBeNull();
    expect(objective.original.scoredBy).toBe("estimate");
  });
});

describe("finalist mode", () => {
  it("scores with the estimate and re-ranks the best by the instant sim", () => {
    const auto = routeAuto([line("after", 30, -30)]);
    const objective = createObjective(
      { auto, robot, field: testField, stepId: "route" },
      { ...MARGIN, scorerMode: "finalist" },
    );
    expect(objective.finalist).toBe(true);
    expect(objective.searchScorer).toBe("estimate");
    expect(objective.original.scoredBy).toBe("estimate");
    const original = findStepIn(auto, "route");
    const candidates: ScoredCandidate[] = [40, 0, 10, 25, 5].map((bow) => {
      const step = bow === 0 ? original : bowed(original, bow);
      return { step, evaluation: objective.evaluate(step) };
    });
    const finalists = rerankFinalists(objective, candidates);
    expect(finalists).toHaveLength(3);
    expect(finalists.every((f) => f.evaluation.scoredBy === "sim")).toBe(true);
    // The three best by the estimate are the straight route and the two smallest bows.
    const t0Best = [...candidates].sort((a, b) => a.evaluation.j - b.evaluation.j).slice(0, 3).map((c) => c.step);
    expect(new Set(finalists.map((f) => f.step))).toEqual(new Set(t0Best));
    for (let i = 1; i < finalists.length; i += 1) {
      expect((finalists[i] as ScoredCandidate).evaluation.j).toBeGreaterThanOrEqual((finalists[i - 1] as ScoredCandidate).evaluation.j);
    }
  });

  it("is off in the default mode the bench chose", () => {
    const objective = createObjective({ auto: routeAuto([]), robot, field: testField, stepId: "route" }, MARGIN);
    expect(objective.finalist).toBe(false);
    expect(objective.searchScorer).toBe("sim");
  });
});

describe("the penalty", () => {
  /**
   * A straight run past `hiveRedBase` (x -16.75 to -8.75, y -6 to 6, at floor level) at height y,
   * driven nose-on so the 14 in wide body's lower edge is at y - 7: its clearance to the box is
   * y - 13, and it reaches the 1 in margin at y = 14. Both ends are far from the box in x.
   */
  const passAt = (yIn: number, extra: Record<string, unknown> = {}): Auto =>
    autoOf(
      [
        line("lead", -40, yIn, { heading: { mode: "constant", headingRad: 0 } }),
        line("route", 20, yIn, { heading: { mode: "constant", headingRad: 0 }, ...extra }),
        { id: "rest", kind: "wait", seconds: 0.5 },
      ],
      { xIn: -55, yIn, headingRad: 0 },
    );
  const original = (yIn: number) => createObjective({ auto: passAt(yIn), robot, field: testField, stepId: "route" }, MARGIN).original;

  it("is 0 for a clear route, on the plan and on the sim's motion", () => {
    for (const y of [20, 16]) {
      const result = original(y);
      expect(result.penalty).toMatchObject({ clearance: 0, simClearance: 0, mouthLeading: 0, sweepSpeed: 0, totalS: 0 });
      expect(result.worst).toBeNull();
      expect(result.j).toBe(result.t1?.windowEndS);
    }
    expect(original(14).penalty.clearance).toBe(0);
  });

  it("grows continuously as the route moves into the margin", () => {
    const heights = [14, 13.999, 13.99, 13.9, 13.75, 13.5, 13.25, 13];
    const penalties = heights.map((y) => original(y).penalty.clearance);
    expect(penalties[0]).toBe(0);
    for (let i = 1; i < penalties.length; i += 1) expect(penalties[i] as number).toBeGreaterThan(penalties[i - 1] as number);
    // Continuous: a thousandth of an inch into the margin costs next to nothing.
    expect(penalties[1] as number).toBeLessThan(1e-4);
    // A squared hinge: the penalty per sample is the squared shortfall, the same at every sample alongside the box.
    const deep = original(13);
    expect(deep.worst).toMatchObject({ kind: "structure", id: "hiveRedBase" });
    expect(deep.worst?.shortfallIn).toBeCloseTo(1, 6);
    expect(deep.penalty.totalS).toBeGreaterThan(0);
    expect(deep.j).toBeCloseTo((deep.t1?.windowEndS ?? NaN) + deep.penalty.totalS, 12);
    // The sim's motion is measured as well, and is just as inside the margin.
    expect(deep.penalty.simClearance).toBeGreaterThan(0);
    expect(deep.penetrates).toBe(false);
  });

  it("scales with the weight the search passes", () => {
    const objective = createObjective({ auto: passAt(13.5), robot, field: testField, stepId: "route" }, MARGIN);
    const once = objective.evaluate(objective.originalStep);
    const twice = objective.evaluate(objective.originalStep, { penaltyWeightS: 2 });
    expect(twice.penalty.totalS).toBeCloseTo(2 * once.penalty.totalS, 12);
    expect(twice.j - once.j).toBeCloseTo(once.penalty.totalS, 12);
  });

  it("skips the sim for a route that penetrates, and scores it by the estimate plus the penalty", () => {
    const result = original(10);
    expect(result.penetrates).toBe(true);
    expect(result.scoredBy).toBe("estimate");
    expect(result.t1).toBeNull();
    expect(result.j).toBeCloseTo((result.t0?.windowEndS ?? NaN) + result.penalty.totalS, 12);
  });

  it("adds MOUTH_LEADING when the running mouth trails, and SWEEP_SPEED when the sweep is too fast", () => {
    const intake = { id: "intake", kind: "command", name: "setIntake", args: { side: "FRONT", state: "FORWARD" } };
    const sweepAuto = (heading: Record<string, unknown>, speedFraction: number): Auto =>
      autoOf([
        line("lead", -30, 30),
        intake,
        line("route", 30, 30, { heading, speedFraction }),
        { id: "rest", kind: "wait", seconds: 0.5 },
      ]);
    const score = (auto: Auto) => createObjective({ auto, robot, field: testField, stepId: "route" }, MARGIN).original;

    const leading = score(sweepAuto({ mode: "tangent" }, 0.3));
    expect(leading.penalty.mouthLeading).toBe(0);
    expect(leading.penalty.sweepSpeed).toBe(0);

    const trailing = score(sweepAuto({ mode: "constant", headingRad: Math.PI }, 0.3));
    expect(trailing.penalty.mouthLeading).toBeGreaterThan(0);
    // Each running stretch adds the square of how far past 30 degrees the mouth points: the front
    // mouth faces backwards, 180 degrees from the travel, so 150 degrees past the limit.
    const stretches = (planOf(sweepAuto({ mode: "constant", headingRad: Math.PI }, 0.3)).steps[2]?.samples.length ?? 0) - 1;
    expect(stretches).toBeGreaterThan(10);
    expect(trailing.penalty.mouthLeading / (stretches * ((5 * Math.PI) / 6) ** 2)).toBeCloseTo(1, 4);

    const fast = score(sweepAuto({ mode: "tangent" }, 0.9));
    expect(fast.penalty.sweepSpeed).toBeCloseTo((0.9 - 0.4) ** 2, 12);
  });
});

describe("the checks' own predicates", () => {
  it("leave MOUTH_LEADING and SWEEP_SPEED findings as they were", async () => {
    const { check } = await import("../check.js");
    const intake = (side: string): Step =>
      ({ id: `intake-${side}`, kind: "command", name: "setIntake", args: { side, state: "FORWARD" } }) as Step;
    const auto = autoOf([
      line("lead", -30, 30),
      intake("FRONT"),
      line("route", 30, 30, { heading: { mode: "constant", headingRad: Math.PI }, speedFraction: 0.9 }),
    ]);
    const planned = planOf(auto);
    const codes = check(planned, estimate(planned, robot), robot, testField).map((finding) => finding.code);
    expect(codes).toContain("MOUTH_LEADING");
    expect(codes).toContain("SWEEP_SPEED");
  });
});
