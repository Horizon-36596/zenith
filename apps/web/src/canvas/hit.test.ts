import { describe, expect, it } from "vitest";
import {
  emptyHitScene,
  handleRank,
  hitTest,
  isMarkerOrLineHit,
  nextStepUnder,
  projectOntoPolyline,
  stepsUnder,
  type HitScene,
  type MarkerEntry,
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

/**
 * Issue #149: where steps overlap, markers and lines are one tier, ranked the selected step's
 * markers, then its line, then other steps' markers, then their lines. Among markers the later step
 * wins, then the nearer; among lines the nearer wins, then the later step.
 */
describe("hitTest on overlapping steps", () => {
  /** The same straight run as `straight`, for step `stepId` at `stepIndex`. */
  const line = (stepId: string, stepIndex: number, selected = false, yPx = 100): PolylineEntry => ({
    stepId,
    xsPx: [100, 200],
    ysPx: [yPx, yPx],
    ts: [0, 1],
    rank: handleRank(stepIndex, selected),
  });
  const markerOf = (stepId: string, stepIndex: number, selected = false, xPx = 150): MarkerEntry => ({
    stepId,
    markerIndex: 0,
    xPx,
    yPx: 100,
    rank: handleRank(stepIndex, selected),
  });

  it("returns the earlier of two identical lines when it is selected", () => {
    const hit = hitTest(scene({ polylines: [line("outA", 0, true), line("outC", 2)] }), 150, 100);
    expect(hit).toEqual({ stepId: "outA", t: 0.5 });
  });

  it("returns the later of two identical lines when neither is selected", () => {
    expect(hitTest(scene({ polylines: [line("outA", 0), line("outC", 2)] }), 150, 100)?.stepId).toBe("outC");
  });

  it("does not let a later line beat a nearer earlier one", () => {
    const polylines = [line("outA", 0, false, 101), line("outC", 2, false, 104)];
    expect(hitTest(scene({ polylines }), 150, 101)?.stepId).toBe("outA");
  });

  it("keeps the selected step's line over a nearer line of another step", () => {
    const polylines = [line("outA", 0, true, 104), line("outC", 2, false, 100)];
    expect(hitTest(scene({ polylines }), 150, 100)?.stepId).toBe("outA");
  });

  it("gives a later step's marker on the selected step's line to that line", () => {
    const hit = hitTest(scene({ polylines: [line("outA", 0, true), line("outC", 2)], markers: [markerOf("outC", 2)] }), 150, 100);
    expect(hit).toEqual({ stepId: "outA", t: 0.5 });
  });

  it("gives the selected step's own marker the press over its line", () => {
    const markers = [markerOf("outC", 2), markerOf("outA", 0, true)];
    const hit = hitTest(scene({ polylines: [line("outA", 0, true), line("outC", 2)], markers }), 150, 100);
    expect(hit).toEqual({ stepId: "outA", markerIndex: 0 });
  });

  it("gives another step's marker the press over the lines of steps that are not selected", () => {
    const hit = hitTest(scene({ polylines: [line("outA", 0), line("outC", 2)], markers: [markerOf("outA", 0)] }), 150, 100);
    expect(hit).toEqual({ stepId: "outA", markerIndex: 0 });
  });

  it("gives the later step's marker an overlap of markers, even when an earlier one is nearer", () => {
    const markers = [markerOf("outA", 0, false, 150), markerOf("outC", 2, false, 156)];
    expect(hitTest(scene({ markers }), 151, 100)).toEqual({ stepId: "outC", markerIndex: 0 });
  });

  it("still gives a pin the press over a line and a marker the press over a pin", () => {
    const pin = { name: "scoreSouth", xPx: 150, yPx: 100, label: null };
    expect(hitTest(scene({ polylines: [line("outA", 0, true)], pins: [pin] }), 150, 100)).toEqual({ stepId: "", waypoint: "scoreSouth" });
    expect(hitTest(scene({ markers: [markerOf("outC", 2)], pins: [pin] }), 150, 100)).toEqual({ stepId: "outC", markerIndex: 0 });
  });
});

/** Issue #149: Alt+click moves to the next step under the pointer, in the order a click ranks them. */
describe("stepsUnder and nextStepUnder", () => {
  const line = (stepId: string, stepIndex: number, selected = false): PolylineEntry => ({
    stepId,
    xsPx: [100, 200],
    ysPx: [100, 100],
    ts: [0, 1],
    rank: handleRank(stepIndex, selected),
  });
  /** Three steps on one line, outA selected, as in the e2e spec. */
  const shared = scene({ polylines: [line("outA", 0, true), line("backB", 1), line("outC", 2)] });

  it("lists every step under the pointer once, in rank order with nothing selected", () => {
    expect(stepsUnder(shared, 150, 100).map((hit) => hit.stepId)).toEqual(["outC", "backB", "outA"]);
    expect(stepsUnder(shared, 150, 140)).toEqual([]);
  });

  it("lists a step at its marker when its marker is under the pointer", () => {
    const withMarker = { ...shared, markers: [{ stepId: "outA", markerIndex: 2, xPx: 150, yPx: 100, rank: handleRank(0, true) }] };
    expect(stepsUnder(withMarker, 150, 100)).toEqual([
      { stepId: "outA", markerIndex: 2 },
      { stepId: "outC", t: 0.5 },
      { stepId: "backB", t: 0.5 },
    ]);
  });

  it("cycles outC, backB, outA from outA, whichever is selected", () => {
    expect(nextStepUnder(shared, 150, 100, "outA")?.stepId).toBe("outC");
    expect(nextStepUnder(shared, 150, 100, "outC")?.stepId).toBe("backB");
    expect(nextStepUnder(shared, 150, 100, "backB")?.stepId).toBe("outA");
  });

  it("starts at the top of the list when the selected step is not under the pointer", () => {
    expect(nextStepUnder(shared, 150, 100, undefined)?.stepId).toBe("outC");
    expect(nextStepUnder(shared, 150, 100, "park")?.stepId).toBe("outC");
  });

  it("returns null where no step is under the pointer", () => {
    expect(nextStepUnder(shared, 150, 140, "outA")).toBeNull();
  });
});

/**
 * Review of issue #149: Alt+click walks the steps under the pointer only where the press landed on a
 * marker or a line. A dot, the start mark and a pin sit above that tier and keep the press, so an
 * Alt+click on one of them does what a plain click does, even where a line runs under it.
 */
describe("isMarkerOrLineHit", () => {
  /** One selected step, `solo`, from its start mark at (100, 100) to its end dot at (200, 100). */
  const solo = scene({
    polylines: [{ stepId: "solo", xsPx: [100, 200], ysPx: [100, 100], ts: [0, 1], rank: handleRank(0, true) }],
    handles: [{ stepId: "solo", point: { segmentIndex: 0, pointKind: "to" }, xPx: 200, yPx: 100, rank: handleRank(0, true) }],
    markers: [{ stepId: "solo", markerIndex: 0, xPx: 125, yPx: 100, rank: handleRank(0, true) }],
    start: { xPx: 100, yPx: 100 },
    pins: [{ name: "scoreNorth", xPx: 160, yPx: 100, label: null }],
  });

  it("is true for a press on a line or a marker", () => {
    expect(hitTest(solo, 180, 100)).toEqual({ stepId: "solo", t: 0.8 });
    expect(isMarkerOrLineHit(hitTest(solo, 180, 100))).toBe(true);
    expect(hitTest(solo, 125, 100)).toEqual({ stepId: "solo", markerIndex: 0 });
    expect(isMarkerOrLineHit(hitTest(solo, 125, 100))).toBe(true);
  });

  it("is false for the end dot, the start mark and a pin on the line, selected or not", () => {
    const endDot = hitTest(solo, 200, 100);
    expect(endDot).toEqual({ stepId: "solo", point: { segmentIndex: 0, pointKind: "to" } });
    expect(isMarkerOrLineHit(endDot)).toBe(false);
    const start = hitTest(solo, 100, 100);
    expect(start).toEqual({ stepId: "", start: true });
    expect(isMarkerOrLineHit(start)).toBe(false);
    const pin = hitTest(solo, 160, 100);
    expect(pin).toEqual({ stepId: "", waypoint: "scoreNorth" });
    expect(isMarkerOrLineHit(pin)).toBe(false);
    const selectedPin = hitTest({ ...solo, pins: [{ name: "scoreNorth", xPx: 160, yPx: 100, label: null, selected: true }] }, 160, 100);
    expect(selectedPin).toEqual({ stepId: "", waypoint: "scoreNorth" });
    expect(isMarkerOrLineHit(selectedPin)).toBe(false);
  });

  it("is false over empty field", () => {
    expect(isMarkerOrLineHit(hitTest(solo, 150, 140))).toBe(false);
  });
});
