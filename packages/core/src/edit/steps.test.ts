import { parseAuto, SCHEMA_ID, type Auto } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { EditError } from "./errors.js";
import { collectIds, duplicateIds } from "./ids.js";
import { addStep, moveStep, removeStep, renameStep } from "./steps.js";
import { canonicalRoundTrip, testAuto } from "./testing.js";

describe("addStep", () => {
  it("appends at the end when afterId is omitted", () => {
    const result = addStep(testAuto(), { kind: "command", name: "launcherIdle" });
    expect(result.steps.map((step) => step.id)).toEqual(["leg1", "shoot", "park", "command"]);
    canonicalRoundTrip(result);
  });

  it("inserts after a top-level step", () => {
    const result = addStep(testAuto(), { kind: "command", name: "launcherIdle" }, "leg1");
    expect(result.steps.map((step) => step.id)).toEqual(["leg1", "command", "shoot", "park"]);
  });

  it("inserts after a step nested in a parallel group", () => {
    const result = addStep(testAuto(), { kind: "command", name: "launcherIdle" }, "drive");
    const park = result.steps.find((step) => step.id === "park");
    expect(park?.kind).toBe("parallel");
    if (park?.kind !== "parallel") throw new Error("expected parallel");
    expect(park.steps.map((step) => step.id)).toEqual(["drive", "command", "spinDown"]);
    canonicalRoundTrip(result);
  });

  it("gives an id-less step a stable, unique id", () => {
    const result = addStep(testAuto(), { kind: "command", name: "launcherIdle" });
    const result2 = addStep(result, { kind: "command", name: "launcherIdle" });
    expect(result2.steps.map((step) => step.id)).toEqual([
      "leg1",
      "shoot",
      "park",
      "command",
      "command-2",
    ]);
  });

  it("rejects a duplicate explicit id", () => {
    expect(() => addStep(testAuto(), { id: "shoot", kind: "command", name: "launcherIdle" })).toThrow(
      EditError,
    );
  });

  it("rejects an afterId that does not exist", () => {
    expect(() =>
      addStep(testAuto(), { kind: "command", name: "launcherIdle" }, "nope"),
    ).toThrow(EditError);
  });
});

describe("removeStep", () => {
  it("removes a top-level step", () => {
    const result = removeStep(testAuto(), "shoot");
    expect(result.steps.map((step) => step.id)).toEqual(["leg1", "park"]);
    canonicalRoundTrip(result);
  });

  it("removes a step nested in a parallel group", () => {
    const result = removeStep(testAuto(), "spinDown");
    const park = result.steps.find((step) => step.id === "park");
    if (park?.kind !== "parallel") throw new Error("expected parallel");
    expect(park.steps.map((step) => step.id)).toEqual(["drive"]);
    canonicalRoundTrip(result);
  });

  it("throws when the id does not exist", () => {
    expect(() => removeStep(testAuto(), "nope")).toThrow(EditError);
  });

  it("throws rather than leave the auto with zero steps", () => {
    let auto = testAuto();
    auto = removeStep(auto, "shoot");
    auto = removeStep(auto, "park");
    expect(() => removeStep(auto, "leg1")).toThrow(EditError);
  });
});

describe("moveStep", () => {
  it("moves a top-level step after another top-level step", () => {
    const result = moveStep(testAuto(), "shoot", "park");
    expect(result.steps.map((step) => step.id)).toEqual(["leg1", "park", "shoot"]);
    canonicalRoundTrip(result);
  });

  it("moves a step to a numbered top-level index, pulling it out of a nested group", () => {
    const result = moveStep(testAuto(), "spinDown", 0);
    expect(result.steps.map((step) => step.id)).toEqual(["spinDown", "leg1", "shoot", "park"]);
    const park = result.steps.find((step) => step.id === "park");
    if (park?.kind !== "parallel") throw new Error("expected parallel");
    expect(park.steps.map((step) => step.id)).toEqual(["drive"]);
    canonicalRoundTrip(result);
  });

  it("clamps an out-of-range index", () => {
    const result = moveStep(testAuto(), "leg1", 99);
    expect(result.steps.map((step) => step.id)).toEqual(["shoot", "park", "leg1"]);
  });

  it("rejects moving a step after itself", () => {
    expect(() => moveStep(testAuto(), "shoot", "shoot")).toThrow(EditError);
  });

  it("throws when the id to move does not exist", () => {
    expect(() => moveStep(testAuto(), "nope", 0)).toThrow(EditError);
  });

  it("throws when the afterId target does not exist", () => {
    expect(() => moveStep(testAuto(), "shoot", "nope")).toThrow(EditError);
  });
});

