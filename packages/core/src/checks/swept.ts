import { angleDelta } from "../geometry/angle.js";
import type { Pose } from "../geometry/vec.js";
import type { PlanSample, PlanStep } from "../types.js";

/**
 * Which footprint samples the footprint checks (PERIMETER, STRUCTURE, KEEPOUT) sweep for each step,
 * so that one collision is reported once, on the step that drove into it (issue #152).
 *
 * The plan gives a command, a wait or a transfer one sample, the pose it stands at, and gives a
 * path a sample at its start, its `s = 0`. Both are the pose the robot is already in when the step
 * begins, which the step before it has already checked: a robot that ends a path against a flower's
 * foot and then waits, stops its intake and drives away was reported four times for one overlap.
 *
 * The walk below goes through the steps in the order they run and carries the full pose the robot
 * enters each step with, heading included. A stationary step's sample, or a path's `s = 0` sample,
 * is left out when it is that entry pose and the entry pose has already been checked. Anything else
 * is swept as before, so:
 *
 * - the auto's start pose counts as not yet checked, so the first step to stand there reports it;
 * - a path that turns on the spot as it starts (a tangent path off a wall start) has a first
 *   sample with a new heading, which is a new pose, so it is still checked and keeps its finding;
 * - a path that starts somewhere else (a CONTINUITY gap) is checked from its own start.
 *
 * The members of a parallel group all start at the group's entry pose, and the arms of a branch
 * both start at the branch's, so the first of them to check that pose covers it for the rest.
 */

/** How close two poses are to count as the same one, in inches and in radians. */
const SAME_POSE_IN = 1e-3;
/**
 * Canonical form rounds headings to four decimals, so a constant heading written as 3.1416 and a
 * reversed tangent of exactly pi are 7e-6 rad apart: one pose, which this tolerance treats as one.
 */
const SAME_POSE_RAD = 1e-3;

const samePose = (a: Pose, b: Pose): boolean =>
  Math.hypot(a.xIn - b.xIn, a.yIn - b.yIn) <= SAME_POSE_IN &&
  Math.abs(angleDelta(a.headingRad, b.headingRad)) <= SAME_POSE_RAD;

/** The pose the robot is in as a step begins, and whether a step before it has checked it. */
interface Entry {
  pose: Pose;
  covered: boolean;
}

/**
 * The samples each step's footprint checks sweep, for every step of the plan tree, parallel and
 * branch members included. A step that is not in the map (none, from a plan) sweeps all of its own.
 * `startChecked` says a check of its own has already reported the start pose, as START_ILLEGAL's
 * wrong-half error does for OPPONENT_SIDE (`startReportedOver`), so no step reports it again.
 */
export function sweptSamples(
  steps: readonly PlanStep[],
  startPose: Pose,
  startChecked = false,
): Map<PlanStep, readonly PlanSample[]> {
  const out = new Map<PlanStep, readonly PlanSample[]>();
  walk(steps, { pose: startPose, covered: startChecked }, out);
  return out;
}

/** Steps that run one after another, from `entry`; returns where the last one leaves the robot. */
function walk(steps: readonly PlanStep[], entry: Entry | null, out: Map<PlanStep, readonly PlanSample[]>): Entry | null {
  let current = entry;
  for (const step of steps) current = visit(step, current, out);
  return current;
}

/**
 * Takes the entry pose's sample when it is the step's first one. It is dropped when a step before
 * already checked it; otherwise it is kept, and the entry becomes checked for any step sharing it.
 */
function withoutEntry(samples: readonly PlanSample[], entry: Entry | null): readonly PlanSample[] {
  const first = samples[0];
  if (first === undefined || first.sIn !== 0 || entry === null || !samePose(first.pose, entry.pose)) return samples;
  if (entry.covered) return samples.slice(1);
  entry.covered = true;
  return samples;
}

function visit(step: PlanStep, entry: Entry | null, out: Map<PlanStep, readonly PlanSample[]>): Entry | null {
  const children = step.children;
  if (children !== undefined) {
    out.set(step, step.samples);
    if (step.kind === "sequence") return walk(children, entry, out);
    // A parallel group's members each start at the group's entry; a branch's two arms each run
    // in order from it. The entry object is shared, so the first to check it covers it.
    const lists: PlanStep[][] =
      step.step.kind === "branch"
        ? [children.slice(0, step.step.then.length), children.slice(step.step.then.length)]
        : children.map((child) => [child]);
    const exits = lists.map((list) => walk(list, entry, out));
    const end = step.endPose;
    if (end === null) return null;
    return { pose: end, covered: exits.some((exit) => exit !== null && exit.covered && samePose(exit.pose, end)) };
  }

  out.set(step, withoutEntry(step.samples, entry));
  const end = step.endPose;
  if (end === null) return null;
  // Every sample of the step has been checked, by it or by a step before it, so its last pose has
  // been; the next step's entry is checked when it is that pose.
  const last = step.samples[step.samples.length - 1];
  return { pose: end, covered: last !== undefined && samePose(last.pose, end) };
}
