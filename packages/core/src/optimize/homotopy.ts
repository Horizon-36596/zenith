import type { PathStep } from "@horizon36596/zenith-schema";
import { sampleDistances } from "../geometry/path.js";
import { boxCorners, convexHull } from "../geometry/sat.js";
import { cross, dot, sub, type Vec2 } from "../geometry/vec.js";
import { stepGeometry, type RouteEnds } from "./candidate.js";
import type { ClearanceWorld } from "./clearance.js";

/**
 * A route's way round the obstacles, its homotopy class (issue #310): which side it passes each
 * structure and keep-out on. Two routes between the same two ends go round an obstacle the same way
 * when, seen from the obstacle's middle, the angles they sweep differ by less than half a turn; going
 * round it the other way changes the angle by a whole turn. The visibility seeds merge routes by this
 * rule (`seeds.ts` `mergeSameSide`), and the alternatives beside the pick are chosen by it, so they go
 * round the obstacles differently.
 *
 * Pure (CLAUDE.md rule 1).
 */

/** The angle a route sweeps as seen from a point, in radians: positive when it passes the point on its left. */
export function sweptAngleRad(pointsIn: readonly Vec2[], about: Vec2): number {
  let total = 0;
  for (let k = 0; k + 1 < pointsIn.length; k += 1) {
    const a = sub(pointsIn[k] as Vec2, about);
    const b = sub(pointsIn[k + 1] as Vec2, about);
    total += Math.atan2(cross(a, b), dot(a, b));
  }
  return total;
}

const meanOf = (points: readonly Vec2[]): Vec2 => ({
  xIn: points.reduce((sum, point) => sum + point.xIn, 0) / points.length,
  yIn: points.reduce((sum, point) => sum + point.yIn, 0) / points.length,
});

/** The middle of every obstacle a route goes round: the structures in order, then the keep-outs. */
function centresOf(world: ClearanceWorld): Vec2[] {
  return [
    ...world.structures.map((structure) => meanOf(convexHull(structure.polygonIn))),
    ...world.keepOuts.map((keepOut) => meanOf(boxCorners(keepOut.boxIn))),
  ];
}

/** The angle a polyline sweeps round each obstacle of the world, structures first, then keep-outs. */
export function routeAngles(world: ClearanceWorld, pointsIn: readonly Vec2[]): number[] {
  return centresOf(world).map((centre) => sweptAngleRad(pointsIn, centre));
}

/** True when two routes between the same ends pass every obstacle on the same side. */
export function sameRouteClass(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((angle, k) => Math.abs(angle - (b[k] as number)) < Math.PI);
}

/**
 * The angles a path step's own route sweeps round each obstacle, read from its geometry at the
 * plan's sample spacing, or null when the step has no geometry a candidate could hold.
 */
export function routeClassOf(world: ClearanceWorld, step: PathStep, ends: RouteEnds): number[] | null {
  const geometry = stepGeometry(step, ends);
  if (typeof geometry === "string") return null;
  return routeAngles(
    world,
    sampleDistances(geometry).map((sIn) => geometry.pointAtDistance(sIn)),
  );
}
