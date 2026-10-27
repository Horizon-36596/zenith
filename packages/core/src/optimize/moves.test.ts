import { parseAuto, parseField, parseRobot, SCHEMA_ID, type Auto, type Field, type PathStep, type Robot } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { intakeTimeline } from "../checks/intake.js";
import { makePath, type PathGeometry } from "../geometry/path.js";
import { headingFunction } from "../heading.js";
import { robotLimits } from "../kinematics.js";
import { plan } from "../plan.js";
import { resolve } from "../resolve.js";
import { makeSimCurve } from "../sim/curves.js";
import { parameterAtFraction } from "../sim/pedroPath.js";
import { testField, testRobot } from "../testing/fixtures.js";
import { canonicalAuto, emitStep, MIN_CANDIDATE_LENGTH_IN, routeEndsOf, stepGeometry, type CandidateRange, type RouteCandidate } from "./candidate.js";
import { optimizeRoute, resolveOptimizeOptions, runOptimize } from "./index.js";
import {
  candidateRangesOf,
  changeDegree,
  changeRangeMode,
  fitCubicHandles,
  mergeHeadingRanges,
  mergePaths,
  splitHeadingRange,
  splitPath,
  STRUCTURAL_MOVE_ORDER,
  structuralMoves,
  type MoveBase,
  type MoveOptions,
} from "./moves.js";
import { createObjective, TIME_EPSILON_S, type ObjectiveInput } from "./objective.js";
import { DEFAULT_BATCH_SIZE, DEFAULT_MAX_PATHS, keepsStructuralMove, searchRoutes, TIE_S, type SearchOutcome } from "./search.js";
import { END_TANGENT_HANDLE_FRACTION, originalGeometry } from "./seeds.js";
import type { OptimizeOptions } from "./types.js";

/**
 * The structural moves (issue #307): what each builds, the options that rule them out, their fixed
 * order, and D3: a split, and an exact change of degree, leave J as it was until the next continuous
 * pass moves something.
 */

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The test robot, 18 in long and 14 in wide, 12 in tall. */
const robot: Robot = parseRobot({ ...clone(testRobot), heightIn: { value: 12, provenance: "PLACEHOLDER: test fixture" } });
const openField: Field = parseField({ ...clone(testField), obstacles: [], zones: [] });

const START = { xIn: -48, yIn: 0, headingRad: 0 };
const END = { xIn: 48, yIn: 0 };

function autoOf(route: Record<string, unknown>, start: { xIn: number; yIn: number; headingRad: number } = START): Auto {
  return canonicalAuto(
    parseAuto({
      $schema: SCHEMA_ID.auto,
      formatVersion: 4,
      name: "moves-fixture",
      alliance: "RED",
      start: { pose: start },
      steps: [{ id: "route", kind: "path", ...route }],
    }),
  ).auto;
}

const line = (heading: Record<string, unknown>): Auto => autoOf({ segments: [{ kind: "line", from: "current", to: END }], heading });

const cubic = (heading: Record<string, unknown>): Auto =>
  autoOf({
    segments: [{ kind: "bezier", from: "current", control: [{ xIn: -20, yIn: 30 }, { xIn: 20, yIn: 30 }], to: END }],
    heading,
  });

const LINEAR_QUARTER_TURN = { mode: "linear", fromRad: 0, toRad: 1.5708 };

/** The candidate an auto's route is, with its heading as the candidate's own ranges, and the base the moves start from. */
function baseOf(auto: Auto): { base: MoveBase; original: PathStep } {
  const original = auto.steps[0] as PathStep;
  const resolved = resolve(auto, undefined, robot).steps[0];
  if (resolved === undefined) throw new Error("no step");
  const ends = routeEndsOf(resolved);
  const geometry = originalGeometry(resolved, 4);
  if (typeof geometry === "string") throw new Error(geometry);
  const ranges = candidateRangesOf(original.heading ?? { mode: "tangent" });
  const candidate: RouteCandidate = {
    ends,
    ...geometry,
    heading: ranges === null ? { mode: "facePoint" } : { mode: "ranges", ranges },
  };
  const emitted = emitStep(candidate, original);
  if (!emitted.ok) throw new Error(emitted.reason);
  const shape = stepGeometry(emitted.step, ends);
  if (typeof shape === "string") throw new Error(shape);
  return { base: { candidate, step: emitted.step, geometry: shape }, original };
}

