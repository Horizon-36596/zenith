import type { Step } from "@horizon36596/zenith-schema";
import {
  IDEAL_HEADING_TOLERANCE_RAD,
  IDEAL_POSITION_TOLERANCE_IN,
  transitionProfile,
} from "../estimate.js";
import { driftPoseAt, driftTarget } from "../drift.js";
import { angleDelta, wrapAngle } from "../geometry/angle.js";
import { distance, type Pose } from "../geometry/vec.js";
import { headingFunction } from "../heading.js";
import { robotLimits, type RobotLimits } from "../kinematics.js";
import { containsPath } from "../resolve.js";
import { holdTurnRad, isTurnInPlace } from "../turnInPlace.js";
import type { Estimate, Plan, PlanStep } from "../types.js";

export { IDEAL_HEADING_TOLERANCE_RAD, IDEAL_POSITION_TOLERANCE_IN };

/**
 * The ideal playback level (site/docs/simulation.md, "Playback levels"): the robot follows the
 * planned geometry exactly, with no wobble and no overshoot, and its heading is the heading
 * interpolation exactly, the way the public Pedro visualizer draws a path. The clock is the one the
 * timeline already uses, the kinematic estimate (`estimate.ts`), so a path step drives along its
 * samples at `timeAtSampleS` and then holds its end pose for the settle time the estimate adds.
 *
 * Where a step starts somewhere other than where the robot is, or facing another way (a literal
 * `from`, or a heading mode whose first heading is not the last one), the robot has to get there,
 * so the ideal robot does, visibly: a transition that turns and drives in a straight line from the
 * pose it has to the pose the next path starts at, timed with the same kinematic model
 * (`estimate.transitionProfile`: the same caps, acceleration and deceleration as a path step, from
 * rest to rest).
 *
 * A path that starts on the robot's spot but facing another way is a joint turn, which the estimate
 * times itself (`StepEstimate.turnS`), so the ideal robot plays that turn out of the step's own
 * seconds and it adds nothing beyond the estimate. Only a gap, a drive the estimate does not time,
 * makes the ideal run longer than the estimate, by what its transition takes beyond the turn the
 * estimate counted. A gap comes from a literal-pose `from`, or from a timeout shorter than a path's
 * estimate: the estimate counts that path only up to its timeout (`StepEstimate.uncappedS`), so the
 * ideal robot stops there, short of the path's end, and the next path, planned from that end, opens
 * with a transition across what is left.
 *
 * A turn on the spot, a path step with no length (`turnInPlace.ts`), is a pure turn inside its own
 * span, from the heading the robot arrives with to the end heading, over the step's own seconds.
 *
 * A wait or a command holds the pose for its estimated seconds, as the time model does, with one
 * exception: a command that drives the robot by itself (`movesRobot`) and that the next path
 * rejoins (`rejoinFrom`) drifts (`drift.ts`). Its end is not a prediction, but the plan knows where
 * it is meant to end, so the robot moves there inside the step's own seconds, eased, and is at rest
 * on the rejoin pose when that path starts: no transition, and the ideal total is the estimate's.
 * A parallel
 * group follows the member that drives (its deadline when that drives, else the last member with a
 * path, the same member the estimate carries the velocity through) for as long as the group lasts;
 * a branch drives its `then` side, the side the instant sim takes when it cannot read the
 * condition, and lasts as long as the estimate says (the longer side).
 *
 * Pure and deterministic, like the rest of core: the same plan and estimate give the same poses.
 */

/** The robot holds still: at a wait, a command, a path's settle, or the end of a group. */
export interface IdealHold {
  kind: "hold";
  /** The step whose time this is, or null for a hold that belongs to no step. */
  stepId: string | null;
  startS: number;
  endS: number;
  pose: Pose;
}

/** The robot drives a path step along its planned geometry. */
export interface IdealPathMotion {
  kind: "path";
  stepId: string;
  startS: number;
  endS: number;
  step: PlanStep;
  /**
   * The routine clock at each of the step's plan samples. When a timeout or the end of its group
   * cuts the motion short, `endS` is where it stops and the samples after it are never reached.
   */
  timesS: readonly number[];
  /** h(t) for the step's heading mode, evaluated exactly rather than between samples. */
  headingAt: (t: number) => number;
}

