import { parseAuto, SCHEMA_ID, type Auto, type Heading, type HeadingRange } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { check } from "./check.js";
import { estimate } from "./estimate.js";
import { makePath } from "./geometry/path.js";
import { headingAtT, rangeIndexAt, rangeProblem } from "./heading.js";
import { deleteRange, moveBoundary, rangeHeadingForMode, setRangeHeading, splitRange, toPiecewise } from "./headingRanges.js";
import { mirrorAuto } from "./mirror.js";
import { plan } from "./plan.js";
import { resolve } from "./resolve.js";
import { buildSimPath, parameterAtFraction } from "./sim/pedroPath.js";
import { testField, testRobot, testWaypoints } from "./testing/fixtures.js";

/**
 * The piecewise heading of site/docs/file-format.md, "Piecewise heading": ranges over t in 0..1, each
 * with its own mode, the way Pedro's `Interpolator.piecewise().until(t, ...)` takes them.
 */

type Piecewise = Extract<Heading, { mode: "piecewise" }>;

const range = (startT: number, endT: number, heading: HeadingRange["heading"]): HeadingRange => ({
  startT,
  endT,
  heading,
});

/** Constant 0 over the first half, then a linear quarter turn over the second. */
const holdThenTurn: Piecewise = {
  mode: "piecewise",
  ranges: [
    range(0, 0.5, { mode: "constant", headingRad: 0 }),
    range(0.5, 1, { mode: "linear", fromRad: 0, toRad: Math.PI / 2 }),
  ],
};

const straight = makePath([
  [
    { xIn: 0, yIn: 0 },
    { xIn: 24, yIn: 0 },
  ],
]);

describe("headingAtT on a piecewise heading", () => {
  it("holds in the constant range and turns over the linear range's own stretch", () => {
    expect(headingAtT(holdThenTurn, straight, 0)).toBeCloseTo(0, 9);
    expect(headingAtT(holdThenTurn, straight, 0.25)).toBeCloseTo(0, 9);
    expect(headingAtT(holdThenTurn, straight, 0.75)).toBeCloseTo(Math.PI / 4, 9);
    expect(headingAtT(holdThenTurn, straight, 1)).toBeCloseTo(Math.PI / 2, 9);
  });

  it("gives a boundary to the range that ends there, as Pedro's ceilingEntry does", () => {
    expect(rangeIndexAt(holdThenTurn.ranges, 0.5)).toBe(0);
    expect(rangeIndexAt(holdThenTurn.ranges, 0.5000001)).toBe(1);
    expect(rangeIndexAt(holdThenTurn.ranges, 2)).toBe(1);
  });

  it("reads tangent and facing point on the whole path inside a range", () => {
    const heading: Piecewise = {
      mode: "piecewise",
      ranges: [range(0, 0.5, { mode: "tangentReversed" }), range(0.5, 1, { mode: "facePoint", xIn: 12, yIn: 12 })],
    };
    expect(Math.abs(headingAtT(heading, straight, 0.25))).toBeCloseTo(Math.PI, 9);
    // At x = 18 on the line, the point (12, 12) is up and back: atan2(12, -6).
    expect(headingAtT(heading, straight, 0.75)).toBeCloseTo(Math.atan2(12, -6), 9);
  });

  it("turns a linear range the short way, as the runtime does", () => {
    const heading: Piecewise = {
      mode: "piecewise",
      ranges: [range(0, 1, { mode: "linear", fromRad: 0.1, toRad: 2 * Math.PI - 0.1 })],
    };
    expect(headingAtT(heading, straight, 0.5)).toBeCloseTo(0, 9);
  });
});

describe("rangeProblem", () => {
  it("accepts ranges that cover 0 to 1 end to start", () => {
    expect(rangeProblem(holdThenTurn.ranges)).toBeNull();
  });

  it("names a gap, an overlap, a late start, an early end and an empty range", () => {
    const tangent = { mode: "tangent" } as const;
    expect(rangeProblem([range(0, 0.4, tangent), range(0.5, 1, tangent)])).toMatch(/gap/);
    expect(rangeProblem([range(0, 0.6, tangent), range(0.5, 1, tangent)])).toMatch(/overlap/);
    expect(rangeProblem([range(0.1, 1, tangent)])).toMatch(/must start at 0/);
    expect(rangeProblem([range(0, 0.9, tangent)])).toMatch(/must end at 1/);
    expect(rangeProblem([range(0, 0.5, tangent), range(0.5, 0.5, tangent), range(0.5, 1, tangent)])).toMatch(
      /not after its start/,
    );
    expect(rangeProblem([])).toMatch(/at least one range/);
  });
});

