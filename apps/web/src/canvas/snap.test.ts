import type { Box2, Pose } from "@horizon36596/zenith-core";
import { describe, expect, it } from "vitest";
import {
  snapHeading,
  snapPose,
  GRID_IN,
  HEADING_SNAP_DEG,
  WALL_SNAP_IN,
  type SnapContext,
} from "./snap.js";

const BOUNDS: Box2 = { minXIn: -72, maxXIn: 72, minYIn: -72, maxYIn: 72 };

/** An 18 in square robot, axis aligned, so the maths in the test stays readable. */
const footprintBounds = (pose: Pose): Box2 => ({
  minXIn: pose.xIn - 9,
  maxXIn: pose.xIn + 9,
  minYIn: pose.yIn - 9,
  maxYIn: pose.yIn + 9,
});

const context = (overrides: Partial<SnapContext> = {}): SnapContext => ({
  enabled: true,
  altHeld: false,
  pxPerIn: 4,
  waypoints: [{ name: "scoreSouth", xIn: -40, yIn: 40 }],
  bounds: BOUNDS,
  footprintBounds,
  ...overrides,
});

const pose = (xIn: number, yIn: number, headingRad = 0): Pose => ({ xIn, yIn, headingRad });

describe("snapPose", () => {
  it("does nothing at all when the toggle is off", () => {
    const wanted = pose(-40.13, 39.91);
    const result = snapPose(wanted, context({ enabled: false }));
    expect(result.kind).toBe("none");
    expect(result.pose).toBe(wanted);
  });

  it("takes a waypoint inside the pixel tolerance, and keeps the heading", () => {
    // 6 px at 4 px per inch is 1.5 in of tolerance.
    const result = snapPose(pose(-41, 40.5, 1.2), context());
    expect(result.kind).toBe("waypoint");
    expect(result.waypoint).toBe("scoreSouth");
    expect(result.pose.xIn).toBe(-40);
    expect(result.pose.yIn).toBe(40);
    expect(result.pose.headingRad).toBe(1.2);
  });

  it("ignores a waypoint outside the tolerance", () => {
    const result = snapPose(pose(-44, 40), context());
    expect(result.kind).not.toBe("waypoint");
  });

  it("scales the waypoint tolerance with the zoom, because it is a pixel rule", () => {
    const far = pose(-43, 40);
    expect(snapPose(far, context({ pxPerIn: 4 })).kind).not.toBe("waypoint");
    expect(snapPose(far, context({ pxPerIn: 1 })).kind).toBe("waypoint");
  });

  it("rounds to the half inch grid", () => {
    const result = snapPose(pose(12.34, -5.61), context({ waypoints: [] }));
    expect(result.kind).toBe("grid");
    expect(result.pose.xIn).toBeCloseTo(12.5, 9);
    expect(result.pose.yIn).toBeCloseTo(-5.5, 9);
    expect(GRID_IN).toBe(0.5);
  });

  it("leaves the number alone when Alt is held", () => {
    const result = snapPose(pose(12.34, -5.61), context({ waypoints: [], altHeld: true }));
    expect(result.kind).toBe("none");
    expect(result.pose.xIn).toBe(12.34);
  });

  it("rests the footprint flush against a wall it is near", () => {
    // Flush would be x = -63; start just inside the tolerance of that.
    const result = snapPose(pose(-62.4, 0), context({ waypoints: [] }));
    expect(result.kind).toBe("wall");
    expect(result.pose.xIn).toBeCloseTo(-63, 9);
    expect(result.walls?.[0]).toEqual({ axis: "x", atIn: -72 });
  });

  it("pulls a footprint that has crept over the wall back to flush", () => {
    const result = snapPose(pose(-63.4, 0), context({ waypoints: [] }));
    expect(result.pose.xIn).toBeCloseTo(-63, 9);
  });

  it("pulls a footprint dragged well into the wall back to flush, while the point is on the field", () => {
    // The box reaches -75, three inches past the wall and far outside the 1 in tolerance.
    const result = snapPose(pose(-66, 10), context({ waypoints: [] }));
    expect(result.kind).toBe("wall");
    expect(result.pose.xIn).toBeCloseTo(-63, 9);
    expect(result.pose.yIn).toBe(10);
  });

  it("snaps both axes at a corner", () => {
    const result = snapPose(pose(62.6, -62.6), context({ waypoints: [] }));
    expect(result.kind).toBe("wall");
    expect(result.pose.xIn).toBeCloseTo(63, 9);
    expect(result.pose.yIn).toBeCloseTo(-63, 9);
    expect(result.walls).toHaveLength(2);
  });

  it("leaves a pose that is deliberately off the field where it is", () => {
    const result = snapPose(pose(-80, 0), context({ waypoints: [] }));
    expect(result.kind).toBe("grid");
    expect(result.pose.xIn).toBe(-80);
    expect(WALL_SNAP_IN).toBe(1);
  });

  it("skips the wall rule for a point with no footprint, such as a control point", () => {
    const result = snapPose(pose(-62.4, 0), context({ waypoints: [], footprintBounds: () => null }));
    expect(result.kind).toBe("grid");
    expect(result.pose.xIn).toBeCloseTo(-62.5, 9);
  });

  it("lets the wall beat the grid when both apply", () => {
    // 62.8 grids to 63.0, which is already flush, so the wall confirms rather than fights it.
    const result = snapPose(pose(62.8, 0), context({ waypoints: [] }));
    expect(result.kind).toBe("wall");
    expect(result.pose.xIn).toBeCloseTo(63, 9);
  });
});

describe("snapHeading", () => {
  it("rounds to 15 degrees", () => {
    expect(HEADING_SNAP_DEG).toBe(15);
    const result = snapHeading(0.26, context());
    expect(result.snapped).toBe(true);
    expect((result.headingRad * 180) / Math.PI).toBeCloseTo(15, 6);
  });

  it("is off with the toggle off or with Alt held", () => {
    expect(snapHeading(0.26, context({ enabled: false })).snapped).toBe(false);
    expect(snapHeading(0.26, context({ altHeld: true })).headingRad).toBeCloseTo(0.26, 9);
  });

  it("wraps the result into (-pi, pi]", () => {
    const result = snapHeading(3.2, context());
    expect(result.headingRad).toBeLessThanOrEqual(Math.PI);
    expect(result.headingRad).toBeGreaterThan(-Math.PI);
  });
});
