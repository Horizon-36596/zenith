import type { Robot } from "@horizon36596/zenith-schema";
import type { Vec2 } from "../geometry/vec.js";
import type { SeasonRules, SeasonState, TargetId } from "../season.js";

/**
 * "Add a clear path here" (issue #310): the editor adds a path step from where the robot is to a
 * clicked point and opens it in Optimize path with both ends fixed. The end heading is the person's
 * default heading mode's (D6), or, when the point is a season target, the heading of the legal approach
 * there. This file decides the second.
 *
 * Pure (CLAUDE.md rule 1).
 */

/** The heading a clear path ends on at a season target, and the target it faces. */
export interface LegalApproachEnd {
  target: TargetId;
  headingRad: number;
}

/**
 * The legal-approach end at a point, or null when the point is not a season target. A point is one
 * when the season has a current target at the ledger state `state` and the point is a legal approach
 * to it (`SeasonRules.legalApproach`). The heading faces the target's point when the season names
 * one (`targetPoint`), else it is the heading the season's nearest legal approach gives, else the
 * heading the caller would have used, `headingRad`. The point counts only when the season accepts
 * it at that heading, so a point legal only when facing the target counts, and a heading the season
 * would not accept there gives null, so the caller keeps its own.
 */
export function legalApproachEnd(
  season: SeasonRules,
  state: SeasonState,
  alliance: "RED" | "BLUE",
  pointIn: Vec2,
  headingRad: number,
  robot: Robot,
): LegalApproachEnd | null {
  const target = season.currentTarget(state, alliance);
  if (target === null) return null;
  const at = { xIn: pointIn.xIn, yIn: pointIn.yIn, headingRad };
  // Legality is tested at the heading the path would end on, never at the drive bearing alone: a
  // season may accept a point only when the robot faces its target from there.
  const aim = season.targetPoint?.(state, target) ?? null;
  const facing =
    aim !== null
      ? Math.atan2(aim.yIn - pointIn.yIn, aim.xIn - pointIn.xIn)
      : (season.nearestLegalApproach?.(state, target, at, robot)?.headingRad ?? headingRad);
  if (!Number.isFinite(facing)) return null;
  if (!season.legalApproach(state, target, { ...at, headingRad: facing }, robot)) return null;
  return { target, headingRad: facing };
}
