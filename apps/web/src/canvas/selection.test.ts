import { describe, expect, it } from "vitest";
import {
  isPointSelected,
  marqueeSelection,
  rectFrom,
  selectedPoints,
  selectionOf,
  stepsWithHandles,
  togglePoint,
  type MarqueeCandidate,
} from "./selection.js";
import type { SelectedPoint, Selection } from "./types.js";

const a: SelectedPoint = { stepId: "one", point: { segmentIndex: 0, pointKind: "to" } };
const b: SelectedPoint = { stepId: "two", point: { segmentIndex: 0, pointKind: "to" } };
const c: SelectedPoint = { stepId: "two", point: { segmentIndex: 1, pointKind: "control", controlIndex: 0 } };

const candidates: MarqueeCandidate[] = [
  { ...a, xPx: 10, yPx: 10 },
  { ...b, xPx: 50, yPx: 50 },
  { ...c, xPx: 90, yPx: 90 },
];

describe("selection of points", () => {
  it("keeps a single point as the plain v1 selection, with no points list", () => {
    expect(selectionOf([a])).toEqual({ stepId: "one", point: a.point });
    expect(selectionOf([])).toEqual({});
  });

  it("makes the last point primary and lists every point once there are several", () => {
    const selection = selectionOf([a, b]);
    expect(selection.stepId).toBe("two");
    expect(selection.points).toHaveLength(2);
    expect(selectedPoints(selection)).toEqual([a, b]);
  });

  it("adds a point with Shift-click, and removes it on a second Shift-click", () => {
    let selection: Selection = selectionOf([a]);
    selection = togglePoint(selection, b);
    expect(isPointSelected(selection, a)).toBe(true);
    expect(isPointSelected(selection, b)).toBe(true);
    selection = togglePoint(selection, a);
    expect(isPointSelected(selection, a)).toBe(false);
    expect(selectedPoints(selection)).toEqual([b]);
  });

  it("tells a control point apart from the endpoint of the same segment", () => {
    const endpoint: SelectedPoint = { stepId: "two", point: { segmentIndex: 1, pointKind: "to" } };
    expect(isPointSelected(selectionOf([c]), endpoint)).toBe(false);
  });

  it("draws handles on every step that has a selected point", () => {
    expect([...stepsWithHandles(selectionOf([a, c]))].sort()).toEqual(["one", "two"]);
  });
});

describe("marquee", () => {
  it("selects what the box encloses, whichever corner it was dragged from", () => {
    const selection = marqueeSelection({}, candidates, rectFrom({ xPx: 60, yPx: 60 }, { xPx: 0, yPx: 0 }), false);
    expect(selectedPoints(selection)).toEqual([a, b]);
  });

  it("replaces the selection without Shift and adds to it with Shift", () => {
    const base = selectionOf([c]);
    const box = rectFrom({ xPx: 0, yPx: 0 }, { xPx: 20, yPx: 20 });
    expect(selectedPoints(marqueeSelection(base, candidates, box, false))).toEqual([a]);
    expect(selectedPoints(marqueeSelection(base, candidates, box, true))).toEqual([c, a]);
  });

  it("clears the selection when the box encloses nothing, unless it was additive", () => {
    const base = selectionOf([c]);
    const empty = rectFrom({ xPx: 200, yPx: 200 }, { xPx: 300, yPx: 300 });
    expect(marqueeSelection(base, candidates, empty, false)).toEqual({});
    expect(marqueeSelection(base, candidates, empty, true)).toEqual(base);
  });
});
