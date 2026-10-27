import { parseAuto, SCHEMA_ID, type Heading } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { check } from "./check.js";
import { angleDelta } from "./geometry/angle.js";
import type { Curve } from "./geometry/curve.js";
import { makePath, type PathGeometry } from "./geometry/path.js";
import { headingFunction, linearHeadingPieces, tangentHeading } from "./heading.js";
import { plan } from "./plan.js";
import { resolve } from "./resolve.js";
import { buildSimPath, type SimSegment } from "./sim/pedroPath.js";
import { testField, testRobot, testWaypoints } from "./testing/fixtures.js";
import type { PlanStep } from "./types.js";

describe("tangentHeading", () => {
  it("finding 4: a repeated last control point still reads as travelling forwards", () => {
    // A bezier whose last control point equals its `to`: the analytic derivative vanishes at t = 1,
    // so the cusp fallback samples just before the end. The path travels in +x throughout.
    const path = makePath([
      [
        { xIn: 0, yIn: 0 },
        { xIn: 10, yIn: 0 },
        { xIn: 10, yIn: 0 },
      ],
    ]);
    expect(tangentHeading(path, 1)).toBeCloseTo(0, 6);
    expect(headingFunction({ mode: "tangent" }, path)(1)).toBeCloseTo(0, 6);
    expect(Math.abs(headingFunction({ mode: "tangentReversed" }, path)(1))).toBeCloseTo(Math.PI, 6);
  });

  it("finding 4: a repeated first control point still reads as travelling forwards", () => {
    const path = makePath([
      [
        { xIn: 0, yIn: 0 },
        { xIn: 0, yIn: 0 },
        { xIn: 10, yIn: 0 },
      ],
    ]);
    expect(tangentHeading(path, 0)).toBeCloseTo(0, 6);
  });
});

describe("the linear heading mode turns the short way, as Pedro does", () => {
  const straight = makePath([
    [
      { xIn: 0, yIn: 0 },
      { xIn: 20, yIn: 0 },
    ],
  ]);
  // Two segments of equal length, so the runtime gives each half of the sweep.
  const twoLegs = makePath([
    [
      { xIn: 0, yIn: 0 },
      { xIn: 10, yIn: 0 },
    ],
    [
      { xIn: 10, yIn: 0 },
      { xIn: 20, yIn: 0 },
    ],
  ]);

  it("turns a quarter turn the way the file wrote it", () => {
    const h = headingFunction({ mode: "linear", fromRad: 0, toRad: 1.5708 }, straight);
    expect(h(0)).toBeCloseTo(0, 6);
    expect(h(0.5)).toBeCloseTo(0.7854, 4);
    expect(h(1)).toBeCloseTo(1.5708, 4);
  });

  it("turns the editor's half turn, 3.1416, clockwise, because 3.1416 is a hair over pi", () => {
    const h = headingFunction({ mode: "linear", fromRad: 0, toRad: 3.1416 }, straight);
    expect(h(0.25)).toBeCloseTo(-0.7854, 3);
    expect(h(0.5)).toBeCloseTo(-1.5708, 3);
    expect(Math.abs(h(1))).toBeCloseTo(Math.PI, 3);
    const counter = headingFunction({ mode: "linear", fromRad: 0, toRad: -3.1416 }, straight);
    expect(counter(0.5)).toBeCloseTo(1.5708, 3);
  });

  it("turns a 270 degree sweep on one segment 90 degrees the other way", () => {
    const h = headingFunction({ mode: "linear", fromRad: 0, toRad: 4.7124 }, straight);
    expect(h(0.5)).toBeCloseTo(-0.7854, 4);
    expect(h(1)).toBeCloseTo(-1.5708, 4);
    expect(linearHeadingPieces({ mode: "linear", fromRad: 0, toRad: 4.7124 }, straight)[0]?.reversed).toBe(true);
  });

  it("keeps a 270 degree sweep split over two segments at 270 degrees, as the runtime cuts it", () => {
    const heading = { mode: "linear", fromRad: 0, toRad: 4.7124 } as const;
    const h = headingFunction(heading, twoLegs);
    expect(h(0.25)).toBeCloseTo(1.1781, 4);
    expect(h(0.5)).toBeCloseTo(2.3562, 4);
    expect(h(0.75)).toBeCloseTo(3.5343 - 2 * Math.PI, 4);
    expect(h(1)).toBeCloseTo(-1.5708, 4);
    const pieces = linearHeadingPieces(heading, twoLegs);
    expect(pieces.map((piece) => piece.reversed)).toEqual([false, false]);
    expect(pieces.reduce((sum, piece) => sum + piece.turnRad, 0)).toBeCloseTo(4.7124, 6);
  });
});

