import { describe, expect, it } from "vitest";
import {
  emptyHitScene,
  hitTest,
  projectOntoPolyline,
  type HitScene,
  type PolylineEntry,
} from "./hit.js";

/** A straight run of 100 px, left to right, whose t is the fraction along it. */
const straight: PolylineEntry = {
  stepId: "driveOut",
  xsPx: [100, 150, 200],
  ysPx: [100, 100, 100],
  ts: [0, 0.5, 1],
};

const scene = (overrides: Partial<HitScene> = {}): HitScene => ({
  ...emptyHitScene(),
  polylines: [straight],
  ...overrides,
});

describe("projectOntoPolyline", () => {
  it("returns the arc-length t of the nearest point", () => {
    const projection = projectOntoPolyline(straight, 175, 104);
    expect(projection).not.toBeNull();
    expect(projection?.t).toBeCloseTo(0.75, 9);
    expect(projection?.distancePx).toBeCloseTo(4, 9);
  });

  it("clamps past either end rather than extrapolating", () => {
    expect(projectOntoPolyline(straight, 0, 100)?.t).toBe(0);
    expect(projectOntoPolyline(straight, 400, 100)?.t).toBe(1);
  });

  it("interpolates t between vertices, not between indices", () => {
    const uneven: PolylineEntry = {
      stepId: "s",
      xsPx: [0, 10, 110],
      ysPx: [0, 0, 0],
      ts: [0, 0.1, 1],
    };
    expect(projectOntoPolyline(uneven, 60, 0)?.t).toBeCloseTo(0.55, 9);
  });

  it("handles a degenerate polyline", () => {
    expect(projectOntoPolyline({ stepId: "s", xsPx: [], ysPx: [], ts: [] }, 0, 0)).toBeNull();
    expect(projectOntoPolyline({ stepId: "s", xsPx: [5], ysPx: [5], ts: [0.25] }, 5, 5)?.t).toBe(0.25);
  });
});

describe("hitTest priority", () => {
  const handle = { stepId: "driveOut", point: { segmentIndex: 0, pointKind: "to" as const }, xPx: 150, yPx: 100 };
  const marker = { stepId: "driveOut", markerIndex: 1, xPx: 150, yPx: 100 };

  it("takes a handle over a marker and a path at the same place", () => {
    const hit = hitTest(scene({ handles: [handle], markers: [marker] }), 150, 100);
    expect(hit?.point).toEqual(handle.point);
    expect(hit?.markerIndex).toBeUndefined();
  });

  it("takes a marker over the path under it", () => {
    const hit = hitTest(scene({ markers: [marker] }), 150, 100);
    expect(hit?.markerIndex).toBe(1);
    expect(hit?.point).toBeUndefined();
  });

  it("falls through to the path, with the t of the point pressed", () => {
    const hit = hitTest(scene(), 175, 103);
    expect(hit?.stepId).toBe("driveOut");
    expect(hit?.t).toBeCloseTo(0.75, 9);
  });

  it("respects each tier's own tolerance", () => {
    // 9 px away: inside the 10 px handle target, outside the 6 px path target.
    expect(hitTest(scene({ handles: [handle] }), 150, 109)?.point).toEqual(handle.point);
    expect(hitTest(scene(), 150, 109)).toBeNull();
    expect(hitTest(scene(), 150, 105)?.stepId).toBe("driveOut");
  });

  it("returns null over empty field", () => {
    expect(hitTest(scene(), 400, 400)).toBeNull();
    expect(hitTest(emptyHitScene(), 0, 0)).toBeNull();
  });

  it("prefers the nearer of two handles", () => {
    const other = { ...handle, point: { segmentIndex: 1, pointKind: "to" as const }, xPx: 156, yPx: 100 };
    const hit = hitTest(scene({ handles: [handle, other] }), 155, 100);
    expect(hit?.point?.segmentIndex).toBe(1);
  });

  it("prefers the nearer of two overlapping paths", () => {
    const below: PolylineEntry = { stepId: "park", xsPx: [100, 200], ysPx: [104, 104], ts: [0, 1] };
    const hit = hitTest(scene({ polylines: [straight, below] }), 150, 103);
    expect(hit?.stepId).toBe("park");
  });
});
