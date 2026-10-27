import {
  parseAuto,
  parseWaypoints,
  SCHEMA_ID,
  type Auto,
  type HeadingRange,
  type PathStep,
  type Segment,
  type Step,
  type Waypoints,
} from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../canonicalize.js";
import { angleDelta, wrapAngle } from "../geometry/angle.js";
import { makePath } from "../geometry/path.js";
import type { Vec2 } from "../geometry/vec.js";
import { HALF_TURN_TOLERANCE_RAD, rangeHeadingFunction, rangeProblem } from "../heading.js";
import { MIN_RANGE_T } from "../headingRanges.js";
import { resolve, type ResolvedStep } from "../resolve.js";
import {
  autoWithRoute,
  canonicalAuto,
  canonicalPathStep,
  emitStep,
  emittedStepProblem,
  END_HEADING_TOLERANCE_RAD,
  G1_TOLERANCE_RAD,
  OPTIMIZER_PROVENANCE,
  routeEndsOf,
  type CandidatePath,
  type CandidateRange,
  type RouteCandidate,
  type RouteEnds,
} from "./candidate.js";

/**
 * The candidate tests build one small auto around the step under test: a lead-in path that leaves
 * the robot at (24, 0) facing +x, the step itself, and a path after it that starts from
 * `"current"`, so a test can see that every later step still starts where it did. Every case is a
 * fixed value; nothing is random.
 */

const waypoints: Waypoints = parseWaypoints({
  $schema: SCHEMA_ID.waypoints,
  formatVersion: 1,
  waypoints: {
    leave: { xIn: 24, yIn: 0, headingRad: 0, provenance: "SET BY HAND: test fixture" },
    goal: { xIn: 60, yIn: 30, headingRad: 2, provenance: "SET BY HAND: test fixture" },
  },
});

function autoAround(route: Record<string, unknown>): Auto {
  return parseAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 4,
    name: "candidate-fixture",
    alliance: "RED",
    start: { pose: { xIn: 0, yIn: 0, headingRad: 0 } },
    steps: [
      {
        id: "lead",
        kind: "path",
        segments: [{ kind: "line", from: "current", to: { xIn: 24, yIn: 0 } }],
        heading: { mode: "constant", headingRad: 0 },
      },
      { id: "route", ...route },
      {
        id: "after",
        kind: "path",
        segments: [{ kind: "line", from: "current", to: { xIn: 0, yIn: 60 } }],
        heading: { mode: "tangent" },
      },
    ],
  });
}

/** A route step that keeps every key of the keep list, so a test can see that none of them moves. */
const linearRoute = {
  kind: "path",
  timeoutS: 4.5,
  rejoinFrom: { xIn: 24, yIn: 0, headingRad: 0, provenance: "SET BY HAND: test fixture" },
  segments: [
    {
      kind: "bezier",
      from: "current",
      control: [{ xIn: 30, yIn: 30 }],
      to: { xIn: 48, yIn: 36, headingRad: 1, provenance: "SET FROM EDITOR" },
    },
  ],
  heading: { mode: "linear", fromRad: 0, toRad: 1.5708 },
  speedFraction: 0.7,
  markers: [
    { at: { t: 0.5 }, command: { name: "setIntake", args: { on: true } } },
    { at: { distanceFromEndIn: 6 }, command: { name: "setIntake", args: { on: false } } },
  ],
  endCondition: { condition: "hopperFull" },
  expect: { collectFrom: "spike", count: 3 },
  envelope: {
    polygon: [
      { xIn: 0, yIn: 0 },
      { xIn: 60, yIn: 0 },
      { xIn: 60, yIn: 60 },
    ],
    maxDurationS: 3,
    provenance: "SET BY HAND: test fixture",
  },
  notes: "Picks up the spike.",
};

/** A tangent route between two waypoints: E's heading is the curve's own end tangent (`headingForEnd`). */
const tangentRoute = {
  kind: "path",
  segments: [
    { kind: "bezier", from: { ref: "leave" }, control: [{ xIn: 40, yIn: -10 }, { xIn: 70, yIn: 10 }], to: { ref: "goal" } },
  ],
  heading: { mode: "tangent" },
};

const facePointRoute = {
  kind: "path",
  segments: [{ kind: "line", from: "current", to: { xIn: 48, yIn: 24 } }],
  heading: { mode: "facePoint", xIn: 0, yIn: 48, offsetRad: 0.25 },
};

/** Two segments, an interior pose with a heading of its own, and piecewise ranges. */
const chainRoute = {
  kind: "path",
  segments: [
    { kind: "line", from: "current", to: { xIn: 36, yIn: 12, headingRad: 0.5 } },
    { kind: "line", from: "current", to: { xIn: 48, yIn: 36 } },
  ],
  heading: {
    mode: "piecewise",
    ranges: [
      { startT: 0, endT: 0.5, heading: { mode: "linear", fromRad: 0, toRad: 0.5 } },
      { startT: 0.5, endT: 1, heading: { mode: "constant", headingRad: 0.5 } },
    ],
  },
};

