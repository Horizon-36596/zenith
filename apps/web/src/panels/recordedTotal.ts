/**
 * The recorded total at the end of the timeline's actual track (W4-4 of the 0.1.2 sweep). Adding up
 * every step's duration counted a parallel or sequence group and each step inside it again, so a run
 * DSIM timed at 9.22 s read "13.22 s actual". The total is when the routine ended instead: the latest
 * end of any step the trace records (`traceRoutineEndS`), the same end the Full level's total uses,
 * so the two never disagree. A sim records the whole period after the routine, so neither its clock
 * nor its last pose sample is the routine's length; they stand in only for a trace with no steps.
 * The tooltip says which it is.
 *
 * The timeline's track and the Simulate dialog's report say the total the same way, with one name
 * for the level, Full sim, and the plan it is against (0.1.2 UX review): "Full sim 6.20 s, +0.25 s
 * on the 5.95 s plan".
 */
import { traceRoutineEndS, type Trace } from "@horizon36596/zenith-core";
import { seconds } from "../lib/format";

export interface RecordedTotal {
  seconds: number;
  /** The total's tooltip hint: where the number comes from. */
  hint: string;
}

export const RECORDED_ROUTINE_HINT = "How long the recorded routine ran, to the end of its last step; a group counts once.";
export const RECORDED_CLOCK_HINT = "How long the recorded run took, by the trace's own clock. It records no steps.";
export const RECORDED_SAMPLE_HINT = "How long the recorded run took, to the trace's last pose sample. It records no steps.";

/** The recorded total of `trace`. */
export function recordedTotal(trace: Trace): RecordedTotal {
  if (trace.steps.length > 0) return { seconds: traceRoutineEndS(trace), hint: RECORDED_ROUTINE_HINT };
  if (Number.isFinite(trace.simTimeS) && trace.simTimeS > 0) return { seconds: trace.simTimeS, hint: RECORDED_CLOCK_HINT };
  return { seconds: traceRoutineEndS(trace), hint: RECORDED_SAMPLE_HINT };
}

/**
 * "+0.25 s" or "-0.10 s": a recorded time against the plan's. The sign follows the number as
 * printed, so a difference that rounds to zero reads "0.00 s", never "+0.00 s" or "-0.00 s".
 */
export function signedSeconds(deltaS: number): string {
  const shown = seconds(Math.abs(deltaS));
  if (Number(shown) === 0) return `${shown} s`;
  return `${deltaS > 0 ? "+" : "-"}${shown} s`;
}

/** "+0.25 s on the 5.95 s plan", or null when there is no plan to compare with. */
export function againstPlan(recordedS: number, planS: number | null): string | null {
  return planS === null ? null : `${signedSeconds(recordedS - planS)} on the ${seconds(planS)} s plan`;
}

/** "Full sim 6.20 s, +0.25 s on the 5.95 s plan": the recorded total in one sentence. */
export function fullSimSentence(recordedS: number, planS: number | null): string {
  const against = againstPlan(recordedS, planS);
  return `Full sim ${seconds(recordedS)} s${against === null ? "" : `, ${against}`}`;
}
