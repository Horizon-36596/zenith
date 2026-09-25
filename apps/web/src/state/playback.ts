/**
 * The three playback levels (site/docs/simulation.md, "Playback levels"): which source the robot on
 * the field, the playhead and the timeline read.
 *
 * - **Ideal** (the default): the planned path exactly, on the estimate's clock (`core.idealTrajectory`).
 * - **Instant sim**: the TypeScript follower and plant (`core.simulate`), a rough real-world estimate.
 * - **Full sim**: the robot repository's own Gradle sim, from a trace it wrote. It needs that trace,
 *   which comes from the desktop app's high-fidelity sim or from loading a trace file.
 */
import { idealTrajectory, type Estimate, type IdealTrajectory, type Plan } from "@horizon36596/zenith-core";
import { isDesktop } from "../project/desktop";
import type { PlaybackLevel } from "./prefs";

export type { PlaybackLevel };

export const PLAYBACK_LEVELS: readonly PlaybackLevel[] = ["ideal", "instant", "full"];

/** The name of each level, as the control, the robot's label and the readouts write it. */
export const LEVEL_LABEL: Readonly<Record<PlaybackLevel, string>> = {
  ideal: "Ideal",
  instant: "Instant sim",
  full: "Full sim",
};

/** The same names in running text: "ideal 12.40 s", "instant sim 12.67 s". */
export const LEVEL_WORD: Readonly<Record<PlaybackLevel, string>> = {
  ideal: "ideal",
  instant: "instant sim",
  full: "full sim",
};

/** The shortest name, for the playhead readout beside the scrubber: "5.23 s instant". */
export const LEVEL_SHORT: Readonly<Record<PlaybackLevel, string>> = {
  ideal: "ideal",
  instant: "instant",
  full: "full sim",
};

/** What each level is for, for the control's tooltips. */
export const LEVEL_HINT: Readonly<Record<PlaybackLevel, string>> = {
  ideal:
    "The planned path exactly, with no wobble or overshoot, timed by the estimate. Where one path does not start where the last one ended, the robot turns or drives across the gap.",
  instant:
    "Zenith's own follower and drivetrain model, run after every edit: a rough estimate of how the robot really drives the path.",
  full: "The robot repository's own Gradle simulation, from the trace it wrote: the closest match to the robot.",
};

export interface LevelInputs {
  /** Whether the instant sim has a run for the routine, and why not when it has none. */
  instantReady: boolean;
  instantReason: string | null;
  /** Whether a full sim trace is loaded. */
  fullReady: boolean;
}

/** The inputs from what the editor has: the instant sim's view and the loaded trace. */
export const levelInputs = (
  sim: { trace: unknown; reason: string | null },
  trace: unknown,
): LevelInputs => ({
  instantReady: sim.trace !== null,
  instantReason: sim.reason,
  fullReady: trace !== null,
});

/** Why a level cannot be chosen now, or null when it can. */
export function levelUnavailable(level: PlaybackLevel, inputs: LevelInputs): string | null {
  if (level === "instant" && !inputs.instantReady) {
    return inputs.instantReason === null
      ? "The instant sim has not run yet."
      : `The instant sim could not run this routine: ${inputs.instantReason}`;
  }
  if (level === "full" && !inputs.fullReady) {
    return isDesktop()
      ? "No full sim run yet. Run the high-fidelity sim from Simulate (F5), or load a trace it wrote."
      : "Full sim runs the robot repository's Gradle sim, which only the desktop app can start. Run the sim command in that repository, then load the trace it writes from Simulate (F5).";
  }
  return null;
}

/** The level that actually plays: the chosen one, or Ideal while the chosen one is unavailable. */
export function effectiveLevel(chosen: PlaybackLevel, inputs: LevelInputs): PlaybackLevel {
  return levelUnavailable(chosen, inputs) === null ? chosen : "ideal";
}

const idealCache = new WeakMap<Estimate, { plan: Plan; trajectory: IdealTrajectory | null }>();

/**
 * The ideal trajectory of a plan on its estimate's clock, memoised on the estimate (a new document
 * is a new estimate). Null without an estimate, or if the trajectory cannot be laid out.
 */
export function idealFor(plan: Plan | null, estimate: Estimate | null): IdealTrajectory | null {
  if (plan === null || estimate === null) return null;
  const hit = idealCache.get(estimate);
  if (hit !== undefined && hit.plan === plan) return hit.trajectory;
  let trajectory: IdealTrajectory | null = null;
  try {
    trajectory = idealTrajectory(plan, estimate);
  } catch {
    trajectory = null;
  }
  idealCache.set(estimate, { plan, trajectory });
  return trajectory;
}
