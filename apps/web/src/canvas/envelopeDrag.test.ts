import type { Box2, Pose } from "@horizon36596/zenith-core";
import { describe, expect, it } from "vitest";
import { rectOfPolygon } from "../lib/envelopeRect.js";
import {
  cursorForGrab,
  dragEnvelopeRect,
  drawEnvelopeRect,
  envelopeRectLines,
  envelopeRectOf,
  projectEnvelopeBody,
  projectEnvelopeHandles,
  snapDrawStart,
} from "./envelopeDrag.js";
import { emptyHitScene, hitTest, type HitScene } from "./hit.js";
import { projectHitScene } from "./liveLayer.js";
import { NO_KEYS, resolveModifiers, type HeldKeys } from "./modifiers.js";
import { resolveLeader } from "./pointDrag.js";
import type { Scene } from "./scene.js";
import type { SnapContext } from "./snap.js";
import { orientationFor, type View } from "./view.js";

/**
 * Drawing, resizing and moving envelopes on the field (spec 13 section 10, issue #120): which
 * handles can be grabbed, what a press hits, where a dragged corner, side or whole rectangle goes
 * under each modifier, and what the bubble says. The rectangle math itself is
 * `lib/envelopeRect.test.ts`.
 */

const SQUARE = [
  { xIn: -48, yIn: -48 },
  { xIn: -24, yIn: -48 },
  { xIn: -24, yIn: -24 },
  { xIn: -48, yIn: -24 },
];

/** A scene with one command's envelope and no paths, which is all the corner helpers read. */
const scene: Scene = {
  steps: [],
  startPose: { xIn: 0, yIn: 0, headingRad: 0 },
  spans: [],
  totalS: null,
  envelopes: [{ stepId: "spin", polygonIn: SQUARE, maxDurationS: 3 }],
};

/** One pixel per inch, audience at the bottom: screen (x, -y). */
const view: View = { pxPerIn: 1, originXPx: 0, originYPx: 0, orientation: orientationFor("bottom") };

const BOUNDS: Box2 = { minXIn: -72, maxXIn: 72, minYIn: -72, maxYIn: 72 };
const square = (pose: Pose): Box2 => ({ minXIn: pose.xIn - 9, maxXIn: pose.xIn + 9, minYIn: pose.yIn - 9, maxYIn: pose.yIn + 9 });
const context = (overrides: Partial<SnapContext> = {}): SnapContext => ({
  enabled: true,
  altHeld: false,
  pxPerIn: 4,
  waypoints: [],
  bounds: BOUNDS,
  footprintBounds: square,
  ...overrides,
});
const keys = (held: Partial<HeldKeys> = {}): HeldKeys => ({ ...NO_KEYS, ...held });
const RECT = rectOfPolygon(SQUARE);


describe("projectEnvelopeHandles: the handles that can be grabbed", () => {
  it("lists the selected step's corners then side midpoints, in screen pixels", () => {
    const handles = projectEnvelopeHandles(scene, view, "none", { stepId: "spin" });
    expect(handles.map((entry) => entry.handle)).toEqual(["ne", "se", "sw", "nw", "n", "e", "s", "w"]);
    expect(handles.find((entry) => entry.handle === "sw")).toEqual({ stepId: "spin", handle: "sw", xPx: -48, yPx: 48 });
    expect(handles.find((entry) => entry.handle === "n")).toEqual({ stepId: "spin", handle: "n", xPx: -36, yPx: 24 });
  });

  it("lists nothing when the step is not selected, has no envelope, or its envelope is not a rectangle", () => {
    expect(projectEnvelopeHandles(scene, view, "none", {})).toEqual([]);
    expect(projectEnvelopeHandles(scene, view, "none", { stepId: "other" })).toEqual([]);
    const triangle: Scene = {
      ...scene,
      envelopes: [{ stepId: "spin", polygonIn: [{ xIn: 0, yIn: 0 }, { xIn: 10, yIn: 0 }, { xIn: 0, yIn: 10 }], maxDurationS: 3 }],
    };
    expect(projectEnvelopeHandles(triangle, view, "none", { stepId: "spin" })).toEqual([]);
    expect(projectEnvelopeBody(triangle, view, "none", { stepId: "spin" })).toBeNull();
    expect(envelopeRectOf(triangle, "spin")).toBeNull();
  });

  it("mirrors the handles with the routine when viewed as the other alliance", () => {
    const sw = projectEnvelopeHandles(scene, view, "pointSymmetry", { stepId: "spin" }).find((entry) => entry.handle === "sw");
    expect(sw).toMatchObject({ xPx: 48, yPx: -48 });
  });

  it("goes into the hit scene for the selected step only", () => {
    expect(projectHitScene(scene, view, "none", { stepId: "spin" }).envelopeHandles).toHaveLength(8);
    expect(projectHitScene(scene, view, "none", { stepId: "spin" }).envelopeBody?.stepId).toBe("spin");
    expect(projectHitScene(scene, view, "none", {}).envelopeHandles).toEqual([]);
    expect(projectHitScene(scene, view, "none", {}).envelopeBody).toBeNull();
  });

  it("gives each handle the resize cursor it faces on screen, mirrored or not", () => {
    const handles = projectEnvelopeHandles(scene, view, "none", { stepId: "spin" });
    // Audience at the bottom: north is up the screen, so the north-east corner is up and right.
    expect(cursorForGrab("ne", handles)).toBe("nesw-resize");
    expect(cursorForGrab("nw", handles)).toBe("nwse-resize");
    expect(cursorForGrab("n", handles)).toBe("ns-resize");
    expect(cursorForGrab("e", handles)).toBe("ew-resize");
    expect(cursorForGrab("move", handles)).toBe("move");
    // Turned a quarter: east is now up or down the screen.
    const turned: View = { ...view, orientation: orientationFor("left") };
    const sideways = projectEnvelopeHandles(scene, turned, "none", { stepId: "spin" });
    expect(cursorForGrab("e", sideways)).toBe("ns-resize");
    expect(cursorForGrab("n", sideways)).toBe("ew-resize");
  });
});

