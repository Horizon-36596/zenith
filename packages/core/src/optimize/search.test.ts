import { parseAuto, parseField, parseRobot, SCHEMA_ID, type Auto, type Field, type PathStep, type Robot } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { flattenSteps, plan } from "../plan.js";
import { resolve } from "../resolve.js";
import { testField, testRobot } from "../testing/fixtures.js";
import type { PlanSample } from "../types.js";
import { FINALIST_COUNT, OPTIMIZE_DEFAULT_BUDGET } from "./budget.js";
import { canonicalAuto, canonicalPathStep } from "./candidate.js";
import { PLANNED_PATH_ONLY_NOTE, type AcceptedRoute, type FinalVerdict } from "./final.js";
import { optimizeRoute, resolveOptimizeOptions, runOptimize, stepEndOverlap, type OptimizeOptions, type OptimizeResult } from "./index.js";
import { createObjective, TIME_EPSILON_S, type Evaluation, type ObjectiveInput } from "./objective.js";
import { oracleClearance } from "./oracle.test-helper.js";
import { checkFinalists, finalistOrder, jAtWeight, rankEntries, TIE_S, timeOf, type SearchEntry } from "./search.js";

/**
 * The search's contract (issue #302): over a corpus of fixtures (a post, a thin bar below the robot's
 * top, a bar above it, a keep-out, a start against the wall) at margins of 0, 1 and 3 in, every route
 * it returns passes a brute-force oracle written apart from `clearance.ts`, and none is slower than an
 * original that `check()` passes (a blocked one gets the fastest clear route, issue #388); a trap
 * returns `infeasible` with no step; an open-field straight line with a tangent heading is `noBetter`;
 * the result is deterministic, whatever the batch size, and a run the host stops is reproduced by a
 * budget of its evaluations; and the evaluations never pass the budget. Every fixture is a fixed value.
 */

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The test robot, 18 in long and 14 in wide, 12 in tall. */
const robot: Robot = parseRobot({ ...clone(testRobot), heightIn: { value: 12, provenance: "PLACEHOLDER: test fixture" } });

const fieldWith = (obstacles: unknown[], zones: unknown[] = []): Field => parseField({ ...clone(testField), obstacles, zones });

const box = (id: string, minX: number, maxX: number, minY: number, maxY: number, minZ = 0, maxZ = 10): Record<string, unknown> => ({
  id,
  kind: "box",
  minXIn: minX,
  maxXIn: maxX,
  minYIn: minY,
  maxYIn: maxY,
  minZIn: minZ,
  maxZIn: maxZ,
  solidToRobot: true,
  provenance: "PLACEHOLDER: test fixture",
});

const keepOut = (id: string, minX: number, maxX: number, minY: number, maxY: number): Record<string, unknown> => ({
  id,
  kind: "rect",
  minXIn: minX,
  maxXIn: maxX,
  minYIn: minY,
  maxYIn: maxY,
  appliesInAuto: true,
  provenance: "PLACEHOLDER: test fixture",
});

/** An auto with one path step `route` from `start` to `to`, and the segments and heading given. */
function autoOf(
  start: { xIn: number; yIn: number; headingRad: number },
  route: Record<string, unknown>,
  name = "search-fixture",
): Auto {
  return canonicalAuto(
    parseAuto({
      $schema: SCHEMA_ID.auto,
      formatVersion: 4,
      name,
      alliance: "RED",
      start: { pose: start },
      steps: [{ id: "route", kind: "path", ...route }],
    }),
  ).auto;
}

const START = { xIn: -48, yIn: 0, headingRad: 0 };
const END = { xIn: 48, yIn: 0 };

/** A slow detour north of the middle, which leaves room for a faster route. */
const detourRoute = {
  segments: [{ kind: "bezier", from: "current", control: [{ xIn: 0, yIn: 56 }], to: END }],
  heading: { mode: "constant", headingRad: 0 },
};
const detour = (): Auto => autoOf(START, detourRoute);

interface Fixture {
  name: string;
  field: Field;
  auto: Auto;
}

