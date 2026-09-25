import { describe, expect, it } from "vitest";
import {
  expandBounds,
  fitView,
  headingToScreenAngle,
  layoutPane,
  orientationFor,
  panBy,
  scaleBarInches,
  screenToWorld,
  worldToScreen,
  zoomAbout,
  MAX_PX_PER_IN,
  type PaneSize,
} from "./view.js";

const FIELD = { minXIn: -72, maxXIn: 72, minYIn: -72, maxYIn: 72 };
const bottom = orientationFor("bottom");

describe("world and screen", () => {
  it("round-trips every point through the transform", () => {
    const view = fitView(FIELD, 900, 600, 24, bottom);
    for (const point of [
      { xIn: 0, yIn: 0 },
      { xIn: -72, yIn: 72 },
      { xIn: 13.25, yIn: -41.5 },
    ]) {
      const back = screenToWorld(view, worldToScreen(view, point));
      expect(back.xIn).toBeCloseTo(point.xIn, 9);
      expect(back.yIn).toBeCloseTo(point.yIn, 9);
    }
  });

  it("round-trips in every audience placement", () => {
    for (const at of ["bottom", "top", "left", "right"] as const) {
      const view = fitView(FIELD, 800, 800, 10, orientationFor(at));
      const back = screenToWorld(view, worldToScreen(view, { xIn: 30, yIn: -12 }));
      expect(back.xIn).toBeCloseTo(30, 9);
      expect(back.yIn).toBeCloseTo(-12, 9);
    }
  });

  it("puts +Y up the screen when the audience is at the bottom", () => {
    const view = fitView(FIELD, 600, 600, 0, bottom);
    const origin = worldToScreen(view, { xIn: 0, yIn: 0 });
    const away = worldToScreen(view, { xIn: 0, yIn: 24 });
    const right = worldToScreen(view, { xIn: 24, yIn: 0 });
    expect(away.yPx).toBeLessThan(origin.yPx);
    expect(right.xPx).toBeGreaterThan(origin.xPx);
  });

  it("turns a counter-clockwise world heading into a clockwise screen angle", () => {
    const view = fitView(FIELD, 600, 600, 0, bottom);
    expect(headingToScreenAngle(view, 0)).toBeCloseTo(0, 9);
    expect(headingToScreenAngle(view, Math.PI / 2)).toBeCloseTo(-Math.PI / 2, 9);
  });
});

describe("fit, pan and zoom", () => {
  it("fits the field inside the element with the padding to spare", () => {
    const view = fitView(FIELD, 900, 600, 24, bottom);
    const corners = [
      worldToScreen(view, { xIn: -72, yIn: -72 }),
      worldToScreen(view, { xIn: 72, yIn: 72 }),
    ];
    const minY = Math.min(...corners.map((corner) => corner.yPx));
    const maxY = Math.max(...corners.map((corner) => corner.yPx));
    expect(minY).toBeCloseTo(24, 6);
    expect(maxY).toBeCloseTo(576, 6);
    // Centred on the long axis.
    expect(worldToScreen(view, { xIn: 0, yIn: 0 }).xPx).toBeCloseTo(450, 6);
  });

  it("shows the whole field and its margin in a pane of any shape", () => {
    const margin = expandBounds(FIELD, 10);
    for (const [widthPx, heightPx] of [
      [1200, 760],
      [640, 900],
      [900, 220],
    ] as const) {
      const view = fitView(margin, widthPx, heightPx, 16, bottom);
      for (const corner of [
        { xIn: -72, yIn: -72 },
        { xIn: 72, yIn: -72 },
        { xIn: -72, yIn: 72 },
        { xIn: 72, yIn: 72 },
      ]) {
        const screen = worldToScreen(view, corner);
        expect(screen.xPx).toBeGreaterThanOrEqual(0);
        expect(screen.yPx).toBeGreaterThanOrEqual(0);
        expect(screen.xPx).toBeLessThanOrEqual(widthPx);
        expect(screen.yPx).toBeLessThanOrEqual(heightPx);
      }
    }
  });

  it("keeps a margin outside the field for a robot outline against the wall", () => {
    const view = fitView(expandBounds(FIELD, 10), 900, 600, 16, bottom);
    const edge = worldToScreen(view, { xIn: 0, yIn: 72 });
    const beyond = worldToScreen(view, { xIn: 0, yIn: 80 });
    expect(beyond.yPx).toBeGreaterThan(0);
    expect(edge.yPx).toBeGreaterThan(beyond.yPx);
  });

  it("keeps the world point under the cursor fixed while zooming", () => {
    const view = fitView(FIELD, 900, 600, 24, bottom);
    const anchor = { xPx: 312, yPx: 188 };
    const before = screenToWorld(view, anchor);
    const zoomed = zoomAbout(view, anchor, 1.8);
    const after = screenToWorld(zoomed, anchor);
    expect(zoomed.pxPerIn).toBeGreaterThan(view.pxPerIn);
    expect(after.xIn).toBeCloseTo(before.xIn, 9);
    expect(after.yIn).toBeCloseTo(before.yIn, 9);
  });

  it("clamps zoom and reports the same view when it is already at the stop", () => {
    const view = fitView(FIELD, 900, 600, 24, bottom);
    const far = zoomAbout(view, { xPx: 0, yPx: 0 }, 1e6);
    expect(far.pxPerIn).toBe(MAX_PX_PER_IN);
    expect(zoomAbout(far, { xPx: 0, yPx: 0 }, 2)).toBe(far);
  });

  it("pans by screen pixels without changing the zoom", () => {
    const view = fitView(FIELD, 900, 600, 24, bottom);
    const panned = panBy(view, 40, -15);
    expect(panned.pxPerIn).toBe(view.pxPerIn);
    const before = worldToScreen(view, { xIn: 10, yIn: 10 });
    const after = worldToScreen(panned, { xIn: 10, yIn: 10 });
    expect(after.xPx - before.xPx).toBeCloseTo(40, 9);
    expect(after.yPx - before.yPx).toBeCloseTo(-15, 9);
  });

  it("picks a round scale bar that fits", () => {
    expect(scaleBarInches(4, 140)).toBe(24);
    expect(scaleBarInches(0.8, 140)).toBe(144);
  });
});

