/**
 * World (field inches) to screen (CSS pixels) and back, plus the alliance mirror.
 *
 * The field frame is site/docs/file-format.md: centre origin, inches, +X audience-right, +Y away
 * from the audience, heading counter-clockwise from +X. `field.json` declares where the audience
 * sits (`frame.view.audienceAt`) and that alone decides which way the world axes point on screen:
 * with the audience at the bottom, +Y is up, so the screen's y axis runs the other way from the
 * field's. The other three placements are the same field rotated a quarter turn at a time, and the
 * rule that generates them is "the audience faces the field, and their right hand is a quarter turn
 * clockwise from the direction they are facing".
 *
 * Everything here is arithmetic with no DOM, so the transforms are unit-tested directly.
 */
import type { Box2, Vec2 } from "@horizon36596/zenith-core";

export type AudienceAt = "bottom" | "top" | "left" | "right";

/** A point or a direction in screen space, in CSS pixels from the canvas's top-left corner. */
export interface ScreenVec {
  xPx: number;
  yPx: number;
}

/** Where the world axes point on screen, as unit vectors. */
export interface Orientation {
  readonly xAxis: ScreenVec;
  readonly yAxis: ScreenVec;
}

const ORIENTATIONS: Readonly<Record<AudienceAt, Orientation>> = {
  bottom: { xAxis: { xPx: 1, yPx: 0 }, yAxis: { xPx: 0, yPx: -1 } },
  top: { xAxis: { xPx: -1, yPx: 0 }, yAxis: { xPx: 0, yPx: 1 } },
  left: { xAxis: { xPx: 0, yPx: 1 }, yAxis: { xPx: 1, yPx: 0 } },
  right: { xAxis: { xPx: 0, yPx: -1 }, yAxis: { xPx: -1, yPx: 0 } },
};

export const orientationFor = (audienceAt: AudienceAt = "bottom"): Orientation =>
  ORIENTATIONS[audienceAt];

/**
 * The view is a uniform scale and a translation on top of the orientation, so a field inch is the
 * same number of pixels in both directions and nothing is ever sheared.
 */
export interface View {
  /** Zoom, in CSS pixels per field inch. */
  readonly pxPerIn: number;
  /** Where the world origin sits on screen, in CSS pixels. */
  readonly originXPx: number;
  readonly originYPx: number;
  readonly orientation: Orientation;
}

/** A 144 in field in a 400 px pane is about 2.7 px per inch, so the floor is well below useful. */
export const MIN_PX_PER_IN = 0.75;
export const MAX_PX_PER_IN = 40;

export const clampZoom = (pxPerIn: number): number =>
  pxPerIn < MIN_PX_PER_IN ? MIN_PX_PER_IN : pxPerIn > MAX_PX_PER_IN ? MAX_PX_PER_IN : pxPerIn;

export function worldToScreen(view: View, point: Vec2): ScreenVec {
  const { xAxis, yAxis } = view.orientation;
  return {
    xPx: view.originXPx + view.pxPerIn * (xAxis.xPx * point.xIn + yAxis.xPx * point.yIn),
    yPx: view.originYPx + view.pxPerIn * (xAxis.yPx * point.xIn + yAxis.yPx * point.yIn),
  };
}

export function screenToWorld(view: View, point: ScreenVec): Vec2 {
  const { xAxis, yAxis } = view.orientation;
  const dx = (point.xPx - view.originXPx) / view.pxPerIn;
  const dy = (point.yPx - view.originYPx) / view.pxPerIn;
  // The orientation is orthonormal, so its inverse is its transpose.
  return { xIn: xAxis.xPx * dx + xAxis.yPx * dy, yIn: yAxis.xPx * dx + yAxis.yPx * dy };
}

/** The angle to hand `ctx.rotate` so that a world heading points the right way on screen. */
export function headingToScreenAngle(view: View, headingRad: number): number {
  const { xAxis, yAxis } = view.orientation;
  const cos = Math.cos(headingRad);
  const sin = Math.sin(headingRad);
  return Math.atan2(xAxis.yPx * cos + yAxis.yPx * sin, xAxis.xPx * cos + yAxis.xPx * sin);
}

/** A box grown by `marginIn` on every side, in field inches. */
export const expandBounds = (bounds: Box2, marginIn: number): Box2 => ({
  minXIn: bounds.minXIn - marginIn,
  maxXIn: bounds.maxXIn + marginIn,
  minYIn: bounds.minYIn - marginIn,
  maxYIn: bounds.maxYIn + marginIn,
});

/** The screen size, in CSS pixels, of a world-aligned box at a given zoom. */
function screenExtent(bounds: Box2, orientation: Orientation): { widthPx: number; heightPx: number } {
  const w = bounds.maxXIn - bounds.minXIn;
  const h = bounds.maxYIn - bounds.minYIn;
  const { xAxis, yAxis } = orientation;
  return {
    widthPx: Math.abs(xAxis.xPx) * w + Math.abs(yAxis.xPx) * h,
    heightPx: Math.abs(xAxis.yPx) * w + Math.abs(yAxis.yPx) * h,
  };
}

