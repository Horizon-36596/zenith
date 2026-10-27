import type { Obstacle, StrutObstacle } from "@horizon36596/zenith-schema";
import { boxCorners, type Box2 } from "./sat.js";
import type { Vec2 } from "./vec.js";

/**
 * The robot is modelled as an upright prism of its footprint from the tiles (z 0) to its top
 * (`robotHeightIn`). It touches an obstacle exactly where its footprint meets the obstacle's
 * shadow: the floor plan of the part of the obstacle that sits below the robot's top. This file
 * computes that shadow, once per check, for each obstacle kind of site/docs/file-format.md.
 *
 * Pure (CLAUDE.md rule 1).
 */

/** The shadow of an obstacle with the obstacle it came from and the box around it. */
export interface ObstacleShadow {
  obstacle: Obstacle;
  /** The shadow as a convex polygon, counter-clockwise, in the field frame. */
  polygonIn: Vec2[];
  /** The axis-aligned box around `polygonIn`: the box itself for a box obstacle. */
  boxIn: Box2;
}

/**
 * The plan polygon of the part of `obstacle` below `robotHeightIn`, or null when none of it is.
 *
 * - A box: its four corners when its underside (`minZIn`) is lower than the robot's top, and null
 *   otherwise. This is the z gate STRUCTURE has always used.
 * - A strut: see `strutShadowIn`.
 */
export function obstacleShadowIn(obstacle: Obstacle, robotHeightIn: number): Vec2[] | null {
  if (obstacle.kind === "box") return obstacle.minZIn < robotHeightIn ? boxCorners(obstacle) : null;
  return strutShadowIn(obstacle, robotHeightIn);
}

/**
 * A strut's shadow. Let E be its elevation above horizontal and r its radius. A round tube of
 * radius r reaches r·cos E below and above its centreline, so it reaches below the robot's top h
 * wherever its centreline is below h + r·cos E, and above the tiles wherever its centreline is
 * above -r·cos E. The centreline is clipped to that z range and projected onto the floor; the
 * shadow is the rectangle around the projected piece, r either side of it and extended by r past
 * both ends. That is one convex polygon that holds the exact shadow of the round envelope and is
 * at most a fraction of an inch larger. When the clipped piece is empty the result is null.
 */
function strutShadowIn(strut: StrutObstacle, robotHeightIn: number): Vec2[] | null {
  const from = strut.fromIn;
  const to = strut.toIn;
  const r = strut.radiusIn;
  const dx = to.xIn - from.xIn;
  const dy = to.yIn - from.yIn;
  const dz = to.zIn - from.zIn;
  const length = Math.hypot(dx, dy, dz);
  // A strut of no length is a ball of radius r; treat it as level so it reaches r up and down.
  const cosE = length < 1e-12 ? 1 : Math.hypot(dx, dy) / length;
  const lowIn = -r * cosE;
  const highIn = robotHeightIn + r * cosE;

  let t0 = 0;
  let t1 = 1;
  if (Math.abs(dz) < 1e-12) {
    if (!(from.zIn > lowIn && from.zIn < highIn)) return null;
  } else {
    const a = (lowIn - from.zIn) / dz;
    const b = (highIn - from.zIn) / dz;
    t0 = Math.max(0, Math.min(a, b));
    t1 = Math.min(1, Math.max(a, b));
    if (!(t1 > t0)) return null;
  }

  const start: Vec2 = { xIn: from.xIn + t0 * dx, yIn: from.yIn + t0 * dy };
  const end: Vec2 = { xIn: from.xIn + t1 * dx, yIn: from.yIn + t1 * dy };
  const planLength = Math.hypot(end.xIn - start.xIn, end.yIn - start.yIn);
  // An upright piece projects to a point; any direction gives the same square around it.
  const u: Vec2 =
    planLength < 1e-12
      ? { xIn: 1, yIn: 0 }
      : { xIn: (end.xIn - start.xIn) / planLength, yIn: (end.yIn - start.yIn) / planLength };
  const n: Vec2 = { xIn: -u.yIn, yIn: u.xIn };
  const at = (base: Vec2, along: number, across: number): Vec2 => ({
    xIn: base.xIn + r * (along * u.xIn + across * n.xIn),
    yIn: base.yIn + r * (along * u.yIn + across * n.yIn),
  });
  return [at(start, -1, -1), at(end, 1, -1), at(end, 1, 1), at(start, -1, 1)];
}

/** The axis-aligned box around a polygon. */
export function polygonBoxIn(polygon: readonly Vec2[]): Box2 {
  let minXIn = Infinity;
  let maxXIn = -Infinity;
  let minYIn = Infinity;
  let maxYIn = -Infinity;
  for (const point of polygon) {
    minXIn = Math.min(minXIn, point.xIn);
    maxXIn = Math.max(maxXIn, point.xIn);
    minYIn = Math.min(minYIn, point.yIn);
    maxYIn = Math.max(maxYIn, point.yIn);
  }
  return { minXIn, maxXIn, minYIn, maxYIn };
}

/**
 * The shadows STRUCTURE tests, built once per check because the robot's height is one number:
 * every obstacle solid to the robot that has a part below its top, in field order.
 */
export function obstacleShadows(obstacles: readonly Obstacle[], robotHeightIn: number): ObstacleShadow[] {
  const shadows: ObstacleShadow[] = [];
  for (const obstacle of obstacles) {
    if (!(obstacle.solidToRobot ?? true)) continue;
    const polygonIn = obstacleShadowIn(obstacle, robotHeightIn);
    if (polygonIn === null) continue;
    const boxIn: Box2 =
      obstacle.kind === "box"
        ? { minXIn: obstacle.minXIn, maxXIn: obstacle.maxXIn, minYIn: obstacle.minYIn, maxYIn: obstacle.maxYIn }
        : polygonBoxIn(polygonIn);
    shadows.push({ obstacle, polygonIn, boxIn });
  }
  return shadows;
}