describe("range edits", () => {
  it("wraps any heading as one range, and a step with none as tangent", () => {
    expect(toPiecewise({ mode: "constant", headingRad: 1 })).toEqual({
      mode: "piecewise",
      ranges: [range(0, 1, { mode: "constant", headingRad: 1 })],
    });
    expect(toPiecewise(undefined).ranges[0]?.heading).toEqual({ mode: "tangent" });
    expect(toPiecewise(holdThenTurn)).toBe(holdThenTurn);
  });

  it("splits a linear range where it passes, so the robot turns exactly as before", () => {
    const split = splitRange(holdThenTurn, 0.75);
    expect(split.ranges).toEqual([
      range(0, 0.5, { mode: "constant", headingRad: 0 }),
      range(0.5, 0.75, { mode: "linear", fromRad: 0, toRad: Math.PI / 4 }),
      range(0.75, 1, { mode: "linear", fromRad: Math.PI / 4, toRad: Math.PI / 2 }),
    ]);
    for (const t of [0.1, 0.6, 0.75, 0.9]) {
      expect(headingAtT(split, straight, t)).toBeCloseTo(headingAtT(holdThenTurn, straight, t), 9);
    }
    expect(rangeProblem(split.ranges)).toBeNull();
  });

  it("refuses a split on a boundary or too close to one", () => {
    expect(splitRange(holdThenTurn, 0.5)).toBe(holdThenTurn);
    expect(splitRange(holdThenTurn, 0.51)).toBe(holdThenTurn);
  });

  it("moves a boundary and clamps it short of the neighbouring ends", () => {
    expect(moveBoundary(holdThenTurn, 0, 0.3).ranges.map((r) => [r.startT, r.endT])).toEqual([
      [0, 0.3],
      [0.3, 1],
    ]);
    expect(moveBoundary(holdThenTurn, 0, 1.5).ranges[0]?.endT).toBe(0.98);
    expect(moveBoundary(holdThenTurn, 0, -1).ranges[0]?.endT).toBe(0.02);
    expect(moveBoundary(holdThenTurn, 1, 0.3)).toBe(holdThenTurn);
  });

  it("deletes a range into its neighbour and keeps the last one", () => {
    expect(deleteRange(holdThenTurn, 1).ranges).toEqual([range(0, 1, { mode: "constant", headingRad: 0 })]);
    expect(deleteRange(holdThenTurn, 0).ranges).toEqual([
      range(0, 1, { mode: "linear", fromRad: 0, toRad: Math.PI / 2 }),
    ]);
    const one = toPiecewise({ mode: "tangent" });
    expect(deleteRange(one, 0)).toBe(one);
  });

  it("changes one range's mode, carrying its angles over", () => {
    const second = holdThenTurn.ranges[1] as HeadingRange;
    expect(rangeHeadingForMode("constant", second)).toEqual({ mode: "constant", headingRad: 0 });
    const first = holdThenTurn.ranges[0] as HeadingRange;
    expect(rangeHeadingForMode("linear", first)).toEqual({ mode: "linear", fromRad: 0, toRad: 0 });
    const changed = setRangeHeading(holdThenTurn, 0, { mode: "tangent" });
    expect(changed.ranges[0]).toEqual(range(0, 0.5, { mode: "tangent" }));
    expect(changed.ranges[1]).toBe(holdThenTurn.ranges[1]);
  });
});

const auto = (heading: unknown): Auto =>
  parseAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 3,
    name: "piecewise-fixture",
    alliance: "RED",
    start: { pose: { xIn: 0, yIn: -40, headingRad: 0 } },
    steps: [
      {
        id: "turn",
        kind: "path",
        segments: [{ kind: "line", from: "current", to: { xIn: 24, yIn: -40 } }],
        heading,
      },
    ],
  });

