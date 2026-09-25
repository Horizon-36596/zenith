import type { Step } from "@horizon36596/zenith-schema";
import { radToDeg } from "../geometry/angle.js";
import { HALF_TURN_TOLERANCE_RAD, linearHeadingPieces, rangeProblem } from "../heading.js";
import type { Finding, PlanStep } from "../types.js";

/**
 * HEADING: where the file asks for a heading the robot will not hold.
 *
 * - warning: a `linear` heading that asks one segment for more than half a turn. The runtime hands
 *   Pedro that segment's two headings and Pedro turns the short way, so the robot goes round the
 *   other way from the one the file wrote. The preview already draws the short way; this says so.
 * - info: a `facePoint` heading with a non-zero `offsetRad`, which the robot runtime does not pass
 *   to Pedro yet.
 *
 * HEADING_RANGES (error): a `piecewise` heading whose ranges do not run from 0 to 1 in order with no
 * gap and no overlap. Pedro's `PiecewiseInterpolator` throws on the robot for exactly these, so the
 * file cannot run. Inside ranges that are fine, a `linear` range over half a turn and a `facePoint`
 * range with an offset raise the same HEADING findings as a whole-step heading.
 */
export function checkHeading(steps: readonly PlanStep[]): Finding[] {
  const findings: Finding[] = [];
  for (const planned of steps) {
    if (planned.step.kind !== "path") continue;
    const heading = (planned.step as Extract<Step, { kind: "path" }>).heading;
    if (heading === undefined) continue;

    if (heading.mode === "piecewise") {
      const problem = rangeProblem(heading.ranges);
      if (problem !== null) {
        findings.push({ severity: "error", stepId: planned.id, code: "HEADING_RANGES", message: problem });
        continue;
      }
      for (const [index, range] of heading.ranges.entries()) {
        const inner = range.heading;
        if (inner.mode === "linear" && Math.abs(inner.toRad - inner.fromRad) > Math.PI + HALF_TURN_TOLERANCE_RAD) {
          findings.push({
            severity: "warning",
            stepId: planned.id,
            t: range.startT,
            code: "HEADING",
            message: `Range ${String(index + 1)} asks for over half a turn; the robot takes the short way. Split the range if you want the long way.`,
          });
        }
        if (inner.mode === "facePoint" && (inner.offsetRad ?? 0) !== 0) {
          findings.push({
            severity: "info",
            stepId: planned.id,
            t: range.startT,
            code: "HEADING",
            message: `The robot runtime ignores offsetRad for now (range ${String(index + 1)}).`,
          });
        }
      }
      continue;
    }

    if (heading.mode === "linear" && planned.geometry !== undefined) {
      const pieces = linearHeadingPieces(heading, planned.geometry);
      if (!pieces.some((piece) => piece.reversed)) continue;
      const turnRad = pieces.reduce((sum, piece) => sum + piece.turnRad, 0);
      findings.push({
        severity: "warning",
        stepId: planned.id,
        code: "HEADING",
        message: `This turn is over half a turn; the robot takes the short way (${String(Math.round(radToDeg(turnRad)))}°). Split the path or use a waypoint heading if you want the long way.`,
      });
      continue;
    }

    if (heading.mode === "facePoint" && (heading.offsetRad ?? 0) !== 0) {
      findings.push({
        severity: "info",
        stepId: planned.id,
        code: "HEADING",
        message: "The robot runtime ignores offsetRad for now.",
      });
    }
  }
  return findings;
}
