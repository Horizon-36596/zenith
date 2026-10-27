import { isTurnInPlace } from "../turnInPlace.js";
import type { Finding, Fix, PlanStep } from "../types.js";

/**
 * The two ways a finding asks for the optimizer (issue #309): "Route around <label>" on a collision,
 * and "Find a faster heading" on a strafing leg. Both are the `optimizeRoute` fix, which writes
 * nothing: the editor opens Optimize path on the step and the person previews the route. `check()` only
 * describes the request and never runs the optimizer.
 *
 * Only a path step with a route to change offers either; a wait or a command where the robot stands,
 * and a turn on the spot, have no route to go round anything with.
 */

/** Whether the step is a path that drives somewhere, which is what the optimizer changes. */
const hasRoute = (step: PlanStep): boolean => step.kind === "path" && !isTurnInPlace(step);

/**
 * "Route around <label>" for a collision on `step`, or null when the step has no route. `label` is
 * how the finding names the thing: the season's words for an obstacle, a zone's id, or the field wall.
 */
export function routeAroundFix(
  step: PlanStep,
  label: string,
  params: { obstacleId?: string; zoneId?: string },
): Fix | null {
  if (!hasRoute(step)) return null;
  return { kind: "optimizeRoute", stepId: step.id, label: `Route around ${label}`, params };
}

/** "Find a faster heading" for a strafing leg, which keeps the path's segments and searches headings only. */
export function fasterHeadingFix(step: PlanStep): Fix | null {
  if (!hasRoute(step)) return null;
  return { kind: "optimizeRoute", stepId: step.id, label: "Find a faster heading", params: { mode: "headingOnly" } };
}

/** `fixes` with `fix` after them, as a finding's `fixes` key; nothing at all when there are none. */
export function withFix(fixes: readonly Fix[] | undefined, fix: Fix | null): Pick<Finding, "fixes"> {
  const all = fix === null ? [...(fixes ?? [])] : [...(fixes ?? []), fix];
  return all.length === 0 ? {} : { fixes: all };
}