describe("piecewise in the plan and the checks", () => {
  const findings = (a: Auto) => {
    const planned = plan(resolve(a, testWaypoints), testRobot, testField);
    return check(planned, estimate(planned, testRobot), testRobot, testField);
  };

  it("plans the heading at each sample from the ranges", () => {
    const planned = plan(resolve(auto(holdThenTurn), testWaypoints), testRobot, testField);
    const samples = planned.steps[0]?.samples ?? [];
    expect(samples[0]?.pose.headingRad).toBeCloseTo(0, 6);
    expect(samples[samples.length - 1]?.pose.headingRad).toBeCloseTo(Math.PI / 2, 6);
    expect(findings(auto(holdThenTurn)).filter((f) => f.code.startsWith("HEADING"))).toEqual([]);
  });

  it("raises HEADING_RANGES, an error, for ranges with a gap", () => {
    const gap = {
      mode: "piecewise",
      ranges: [range(0, 0.4, { mode: "tangent" }), range(0.5, 1, { mode: "tangent" })],
    };
    const found = findings(auto(gap)).filter((f) => f.code === "HEADING_RANGES");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: "error", stepId: "turn" });
    expect(found[0]?.message).toMatch(/gap/);
  });

  it("warns about a linear range over half a turn, at the range's start", () => {
    const long = {
      mode: "piecewise",
      ranges: [range(0, 0.5, { mode: "tangent" }), range(0.5, 1, { mode: "linear", fromRad: 0, toRad: 3.5 })],
    };
    const found = findings(auto(long)).filter((f) => f.code === "HEADING");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: "warning", t: 0.5 });
  });

  it("mirrors each range's heading and keeps the ranges where they are", () => {
    const mirrored = mirrorAuto(auto(holdThenTurn));
    const step = mirrored.steps[0];
    const heading = step?.kind === "path" ? step.heading : undefined;
    expect(heading?.mode).toBe("piecewise");
    if (heading?.mode !== "piecewise") return;
    expect(heading.ranges.map((r) => [r.startT, r.endT])).toEqual([
      [0, 0.5],
      [0.5, 1],
    ]);
    expect(heading.ranges[0]?.heading).toEqual({ mode: "constant", headingRad: Math.PI });
    expect(mirrorAuto(mirrored)).toEqual(auto(holdThenTurn));
  });
});

describe("piecewise in the instant sim, as PathBuilder.piecewiseFor builds it", () => {
  const TWO_PI = 2 * Math.PI;

  it("holds then turns on one segment", () => {
    const path = buildSimPath([[{ x: 0, y: 0 }, { x: 24, y: 0 }]], holdThenTurn, 0);
    const segment = path.segments[0];
    expect(segment?.heading(0.25)).toBeCloseTo(0, 9);
    expect(segment?.heading(0.75)).toBeCloseTo(Math.PI / 4, 9);
    expect(segment?.heading(1)).toBeCloseTo(Math.PI / 2, 9);
  });

  it("gives a second segment only the ranges that cross it, in its own t", () => {
    const path = buildSimPath(
      [
        [{ x: 0, y: 0 }, { x: 24, y: 0 }],
        [{ x: 24, y: 0 }, { x: 48, y: 0 }],
      ],
      holdThenTurn,
      0,
    );
    expect(path.segments[0]?.heading(1)).toBeCloseTo(0, 9);
    expect(path.segments[1]?.heading(0)).toBeCloseTo(0, 9);
    expect(path.segments[1]?.heading(0.5)).toBeCloseTo(Math.PI / 4, 9);
    expect(path.segments[1]?.heading(1)).toBeCloseTo(Math.PI / 2, 9);
    expect(path.endPose.heading).toBeCloseTo(Math.PI / 2 % TWO_PI, 9);
  });

  it("maps an arc fraction to the segment's own t through the chord table", () => {
    const path = buildSimPath([[{ x: 0, y: 0 }, { x: 0, y: 20 }, { x: 20, y: 20 }]], { mode: "tangent" }, 0);
    const curve = path.segments[0]?.curve;
    if (curve === undefined) throw new Error("no curve");
    expect(parameterAtFraction(curve, 0.5)).toBeCloseTo(0.5, 6);
    expect(parameterAtFraction(curve, 0)).toBe(0);
    expect(parameterAtFraction(curve, 1)).toBe(1);
  });
});
