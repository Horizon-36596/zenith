import type { Field, Robot } from "@horizon36596/zenith-schema";
import { fieldBounds, footprintAt } from "../footprint.js";
import type { Box2 } from "../geometry/sat.js";
import type { Pose, Vec2 } from "../geometry/vec.js";
import { pastLineIn, type OwnSide } from "../season.js";
import { isTurnInPlace } from "../turnInPlace.js";
import type { Finding, PlanSample, PlanStep } from "../types.js";
import { routeAroundFix, withFix } from "./optimizeFixes.js";
import { worstPose, type Worst } from "./worst.js";

/**
 * OPPONENT_SIDE (issue #365): the robot's footprint goes past the centre line into the other
 * alliance's side during auto. The season says where the line is, which side is the alliance's own,
 * how far past it a corner may go and which rule forbids it (`SeasonRules.ownSide`); this file only
 * sweeps the footprints and reports. It is an error.
 *
 * The robot is everything `plan()` sweeps for it: the expanded body and every intake mouth, the
 * polygons PERIMETER and STRUCTURE test, because a mouth reaching over the line is part of the robot
 * over it.
 *
 * The start pose is swept like any other, by the first step that stands in it, because
 * START_ILLEGAL's own-half test measures only the start-configuration body there, and the expanded
 * body or a mouth can be over the line when that body is not. Only when START_ILLEGAL has already
 * reported that body over the line (`startReportedOver`) is `swept` (`swept.ts`) built with the start
 * pose checked, so the same pose is not reported twice. A step where the robot only stands in a pose
 * a step before it checked is not reported again either.
 *
 * Route around is offered only on a path whose own start and end are both on the alliance's side
 * (`endOver`): from an end over the line, no route can keep off the other side.
 */

/**
 * Whether START_ILLEGAL has already reported the start pose over the line: the field's start rules
 * ask for the robot's own half, the season reported the start as illegal, and the start-configuration
 * body has a corner past the line by more than the tolerance, measured with the same `pastLineIn` and
 * tolerance as the season's own-half test. Anything less, and OPPONENT_SIDE checks the start pose
 * itself.
 */
export function startReportedOver(
  field: Field,
  startPose: Pose,
  robot: Robot,
  side: OwnSide,
  startFindings: readonly Finding[],
): boolean {
  if (field.startRules?.ownHalf !== true) return false;
  if (!startFindings.some((finding) => finding.code === "START_ILLEGAL")) return false;
  return footprintAt(startPose, robot, "startIn").bodyIn.some((corner) => pastLineIn(corner, side) > side.toleranceIn);
}

/** One sample over the line: how far its worst corner goes past, and where. */
interface Over extends Worst {
  sample: PlanSample;
  /** The sample's place in the samples the step sweeps, so consecutive ones make one run. */
  index: number;
  pointIn: Vec2;
}

/** How far the polygons at one sample go past the line, the worst polygon and its worst corner. */
function overAt(sample: PlanSample, side: OwnSide, index: number): Over | null {
  let worst: Over | null = null;
  for (const [polygonIndex, polygon] of [sample.footprintIn, ...sample.mouthsIn].entries()) {
    for (const corner of polygon) {
      const past = pastLineIn(corner, side);
      if (past > side.toleranceIn && (worst === null || past > worst.depthIn)) {
        worst = { depthIn: past, sample, polygonIndex, index, pointIn: { xIn: corner.xIn, yIn: corner.yIn } };
      }
    }
  }
  return worst;
}

/** The run of consecutive samples over the line that goes farthest, and its worst sample; the first on a tie. */
function farthestRun(overs: readonly Over[]): { run: Over[]; worst: Over } | null {
  let best: { run: Over[]; worst: Over } | null = null;
  let run: Over[] = [];
  const close = (): void => {
    if (run.length === 0) return;
    const worst = run.reduce((a, b) => (b.depthIn > a.depthIn ? b : a));
    if (best === null || worst.depthIn > best.worst.depthIn) best = { run, worst };
    run = [];
  };
  for (const over of overs) {
    const last = run[run.length - 1];
    if (last !== undefined && over.index !== last.index + 1) close();
    run.push(over);
  }
  close();
  return best;
}

const inches = (value: number): string => `${value.toFixed(2)} in`;