const corpus: Fixture[] = [
  { name: "a post", field: fieldWith([box("post", -4, 4, -3, 3)]), auto: detour() },
  { name: "a thin bar below the robot's top", field: fieldWith([box("bar", -0.5, 0.5, -15, 15, 0, 10)]), auto: detour() },
  { name: "a bar above the robot's top", field: fieldWith([box("highBar", -0.5, 0.5, -30, 30, 20, 30)]), auto: detour() },
  { name: "a keep-out", field: fieldWith([], [keepOut("lane", -6, 6, -10, 10)]), auto: detour() },
  {
    name: "a start against the wall",
    field: fieldWith([box("post", -4, 4, -66, -56)]),
    // The robot's side rides the south wall at y = -72.
    auto: autoOf(
      { xIn: -48, yIn: -65, headingRad: 0 },
      {
        segments: [{ kind: "bezier", from: "current", control: [{ xIn: 0, yIn: -10 }], to: { xIn: 48, yIn: -60 } }],
        heading: { mode: "constant", headingRad: 0 },
      },
    ),
  },
];

const inputOf = (fixture: Fixture): ObjectiveInput => ({ auto: fixture.auto, robot, field: fixture.field, stepId: "route" });

const BUDGET = 120;

const stepIn = (auto: Auto): PathStep => auto.steps[0] as PathStep;

/** The poses of the route's plan, followed every 0.1 in, for the oracle. */
function trackOf(auto: Auto, step: PathStep, field: Field): { xIn: number; yIn: number; headingRad: number }[] {
  const written = canonicalAuto({ ...auto, steps: [step, ...auto.steps.slice(1)] } as Auto).auto;
  const dense = plan(resolve(written, undefined, robot), robot, field, { sampleSpacingIn: 0.1 });
  return (flattenSteps(dense.steps).find((planned) => planned.id === "route")?.samples as PlanSample[]).map((sample) => sample.pose);
}

/** Every route a result offers: the pick and the alternatives. */
const routesOf = (result: OptimizeResult): PathStep[] => [
  ...(result.pick === null ? [] : [result.pick.step]),
  ...result.alternatives.map((route) => route.step),
];

