import { describe, expect, it } from "vitest";
import {
  boxCorners,
  convexHull,
  convexPolygonClearance,
  inflateBox,
  polygonBoxClearance,
  polygonOverlapsBox,
  rectCorners,
  type Box2,
} from "./sat.js";

const box: Box2 = { minXIn: 0, maxXIn: 10, minYIn: 0, maxYIn: 10 };
const square = (minX: number, maxX: number, minY: number, maxY: number) =>
  boxCorners({ minXIn: minX, maxXIn: maxX, minYIn: minY, maxYIn: maxY });
const diamond = (cx: number, cy: number, half: number) => [
  { xIn: cx + half, yIn: cy },
  { xIn: cx, yIn: cy + half },
  { xIn: cx - half, yIn: cy },
  { xIn: cx, yIn: cy - half },
];

describe("polygonBoxClearance", () => {
  it("is the gap when the shapes are apart", () => {
    expect(polygonBoxClearance(square(12, 14, 0, 2), box)).toBeCloseTo(2, 12);
    expect(polygonBoxClearance(square(3, 5, -7, -3), box)).toBeCloseTo(3, 12);
  });

  it("is 0 when the shapes touch", () => {
    expect(polygonBoxClearance(square(10, 12, 0, 2), box)).toBeCloseTo(0, 12);
    expect(polygonBoxClearance(square(4, 6, 10, 12), box)).toBeCloseTo(0, 12);
  });

  it("is minus the penetration depth when the shapes overlap", () => {
    // 8..12 against 0..10 on x: it has to move 2 in to the right to get out; on y it is 4.
    expect(polygonBoxClearance(square(8, 12, 0, 4), box)).toBeCloseTo(-2, 12);
    // A shape wholly inside has to move the shortest way out: on x, 3..5 is 5 in from getting
    // past the left edge and 7 in from the right; on y, 4..6 needs 6 either way.
    expect(polygonBoxClearance(square(3, 5, 4, 6), box)).toBeCloseTo(-5, 12);
  });

  it("is exact for a rotated polygon", () => {
    // A diamond of half-diagonal sqrt 2 centred at (12, 12). Its nearest edge is the line
    // x + y = 24 - sqrt 2, and the box's corner (10, 10) is (24 - sqrt 2 - 20) / sqrt 2 = 2 sqrt 2 - 1
    // from it, which is the gap on that edge's normal and the largest of the four axes.
    expect(polygonBoxClearance(diamond(12, 12, Math.SQRT2), box)).toBeCloseTo(2 * Math.SQRT2 - 1, 12);
    // A diamond of half-diagonal 2 centred at (11, 5): its left corner is 1 in inside the box's
    // right edge, and that is the shallowest way out.
    expect(polygonBoxClearance(diamond(11, 5, 2), box)).toBeCloseTo(-1, 12);
  });

  it("agrees with polygonOverlapsBox on a fixed grid of poses", () => {
    const headings = [0, Math.PI / 12, Math.PI / 6, Math.PI / 4, Math.PI / 3, 1.3, Math.PI / 2, 2.4];
    let overlapping = 0;
    let apart = 0;
    for (const headingRad of headings) {
      for (let x = -8; x <= 18; x += 1.5) {
        for (let y = -8; y <= 18; y += 1.5) {
          const polygon = rectCorners({ centreIn: { xIn: x, yIn: y }, lengthIn: 6, widthIn: 2, headingRad });
          const clearance = polygonBoxClearance(polygon, box);
          const result = polygonOverlapsBox(polygon, box);
          expect(clearance < 0).toBe(result.overlaps);
          if (result.overlaps) {
            overlapping += 1;
            expect(-clearance).toBeCloseTo(result.penetrationIn, 12);
          } else {
            apart += 1;
            expect(clearance).toBeGreaterThanOrEqual(0);
          }
        }
      }
    }
    expect(overlapping).toBeGreaterThan(50);
    expect(apart).toBeGreaterThan(50);
  });

  it("never exceeds the Euclidean distance between the shapes", () => {
    // The nearest approach of a rotated square to the box's corner is a corner-to-corner one.
    const polygon = rectCorners({ centreIn: { xIn: 13, yIn: 13 }, lengthIn: 2, widthIn: 2, headingRad: 0.3 });
    const clearance = polygonBoxClearance(polygon, box);
    let nearest = Infinity;
    for (const corner of polygon) nearest = Math.min(nearest, Math.hypot(corner.xIn - 10, corner.yIn - 10));
    expect(clearance).toBeGreaterThan(0);
    expect(clearance).toBeLessThanOrEqual(nearest);
  });
});

describe("convexPolygonClearance", () => {
  it("is the same signed gap for two polygons", () => {
    expect(convexPolygonClearance(square(12, 14, 0, 2), boxCorners(box))).toBeCloseTo(2, 12);
    expect(convexPolygonClearance(square(8, 12, 0, 4), boxCorners(box))).toBeCloseTo(-2, 12);
    // A 4 by 2 rectangle turned a quarter turn about (20, 5) spans x 19..21 in the field frame.
    const turned = rectCorners({ centreIn: { xIn: 20, yIn: 5 }, lengthIn: 4, widthIn: 2, headingRad: Math.PI / 2 });
    expect(convexPolygonClearance(turned, boxCorners(box))).toBeCloseTo(9, 12);
  });
});

describe("inflateBox", () => {
  it("grows every side by the same amount", () => {
    expect(inflateBox(box, 1.5)).toEqual({ minXIn: -1.5, maxXIn: 11.5, minYIn: -1.5, maxYIn: 11.5 });
  });

  it("turns a clearance of d into a touch", () => {
    const polygon = square(13, 15, 2, 4);
    expect(polygonBoxClearance(polygon, inflateBox(box, 3))).toBeCloseTo(0, 12);
    expect(polygonBoxClearance(polygon, inflateBox(box, 3.5))).toBeLessThan(0);
  });
});

describe("convexHull", () => {
  it("keeps the corners of two squares and drops the rest", () => {
    const hull = convexHull([...square(0, 2, 0, 2), ...square(2, 4, 0, 2)]);
    expect(hull).toHaveLength(4);
    const xs = hull.map((p) => p.xIn).sort((a, b) => a - b);
    expect(xs).toEqual([0, 0, 4, 4]);
  });

  it("returns what it is given when there are fewer than three distinct points", () => {
    expect(
      convexHull([
        { xIn: 1, yIn: 1 },
        { xIn: 1, yIn: 1 },
      ]),
    ).toEqual([{ xIn: 1, yIn: 1 }]);
    expect(convexHull([])).toEqual([]);
  });
});
