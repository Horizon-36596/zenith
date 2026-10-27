/**
 * Suggest changes lists the partner's steps. A command reads by its real name and arguments when
 * the share includes command names, and only by its token (`cmd1`) when it does not.
 */
import { describe, expect, it } from "vitest";
import type { ProjectionStep } from "@horizon36596/zenith-schema";
import { commandNamer } from "../cloud/projectionModel";
import { stepWords } from "./stepWords";

const command = { id: "s2", kind: "command", token: "cmd1", estimateS: 2.5, stationary: true, movesRobot: false } as ProjectionStep;
const path = {
  id: "s3",
  kind: "path",
  segments: [{ kind: "line", to: { xIn: 0, yIn: 24 } }],
  markers: [{ at: { t: 0.5 }, token: "cmd2" }],
} as unknown as ProjectionStep;

describe("stepWords", () => {
  it("names each command when the share includes command names", () => {
    const name = commandNamer({
      commands: [
        { token: "cmd1", kind: "command", name: "score", args: { count: 4 } },
        { token: "cmd2", kind: "marker", name: "intakeOn" },
      ],
    });
    expect(stepWords(command, name)).toBe("score (count 4) · 2.5 s · stationary");
    expect(stepWords(path, name)).toBe("1 path · intakeOn");
  });

  it("shows the tokens when the share does not", () => {
    const name = commandNamer({});
    expect(stepWords(command, name)).toBe("cmd1 · 2.5 s · stationary");
    expect(stepWords(path, name)).toBe("1 path · cmd2");
    expect(stepWords(command)).toBe("cmd1 · 2.5 s · stationary");
  });
});