describe("never colliding, never slower", () => {
  for (const fixture of corpus) {
    it(`passes the oracle on ${fixture.name} at margins 0, 1 and 3 in`, () => {
      let offered = 0;
      for (const marginIn of [0, 1, 3]) {
        const input = inputOf(fixture);
        const result = runOptimize(input, { marginIn, budget: BUDGET });
        expect(result.evaluations).toBeLessThanOrEqual(BUDGET);
        expect(["improved", "noBetter", "infeasible"]).toContain(result.status);
        expect(result.step === null).toBe(result.status !== "improved");
        const objective = createObjective(input, { marginIn });
        for (const route of [...(result.pick === null ? [] : [result.pick]), ...result.alternatives]) {
          offered += 1;
          const oracle = oracleClearance(trackOf(fixture.auto, route.step, fixture.field), robot, fixture.field, marginIn);
          expect(oracle.violation, `${fixture.name} at ${String(marginIn)} in: ${JSON.stringify(oracle.violation)}`).toBeNull();
          const poses = objective.simulatedPoses(route.step);
          for (const span of poses === null ? [] : [poses.path, poses.after]) {
            if (span.length === 0) continue;
            expect(oracleClearance(span.map((sample) => sample.pose), robot, fixture.field, marginIn).violation).toBeNull();
          }
        }
        // Never slower: the pick under both models, unless check() finds the original going through
        // something, when the fastest clear route may be slower (issue #388).
        const pick = result.pick;
        if (pick !== null && result.originalBlocked === null) {
          expect(pick.t0.after.windowEndS).toBeLessThanOrEqual(pick.t0.before.windowEndS + TIME_EPSILON_S);
          if (pick.t1 !== null) expect(pick.t1.after.windowEndS).toBeLessThanOrEqual(pick.t1.before.windowEndS + TIME_EPSILON_S);
        }
      }
      // The detours leave room for a faster route, so the oracle has something to judge.
      expect(offered).toBeGreaterThan(0);
    }, 240_000);
  }

  it("returns infeasible with no step on a trap", () => {
    // E sits inside a closed pen of walls; the original drives through the pen's west wall.
    const field = fieldWith([
      box("penWest", 20, 22, -20, 20),
      box("penEast", 74 - 2, 74, -20, 20),
      box("penSouth", 20, 74, -22, -20),
      box("penNorth", 20, 74, 20, 22),
    ]);
    const auto = autoOf(START, { segments: [{ kind: "line", from: "current", to: END }], heading: { mode: "constant", headingRad: 0 } });
    const result = runOptimize({ auto, robot, field, stepId: "route" }, { budget: BUDGET });
    expect(result.status).toBe("infeasible");
    expect(result.step).toBeNull();
    expect(result.pick).toBeNull();
    expect(result.closest).toMatchObject({ kind: "structure" });
  }, 120_000);

  it("refuses a step whose own end overlaps a structure", () => {
    const field = fieldWith([box("onEnd", 44, 52, -4, 4)]);
    const result = runOptimize({ auto: detour(), robot, field, stepId: "route" }, { budget: BUDGET });
    expect(result.status).toBe("infeasible");
    expect(result.step).toBeNull();
    expect(result.evaluations).toBe(0);
    expect(result.changes).toEqual(['The step\'s own end overlaps the structure "onEnd".']);
  });

  it("refuses a step whose own end overlaps a keep-out or the field wall, and names which", () => {
    const inKeepOut = runOptimize({ auto: detour(), robot, field: fieldWith([], [keepOut("onEnd", 44, 52, -4, 4)]), stepId: "route" }, { budget: BUDGET });
    expect(inKeepOut.status).toBe("infeasible");
    expect(inKeepOut.evaluations).toBe(0);
    expect(inKeepOut.changes).toEqual(['The step\'s own end overlaps the keep-out "onEnd".']);
    expect(inKeepOut.closest).toMatchObject({ step: null, kind: "keepOut", id: "onEnd" });

    // The robot is 18 in long, so ending at x = 70 facing +x puts its front 7 in past the wall at 72.
    const pastWall = autoOf(START, { segments: [{ kind: "line", from: "current", to: { xIn: 70, yIn: 0 } }], heading: { mode: "constant", headingRad: 0 } });
    const inWall = runOptimize({ auto: pastWall, robot, field: fieldWith([]), stepId: "route" }, { budget: BUDGET });
    expect(inWall.status).toBe("infeasible");
    expect(inWall.evaluations).toBe(0);
    expect(inWall.changes).toEqual(["The step's own end overlaps the field wall."]);
    expect(inWall.closest).toMatchObject({ step: null, kind: "wall", id: null });
  });

  it("says which end overlaps what without a run, as the run's own refusal does (stepEndOverlap)", () => {
    expect(stepEndOverlap({ auto: detour(), robot, field: fieldWith([box("onEnd", 44, 52, -4, 4)]), stepId: "route" })).toMatchObject({
      end: "end",
      kind: "structure",
      id: "onEnd",
    });
    expect(stepEndOverlap({ auto: detour(), robot, field: fieldWith([], [keepOut("onEnd", 44, 52, -4, 4)]), stepId: "route" })).toMatchObject({
      end: "end",
      kind: "keepOut",
      id: "onEnd",
    });
    expect(stepEndOverlap({ auto: detour(), robot, field: fieldWith([]), stepId: "route" })).toBeNull();
    expect(stepEndOverlap({ auto: detour(), robot, field: fieldWith([]), stepId: "notAStep" })).toBeNull();
  });

  it("returns no piecewise route without heading ranges, even from a piecewise original", () => {
    const auto = autoOf(START, {
      ...detourRoute,
      heading: {
        mode: "piecewise",
        ranges: [
          { startT: 0, endT: 0.5, heading: { mode: "constant", headingRad: 0 } },
          { startT: 0.5, endT: 1, heading: { mode: "linear", fromRad: 0, toRad: 0 } },
        ],
      },
    });
    const input = { auto, robot, field: fieldWith([]), stepId: "route" };
    // Searching route and heading, the open field has faster routes, none of them piecewise.
    const both = runOptimize(input, { budget: 40, allowRanges: false });
    expect(both.status).toBe("improved");
    expect(routesOf(both).length).toBeGreaterThan(0);
    for (const route of routesOf(both)) expect(route.heading?.mode).not.toBe("piecewise");
    // routeOnly keeps the heading as written, which is piecewise, so it has nothing to offer,
    // although with ranges allowed the same search finds a faster route.
    const routeOnly = runOptimize(input, { budget: 40, allowRanges: false, mode: "routeOnly" });
    expect(routeOnly.status).toBe("noBetter");
    expect(routesOf(routeOnly)).toEqual([]);
    const withRanges = runOptimize(input, { budget: 40, mode: "routeOnly" });
    expect(withRanges.status).toBe("improved");
    expect(withRanges.step?.heading?.mode).toBe("piecewise");
  }, 120_000);

  it("finds nothing better than an open-field straight line with a tangent heading", () => {
    const auto = autoOf(START, { segments: [{ kind: "line", from: "current", to: END }], heading: { mode: "tangent" } });
    const result = runOptimize({ auto, robot, field: fieldWith([]), stepId: "route" }, { budget: BUDGET });
    expect(result.status).toBe("noBetter");
    expect(result.step).toBeNull();
    expect(result.evaluations).toBeLessThanOrEqual(BUDGET);
  }, 120_000);
});