describe("renameStep", () => {
  it("renames a top-level step", () => {
    const result = renameStep(testAuto(), "shoot", "volley1");
    expect(result.steps.map((step) => step.id)).toEqual(["leg1", "volley1", "park"]);
    canonicalRoundTrip(result);
  });

  it("keeps a parallel group's deadline pointing at the renamed child", () => {
    const result = renameStep(testAuto(), "drive", "driveToWall");
    const park = result.steps.find((step) => step.id === "park");
    if (park?.kind !== "parallel") throw new Error("expected parallel");
    expect(park.deadline).toBe("driveToWall");
    expect(park.steps.map((step) => step.id)).toEqual(["driveToWall", "spinDown"]);
    canonicalRoundTrip(result);
  });

  it("rejects renaming to an id that already exists", () => {
    expect(() => renameStep(testAuto(), "shoot", "leg1")).toThrow(EditError);
  });

  it("throws when the id does not exist", () => {
    expect(() => renameStep(testAuto(), "nope", "x")).toThrow(EditError);
  });
});

describe("a parallel group's deadline reference", () => {
  it("finding 6: is dropped when removeStep deletes the child it names", () => {
    const result = removeStep(testAuto(), "drive");
    const park = result.steps.find((step) => step.id === "park");
    if (park?.kind !== "parallel") throw new Error("expected parallel");
    expect(park.steps.map((step) => step.id)).toEqual(["spinDown"]);
    expect(park.deadline).toBeUndefined();
    canonicalRoundTrip(result);
  });

  it("finding 6: is dropped when moveStep takes the child out of the group", () => {
    const result = moveStep(testAuto(), "drive", 0);
    const park = result.steps.find((step) => step.id === "park");
    if (park?.kind !== "parallel") throw new Error("expected parallel");
    expect(result.steps.map((step) => step.id)).toEqual(["drive", "leg1", "shoot", "park"]);
    expect(park.deadline).toBeUndefined();
    canonicalRoundTrip(result);
  });

  it("finding 6: survives a move inside the group it belongs to", () => {
    const result = moveStep(testAuto(), "drive", "spinDown");
    const park = result.steps.find((step) => step.id === "park");
    if (park?.kind !== "parallel") throw new Error("expected parallel");
    expect(park.steps.map((step) => step.id)).toEqual(["spinDown", "drive"]);
    expect(park.deadline).toBe("drive");
  });
});

describe("ids after an insertion", () => {
  /** Three unnamed command steps, so every id is positional: step1, step2, step3. */
  const unnamed = (): Auto =>
    parseAuto({
      $schema: SCHEMA_ID.auto,
      formatVersion: 1,
      name: "positional",
      alliance: "RED",
      start: { pose: { xIn: 0, yIn: 0, headingRad: 0 } },
      steps: [
        { kind: "command", name: "launcherIdle" },
        { kind: "command", name: "launcherIdle" },
        { kind: "command", name: "launcherIdle" },
      ],
    });

  it("finding 8: refuses an explicit id that the insertion itself would collide with", () => {
    // Inserting after step1 pushes the old step2 and step3 down to step3 and step4.
    expect(() =>
      addStep(unnamed(), { id: "step4", kind: "command", name: "launcherIdle" }, "step1"),
    ).toThrow(EditError);
  });

  it("finding 8: mints an id that is free after the insertion, not before it", () => {
    const result = addStep(unnamed(), { kind: "command", name: "launcherIdle" }, "step1");
    expect(collectIds(result.steps).size).toBe(result.steps.length);
    expect(duplicateIds(result.steps)).toEqual([]);
  });

  it("finding 8: an id-less step still lands next to the step it was added after", () => {
    const result = addStep(testAuto(), { kind: "command", name: "launcherIdle" }, "leg1");
    expect(result.steps[1]?.id).toBe("command");
  });
});
