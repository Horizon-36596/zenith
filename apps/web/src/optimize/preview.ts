/**
 * What the field draws while the Optimize card is open (UI_GUIDE 9.11, issue #308), worked out from the
 * card's result and the open files:
 *
 * - the proposed route, planned inside the whole auto as it would be saved, which the canvas draws
 *   as a second, non-interactive scene, dashed in `--path-candidate`, with its joints as dots;
 * - the margin round the structures the route passes near, a 1 px `--canvas-annotation` hairline;
 * - on `infeasible`, the closest attempt's worst pose, which the canvas draws as a clip ghost.
 *
 * DOM-free, so it is tested in vitest. Planning the candidate goes through `plan()`'s memo, so every
 * step but the optimized one is a hit and the open auto's own plan is not touched.
 */
import {
  clearanceWorld,
  flattenSteps,
  measureClearances,
  plan,
  resolve,
  setRoute,
  type OptimizeResult,
  type Plan,
  type PlanSample,
  type Pose,
  type Vec2,
} from "@horizon36596/zenith-core";
import type { Auto, Field, PathStep, Robot, Waypoints } from "@horizon36596/zenith-schema";
import { grownOutlineIn } from "../canvas/clearanceOutline";

/**
 * How close the route must come to a structure, beyond the margin, for the card to outline that
 * structure's margin, in inches (SET BY HAND: half a 24 in field tile, so the structures the route
 * actually threads between are outlined and the far side of the field is not).
 */
export const NEAR_STRUCTURE_IN = 12;

/** One structure's margin, as the hairline is drawn: its shadow grown by the margin. */
export interface MarginOutline {
  id: string;
  polygonIn: Vec2[];
}

export interface CandidatePreview {
  stepId: string;
  /** The auto with the proposed route, planned; null while there is no route to show. */
  plan: Plan | null;
  /** Where one path of the chain meets the next, on the proposed route. */
  jointsIn: Vec2[];
  marginIn: number;
  marginOutlines: MarginOutline[];
  /** On `infeasible`, the closest attempt's worst pose, for a clip ghost; else null. */
  ghostPoseIn: Pose | null;
}

export interface PreviewFiles {
  auto: Auto;
  robot: Robot;
  field: Field;
  waypoints?: Waypoints | undefined;
}

export interface PreviewCard {
  stepId: string;
  marginIn: number;
  result: OptimizeResult | null;
  stale: boolean;
  /**
   * The route the card's switcher shows (issue #310), which is the one drawn; left out, the
   * result's pick. On a clear path the files' auto is the draft, with the new step in it.
   */
  route?: PathStep | null;
}

const planOf = (auto: Auto, files: PreviewFiles): Plan | null => {
  try {
    return plan(resolve(auto, files.waypoints, files.robot), files.robot, files.field);
  } catch {
    return null;
  }
};

const samplesOf = (planned: Plan | null, stepId: string): PlanSample[] =>
  planned === null ? [] : (flattenSteps(planned.steps).find((step) => step.id === stepId)?.samples ?? []);

/** The margin round every structure the samples come within `marginIn + NEAR_STRUCTURE_IN` of. */
function marginOutlines(files: PreviewFiles, samples: readonly PlanSample[], marginIn: number): MarginOutline[] {
  if (samples.length === 0 || !(marginIn > 0)) return [];
  const world = clearanceWorld(files.robot, files.field);
  const measured = measureClearances(world, samples);
  return world.structures.flatMap((structure, index) => {
    const nearest = Math.min(...(measured.structuresIn[index] ?? [Infinity]));
    if (nearest > marginIn + NEAR_STRUCTURE_IN) return [];
    const polygonIn = grownOutlineIn(structure.polygonIn, marginIn);
    return polygonIn.length === 0 ? [] : [{ id: structure.id, polygonIn }];
  });
}

/**
 * The preview for the card's state, or null when there is nothing to draw. The route shows only for
 * a result with a pick that is not stale; the margin shows round the route, or round the step as it
 * is while there is none.
 */
export function candidatePreview(files: PreviewFiles, card: PreviewCard): CandidatePreview | null {
  const result = card.result;
  const pick = card.stale ? null : card.route !== undefined ? card.route : (result?.step ?? null);
  let candidatePlan: Plan | null = null;
  if (pick !== null) {
    try {
      candidatePlan = planOf(setRoute(files.auto, card.stepId, pick.segments, pick.heading ?? { mode: "tangent" }), files);
    } catch {
      candidatePlan = null;
    }
  }
  const candidateStep = candidatePlan === null ? undefined : flattenSteps(candidatePlan.steps).find((step) => step.id === card.stepId);
  const segments = candidateStep?.segments ?? [];
  const jointsIn = segments.slice(0, -1).map((segment) => ({ xIn: segment.toPose.xIn, yIn: segment.toPose.yIn }));
  const route = candidatePlan === null ? samplesOf(planOf(files.auto, files), card.stepId) : samplesOf(candidatePlan, card.stepId);
  const ghost = !card.stale && result?.status === "infeasible" ? (result.closest?.pose ?? null) : null;
  return {
    stepId: card.stepId,
    plan: candidatePlan,
    jointsIn,
    marginIn: card.marginIn,
    marginOutlines: marginOutlines(files, route, card.marginIn),
    ghostPoseIn: ghost,
  };
}
