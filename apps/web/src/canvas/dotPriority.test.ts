/**
 * Any path's dot can be pressed and dragged, not only the selected step's (UI_GUIDE 9.11): the hit
 * scene lists every step's endpoints, and where dots overlap the one on top wins, the selected step
 * first and then the step drawn last. Control points stay grabbable only where they are drawn.
 */
import { describe, expect, it } from "vitest";
import { emptyHitScene, handleRank, HANDLE_HIT_PX, hitTest, topHandle, type HandleEntry } from "./hit.js";
import { projectHitScene } from "./liveLayer.js";
import type { Scene, SceneStep } from "./scene.js";
import type { PointTarget } from "./types.js";
import { orientationFor, type View } from "./view.js";

const to: PointTarget = { segmentIndex: 0, pointKind: "to" };
const from: PointTarget = { segmentIndex: 0, pointKind: "from" };
const control: PointTarget = { segmentIndex: 0, pointKind: "control", controlIndex: 0 };

const dot = (stepId: string, xPx: number, rank?: number, point: PointTarget = to): HandleEntry => ({
  stepId,
  point,
  xPx,
  yPx: 0,
  ...(rank === undefined ? {} : { rank }),
});

describe("topHandle: which dot is on top", () => {
  it("is nearest-wins among dots of one rank, as before", () => {
    expect(topHandle([dot("a", 0), dot("b", 4)], 3, 0, HANDLE_HIT_PX)?.stepId).toBe("b");
    expect(topHandle([dot("a", 0), dot("b", 4)], 1, 0, HANDLE_HIT_PX)?.stepId).toBe("a");
  });

  it("gives an overlap to the step drawn last, even when an earlier step's dot is nearer", () => {
    const dots = [dot("first", 0, handleRank(0, false)), dot("second", 6, handleRank(1, false))];
    expect(topHandle(dots, 1, 0, HANDLE_HIT_PX)?.stepId).toBe("second");
  });

  it("gives an overlap to the selected step over any step drawn after it", () => {
    const dots = [dot("selected", 6, handleRank(0, true)), dot("later", 0, handleRank(5, false))];
    expect(topHandle(dots, 0, 0, HANDLE_HIT_PX)?.stepId).toBe("selected");
  });

  it("never reaches past the hit radius, whatever the rank", () => {
    const dots = [dot("near", 2, handleRank(0, false)), dot("selected", HANDLE_HIT_PX + 1, handleRank(1, true))];
    expect(topHandle(dots, 0, 0, HANDLE_HIT_PX)?.stepId).toBe("near");
    expect(topHandle([dot("selected", HANDLE_HIT_PX + 1, handleRank(1, true))], 0, 0, HANDLE_HIT_PX)).toBeNull();
  });

  it("is what hitTest uses, so a dot on top beats the path it sits on", () => {
    const scene = {
      ...emptyHitScene(),
      handles: [dot("first", 0, handleRank(0, false)), dot("second", 5, handleRank(1, false))],
      polylines: [{ stepId: "first", xsPx: [-50, 50], ysPx: [0, 0], ts: [0, 1] }],
    };
    expect(hitTest(scene, 2, 0)).toEqual({ stepId: "second", point: to });
    expect(hitTest(scene, -30, 0)).toMatchObject({ stepId: "first", t: 0.2 });
  });
});

describe("projectHitScene lists every path's dots", () => {
  const view: View = { pxPerIn: 1, originXPx: 0, originYPx: 0, orientation: orientationFor("bottom") };

  const step = (stepId: string, startXIn: number, xIn: number, chainedStart: boolean): SceneStep => ({
    stepId,
    kind: "path",
    poses: [
      { xIn: startXIn, yIn: 0, headingRad: 0 },
      { xIn, yIn: 0, headingRad: 0 },
    ],
    ts: [0, 1],
    sIns: [0, xIn - startXIn],
    lengthIn: xIn - startXIn,
    handles: [
      { target: from, poseIn: { xIn: startXIn, yIn: 0, headingRad: 0 }, chained: chainedStart },
      { target: to, poseIn: { xIn, yIn: 0, headingRad: 0 }, chained: false },
    ],
    controls: [{ target: control, pointIn: { xIn: (startXIn + xIn) / 2, yIn: 5 }, anchorIn: { xIn: startXIn, yIn: 0 }, anchorsIn: [{ xIn: startXIn, yIn: 0 }] }],
    markers: [],
    polygons: [],
    nodes: [],
    timesS: null,
    highlights: [],
  });

  // `a` ends where `b` starts; `b` starts at "current", so that joint is `a`'s dot alone.
  const scene: Scene = {
    steps: [step("a", 0, 10, false), step("b", 10, 40, true)],
    startPose: { xIn: 0, yIn: 0, headingRad: 0 },
    spans: [],
    totalS: null,
  };

  const listed = (hit: ReturnType<typeof projectHitScene>, stepId: string): string[] =>
    hit.handles.filter((entry) => entry.stepId === stepId).map((entry) => entry.point.pointKind);

  it("lists the endpoints of steps that are not selected, but not their control points", () => {
    const hit = projectHitScene(scene, view, "none", {});
    expect(listed(hit, "a")).toEqual(["from", "to"]);
    expect(listed(hit, "b")).toEqual(["to"]);
    expect(hit.headingHandles).toEqual([]);
  });

  it("lists a step's control points once it is selected, or while the pointer is over it", () => {
    expect(listed(projectHitScene(scene, view, "none", { stepId: "b" }), "b")).toEqual(["to", "control"]);
    expect(listed(projectHitScene(scene, view, "none", {}, "b"), "b")).toEqual(["to", "control"]);
    expect(listed(projectHitScene(scene, view, "none", {}, "b"), "a")).toEqual(["from", "to"]);
  });

  it("ranks the selected step above the others and later steps above earlier ones", () => {
    const rankOf = (hit: ReturnType<typeof projectHitScene>, stepId: string): number =>
      hit.handles.find((entry) => entry.stepId === stepId)?.rank ?? Number.NaN;
    const none = projectHitScene(scene, view, "none", {});
    expect(rankOf(none, "b")).toBeGreaterThan(rankOf(none, "a"));
    const aSelected = projectHitScene(scene, view, "none", { stepId: "a" });
    expect(rankOf(aSelected, "a")).toBeGreaterThan(rankOf(aSelected, "b"));
  });

  it("grabs the joint as the earlier step's end, and a dot on the later step's end directly", () => {
    const hit = projectHitScene(scene, view, "none", {});
    expect(hitTest(hit, 10, 0)).toEqual({ stepId: "a", point: to });
    expect(hitTest(hit, 40, 0)).toEqual({ stepId: "b", point: to });
  });
});
