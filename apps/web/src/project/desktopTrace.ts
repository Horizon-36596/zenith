/**
 * Cleans a high-fidelity sim trace before the desktop app draws it over the plan.
 *
 * A trace's poses are the robot's belief of where it is, one row per tick. When the localizer is
 * re-seeded or overwritten, the belief jumps further in one tick than any drivetrain can move, and a
 * polyline drawn through the rows joins the two places with a straight line the robot never drove.
 * The BIOBUZZ headless harness does this on its first tick today: row 0 is
 * the start pose the auto set, and row 1 is back at the origin, so the overlay drew a line from the
 * start pose to the field centre.
 *
 * Only a jump before the robot has moved is repaired, by dropping the rows before it: those rows are
 * the pose that did not stick, and nothing after them depends on them. A jump later in the run is
 * kept and counted, because dropping half a run would hide the problem rather than show it.
 */
import type { Trace, TracePoseRow } from "@horizon36596/zenith-core";

/** Faster than any FTC drivetrain: roughly twice a fast robot's top speed. */
const MAX_PLAUSIBLE_SPEED_IN_PER_S = 150;
/** A jump this short is never called a reset, whatever the tick, so a slow tick is not mistaken. */
const MIN_RESET_JUMP_IN = 6;
/** How far the rows before a reset may wander and still count as "had not moved yet". */
const SETTLED_IN = 2;

export interface SettledTrace {
  trace: Trace;
  /** Rows dropped from the start because the pose they held was overwritten on the next tick. */
  droppedLeading: number;
  /** Indices, into the returned poses, of rows that jump from the row before them mid-run. */
  resets: number[];
}

const distanceIn = (a: TracePoseRow, b: TracePoseRow): number => Math.hypot(b[1] - a[1], b[2] - a[2]);

/** True when row `b` is further from row `a` than a robot can travel in the time between them. */
export function isPoseReset(a: TracePoseRow, b: TracePoseRow, tickS: number): boolean {
  const dt = Math.max(b[0] - a[0], tickS, 0);
  return distanceIn(a, b) > Math.max(MIN_RESET_JUMP_IN, MAX_PLAUSIBLE_SPEED_IN_PER_S * dt);
}

export function settleTrace(trace: Trace): SettledTrace {
  const rows = trace.poses;
  const first = rows[0];
  let poses = rows;
  let droppedLeading = 0;
  if (first !== undefined) {
    for (let i = 1; i < rows.length; i += 1) {
      const before = rows[i - 1] as TracePoseRow;
      const row = rows[i] as TracePoseRow;
      if (distanceIn(first, before) > SETTLED_IN) break;
      if (isPoseReset(before, row, trace.tickS)) {
        droppedLeading = i;
        poses = rows.slice(i);
        break;
      }
    }
  }
  const resets: number[] = [];
  for (let i = 1; i < poses.length; i += 1) {
    if (isPoseReset(poses[i - 1] as TracePoseRow, poses[i] as TracePoseRow, trace.tickS)) resets.push(i);
  }
  return { trace: droppedLeading === 0 ? trace : { ...trace, poses }, droppedLeading, resets };
}
