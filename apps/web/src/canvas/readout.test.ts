/**
 * Polish item (earlier integration pass): the corner readout in `FieldCanvas.tsx`'s `updateHover`
 * must show the pose under the cursor, heading included, while hovering a path — not only while
 * dragging a handle. `updateHover` wires three pure pieces together: `hitTest` (is the pointer over
 * a path, and at what arc-length `t`), `poseAtT` (the pose at that `t`) and `degrees` (the UI's
 * radians-to-degrees boundary, UI_GUIDE section 5 — files are radians, the screen is degrees). This
 * test exercises that same chain directly, without a DOM, the way `hit.test.ts` already exercises
 * `hitTest` alone.
 */
import { describe, expect, it } from "vitest";
import { hitTest, type HitScene, type PolylineEntry } from "./hit.js";
import { poseAtT, type SceneStep } from "./scene.js";
import { degrees } from "../lib/format.js";

/** A 20 in straight run whose heading turns from 0 to 90 deg over its length, screen == world. */
const step: SceneStep = {
  stepId: "driveOut",
  kind: "path",
  poses: [
    { xIn: 0, yIn: 0, headingRad: 0 },
    { xIn: 20, yIn: 0, headingRad: Math.PI / 2 },
  ],
  ts: [0, 1],
  sIns: [0, 20],
  lengthIn: 20,
  handles: [],
  controls: [],
  markers: [],
  polygons: [],
  nodes: [],
  timesS: null,
  highlights: [],
};

const polyline: PolylineEntry = { stepId: step.stepId, xsPx: [0, 20], ysPx: [0, 0], ts: step.ts };
const hitScene: HitScene = { handles: [], markers: [], polylines: [polyline] };

describe("the coordinate readout's hover chain (hitTest -> poseAtT -> degrees)", () => {
  it("reports the interpolated heading, in degrees, at the hovered point of a path", () => {
    const hit = hitTest(hitScene, 10, 0);
    expect(hit).not.toBeNull();
    expect(hit?.t).toBeCloseTo(0.5, 9);

    const pose = poseAtT(step, hit?.t as number);
    expect(pose.xIn).toBeCloseTo(10, 9);
    expect(pose.yIn).toBeCloseTo(0, 9);
    expect(pose.headingRad).toBeCloseTo(Math.PI / 4, 9);
    expect(degrees(pose.headingRad)).toBe("45.0");
  });

  it("tracks the heading continuously along the path, not just at its endpoints", () => {
    const nearEnd = hitTest(hitScene, 19, 0);
    const pose = poseAtT(step, nearEnd?.t as number);
    expect(Number(degrees(pose.headingRad))).toBeGreaterThan(45);
    expect(Number(degrees(pose.headingRad))).toBeLessThan(90);
  });

  it("finds nothing to report once the pointer leaves the path's hit tolerance", () => {
    // 6 px is `PATH_HIT_PX`; 8 px away is a miss, which is what makes `updateHover` clear the
    // readout's heading back to null instead of leaving the last value stale.
    expect(hitTest(hitScene, 10, 8)).toBeNull();
  });
});
