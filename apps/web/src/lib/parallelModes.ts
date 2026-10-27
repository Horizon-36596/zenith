/**
 * The three ways a parallel group can end, named once (issue #246, decision parallel-naming). The
 * Insert menu and the Inspector both read these labels, so a group is never "Race" in one place and
 * "Stop when any step ends" in the other. "Any" and "a chosen" keep the two stopping modes apart (issue #505). The file and the robot runtime call the modes `all`,
 * `race` and `deadline` (`Parallel.all`, `Parallel.race`, `Parallel.deadline`); those names are in
 * the hint, in `help/descriptions/insert.ts`, for someone who reads the code.
 */
import type { ParallelStep } from "@horizon36596/zenith-schema";

export type ParallelMode = ParallelStep["mode"];

export const PARALLEL_MODES: ReadonlyArray<{ value: ParallelMode; label: string }> = [
  { value: "all", label: "Wait for all of them" },
  { value: "race", label: "Stop when any step ends" },
  { value: "deadline", label: "Stop when a chosen step ends" },
];
