import type { Robot } from "@horizon36596/zenith-schema";
import { polygonBoxIn, type ObstacleShadow } from "../geometry/obstacle.js";
import { boxGapIn, convexPolygonsGap } from "../geometry/sat.js";
import type { Vec2 } from "../geometry/vec.js";
import { robotClearanceIn, robotClearanceProvenance } from "../kinematics.js";
import { provenanceLabel } from "../provenance.js";
import type { Finding, PlanSample, PlanStep } from "../types.js";
import { worstPose } from "./worst.js";

/**
 * CLEARANCE (owner ruling D8): a warning where the swept footprint comes within the robot's clearance
 * of a structure without touching it.
 *
 * - The margin is `robotClearanceIn`: `footprint.clearanceIn` in robot.json, else 1 in. No
 *   per-person setting changes it, so the CLI, the MCP server and the editor agree about one file.
 * - Structures only: the obstacle shadows STRUCTURE tests, so a box above the robot, or one that is
 *   not solid to it, is never near. The perimeter wall and keep-out zones are not covered, because
 *   riding the wall is common.
 * - Contact stays the STRUCTURE error: `checkGeometry` raises CLEARANCE for an obstacle only on a
 *   step that never touches it.
 *
 * Pure (CLAUDE.md rule 1).
 */

/** Two gaps closer than this, in inches, are a tie: the same gap held along a stretch. */
const GAP_TIE_IN = 1e-9;

/**
 * How much closer than the margin the robot must come before the warning fires, in inches. A line
 * exactly one margin clear, such as the M0 contract's 1 in clear pass, stays clean despite
 * rounding in the footprint corners.
 */
const AT_MARGIN_IN = 1e-6;

/** One sample near one obstacle: the nearest of its polygons, and where it is in the sweep. */
export interface Near {
  gapIn: number;
  sample: PlanSample;
  polygonIndex: number;
  /** The point of the robot nearest the obstacle. */
  pointIn: Vec2;
  index: number;
}

/**
 * The nearest of `polygons` to `shadow` when it is closer than `clearanceIn` and not overlapping,
 * or null. The caller has already found that none of them overlaps the shadow, so a gap of 0 is a
 * footprint lying exactly flush against it, the closest a robot can be without a STRUCTURE error.
 */
export function nearAt(
  polygons: readonly Vec2[][],
  shadow: ObstacleShadow,
  clearanceIn: number,
  sample: PlanSample,
  index: number,
): Near | null {
  if (!(clearanceIn > 0)) return null;
  let near: Near | null = null;
  for (const [polygonIndex, polygon] of polygons.entries()) {
    if (boxGapIn(polygonBoxIn(polygon), shadow.boxIn) >= clearanceIn) continue;
    const gap = convexPolygonsGap(polygon, shadow.polygonIn);
    if (gap.gapIn >= clearanceIn - AT_MARGIN_IN) continue;
    if (near === null || gap.gapIn < near.gapIn) near = { gapIn: gap.gapIn, sample, polygonIndex, pointIn: gap.pointOnA, index };
  }
  return near;
}

/**
 * The nearest of a step's samples to one obstacle. A robot driving alongside a bar is equally near
 * all the way along it, so on a tie the sample in the middle of the tied stretch is the one named,
 * as STRUCTURE does for depth.
 */
function nearest(nears: readonly Near[]): Near {
  const gapIn = Math.min(...nears.map((near) => near.gapIn));
  const tied = nears.filter((near) => near.gapIn <= gapIn + GAP_TIE_IN);
  const first = tied[0] as Near;
  const middleIn = (first.sample.sIn + (tied[tied.length - 1] as Near).sample.sIn) / 2;
  let best = first;
  for (const near of tied) {
    if (Math.abs(near.sample.sIn - middleIn) < Math.abs(best.sample.sIn - middleIn)) best = near;
  }
  return best;
}

const inches = (value: number): string => String(Math.round(value * 100) / 100);

/**
 * Where the margin came from, for the message: Zenith's default and where to change it, or the
 * robot file and its provenance label.
 */
function marginSource(robot: Robot): string {
  if (robot.footprint.clearanceIn === undefined) return "Zenith's default; set it in Settings, Robot";
  return `robot.json, ${provenanceLabel(robotClearanceProvenance(robot))}`;
}

/** The CLEARANCE finding for one obstacle on one step, from every sample that came near it. */
export function clearanceFinding(step: PlanStep, obstacleId: string, name: string, nears: readonly Near[], robot: Robot): Finding {
  const near = nearest(nears);
  const gap = `${near.gapIn.toFixed(2)} in`;
  const margin = `within ${inches(robotClearanceIn(robot))} in (${marginSource(robot)})`;
  const message =
    step.kind === "path"
      ? `The robot passes ${gap} from ${name} at t ${near.sample.t.toFixed(2)}, ${margin}.`
      : `The robot stands ${gap} from ${name} for this step, ${margin}.`;
  return {
    severity: "warning",
    stepId: step.id,
    t: near.sample.t,
    code: "CLEARANCE",
    message,
    geometry: {
      obstacleId,
      gapIn: near.gapIn,
      pointIn: { ...near.pointIn },
      ...worstPose({ depthIn: 0, sample: near.sample, polygonIndex: near.polygonIndex }),
    },
  };
}
