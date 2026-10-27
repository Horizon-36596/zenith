/**
 * The routine's start mark can be pressed and dragged (`FieldCanvas.tsx`, drag kind "start"). A
 * fresh auto chains its first step from `"current"`, whose dot is never listed, so without the mark
 * there would be nothing at the start to grab. The mark sits in the point tier of `hitTest`: a path
 * dot on top of it keeps the press unless the pointer is strictly nearer to the mark, and it beats
 * markers and the path. The exception is a path's first point that sits on the start, as in the
 * starter autos where both follow the start waypoint: the mark takes that press and a start drag
 * carries the point (issue #133). `projectHitScene` puts the mark where `drawStartEnd` paints it,
 * mirror included.
 *
 * While the start is hovered or selected, its heading knob is drawn and listed too. The knob is in
 * the heading-handle tier: it beats the mark where their targets meet, and turning it writes the
 * bearing from the start to the pointer in the file's own frame, whatever the view's mirror.
 */
import { mirrorVec, type Finding, type MirrorMode } from "@horizon36596/zenith-core";
import { describe, expect, it } from "vitest";
import { emptyHitScene, HANDLE_HIT_PX, hitTest, type HitScene } from "./hit.js";
import { projectHitScene, START_KNOB_PX, startKnobScreen, startMarkTone } from "./liveLayer.js";
import { NO_KEYS, resolveModifiers } from "./modifiers.js";
import { headingDrag } from "./pointDrag.js";
import { pointsOnStart, type Scene, type SceneStep } from "./scene.js";
import type { PointTarget } from "./types.js";
import { orientationFor, screenToWorld, type View } from "./view.js";

const to: PointTarget = { segmentIndex: 0, pointKind: "to" };

const hitScene = (overrides: Partial<HitScene> = {}): HitScene => ({
  ...emptyHitScene(),
  start: { xPx: 0, yPx: 0 },
  polylines: [{ stepId: "leg", xsPx: [0, 100], ysPx: [0, 0], ts: [0, 1] }],
  ...overrides,
});

describe("hitTest on the start mark", () => {
  it("hits the mark within the point handle radius, and says it is the start", () => {
    expect(hitTest(hitScene(), 3, 4)).toEqual({ stepId: "", start: true });
    expect(hitTest(hitScene(), 0, HANDLE_HIT_PX)).toEqual({ stepId: "", start: true });
  });

  it("does not reach past the radius", () => {
    expect(hitTest(hitScene({ polylines: [] }), HANDLE_HIT_PX + 1, 0)).toBeNull();
  });

  it("beats the path and a marker it sits on", () => {
    const scene = hitScene({ markers: [{ stepId: "leg", markerIndex: 0, xPx: 1, yPx: 0 }] });
    expect(hitTest(scene, 1, 0)).toEqual({ stepId: "", start: true });
  });

  it("gives a dot drawn exactly on the mark the press", () => {
    const scene = hitScene({ handles: [{ stepId: "leg", point: to, xPx: 0, yPx: 0 }] });
    expect(hitTest(scene, 2, 0)).toEqual({ stepId: "leg", point: to });
  });

  it("gives the press to the mark when the pointer is nearer to it than to a dot", () => {
    const scene = hitScene({ handles: [{ stepId: "leg", point: to, xPx: 8, yPx: 0 }] });
    expect(hitTest(scene, 1, 0)).toEqual({ stepId: "", start: true });
    expect(hitTest(scene, 6, 0)).toEqual({ stepId: "leg", point: to });
  });

  it("lets a nearer heading handle win, as it does over a dot", () => {
    const scene = hitScene({ headingHandles: [{ stepId: "leg", key: "start", editable: true, xPx: 6, yPx: 0 }] });
    expect(hitTest(scene, 5, 0)).toEqual({ stepId: "leg", headingHandle: "start" });
    expect(hitTest(scene, 1, 0)).toEqual({ stepId: "", start: true });
  });

  it("is absent from a scene without a start, which hits nothing there", () => {
    expect(hitTest({ ...emptyHitScene() }, 0, 0)).toBeNull();
  });

  it("takes the press from a path's first point that sits on it, which a start drag carries (issue #133)", () => {
    const from: PointTarget = { segmentIndex: 0, pointKind: "from" };
    const scene = hitScene({ handles: [{ stepId: "leg", point: from, xPx: 0, yPx: 0, onStart: true }] });
    expect(hitTest(scene, 2, 0)).toEqual({ stepId: "", start: true });
    expect(hitTest(scene, 0, 0)).toEqual({ stepId: "", start: true });
  });
});