function emitted(candidate: RouteCandidate | null, original: PathStep): PathStep {
  if (candidate === null) throw new Error("the move built nothing");
  const result = emitStep(candidate, original);
  if (!result.ok) throw new Error(result.reason);
  return result.step;
}

const geometryOf = (step: PathStep, base: MoveBase): PathGeometry => {
  const shape = stepGeometry(step, base.candidate.ends);
  if (typeof shape === "string") throw new Error(shape);
  return shape;
};

/** The largest distance between two routes, sampled at the same arc-length fractions. */
function largestGapIn(a: PathGeometry, b: PathGeometry): number {
  let worst = 0;
  for (let k = 0; k <= 200; k += 1) {
    const p = a.pointAtDistance((a.lengthIn * k) / 200);
    const q = b.pointAtDistance((b.lengthIn * k) / 200);
    worst = Math.max(worst, Math.hypot(p.xIn - q.xIn, p.yIn - q.yIn));
  }
  return worst;
}

const OPTIONS: MoveOptions = { mode: "routeAndHeading", maxPaths: 4, allowRanges: true };

/** A search of the slalom that reaches a split, with room over the fewest evaluations that do. */
const SPLIT_BUDGET = 800;

describe("move 1: split a path", () => {
  it("draws the curve the path drew, with the new joint at its arc-length midpoint", () => {
    const { base, original } = baseOf(cubic({ mode: "constant", headingRad: 0 }));
    const step = emitted(splitPath(base, 0, OPTIONS), original);
    expect(step.segments).toHaveLength(2);
    expect(step.segments[1]?.from).toBe("current");
    const after = geometryOf(step, base);
    // Rounding the joint and the controls to the file's 0.001 in is all that moves it.
    expect(largestGapIn(base.geometry, after)).toBeLessThan(0.01);
    expect(Math.abs((after.breaks[1] as number) - base.geometry.lengthIn / 2)).toBeLessThan(0.01);
  });

  it("splits a linear heading on the new joint at the heading the robot had there (D3)", () => {
    const { base, original } = baseOf(cubic(LINEAR_QUARTER_TURN));
    const step = emitted(splitPath(base, 0, OPTIONS), original);
    expect(step.heading?.mode).toBe("piecewise");
    const before = headingFunction(base.step.heading as NonNullable<PathStep["heading"]>, base.geometry);
    const after = headingFunction(step.heading as NonNullable<PathStep["heading"]>, geometryOf(step, base));
    for (let k = 0; k <= 50; k += 1) expect(Math.abs(after(k / 50) - before(k / 50))).toBeLessThan(2e-3);
  });

  it("keeps one heading range when ranges are not allowed, and builds nothing at maxPaths", () => {
    const { base } = baseOf(cubic(LINEAR_QUARTER_TURN));
    const single = splitPath(base, 0, { ...OPTIONS, allowRanges: false });
    expect(single?.heading).toStrictEqual(base.candidate.heading);
    expect(splitPath(base, 0, { ...OPTIONS, maxPaths: 1 })).toBeNull();
  });
});

