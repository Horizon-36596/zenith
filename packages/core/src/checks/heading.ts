import type { Step } from "@horizon36596/zenith-schema";
import { radToDeg } from "../geometry/angle.js";
import { HALF_TURN_TOLERANCE_RAD, linearHeadingPieces, rangeProblem, type LinearHeadingPiece } from "../heading.js";
import type { Finding, Fix, PlanStep } from "../types.js";

/**
 * How many equal pieces a sweep of `sweepRad` takes so that none asks for more than half a turn,
 * less the tolerance, the way `linearHeadingPieces` measures it (issue #186).
 */
const piecesFor = (sweepRad: number): number =>
  Math.max(2, Math.ceil(Math.abs(sweepRad) / (Math.PI - HALF_TURN_TOLERANCE_RAD)));

const intoParts = (parts: number): string => (parts === 2 ? "in two" : `into ${String(parts)}`);

/**
 * The split fix for a `linear` heading: the piece that asks for the most of the reversed ones is
 * its segment, and cutting that segment into equal lengths shares its sweep out equally, because
 * the runtime shares a linear sweep by arc length. The heading stays the one sweep, so the robot
 * faces at each cut exactly where it was meant to. The segment's resolved ends go with the fix, so
 * it can cut a segment that starts from `"current"` or ends at a waypoint and keep those ends.
 */
function splitFix(planned: PlanStep, pieces: readonly LinearHeadingPiece[]): Fix | null {
  const ask = (piece: LinearHeadingPiece): number => Math.abs(piece.toRad - piece.fromRad);
  let worst = -1;
  for (const [index, piece] of pieces.entries()) {
    const best = pieces[worst];
    if (piece.reversed && (best === undefined || ask(piece) > ask(best))) worst = index;
  }
  const piece = pieces[worst];
  const ends = planned.segments?.[worst];
  if (piece === undefined || ends === undefined) return null;
  const parts = piecesFor(piece.toRad - piece.fromRad);
  const which = pieces.length === 1 ? "the path" : `path ${String(worst + 1)}`;
  return {
    kind: "splitSegment",
    stepId: planned.id,
    label: `Split ${which} ${intoParts(parts)}`,
    params: {
      segmentIndex: worst,
      atFractions: Array.from({ length: parts - 1 }, (_, cut) => (cut + 1) / parts),
      fromIn: { xIn: ends.fromPose.xIn, yIn: ends.fromPose.yIn },
      toIn: { xIn: ends.toPose.xIn, yIn: ends.toPose.yIn },
    },
  };
}

/**
 * HEADING: where the file asks for a heading the robot will not hold.
 *
 * - warning: a `linear` heading that asks one segment for more than half a turn. The runtime hands
 *   Pedro that segment's two headings and Pedro turns the short way, so the robot goes round the
 *   other way from the one the file wrote. The preview already draws the short way; this says so,
 *   and offers the split fix that keeps every piece under half a turn (issue #186).
 * - info: a `facePoint` heading with a non-zero `offsetRad`, which the robot runtime does not pass
 *   to Pedro yet.
 *
 * HEADING_RANGES (error): a `piecewise` heading whose ranges do not run from 0 to 1 in order with no
 * gap and no overlap. Pedro's `PiecewiseInterpolator` throws on the robot for exactly these, so the
 * file cannot run. Inside ranges that are fine, a `linear` range over half a turn and a `facePoint`
 * range with an offset raise the same HEADING findings as a whole-step heading; the range's warning
 * offers to split the range into pieces that each turn under half a turn.
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
          const parts = piecesFor(inner.toRad - inner.fromRad);
          findings.push({
            severity: "warning",
            stepId: planned.id,
            t: range.startT,
            code: "HEADING",
            message: `Range ${String(index + 1)} asks for over half a turn; the robot takes the short way. Split the range if you want the long way.`,
            fixes: [
              {
                kind: "splitHeadingRange",
                stepId: planned.id,
                label: `Split range ${String(index + 1)} ${intoParts(parts)}`,
                params: { rangeIndex: index, parts },
              },
            ],
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
      const split = splitFix(planned, pieces);
      findings.push({
        severity: "warning",
        stepId: planned.id,
        code: "HEADING",
        message: `This turn is over half a turn; the robot takes the short way (${String(Math.round(radToDeg(turnRad)))}°). Split the path or use a waypoint heading if you want the long way.`,
        ...(split === null ? {} : { fixes: [split] }),
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