const routeOf = (auto: Auto): PathStep => auto.steps[1] as PathStep;

function resolvedStep(auto: Auto, id: string): ResolvedStep {
  const found = resolve(auto, waypoints).steps.find((step) => step.id === id);
  if (found === undefined) throw new Error(`No step ${id}.`);
  return found;
}

const endsOf = (auto: Auto): RouteEnds => routeEndsOf(resolvedStep(auto, "route"));

function candidate(
  ends: RouteEnds,
  jointsIn: Vec2[],
  paths: CandidatePath[],
  ranges: CandidateRange[],
  tangentsRad?: number[],
): RouteCandidate {
  return {
    ends,
    jointsIn,
    tangentsRad: tangentsRad ?? Array.from({ length: paths.length + 1 }, () => 0),
    paths,
    heading: { mode: "ranges", ranges },
  };
}

function emitted(candidateValue: RouteCandidate, original: PathStep): PathStep {
  const result = emitStep(candidateValue, original);
  if (!result.ok) throw new Error(`Expected an emitted step, got: ${result.reason}`);
  return result.step;
}

const KEEP_KEYS = [
  "id",
  "kind",
  "timeoutS",
  "rejoinFrom",
  "speedFraction",
  "markers",
  "endCondition",
  "expect",
  "envelope",
  "notes",
] as const;

/** The control polygon of each emitted segment, with the route's own ends where the file names none. */
function polygons(step: PathStep, ends: RouteEnds): Vec2[][] {
  const result: Vec2[][] = [];
  let from = ends.startIn;
  for (const [index, segment] of step.segments.entries()) {
    const last = index === step.segments.length - 1;
    const to = last ? ends.endIn : (segment.to as Vec2);
    const control = segment.kind === "bezier" ? segment.control.map((point) => ({ xIn: point.xIn, yIn: point.yIn })) : [];
    result.push([from, ...control, { xIn: to.xIn, yIn: to.yIn }]);
    from = to;
  }
  return result;
}

/**
 * Every property the issue's "Done when" names, on one emitted step inside its auto: it parses, it
 * round-trips byte for byte, it keeps the keep list and both ends as written, its interior joints are
 * `"current"` and bare points, its ranges are valid, none is narrower than 0.02 or turns more than
 * half a turn, and resolve gives the original S and E.
 */
function expectGood(auto: Auto, step: PathStep): void {
  const original = routeOf(auto);
  const placed = autoWithRoute(auto, "route", step);
  expect(canonicalize("auto", placed.auto)).toBe(placed.text);
  expect(canonicalize("auto", parseAuto(JSON.parse(placed.text) as unknown))).toBe(placed.text);
  expect(canonicalPathStep(step)).toEqual(step);
  expect(routeOf(placed.auto)).toEqual(step);

  for (const key of KEEP_KEYS) expect(step[key]).toEqual(original[key]);
  expect(placed.auto.steps[0]).toEqual(auto.steps[0]);
  expect(placed.auto.steps[2]).toEqual(auto.steps[2]);

  const first = step.segments[0] as Segment;
  const last = step.segments[step.segments.length - 1] as Segment;
  expect(first.from).toEqual((original.segments[0] as Segment).from);
  expect(last.to).toEqual((original.segments[original.segments.length - 1] as Segment).to);
  for (const [index, segment] of step.segments.entries()) {
    if (index > 0) expect(segment.from).toBe("current");
    // An interior joint is a bare point the optimizer placed, labelled as such (issue #434).
    if (index < step.segments.length - 1) {
      expect(Object.keys(segment.to as object).sort()).toEqual(["provenance", "xIn", "yIn"]);
      expect((segment.to as { provenance?: string }).provenance).toBe(OPTIMIZER_PROVENANCE);
    }
    if (segment.kind === "bezier") for (const point of segment.control) expect(point.provenance).toBe(OPTIMIZER_PROVENANCE);
  }

  const heading = step.heading;
  expect(heading).toBeDefined();
  if (heading?.mode === "piecewise") {
    expect(rangeProblem(heading.ranges)).toBeNull();
    for (const range of heading.ranges) {
      expect(range.endT - range.startT).toBeGreaterThanOrEqual(MIN_RANGE_T - 1e-12);
      if (range.heading.mode === "linear") {
        expect(Math.abs(range.heading.toRad - range.heading.fromRad)).toBeLessThanOrEqual(Math.PI + HALF_TURN_TOLERANCE_RAD);
      }
    }
  }
  if (heading?.mode === "linear") {
    expect(Math.abs(heading.toRad - heading.fromRad)).toBeLessThanOrEqual(Math.PI + HALF_TURN_TOLERANCE_RAD);
  }

  const before = resolvedStep(auto, "route");
  const after = resolvedStep(placed.auto, "route");
  expect(after.startPose).toEqual(before.startPose);
  expect(after.endPose.xIn).toBe(before.endPose.xIn);
  expect(after.endPose.yIn).toBe(before.endPose.yIn);
  expect(Math.abs(angleDelta(before.endPose.headingRad, after.endPose.headingRad))).toBeLessThanOrEqual(1e-4);
  const nextBefore = resolvedStep(auto, "after");
  const nextAfter = resolvedStep(placed.auto, "after");
  expect(nextAfter.startPose.xIn).toBe(nextBefore.startPose.xIn);
  expect(nextAfter.startPose.yIn).toBe(nextBefore.startPose.yIn);
  expect(Math.abs(angleDelta(nextBefore.startPose.headingRad, nextAfter.startPose.headingRad))).toBeLessThanOrEqual(1e-4);
  expect(emittedStepProblem(step, routeEndsOf(before))).toBeNull();

  // The saved bytes are G1 at every joint that is not two lines meeting.
  const shape = polygons(step, routeEndsOf(before));
  for (let index = 1; index < shape.length; index += 1) {
    const before = shape[index - 1] as Vec2[];
    const after = shape[index] as Vec2[];
    if (before.length === 2 && after.length === 2) continue;
    const arriving = Math.atan2(
      (before[before.length - 1] as Vec2).yIn - (before[before.length - 2] as Vec2).yIn,
      (before[before.length - 1] as Vec2).xIn - (before[before.length - 2] as Vec2).xIn,
    );
    const leaving = Math.atan2((after[1] as Vec2).yIn - (after[0] as Vec2).yIn, (after[1] as Vec2).xIn - (after[0] as Vec2).xIn);
    expect(Math.abs(angleDelta(arriving, leaving))).toBeLessThanOrEqual(G1_TOLERANCE_RAD);
  }
}

