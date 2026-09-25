/**
 * The instant preview sim, run for the editor (site/docs/simulation.md). After every edit the
 * routine is simulated again, off the render: `resimulate` picks up from the first top-level step
 * the edit changed, so an edit near the end of a routine costs only that end. The timeline reads
 * the result as its preview bars.
 *
 * A trace always belongs to one plan. Until the run for the current plan has finished, the hook
 * returns the last one with `stale` set, so bars do not flicker on every drag frame.
 */
import { resimulate, simulateRun, type Plan, type SimRun, type SimTrace } from "@horizon36596/zenith-core";
import type { Field, Robot } from "@horizon36596/zenith-schema";
import { useEffect, useSyncExternalStore } from "react";

export interface SimView {
  trace: SimTrace | null;
  /** True while the trace is from before the latest edit. */
  stale: boolean;
  /** Why there is no trace, when the sim refused the routine. */
  reason: string | null;
}

interface Entry {
  plan: Plan;
  robot: Robot;
  field: Field;
  run: SimRun | null;
  reason: string | null;
}

let last: Entry | null = null;
let pending: number | null = null;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

let version = 0;
const getVersion = (): number => version;

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/** Runs the sim for this plan now, reusing the previous run's checkpoints when it can. */
export function runSim(plan: Plan, robot: Robot, field: Field): Entry {
  let run: SimRun | null = null;
  let reason: string | null = null;
  try {
    const previous = last?.run ?? null;
    run =
      previous !== null && last?.robot === robot && last.field === field
        ? resimulate(previous, plan, robot, field)
        : simulateRun(plan, robot, field);
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  last = { plan, robot, field, run, reason };
  return last;
}

/** The preview sim for the given plan: run on the next tick after the plan changes. */
export function useSim(plan: Plan | null, robot: Robot | null, field: Field | null): SimView {
  useSyncExternalStore(subscribe, getVersion, getVersion);

  useEffect(() => {
    if (plan === null || robot === null || field === null) return;
    if (last?.plan === plan && last.robot === robot && last.field === field) return;
    if (pending !== null) window.clearTimeout(pending);
    pending = window.setTimeout(() => {
      pending = null;
      runSim(plan, robot, field);
      notify();
    }, 0);
    return () => {
      if (pending !== null) window.clearTimeout(pending);
      pending = null;
    };
  }, [plan, robot, field]);

  if (plan === null || last === null) return { trace: null, stale: false, reason: null };
  return {
    trace: last.run?.trace ?? null,
    stale: last.plan !== plan,
    reason: last.reason,
  };
}

/** Per top-level step, when the sim started and ended it, and when its hold settled. */
export interface SimSpan {
  startS: number;
  endS: number;
  settledS: number | null;
  unknown: boolean;
  unknownReason: string | null;
}

export function simSpans(trace: SimTrace | null): Map<string, SimSpan> {
  const spans = new Map<string, SimSpan>();
  if (trace === null) return spans;
  for (const step of trace.steps) {
    if (step.parentId !== null) continue;
    spans.set(step.id, {
      startS: step.startS,
      endS: step.endS,
      settledS: step.settledS ?? null,
      unknown: step.unknown,
      unknownReason: step.unknownReason ?? null,
    });
  }
  return spans;
}

/** When the sim's routine ended: the last top-level step's end. */
export function simTotalS(trace: SimTrace | null): number | null {
  if (trace === null) return null;
  let end = 0;
  for (const step of trace.steps) if (step.parentId === null) end = Math.max(end, step.endS);
  return end;
}
