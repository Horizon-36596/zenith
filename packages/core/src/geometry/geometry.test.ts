import { describe, expect, it } from "vitest";
import { angleDelta, lerpAngle, wrapAngle } from "./angle.js";
import { arcLength, makeCurve } from "./curve.js";
import { makePath, sampleDistances } from "./path.js";
import {
  boxCorners,
  boxGapIn,
  convexPolygonsGap,
  convexPolygonsOverlap,
  polygonOutsideBox,
  polygonOverlapsBox,
  rectCorners,
} from "./sat.js";
import { distance } from "./vec.js";

describe("arc length", () => {
  it("is the distance for a straight line", () => {
    const line = makeCurve([
      { xIn: -40, yIn: -63 },
      { xIn: -58, yIn: -24 },
    ]);
    const expected = distance({ xIn: -40, yIn: -63 }, { xIn: -58, yIn: -24 });
    expect(line.lengthIn).toBeCloseTo(expected, 12);
    expect(arcLength(line)).toBeCloseTo(expected, 12);
  });

  it("matches the closed form for a quadratic Bezier", () => {
    // Control polygon (-1,1), (0,-1), (1,1) traces y = x^2 from x = -1 to 1, whose exact arc
    // length is sqrt(5) + asinh(2) / 2.
    const curve = makeCurve([
      { xIn: -1, yIn: 1 },
      { xIn: 0, yIn: -1 },
      { xIn: 1, yIn: 1 },
    ]);
    const exact = Math.sqrt(5) + Math.asinh(2) / 2;
    expect(curve.degree).toBe(2);
    expect(curve.lengthIn).toBeCloseTo(exact, 10);
  });

  it("inverts: u at a length gives back that length", () => {
    const curve = makeCurve([
      { xIn: 0, yIn: 0 },
      { xIn: 10, yIn: 20 },
      { xIn: 30, yIn: 0 },
    ]);
    for (const fraction of [0, 0.1, 0.37, 0.5, 0.9, 1]) {
      const target = curve.lengthIn * fraction;
      expect(curve.lengthAt(curve.uAtLength(target))).toBeCloseTo(target, 3);
    }
  });
});

describe("paths", () => {
  const path = makePath([
    [
      { xIn: 0, yIn: 0 },
      { xIn: 10, yIn: 0 },
    ],
    [
      { xIn: 10, yIn: 0 },
      { xIn: 10, yIn: 5 },
    ],
  ]);

  it("re-parameterises the whole path by arc length to t in [0, 1]", () => {
    expect(path.lengthIn).toBeCloseTo(15, 9);
    expect(path.pointAt(0)).toEqual({ xIn: 0, yIn: 0 });
    expect(path.pointAt(1).xIn).toBeCloseTo(10, 9);
    expect(path.pointAt(1).yIn).toBeCloseTo(5, 9);
    const middle = path.pointAt(0.5);
    expect(middle.xIn).toBeCloseTo(7.5, 6);
    expect(middle.yIn).toBeCloseTo(0, 6);
  });

  it("samples every 2 in, plus the endpoints and every segment boundary", () => {
    const distances = sampleDistances(path, 2);
    expect(distances[0]).toBe(0);
    expect(distances[distances.length - 1]).toBeCloseTo(15, 9);
    // The segment boundary, to within the quadrature's own error on the first segment's length.
    expect(distances.some((s) => Math.abs(s - 10) < 1e-6)).toBe(true);
    for (let i = 1; i < distances.length; i += 1) {
      expect((distances[i] as number) - (distances[i - 1] as number)).toBeLessThanOrEqual(2 + 1e-9);
    }
  });
});