describe("hitTest: envelope handles, sides and inside", () => {
  const handles = projectEnvelopeHandles(scene, view, "none", { stepId: "spin" });
  const body = projectEnvelopeBody(scene, view, "none", { stepId: "spin" });
  const withEnvelope = (overrides: Partial<HitScene> = {}): HitScene => ({
    ...emptyHitScene(),
    envelopeHandles: handles,
    envelopeBody: body,
    ...overrides,
  });

  it("names the corner or side handle under the pointer, within the handle radius", () => {
    expect(hitTest(withEnvelope(), -46, 45)).toEqual({ stepId: "spin", envelopeHandle: "sw" });
    expect(hitTest(withEnvelope(), -36, 22)).toEqual({ stepId: "spin", envelopeHandle: "n" });
  });

  it("grabs a side anywhere along it, and the whole rectangle inside it", () => {
    // On the west side (x -48), well away from its midpoint handle and the corners.
    expect(hitTest(withEnvelope(), -50, 44 - 13)).toEqual({ stepId: "spin", envelopeHandle: "w" });
    expect(hitTest(withEnvelope(), -36, 36)).toEqual({ stepId: "spin", envelopeHandle: "move" });
    expect(hitTest(withEnvelope(), 0, 0)).toBeNull();
  });

  it("gives a path's own dot the press where the two overlap", () => {
    const handle = { stepId: "go", point: { segmentIndex: 0, pointKind: "to" as const }, xPx: -48, yPx: 48 };
    expect(hitTest(withEnvelope({ handles: [handle] }), -48, 48)).toEqual({ stepId: "go", point: handle.point });
  });

  it("beats a marker and a path at a handle, but a path beats the inside", () => {
    const marker = { stepId: "go", markerIndex: 0, xPx: -48, yPx: 48 };
    const polyline = { stepId: "go", xsPx: [-60, 0], ysPx: [36, 36], ts: [0, 1] };
    expect(hitTest(withEnvelope({ markers: [marker], polylines: [polyline] }), -48, 48)).toEqual({ stepId: "spin", envelopeHandle: "sw" });
    expect(hitTest(withEnvelope({ polylines: [polyline] }), -36, 36)).toMatchObject({ stepId: "go" });
  });
});

