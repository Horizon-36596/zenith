import { describe, expect, it } from "vitest";
import { angleDelta, lerpAngle, wrapAngle } from "./angle.js";
import { arcLength, makeCurve } from "./curve.js";
import { makePath, sampleDistances } from "./path.js";
import { polygonOutsideBox, polygonOverlapsBox, rectCorners } from "./sat.js";
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
