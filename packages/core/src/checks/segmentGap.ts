import type { Step } from "@horizon36596/zenith-schema";
import type { ContinuityGap } from "../continuity.js";
import { startFromCurrentFix } from "../fix.js";
import type { Fix } from "../types.js";

/**
 * The one-click fix a CONTINUITY gap offers.
 *
 * - Between two segments of one path step (issue #146): "Join path N to path N-1", which starts
 *   segment N where segment N-1 ends.
 * - At the start of a step (issue #186): "Start from where the robot is", which sets the step's
 *   first segment to start from `"current"`. A step that already starts from `"current"` gets none,
 *   since the fix would change nothing.
 *
 * Spread into the finding, so a gap with no fix stays without a `fixes` key.
 */
export function continuityFixes(gap: ContinuityGap, step?: Step): { fixes?: Fix[] } {
  if (gap.where === "start") {
    const first = step?.kind === "path" ? step.segments[0] : undefined;
    return first === undefined || first.from === "current" ? {} : { fixes: [startFromCurrentFix(gap.stepId)] };
  }
  if (gap.segmentIndex === undefined || gap.segmentIndex < 1) return {};
  const later = gap.segmentIndex + 1;
  return {
    fixes: [
      {
        kind: "joinSegments",
        stepId: gap.stepId,
        label: `Join path ${String(later)} to path ${String(later - 1)}`,
        params: { segmentIndex: gap.segmentIndex },
      },
    ],
  };
}