/** The message: what crosses, how far and where, then the season's rule and what it costs. */
function message(step: PlanStep, run: readonly Over[], worst: Over, other: string, rule: string): string {
  const who = worst.polygonIndex === 0 ? "The robot" : "The robot's intake mouth";
  const into = `the centre line into ${other}'s side`;
  const depth = inches(worst.depthIn);
  let said: string;
  if (isTurnInPlace(step)) {
    said = `${who} swings ${depth} over ${into} while it turns on the spot.`;
  } else if (step.kind !== "path") {
    said = `${who} stands ${depth} over ${into} for this step.`;
  } else {
    const first = run[0] as Over;
    const last = run[run.length - 1] as Over;
    const lengthIn = Math.round(last.sample.sIn - first.sample.sIn);
    said =
      lengthIn < 1
        ? `${who} crosses ${into} at t ${worst.sample.t.toFixed(2)}, ${depth} over.`
        : `${who} crosses ${into} for about ${String(lengthIn)} in (t ${first.sample.t.toFixed(2)} to ${last.sample.t.toFixed(2)}), up to ${depth} over.`;
  }
  return `${said} ${rule}`;
}

/**
 * True when the step's own start or end has the robot over the line. Route around keeps both ends
 * where they are, and the optimizer refuses a step whose end is inside the other side's keep-out
 * (`opponentSideBox`, whose face is this same line and tolerance), so a route between such ends can
 * never stay on the alliance's own side (0.1.2 UX sweep W2-14). The end has to move first.
 */
function endOver(step: PlanStep, side: OwnSide): boolean {
  const { samples } = step;
  const first = samples[0];
  const last = samples[samples.length - 1];
  return [first, last].some((sample) => sample !== undefined && overAt(sample, side, 0) !== null);
}

export function checkOpponentSide(
  steps: readonly PlanStep[],
  swept: ReadonlyMap<PlanStep, readonly PlanSample[]>,
  side: OwnSide,
  alliance: "RED" | "BLUE",
): Finding[] {
  const findings: Finding[] = [];
  const other = alliance === "RED" ? "BLUE" : "RED";
  for (const step of steps) {
    // A group's own samples are its members', which are checked as steps of their own.
    if (step.children !== undefined) continue;
    const samples = swept.get(step) ?? step.samples;
    const overs = samples.flatMap((sample, index) => {
      const over = overAt(sample, side, index);
      return over === null ? [] : [over];
    });
    const farthest = farthestRun(overs);
    if (farthest === null) continue;
    const { run, worst } = farthest;
    const first = run[0] as Over;
    const last = run[run.length - 1] as Over;
    findings.push({
      severity: "error",
      stepId: step.id,
      t: worst.sample.t,
      code: "OPPONENT_SIDE",
      message: message(step, run, worst, other, side.rule),
      geometry: {
        pointIn: worst.pointIn,
        penetrationIn: worst.depthIn,
        ...worstPose(worst),
        ...(step.kind === "path" && !isTurnInPlace(step)
          ? { tRange: [first.sample.t, last.sample.t] as [number, number], contactIn: last.sample.sIn - first.sample.sIn }
          : {}),
      },
      ...withFix(undefined, endOver(step, side) ? null : routeAroundFix(step, "the centre line", {})),
    });
  }
  return findings;
}

/**
 * The other alliance's side as a box, for the optimizer, which keeps the footprint out of it as a
 * keep-out with no margin (`optimize/clearance.ts`). Its face toward the robot is the line moved by
 * the tolerance, so a corner the check passes clears the box and one it reports does not. The far
 * faces sit a field's width beyond the walls, so no face but that one is anywhere near the robot.
 */
export function opponentSideBox(side: OwnSide, field: Field): Box2 {
  const bounds = fieldBounds(field);
  const spanIn = Math.max(bounds.maxXIn - bounds.minXIn, bounds.maxYIn - bounds.minYIn);
  const faceIn = side.lineIn - side.ownSign * side.toleranceIn;
  const [min, max] = side.axis === "x" ? [bounds.minXIn, bounds.maxXIn] : [bounds.minYIn, bounds.maxYIn];
  // Own side above the line: the other side runs from beyond the low wall up to the face.
  const along = side.ownSign > 0 ? { low: min - spanIn, high: faceIn } : { low: faceIn, high: max + spanIn };
  return side.axis === "x"
    ? { minXIn: along.low, maxXIn: along.high, minYIn: bounds.minYIn - spanIn, maxYIn: bounds.maxYIn + spanIn }
    : { minXIn: bounds.minXIn - spanIn, maxXIn: bounds.maxXIn + spanIn, minYIn: along.low, maxYIn: along.high };
}