describe("angles", () => {
  it("wraps to (-pi, pi]", () => {
    expect(wrapAngle(0)).toBe(0);
    expect(wrapAngle(Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(wrapAngle(-Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(wrapAngle(1.5 * Math.PI)).toBeCloseTo(-0.5 * Math.PI, 12);
    expect(Object.is(wrapAngle(-2 * Math.PI), -0)).toBe(false);
  });

  it("takes the short way round", () => {
    const from = (170 * Math.PI) / 180;
    const to = (-170 * Math.PI) / 180;
    expect(angleDelta(from, to)).toBeCloseTo((20 * Math.PI) / 180, 12);
    expect(lerpAngle(from, to, 0.5)).toBeCloseTo(Math.PI, 12);
    expect(lerpAngle(0, Math.PI / 2, 0.5)).toBeCloseTo(Math.PI / 4, 12);
  });
});

describe("separating-axis test", () => {
  const box = { minXIn: -5, maxXIn: 5, minYIn: -5, maxYIn: 5 };

  it("separates a rectangle that is clear of the box", () => {
    const rect = rectCorners({
      centreIn: { xIn: 20, yIn: 0 },
      lengthIn: 18,
      widthIn: 14,
      headingRad: 0,
    });
    expect(polygonOverlapsBox(rect, box).overlaps).toBe(false);
  });

  it("reports the penetration of a rectangle that overlaps head on", () => {
    // Nose along +x, centred at x = 12: the box's near face is at x = 5, so the front 2 in of the
    // 18 in long footprint is inside.
    const rect = rectCorners({
      centreIn: { xIn: 12, yIn: 0 },
      lengthIn: 18,
      widthIn: 14,
      headingRad: 0,
    });
    const result = polygonOverlapsBox(rect, box);
    expect(result.overlaps).toBe(true);
    expect(result.penetrationIn).toBeCloseTo(2, 9);
  });

  it("catches a corner-on overlap a bounding-box test would miss", () => {
    // Rotated 45 degrees, centred on the box's corner diagonal. Its own axes separate nothing and
    // the world axes separate nothing, so the two really do overlap.
    const rect = rectCorners({
      centreIn: { xIn: 10, yIn: 10 },
      lengthIn: 18,
      widthIn: 14,
      headingRad: Math.PI / 4,
    });
    expect(polygonOverlapsBox(rect, box).overlaps).toBe(true);
  });

  it("separates the same rotated rectangle once it is moved away", () => {
    const rect = rectCorners({
      centreIn: { xIn: 16, yIn: 16 },
      lengthIn: 18,
      widthIn: 14,
      headingRad: Math.PI / 4,
    });
    expect(polygonOverlapsBox(rect, box).overlaps).toBe(false);
  });

  it("issue #152: reports how far an 18 in robot has to move to clear a 1 in bar it straddles", () => {
    // The old frameBarWest (before issue #229): 1 in wide in x, 38.8 in long in y. The robot drives north
    // along its centre line, so the bar runs right through the footprint. The overlap interval on
    // the x axis is only the bar's own 1 in, but the robot has to move 9.5 in either way to get off
    // it, and that is the depth a person needs to read.
    const bar = { minXIn: -25, maxXIn: -24, minYIn: -19.4, maxYIn: 19.4 };
    const rect = rectCorners({ centreIn: { xIn: -24.5, yIn: 0 }, lengthIn: 18, widthIn: 18, headingRad: Math.PI / 2 });
    const result = polygonOverlapsBox(rect, bar);
    expect(result.overlaps).toBe(true);
    expect(result.penetrationIn).toBeCloseTo(9.5, 9);
    expect(convexPolygonsOverlap(rect, boxCorners(bar)).penetrationIn).toBeCloseTo(9.5, 9);
  });

  it("issue #152: keeps the M0 contract's 1 in for a footprint whose edge is 1 in into the hive", () => {
    // The M0 contract's line: an 18 by 14 in robot driving east at y = 12, centred over the 8 in
    // hiveRedBase box (y -6 to 6). Its south edge is at y = 5, 1 in inside.
    const hive = { minXIn: -16.75, maxXIn: -8.75, minYIn: -6, maxYIn: 6 };
    const rect = rectCorners({ centreIn: { xIn: -12.75, yIn: 12 }, lengthIn: 18, widthIn: 14, headingRad: 0 });
    expect(polygonOverlapsBox(rect, hive).penetrationIn).toBeCloseTo(1, 9);
    expect(convexPolygonsOverlap(rect, boxCorners(hive)).penetrationIn).toBeCloseTo(1, 9);
  });

  it("issue #152: keeps the head-on 2 in for two convex polygons as well", () => {
    const rect = rectCorners({ centreIn: { xIn: 12, yIn: 0 }, lengthIn: 18, widthIn: 14, headingRad: 0 });
    expect(convexPolygonsOverlap(rect, boxCorners(box)).penetrationIn).toBeCloseTo(2, 9);
  });

  it("measures how far a polygon pokes out of the field", () => {
    const rect = rectCorners({
      centreIn: { xIn: 68, yIn: 0 },
      lengthIn: 18,
      widthIn: 14,
      headingRad: 0,
    });
    const outside = polygonOutsideBox(rect, { minXIn: -72, maxXIn: 72, minYIn: -72, maxYIn: 72 });
    expect(outside.outside).toBe(true);
    expect(outside.worstIn).toBeCloseTo(5, 9);
  });
});

describe("the gap between two convex polygons (CLEARANCE)", () => {
  const box = boxCorners({ minXIn: 0, maxXIn: 10, minYIn: 0, maxYIn: 10 });

  it("is the distance between facing edges", () => {
    const beside = boxCorners({ minXIn: 10.5, maxXIn: 20, minYIn: 2, maxYIn: 8 });
    const gap = convexPolygonsGap(beside, box);
    expect(gap.gapIn).toBeCloseTo(0.5, 9);
    expect(gap.pointOnA.xIn).toBeCloseTo(10.5, 9);
    expect(gap.pointOnB.xIn).toBeCloseTo(10, 9);
  });

  it("is corner to corner across a diagonal", () => {
    const corner = rectCorners({ centreIn: { xIn: 13, yIn: 14 }, lengthIn: 2, widthIn: 2, headingRad: 0 });
    // Nearest corner (12, 13) to the box's corner (10, 10): sqrt(4 + 9).
    expect(convexPolygonsGap(corner, box).gapIn).toBeCloseTo(Math.sqrt(13), 9);
  });

  it("is a rotated corner to an edge", () => {
    const diamond = rectCorners({ centreIn: { xIn: 5, yIn: 12 }, lengthIn: Math.SQRT2, widthIn: Math.SQRT2, headingRad: Math.PI / 4 });
    // The diamond's lowest corner is at y 11, 1 in above the box's top edge.
    expect(convexPolygonsGap(diamond, box).gapIn).toBeCloseTo(1, 9);
  });

  it("is 0 when they overlap", () => {
    expect(convexPolygonsGap(boxCorners({ minXIn: 9, maxXIn: 12, minYIn: 0, maxYIn: 1 }), box).gapIn).toBe(0);
  });

  it("box gap is a lower bound: 0 for overlapping boxes, the corner distance for diagonal ones", () => {
    expect(boxGapIn({ minXIn: 0, maxXIn: 1, minYIn: 0, maxYIn: 1 }, { minXIn: 0.5, maxXIn: 2, minYIn: 0.5, maxYIn: 2 })).toBe(0);
    expect(boxGapIn({ minXIn: 0, maxXIn: 1, minYIn: 0, maxYIn: 1 }, { minXIn: 4, maxXIn: 5, minYIn: 5, maxYIn: 6 })).toBeCloseTo(5, 9);
  });
});