describe("laying the view out for the pane", () => {
  const fit = (size: PaneSize) => fitView(FIELD, size.widthPx, size.heightPx, 24, bottom);
  const tall: PaneSize = { widthPx: 900, heightPx: 600 };
  // The status strip timing out hands its 28 px row back to the canvas.
  const taller: PaneSize = { widthPx: 900, heightPx: 628 };

  it("refits an unadjusted view to the new size", () => {
    const start = layoutPane(null, tall, false, false, fit);
    const next = layoutPane(start, taller, false, false, fit);
    expect(next.view).toEqual(fit(taller));
    expect(next.laidOutAt).toEqual(taller);
  });

  it("re-centres a view the user has moved instead of refitting it", () => {
    const start = { view: panBy(fit(tall), 30, 0), laidOutAt: tall };
    const next = layoutPane(start, taller, true, false, fit);
    expect(next.view.pxPerIn).toBe(start.view.pxPerIn);
    expect(next.view.originYPx - start.view.originYPx).toBeCloseTo(14, 9);
  });

  it("holds the view still while a press is down, so a dragged point stays under the pointer", () => {
    const start = layoutPane(null, tall, false, false, fit);
    const aimed = { xIn: -65, yIn: 6.3 };
    const pointer = worldToScreen(start.view, aimed);
    const during = layoutPane(start, taller, false, true, fit);
    expect(during).toBe(start);
    const landed = screenToWorld(during.view, pointer);
    expect(landed.xIn).toBeCloseTo(aimed.xIn, 9);
    expect(landed.yIn).toBeCloseTo(aimed.yIn, 9);
    // Refitting under the press, as v2 did, would have put the point several inches off.
    const refitted = screenToWorld(fit(taller), pointer);
    expect(Math.hypot(refitted.xIn - aimed.xIn, refitted.yIn - aimed.yIn)).toBeGreaterThan(1);
  });

  it("catches up with a resize held back during a press once the press ends", () => {
    const start = layoutPane(null, tall, false, false, fit);
    const during = layoutPane(start, taller, false, true, fit);
    const after = layoutPane(during, taller, false, false, fit);
    expect(after.view).toEqual(fit(taller));
    expect(after.laidOutAt).toEqual(taller);
  });
});

// Finding 22: view.ts no longer carries its own mirror math (mirrorPose/mirrorPoint deleted).
// The alliance mirror is now @horizon36596/zenith-core's mirrorVec/mirrorHeadingRad, exercised by
// canvas/mirror.test.ts for every MirrorMode (none/pointSymmetry/mirrorX/mirrorY) including the
// round-trip/involution behaviour this block used to check.
