import type { CommandCall, MarkerAt, Mouth, Robot } from "@horizon36596/zenith-schema";
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

/** Where along a path step each mouth starts running: 0 when it already was, or a marker's t. */
export type RunningFrom = ReadonlyMap<string, number>;

export interface IntakeTimeline {
  /** For each path step id, the mouths running on it and where they started. */
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
 * Walks the auto once and works out, for every path step, which mouths are running over it: those
 * a previous command turned on and never stopped, those a marker turns on part way through, and,
 * inside a parallel group, those any other member of the group turns on, because that member runs
 * alongside the drive (a deadline drive with an intake sequence beside it is the common case).
 */
export function intakeTimeline(steps: readonly PlanStep[], robot: Robot): IntakeTimeline {
  const running = new Set<string>();
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

  const walk = (list: readonly PlanStep[], alongside: ReadonlySet<string> = new Set()): void => {
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
        const from = new Map<string, number>();
        for (const id of running) from.set(id, 0);
        for (const id of alongside) from.set(id, 0);
        for (const marker of step.markers ?? []) {
          const call = intakeCall(robot, marker.command);
          if (call === null) continue;
          const t = markerT(marker.at, planned.lengthIn);
          for (const id of call.mouthIds) {
            if (call.running) {
              from.set(id, Math.min(from.get(id) ?? 1, t));
              running.add(id);
            } else {
              from.delete(id);
              running.delete(id);
            }
          }
        }
        byStepId.set(planned.id, from);
        continue;
      }
      if (planned.children === undefined) continue;
      if (step.kind === "parallel") {
        walk(planned.children, turnedOn(planned.children, new Set(alongside)));
      } else {
        walk(planned.children, alongside);
      }
    }
  };

  walk(steps);
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