/** The robot turns and drives from where it is to where the next path starts. */
export interface IdealTransition {
  kind: "transition";
  /** The step this transition leads into. */
  stepId: string;
  startS: number;
  endS: number;
  fromPose: Pose;
  toPose: Pose;
  /** How far it drives, in inches, and how far it turns (signed, the short way), in radians. */
  translateIn: number;
  turnRad: number;
  /** Distance along the straight line and the clock there, from the profile. */
  sIns: readonly number[];
  timesS: readonly number[];
}

/**
 * The robot drifts from where a `movesRobot` command starts to the end pose the plan was given for
 * it (the next path's rejoin pose), over the command's own seconds, along a straight line eased by
 * smoothstep and turning the short way (`drift.ts`). It is a guess at where the robot is, drawn as
 * one, not a prediction.
 */
export interface IdealDrift {
  kind: "drift";
  stepId: string;
  startS: number;
  endS: number;
  fromPose: Pose;
  toPose: Pose;
}

export type IdealSegment = IdealHold | IdealPathMotion | IdealTransition | IdealDrift;

/** When a step starts and ends on the ideal clock. */
export interface IdealSpan {
  stepId: string;
  startS: number;
  endS: number;
  /**
   * Seconds of transition inside the span that the estimate does not count: what a transition takes
   * beyond the step's joint turn, before the step or inside a group's members. A joint turn alone
   * adds none, since it is already part of the step's estimate.
   */
  transitionS: number;
}

export interface IdealTrajectory {
  startPose: Pose;
  /** Contiguous, in time order, from 0 to `totalS`. */
  segments: IdealSegment[];
  /** Every step, groups and their members included, in document order. */
  spans: IdealSpan[];
  transitions: IdealTransition[];
  totalS: number;
}

interface Cursor {
  clockS: number;
  pose: Pose;
}

/** True when the robot has to move or turn to get from one pose to the other. */
export function posesDiffer(a: Pose, b: Pose): boolean {
  return (
    distance(a, b) > IDEAL_POSITION_TOLERANCE_IN ||
    Math.abs(angleDelta(a.headingRad, b.headingRad)) > IDEAL_HEADING_TOLERANCE_RAD
  );
}

/**
 * Lays the plan on the ideal clock. Throws nothing: a step without an estimate takes no time, the
 * way it counts as zero in the estimate's total.
 */