describe("move 2: merge two paths", () => {
  it("fits one cubic over the two halves of a split, keeping both ends and their directions", () => {
    const { base, original } = baseOf(cubic({ mode: "constant", headingRad: 0 }));
    const split = emitted(splitPath(base, 0, OPTIONS), original);
    const splitBase: MoveBase = { candidate: splitPath(base, 0, OPTIONS) as RouteCandidate, step: split, geometry: geometryOf(split, base) };
    const merged = mergePaths(splitBase, 0);
    expect(merged?.paths).toHaveLength(1);
    expect(merged?.paths[0]?.kind).toBe("cubic");
    const step = emitted(merged, original);
    expect(step.segments).toHaveLength(1);
    expect(largestGapIn(base.geometry, geometryOf(step, base))).toBeLessThan(1);
    expect(mergePaths(base, 0)).toBeNull();
  });

  it("solves the least-squares handles exactly when the targets lie on such a cubic, and falls back where a handle would be too short", () => {
    const p0 = { xIn: 0, yIn: 0 };
    const p3 = { xIn: 30, yIn: 0 };
    const d0 = { xIn: 0, yIn: 1 };
    const d1 = { xIn: 0, yIn: -1 };
    const at = (s: number, a: number, b: number) => {
      const r = 1 - s;
      const c1 = { xIn: p0.xIn + a * d0.xIn, yIn: p0.yIn + a * d0.yIn };
      const c2 = { xIn: p3.xIn - b * d1.xIn, yIn: p3.yIn - b * d1.yIn };
      return {
        xIn: r * r * r * p0.xIn + 3 * r * r * s * c1.xIn + 3 * r * s * s * c2.xIn + s * s * s * p3.xIn,
        yIn: r * r * r * p0.yIn + 3 * r * r * s * c1.yIn + 3 * r * s * s * c2.yIn + s * s * s * p3.yIn,
      };
    };
    const params = [0.2, 0.4, 0.6, 0.8];
    const fit = fitCubicHandles(p0, p3, d0, d1, params, params.map((s) => at(s, 12, 7)));
    expect(fit.startHandleIn).toBeCloseTo(12, 9);
    expect(fit.endHandleIn).toBeCloseTo(7, 9);

    // A handle the fit makes negative, or shorter than a candidate allows, falls back to the chord over three.
    const chordThird = 30 * END_TANGENT_HANDLE_FRACTION;
    const backwards = fitCubicHandles(p0, p3, d0, d1, params, params.map((s) => at(s, -5, 7)));
    expect(backwards.startHandleIn).toBeCloseTo(chordThird, 12);
    expect(backwards.endHandleIn).toBeCloseTo(7, 9);
    const tiny = fitCubicHandles(p0, p3, d0, d1, params, params.map((s) => at(s, 12, MIN_CANDIDATE_LENGTH_IN / 2)));
    expect(tiny.startHandleIn).toBeCloseTo(12, 9);
    expect(tiny.endHandleIn).toBeCloseTo(chordThird, 12);
    // With nothing to fit, the normal equations are singular and both handles fall back.
    expect(fitCubicHandles(p0, p3, d0, d1, [], [])).toEqual({ startHandleIn: chordThird, endHandleIn: chordThird });
  });
});

describe("move 3: change a path's degree", () => {
  it("steps a cubic up to the quartic that draws the same curve, and down to the quadratic its tangents meet in", () => {
    const { base, original } = baseOf(cubic({ mode: "constant", headingRad: 0 }));
    const up = changeDegree(base, 0, "up");
    expect(up?.paths[0]?.kind).toBe("quartic");
    expect(largestGapIn(base.geometry, geometryOf(emitted(up, original), base))).toBeLessThan(0.01);
    const down = changeDegree(base, 0, "down");
    expect(down?.paths[0]?.kind).toBe("quadratic");
    // The tangents leave along (28, 30) and arrive along (28, -30), so they meet above the middle.
    expect(emitted(down, original).segments[0]).toMatchObject({ kind: "bezier", control: [{ xIn: 0, yIn: 51.429 }] });
  });

  it("steps a line up to a quadratic along it, and no further down", () => {
    const { base, original } = baseOf(line({ mode: "tangent" }));
    expect(changeDegree(base, 0, "down")).toBeNull();
    const up = emitted(changeDegree(base, 0, "up"), original);
    expect(up.segments[0]).toMatchObject({ kind: "bezier", control: [{ xIn: 0, yIn: 0 }] });
  });
});

