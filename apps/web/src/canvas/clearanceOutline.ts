/**
 * The clearance outline (`display.clearanceOutline`, owner ruling D8): the robot's footprint at the
 * playhead grown by its clearance from field elements, so a person can see the margin the CLEARANCE
 * warning measures. It is a view only; the margin comes from robot.json (`robotClearanceIn`).
 *
 * DOM-free arithmetic, like the rest of `canvas/`'s geometry, so it is tested in vitest.
 */
import type { Vec2 } from "@horizon36596/zenith-core";

/** How many straight pieces each rounded corner is drawn with. */
const CORNER_STEPS = 6;

/**
 * A convex, counter-clockwise polygon grown outward by `byIn` inches: every edge pushed out by
 * `byIn`, joined by a quarter-round at each corner, which is every point within `byIn` of the
 * polygon. Empty for a polygon of fewer than three corners or a margin that is not above 0.
 */
export function grownOutlineIn(polygon: readonly Vec2[], byIn: number, cornerSteps = CORNER_STEPS): Vec2[] {
  if (polygon.length < 3 || !(byIn > 0)) return [];
  const outwardAngle = (from: Vec2, to: Vec2): number =>
    // The outward normal of a counter-clockwise edge points to its right.
    Math.atan2(-(to.xIn - from.xIn), to.yIn - from.yIn);
  const outline: Vec2[] = [];
  const count = polygon.length;
  for (let i = 0; i < count; i += 1) {
    const corner = polygon[i] as Vec2;
    const before = polygon[(i + count - 1) % count] as Vec2;
    const after = polygon[(i + 1) % count] as Vec2;
    const start = outwardAngle(before, corner);
    let end = outwardAngle(corner, after);
    while (end < start) end += 2 * Math.PI;
    for (let step = 0; step <= cornerSteps; step += 1) {
      const angle = start + ((end - start) * step) / cornerSteps;
      outline.push({ xIn: corner.xIn + byIn * Math.cos(angle), yIn: corner.yIn + byIn * Math.sin(angle) });
    }
  }
  return outline;
}
