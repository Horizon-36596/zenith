/**
 * The box `F` frames (issue #233). A selected pin is drawn in waypoints.json's own frame and is never
 * mirrored, so it is framed as it is whatever alliance is in view; points of the path are mirrored
 * with the view, as they are drawn.
 */
import { mirrorVec, type Box2, type MirrorMode, type Vec2 } from "@horizon36596/zenith-core";

export const SELECTION_MARGIN_IN = 12;
export const SELECTION_MIN_SPAN_IN = 30;

/** `points` is what to frame; `pinSelected` says the first of them is a pin, so no mirror applies. */
export function selectionFrameBounds(points: readonly Vec2[], pinSelected: boolean, mirror: MirrorMode): Box2 {
  const drawn = points.map((point) => mirrorVec(point, pinSelected ? "none" : mirror));
  const xs = drawn.map((point) => point.xIn);
  const ys = drawn.map((point) => point.yIn);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const halfX = Math.max((Math.max(...xs) - Math.min(...xs)) / 2 + SELECTION_MARGIN_IN, SELECTION_MIN_SPAN_IN / 2);
  const halfY = Math.max((Math.max(...ys) - Math.min(...ys)) / 2 + SELECTION_MARGIN_IN, SELECTION_MIN_SPAN_IN / 2);
  return { minXIn: cx - halfX, maxXIn: cx + halfX, minYIn: cy - halfY, maxYIn: cy + halfY };
}