describe("moves 4 to 6: heading ranges", () => {
  it("splits a linear range at its middle at the heading it has there, and nothing else", () => {
    const { base, original } = baseOf(line(LINEAR_QUARTER_TURN));
    const step = emitted(splitHeadingRange(base, 0), original);
    expect(step.heading).toStrictEqual({
      mode: "piecewise",
      ranges: [
        { startT: 0, endT: 0.5, heading: { mode: "linear", fromRad: 0, toRad: 0.7854 } },
        { startT: 0.5, endT: 1, heading: { mode: "linear", fromRad: 0.7854, toRad: 1.5708 } },
      ],
    });
    expect(splitHeadingRange(baseOf(line({ mode: "tangent" })).base, 0)).toBeNull();
  });

  describe("on a curve, where the runtime's chord table and exact arc length part", () => {
    // An asymmetric cubic: its 64-chord table puts a range end a little away from the point at that
    // exact arc-length fraction, so a knot read at the wrong one is off by about 5e-5 rad.
    const lopsided = (heading: Record<string, unknown>): Auto =>
      autoOf({
        segments: [{ kind: "bezier", from: "current", control: [{ xIn: -40, yIn: 60 }, { xIn: 40, yIn: 5 }], to: END }],
        heading,
      });
    /** The arc-length fraction of the point where the runtime puts a range end at t on a one-segment step. */
    const runtimePointT = (base: MoveBase, t: number): number => {
      const curve = base.geometry.curves[0];
      if (curve === undefined) throw new Error("no curve");
      const u = parameterAtFraction(makeSimCurve(curve.points.map((point) => ({ x: point.xIn, y: point.yIn }))), t);
      return curve.lengthAt(u) / base.geometry.lengthIn;
    };
    const knotsOf = (candidate: RouteCandidate | null): CandidateRange[] => {
      if (candidate === null || candidate.heading.mode !== "ranges") throw new Error("expected ranges");
      return [...candidate.heading.ranges];
    };

    it("splits a linear range with the knot at the heading where the runtime puts the new boundary", () => {
      const { base } = baseOf(lopsided(LINEAR_QUARTER_TURN));
      const before = headingFunction(base.step.heading as NonNullable<PathStep["heading"]>, base.geometry);
      const [first] = knotsOf(splitHeadingRange(base, 0));
      if (first?.mode !== "linear") throw new Error("expected a linear range");
      expect(first.endT).toBe(0.5);
      expect(Math.abs((first.endHeadingRad as number) - before(runtimePointT(base, 0.5)))).toBeLessThan(1e-9);
    });

    it("re-pins a knot to the heading where the runtime puts that range's end", () => {
      const { base } = baseOf(
        lopsided({
          mode: "piecewise",
          ranges: [
            { startT: 0, endT: 0.4, heading: { mode: "linear", fromRad: 0, toRad: 0.6 } },
            { startT: 0.4, endT: 1, heading: { mode: "linear", fromRad: 0.6, toRad: 1.5708 } },
          ],
        }),
      );
      const [first] = knotsOf(changeRangeMode(base, 1, "constant"));
      if (first?.mode !== "linear") throw new Error("expected a linear range");
      // The heading the robot has at the runtime's boundary is the file's own knot there.
      expect(Math.abs((first.endHeadingRad as number) - 0.6)).toBeLessThan(1e-9);
    });
  });

  it("merges two ranges into the first, and re-pins the knot a later range starts from", () => {
    const { base, original } = baseOf(
      line({
        mode: "piecewise",
        ranges: [
          { startT: 0, endT: 0.3, heading: { mode: "linear", fromRad: 0, toRad: 0.3 } },
          { startT: 0.3, endT: 0.6, heading: { mode: "linear", fromRad: 0.3, toRad: 0.9 } },
          { startT: 0.6, endT: 1, heading: { mode: "linear", fromRad: 0.9, toRad: 1.5708 } },
        ],
      }),
    );
    const step = emitted(mergeHeadingRanges(base, 0), original);
    expect(step.heading).toStrictEqual({
      mode: "piecewise",
      ranges: [
        { startT: 0, endT: 0.6, heading: { mode: "linear", fromRad: 0, toRad: 0.9 } },
        { startT: 0.6, endT: 1, heading: { mode: "linear", fromRad: 0.9, toRad: 1.5708 } },
      ],
    });
    expect(mergeHeadingRanges(base, 2)).toBeNull();
  });

  it("changes a range's mode with the knots re-pinned, and leaves the emitter to refuse a torn heading", () => {
    const { base, original } = baseOf(
      line({
        mode: "piecewise",
        ranges: [
          { startT: 0, endT: 0.5, heading: { mode: "tangent" } },
          { startT: 0.5, endT: 1, heading: { mode: "linear", fromRad: 0, toRad: 1.5708 } },
        ],
      }),
    );
    const constant = changeRangeMode(base, 0, "constant");
    expect((constant?.heading as { ranges: readonly CandidateRange[] }).ranges[0]).toStrictEqual({ mode: "constant", endT: 0.5 });
    expect(emitted(constant, original).heading).toMatchObject({ ranges: [{ heading: { mode: "constant", headingRad: 0 } }, {}] });
    // Tangent reversed faces backwards at t = 0, so the robot would have to turn on the spot.
    const reversed = changeRangeMode(base, 0, "tangentReversed");
    expect(reversed).not.toBeNull();
    expect(emitStep(reversed as RouteCandidate, original).ok).toBe(false);
    expect(changeRangeMode(base, 0, "tangent")).toBeNull();
  });
});