export function idealTrajectory(plan: Plan, estimate: Estimate): IdealTrajectory {
  const limits = robotLimits(plan.robot);
  const byId = estimate.byStepId;
  const segments: IdealSegment[] = [];
  const spans: IdealSpan[] = [];
  const transitions: IdealTransition[] = [];

  const push = (segment: IdealSegment): void => {
    if (segment.endS - segment.startS <= 0 && segment.kind !== "path") return;
    segments.push(segment);
  };
  const hold = (stepId: string | null, cursor: Cursor, seconds: number): void => {
    if (seconds <= 0) return;
    push({ kind: "hold", stepId, startS: cursor.clockS, endS: cursor.clockS + seconds, pose: cursor.pose });
    cursor.clockS += seconds;
  };

  /**
   * One step from the cursor. `record` is false for members whose motion is not the one drawn (the
   * non-driving members of a parallel group, the `else` side of a branch): they are still timed, so
   * their spans exist, but they add no segments and do not move the robot.
   */
  const walk = (step: PlanStep, cursor: Cursor, record: boolean): number => {
    const startS = cursor.clockS;
    const row = byId[step.id];
    const ownS = row?.nominalS ?? null;
    let transitionS = 0;

    if (isTurnInPlace(step) && step.samples.length >= 2) {
      transitionS += walkTurn(step, cursor, record);
    } else if (step.kind === "path" && step.geometry !== undefined && step.samples.length >= 2) {
      const pathStep = step.step as Extract<Step, { kind: "path" }>;
      // The step's motion is laid out whether or not it is drawn, so a member that is timed but not
      // drawn ends where the drawn one would, a timeout's cut included.
      const own: IdealSegment[] = [];
      // The joint turn the estimate already counts in this step's own seconds.
      const turnS = row?.turnS ?? 0;
      let playedS = 0;
      if (posesDiffer(cursor.pose, step.startPose)) {
        const { transition, seconds } = transitionBetween(step.id, cursor.clockS, cursor.pose, step.startPose, limits);
        own.push(transition);
        // The profile's own seconds, not `endS - startS`, which rounds a pure turn a hair past the
        // joint turn the estimate counts and would show a transition of nothing on the timeline.
        playedS = seconds;
      }
      let clockS = startS + playedS;
      // Only what the transition takes beyond that turn is time the estimate does not count. A
      // transition shorter than the counted turn leaves the robot waiting out the rest, so the step
      // still lasts its estimate.
      transitionS += Math.max(0, playedS - turnS);
      if (playedS < turnS) {
        own.push({ kind: "hold", stepId: step.id, startS: clockS, endS: startS + turnS, pose: step.startPose });
        clockS = startS + turnS;
      }
      const offsets =
        row?.timeAtSampleS !== undefined && row.timeAtSampleS.length === step.samples.length
          ? row.timeAtSampleS
          : step.samples.map((sample) => sample.t * Math.max(0, (ownS ?? 0) - turnS - limits.settleS));
      const moveS = offsets[offsets.length - 1] ?? 0;
      const motionStartS = clockS;
      own.push({
        kind: "path",
        stepId: step.id,
        startS: motionStartS,
        endS: motionStartS + moveS,
        step,
        timesS: offsets.map((at) => motionStartS + at),
        headingAt:
          pathStep.heading === undefined
            ? () => step.startPose.headingRad
            : headingFunction(pathStep.heading, step.geometry),
      });
      clockS = motionStartS + moveS;
      let pose = step.endPose ?? step.samples[step.samples.length - 1]?.pose ?? step.startPose;
      const settleS = Math.max(0, (ownS ?? moveS) - turnS - moveS);
      if (settleS > 0) own.push({ kind: "hold", stepId: step.id, startS: clockS, endS: clockS + settleS, pose });
      clockS += settleS;

      // A timeout shorter than the step's estimate stops the robot where it runs out, which the
      // estimate counts the step up to (`StepEstimate.uncappedS`): the robot stays there, short of
      // the path's end, and the next path, planned from that end, closes the gap with a transition.
      let kept: readonly IdealSegment[] = own;
      const cutS = row?.uncappedS !== undefined && ownS !== null ? startS + transitionS + ownS : null;
      if (cutS !== null && clockS > cutS) {
        const cut = cutAt(own, cutS, cursor.pose);
        kept = cut.kept;
        pose = cut.pose;
        clockS = cutS;
      }
      if (record) {
        for (const segment of kept) {
          if (segment.kind === "transition") transitions.push(segment);
          push(segment);
        }
      }
      cursor.clockS = clockS;
      cursor.pose = pose;
    } else if (step.children !== undefined && step.children.length > 0) {
      transitionS += walkGroup(step, cursor, record);
    } else {
      // A wait, a command, or a path with nothing to drive: the robot holds where it is, unless the
      // step is a command that drives the robot to a pose the plan knows it is meant to end at.
      const seconds = ownS ?? 0;
      const target = driftTarget(step, plan.robot);
      if (target !== null && seconds > 0 && posesDiffer(cursor.pose, target)) {
        if (record) {
          push({ kind: "drift", stepId: step.id, startS: cursor.clockS, endS: cursor.clockS + seconds, fromPose: cursor.pose, toPose: target });
        }
        cursor.clockS += seconds;
        cursor.pose = target;
      } else if (record) {
        hold(step.id, cursor, seconds);
      } else {
        cursor.clockS += seconds;
      }
    }

    spans.push({ stepId: step.id, startS, endS: cursor.clockS, transitionS });
    return transitionS;
  };

  /**
   * A turn on the spot (`turnInPlace.ts`), laid out as a pure turn inside its own span: the robot
   * stays on the step's point and turns from the heading it arrives with to the end heading, the
   * short way, over the step's own seconds. A robot that is somewhere else first closes the gap with
   * a transition, which the estimate does not count. A timeout shorter than the turn stops it part
   * way round, as it does a path. Returns the seconds of transition the estimate does not count.
   */
  const walkTurn = (step: PlanStep, cursor: Cursor, record: boolean): number => {
    const startS = cursor.clockS;
    const row = byId[step.id];
    const ownS = row?.nominalS ?? 0;
    // The turn starts from the heading the robot arrives with, not the one the plan expected: a turn
    // after a step a timeout cut short must not swing back to the planned heading first.
    const from: Pose = { ...step.startPose, headingRad: cursor.pose.headingRad };
    const to = step.endPose ?? (step.samples[step.samples.length - 1] as { pose: Pose }).pose;
    const own: IdealSegment[] = [];
    let gap = false;
    let clockS = startS;
    let transitionS = 0;
    if (posesDiffer(cursor.pose, from)) {
      const { transition, seconds } = transitionBetween(step.id, clockS, cursor.pose, from, limits);
      own.push(transition);
      gap = true;
      clockS += seconds;
      transitionS += seconds;
    }
    const turnS = row?.uncappedS ?? ownS;
    own.push({
      kind: "transition",
      stepId: step.id,
      startS: clockS,
      endS: clockS + turnS,
      fromPose: from,
      toPose: to,
      translateIn: 0,
      turnRad: holdTurnRad(from.headingRad, to.headingRad),
      sIns: [0, 0],
      timesS: [clockS, clockS + turnS],
    });
    clockS += turnS;
    let pose = to;
    let kept: readonly IdealSegment[] = own;
    const cutS = startS + transitionS + ownS;
    if (row?.uncappedS !== undefined && clockS > cutS) {
      const cut = cutAt(own, cutS, cursor.pose);
      kept = cut.kept;
      pose = cut.pose;
      clockS = cutS;
    }
    if (record) {
      // The gap, when there is one, is the first segment; the turn itself is not a gap.
      for (const [index, segment] of kept.entries()) {
        if (gap && index === 0 && segment.kind === "transition") transitions.push(segment);
        push(segment);
      }
    }
    cursor.clockS = clockS;
    cursor.pose = pose;
    return transitionS;
  };

  const walkGroup = (step: PlanStep, cursor: Cursor, record: boolean): number => {
    const children = step.children ?? [];
    const startS = cursor.clockS;
    const entry = cursor.pose;
    const authored = step.step;

    if (authored.kind === "sequence") {
      let transitionS = 0;
      for (const child of children) transitionS += walk(child, cursor, record);
      return transitionS;
    }

    if (authored.kind === "branch") {
      const thenCount = authored.then.length;
      const thenCursor: Cursor = { clockS: startS, pose: entry };
      let transitionS = 0;
      for (const child of children.slice(0, thenCount)) transitionS += walk(child, thenCursor, record);
      const elseCursor: Cursor = { clockS: startS, pose: entry };
      for (const child of children.slice(thenCount)) walk(child, elseCursor, false);
      // The estimate costs a branch as its longer side; the ideal robot waits out the difference.
      const endS = Math.max(thenCursor.clockS, elseCursor.clockS);
      cursor.pose = thenCursor.pose;
      cursor.clockS = thenCursor.clockS;
      if (record) hold(step.id, cursor, endS - thenCursor.clockS);
      cursor.clockS = endS;
      return transitionS;
    }

    // Parallel: every member starts together from the group's start; the driving one is drawn.
    const group = authored as Extract<Step, { kind: "parallel" }>;
    const mover =
      children.find((child) => child.id === group.deadline && containsPath(child)) ??
      [...children].reverse().find(containsPath);
    const ends = new Map<string, number>();
    let transitionS = 0;
    let moverCursor: Cursor | null = null;
    const moverSegments: IdealSegment[] = [];
    for (const child of children) {
      const childCursor: Cursor = { clockS: startS, pose: entry };
      if (child === mover) {
        const before = segments.length;
        transitionS += walk(child, childCursor, record);
        moverSegments.push(...segments.splice(before));
        moverCursor = childCursor;
      } else {
        walk(child, childCursor, false);
      }
      ends.set(child.id, childCursor.clockS);
    }
    const durations = [...ends.values()].map((endS) => endS - startS);
    let groupS: number;
    if (group.mode === "deadline" && ends.has(group.deadline ?? "")) {
      groupS = (ends.get(group.deadline ?? "") as number) - startS;
    } else if (group.mode === "race") {
      groupS = durations.length === 0 ? 0 : Math.min(...durations);
    } else {
      groupS = durations.length === 0 ? 0 : Math.max(...durations);
    }
    const endS = startS + groupS;

    if (!record) {
      cursor.pose = moverCursor?.pose ?? entry;
      cursor.clockS = endS;
      return transitionS;
    }

    // The mover's motion, cut where the group ends (a race or a deadline can end it early).
    const cut = cutAt(moverSegments, endS, entry);
    segments.push(...cut.kept);
    let pose = cut.pose;
    if (moverCursor !== null && moverCursor.clockS <= endS) pose = moverCursor.pose;
    const last = segments[segments.length - 1];
    const lastS = last === undefined ? startS : Math.max(startS, last.endS);
    cursor.pose = pose;
    cursor.clockS = Math.min(lastS, endS);
    hold(step.id, cursor, endS - cursor.clockS);
    cursor.clockS = endS;
    return transitionS;
  };

  const cursor: Cursor = { clockS: 0, pose: plan.startPose };
  for (const step of plan.steps) walk(step, cursor, true);

  return { startPose: plan.startPose, segments, spans, transitions, totalS: cursor.clockS };
}

