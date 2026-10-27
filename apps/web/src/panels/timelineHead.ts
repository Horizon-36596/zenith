/**
 * The timeline head's one total (issue #411): which number it shows, what its tooltip calls it and
 * says about it, and whether the quiet "~" rough chip goes before it. The chip is about the
 * estimate's bound, so it shows only while the head shows a number on the estimate's clock: the
 * Ideal level's, or the estimate itself while the chosen level has no total yet. Every hint here is
 * a tooltip's second line, so it stays within `TOOLTIP_HINT_CAP` (`timelineHead.test.ts`).
 */
import { traceDurationS, traceRoutineEndS, type Trace } from "@horizon36596/zenith-core";
import { seconds as fmtSeconds } from "../lib/format";
import { LEVEL_LABEL, type PlaybackLevel } from "../state/playback";

/** Why a rough total is rough, in one sentence, for the "~" chip's tooltip. */
export const BOUND_HINT: Readonly<Record<"lower" | "upper", string>> = {
  lower: "Rough: a step with no predictable time counts as zero, so the run may take longer.",
  upper: "Rough: a path that ends on a condition is timed as if it drove all the way, so the run may end sooner.",
};

/** What each level's total is, for the head total's tooltip. */
export const LEVEL_TOTAL_HINT: Readonly<Record<PlaybackLevel, string>> = {
  ideal: "How long the routine takes driving the planned path exactly, on the estimate's clock, plus any drive across a gap between steps.",
  instant:
    "How long the instant sim took to run the routine, following each path the way Pedro does. It runs again after every edit.",
  full: "How long the routine ran in the robot repository's own sim, to the end of its last step in the loaded trace.",
};

/** The head total's tooltip while the chosen level has no total yet and the estimate stands in. */
export const ESTIMATE_TOTAL_HINT = "The estimate's total, from each step's planned time. The chosen level has no total yet.";

export interface HeadTotal {
  /** The seconds the head shows, or null for a dash. */
  seconds: number | null;
  /** The total's tooltip label. */
  label: string;
  /** The total's tooltip hint. */
  hint: string;
  /** Whether the "~" rough chip goes before the total. */
  rough: boolean;
}

/**
 * The Full sim level's two lengths for a loaded trace. `totalS` is the head's total: when the routine
 * ended, at its last step's end (`traceRoutineEndS`), since the sim records the whole period and a
 * margin after it while the robot stands still. `runS` is how far the scrubber and playback run: to
 * that same end once the run is complete, but to the last time received while the run is still
 * streaming in, so the playhead keeps waiting there for more rather than stopping at a step's end.
 */
export function fullSimLengths(trace: Trace | null, streaming: boolean): { totalS: number | null; runS: number | null } {
  if (trace === null) return { totalS: null, runS: null };
  const totalS = traceRoutineEndS(trace);
  return { totalS, runS: streaming ? traceDurationS(trace) : totalS };
}

/**
 * The head total for `level`: its own total, `levelS`, or the estimate's, `estimateS`, while the
 * level has none. `bound` is the estimate's (`totalBound`), null when the estimate is firm.
 */
export function headTotal({
  level,
  levelS,
  estimateS,
  bound,
}: {
  level: PlaybackLevel;
  levelS: number | null;
  estimateS: number | null;
  bound: "lower" | "upper" | null;
}): HeadTotal {
  if (levelS === null) {
    return { seconds: estimateS, label: "Estimate total", hint: ESTIMATE_TOTAL_HINT, rough: bound !== null && estimateS !== null };
  }
  const estimateLine = estimateS !== null && Math.abs(estimateS - levelS) >= 0.005 ? ` The estimate alone is ${fmtSeconds(estimateS)} s.` : "";
  return {
    seconds: levelS,
    label: `${LEVEL_LABEL[level]} total`,
    hint: `${LEVEL_TOTAL_HINT[level]}${estimateLine}`,
    rough: bound !== null && level === "ideal",
  };
}