describe("the moves of a stalled candidate", () => {
  const rank = (kind: (typeof STRUCTURAL_MOVE_ORDER)[number]): number => STRUCTURAL_MOVE_ORDER.indexOf(kind);

  it("come in the fixed order of spec 16 section 6.3", () => {
    const { base } = baseOf(cubic(LINEAR_QUARTER_TURN));
    const moves = structuralMoves(base, OPTIONS);
    expect(moves.length).toBeGreaterThan(0);
    for (let k = 1; k < moves.length; k += 1) {
      expect(rank((moves[k] as { kind: (typeof STRUCTURAL_MOVE_ORDER)[number] }).kind)).toBeGreaterThanOrEqual(rank((moves[k - 1] as { kind: (typeof STRUCTURAL_MOVE_ORDER)[number] }).kind));
    }
    expect(new Set(moves.map((move) => move.kind))).toStrictEqual(new Set(["splitPath", "changeDegree", "splitRange", "changeRangeMode"]));
  });

  it("follow the mode and the options", () => {
    const { base } = baseOf(cubic(LINEAR_QUARTER_TURN));
    const kinds = (options: MoveOptions): string[] => [...new Set(structuralMoves(base, options).map((move) => move.kind))];
    expect(kinds({ ...OPTIONS, mode: "headingOnly" })).toStrictEqual(["splitRange", "changeRangeMode"]);
    expect(kinds({ ...OPTIONS, mode: "routeOnly" })).toStrictEqual(["splitPath", "changeDegree"]);
    expect(kinds({ ...OPTIONS, allowRanges: false })).not.toContain("splitRange");
    expect(kinds({ ...OPTIONS, maxPaths: 1 })).not.toContain("splitPath");
    for (const move of structuralMoves(base, { ...OPTIONS, maxPaths: 1 })) expect(move.candidate.paths.length).toBeLessThanOrEqual(1);
  });

  it("never give a facePoint step a heading of its own", () => {
    const { base } = baseOf(cubic({ mode: "facePoint", xIn: 0, yIn: 60 }));
    const moves = structuralMoves(base, OPTIONS);
    expect(moves.length).toBeGreaterThan(0);
    for (const move of moves) expect(move.candidate.heading).toStrictEqual({ mode: "facePoint" });
  });
});

