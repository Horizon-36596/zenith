import type { Step } from "@horizon36596/zenith-schema";
import { integrateProfile } from "../estimate.js";
import { angleDelta, wrapAngle } from "../geometry/angle.js";
import { distance, type Pose } from "../geometry/vec.js";
import { headingFunction } from "../heading.js";
import { decelInPerS2, robotLimits, velocityCapInPerS, type RobotLimits } from "../kinematics.js";
import { containsPath } from "../resolve.js";
import type { Estimate, Plan, PlanStep } from "../types.js";

/**
 * The ideal playback level (site/docs/simulation.md, "Playback levels"): the robot follows the
 * planned geometry exactly, with no wobble and no overshoot, and its heading is the heading
 * interpolation exactly, the way the public Pedro visualizer draws a path. The clock is the one the
 * timeline already uses, the kinematic estimate (`estimate.ts`), so a path step drives along its
 * samples at `timeAtSampleS` and then holds its end pose for the settle time the estimate adds.
 *
 * The one thing the estimate does not time is a gap: a step that starts somewhere other than where
 * the robot is, or facing another way (a literal `from`, or a heading mode whose first heading is
 * not the last one). The robot has to get there, so the ideal robot does, visibly: a transition that
 * turns and drives in a straight line from the pose it has to the pose the next path starts at,
 * timed with the same kinematic model (the same caps, acceleration and deceleration as a path
 * step, from rest to rest). A transition therefore makes the ideal run longer than the estimate by
 * exactly its own duration.
 *
 * A wait or a command holds the pose for its estimated seconds, as the time model does. A parallel
 * group follows the member that drives (its deadline when that drives, else the last member with a
 * path, the same member the estimate carries the velocity through) for as long as the group lasts;
 * a branch drives its `then` side, the side the instant sim takes when it cannot read the
 * condition, and lasts as long as the estimate says (the longer side).
 *
 * Pure and deterministic, like the rest of core: the same plan and estimate give the same poses.
 */

/** Position gaps below this are the same place, in inches: canonical form rounds to 1e-4. */
export const IDEAL_POSITION_TOLERANCE_IN = 0.01;

/** Heading gaps below this are the same heading, in radians. */
export const IDEAL_HEADING_TOLERANCE_RAD = 1e-3;

/** Spacing of the profile samples along a transition, in inches, the same as a path's. */
const TRANSITION_SPACING_IN = 2;

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
  /** The routine clock at each of the step's plan samples. */
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

export type IdealSegment = IdealHold | IdealPathMotion | IdealTransition;