/**
 * OPT-01 (owner ruling 2026-10-08): on a Bezier, `linear` and the linear ranges of `piecewise` turn
 * linearly in each segment's own parametric t, the way the runtime hands them to Pedro
 * (`PathBuilder.withHeading`, `PathBuilder.piecewiseFor`) and the way `sim/pedroPath.ts` mirrors it.
 * The plan, and so the estimator and the ideal playback, must sweep the footprint at the heading the
 * robot will have there.
 */
describe("on a curve, plan() turns a linear heading the way the runtime does", () => {
  const start = { xIn: -50, yIn: -20, headingRad: 0 };
  const quadratic = {
    kind: "bezier",
    from: "current",
    control: [{ xIn: -46, yIn: 45 }],
    to: { xIn: 40, yIn: 30 },
  };
  const cubic = {
    kind: "bezier",
    from: "current",
    control: [
      { xIn: -48, yIn: 40 },
      { xIn: 30, yIn: 44 },
    ],
    to: { xIn: 40, yIn: -10 },
  };
  /** A quadratic into a cubic, so a range can cross the joint between them. */
  const twoCurves = [
    { kind: "bezier", from: "current", control: [{ xIn: -48, yIn: 30 }], to: { xIn: -10, yIn: 25 } },
    {
      kind: "bezier",
      from: { xIn: -10, yIn: 25 },
      control: [
        { xIn: 20, yIn: 22 },
        { xIn: 45, yIn: 50 },
      ],
      to: { xIn: 50, yIn: -5 },
    },
  ];

  const planned = (segments: unknown[], heading: Heading): PlanStep => {
    const auto = parseAuto({
      $schema: SCHEMA_ID.auto,
      formatVersion: 2,
      name: "curve-headings",
      alliance: "RED",
      start: { pose: start },
      steps: [{ id: "curve", kind: "path", segments, heading }],
    });
    const step = plan(resolve(auto, testWaypoints), testRobot, testField, { memoize: false }).steps[0];
    if (step?.geometry === undefined || step.segments === undefined) throw new Error("the path did not plan");
    return step;
  };

  /**
   * The runtime's heading at each of the step's samples: the sample's segment, and that segment's own
   * parametric t at the sample's arc length, read from `buildSimPath`.
   */
  const runtimeHeadings = (step: PlanStep, heading: Heading): number[] => {
    const geometry = step.geometry as PathGeometry;
    const polygons = (step.segments ?? []).map((segment) => segment.pointsIn.map((point) => ({ x: point.xIn, y: point.yIn })));
    const simPath = buildSimPath(polygons, heading, start.headingRad);
    expect(simPath.segments.length).toBe(geometry.curves.length);
    return step.samples.map((sample) => {
      let index = 0;
      while (index + 1 < geometry.curves.length && (geometry.breaks[index + 1] as number) < sample.sIn) index += 1;
      const curve = geometry.curves[index] as Curve;
      const u = curve.uAtLength(sample.sIn - (geometry.breaks[index] as number));
      return (simPath.segments[index] as SimSegment).heading(u);
    });
  };

  const expectRuntime = (segments: unknown[], heading: Heading): void => {
    const step = planned(segments, heading);
    const expected = runtimeHeadings(step, heading);
    expect(step.samples.length).toBeGreaterThan(10);
    step.samples.forEach((sample, index) => {
      const error = Math.abs(angleDelta(sample.pose.headingRad, expected[index] as number));
      expect(error, `sample ${String(index)} at ${sample.sIn.toFixed(3)} in is off by ${error.toExponential(2)} rad`).toBeLessThan(1e-6);
    });
  };

  it("on a quadratic", () => {
    expectRuntime([quadratic], { mode: "linear", fromRad: 0, toRad: 2.4 });
  });

  it("on a cubic", () => {
    expectRuntime([cubic], { mode: "linear", fromRad: 0.3, toRad: -2 });
  });

  it("on a sweep shared out over a quadratic and a cubic", () => {
    expectRuntime(twoCurves, { mode: "linear", fromRad: 0, toRad: 4.7124 });
  });

  it("on a piecewise heading whose linear range crosses the joint between a quadratic and a cubic", () => {
    expectRuntime(twoCurves, {
      mode: "piecewise",
      ranges: [
        { startT: 0, endT: 0.15, heading: { mode: "constant", headingRad: 0 } },
        { startT: 0.15, endT: 0.7, heading: { mode: "linear", fromRad: 0, toRad: 2.2 } },
        { startT: 0.7, endT: 1, heading: { mode: "linear", fromRad: 2.2, toRad: -1 } },
      ],
    });
  });

  it("on a tangent range and a facePoint range that cross the joint between a quadratic and a cubic", () => {
    expectRuntime(twoCurves, {
      mode: "piecewise",
      ranges: [
        { startT: 0, endT: 0.4, heading: { mode: "tangent" } },
        { startT: 0.4, endT: 0.75, heading: { mode: "facePoint", xIn: 0, yIn: 60 } },
        { startT: 0.75, endT: 1, heading: { mode: "tangentReversed" } },
      ],
    });
  });

  it("reads a tangent range at the sample's own point, so it follows the path across the joint", () => {
    const step = planned(twoCurves, {
      mode: "piecewise",
      ranges: [{ startT: 0, endT: 1, heading: { mode: "tangent" } }],
    });
    const geometry = step.geometry as PathGeometry;
    for (const sample of step.samples) {
      expect(Math.abs(angleDelta(sample.pose.headingRad, tangentHeading(geometry, sample.t)))).toBeLessThan(1e-6);
    }
  });

  it("keeps a share of more than half a turn reversed on a curve, and the HEADING warning with it", () => {
    const heading: Heading = { mode: "linear", fromRad: 0, toRad: 4.7124 };
    const step = planned([quadratic], heading);
    const pieces = linearHeadingPieces(heading, step.geometry as PathGeometry);
    expect(pieces).toHaveLength(1);
    expect(pieces[0]?.reversed).toBe(true);
    // The short way round 270 degrees is 90 degrees the other way.
    expect(pieces[0]?.turnRad).toBeCloseTo(-Math.PI / 2, 3);
    const last = step.samples[step.samples.length - 1];
    expect(angleDelta(last?.pose.headingRad ?? 0, -Math.PI / 2)).toBeCloseTo(0, 3);
    const auto = parseAuto({
      $schema: SCHEMA_ID.auto,
      formatVersion: 2,
      name: "curve-headings",
      alliance: "RED",
      start: { pose: start },
      steps: [{ id: "curve", kind: "path", segments: [quadratic], heading }],
    });
    const findings = check(plan(resolve(auto, testWaypoints), testRobot, testField, { memoize: false }), null, testRobot, testField);
    expect(findings.filter((finding) => finding.code === "HEADING" && finding.severity === "warning")).toHaveLength(1);
  });

  it("keeps the sweep per segment on two curves, where each share can be under half a turn", () => {
    const heading: Heading = { mode: "linear", fromRad: 0, toRad: 4.7124 };
    const pieces = linearHeadingPieces(heading, planned(twoCurves, heading).geometry as PathGeometry);
    expect(pieces).toHaveLength(2);
    expect(pieces.some((piece) => piece.reversed)).toBe(false);
    expect(pieces.reduce((sum, piece) => sum + (piece.toRad - piece.fromRad), 0)).toBeCloseTo(4.7124, 6);
  });

  it("is no longer linear in arc length, which is what moved", () => {
    const step = planned([quadratic], { mode: "linear", fromRad: 0, toRad: 2.4 });
    const deviation = Math.max(...step.samples.map((sample) => Math.abs(angleDelta(sample.pose.headingRad, 2.4 * sample.t))));
    expect(deviation).toBeGreaterThan(0.01);
  });
});