describe("D3: a split leaves J as it was until the next continuous pass", () => {
  const objectiveOf = (auto: Auto, scorer: "sim" | "estimate") =>
    createObjective({ auto, robot, field: openField, stepId: "route" }, { marginIn: 1, scorer });

  for (const scorer of ["sim", "estimate"] as const) {
    it(`splitting a linear heading range leaves J unchanged under the ${scorer === "sim" ? "instant sim" : "estimate"}`, () => {
      for (const auto of [line(LINEAR_QUARTER_TURN), cubic(LINEAR_QUARTER_TURN)]) {
        const { base, original } = baseOf(auto);
        const objective = objectiveOf(auto, scorer);
        const before = objective.evaluate(base.step);
        const after = objective.evaluate(emitted(splitHeadingRange(base, 0), original));
        expect(Number.isFinite(before.j)).toBe(true);
        expect(Math.abs(after.j - before.j)).toBeLessThan(1e-9);
      }
    }, 60_000);

    it(`raising a path's degree leaves J unchanged under the ${scorer === "sim" ? "instant sim" : "estimate"}`, () => {
      for (const auto of [line({ mode: "tangent" }), cubic(LINEAR_QUARTER_TURN)]) {
        const { base, original } = baseOf(auto);
        const objective = objectiveOf(auto, scorer);
        const before = objective.evaluate(base.step);
        const after = objective.evaluate(emitted(changeDegree(base, 0, "up"), original));
        expect(Math.abs(after.j - before.j)).toBeLessThan(1e-9);
      }
    }, 60_000);
  }

  it("splitting a path leaves the estimate unchanged, its heading included", () => {
    for (const heading of [{ mode: "tangent" }, LINEAR_QUARTER_TURN, { mode: "constant", headingRad: 0 }]) {
      const auto = line(heading);
      const { base, original } = baseOf(auto);
      const objective = objectiveOf(auto, "estimate");
      const before = objective.evaluate(base.step);
      const after = objective.evaluate(emitted(splitPath(base, 0, OPTIONS), original));
      expect(Math.abs(after.j - before.j)).toBeLessThan(1e-9);
    }
  }, 60_000);
});

