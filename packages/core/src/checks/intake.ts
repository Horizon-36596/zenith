import { childLists, type CommandCall, type MarkerAt, type Mouth, type Robot } from "@horizon36596/zenith-schema";
import type { PlanStep } from "../types.js";

/**
 * Which mouths are running while a path step is driven.
 *
 * Nothing here knows the name `setIntake`: a command counts as an intake command when its registry
 * entry in `robot.json` requires the intake and takes a `state` parameter, which is the contract
 * site/docs/file-format.md sets out. That way a robot that calls the command something else, or
 * has three mouths, still gets the MOUTH_LEADING and SWEEP_SPEED checks.
 */

const RUNNING_STATES = new Set(["FORWARD", "REVERSE", "ON", "IN", "OUT"]);
const STOPPED_STATES = new Set(["STOP", "OFF", "IDLE"]);

interface IntakeCall {
  /** The mouths the call addresses, by id. */
  mouthIds: string[];
  running: boolean;
}

/** Reads a command call as an intake instruction, or returns null when it is not one. */
export function intakeCall(robot: Robot, call: CommandCall): IntakeCall | null {
  const spec = robot.commands.find((command) => command.name === call.name);
  if (spec === undefined) return null;
  if (!(spec.requires ?? []).includes("intake")) return null;
  const state = call.args?.["state"] ?? spec.params?.["state"]?.default;
  if (typeof state !== "string") return null;
  const running = RUNNING_STATES.has(state)
    ? true
    : STOPPED_STATES.has(state)
      ? false
      : null;
  if (running === null) return null;

  const side = call.args?.["side"] ?? spec.params?.["side"]?.default;
  const mouths = robot.mouths ?? [];
  const mouthIds =
    typeof side === "string" && side !== "BOTH" && side !== "ALL"
      ? mouths.filter((mouth) => mouth.side === side).map((mouth) => mouth.id)
      : mouths.map((mouth) => mouth.id);
  return { mouthIds, running };
}

/**
 * One stretch of a path step over which a mouth runs, as path fractions: from `fromT` up to, not
 * including, `toT`. A mouth still running when the step ends has `toT` of infinity.
 */
export interface RunningSpan {
  fromT: number;
  toT: number;
}

/**
 * Where along a path step each mouth runs: one span from 0 when it already was, a span from a
 * marker's t when a marker starts it, and a span that ends at a marker's t when a marker stops it.
 * A mouth that never runs on the step is not in the map.
 */
export type RunningFrom = ReadonlyMap<string, readonly RunningSpan[]>;

/** True when one of `spans` covers `t`. */
export const runningAt = (spans: readonly RunningSpan[] | undefined, t: number): boolean =>
  (spans ?? []).some((span) => t >= span.fromT && t < span.toT);

export interface IntakeTimeline {
  /** For each path step id, the mouths running on it and where. */
  byStepId: ReadonlyMap<string, RunningFrom>;
}

/** Where a marker sits as a fraction of the step, whichever of the three ways it was written. */
export const markerT = (at: MarkerAt, lengthIn: number): number => {
  if ("t" in at) return at.t;
  if (lengthIn <= 0) return 0;
  if ("distanceIn" in at) return Math.min(at.distanceIn / lengthIn, 1);
  return Math.max(1 - at.distanceFromEndIn / lengthIn, 0);
};

/**
 * Walks the auto once and works out, for every path step, which mouths are running over it and
 * where: those a previous command turned on and never stopped, those a marker turns on or off part
 * way through, and, inside a parallel group, those any other member of the group turns on, because
 * that member runs alongside the drive (a deadline drive with an intake sequence beside it is the
 * common case). Each arm of a branch starts from the state the branch was entered with, and the
 * steps after the branch see a mouth running when either arm leaves it running.
 */
export function intakeTimeline(steps: readonly PlanStep[], robot: Robot): IntakeTimeline {
  const byStepId = new Map<string, RunningFrom>();

  const turnedOn = (list: readonly PlanStep[], into: Set<string>): Set<string> => {
    for (const planned of list) {
      const step = planned.step;
      if (step.kind === "command") {
        const call = intakeCall(robot, { name: step.name, ...(step.args === undefined ? {} : { args: step.args }) });
        if (call?.running === true) for (const id of call.mouthIds) into.add(id);
      }
      if (planned.children !== undefined) turnedOn(planned.children, into);
    }
    return into;
  };

  /** Walks `list` in order, turning mouths on and off in `running`. */
  const walk = (list: readonly PlanStep[], running: Set<string>, alongside: ReadonlySet<string>): void => {
    for (const planned of list) {
      const step = planned.step;
      if (step.kind === "command") {
        const call = intakeCall(robot, { name: step.name, ...(step.args === undefined ? {} : { args: step.args }) });
        if (call !== null) {
          for (const id of call.mouthIds) {
            if (call.running) running.add(id);
            else running.delete(id);
          }
        }
        continue;
      }
      if (step.kind === "path") {
        // The markers in path order; markers at the same t keep the order the file gives them.
        const events = (step.markers ?? [])
          .map((marker, index) => ({ t: markerT(marker.at, planned.lengthIn), index, call: intakeCall(robot, marker.command) }))
          .filter((event): event is { t: number; index: number; call: IntakeCall } => event.call !== null)
          .sort((a, b) => a.t - b.t || a.index - b.index);
        const opened = new Map<string, number>();
        for (const id of running) opened.set(id, 0);
        for (const id of alongside) opened.set(id, 0);
        const spans = new Map<string, RunningSpan[]>();
        const close = (id: string, toT: number): void => {
          const fromT = opened.get(id);
          if (fromT === undefined) return;
          opened.delete(id);
          if (toT > fromT) spans.set(id, [...(spans.get(id) ?? []), { fromT, toT }]);
        };
        for (const { t, call } of events) {
          for (const id of call.mouthIds) {
            if (call.running) {
              if (!opened.has(id)) opened.set(id, t);
              running.add(id);
            } else {
              close(id, t);
              running.delete(id);
            }
          }
        }
        for (const id of [...opened.keys()]) close(id, Number.POSITIVE_INFINITY);
        byStepId.set(planned.id, spans);
        continue;
      }
      if (planned.children === undefined) continue;
      if (step.kind === "parallel") {
        walk(planned.children, running, turnedOn(planned.children, new Set(alongside)));
      } else if (step.kind === "branch") {
        // Only one arm runs, so each starts from the state on entry; afterwards a mouth may be
        // running when either arm (or, with no else, skipping the branch) leaves it running.
        const entry = new Set(running);
        const arms = childLists(step).map((arm) => arm.length);
        if (arms.length < 2) arms.push(0);
        running.clear();
        let offset = 0;
        for (const length of arms) {
          const state = new Set(entry);
          walk(planned.children.slice(offset, offset + length), state, alongside);
          for (const id of state) running.add(id);
          offset += length;
        }
      } else {
        walk(planned.children, running, alongside);
      }
    }
  };

  walk(steps, new Set(), new Set());
  return { byStepId };
}

/** Which way a mouth points in the field frame when the robot is at this heading. */
export function mouthHeadingRad(mouth: Mouth, robotHeadingRad: number): number {
  const offsets: Record<Mouth["side"], number> = {
    FRONT: 0,
    BACK: Math.PI,
    LEFT: Math.PI / 2,
    RIGHT: -Math.PI / 2,
  };
  return robotHeadingRad + offsets[mouth.side];
}