/** The transition from one pose to another, starting at `startS` on the routine clock, and its seconds. */
function transitionBetween(
  stepId: string,
  startS: number,
  from: Pose,
  to: Pose,
  limits: RobotLimits,
): { transition: IdealTransition; seconds: number } {
  const profile = transitionProfile(from, to, limits);
  const seconds = profile.timesS[profile.timesS.length - 1] ?? 0;
  const transition: IdealTransition = {
    kind: "transition",
    stepId,
    startS,
    endS: startS + seconds,
    fromPose: from,
    toPose: to,
    translateIn: profile.translateIn,
    turnRad: profile.turnRad,
    sIns: profile.sIns,
    timesS: profile.timesS.map((at) => startS + at),
  };
  return { transition, seconds };
}

/**
 * Segments in time order, cut where `endS` falls: the ones that start after it are dropped and the
 * one it falls inside ends there. Also says where that leaves the robot, `entry` when nothing ran.
 */
function cutAt(list: readonly IdealSegment[], endS: number, entry: Pose): { kept: IdealSegment[]; pose: Pose } {
  const kept: IdealSegment[] = [];
  let pose = entry;
  for (const segment of list) {
    if (segment.startS >= endS && segment.endS > segment.startS) break;
    if (segment.endS <= endS) {
      kept.push(segment);
      pose = segmentEndPose(segment);
    } else {
      kept.push({ ...segment, endS } as IdealSegment);
      pose = poseInSegment(segment, endS);
    }
  }
  return { kept, pose };
}

