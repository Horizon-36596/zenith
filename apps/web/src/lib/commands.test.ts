import type { CommandSpec } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { NO_SUMMARY, commandChoices, commandSummary } from "./commands";

/** The BIOBUZZ robot's relocalize summary, which is long enough that a one-line picker cut it off. */
const RELOCALIZE =
  "AutoBase.relocalize() -> RelocalizeFromVision(vision): overwrites odometry from vision if within RELOCALIZE_MAX_JUMP_IN inches; no-op today with the default NoVision provider.";

const commands = [
  { name: "relocalize", summary: RELOCALIZE, estimateS: "0" },
  { name: "cancelAll", estimateS: "0" },
] as unknown as CommandSpec[];

describe("commandSummary", () => {
  it("returns the whole summary, not a shortened one", () => {
    expect(commandSummary(commands, "relocalize")).toBe(RELOCALIZE);
  });

  it("is null for a command with no summary or no such command", () => {
    expect(commandSummary(commands, "cancelAll")).toBeNull();
    expect(commandSummary(commands, "missing")).toBeNull();
  });
});

describe("commandChoices", () => {
  it("gives every option its full summary as the tooltip", () => {
    const choices = commandChoices(commands);
    expect(choices.map((choice) => choice.value)).toEqual(["relocalize", "cancelAll"]);
    expect(choices[0]?.hint).toBe(RELOCALIZE);
    expect(choices[1]?.hint).toBe(NO_SUMMARY);
  });

  it("keeps a name the robot file no longer registers, so the picker shows what the file says", () => {
    const choices = commandChoices(commands, "oldCommand");
    expect(choices.at(-1)).toMatchObject({ value: "oldCommand", label: "oldCommand" });
    expect(commandChoices(commands, "relocalize")).toHaveLength(2);
  });
});