/** The view that shows all of `bounds` inside `widthPx` x `heightPx` with `paddingPx` to spare. */
export function fitView(
  bounds: Box2,
  widthPx: number,
  heightPx: number,
  paddingPx: number,
  orientation: Orientation,
): View {
  const extent = screenExtent(bounds, orientation);
  const usableX = Math.max(widthPx - 2 * paddingPx, 1);
  const usableY = Math.max(heightPx - 2 * paddingPx, 1);
  const pxPerIn = clampZoom(
    Math.min(usableX / Math.max(extent.widthPx, 1e-9), usableY / Math.max(extent.heightPx, 1e-9)),
  );
  const centre: Vec2 = {
    xIn: (bounds.minXIn + bounds.maxXIn) / 2,
    yIn: (bounds.minYIn + bounds.maxYIn) / 2,
  };
  const { xAxis, yAxis } = orientation;
  return {
    pxPerIn,
    originXPx: widthPx / 2 - pxPerIn * (xAxis.xPx * centre.xIn + yAxis.xPx * centre.yIn),
    originYPx: heightPx / 2 - pxPerIn * (xAxis.yPx * centre.xIn + yAxis.yPx * centre.yIn),
    orientation,
  };
}

/** Zoom by `factor`, keeping whatever world point is under `anchor` under it. */
export function zoomAbout(view: View, anchor: ScreenVec, factor: number): View {
  const pxPerIn = clampZoom(view.pxPerIn * factor);
  if (pxPerIn === view.pxPerIn) return view;
  const held = screenToWorld(view, anchor);
  const { xAxis, yAxis } = view.orientation;
  return {
    pxPerIn,
    originXPx: anchor.xPx - pxPerIn * (xAxis.xPx * held.xIn + yAxis.xPx * held.yIn),
    originYPx: anchor.yPx - pxPerIn * (xAxis.yPx * held.xIn + yAxis.yPx * held.yIn),
    orientation: view.orientation,
  };
}

export const panBy = (view: View, dxPx: number, dyPx: number): View => ({
  ...view,
  originXPx: view.originXPx + dxPx,
  originYPx: view.originYPx + dyPx,
});

export interface PaneSize {
  widthPx: number;
  heightPx: number;
}

export interface PaneLayout {
  view: View;
  /** The pane size `view` was laid out for, which lags the element's size while a press is down. */
  laidOutAt: PaneSize;
}

/**
 * The view once the pane is `size`. Until the user pans or zooms (`userAdjusted`), the view is
 * refitted; after that it is panned by half the change, so what was in the middle stays there. A
 * pane that has not changed size keeps its layout, and no layout yet (`current` null) is a fit.
 *
 * While a press is down (`pressing`) the view is left alone, whatever the pane does: the status
 * strip coming or going resizes the pane with no input from the user, and a refit under a drag
 * would slide the field beneath a still pointer and drop the dragged point somewhere the user never
 * aimed. The layout catches up when it is next asked with `pressing` false, which the canvas does as
 * the press ends.
 */
export function layoutPane(
  current: PaneLayout | null,
  size: PaneSize,
  userAdjusted: boolean,
  pressing: boolean,
  fit: (size: PaneSize) => View,
): PaneLayout {
  if (current === null) return { view: fit(size), laidOutAt: size };
  if (pressing) return current;
  const { view, laidOutAt } = current;
  if (laidOutAt.widthPx === size.widthPx && laidOutAt.heightPx === size.heightPx) return current;
  if (!userAdjusted) return { view: fit(size), laidOutAt: size };
  return {
    view: panBy(view, (size.widthPx - laidOutAt.widthPx) / 2, (size.heightPx - laidOutAt.heightPx) / 2),
    laidOutAt: size,
  };
}

/**
 * The alliance mirror is `field.json`'s own `frame.mirror` kind (finding 22: this used to hardcode
 * point symmetry here and in `packages/core/src/render.ts`, ignoring `mirrorX`/`mirrorY`/`none`).
 * `@horizon36596/zenith-core`'s `mirrorVec`/`mirrorHeadingRad` already implement all four kinds and are what
 * `render` uses, so the canvas calls them directly instead of keeping its own copy: `mirrorVec(point,
 * field.frame.mirror)`, `mirrorHeadingRad(headingRad, field.frame.mirror)`. Every kind is its own
 * inverse, which is what lets the canvas draw a BLUE preview and still report the canonical RED pose
 * back to the shell: the same function un-mirrors on the way out (`FieldCanvas.tsx`'s `toWorld`).
 */

/** The round number of inches a scale bar should span to sit just inside `maxPx`. */
export function scaleBarInches(pxPerIn: number, maxPx: number): number {
  const steps = [1, 2, 6, 12, 24, 48, 72, 144];
  let best = steps[0] as number;
  for (const step of steps) if (step * pxPerIn <= maxPx) best = step;
  return best;
}
