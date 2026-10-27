/**
 * Descriptions of the Insert menu's items (issues #238 and #246). An item takes an entry with
 * `describe="insert.…"`. In Labels only the menu shows each kind's label and nothing else; With
 * descriptions adds the brief under it, and a long hover or Shift F1 opens the brief and the more.
 *
 * The three parallel modes use the Inspector's plain wording (`lib/parallelModes.ts`, decision
 * parallel-naming), with the names the file and the robot runtime use in the hint.
 */
import type { Description } from "./types";

export const INSERT_DESCRIPTIONS = {
  "insert.path": {
    label: "Path",
    brief: "Drive to a new point",
    more: "Starts where the selected step ends.",
  },
  "insert.turn": {
    label: "Turn",
    brief: "Face a new way without driving",
    more: "Has a timeout so it cannot stall. Drag its arrow on the field to aim it.",
  },
  "insert.command": {
    label: "Command",
    brief: "An action from your robot code",
    more: "Such as the intake or the launcher, from robot.json.",
  },
  "insert.wait": {
    label: "Wait",
    brief: "Pause for a time or a sensor",
    more: "Waits some seconds, or until a condition from robot.json is true.",
  },
  "insert.transfer": {
    label: "Transfer",
    brief: "Pieces that move without your robot",
    more: "Such as a partner scoring. Planner only: the robot does nothing.",
  },
  "insert.sequence": {
    label: "Sequence",
    brief: "Steps in order, as one block",
    more: "Useful inside a parallel group, where one lane needs several steps.",
  },
  "insert.parallel": {
    label: "Parallel",
    brief: "Steps at the same time",
    more: "Such as driving while the intake spins.",
  },
  "insert.branch": {
    label: "Branch",
    brief: "If or else on a condition",
    more: "Runs one set of steps if a condition is true, another if not.",
  },
  "insert.parallelAll": {
    label: "Wait for all of them",
    brief: "Ends when every step has finished",
    more: "The file and the code call this all.",
  },
  "insert.parallelRace": {
    label: "Stop when any step ends",
    brief: "Ends as soon as any of its steps finishes",
    more: "The file and the code call this race.",
  },
  "insert.parallelDeadline": {
    label: "Stop when a chosen step ends",
    brief: "Ends when the step you choose finishes",
    more: "The others are stopped then. The file and the code call this deadline.",
  },
} as const satisfies Record<`insert.${string}`, Description>;