describe("the path points that sit on the start (issue #133)", () => {
  const view: View = { pxPerIn: 1, originXPx: 0, originYPx: 0, orientation: orientationFor("bottom") };
  const from: PointTarget = { segmentIndex: 0, pointKind: "from" };
  // The starter autos: the start and the first path both follow the start waypoint, so the path's
  // first dot is drawn exactly on the start mark.
  const step = (stepId: string, fromIn: { xIn: number; yIn: number }, chained = false): SceneStep => ({
    stepId,
    kind: "path",
    poses: [
      { ...fromIn, headingRad: 0 },
      { xIn: 40, yIn: 4, headingRad: 0 },
    ],
    ts: [0, 1],
    sIns: [0, 30],
    lengthIn: 30,
    handles: [
      { target: from, poseIn: { ...fromIn, headingRad: 1.5708 }, chained },
      { target: to, poseIn: { xIn: 40, yIn: 4, headingRad: 0 }, chained: false },
    ],
    controls: [],
    markers: [],
    polygons: [],
    nodes: [],
    timesS: null,
    highlights: [],
  });
  const scene: Scene = {
    steps: [step("driveOut", { xIn: 10, yIn: 4 }), step("chained", { xIn: 10, yIn: 4 }, true), step("elsewhere", { xIn: 30, yIn: 4 })],
    startPose: { xIn: 10, yIn: 4, headingRad: 1.5708 },
    spans: [],
    totalS: null,
  };

  it("are the first points, not written as \"current\", on the start's own spot", () => {
    expect(pointsOnStart(scene)).toEqual([{ stepId: "driveOut", point: from }]);
  });

  it("give the press to the start mark when the start can be dragged, and keep it otherwise", () => {
    const draggable = projectHitScene(scene, view, "none", {}, null, false, true);
    expect(draggable.handles.find((entry) => entry.stepId === "driveOut" && entry.point.pointKind === "from")?.onStart).toBe(true);
    expect(hitTest(draggable, 10, -4)).toEqual({ stepId: "", start: true });

    // A canvas that cannot drag the start (a proposal or a review) leaves the dot its press.
    const fixed = projectHitScene(scene, view, "none", {});
    expect(hitTest(fixed, 10, -4)).toEqual({ stepId: "driveOut", point: from });
  });
});

describe("projectHitScene lists the start mark", () => {
  const view: View = { pxPerIn: 1, originXPx: 0, originYPx: 0, orientation: orientationFor("bottom") };

  // A fresh auto: one step chained from "current", so its start has no dot of its own.
  const leg: SceneStep = {
    stepId: "leg",
    kind: "path",
    poses: [
      { xIn: 10, yIn: 4, headingRad: 0 },
      { xIn: 40, yIn: 4, headingRad: 0 },
    ],
    ts: [0, 1],
    sIns: [0, 30],
    lengthIn: 30,
    handles: [
      { target: { segmentIndex: 0, pointKind: "from" }, poseIn: { xIn: 10, yIn: 4, headingRad: 0 }, chained: true },
      { target: to, poseIn: { xIn: 40, yIn: 4, headingRad: 0 }, chained: false },
    ],
    controls: [],
    markers: [],
    polygons: [],
    nodes: [],
    timesS: null,
    highlights: [],
  };
  const scene: Scene = { steps: [leg], startPose: { xIn: 10, yIn: 4, headingRad: 0.5 }, spans: [], totalS: null };

  it("puts the mark where the chained start is, so the start is grabbable on a fresh auto", () => {
    const hit = projectHitScene(scene, view, "none", {});
    expect(hit.start).toEqual({ xPx: 10, yPx: -4 });
    expect(hit.handles.map((entry) => entry.point.pointKind)).toEqual(["to"]);
    expect(hitTest(hit, 11, -4)).toEqual({ stepId: "", start: true });
  });

  it("mirrors the mark with the view, and the pointer un-mirrors back to the file's start", () => {
    for (const mode of ["none", "pointSymmetry", "mirrorX", "mirrorY"] as const satisfies readonly MirrorMode[]) {
      const at = projectHitScene(scene, view, mode, {}).start;
      if (at === null || at === undefined) throw new Error("expected a start mark");
      const drawn = mirrorVec(scene.startPose, mode);
      expect(at.xPx).toBeCloseTo(drawn.xIn, 9);
      expect(at.yPx).toBeCloseTo(-drawn.yIn, 9);
      // FieldCanvas's toWorld: screenToWorld, then the same mirror, which is its own inverse.
      const back = mirrorVec(screenToWorld(view, at), mode);
      expect(back.xIn).toBeCloseTo(10, 9);
      expect(back.yIn).toBeCloseTo(4, 9);
    }
  });
});