describe("the structural moves in the search", () => {
  const box = (id: string, minX: number, maxX: number, minY: number, maxY: number): Record<string, unknown> => ({
    id,
    kind: "box",
    minXIn: minX,
    maxXIn: maxX,
    minYIn: minY,
    maxYIn: maxY,
    minZIn: 0,
    maxZIn: 10,
    solidToRobot: true,
    provenance: "PLACEHOLDER: test fixture",
  });
  const corner = (xIn: number, yIn: number): Record<string, unknown> => ({ kind: "line", from: "current", to: { xIn, yIn } });

  // Two posts, one standing on the south wall and one hanging from the north wall, so the way
  // through goes north round the first and south round the second. The original drives it as four
  // straight lines with sharp corners.
  const posts: Field = parseField({
    ...clone(testField),
    obstacles: [box("postSouth", -22, -18, -72, 0), box("postNorth", 18, 22, 0, 72)],
    zones: [],
  });
  const slalom = autoOf(
    { segments: [corner(-40, 24), corner(0, 24), corner(0, -24), corner(56, 0)], heading: { mode: "constant", headingRad: 0 } },
    { xIn: -56, yIn: 0, headingRad: 0 },
  );

  it("goes round the posts with two or more paths, at least one tick faster than the best single path", () => {
    const input = { auto: slalom, robot, field: posts, stepId: "route" };
    const result = runOptimize(input);
    const single = runOptimize(input, { allowSplit: false });
    expect(result.status).toBe("improved");
    expect(result.scorer).toBe("sim");
    const pick = result.pick;
    if (pick === null || pick.t1 === null) throw new Error("expected a pick scored by the instant sim");
    expect(pick.step.segments.length).toBeGreaterThanOrEqual(2);
    expect(pick.step.segments.length).toBeLessThanOrEqual(DEFAULT_MAX_PATHS);
    for (const route of [single.pick, ...single.alternatives]) if (route !== null) expect(route.step.segments).toHaveLength(1);
    // The best single path: the one-path run's pick or, when it found none, nothing a tick faster than the original.
    const bestSingleS = single.pick?.t1?.after.windowEndS ?? pick.t1.before.windowEndS - TIE_S;
    expect(pick.t1.after.windowEndS).toBeLessThanOrEqual(bestSingleS - TIE_S + TIME_EPSILON_S);
  }, 120_000);

  // One test for each limit, so neither is a long synchronous block of its own and a failure names the limit.
  for (const maxPaths of [2, 3]) {
    it(`never offers a route of more than ${maxPaths} paths, nor reports one as the best so far`, () => {
      const run = optimizeRoute({ auto: slalom, robot, field: posts, stepId: "route" }, { maxPaths, batchSize: 1, budget: SPLIT_BUDGET });
      let next = run.next();
      while (next.done !== true) {
        if (next.value.bestStep !== undefined) expect(next.value.bestStep.segments.length).toBeLessThanOrEqual(maxPaths);
        next = run.next();
      }
      for (const route of [next.value.pick, ...next.value.alternatives]) {
        if (route !== null) expect(route.step.segments.length).toBeLessThanOrEqual(maxPaths);
      }
      // The limit is not met by never splitting: every seed the search starts from is one path, and
      // a split it kept gave a route of more than one path, within the limit. The search gets a budget
      // of its own, so the split is reached however the bench sets the default.
      const outcome = searchOf({ auto: slalom, robot, field: posts, stepId: "route" }, { maxPaths, budget: SPLIT_BUDGET });
      for (const seed of outcome.seeds) if (!seed.original) expect(seed.step.segments).toHaveLength(1);
      const splits = outcome.keptMoves.filter((move) => move.kind === "splitPath");
      expect(splits.length).toBeGreaterThan(0);
      for (const move of splits) {
        expect(move.step.segments.length).toBeGreaterThan(1);
        expect(move.step.segments.length).toBeLessThanOrEqual(maxPaths);
      }
    }, 120_000);
  }

  it("turns while braking with piecewise ranges that only the range moves build, faster than the best single range", () => {
    // The robot starts facing across the straight and must end facing the other way across it. A
    // half turn spread over the whole straight slows it all the way; turning early, driving
    // backwards, and turning the last quarter at the end while it brakes is faster. The heading
    // seeds already hold piecewise headings, so a piecewise result alone would not show the moves
    // at work: the test also asks for one whose sequence of range modes no seed has, which only a
    // split or a change of a range's mode can build, and for the kept move that led to it.
    const auto = autoOf(
      { segments: [{ kind: "line", from: "current", to: END }], heading: { mode: "linear", fromRad: 1.5708, toRad: -1.5708 } },
      { xIn: -48, yIn: 0, headingRad: 1.5708 },
    );
    const input = { auto, robot, field: openField, stepId: "route" };
    const result = runOptimize(input, { mode: "headingOnly" });
    const single = runOptimize(input, { mode: "headingOnly", allowRanges: false });
    expect(result.status).toBe("improved");
    const pick = result.pick;
    if (pick === null || pick.t1 === null) throw new Error("expected a pick scored by the instant sim");
    expect(pick.step.heading?.mode).toBe("piecewise");
    for (const route of [single.pick, ...single.alternatives]) if (route !== null) expect(route.step.heading?.mode).not.toBe("piecewise");
    const bestSingleS = single.pick?.t1?.after.windowEndS ?? pick.t1.before.windowEndS - TIE_S;
    expect(pick.t1.after.windowEndS).toBeLessThanOrEqual(bestSingleS - TIE_S + TIME_EPSILON_S);

    // A continuous pass moves a range's ends and headings but never adds a range or changes a
    // mode, so a pick whose modes no seed has came from a structural move.
    const modesOf = (step: PathStep): string => {
      const heading = step.heading as NonNullable<PathStep["heading"]>;
      return heading.mode === "piecewise" ? heading.ranges.map((range) => range.heading.mode).join(",") : heading.mode;
    };
    const outcome = searchOf(input, { mode: "headingOnly" });
    const seedModes = outcome.seeds.map((seed) => modesOf(seed.step));
    expect(seedModes).toContain("linear,tangentReversed,linear");
    expect(seedModes).not.toContain(modesOf(pick.step));
    // The pick is the route a kept range move led to, which nothing moved after it.
    const pickKey = JSON.stringify(pick.step);
    const kept = outcome.keptMoves.filter((move) => JSON.stringify(move.step) === pickKey);
    expect(kept.length).toBeGreaterThan(0);
    for (const move of kept) {
      expect(["splitRange", "changeRangeMode"]).toContain(move.kind);
      expect(move.afterJ).toBeLessThan(move.beforeJ);
    }
  }, 120_000);

  it("keeps a structural move only when the pass after it ends strictly lower in J", () => {
    // A route that clips a long wall, which splitting the path helps clear.
    const wall: Field = parseField({ ...clone(testField), obstacles: [box("wall", -4, 4, -72, 30)], zones: [] });
    const auto = autoOf(
      {
        segments: [{ kind: "bezier", from: "current", control: [{ xIn: -40, yIn: 60 }, { xIn: 40, yIn: 60 }], to: { xIn: 40, yIn: -40 } }],
        heading: { mode: "constant", headingRad: 0 },
      },
      { xIn: -40, yIn: -40, headingRad: 0 },
    );
    // The rule itself: a tie, or a pass that ends higher, keeps nothing.
    expect(keepsStructuralMove(2, 1.999)).toBe(true);
    expect(keepsStructuralMove(2, 2)).toBe(false);
    expect(keepsStructuralMove(2, 2.001)).toBe(false);

    // A budget of its own, so the moves are reached however the bench sets the default.
    const budget = 1150;
    const outcome = searchOf({ auto, robot, field: wall, stepId: "route" }, { budget });
    expect(outcome.keptMoves.length).toBeGreaterThan(0);
    for (const kept of outcome.keptMoves) {
      expect(STRUCTURAL_MOVE_ORDER).toContain(kept.kind);
      expect(kept.afterJ).toBeLessThan(kept.beforeJ);
    }
    expect(outcome.evaluations).toBeLessThanOrEqual(budget);
    for (const entry of outcome.ranked) expect(entry.step.segments.length).toBeLessThanOrEqual(DEFAULT_MAX_PATHS);
  }, 120_000);
});

