import { footprintAt, robotClearanceIn, type Vec2 } from "@horizon36596/zenith-core";
import { describe, expect, it } from "vitest";
import { grownOutlineIn } from "./clearanceOutline";

/** The distance from a point to the nearest point of a convex polygon's boundary. */
function distanceToPolygon(point: Vec2, polygon: readonly Vec2[]): number {
  let best = Infinity;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i] as Vec2;
    const b = polygon[(i + 1) % polygon.length] as Vec2;
    const dx = b.xIn - a.xIn;
    const dy = b.yIn - a.yIn;
    const t = Math.max(0, Math.min(1, ((point.xIn - a.xIn) * dx + (point.yIn - a.yIn) * dy) / (dx * dx + dy * dy)));
    best = Math.min(best, Math.hypot(point.xIn - (a.xIn + t * dx), point.yIn - (a.yIn + t * dy)));
  }
  return best;
}

describe("the clearance outline (D8)", () => {
  const square: Vec2[] = [
    { xIn: 1, yIn: -1 },
    { xIn: 1, yIn: 1 },
    { xIn: -1, yIn: 1 },
    { xIn: -1, yIn: -1 },
  ];

  it("puts every point of the outline exactly the clearance from the footprint", () => {
    const outline = grownOutlineIn(square, 1.5);
    expect(outline.length).toBeGreaterThan(4);
    for (const point of outline) expect(distanceToPolygon(point, square)).toBeCloseTo(1.5, 9);
  });

  it("pushes each side straight out by the clearance", () => {
    const outline = grownOutlineIn(square, 1);
    expect(Math.max(...outline.map((point) => point.xIn))).toBeCloseTo(2, 9);
    expect(Math.min(...outline.map((point) => point.yIn))).toBeCloseTo(-2, 9);
  });

  it("follows a rotated footprint from core, at the robot's clearance", () => {
    const robot = {
      footprint: {
        startIn: { lengthIn: 18, widthIn: 14 },
        expandedIn: { lengthIn: 18, widthIn: 14 },
        centreOfRotationIn: { xIn: 0, yIn: 0 },
        clearanceIn: { value: 2, provenance: "SET BY HAND: test fixture" },
      },
      mouths: [],
    } as unknown as Parameters<typeof footprintAt>[1];
    const body = footprintAt({ xIn: 10, yIn: -20, headingRad: 0.7 }, robot, "expandedIn").bodyIn;
    const outline = grownOutlineIn(body, robotClearanceIn(robot));
    for (const point of outline) expect(distanceToPolygon(point, body)).toBeCloseTo(2, 9);
  });

  it("draws nothing at a clearance of 0", () => {
    expect(grownOutlineIn(square, 0)).toEqual([]);
  });
});
