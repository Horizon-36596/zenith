/**
 * The three playback levels (site/docs/simulation.md, "Playback levels"): which source the robot on
 * the field, the playhead and the timeline read.
 *
 * - **Ideal** (the default): the planned path exactly, on the estimate's clock (`core.idealTrajectory`).
 * - **Instant sim**: the TypeScript follower and plant (`core.simulate`), a rough real-world estimate.
 * - **Full sim**: the robot repository's high-fidelity sim, from a trace it wrote. It needs that trace,
 *   which comes from the desktop app's high-fidelity sim or from loading a trace file. Hidden only
 *   while the Full sim switch is off (issue #207, `state/features.ts`) and no host simulates.
 */
import {
  idealTimeAt,
  idealTrajectory,
  type Estimate,
  type Finding,
  type IdealTrajectory,
  type Plan,
} from "@horizon36596/zenith-core";
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

/** What each level is for, for the control's tooltips. */
export const LEVEL_HINT: Readonly<Record<PlaybackLevel, string>> = {
  ideal:
    "The planned path exactly, with no wobble or overshoot, timed by the estimate. Where one path does not start where the last one ended, the robot turns or drives across the gap.",
  instant:
    "Zenith's own follower and drivetrain model, run after every edit: a rough estimate of how the robot really drives the path.",
  full: "The robot repository's high-fidelity sim, from the trace it wrote: the closest match to the robot.",
};

export interface LevelInputs {
  /** Whether the instant sim has a run for the routine, and why not when it has none. */
  instantReady: boolean;
  instantReason: string | null;
  /** Whether a full sim trace is loaded. */
  fullReady: boolean;
  /**
   * In host mode, the host's name when it can simulate an auto and send the trace back
   * (site/docs/host-protocol.md), which is then where a full sim run comes from.
   */
  fullFromHost?: string | null;
  /**
   * Whether the Full sim level is offered at all: the Full sim switch is on (issue #207), or a host
   * simulates. Missing reads as offered.
   */
  fullShown?: boolean;
}

/**
 * The inputs from what the editor has: the instant sim's view, the loaded trace, the host, and the
 * Full sim switch (`prefs.features.fullSim`).
 */
export const levelInputs = (
  sim: { trace: unknown; reason: string | null },
  trace: unknown,
  host: { name: string; simulate: boolean } | null = null,
  fullSim = true,
): LevelInputs => {
  const fullFromHost = host !== null && host.simulate ? host.name : null;
  return {
    instantReady: sim.trace !== null,
    instantReason: sim.reason,
    fullReady: trace !== null,
    fullFromHost,
    fullShown: fullSim || fullFromHost !== null,
  };
};

/** The levels the playback control offers: all three, or Ideal and Instant sim while Full sim is switched off. */
export const shownLevels = (inputs: LevelInputs): readonly PlaybackLevel[] =>
  inputs.fullShown === false ? PLAYBACK_LEVELS.filter((level) => level !== "full") : PLAYBACK_LEVELS;

/** Why a level cannot be chosen now, or null when it can. */
export function levelUnavailable(level: PlaybackLevel, inputs: LevelInputs): string | null {
  if (level === "full" && inputs.fullShown === false) return "Full sim is switched off in this version.";
  if (level === "instant" && !inputs.instantReady) {
    return inputs.instantReason === null
      ? "The instant sim has not run yet."
      : `The instant sim could not run this routine: ${inputs.instantReason}`;
  }
  if (level === "full" && !inputs.fullReady) {
    const host = inputs.fullFromHost ?? null;
    if (host !== null) {
      return `No full sim run yet. Simulate in ${host} sends this auto to ${host}, and the drive it records is laid over the plan.`;
    }
    return isDesktop()
      ? "No full sim run yet. Run the high-fidelity sim from Simulate (F5), or load a trace it wrote."
      : "Full sim plays the robot repository's high-fidelity sim, which only the desktop app can start. Here, run the sim command in your robot repository, then load the trace it writes from Simulate (F5).";
  }
  return null;
}

/**
 * The level that actually plays: the chosen one, or Ideal while the chosen one is unavailable. A
 * remembered Full sim while Full sim is switched off (issue #207) plays the instant sim instead, or Ideal
 * when the instant sim has no run.
 */
export function effectiveLevel(chosen: PlaybackLevel, inputs: LevelInputs): PlaybackLevel {
  if (levelUnavailable(chosen, inputs) === null) return chosen;
  if (chosen === "full" && inputs.fullShown === false && levelUnavailable("instant", inputs) === null) return "instant";
  return "ideal";
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

/**
 * Where the playhead goes when a finding is clicked in the problems panel: the ideal clock's time
 * at the finding's `t` on its step, so the robot outline lands on the place the finding is about
 * (for a clip, exactly on its ghost). Null when the finding has no `t` or there is no clock, and
 * then the playhead stays where it is.
 */
export function findingTimeS(finding: Finding, trajectory: IdealTrajectory | null): number | null {
  if (finding.t === undefined || trajectory === null) return null;
  return idealTimeAt(trajectory, finding.stepId, finding.t);
}

/**
 * The length of the run the scrubber shows, on the level's own clock (and the alliance clock with a
 * partner loaded), as the timeline last drew it; null when there is no run. The timeline owns it and
 * keeps it current, so the `,` and `.` keys stop at the same end as the scrubber (issue #316).
 */
let runLengthS: number | null = null;

export const setRunLength = (lengthS: number | null): void => {
  runLengthS = lengthS;
};

export const getRunLength = (): number | null => runLengthS;

/**
 * The playhead kept between 0 and the run's end: nothing past the total the scrubber shows (issue
 * #316). With no run length the end is open, so a missing run never pins the playhead to 0.
 */
export function clampPlayhead(atS: number, lengthS: number | null): number {
  const end = lengthS === null ? Number.POSITIVE_INFINITY : Math.max(0, lengthS);
  return Math.min(Math.max(0, atS), end);
}

/** The playhead `deltaS` seconds from `atS`, kept inside the run: the `,` and `.` step. */
export const stepPlayhead = (atS: number, deltaS: number, lengthS: number | null): number =>
  clampPlayhead(atS + deltaS, lengthS);