/** Where a segment leaves the robot at its natural end. */
function segmentEndPose(segment: IdealSegment): Pose {
  switch (segment.kind) {
    case "hold":
      return segment.pose;
    case "transition":
    case "drift":
      return segment.toPose;
    case "path":
      return poseInSegment(segment, segment.endS);
  }
}

/** Linear interpolation of a clock series: the index before `atS` and the fraction past it. */
function locate(timesS: readonly number[], atS: number): { index: number; u: number } {
  const count = timesS.length;
  if (count < 2 || atS <= (timesS[0] as number)) return { index: 0, u: 0 };
  if (atS >= (timesS[count - 1] as number)) return { index: Math.max(0, count - 2), u: 1 };
  let lo = 0;
  let hi = count - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((timesS[mid] as number) <= atS) lo = mid;
    else hi = mid;
  }
  const ta = timesS[lo] as number;
  const tb = timesS[hi] as number;
  return { index: lo, u: tb - ta <= 1e-12 ? 1 : (atS - ta) / (tb - ta) };
}

/**
 * The pose inside one segment at a routine time, clamped to the segment. A segment that a timeout or
 * the end of its group cuts short keeps the clock of its whole motion, so the clamp to `endS` is
 * what stops the robot where the cut falls.
 */
function poseInSegment(segment: IdealSegment, rawS: number): Pose {
  if (segment.kind === "hold") return segment.pose;
  const atS = Math.min(rawS, segment.endS);
  if (segment.kind === "drift") {
    const lengthS = segment.endS - segment.startS;
    return driftPoseAt(segment.fromPose, segment.toPose, lengthS <= 1e-12 ? 1 : (atS - segment.startS) / lengthS);
  }
  if (segment.kind === "transition") {
    if (segment.translateIn === 0) {
      const start = segment.timesS[0] as number;
      const end = segment.timesS[segment.timesS.length - 1] as number;
      const u = end - start <= 1e-12 ? 1 : Math.min(1, Math.max(0, (atS - start) / (end - start)));
      return {
        xIn: segment.toPose.xIn,
        yIn: segment.toPose.yIn,
        headingRad: wrapAngle(segment.fromPose.headingRad + segment.turnRad * u),
      };
    }
    const { index, u } = locate(segment.timesS, atS);
    const sa = segment.sIns[index] as number;
    const sb = segment.sIns[Math.min(index + 1, segment.sIns.length - 1)] as number;
    const f = (sa + (sb - sa) * u) / segment.translateIn;
    return {
      xIn: segment.fromPose.xIn + (segment.toPose.xIn - segment.fromPose.xIn) * f,
      yIn: segment.fromPose.yIn + (segment.toPose.yIn - segment.fromPose.yIn) * f,
      headingRad: wrapAngle(segment.fromPose.headingRad + segment.turnRad * f),
    };
  }
  const { step, timesS } = segment;
  const geometry = step.geometry;
  if (geometry === undefined) return step.startPose;
  const { index, u } = locate(timesS, atS);
  const sa = (step.samples[index] as { sIn: number }).sIn;
  const sb = (step.samples[Math.min(index + 1, step.samples.length - 1)] as { sIn: number }).sIn;
  const sIn = sa + (sb - sa) * u;
  const point = geometry.pointAtDistance(sIn);
  return { xIn: point.xIn, yIn: point.yIn, headingRad: segment.headingAt(geometry.tAtDistance(sIn)) };
}

