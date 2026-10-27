import type { Robot } from "@horizon36596/zenith-schema";
import { angleDelta, wrapAngle } from "./geometry/angle.js";
import { distance, type Pose } from "./geometry/vec.js";
import type { PlanStep } from "./types.js";

/**
 * The drift (issue #481): how the planner shows a step whose end nobody can predict but whose
 * intended end it knows. A command `robot.json` marks `movesRobot` drives the robot by itself, so
 * where it leaves the robot is unknown; when the next path carries a `rejoinFrom`, `resolve` takes
 * that pose as the command's end (spec 13 section 10). The ideal playback and the instant sim both
 * move the robot from where the step starts to that end pose inside the step's own time, on the
 * same eased straight line, so the robot is on the rejoin pose, at rest, when the next path starts,
 * and the views agree with the estimate, which starts that path there too.
 *
 * The motion is a picture of "somewhere between here and there", not a prediction: the canvas
 * draws the robot in the unknown-position colour while it plays, and the step stays marked as one
 * the planner does not predict.
 *
 * Pure and deterministic, like the rest of core.
 */

/**
 * Two poses closer than this are one place for a drift, in inches and radians: below it there is
 * nothing to drift. The same 1e-6 core uses for "the same spot" elsewhere (SET BY HAND: a rounding
 * error, not a distance a robot could drive).
 */
const SAME_POSE_TOLERANCE = 1e-6;

/** True for a command step whose registry entry says it drives the robot by itself. */
export function movesRobotCommand(step: Pick<PlanStep, "step">, robot: Pick<Robot, "commands">): boolean {
  const authored = step.step;
  if (authored.kind !== "command") return false;
  return robot.commands.some((command) => command.name === authored.name && command.movesRobot === true);
}

/**
 * Where a step drifts to: the end pose the planner was given for a `movesRobot` command (the next
 * path's rejoin pose), or null when the step is not such a command, or when nothing gave it an end
 * of its own, in which case `resolve` leaves it ending where it started and the robot holds.
 */
export function driftTarget(step: PlanStep, robot: Pick<Robot, "commands">): Pose | null {
  if (!movesRobotCommand(step, robot)) return null;
  const end = step.endPose;
  if (end === null) return null;
  return posesApart(step.startPose, end) ? end : null;
}

/** True when two poses are more than a rounding error apart in place or heading. */
export function posesApart(a: Pose, b: Pose): boolean {
  return distance(a, b) > SAME_POSE_TOLERANCE || Math.abs(angleDelta(a.headingRad, b.headingRad)) > SAME_POSE_TOLERANCE;
}

/**
 * The smoothstep ease, 3u² − 2u³, for u in [0, 1]: it starts and ends at rest, so a drift neither
 * jumps off the step before it nor runs into the path after it. Chosen for that property alone
 * (SET BY HAND: the drift is a picture, not a model of how the command drives).
 */
export function smoothstep(u: number): number {
  const clamped = Math.min(1, Math.max(0, u));
  return clamped * clamped * (3 - 2 * clamped);
}

/** The ease's rate of change, 6u(1 − u), for the drift's velocity. Zero at both ends. */
export function smoothstepRate(u: number): number {
  if (u <= 0 || u >= 1) return 0;
  return 6 * u * (1 - u);
}

/**
 * The drift's pose at fraction `u` of its time: along the straight line from `from` to `to`,
 * eased, with the heading turning the short way round.
 */
export function driftPoseAt(from: Pose, to: Pose, u: number): Pose {
  const f = smoothstep(u);
  return {
    xIn: from.xIn + (to.xIn - from.xIn) * f,
    yIn: from.yIn + (to.yIn - from.yIn) * f,
    headingRad: wrapAngle(from.headingRad + angleDelta(from.headingRad, to.headingRad) * f),
  };
}
