import { describe, expect, it } from "vitest";
import { setCommandArgs } from "./command.js";
import { EditError } from "./errors.js";
import { canonicalRoundTrip, testAuto } from "./testing.js";

describe("setCommandArgs", () => {
  it("replaces a command step's args", () => {
    const result = setCommandArgs(testAuto(), "shoot", { count: 1, cadence: "precise" });
    const step = result.steps.find((s) => s.id === "shoot");
    if (step?.kind !== "command") throw new Error("expected command");
    expect(step.args).toEqual({ count: 1, cadence: "precise" });
    canonicalRoundTrip(result);
  });

  it("clears args when none are given", () => {
    const result = setCommandArgs(testAuto(), "shoot", undefined);
    const step = result.steps.find((s) => s.id === "shoot");
    if (step?.kind !== "command") throw new Error("expected command");
    expect(step.args).toBeUndefined();
    canonicalRoundTrip(result);
  });

  it("rejects a non-command step", () => {
    expect(() => setCommandArgs(testAuto(), "leg1", { count: 1 })).toThrow(EditError);
  });

  it("throws when the id does not exist", () => {
    expect(() => setCommandArgs(testAuto(), "nope", {})).toThrow(EditError);
  });
});