describe("dragEnvelopeRect: where a dragged handle takes the rectangle", () => {
  const press = { xIn: -24, yIn: -48 };

  it("moves a corner's two sides to the snapped pointer and keeps the opposite corner", () => {
    const result = dragEnvelopeRect(RECT, "se", press, { xIn: -20.23, yIn: -54.77 }, resolveModifiers(true, keys()), context());
    expect(result.rect).toEqual({ minXIn: -48, minYIn: -55, maxXIn: -20, maxYIn: -24 });
    expect(result.label).toBe("grid 0.5 in");
  });

  it("moves a side alone, whichever way the pointer strays along it", () => {
    const result = dragEnvelopeRect(RECT, "n", { xIn: -36, yIn: -24 }, { xIn: -10, yIn: -11.8 }, resolveModifiers(true, keys()), context());
    expect(result.rect).toEqual({ minXIn: -48, minYIn: -48, maxXIn: -24, maxYIn: -12 });
  });

  it("goes exactly where the pointer is with Ctrl over snap on, and lands on a waypoint with Alt", () => {
    const free = dragEnvelopeRect(RECT, "ne", press, { xIn: -20.23, yIn: -20.77 }, resolveModifiers(true, keys({ ctrl: true })), context());
    expect(free.rect.maxXIn).toBeCloseTo(-20.23);
    expect(free.label).toBe("snap off (Ctrl)");
    const waypoints = [{ name: "flower0", xIn: -20, yIn: -21 }];
    const onWaypoint = dragEnvelopeRect(RECT, "ne", press, { xIn: -20.3, yIn: -20.8 }, resolveModifiers(true, keys({ alt: true })), context({ waypoints }));
    expect(onWaypoint.rect).toEqual({ minXIn: -48, minYIn: -48, maxXIn: -20, maxYIn: -21 });
    expect(onWaypoint.label).toBe("waypoint flower0");
  });

  it("keeps a corner's aspect ratio with Shift", () => {
    const result = dragEnvelopeRect(RECT, "ne", press, { xIn: -12, yIn: -30 }, resolveModifiers(true, keys({ shift: true })), context());
    expect(result.rect).toEqual({ minXIn: -48, minYIn: -48, maxXIn: -12, maxYIn: -12 });
    expect(result.label).toBe("grid 0.5 in · aspect (Shift)");
  });

  it("flips over rather than inverting when dragged past the opposite side", () => {
    const result = dragEnvelopeRect(RECT, "e", press, { xIn: -60, yIn: -36 }, resolveModifiers(true, keys()), context());
    expect(result.rect).toEqual({ minXIn: -60, minYIn: -48, maxXIn: -48, maxYIn: -24 });
  });

  it("moves the whole rectangle by the corner nearest the press, snapped, keeping its size", () => {
    const result = dragEnvelopeRect(RECT, "move", { xIn: -46, yIn: -46 }, { xIn: -35.8, yIn: -41.1 }, resolveModifiers(true, keys()), context());
    // The south-west corner, nearest the press, goes from (-48, -48) to (-37.8, -43.1), then the grid.
    expect(result.rect).toEqual({ minXIn: -38, minYIn: -43, maxXIn: -14, maxYIn: -19 });
  });

  it("keeps a move on one axis with Shift", () => {
    const result = dragEnvelopeRect(RECT, "move", { xIn: -46, yIn: -46 }, { xIn: -30, yIn: -44 }, resolveModifiers(true, keys({ shift: true })), context());
    expect(result.rect).toEqual({ minXIn: -32, minYIn: -48, maxXIn: -8, maxYIn: -24 });
  });

  it("never rests against a wall, because a corner has no robot footprint", () => {
    const pointer = { xIn: 69.3, yIn: -30 };
    const modifiers = resolveModifiers(true, keys({ alt: true }));
    const asPoint = resolveLeader({ ...press, headingRad: 0 }, pointer, modifiers, context());
    expect(asPoint.snap.kind).toBe("wall");
    const asSide = dragEnvelopeRect(RECT, "e", press, pointer, modifiers, context());
    expect(asSide.rect.maxXIn).toBe(69.3);
    expect(asSide.snap?.kind).toBe("none");
  });
});

describe("drawEnvelopeRect: drawing a new envelope corner to corner", () => {
  it("snaps both corners and normalises whichever way the drag went", () => {
    const from = snapDrawStart({ xIn: 10.2, yIn: 20.1 }, resolveModifiers(true, keys()), context());
    expect(from).toEqual({ xIn: 10, yIn: 20 });
    const result = drawEnvelopeRect(from, { xIn: -5.1, yIn: 4.2 }, resolveModifiers(true, keys()), context());
    expect(result.rect).toEqual({ minXIn: -5, minYIn: 4, maxXIn: 10, maxYIn: 20 });
  });

  it("draws a square with Shift", () => {
    const result = drawEnvelopeRect({ xIn: 0, yIn: 0 }, { xIn: 10, yIn: -4 }, resolveModifiers(true, keys({ shift: true })), context());
    expect(result.rect).toEqual({ minXIn: 0, minYIn: -10, maxXIn: 10, maxYIn: 0 });
    expect(result.label).toBe("grid 0.5 in · square (Shift)");
  });
});

describe("envelopeRectLines: the bubble beside a handle", () => {
  it("says where the rectangle is, how big, which handle, and what a drag does, on hover", () => {
    expect(envelopeRectLines("spin", RECT, "sw", null, 3)).toEqual([
      "x −48.00  y −48.00  24.00 × 24.00 in",
      "spin · envelope south-west corner · 3.0 s · drag to resize",
    ]);
  });

  it("says which snap is acting during a drag or a draw", () => {
    expect(envelopeRectLines("spin", RECT, "move", { label: "grid 0.5 in" })[1]).toBe("spin · envelope · grid 0.5 in");
    expect(envelopeRectLines("spin", RECT, "draw", { label: null })[1]).toBe("spin · new envelope · no snap");
  });
});