describe("determinism", () => {
  const fixture = corpus[0] as Fixture;
  const options: OptimizeOptions = { budget: 80 };

  it("gives deep-equal results on two runs", () => {
    const first = runOptimize(inputOf(fixture), options);
    const second = runOptimize(inputOf(fixture), options);
    expect(second).toStrictEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  }, 120_000);

  it("gives the same result drained one evaluation at a time and fifty at a time", () => {
    const one = runOptimize(inputOf(fixture), { ...options, batchSize: 1 });
    const fifty = runOptimize(inputOf(fixture), { ...options, batchSize: 50 });
    expect(fifty).toStrictEqual(one);
  }, 120_000);

  it("reproduces a run the host stopped with a budget of its evaluations", () => {
    const run = optimizeRoute(inputOf(fixture), { budget: 1150, batchSize: 1 });
    let next = run.next();
    let progressReports = 0;
    while (next.done !== true) {
      progressReports += 1;
      next = run.next(next.value.evaluations >= 70 ? { stop: true } : undefined);
    }
    const stopped = next.value;
    expect(progressReports).toBeGreaterThan(0);
    expect(stopped.status).toBe("stoppedEarly");
    expect(stopped.evaluations).toBe(70);
    // It stops with the fastest route found so far, which the budget-limited run finds too.
    expect(stopped.step).not.toBeNull();
    const again = runOptimize(inputOf(fixture), { budget: stopped.evaluations });
    expect(again.evaluations).toBe(70);
    const comparable = (result: OptimizeResult) => ({ ...result, status: null, budget: null, inputKey: null, notes: null });
    expect(comparable(again)).toStrictEqual(comparable(stopped));
  }, 120_000);

  it("keeps the seed it just scored when the host stops during the seeds", () => {
    // In an open field the straight line is among the first seeds, so a few evaluations already
    // find a faster route. A stop after each of them, all in the seed phase, finds what the budget does.
    const open: Fixture = { name: "an open field", field: fieldWith([]), auto: detour() };
    const found: number[] = [];
    for (const at of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const run = optimizeRoute(inputOf(open), { budget: 1150, batchSize: 1 });
      let next = run.next();
      while (next.done !== true) next = run.next(next.value.evaluations >= at ? { stop: true } : undefined);
      const stopped = next.value;
      expect(stopped.status).toBe("stoppedEarly");
      expect(stopped.evaluations).toBe(at);
      const again = runOptimize(inputOf(open), { budget: at });
      if (again.step !== null) found.push(at);
      // The status, and the sentence that says why there is no route, are the only differences.
      const comparable = (result: OptimizeResult) => ({ ...result, status: null, budget: null, inputKey: null, notes: null, changes: result.step === null ? null : result.changes });
      expect(comparable(stopped)).toStrictEqual(comparable(again));
      expect(stopped.step).toStrictEqual(again.step);
    }
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]).toBeLessThan(8);
  }, 120_000);

  it("matches the golden results on three fixture autos", () => {
    const golden = [corpus[0], corpus[3], corpus[4]].map((entry) => {
      const result = runOptimize(inputOf(entry as Fixture), { budget: 150 });
      return {
        fixture: (entry as Fixture).name,
        status: result.status,
        evaluations: result.evaluations,
        step: result.step,
        t0: result.pick?.t0 ?? null,
        t1: result.pick?.t1 ?? null,
        changes: result.changes,
        inputKey: result.inputKey,
      };
    });
    expect(golden).toMatchSnapshot();
  }, 120_000);
});

