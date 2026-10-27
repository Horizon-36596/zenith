/**
 * A command argument's row is called by the label robot.json gives it, or else its key in sentence
 * case, and the raw key stays in the row's hint (issue #410).
 */
import { describe, expect, it } from "vitest";
import { argHint, argLabel, sentenceCase } from "./CommandArgsForm";

describe("a command argument's row label", () => {
  it("sentence-cases the key", () => {
    expect(sentenceCase("count")).toBe("Count");
    expect(sentenceCase("state")).toBe("State");
    expect(sentenceCase("preloadCount")).toBe("Preload count");
    expect(sentenceCase("arm_state")).toBe("Arm state");
    expect(sentenceCase("RPM")).toBe("Rpm");
  });

  it("uses the label robot.json gives it when there is one", () => {
    expect(argLabel("count", { type: "integer", label: "Pollen to launch" })).toBe("Pollen to launch");
    expect(argLabel("count", { type: "integer" })).toBe("Count");
    expect(argLabel("count", { type: "integer", label: "  " })).toBe("Count");
  });

  it("keeps the raw key in the row hint", () => {
    expect(argHint("preloadCount")).toContain("preloadCount");
  });

  it("says what the argument means and its range, from robot.json, before the key (W2-19)", () => {
    const summary =
      "Launches count pollen into the alliance's up hive cell, then waits for the launcher to settle. The robot must stand still while it runs.";
    expect(argHint("count", { type: "integer", min: 1, max: 4, default: 1 }, summary)).toBe(
      "Launches count pollen into the alliance's up hive cell, then waits for the launcher to settle. A whole number from 1 to 4, 1 by default. The argument's key in robot.json: count.",
    );
    expect(argHint("speed", { type: "number", max: 1 })).toBe("A number of at most 1. The argument's key in robot.json: speed.");
    expect(argHint("state", { type: "enum", values: ["ON", "OFF"], default: "ON" }, "Sets the intake.")).toBe(
      "One of ON, OFF, ON by default. The argument's key in robot.json: state.",
    );
    expect(argHint("reverse", { type: "boolean", default: false })).toBe("On or off, off by default. The argument's key in robot.json: reverse.");
  });
});
