/**
 * The steps running at the playhead (issue #111), for the step list's highlight, and when a step
 * starts, for its "Play from here" (issue #141). Read from the same
 * timing the playback level already plays: the ideal trajectory's spans at Ideal, the instant sim's
 * step records at Instant sim, and the loaded trace's steps at Full sim. There is no timing model
 * of its own.
 *
 * A step is running from its start up to, not including, its end, so two steps one after the other
 * never both count at the moment one hands over to the next. Every group a running step sits in
 * counts as running too, whether or not the source records the group itself, and each member of a
 * parallel group is its own span, so every branch still running shows.
 *
 * Pure: the caller hands in the playhead and the sources.
 */
import type { IdealTrajectory, Trace } from "@horizon36596/zenith-core";
import type { PlaybackLevel } from "../state/prefs";

/** When a step started and ended on a level's clock. */
export interface StepTiming {
  readonly startS: number;
  readonly endS: number;
}

export interface ActiveStepSources {
  level: PlaybackLevel;
  /** The ideal trajectory, for Ideal. */
  ideal: IdealTrajectory | null;
  /** The instant sim's trace, for Instant sim. */
  instant: Trace | null;
  /** The loaded full sim trace, for Full sim. */
  full: Trace | null;
  /** Each step's parent group, by id, as the step list nests them; a top-level step has none. */
  parentOf: ReadonlyMap<string, string | undefined>;
}

const NONE: ReadonlySet<string> = new Set();

/** Each step's timing on the level's own clock, by id; the Ledger follows the playhead on it too. */
export function timings(sources: ActiveStepSources): Iterable<StepTiming & { readonly id: string }> {
  switch (sources.level) {
    case "ideal":
      return (sources.ideal?.spans ?? []).map((span) => ({ id: span.stepId, startS: span.startS, endS: span.endS }));
    case "instant":
      return sources.instant?.steps ?? [];
    case "full":
      return sources.full?.steps ?? [];
  }
}

/**
 * The ids of the steps running at `atS` seconds on the level's clock, with every group they sit in.
 * Empty when the playhead has not been placed (`atS` null) or nothing runs then.
 */
export function activeStepIds(atS: number | null, sources: ActiveStepSources): ReadonlySet<string> {
  if (atS === null || !Number.isFinite(atS)) return NONE;
  const active = new Set<string>();
  for (const step of timings(sources)) {
    if (step.startS <= atS && atS < step.endS) {
      for (let id: string | undefined = step.id; id !== undefined && !active.has(id); id = sources.parentOf.get(id)) {
        active.add(id);
      }
    }
  }
  return active.size === 0 ? NONE : active;
}

/**
 * When a step starts on the level's clock, for "Play from here" (issue #141): the earliest start of
 * the step or of any step inside it, so a group the source does not record itself starts with its
 * first member. Null when the level has no timing for it, as for a branch arm the run never took.
 */
export function stepStartS(stepId: string, sources: ActiveStepSources): number | null {
  let earliest: number | null = null;
  for (const step of timings(sources)) {
    if (!Number.isFinite(step.startS) || (earliest !== null && step.startS >= earliest)) continue;
    for (let id: string | undefined = step.id; id !== undefined; id = sources.parentOf.get(id)) {
      if (id === stepId) {
        earliest = step.startS;
        break;
      }
    }
  }
  return earliest;
}

/**
 * One string for a set of running steps, the same for the same set in any order, so a component can
 * draw again only when the set changes and not on every frame of playback.
 */
export const activeKey = (ids: ReadonlySet<string>): string => [...ids].sort().join("\n");

/** The set `activeKey` wrote. */
export const fromActiveKey = (key: string): ReadonlySet<string> => (key === "" ? NONE : new Set(key.split("\n")));