/**
 * The ideal robot's pose at a routine time: on the planned path exactly while a path runs, on the
 * straight line of a transition while it closes a gap, and still otherwise. Before 0 it is at the
 * start pose, and after the end at the last pose.
 */
export function idealPoseAt(trajectory: IdealTrajectory, atS: number): Pose {
  const segments = trajectory.segments;
  if (segments.length === 0) return trajectory.startPose;
  const first = segments[0] as IdealSegment;
  if (atS <= first.startS) return poseInSegment(first, first.startS);
  let lo = 0;
  let hi = segments.length - 1;
  if (atS >= (segments[hi] as IdealSegment).startS) return poseInSegment(segments[hi] as IdealSegment, atS);
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((segments[mid] as IdealSegment).startS <= atS) lo = mid;
    else hi = mid;
  }
  return poseInSegment(segments[lo] as IdealSegment, atS);
}

/** How far past a cut, in seconds, a point still counts as the place the robot stops. */
const REACHED_TOLERANCE_S = 1e-6;

/**
 * The ideal clock when the robot reaches arc-length fraction `t` of a path step, or null when the
 * robot does not get there on the ideal run: the step is a member that is timed but not drawn, or a
 * timeout or the end of its group stops the robot before that point.
 */
export function idealTimeAt(trajectory: IdealTrajectory, stepId: string, t: number): number | null {
  const motion = trajectory.segments.find(
    (segment): segment is IdealPathMotion => segment.kind === "path" && segment.stepId === stepId,
  );
  if (motion === undefined) return null;
  const { step, timesS } = motion;
  const sIn = step.lengthIn * Math.min(1, Math.max(0, t));
  const count = Math.min(step.samples.length, timesS.length);
  if (count === 0) return null;
  // The point TIMEOUT_TIGHT names as where the robot stops can land a rounding error past the cut.
  const reached = (atS: number): number | null =>
    atS > motion.endS + REACHED_TOLERANCE_S ? null : Math.min(atS, motion.endS);
  for (let index = 0; index + 1 < count; index += 1) {
    const sa = (step.samples[index] as { sIn: number }).sIn;
    const sb = (step.samples[index + 1] as { sIn: number }).sIn;
    if (sIn <= sb) {
      const u = sb - sa <= 1e-12 ? 0 : (sIn - sa) / (sb - sa);
      const ta = timesS[index] as number;
      return reached(ta + ((timesS[index + 1] as number) - ta) * u);
    }
  }
  return reached(timesS[count - 1] as number);
}