describe("routeEndsOf on a step with no route", () => {
  const pose = { xIn: 0, yIn: 0, headingRad: 0 };
  it("throws for a step that is not a path", () => {
    const wait: ResolvedStep = { id: "rest", kind: "wait", step: { id: "rest", kind: "wait", seconds: 1 } as Step, startPose: pose, endPose: pose };
    expect(() => routeEndsOf(wait)).toThrow(/"rest" is not a path with segments/);
  });

  it("throws for a path with no segments", () => {
    const empty: ResolvedStep = {
      id: "bare",
      kind: "path",
      step: { id: "bare", kind: "path", segments: [] } as unknown as Step,
      startPose: pose,
      endPose: pose,
      segments: [],
    };
    expect(() => routeEndsOf(empty)).toThrow(/"bare" is not a path with segments/);
  });
});

describe("emittedStepProblem on a step emitStep would never write", () => {
  // Two lines through (36, 12) from (24, 0) to (48, 36), with a constant heading that is E's.
  const ends: RouteEnds = { startIn: { xIn: 24, yIn: 0 }, endIn: { xIn: 48, yIn: 36 }, arrivalHeadingRad: 0, endHeadingRad: 0 };
  const good = (): PathStep => ({
    kind: "path",
    segments: [
      { kind: "line", from: "current", to: { xIn: 36, yIn: 12 } },
      { kind: "line", from: "current", to: { xIn: 48, yIn: 36 } },
    ],
    heading: { mode: "constant", headingRad: 0 },
  });

  it("accepts the step it is varied from", () => {
    expect(emittedStepProblem(good(), ends)).toBeNull();
  });

  it("refuses an interior from that is not \"current\"", () => {
    const step = good();
    step.segments[1] = { kind: "line", from: { ref: "leave" }, to: { xIn: 48, yIn: 36 } };
    expect(emittedStepProblem(step, ends)).toBe('Path 2 must start from "current".');
  });

  const interiorTo: [string, Segment["to"]][] = [
    ["a ref", { ref: "goal" }],
    ['"current"', "current"],
    ["a point with a heading of its own", { xIn: 36, yIn: 12, headingRad: 0.5 }],
  ];
  for (const [name, to] of interiorTo) {
    it(`refuses an interior to that is ${name}`, () => {
      const step = good();
      step.segments[0] = { kind: "line", from: "current", to };
      expect(emittedStepProblem(step, ends)).toBe("Path 1 must end at a bare inline point, with no heading of its own.");
    });
  }

  it("refuses a step with no heading", () => {
    const step = good();
    delete step.heading;
    expect(emittedStepProblem(step, ends)).toBe("An emitted route must carry a heading.");
  });

  it("refuses a range that faces a point inside piecewise ranges", () => {
    // The last range faces (48, 100) from E at (48, 36), so h(1) is a quarter turn, E's heading here.
    const facing: RouteEnds = { ...ends, endHeadingRad: Math.PI / 2 };
    const step: PathStep = {
      ...good(),
      heading: {
        mode: "piecewise",
        ranges: [
          { startT: 0, endT: 0.5, heading: { mode: "constant", headingRad: 0 } },
          { startT: 0.5, endT: 1, heading: { mode: "facePoint", xIn: 48, yIn: 100 } },
        ],
      },
    };
    expect(emittedStepProblem(step, facing)).toBe("Range 2 faces a point, which the optimizer does not write.");
  });

  it("refuses a curve that meets the next path at a corner", () => {
    const step = good();
    // The curve arrives at (36, 12) heading straight up; the line leaves along atan2(24, 12).
    step.segments[0] = { kind: "bezier", from: "current", control: [{ xIn: 36, yIn: 6 }], to: { xIn: 36, yIn: 12 } };
    expect(emittedStepProblem(step, ends)).toMatch(/^Paths 1 and 2 meet at a corner of 0\.4636 rad/);
  });
});