describe("the modes and the options", () => {
  const fixture = corpus[0] as Fixture;

  it("headingOnly keeps the segments as written", () => {
    const result = runOptimize(inputOf(fixture), { mode: "headingOnly", budget: BUDGET });
    expect(routesOf(result).length).toBeGreaterThan(0);
    for (const step of routesOf(result)) {
      expect(JSON.stringify(step.segments)).toBe(JSON.stringify(canonicalPathStep(stepIn(fixture.auto)).segments));
    }
    expect(result.mode).toBe("headingOnly");
  }, 120_000);

  it("routeOnly keeps the heading as written", () => {
    const result = runOptimize(inputOf(fixture), { mode: "routeOnly", budget: BUDGET });
    expect(routesOf(result).length).toBeGreaterThan(0);
    for (const step of routesOf(result)) {
      expect(step.heading).toStrictEqual(stepIn(fixture.auto).heading);
    }
  }, 120_000);

  it("keeps a route to one path when several are not allowed", () => {
    const result = runOptimize(inputOf(fixture), { allowSplit: false, budget: BUDGET });
    expect(routesOf(result).length).toBeGreaterThan(0);
    for (const step of routesOf(result)) expect(step.segments).toHaveLength(1);
  }, 120_000);

  describe("an original with more paths than allowed", () => {
    // Five lines over the post: the original as written has more paths than any limit below.
    const corners = [
      { xIn: -22, yIn: 13 },
      { xIn: -6, yIn: 13.5 },
      { xIn: 6, yIn: 13.5 },
      { xIn: 22, yIn: 13 },
      END,
    ];
    const fivePaths: Fixture = {
      name: "five lines over a post",
      field: fieldWith([box("post", -4, 4, -3, 3)]),
      auto: autoOf(START, {
        segments: corners.map((to) => ({ kind: "line", from: "current", to })),
        heading: { mode: "constant", headingRad: 0 },
      }),
    };

    // With four paths allowed the search finds nothing faster on this fixture, so there only the
    // progress reports are checked; the other two limits must offer a route to check.
    it.each([
      ["allowSplit false", { allowSplit: false }, 1, true],
      ["maxPaths 2", { maxPaths: 2 }, 2, true],
      ["the default maxPaths", {}, 4, false],
    ] as [string, OptimizeOptions, number, boolean][])("never offers a route of more paths than %s allows", (_label, options, limit, offers) => {
      expect(stepIn(fivePaths.auto).segments).toHaveLength(5);
      // No pass starts from the original, so the best the search reports is never a five-path route either.
      const run = optimizeRoute(inputOf(fivePaths), { ...options, budget: 200, batchSize: 1 });
      let next = run.next();
      while (next.done !== true) {
        if (next.value.bestStep !== undefined) expect(next.value.bestStep.segments.length).toBeLessThanOrEqual(limit);
        next = run.next();
      }
      const result = next.value;
      expect(result.status).not.toBe("stoppedEarly");
      if (offers) expect(routesOf(result).length).toBeGreaterThan(0);
      for (const step of routesOf(result)) expect(step.segments.length).toBeLessThanOrEqual(limit);
    }, 120_000);

    it("lets headingOnly keep the original's five paths, which it never changes", () => {
      // Driven sideways, the same five lines leave the heading something faster to find.
      const sideways: Fixture = {
        ...fivePaths,
        auto: autoOf(START, {
          segments: corners.map((to) => ({ kind: "line", from: "current", to })),
          heading: { mode: "constant", headingRad: Math.PI / 2 },
        }),
      };
      const result = runOptimize(inputOf(sideways), { mode: "headingOnly", allowSplit: false, budget: 200 });
      expect(routesOf(result).length).toBeGreaterThan(0);
      for (const step of routesOf(result)) {
        expect(JSON.stringify(step.segments)).toBe(JSON.stringify(canonicalPathStep(stepIn(sideways.auto)).segments));
      }
      expect(result.status).not.toBe("stoppedEarly");
    }, 120_000);
  });

  it("keeps the heading to one mode when ranges are not allowed", () => {
    const result = runOptimize(inputOf(fixture), { allowRanges: false, budget: BUDGET });
    expect(routesOf(result).length).toBeGreaterThan(0);
    for (const step of routesOf(result)) expect(step.heading?.mode).not.toBe("piecewise");
  }, 120_000);

  it("has no heading to optimize on a facePoint step", () => {
    const auto = autoOf(START, {
      segments: [{ kind: "line", from: "current", to: END }],
      heading: { mode: "facePoint", xIn: 0, yIn: 60 },
    });
    const result = runOptimize({ auto, robot, field: fieldWith([]), stepId: "route" }, { mode: "headingOnly" });
    expect(result.status).toBe("noBetter");
    expect(result.evaluations).toBe(0);
  });

  it("reads the robot's clearance for the margin, and refuses options it cannot run with", () => {
    const input = inputOf(fixture);
    expect(resolveOptimizeOptions(input).marginIn).toBe(1);
    expect(resolveOptimizeOptions(input).budget).toBe(OPTIMIZE_DEFAULT_BUDGET);
    expect(() => resolveOptimizeOptions(input, { budget: 0 })).toThrow(/budget/);
    expect(() => resolveOptimizeOptions(input, { marginIn: -1 })).toThrow(/margin/);
    expect(() => resolveOptimizeOptions(input, { maxPaths: 0 })).toThrow(/maxPaths/);
    expect(() => resolveOptimizeOptions(input, { allowTurnFirst: true as unknown as false })).toThrow(/D10/);
    expect(() => resolveOptimizeOptions(input, { mode: "everything" as unknown as OptimizeOptions["mode"] })).toThrow(/mode/);
    expect(() => resolveOptimizeOptions(input, { scorer: "guess" as unknown as OptimizeOptions["scorer"] })).toThrow(/scorer/);
    expect(() => resolveOptimizeOptions(input, { batchSize: 0 })).toThrow(/batch size/);
    expect(() => resolveOptimizeOptions(input, { batchSize: 2.5 })).toThrow(/batch size/);
    expect(resolveOptimizeOptions(input, { mode: "routeOnly", scorer: "estimate", batchSize: 1 })).toMatchObject({ mode: "routeOnly", scorer: "estimate" });
    expect(() => runOptimize({ ...input, stepId: "nothing" })).toThrow();
  });

  it("leaves the batch size out of the input key", () => {
    const input = inputOf(fixture);
    const one = runOptimize(input, { budget: 10, batchSize: 1 });
    const other = runOptimize(input, { budget: 11 });
    expect(one.inputKey).toMatch(/^[0-9a-f]{64}$/);
    expect(other.inputKey).not.toBe(one.inputKey);
  }, 120_000);
});

