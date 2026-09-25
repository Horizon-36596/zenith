import { describe, expect, it } from "vitest";
import { EditError } from "./errors.js";
import { setTimeout as setStepTimeout } from "./timing.js";
import { canonicalRoundTrip, testAuto } from "./testing.js";

describe("setTimeout", () => {
  it("sets a path step's timeoutS", () => {
    const result = setStepTimeout(testAuto(), "leg1", 9);
    const step = result.steps.find((s) => s.id === "leg1");
    expect(step?.kind === "path" && step.timeoutS).toBe(9);
    canonicalRoundTrip(result);
  });

  it("sets a nested command step's timeoutS", () => {
    const result = setStepTimeout(testAuto(), "spinDown", 1.5);
    const park = result.steps.find((s) => s.id === "park");
    if (park?.kind !== "parallel") throw new Error("expected parallel");
    const spinDown = park.steps.find((s) => s.id === "spinDown");
    expect(spinDown?.kind === "command" && spinDown.timeoutS).toBe(1.5);
    canonicalRoundTrip(result);
  });

  it("clears a timeout when given undefined", () => {
    const result = setStepTimeout(testAuto(), "leg1", undefined);
    const step = result.steps.find((s) => s.id === "leg1");
    expect(step?.kind === "path" && step.timeoutS).toBeUndefined();
    canonicalRoundTrip(result);
  });

  it("rejects a step kind with no timeoutS", () => {
    expect(() => setStepTimeout(testAuto(), "park", 1)).toThrow(EditError);
  });

  it("throws when the id does not exist", () => {
    expect(() => setStepTimeout(testAuto(), "nope", 1)).toThrow(EditError);
  });
});