/** The search itself, run to the end with the settings a run with these options uses, for what the result does not report. */
function searchOf(input: ObjectiveInput, options: OptimizeOptions = {}): SearchOutcome {
  const settings = resolveOptimizeOptions(input, options);
  const objective = createObjective(input, { marginIn: settings.marginIn });
  const resolvedAuto = resolve(canonicalAuto(input.auto).auto, undefined, input.robot);
  const resolved = resolvedAuto.steps.find((step) => step.id === input.stepId);
  if (resolved === undefined) throw new Error("no step");
  const run = searchRoutes({
    objective,
    resolved,
    original: objective.originalStep,
    originalGeometry: makePath((resolved.segments ?? []).map((segment) => segment.pointsIn)),
    ends: routeEndsOf(resolved),
    robot: input.robot,
    field: input.field,
    running: intakeTimeline(plan(resolvedAuto, input.robot, input.field).steps, input.robot).byStepId.get(input.stepId),
    speedFraction: robotLimits(input.robot).defaultPathSpeedFraction,
    mode: settings.mode,
    maxPaths: settings.maxPaths,
    allowRanges: settings.allowRanges,
    defaultHeadingMode: settings.defaultHeadingMode,
    budget: settings.budget,
    batchSize: DEFAULT_BATCH_SIZE,
  });
  let next = run.next();
  while (next.done !== true) next = run.next();
  return next.value;
}