describe("the estimate as the scorer", () => {
  it("says how much faster in the estimate, with no sim sentence, and notes the planned path only", () => {
    const result = runOptimize(inputOf(corpus[0] as Fixture), { scorer: "estimate", budget: BUDGET });
    expect(result.scorer).toBe("estimate");
    expect(result.scorerReason).toBeNull();
    expect(result.status).toBe("improved");
    const pick = result.pick;
    if (pick === null) throw new Error("expected a faster route round the post");
    expect(pick.t1).toBeNull();
    expect(pick.changes[0]).toMatch(/^It is \d+\.\d\d s faster in the estimate\.$/);
    expect(pick.changes.join(" ")).not.toMatch(/instant sim/);
    expect(pick.note).toBe(PLANNED_PATH_ONLY_NOTE);
    expect(result.notes).toContain(PLANNED_PATH_ONLY_NOTE);
  }, 120_000);

  it("notes the planned path only on a run with nothing better, and not when the sim scored it", () => {
    const auto = autoOf(START, { segments: [{ kind: "line", from: "current", to: END }], heading: { mode: "tangent" } });
    const input: ObjectiveInput = { auto, robot, field: fieldWith([]), stepId: "route" };
    const estimated = runOptimize(input, { scorer: "estimate", budget: BUDGET });
    expect(estimated.status).toBe("noBetter");
    expect(estimated.notes).toContain(PLANNED_PATH_ONLY_NOTE);
    const simulated = runOptimize(input, { budget: BUDGET });
    expect(simulated.status).toBe("noBetter");
    expect(simulated.scorer).toBe("sim");
    expect(simulated.notes).not.toContain(PLANNED_PATH_ONLY_NOTE);
  }, 120_000);

  it("falls back to the estimate when the sim cannot run the routine, and says why in the notes", () => {
    // A wait past the end of the auto period: the sim's time runs out before the route is driven.
    const auto = canonicalAuto(
      parseAuto({
        $schema: SCHEMA_ID.auto,
        formatVersion: 4,
        name: "fallback",
        alliance: "RED",
        start: { pose: START },
        steps: [
          { id: "long", kind: "wait", seconds: 40 },
          { id: "route", kind: "path", ...detourRoute },
        ],
      }),
    ).auto;
    const result = runOptimize({ auto, robot, field: corpus[0]?.field as Field, stepId: "route" }, { budget: 20 });
    expect(result.scorer).toBe("estimate");
    expect(result.scorerReason).toMatch(/^Scored by the estimate: the instant sim could not run this routine \(.+\)\.$/);
    expect(result.notes).toContain(result.scorerReason);
  }, 120_000);
});

