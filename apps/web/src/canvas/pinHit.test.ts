/**
 * Which press a waypoint pin gets (issue #134). A dot or the start mark drawn on a pin keeps the
 * press, as in the starter autos, where the start mark and driveOut's first dot both sit on the pin
 * `start`; a pin is reached where nothing else sits, on its ring, its stem or its name, and it wins
 * over the path line. The selected pin takes the press wherever it is drawn, ahead of everything,
 * which is how a covered pin is dragged once it is picked from the inspector's list.
 */
import { describe, expect, it } from "vitest";
import { emptyHitScene, hitTest, PIN_STEM_PX, pinsNear, type HitScene, type PinEntry } from "./hit.js";

const pin = (overrides: Partial<PinEntry> = {}): PinEntry => ({
  name: "start",
  xPx: 100,
  yPx: 100,
  label: { x0Px: 106, y0Px: 84, x1Px: 140, y1Px: 96 },
  ...overrides,
});

const scene = (overrides: Partial<HitScene> = {}): HitScene => ({ ...emptyHitScene(), ...overrides });

/** The starter's spot: the start mark, driveOut's first dot on it, and the pin under both. */
const covered = (selected = false): HitScene =>
  scene({
    start: { xPx: 100, yPx: 100 },
    handles: [{ stepId: "driveOut", point: { segmentIndex: 0, pointKind: "from" }, xPx: 100, yPx: 100, onStart: true }],
    polylines: [{ stepId: "driveOut", xsPx: [100, 100], ysPx: [100, 0], ts: [0, 1] }],
    pins: [pin({ selected })],
  });

describe("the pins within reach of a right-click", () => {
  it("names each pin a dot covers, nearest first, including one that nothing follows", () => {
    const two = scene({
      handles: [{ stepId: "sweepGarden", point: { segmentIndex: 0, pointKind: "to" }, xPx: 103, yPx: 100 }],
      pins: [pin({ name: "gardenSweepEnd", xPx: 103, label: null }), pin({ name: "gardenPickup", xPx: 100, label: null })],
    });
    expect(pinsNear(two, 100, 100)).toEqual(["gardenPickup", "gardenSweepEnd"]);
    expect(pinsNear(two, 103, 100)).toEqual(["gardenSweepEnd", "gardenPickup"]);
    expect(pinsNear(two, 140, 100)).toEqual([]);
  });
});

describe("waypoint pins on the field", () => {
  it("are grabbed on their ring, their stem or their name", () => {
    const alone = scene({ pins: [pin()] });
    expect(hitTest(alone, 102, 101)).toEqual({ stepId: "", waypoint: "start" });
    expect(hitTest(alone, 101, 100 - PIN_STEM_PX)).toEqual({ stepId: "", waypoint: "start" });
    expect(hitTest(alone, 130, 90)).toEqual({ stepId: "", waypoint: "start" });
    expect(hitTest(alone, 100, 120)).toBeNull();
  });

  it("give the press to a dot or the start mark drawn on them", () => {
    expect(hitTest(covered(), 100, 100)).toEqual({ stepId: "", start: true });
    // The stem's tip is still within the start mark's reach, so the start keeps that press too.
    expect(hitTest(covered(), 100, 100 - PIN_STEM_PX)).toEqual({ stepId: "", start: true });
  });

  it("are reached by their name where nothing else sits, ahead of the path under it", () => {
    expect(hitTest(covered(), 130, 90)).toEqual({ stepId: "", waypoint: "start" });
    const onPath = scene({ polylines: [{ stepId: "leg", xsPx: [0, 200], ysPx: [100, 100], ts: [0, 1] }], pins: [pin({ label: null })] });
    expect(hitTest(onPath, 100, 101)).toEqual({ stepId: "", waypoint: "start" });
    expect(hitTest(onPath, 150, 101)).toMatchObject({ stepId: "leg" });
  });

  it("keep a marker's press", () => {
    const withMarker = scene({ markers: [{ stepId: "leg", markerIndex: 0, xPx: 100, yPx: 98 }], pins: [pin()] });
    expect(hitTest(withMarker, 100, 98)).toEqual({ stepId: "leg", markerIndex: 0 });
  });

  it("take the press from everything once selected", () => {
    expect(hitTest(covered(true), 100, 100)).toEqual({ stepId: "", waypoint: "start" });
    expect(hitTest(covered(true), 100, 100 - PIN_STEM_PX)).toEqual({ stepId: "", waypoint: "start" });
    // Away from the selected pin, the rest of the field behaves as before.
    expect(hitTest(covered(true), 100, 50)).toMatchObject({ stepId: "driveOut" });
  });

  it("pick the nearest of two pins", () => {
    const two = scene({ pins: [pin({ label: null }), pin({ name: "scoreSouth", xPx: 108, label: null })] });
    expect(hitTest(two, 105, 100)).toEqual({ stepId: "", waypoint: "scoreSouth" });
    expect(hitTest(two, 102, 100)).toEqual({ stepId: "", waypoint: "start" });
  });
});