/** When a step starts and ends on the ideal clock. */
export interface IdealSpan {
  stepId: string;
  startS: number;
  endS: number;
  /** Seconds of transition inside the span: before the step, or inside a group's members. */
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
 * The seconds and the profile of a straight transition. A pure turn is timed at the robot's
 * angular velocity limit. A move samples the line every 2 in, turns the heading evenly with the
 * distance, caps each sample by the velocity ellipse at the default speed fraction and by the
 * heading rate, and integrates from rest to rest with the estimate's own two-pass profile.
 */
function transitionProfile(
  from: Pose,
  to: Pose,
  limits: RobotLimits,
): { translateIn: number; turnRad: number; sIns: number[]; timesS: number[] } {
  const translateIn = distance(from, to);
  const turnRad = angleDelta(from.headingRad, to.headingRad);
  if (translateIn <= IDEAL_POSITION_TOLERANCE_IN) {
    const seconds = limits.maxAngularVelRadPerS > 0 ? Math.abs(turnRad) / limits.maxAngularVelRadPerS : 0;
    return { translateIn: 0, turnRad, sIns: [0, 0], timesS: [0, seconds] };
  }

  const sIns: number[] = [];
  for (let s = 0; s < translateIn; s += TRANSITION_SPACING_IN) sIns.push(s);
  sIns.push(translateIn);
  const travelRad = Math.atan2(to.yIn - from.yIn, to.xIn - from.xIn);
  const headingRatePerIn = Math.abs(turnRad) / translateIn;
  const samples = sIns.map((sIn) => {
    const headingRad = wrapAngle(from.headingRad + turnRad * (sIn / translateIn));
    const phiRad = wrapAngle(travelRad - headingRad);
    let capInPerS = limits.defaultPathSpeedFraction * velocityCapInPerS(limits, phiRad);
    if (headingRatePerIn > 1e-9) capInPerS = Math.min(capInPerS, limits.maxAngularVelRadPerS / headingRatePerIn);
    return { sIn, phiRad, capInPerS, decelInPerS2: decelInPerS2(limits, phiRad) };
  });
  const timing = integrateProfile(samples, limits, 0, 0);
  return { translateIn, turnRad, sIns, timesS: timing.timeAtSampleS };
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

  /** Moves the cursor to `target` with a transition when it is not there already; returns its seconds. */
  const transitionTo = (stepId: string, cursor: Cursor, target: Pose): number => {
    if (!posesDiffer(cursor.pose, target)) {
      cursor.pose = target;
      return 0;
    }
    const profile = transitionProfile(cursor.pose, target, limits);
    const seconds = profile.timesS[profile.timesS.length - 1] ?? 0;
    const transition: IdealTransition = {
      kind: "transition",
      stepId,
      startS: cursor.clockS,
      endS: cursor.clockS + seconds,
      fromPose: cursor.pose,
      toPose: target,
      translateIn: profile.translateIn,
      turnRad: profile.turnRad,
      sIns: profile.sIns,
      timesS: profile.timesS.map((at) => cursor.clockS + at),
    };
    transitions.push(transition);
    push(transition);
    cursor.clockS = transition.endS;
    cursor.pose = target;
    return seconds;
  };

  /**
   * One step from the cursor. `record` is false for members whose motion is not the one drawn (the
   * non-driving members of a parallel group, the `else` side of a branch): they are still timed, so
   * their spans exist, but they add no segments and do not move the robot.
   */
  const walk = (step: PlanStep, cursor: Cursor, record: boolean): number => {
    const startS = cursor.clockS;
    const ownS = byId[step.id]?.nominalS ?? null;
    let transitionS = 0;

    if (step.kind === "path" && step.geometry !== undefined && step.samples.length >= 2) {
      const pathStep = step.step as Extract<Step, { kind: "path" }>;
      if (record) {
        transitionS += transitionTo(step.id, cursor, step.startPose);
      } else if (posesDiffer(cursor.pose, step.startPose)) {
        transitionS += transitionProfileSeconds(cursor.pose, step.startPose, limits);
        cursor.clockS += transitionS;
      }
      const atSample = byId[step.id]?.timeAtSampleS;
      const offsets =
        atSample !== undefined && atSample.length === step.samples.length
          ? atSample
          : step.samples.map((sample) => sample.t * Math.max(0, (ownS ?? 0) - limits.settleS));
      const moveS = offsets[offsets.length - 1] ?? 0;
      const motionStartS = cursor.clockS;
      if (record) {
        push({
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
      }
      cursor.clockS = motionStartS + moveS;
      cursor.pose = step.endPose ?? step.samples[step.samples.length - 1]?.pose ?? cursor.pose;
      const settleS = Math.max(0, (ownS ?? moveS) - moveS);
      if (record) hold(step.id, cursor, settleS);
      else cursor.clockS += settleS;
    } else if (step.children !== undefined && step.children.length > 0) {
      transitionS += walkGroup(step, cursor, record);
    } else {
      // A wait, a command, or a path with nothing to drive: the robot holds where it is.
      if (record) hold(step.id, cursor, ownS ?? 0);
      else cursor.clockS += ownS ?? 0;
    }

    spans.push({ stepId: step.id, startS, endS: cursor.clockS, transitionS });
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
    let pose = entry;
    for (const segment of moverSegments) {
      if (segment.startS >= endS && segment.endS > segment.startS) break;
      if (segment.endS <= endS) {
        segments.push(segment);
        pose = segmentEndPose(segment);
      } else {
        segments.push({ ...segment, endS } as IdealSegment);
        pose = poseInSegment(segment, endS);
      }
    }
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

/** The seconds a transition would take, for a member that is timed but not drawn. */
function transitionProfileSeconds(from: Pose, to: Pose, limits: RobotLimits): number {
  const profile = transitionProfile(from, to, limits);
  return profile.timesS[profile.timesS.length - 1] ?? 0;
}

/** Where a segment leaves the robot at its natural end. */
function segmentEndPose(segment: IdealSegment): Pose {
  switch (segment.kind) {
    case "hold":
      return segment.pose;
    case "transition":
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

/** The pose inside one segment at a routine time, clamped to the segment. */
function poseInSegment(segment: IdealSegment, atS: number): Pose {
  if (segment.kind === "hold") return segment.pose;
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

/**
 * The ideal clock when the robot reaches arc-length fraction `t` of a path step, or null when the
 * step is not driven on the ideal run (a member that is timed but not drawn).
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
  for (let index = 0; index + 1 < count; index += 1) {
    const sa = (step.samples[index] as { sIn: number }).sIn;
    const sb = (step.samples[index + 1] as { sIn: number }).sIn;
    if (sIn <= sb) {
      const u = sb - sa <= 1e-12 ? 0 : (sIn - sa) / (sb - sa);
      const ta = timesS[index] as number;
      return ta + ((timesS[index + 1] as number) - ta) * u;
    }
  }
  return timesS[count - 1] as number;
}