describe("finalist mode", () => {
  it("checks the estimate's best few first, re-ranked by the instant sim, and keeps the rest in order", () => {
    const fixture = corpus[0] as Fixture;
    const input = inputOf(fixture);
    const finalist = createObjective(input, { marginIn: 1, scorerMode: "finalist" });
    expect(finalist.finalist).toBe(true);
    const entries: SearchEntry[] = [56, 50, 44, 40, 36, 30].map((cy, index) => {
      const step = canonicalPathStep({
        ...stepIn(fixture.auto),
        segments: [{ kind: "bezier", from: "current", control: [{ xIn: 0, yIn: cy }], to: END }],
      });
      return { step, key: JSON.stringify(step), evaluation: finalist.evaluate(step), index, lineage: 0, original: false };
    });
    for (const entry of entries) expect(entry.evaluation.scoredBy).toBe("estimate");

    const ordered = finalistOrder(finalist, entries);
    expect(ordered).toHaveLength(entries.length);
    const byEstimate = [...entries].sort((a, b) => a.evaluation.j - b.evaluation.j || a.index - b.index).slice(0, FINALIST_COUNT);
    const head = ordered.slice(0, FINALIST_COUNT);
    expect(new Set(head)).toEqual(new Set(byEstimate));
    const simJ = head.map((entry) => finalist.evaluate(entry.step, { scoreWith: "sim" }).j);
    for (let i = 1; i < simJ.length; i += 1) expect(simJ[i] as number).toBeGreaterThanOrEqual(simJ[i - 1] as number);
    expect(ordered.slice(FINALIST_COUNT)).toEqual(entries.filter((entry) => !byEstimate.includes(entry)));

    // Outside finalist mode the order is kept as it is.
    const sim = createObjective(input, { marginIn: 1 });
    expect(sim.finalist).toBe(false);
    expect(finalistOrder(sim, entries)).toEqual(entries);
  }, 120_000);
});