describe("the start's heading knob", () => {
  const knobScene = (overrides: Partial<HitScene> = {}): HitScene =>
    hitScene({ startKnob: { xPx: START_KNOB_PX, yPx: 0 }, ...overrides });

  it("is hit near its tip, and beats the start mark where the two targets meet", () => {
    expect(hitTest(knobScene(), START_KNOB_PX + 2, 1)).toEqual({ stepId: "", startKnob: true });
    expect(hitTest(knobScene(), START_KNOB_PX / 2, 0)).toEqual({ stepId: "", startKnob: true });
    expect(hitTest(knobScene(), 3, 0)).toEqual({ stepId: "", start: true });
  });

  it("is not listed, so not hit, while it is not drawn", () => {
    expect(hitTest(hitScene({ polylines: [] }), START_KNOB_PX, 0)).toBeNull();
  });

  it("does not take a press from a nearer path dot or a nearer step arrow", () => {
    const dotScene = knobScene({ handles: [{ stepId: "leg", point: to, xPx: START_KNOB_PX + 6, yPx: 0 }] });
    expect(hitTest(dotScene, START_KNOB_PX + 5, 0)).toEqual({ stepId: "leg", point: to });
    const arrowScene = knobScene({ headingHandles: [{ stepId: "leg", key: "end", editable: true, xPx: START_KNOB_PX + 6, yPx: 0 }] });
    expect(hitTest(arrowScene, START_KNOB_PX + 5, 0)).toEqual({ stepId: "leg", headingHandle: "end" });
    expect(hitTest(arrowScene, START_KNOB_PX + 1, 0)).toEqual({ stepId: "", startKnob: true });
  });

  it("is listed by projectHitScene only when asked, at the tip along the start's heading", () => {
    const view: View = { pxPerIn: 1, originXPx: 0, originYPx: 0, orientation: orientationFor("bottom") };
    const scene: Scene = { steps: [], startPose: { xIn: 0, yIn: 0, headingRad: Math.PI / 2 }, spans: [], totalS: null };
    expect(projectHitScene(scene, view, "none", {}).startKnob).toBeNull();
    const tip = projectHitScene(scene, view, "none", {}, null, true).startKnob;
    // Heading +y is up the screen with the audience at the bottom, and screen y grows downward.
    expect(tip?.xPx).toBeCloseTo(0, 9);
    expect(tip?.yPx).toBeCloseTo(-START_KNOB_PX, 9);
  });

  it("turns to the file-frame heading the knob is drawn at, in every mirror", () => {
    const view: View = { pxPerIn: 4, originXPx: 300, originYPx: 300, orientation: orientationFor("bottom") };
    const startIn = { xIn: 20, yIn: -40, headingRad: 0 };
    const context = {
      enabled: true,
      altHeld: false,
      pxPerIn: 4,
      waypoints: [],
      bounds: { minXIn: -72, maxXIn: 72, minYIn: -72, maxYIn: 72 },
      footprintBounds: () => null,
    };
    for (const mode of ["none", "pointSymmetry", "mirrorX", "mirrorY"] as const satisfies readonly MirrorMode[]) {
      for (const wantedRad of [Math.PI / 4, (2 * Math.PI) / 3, -Math.PI / 6]) {
        // Drawn at `wantedRad`, the knob's tip is where the pointer grabs and turns it; turning it
        // there must write `wantedRad` back, in the file's own frame.
        const { tip } = startKnobScreen(view, mode, { ...startIn, headingRad: wantedRad });
        const pointerIn = mirrorVec(screenToWorld(view, tip), mode);
        const free = headingDrag(startIn, pointerIn, resolveModifiers(true, { ...NO_KEYS, alt: true }), context);
        expect(Math.cos(free.headingRad - wantedRad), `${mode} ${String(wantedRad)}`).toBeCloseTo(1, 9);
      }
    }
  });

  it("snaps to 15 degree steps by default, 45 with Shift, and is free with Alt", () => {
    const context = {
      enabled: true,
      altHeld: false,
      pxPerIn: 4,
      waypoints: [],
      bounds: { minXIn: -72, maxXIn: 72, minYIn: -72, maxYIn: 72 },
      footprintBounds: () => null,
    };
    const startIn = { xIn: 0, yIn: 0, headingRad: 0 };
    const pointer = { xIn: Math.cos(0.3), yIn: Math.sin(0.3) };
    const deg = (rad: number): number => (rad * 180) / Math.PI;
    expect(deg(headingDrag(startIn, pointer, resolveModifiers(true, NO_KEYS), context).headingRad)).toBeCloseTo(15, 9);
    expect(deg(headingDrag(startIn, pointer, resolveModifiers(true, { ...NO_KEYS, shift: true }), context).headingRad)).toBeCloseTo(0, 9);
    expect(headingDrag(startIn, pointer, resolveModifiers(true, { ...NO_KEYS, alt: true }), context).headingRad).toBeCloseTo(0.3, 9);
  });
});

describe("the start mark's colour (issue #155)", () => {
  const finding = (code: Finding["code"]): Finding => ({ severity: "error", stepId: "start", code, message: "test" });

  it("is the error colour while START_ILLEGAL stands, and the normal one otherwise", () => {
    expect(startMarkTone([finding("START_ILLEGAL")])).toBe("error");
    expect(startMarkTone([finding("CAPACITY")])).toBe("normal");
    expect(startMarkTone([])).toBe("normal");
  });
});
