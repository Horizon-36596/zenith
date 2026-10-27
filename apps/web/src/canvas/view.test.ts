import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fieldBounds, loadAuto, loadField, loadRobot, plan, resolve } from "@horizon36596/zenith-core";
import type { Auto } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { robotReachIn } from "./footprintBounds";
import { buildScene, routinePoints } from "./scene";
import {
  expandBounds,
  fitBounds,
  fitView,
  FIT_MARGIN_IN,
  FIT_PADDING,
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

  it("moves the field a screen delta divided by the zoom, so the grabbed point follows the pointer", () => {
    // A middle drag or a Ctrl + right drag (issue #115) pans by the pointer's movement in pixels.
    for (const at of ["bottom", "top", "left", "right"] as const) {
      const view = zoomAbout(fitView(FIELD, 900, 600, 24, orientationFor(at)), { xPx: 400, yPx: 300 }, 2.5);
      const grab = { xPx: 312, yPx: 188 };
      const held = screenToWorld(view, grab);
      const panned = panBy(view, 60, -40);
      // The world point that was under the pointer is under it again where the pointer stopped.
      const under = screenToWorld(panned, { xPx: grab.xPx + 60, yPx: grab.yPx - 40 });
      expect(under.xIn).toBeCloseTo(held.xIn, 9);
      expect(under.yIn).toBeCloseTo(held.yIn, 9);
      // What is now under the unmoved pointer is the delta over the zoom away, in field inches.
      const now = screenToWorld(panned, grab);
      expect(Math.hypot(now.xIn - held.xIn, now.yIn - held.yIn)).toBeCloseTo(Math.hypot(60, 40) / view.pxPerIn, 9);
    }
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

describe("what a fit frames (issue #151)", () => {
  const read = (relative: string): unknown =>
    JSON.parse(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")) as unknown;
  const field = loadField(read("../../../../examples/starter/autos/field/biobuzz.field.json"));
  const robot = loadRobot(read("../../../../examples/starter/autos/robot.json"));
  const example = (): Auto => loadAuto(read("../../../../examples/starter/autos/collect-and-score.auto.json"));
  const sceneOf = (auto: Auto) => buildScene({ plan: plan(resolve(auto, undefined, robot), robot, field), findings: [], estimate: null });
  /** The starter robot is an 18 in square turning about its middle, and its intake stays inside that square's circle. */
  const HALF_DIAGONAL_IN = Math.hypot(18, 18) / 2;

  /** The example with toOtherSide's three curve controls pulled north to y = 130 in, far past the north wall. */
  function controlsAt130(): Auto {
    const auto = example();
    const step = auto.steps.find((candidate) => candidate.id === "toOtherSide");
    const segment = step?.kind === "path" ? step.segments[0] : undefined;
    if (segment?.kind !== "bezier") throw new Error("toOtherSide is no longer a curve");
    for (const control of segment.control) control.yIn = 130;
    return auto;
  }

  it("reaches as far as the starter robot's half-diagonal", () => {
    expect(robotReachIn(robot)).toBeCloseTo(HALF_DIAGONAL_IN, 9);
  });

  it("takes in toOtherSide's controls at y = 130, with the robot's half-diagonal beyond them", () => {
    const scene = sceneOf(controlsAt130());
    const box = fitBounds(fieldBounds(field), routinePoints(scene, "none"), robotReachIn(robot));
    expect(box.maxYIn).toBeGreaterThanOrEqual(130 + HALF_DIAGONAL_IN - 1e-9);
    expect(box.maxYIn).toBeCloseTo(130 + HALF_DIAGONAL_IN, 9);
    // The rest is still the field and its margin: nothing else of the routine leaves the field.
    const margin = expandBounds(fieldBounds(field), FIT_MARGIN_IN);
    expect({ ...box, maxYIn: margin.maxYIn }).toEqual(margin);
  });

  it("frames the board alone, not a start against the wall with its robot's reach (issue #412)", () => {
    // The starter's start is at (-13, -63), 9 in from the south wall, so its reach crosses the wall.
    const box = fitBounds(fieldBounds(field), routinePoints(sceneOf(example()), "none"), robotReachIn(robot));
    expect(box).toEqual(fieldBounds(field));
  });

  it("is the field and its margin when the whole routine stays on the field", () => {
    const box = fitBounds(fieldBounds(field), routinePoints(sceneOf(example()), "none"), robotReachIn(robot));
    expect(box).toEqual(expandBounds(fieldBounds(field), FIT_MARGIN_IN));
  });

  it("frames the routine where it is drawn when the other alliance is viewed", () => {
    // BIOBUZZ mirrors by point symmetry, so the controls are drawn at y = -130 for BLUE.
    const box = fitBounds(fieldBounds(field), routinePoints(sceneOf(controlsAt130()), "pointSymmetry"), robotReachIn(robot));
    expect(box.minYIn).toBeCloseTo(-130 - HALF_DIAGONAL_IN, 9);
    expect(box.maxYIn).toBe(72 + FIT_MARGIN_IN);
  });

  it("shows the whole box it frames, controls and robot included, in the pane", () => {
    const box = fitBounds(fieldBounds(field), routinePoints(sceneOf(controlsAt130()), "none"), robotReachIn(robot));
    const view = fitView(box, 900, 600, FIT_PADDING, bottom);
    const top = worldToScreen(view, { xIn: -12, yIn: 130 + HALF_DIAGONAL_IN });
    expect(top.yPx).toBeGreaterThanOrEqual(FIT_PADDING.topPx - 1e-6);
    const wall = worldToScreen(view, { xIn: 0, yIn: -72 - FIT_MARGIN_IN });
    expect(wall.yPx).toBeLessThanOrEqual(600 - FIT_PADDING.bottomPx + 1e-6);
  });
});

describe("the fit's padding (issue #151)", () => {
  /** The corner readout's top, up from the canvas's bottom: 8 px of pad and its 22 px row (`liveLayer.ts`). */
  const READOUT_TOP_PX = 8 + 22;

  it("keeps a padded box inside the padding on every side, and centres it in what is left", () => {
    const padding = { topPx: 48, rightPx: 16, bottomPx: 16, leftPx: 16 };
    const view = fitView(FIELD, 900, 600, padding, bottom);
    const northWest = worldToScreen(view, { xIn: -72, yIn: 72 });
    const southEast = worldToScreen(view, { xIn: 72, yIn: -72 });
    expect(northWest.yPx).toBeCloseTo(48, 6);
    expect(southEast.yPx).toBeCloseTo(584, 6);
    expect((northWest.xPx + southEast.xPx) / 2).toBeCloseTo(450, 6);
  });

  it("is the same on every side when it is one number", () => {
    expect(fitView(FIELD, 900, 600, 24, bottom)).toEqual(
      fitView(FIELD, 900, 600, { topPx: 24, rightPx: 24, bottomPx: 24, leftPx: 24 }, bottom),
    );
  });

  it("keeps the wall on the well and the board above the corner readout, from a narrow pane to a wide one", () => {
    // At 700 x 500 the steps and inspector panels leave the canvas about 198 x 219 px.
    for (const [widthPx, heightPx] of [
      [198, 219],
      [260, 240],
      [420, 300],
      [660, 460],
      [900, 600],
    ] as const) {
      const view = fitView(expandBounds(FIELD, FIT_MARGIN_IN), widthPx, heightPx, FIT_PADDING, bottom);
      const northWest = worldToScreen(view, { xIn: -72, yIn: 72 });
      const southEast = worldToScreen(view, { xIn: 72, yIn: -72 });
      // The wall is a band up to 5 px wide just outside the field's edge (`staticLayer.ts` drawWall).
      expect(northWest.yPx - 5).toBeGreaterThanOrEqual(0);
      expect(northWest.xPx - 5).toBeGreaterThanOrEqual(0);
      expect(southEast.yPx).toBeLessThanOrEqual(heightPx - READOUT_TOP_PX + 1e-6);
    }
  });

  it("makes the board at least 90% of the 1280 x 720 well's shorter side (issue #412)", () => {
    // At 1280 x 720 the field well is about 660 x 460 px.
    const view = fitView(expandBounds(FIELD, FIT_MARGIN_IN), 660, 460, FIT_PADDING, bottom);
    expect(view.pxPerIn * 144).toBeGreaterThanOrEqual(0.9 * 460);
  });
});

// Finding 22: view.ts no longer carries its own mirror math (mirrorPose/mirrorPoint deleted).
// The alliance mirror is now @horizon36596/zenith-core's mirrorVec/mirrorHeadingRad, exercised by
// canvas/mirror.test.ts for every MirrorMode (none/pointSymmetry/mirrorX/mirrorY) including the
// round-trip/involution behaviour this block used to check.
