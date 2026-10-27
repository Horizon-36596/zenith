/**
 * The robot's commands as the editor offers them: a name to pick and, from `robot.json`, a
 * `summary` that says what the command does. Summaries run to a few sentences (`relocalize` explains
 * the vision fallback), so every picker shows them whole, wrapped or in a tooltip, never cut to a line.
 */
import type { CommandSpec } from "@horizon36596/zenith-schema";
import type { Choice } from "../components/fields";

/** What a command without a summary says, so its tooltip is never empty. */
export const NO_SUMMARY = "robot.json gives this command no summary.";

/** The full summary of the command called `name`, or null when there is none to show. */
export function commandSummary(commands: readonly CommandSpec[], name: string): string | null {
  const summary = commands.find((spec) => spec.name === name)?.summary?.trim();
  return summary === undefined || summary === "" ? null : summary;
}

/**
 * The choices for a command picker, each with its whole summary as the option's tooltip. A name the
 * step already uses that the robot file no longer registers stays on the list, so the picker shows
 * what the file says instead of silently showing the first command.
 */
export function commandChoices(commands: readonly CommandSpec[], current?: string): Choice<string>[] {
  const choices: Choice<string>[] = commands.map((spec) => ({
    value: spec.name,
    label: spec.name,
    hint: commandSummary(commands, spec.name) ?? NO_SUMMARY,
  }));
  if (current !== undefined && !commands.some((spec) => spec.name === current)) {
    choices.push({ value: current, label: current, hint: `robot.json does not register ${current}.` });
  }
  return choices;
}