describe("routeEndsOf", () => {
  it("reads the route's two ends and the headings S and E from the resolved step", () => {
    const auto = autoAround(tangentRoute);
    const ends = endsOf(auto);
    expect(ends.startIn).toEqual({ xIn: 24, yIn: 0 });
    expect(ends.endIn).toEqual({ xIn: 60, yIn: 30 });
    expect(ends.arrivalHeadingRad).toBe(0);
    // A tangent heading ends along the curve's last control leg, (70, 10) to (60, 30), not at the
    // waypoint's own 2 rad.
    expect(ends.endHeadingRad).toBeCloseTo(Math.atan2(20, -10), 9);
  });
});

/** A point as the optimizer writes it: with its provenance. */
const placed = (point: { xIn: number; yIn: number }): { xIn: number; yIn: number; provenance: string } => ({ ...point, provenance: OPTIMIZER_PROVENANCE });

describe("emitStep", () => {
  it("emits one line with one linear heading as plain modes, keeping both ends as written", () => {
    const auto = autoAround(linearRoute);
    const ends = endsOf(auto);
    const step = emitted(candidate(ends, [], [{ kind: "line" }], [{ mode: "linear", endT: 1 }]), routeOf(auto));
    expect(step.segments).toEqual([{ kind: "line", from: "current", to: { xIn: 48, yIn: 36, headingRad: 1, provenance: "SET FROM EDITOR" } }]);
    expect(step.heading).toEqual({ mode: "linear", fromRad: 0, toRad: 1.5708 });
    expectGood(auto, step);
  });

  it("writes interior from as current and interior to as a bare point, with G1 joints", () => {
    const auto = autoAround(linearRoute);
    const ends = endsOf(auto);
    // Line to (36, 0), a quadratic fillet to (48, 12) whose control is where the two lines meet,
    // then a cubic up to the end, leaving (48, 12) along +y because the line before it pins that.
    const step = emitted(
      candidate(
        ends,
        [
          { xIn: 36, yIn: 0 },
          { xIn: 48, yIn: 12 },
          { xIn: 48, yIn: 24 },
        ],
        [{ kind: "line" }, { kind: "quadratic" }, { kind: "line" }, { kind: "cubic", startHandleIn: 4, endHandleIn: 5 }],
        [{ mode: "linear", endT: 1 }],
        [0, 0, 0, 0, 0.25],
      ),
      routeOf(auto),
    );
    expect(step.segments).toEqual([
      { kind: "line", from: "current", to: placed({ xIn: 36, yIn: 0 }) },
      { kind: "bezier", from: "current", control: [placed({ xIn: 48, yIn: 0 })], to: placed({ xIn: 48, yIn: 12 }) },
      { kind: "line", from: "current", to: placed({ xIn: 48, yIn: 24 }) },
      {
        kind: "bezier",
        from: "current",
        control: [
          { xIn: 48, yIn: 28 },
          { xIn: 48 - 5 * Math.cos(0.25), yIn: 36 - 5 * Math.sin(0.25) },
        ].map((point) => placed({ xIn: Number(point.xIn.toFixed(3)), yIn: Number(point.yIn.toFixed(3)) })),
        to: { xIn: 48, yIn: 36, headingRad: 1, provenance: "SET FROM EDITOR" },
      },
    ]);
    // G1 at the joints between a curve and a line, to the canonical rounding.
    const path = makePath(polygons(step, ends));
    for (const index of [1, 2, 3]) {
      const before = (path.curves[index - 1] as (typeof path.curves)[number]).derivativeAt(1);
      const after = (path.curves[index] as (typeof path.curves)[number]).derivativeAt(0);
      const turn = angleDelta(Math.atan2(before.yIn, before.xIn), Math.atan2(after.yIn, after.xIn));
      expect(Math.abs(turn)).toBeLessThan(1e-3);
    }
    expectGood(auto, step);
  });

  it("writes a quadratic whose two tangents both run along its chord as a straight curve, its control midway", () => {
    const auto = autoAround(linearRoute);
    const ends = endsOf(auto);
    // From (24, 0) to (48, 36), leaving and arriving along the chord itself.
    const along = Math.atan2(36, 24);
    const step = emitted(candidate(ends, [], [{ kind: "quadratic" }], [{ mode: "linear", endT: 1 }], [along, along]), routeOf(auto));
    expect(step.segments).toEqual([
      {
        kind: "bezier",
        from: "current",
        control: [placed({ xIn: 36, yIn: 18 })],
        to: { xIn: 48, yIn: 36, headingRad: 1, provenance: "SET FROM EDITOR" },
      },
    ]);
    expectGood(auto, step);
    // Parallel tangents that run against the chord never meet.
    const backwards = emitStep(candidate(ends, [], [{ kind: "quadratic" }], [{ mode: "linear", endT: 1 }], [along + Math.PI, along + Math.PI]), routeOf(auto));
    expect(backwards.ok ? "" : backwards.reason).toMatch(/parallel and not along its chord/);
  });

  it("shares one tangent at a joint between two curves, and writes a quartic's middle control as given", () => {
    const auto = autoAround(linearRoute);
    const ends = endsOf(auto);
    const step = emitted(
      candidate(
        ends,
        [{ xIn: 36, yIn: 24 }],
        [
          { kind: "cubic", startHandleIn: 6, endHandleIn: 6 },
          { kind: "quartic", startHandleIn: 3, endHandleIn: 4, middleIn: { xIn: 44, yIn: 34 } },
        ],
        [{ mode: "linear", endT: 1 }],
        [0, Math.PI / 4, Math.PI / 2],
      ),
      routeOf(auto),
    );
    const [first, second] = step.segments as [Segment, Segment];
    const d = 6 * Math.SQRT1_2;
    expect(first).toEqual({
      kind: "bezier",
      from: "current",
      control: [placed({ xIn: 30, yIn: 0 }), placed({ xIn: Number((36 - d).toFixed(3)), yIn: Number((24 - d).toFixed(3)) })],
      to: placed({ xIn: 36, yIn: 24 }),
    });
    const e = 3 * Math.SQRT1_2;
    expect(second).toMatchObject({
      kind: "bezier",
      from: "current",
      control: [
        { xIn: Number((36 + e).toFixed(3)), yIn: Number((24 + e).toFixed(3)) },
        { xIn: 44, yIn: 34 },
        { xIn: 48, yIn: 32 },
      ],
    });
    expectGood(auto, step);
  });

  it("rounds the route to canonical form, so the step it returns is the step that is saved", () => {
    const auto = autoAround(linearRoute);
    const ends = endsOf(auto);
    const step = emitted(
      candidate(
        ends,
        [{ xIn: 36.00049, yIn: 12.123456 }],
        [{ kind: "line" }, { kind: "line" }],
        [
          { mode: "linear", endT: 0.333333, endHeadingRad: 0.123456789 },
          { mode: "linear", endT: 1 },
        ],
      ),
      routeOf(auto),
    );
    expect((step.segments[0] as Segment).to).toEqual(placed({ xIn: 36, yIn: 12.123 }));
    const heading = step.heading as Extract<PathStep["heading"], { mode: "piecewise" }>;
    expect(heading.ranges.map((range) => [range.startT, range.endT])).toEqual([
      [0, 0.3333],
      [0.3333, 1],
    ]);
    expect(heading.ranges[0]?.heading).toEqual({ mode: "linear", fromRad: 0, toRad: 0.1235 });
    expect(heading.ranges[1]?.heading).toEqual({ mode: "linear", fromRad: 0.1235, toRad: 1.5708 });
    expect(canonicalPathStep(step)).toEqual(step);
    expectGood(auto, step);
  });

  it("keeps the heading continuous across range boundaries: linear from the previous end, constant on it", () => {
    const auto = autoAround(linearRoute);
    const ends = endsOf(auto);
    const step = emitted(
      candidate(
        ends,
        [{ xIn: 36, yIn: 12 }],
        [{ kind: "line" }, { kind: "line" }],
        [
          { mode: "linear", endT: 0.3, endHeadingRad: 1 },
          { mode: "constant", endT: 0.6 },
          { mode: "linear", endT: 1 },
        ],
      ),
      routeOf(auto),
    );
    const ranges = (step.heading as { ranges: HeadingRange[] }).ranges;
    expect(ranges.map((range) => range.heading)).toEqual([
      { mode: "linear", fromRad: 0, toRad: 1 },
      { mode: "constant", headingRad: 1 },
      { mode: "linear", fromRad: 1, toRad: 1.5708 },
    ]);
    const path = makePath(polygons(step, ends));
    for (let index = 0; index + 1 < ranges.length; index += 1) {
      const range = ranges[index] as HeadingRange;
      const next = ranges[index + 1] as HeadingRange;
      const end = rangeHeadingFunction(range, path)(range.endT);
      const start = rangeHeadingFunction(next, path)(range.endT);
      expect(Math.abs(angleDelta(end, start))).toBeLessThanOrEqual(1e-4);
    }
    expectGood(auto, step);
  });

  it("pins a linear range that runs into a tangent range to the tangent at the boundary", () => {
    const auto = autoAround(linearRoute);
    const ends = endsOf(auto);
    // Leave along +x, then turn onto the second line's direction, which the tangent range follows
    // until a last linear range brings the robot round to E's heading.
    const step = emitted(
      candidate(
        ends,
        [{ xIn: 36, yIn: 0 }],
        [{ kind: "line" }, { kind: "line" }],
        [
          { mode: "linear", endT: 0.3, endHeadingRad: 3 },
          { mode: "tangent", endT: 0.8 },
          { mode: "linear", endT: 1 },
        ],
      ),
      routeOf(auto),
    );
    const ranges = (step.heading as { ranges: HeadingRange[] }).ranges;
    const along = Math.atan2(36, 12);
    expect(ranges[0]?.heading).toEqual({ mode: "linear", fromRad: 0, toRad: Number(along.toFixed(4)) });
    expect(ranges[1]?.heading).toEqual({ mode: "tangent" });
    expect(ranges[2]?.heading).toEqual({ mode: "linear", fromRad: Number(along.toFixed(4)), toRad: 1.5708 });
    expectGood(auto, step);
  });

  it("turns the short way to a knot, so no linear range turns more than half a turn", () => {
    const auto = autoAround(linearRoute);
    const ends = endsOf(auto);
    const step = emitted(
      candidate(
        ends,
        [{ xIn: 36, yIn: 12 }],
        [{ kind: "line" }, { kind: "line" }],
        [
          { mode: "linear", endT: 0.5, endHeadingRad: (3 * Math.PI) / 2 + 0.5 },
          { mode: "linear", endT: 1 },
        ],
      ),
      routeOf(auto),
    );
    // Three quarters of a turn and a bit, the long way, is a quarter turn less a bit the short way.
    const knot = Number((0.5 - Math.PI / 2).toFixed(4));
    const ranges = (step.heading as { ranges: HeadingRange[] }).ranges;
    expect(ranges[0]?.heading).toEqual({ mode: "linear", fromRad: 0, toRad: knot });
    expect(ranges[1]?.heading).toEqual({ mode: "linear", fromRad: knot, toRad: 1.5708 });
    expectGood(auto, step);
  });

  it("pins h(1) to E's heading for a tangent original whose end heading comes from headingForEnd", () => {
    const auto = autoAround(tangentRoute);
    const ends = endsOf(auto);
    const original = routeOf(auto);
    // A straight line has the wrong end tangent, so a linear last range carries the robot round.
    const straight = emitted(candidate(ends, [], [{ kind: "line" }], [{ mode: "linear", endT: 1 }]), original);
    expect(straight.heading).toEqual({ mode: "linear", fromRad: 0, toRad: Number(ends.endHeadingRad.toFixed(4)) });
    expectGood(auto, straight);

    // A cubic whose end tangent is E's heading may keep a tangent heading to the end.
    const curve = emitted(
      candidate(ends, [], [{ kind: "cubic", startHandleIn: 12, endHandleIn: 40 }], [{ mode: "tangent", endT: 1 }], [
        0,
        ends.endHeadingRad,
      ]),
      original,
    );
    expect(curve.heading).toEqual({ mode: "tangent" });
    expect(curve.segments).toMatchObject([{ kind: "bezier", from: { ref: "leave" }, to: { ref: "goal" } }]);
    expectGood(auto, curve);

    // A cubic that leaves along S's heading but ends along +x would end facing away from E: refused.
    const wrong = emitStep(
      candidate(ends, [], [{ kind: "cubic", startHandleIn: 12, endHandleIn: 12 }], [{ mode: "tangent", endT: 1 }], [0, 0]),
      original,
    );
    expect(wrong).toMatchObject({ ok: false });
    expect(wrong.ok ? "" : wrong.reason).toMatch(/E's heading/);
  });

  it("keeps a facePoint heading and changes only the geometry", () => {
    const auto = autoAround(facePointRoute);
    const ends = endsOf(auto);
    const original = routeOf(auto);
    const step = emitted(
      {
        ends,
        jointsIn: [{ xIn: 36, yIn: 6 }],
        tangentsRad: [0, 0.3, 0.6],
        paths: [
          { kind: "cubic", startHandleIn: 4, endHandleIn: 4 },
          { kind: "cubic", startHandleIn: 4, endHandleIn: 4 },
        ],
        heading: { mode: "facePoint" },
      },
      original,
    );
    expect(step.heading).toEqual(original.heading);
    expect(step.segments).toHaveLength(2);
    expectGood(auto, step);

    const ranges = emitStep(candidate(ends, [], [{ kind: "line" }], [{ mode: "linear", endT: 1 }]), original);
    expect(ranges.ok ? "" : ranges.reason).toMatch(/facePoint/);
    const other = autoAround(linearRoute);
    const faceOther = emitStep(
      { ...candidate(endsOf(other), [], [{ kind: "line" }], []), heading: { mode: "facePoint" } },
      routeOf(other),
    );
    expect(faceOther.ok ? "" : faceOther.reason).toMatch(/facePoint/);
  });

  it("replaces an original's interior headings and piecewise ranges with its own", () => {
    const auto = autoAround(chainRoute);
    const ends = endsOf(auto);
    const step = emitted(
      candidate(ends, [{ xIn: 40, yIn: 10 }], [{ kind: "line" }, { kind: "line" }], [
        { mode: "linear", endT: 0.5, endHeadingRad: 0.25 },
        { mode: "linear", endT: 1 },
      ]),
      routeOf(auto),
    );
    expect((step.segments[0] as Segment).to).toEqual(placed({ xIn: 40, yIn: 10 }));
    expectGood(auto, step);
  });

  describe("refuses a candidate it cannot write as the specs require", () => {
    const auto = autoAround(linearRoute);
    const ends = endsOf(auto);
    const original = routeOf(auto);
    const line = (ranges: CandidateRange[]): RouteCandidate => candidate(ends, [], [{ kind: "line" }], ranges);
    const cases: [string, RouteCandidate, RegExp][] = [
      ["no paths", candidate(ends, [], [], [{ mode: "linear", endT: 1 }]), /at least one path/],
      [
        "a joint count that does not match the paths",
        candidate(ends, [], [{ kind: "line" }, { kind: "line" }], [{ mode: "linear", endT: 1 }]),
        /joints/,
      ],
      [
        "a tangent count that does not match the paths",
        candidate(ends, [], [{ kind: "line" }], [{ mode: "linear", endT: 1 }], [0]),
        /tangents/,
      ],
      [
        "a path with no length",
        candidate(ends, [{ xIn: 24, yIn: 0.0001 }], [{ kind: "line" }, { kind: "line" }], [{ mode: "linear", endT: 1 }]),
        /no length/,
      ],
      [
        "a handle shorter than the canonical inch resolution",
        candidate(ends, [], [{ kind: "cubic", startHandleIn: 0, endHandleIn: 4 }], [{ mode: "linear", endT: 1 }]),
        /handle/,
      ],
      [
        "a quadratic whose tangents do not meet ahead of both ends",
        candidate(ends, [], [{ kind: "quadratic" }], [{ mode: "linear", endT: 1 }], [Math.PI, 0]),
        /quadratic/,
      ],
      ["no ranges", line([]), /at least one range/],
      ["a last range that does not end at 1", line([{ mode: "linear", endT: 0.9 }]), /end at 1/],
      [
        "a range narrower than 0.02",
        line([
          { mode: "linear", endT: 0.01, endHeadingRad: 0 },
          { mode: "linear", endT: 1 },
        ]),
        /0\.02/,
      ],
      [
        "ranges out of order",
        line([
          { mode: "linear", endT: 0.6, endHeadingRad: 0 },
          { mode: "linear", endT: 0.4, endHeadingRad: 0 },
          { mode: "linear", endT: 1 },
        ]),
        /0\.02|after its start/,
      ],
      [
        "a free knot with no heading",
        line([
          { mode: "linear", endT: 0.5 },
          { mode: "linear", endT: 1 },
        ]),
        /end heading/,
      ],
      [
        "a first tangent range off the arrival heading",
        candidate(ends, [{ xIn: 24, yIn: 24 }], [{ kind: "line" }, { kind: "line" }], [
          { mode: "tangent", endT: 0.5 },
          { mode: "linear", endT: 1 },
        ]),
        /arrives/,
      ],
      [
        "a tangent range that starts off the heading before it",
        line([
          { mode: "constant", endT: 0.5 },
          { mode: "tangent", endT: 0.8 },
          { mode: "linear", endT: 1 },
        ]),
        /range 2/i,
      ],
      ["a constant heading that is not E's", line([{ mode: "constant", endT: 1 }]), /E's heading/],
      [
        "a number that is not finite",
        candidate(ends, [{ xIn: Number.NaN, yIn: 0 }], [{ kind: "line" }, { kind: "line" }], [{ mode: "linear", endT: 1 }]),
        /finite/,
      ],
      [
        // A 0.002 in handle into (36, 12) along 0.3 rad rounds to arrive along 0.46 rad, while the
        // next path leaves along 0.3 rad: a corner the unrounded geometry does not have.
        "a handle so short that rounding bends the joint out of G1",
        candidate(
          ends,
          [{ xIn: 36, yIn: 12 }],
          [
            { kind: "cubic", startHandleIn: 4, endHandleIn: 0.002 },
            { kind: "cubic", startHandleIn: 5, endHandleIn: 4 },
          ],
          [{ mode: "linear", endT: 1 }],
          [0, 0.3, ends.endHeadingRad],
        ),
        /^Paths 1 and 2 meet at a corner/,
      ],
    ];
    for (const [name, value, reason] of cases) {
      it(name, () => {
        const result = emitStep(value, original);
        expect(result.ok).toBe(false);
        expect(result.ok ? "" : result.reason).toMatch(reason);
      });
    }

    it('an original whose last to is "current", since its end would move with the route', () => {
      const tail = autoAround({
        kind: "path",
        segments: [
          { kind: "line", from: "current", to: { xIn: 48, yIn: 0 } },
          { kind: "line", from: "current", to: "current" },
        ],
        heading: { mode: "constant", headingRad: 0 },
      });
      const result = emitStep(candidate(endsOf(tail), [], [{ kind: "line" }], [{ mode: "constant", endT: 1 }]), routeOf(tail));
      expect(result.ok ? "" : result.reason).toMatch(/"current"/);
    });
  });

  /**
   * The grid emits and checks every candidate, about two seconds on an idle machine. Late in `pnpm ship`'s
   * full run a laptop held to its sustained power limit runs it three or four times slower, past the
   * 5-second default. 30 seconds still catches a hang.
   */
  const GRID_TIMEOUT_MS = 30_000;
  it("obeys every rule for every candidate it emits, over a fixed grid of routes and heading profiles", () => {
    const originals = [linearRoute, tangentRoute, chainRoute];
    const pathSets: CandidatePath[][] = [
      [{ kind: "line" }, { kind: "line" }],
      [{ kind: "line" }, { kind: "cubic", startHandleIn: 6, endHandleIn: 3 }],
      [{ kind: "cubic", startHandleIn: 5, endHandleIn: 5 }, { kind: "quadratic" }],
      [
        { kind: "quartic", startHandleIn: 4, endHandleIn: 4, middleIn: { xIn: 30, yIn: 20 } },
        { kind: "cubic", startHandleIn: 2, endHandleIn: 20 },
      ],
    ];
    const joints: Vec2[] = [
      { xIn: 40, yIn: -6 },
      { xIn: 44.4444, yIn: 20.1234567 },
    ];
    const profiles: CandidateRange[][] = [
      [{ mode: "linear", endT: 1 }],
      [{ mode: "tangent", endT: 1 }],
      [
        { mode: "linear", endT: 0.25, endHeadingRad: 2.5 },
        { mode: "linear", endT: 1 },
      ],
      [
        { mode: "linear", endT: 0.2 },
        { mode: "tangent", endT: 0.7 },
        { mode: "linear", endT: 1 },
      ],
      [
        { mode: "linear", endT: 0.4, endHeadingRad: -2.9 },
        { mode: "constant", endT: 0.6 },
        { mode: "linear", endT: 0.75 },
        { mode: "tangentReversed", endT: 0.9 },
        { mode: "linear", endT: 1 },
      ],
      [
        { mode: "constant", endT: 0.5 },
        { mode: "linear", endT: 0.7, endHeadingRad: 4 },
        { mode: "linear", endT: 1 },
      ],
    ];
    let good = 0;
    let refused = 0;
    const written: number[] = profiles.map(() => 0);
    for (const route of originals) {
      const auto = autoAround(route);
      const ends = endsOf(auto);
      const original = routeOf(auto);
      for (const paths of pathSets) {
        for (const joint of joints) {
          for (const tangent of [-0.6, 1.2]) {
            for (const [profile, ranges] of profiles.entries()) {
              const result = emitStep(candidate(ends, [joint], paths, ranges, [0, tangent, ends.endHeadingRad]), original);
              if (!result.ok) {
                refused += 1;
                continue;
              }
              good += 1;
              written[profile] = (written[profile] ?? 0) + 1;
              expectGood(auto, result.step);
              const heading = result.step.heading;
              if (heading !== undefined && heading.mode !== "piecewise" && heading.mode !== "facePoint") {
                const path = makePath(polygons(result.step, ends));
                const range: HeadingRange = { startT: 0, endT: 1, heading };
                expect(Math.abs(angleDelta(rangeHeadingFunction(range, path)(1), ends.endHeadingRad))).toBeLessThanOrEqual(
                  END_HEADING_TOLERANCE_RAD,
                );
              }
            }
          }
        }
      }
    }
    // The grid is meant to exercise both answers: most of it is writable, every heading profile is
    // written at least once, and some candidates are refused.
    expect(good).toBeGreaterThan(150);
    expect(written.every((count) => count > 0)).toBe(true);
    expect(refused).toBeGreaterThan(0);
  }, GRID_TIMEOUT_MS);
});

describe("the canonical helpers", () => {
  it("canonicalAuto returns the parsed saved bytes, and autoWithRoute changes only the route", () => {
    const auto = autoAround(linearRoute);
    const once = canonicalAuto(auto);
    expect(once.text).toBe(canonicalize("auto", auto));
    expect(canonicalAuto(once.auto).text).toBe(once.text);

    const ends = endsOf(auto);
    const step = emitted(candidate(ends, [], [{ kind: "line" }], [{ mode: "linear", endT: 1 }]), routeOf(auto));
    const placed = autoWithRoute(auto, "route", step);
    const steps = (placed.auto.steps as Step[]).map((each) => each.id);
    expect(steps).toEqual(["lead", "route", "after"]);
    expect(placed.text).toContain('"kind": "line"');
  });

  it("canonicalPathStep rounds a step's numbers by the unit its keys name", () => {
    const step = canonicalPathStep({
      kind: "path",
      segments: [{ kind: "line", from: "current", to: { xIn: 1.23456, yIn: 2 } }],
      heading: { mode: "constant", headingRad: wrapAngle(0.123456) },
      timeoutS: 1.23456,
    });
    expect(step).toEqual({
      kind: "path",
      segments: [{ kind: "line", from: "current", to: { xIn: 1.235, yIn: 2 } }],
      heading: { mode: "constant", headingRad: 0.1235 },
      timeoutS: 1.235,
    });
  });
});
