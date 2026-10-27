/**
 * When the playback robot is a guess (issue #481): while a command that drives the robot by itself
 * (`movesRobot` in robot.json) runs, nobody can predict where the robot is. The ideal playback and
 * the instant sim move it towards the next path's rejoin pose (core `drift.ts`), and the canvas
 * draws it as a ghost in the unknown-position colour, labelled as a guess, with its step's envelope
 * hatched in that colour while the envelope's window is open.
 *
 * The spans come from the playback level's own clock: the ideal trajectory's spans at the Ideal
 * level, the instant sim's step records at Instant, the recorded trace's at Full. Pure: no canvas.
 */
import {
  envelopeWindowS,
  flattenSteps,
  movesRobotCommand,
  type IdealTrajectory,
  type Plan,
  type TraceStep,
} from "@horizon36596/zenith-core";
import type { Robot } from "@horizon36596/zenith-schema";

/** One stretch of the routine where the robot's position is a guess. */
export interface UnknownSpan {
  stepId: string;
  startS: number;
  endS: number;
  /**
   * When the step's envelope window closes on this clock: its start plus the seconds the planner
   * times the envelope by (`actualDurationS`, else `maxDurationS`). Null when it has no envelope.
   */
  windowEndS: number | null;
}

/** The ids of the steps whose position nobody can predict, with each one's envelope window in seconds. */
export function unknownSteps(plan: Plan, robot: Pick<Robot, "commands">): Map<string, number | null> {
  const steps = new Map<string, number | null>();
  for (const step of flattenSteps(plan.steps)) {
    if (movesRobotCommand(step, robot)) steps.set(step.id, envelopeWindowS(step.step));
  }
  return steps;
}

/**
 * The unknown spans on one clock: the ideal trajectory's spans, or a trace's step records. A step
 * that appears more than once in a trace (it cannot today) gives one span each time.
 */
export function unknownSpans(
  steps: ReadonlyMap<string, number | null>,
  clock: { ideal: IdealTrajectory } | { trace: { steps: readonly TraceStep[] } },
): UnknownSpan[] {
  if (steps.size === 0) return [];
  const timed = "ideal" in clock ? clock.ideal.spans.map((span) => ({ id: span.stepId, startS: span.startS, endS: span.endS })) : clock.trace.steps;
  const spans: UnknownSpan[] = [];
  for (const record of timed) {
    if (!steps.has(record.id)) continue;
    const windowS = steps.get(record.id) ?? null;
    spans.push({
      stepId: record.id,
      startS: record.startS,
      endS: record.endS,
      windowEndS: windowS === null ? null : record.startS + windowS,
    });
  }
  return spans;
}

/** The span the playback time is inside, from its start up to but not including its end, or null. */
export function unknownSpanAt(spans: readonly UnknownSpan[], atS: number): UnknownSpan | null {
  return spans.find((span) => span.endS > span.startS && atS >= span.startS && atS < span.endS) ?? null;
}

/** The step whose envelope is open at the playback time and hatched in the unknown colour, or null. */
export function openUnknownEnvelope(spans: readonly UnknownSpan[], atS: number): string | null {
  return (
    spans.find((span) => span.windowEndS !== null && span.windowEndS > span.startS && atS >= span.startS && atS < span.windowEndS)
      ?.stepId ?? null
  );
}

/** The label under the robot while its position is a guess: the level's name, then what it is. */
export const unknownLabel = (levelLabel: string): string => `${levelLabel} · position unknown`;
