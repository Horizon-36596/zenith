import type { Step } from "@horizon36596/zenith-schema";
import { distance, type Pose, type Vec2 } from "./geometry/vec.js";
import type { ResolvedSegment } from "./resolve.js";

/** The gap two segment endpoints may leave before it is a CONTINUITY error, in inches. */
export const CONTINUITY_TOLERANCE_IN = 0.5;

/**
 * What the continuity walk needs of a step: a resolved step (`resolve`) and a planned one (`plan`)
 * both have this shape, so the check and the editor's insert-in-the-middle read one definition.
 */
export interface ContinuityNode {
  id: string;
  step: Step;
  endPose: Pose | null;
  segments?: readonly ResolvedSegment[];
  /** A branch's children are its `then` steps followed by its `else` steps, as `resolve` lays them. */
  children?: readonly ContinuityNode[];
}

/** One place where the robot would have to jump. */
export interface ContinuityGap {
  stepId: string;
  /** `start`: the step does not begin where the robot was. `segment`: a segment does not begin where the one before it ended. */
  where: "start" | "segment";
  /** For a `segment` gap, the 0-based index of the segment that starts away from the last. */
  segmentIndex?: number;
  gapIn: number;
  /** Where the step or segment starts. */
  pointIn: Vec2;
}

/**
 * Every gap over `toleranceIn`, depth first in document order.
 *
 * A sequence chains like the top level: its first member starts where the robot was and each later
 * one where the member before it ended. Every member of a parallel group, and the first step of each
 * side of a branch, starts from the pose the group started at, not from wherever the member before
 * it happened to finish: two paths in a `parallel` both begin where the robot was.
 */
export function continuityGaps(
  steps: readonly ContinuityNode[],
  entry: Pose,
  toleranceIn: number = CONTINUITY_TOLERANCE_IN,
): ContinuityGap[] {
  const gaps: ContinuityGap[] = [];
  let previous: ContinuityNode | null = null;

  for (const step of steps) {
    const startPose = previous?.endPose ?? entry;
    if (step.children !== undefined) {
      if (step.step.kind === "sequence") {
        gaps.push(...continuityGaps(step.children, startPose, toleranceIn));
      } else if (step.step.kind === "parallel") {
        for (const child of step.children) {
          gaps.push(...continuityGaps([child], startPose, toleranceIn));
        }
      } else if (step.step.kind === "branch") {
        const thenCount = step.step.then.length;
        gaps.push(...continuityGaps(step.children.slice(0, thenCount), startPose, toleranceIn));
        gaps.push(...continuityGaps(step.children.slice(thenCount), startPose, toleranceIn));
      }
      previous = step;
      continue;
    }
    const segments = step.segments;
    if (segments !== undefined) {
      for (let i = 1; i < segments.length; i += 1) {
        const before = segments[i - 1];
        const after = segments[i];
        if (before === undefined || after === undefined) continue;
        const gapIn = distance(before.toPose, after.fromPose);
        if (gapIn > toleranceIn) {
          gaps.push({
            stepId: step.id,
            where: "segment",
            segmentIndex: i,
            gapIn,
            pointIn: { xIn: after.fromPose.xIn, yIn: after.fromPose.yIn },
          });
        }
      }
      const first = segments[0];
      if (first !== undefined) {
        const gapIn = distance(startPose, first.fromPose);
        if (gapIn > toleranceIn) {
          gaps.push({
            stepId: step.id,
            where: "start",
            gapIn,
            pointIn: { xIn: first.fromPose.xIn, yIn: first.fromPose.yIn },
          });
        }
      }
    }
    previous = step;
  }
  return gaps;
}