describe("ranking and ties", () => {
  const evaluation = (time: number, units = 0): Evaluation =>
    ({
      status: "scored",
      reason: null,
      j: time + units,
      scoredBy: "sim",
      t0: null,
      t1: null,
      penalty: { clearance: units, simClearance: 0, mouthLeading: 0, sweepSpeed: 0, weightS: 1, totalS: units },
      penetrates: false,
      worst: null,
      simWorst: null,
      scored: null,
    }) as Evaluation;
  const entry = (index: number, time: number, step: Partial<PathStep>): SearchEntry => ({
    step: { id: "route", kind: "path", segments: [{ kind: "line", from: "current", to: END }], heading: { mode: "linear", fromRad: 0, toRad: 0 }, ...step } as PathStep,
    key: String(index),
    evaluation: evaluation(time),
    index,
    lineage: 0,
    original: false,
  });

  it("reweighs the penalty and reads the time apart from it", () => {
    const scored = evaluation(3, 0.5);
    expect(jAtWeight(scored, 1)).toBeCloseTo(3.5, 12);
    expect(jAtWeight(scored, 4)).toBeCloseTo(5, 12);
    expect(timeOf(scored)).toBeCloseTo(3, 12);
  });

  it("orders candidates within one sim tick by fewer paths, fewer ranges, lower degree, the D6 mode, then index", () => {
    const twoPaths = entry(0, 2.0, {
      segments: [
        { kind: "line", from: "current", to: { xIn: 0, yIn: 10 } },
        { kind: "line", from: "current", to: END },
      ],
    });
    const cubic = entry(1, 2.001, {
      segments: [{ kind: "bezier", from: "current", control: [{ xIn: 0, yIn: 1 }, { xIn: 1, yIn: 1 }], to: END }],
    });
    const lineTangent = entry(2, 2.002, { heading: { mode: "tangent" } });
    const lineLinear = entry(3, 2.003, {});
    const slower = entry(4, 2.0 + TIE_S + 0.001, {});
    const ranked = rankEntries([twoPaths, cubic, lineTangent, lineLinear, slower], (e) => timeOf(e.evaluation), "linear");
    expect(ranked.map((e) => e.index)).toEqual([3, 2, 1, 0, 4]);
  });

  describe("the final check of the finalists", () => {
    /** A final check that refuses the routes named and accepts the rest, and records what it was asked. */
    const checkOf = (refuse: readonly string[], gated: readonly string[] = []) => {
      const asked: string[] = [];
      const verify = (step: PathStep): FinalVerdict => {
        const name = step.id ?? "";
        asked.push(name);
        if (refuse.includes(name)) return { ok: false, failure: { step: 5, code: "sweptPlan", reason: "too close" } };
        return { ok: true, accepted: { step, fasterInSimOnly: gated.includes(name) } as unknown as AcceptedRoute };
      };
      return { asked, verify };
    };
    const named = (name: string, index: number, time: number, lineage: number, step: Partial<PathStep> = {}): SearchEntry => ({
      ...entry(index, time, { ...step, id: name }),
      lineage,
    });

    it("passes over the routes of a refused one's start within one sim tick, and checks the rest", () => {
      const ranked = [
        named("refused", 0, 3.0, 0),
        named("hairApart", 1, 3.0 + TIE_S / 2, 0),
        named("otherStart", 2, 3.0 + TIE_S / 2, 1),
        named("aTickOn", 3, 3.0 + TIE_S + 0.001, 0),
      ];
      const { asked, verify } = checkOf(["refused"]);
      const result = checkFinalists(ranked, verify, 12);
      expect(asked).toEqual(["refused", "otherStart", "aTickOn"]);
      expect(result.verified).toBe(3);
      expect(result.accepted.map((route) => route.step.id)).toEqual(["otherStart", "aTickOn"]);
    });

    it("still checks a route of the refused one's start with another number of paths", () => {
      // A structural move gives a start routes of another shape, which a refusal of one path does not speak for.
      const twoPaths = {
        segments: [
          { kind: "line", from: "current", to: { xIn: 0, yIn: 10 } },
          { kind: "line", from: "current", to: END },
        ],
      } as Partial<PathStep>;
      const ranked = [named("onePath", 0, 3.0, 0), named("twoPaths", 1, 3.0 + TIE_S / 2, 0, twoPaths)];
      const { asked, verify } = checkOf(["onePath"]);
      const result = checkFinalists(ranked, verify, 12);
      expect(asked).toEqual(["onePath", "twoPaths"]);
      expect(result.accepted.map((route) => route.step.id)).toEqual(["twoPaths"]);
    });

    it("keeps one plain and one gated route per start, and stops at the limit", () => {
      const ranked = [
        named("gated", 0, 3.0, 0),
        named("gatedAgain", 1, 3.1, 0),
        named("plain", 2, 3.2, 0),
        named("plainAgain", 3, 3.3, 0),
        named("otherStart", 4, 3.4, 1),
      ];
      const all = checkOf([], ["gated", "gatedAgain"]);
      const kept = checkFinalists(ranked, all.verify, 12);
      expect(all.asked).toEqual(["gated", "gatedAgain", "plain", "otherStart"]);
      expect(kept.accepted.map((route) => route.step.id)).toEqual(["gated", "plain", "otherStart"]);

      const limited = checkOf([], ["gated", "gatedAgain"]);
      expect(checkFinalists(ranked, limited.verify, 2).verified).toBe(2);
      expect(limited.asked).toEqual(["gated", "gatedAgain"]);
    });
  });
});
