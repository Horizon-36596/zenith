/**
 * The canvas mirrors iff the viewed alliance differs from the file's own `alliance`
 * (`shouldMirror`), and by the field's own declared `frame.mirror` kind (finding 22) — not always
 * point symmetry. `apps/web/src/canvas/view.ts` no longer carries its own hardcoded mirror math
 * (deleted, per the finding's fix); `liveLayer.ts`'s `project`/`projectPose` now call
 * `@horizon36596/zenith-core`'s `mirrorVec`/`mirrorHeadingRad` directly, the same functions `packages/core`'s
 * `render` uses for the PR body and `--png`, so the two renderers can no longer disagree about which
 * transform a field asks for.
 *
 * This exercises `projectHitScene` (`liveLayer.ts`), the exported function `FieldCanvas.tsx` calls
 * to turn the document into screen pixels for hit-testing: the same code path a hover or a drag
 * runs through. A view with `pxPerIn: 1` and the origin at (0, 0) makes the screen math easy to
 * hand-check for every `MirrorMode`.
 */
import { describe, expect, it } from "vitest";
import { mirrorVec, type MirrorMode } from "@horizon36596/zenith-core";
import { orientationFor, screenToWorld, type View } from "./view.js";
import { projectHitScene } from "./liveLayer.js";
import type { Scene, SceneStep } from "./scene.js";

const view: View = {
  pxPerIn: 1,
  originXPx: 0,
  originYPx: 0,
  orientation: orientationFor("bottom"), // +x right, +y up the screen: screen = (xIn, -yIn).
};

const step: SceneStep = {
  stepId: "leg",
  kind: "path",
  poses: [{ xIn: 10, yIn: 4, headingRad: 0 }],
  ts: [0],
  sIns: [0],
  lengthIn: 0,
  handles: [],
  controls: [],
  markers: [],
  polygons: [],
  nodes: [],
  timesS: null,
  highlights: [],
};

const scene = (): Scene => ({
  steps: [step],
  startPose: { xIn: 0, yIn: 0, headingRad: 0 },
  spans: [],
  totalS: null,
});

/** The first (only) vertex of the one polyline `projectHitScene` produces for `step`. */
function firstVertex(mirror: MirrorMode): { xPx: number; yPx: number } {
  const hitScene = projectHitScene(scene(), view, mirror, {});
  const polyline = hitScene.polylines[0];
  if (polyline === undefined) throw new Error("expected one polyline");
  return { xPx: polyline.xsPx[0] as number, yPx: polyline.ysPx[0] as number };
}

describe("the canvas mirrors by the field's own frame.mirror kind, not always point symmetry", () => {
  it("draws the file's pose unmoved when not mirrored", () => {
    expect(firstVertex("none")).toEqual({ xPx: 10, yPx: -4 });
  });

  it("negates both axes for pointSymmetry", () => {
    expect(firstVertex("pointSymmetry")).toEqual({ xPx: -10, yPx: 4 });
  });

  it("negates only y (the field's own axis) for mirrorX, not both", () => {
    const mirrorX = firstVertex("mirrorX");
    expect(mirrorX).toEqual({ xPx: 10, yPx: 4 });
    expect(mirrorX).not.toEqual(firstVertex("pointSymmetry"));
  });

  it("negates only x for mirrorY, not both", () => {
    const mirrorY = firstVertex("mirrorY");
    expect(mirrorY).toEqual({ xPx: -10, yPx: -4 });
    expect(mirrorY).not.toEqual(firstVertex("pointSymmetry"));
  });

  it("un-mirrors on the way back out, the way FieldCanvas.tsx's toWorld does", () => {
    // toWorld is screenToWorld followed by mirrorVec with the same mode: the pointer only ever
    // hands the shell a pose in the file's own frame, whichever alliance is being viewed.
    for (const mode of ["none", "pointSymmetry", "mirrorX", "mirrorY"] as const) {
      const vertex = firstVertex(mode);
      const roundTripped = mirrorVec(screenToWorld(view, vertex), mode);
      expect(roundTripped.xIn).toBeCloseTo(10, 9);
      expect(roundTripped.yIn).toBeCloseTo(4, 9);
    }
  });
});
