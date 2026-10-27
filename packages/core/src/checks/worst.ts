import type { FindingGeometry, PlanSample } from "../types.js";

/**
 * Where a footprint check (PERIMETER, STRUCTURE, KEEPOUT) found the robot at its worst along one
 * step, shared so each check reports the worst pose the same way.
 */

/** The worst sample a footprint check has seen so far, and which of its polygons was worst. */
export interface Worst {
  depthIn: number;
  sample: PlanSample | null;
  polygonIndex: number;
}

export const NO_WORST: Worst = { depthIn: 0, sample: null, polygonIndex: 0 };

/**
 * The part of a footprint finding's geometry that says where the robot was when it was worst: the
 * pose, every polygon tested there (body first, then the mouths), and which one was the offender.
 * The canvas draws its ghost from these, so the ghost is exactly what the check measured.
 */
export function worstPose(
  worst: Worst,
): Pick<FindingGeometry, "poseIn" | "footprintIn" | "worstPolygonIndex"> {
  const sample = worst.sample;
  if (sample === null) return {};
  return {
    poseIn: { ...sample.pose },
    footprintIn: [sample.footprintIn, ...sample.mouthsIn].map((polygon) =>
      polygon.map((corner) => ({ xIn: corner.xIn, yIn: corner.yIn })),
    ),
    worstPolygonIndex: worst.polygonIndex,
  };
}
