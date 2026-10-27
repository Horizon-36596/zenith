import { parseAuto, SCHEMA_ID, type Auto, type Step } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { EditError } from "./errors.js";
import { collectIds, duplicateIds, stepIdProblem } from "./ids.js";
import { setParallel } from "./fields.js";
import { finish } from "./finish.js";
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

  it("refuses an explicit id outside the step id rule, in the rule's own words", () => {
    const command = (id: string): Step => ({ id, kind: "command", name: "launcherIdle" });
    expect(() => addStep(testAuto(), command("park.2"))).toThrow(EditError);
    expect(() => addStep(testAuto(), command("park.2"))).toThrow(stepIdProblem("park.2") ?? "");
    expect(() => addStep(testAuto(), command("a".repeat(65)))).toThrow("A step's id is at most 64 characters.");
    expect(addStep(testAuto(), command("idle_2")).steps.map((step) => step.id)).toEqual([
      "leg1",
      "shoot",
      "park",
      "idle_2",
    ]);
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

  it("refuses an id of only spaces", () => {
    expect(() => renameStep(testAuto(), "shoot", "   ")).toThrow(EditError);
  });

  it("throws when the id does not exist", () => {
    expect(() => renameStep(testAuto(), "nope", "x")).toThrow(EditError);
  });

  it("refuses a new id outside the waypoint name rule, with the reason", () => {
    expect(() => renameStep(testAuto(), "shoot", "shoot preload")).toThrow(
      "A step's id starts with a letter and holds only letters, digits, _ and -.",
    );
    expect(() => renameStep(testAuto(), "shoot", "2nd")).toThrow(EditError);
    expect(() => renameStep(testAuto(), "shoot", "shoot.preload")).toThrow(EditError);
    expect(() => renameStep(testAuto(), "shoot", "")).toThrow("A step needs an id.");
    expect(() => renameStep(testAuto(), "shoot", "a".repeat(65))).toThrow("A step's id is at most 64 characters.");
    expect(() => renameStep(testAuto(), "shoot", "leg1")).toThrow("There is already a step named leg1.");
  });

  it("renames an old id outside the rule to one inside it, and the deadline that named it follows", () => {
    const fixture = testAuto();
    const old = parseAuto({
      ...fixture,
      steps: fixture.steps.map((step) =>
        step.kind === "parallel"
          ? {
              ...step,
              deadline: "drive to wall",
              steps: step.steps.map((member) => (member.id === "drive" ? { ...member, id: "drive to wall" } : member)),
            }
          : step,
      ),
    });
    const result = renameStep(old, "drive to wall", "driveToWall");
    const park = result.steps.find((step) => step.id === "park");
    if (park?.kind !== "parallel") throw new Error("expected parallel");
    expect(park.deadline).toBe("driveToWall");
    expect(park.steps.map((step) => step.id)).toEqual(["driveToWall", "spinDown"]);
  });
});

describe("a parallel group's deadline reference", () => {
  const parkOf = (auto: Auto) => {
    const park = auto.steps.find((step) => step.id === "park");
    if (park?.kind !== "parallel") throw new Error("expected parallel");
    return park;
  };

  /** `park` with a path that has no id of its own after `spinDown`, in the given mode. */
  const withPositionalDrive = (mode: "all" | "deadline"): Auto =>
    finish({
      ...testAuto(),
      steps: testAuto().steps.map((step) =>
        step.id === "park" && step.kind === "parallel"
          ? {
              ...step,
              mode,
              steps: [
                ...step.steps,
                {
                  kind: "path",
                  segments: [{ kind: "line", from: "current", to: { xIn: 24, yIn: 24, headingRad: 0 } }],
                  heading: { mode: "tangent" },
                },
              ],
            }
          : step,
      ),
    });

  it("finding 6: passes to the step left in the group when removeStep deletes the child it names", () => {
    const result = removeStep(testAuto(), "drive");
    const park = parkOf(result);
    expect(park.steps.map((step) => step.id)).toEqual(["spinDown"]);
    expect(park.mode).toBe("deadline");
    expect(park.deadline).toBe("spinDown");
    canonicalRoundTrip(result);
  });

  it("finding 6: passes to the step left in the group when moveStep takes the child out of it", () => {
    const result = moveStep(testAuto(), "drive", 0);
    expect(result.steps.map((step) => step.id)).toEqual(["drive", "leg1", "shoot", "park"]);
    expect(parkOf(result).deadline).toBe("spinDown");
    canonicalRoundTrip(result);
  });

  it("passes to the first remaining step that drives, and names it in the file when it has no id", () => {
    const result = removeStep(withPositionalDrive("deadline"), "drive");
    const park = parkOf(result);
    // The id it went by, park.2, with the dot a step's id cannot hold taken out.
    expect(park.deadline).toBe("park2");
    expect(park.steps.map((step) => step.id)).toEqual(["spinDown", "park2"]);
    expect(canonicalRoundTrip(result)).toContain('"deadline": "park2"');
  });

  it("is dropped from a group in all mode, which has no use for one", () => {
    const stale = withPositionalDrive("all");
    expect(parkOf(stale).deadline).toBe("drive");
    const result = removeStep(stale, "drive");
    const park = parkOf(result);
    expect(park.mode).toBe("all");
    expect("deadline" in park).toBe(false);
    expect(park.steps.map((step) => step.id)).toEqual(["spinDown", undefined]);
  });

  it("stays one of the group's own steps after a switch to deadline and a move out of the group", () => {
    const switched = setParallel(setParallel(testAuto(), "park", { mode: "all" }), "park", { mode: "deadline" });
    expect(parkOf(switched).deadline).toBe("drive");
    const result = moveStep(switched, "drive", "leg1");
    const park = parkOf(result);
    expect(park.mode).toBe("deadline");
    expect(park.steps.map((step) => step.id)).toContain(park.deadline);
    expect(park.deadline).toBe("spinDown");
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

describe("positional ids through an edit (issue #401)", () => {
  /** Wait steps with no ids, told apart by how long they wait. */
  const wait = (seconds: number) => ({ kind: "wait", seconds });
  const autoOf = (steps: unknown[]): Auto =>
    parseAuto({
      $schema: SCHEMA_ID.auto,
      formatVersion: 1,
      name: "positional",
      alliance: "RED",
      start: { pose: { xIn: 0, yIn: 0, headingRad: 0 } },
      steps,
    });
  const group = (deadline: string, members: unknown[]) => ({ id: "g", kind: "parallel", mode: "deadline", deadline, steps: members });
  const seconds = (steps: readonly Step[]) => steps.map((step) => (step.kind === "wait" ? step.seconds : step.kind));
  const groupOf = (auto: Auto) => {
    const found = auto.steps[0];
    if (found?.kind !== "parallel") throw new Error("expected parallel");
    return found;
  };

  it("moveStep puts a positional step after the step the target named before the move", () => {
    const result = moveStep(autoOf([wait(1), wait(2), wait(3)]), "step1", "step2");
    expect(seconds(result.steps)).toEqual([2, 1, 3]);
  });

  it("moveStep into a positional group finds the group the id named before the move", () => {
    const result = moveStep(autoOf([wait(1), { kind: "sequence", steps: [wait(2)] }, { kind: "sequence", steps: [wait(3)] }]), "step1", { into: "step2" });
    const first = result.steps[0];
    // The group that held the 2 s wait, not the one that held the 3 s wait, which was step3.
    expect(first?.kind === "sequence" ? seconds(first.steps) : null).toEqual([2, 1]);
  });

  it("removeStep keeps a deadline on the positional member it named, now renumbered", () => {
    const result = removeStep(autoOf([group("g.2", [wait(1), wait(2), wait(3)])]), "g.1");
    const g = groupOf(result);
    expect(seconds(g.steps)).toEqual([2, 3]);
    expect(g.deadline).toBe("g.1");
  });

  it("moveStep within a group keeps the deadline on the member it named", () => {
    const result = moveStep(autoOf([group("g.1", [wait(1), wait(2), wait(3)])]), "g.1", "g.3");
    const g = groupOf(result);
    expect(seconds(g.steps)).toEqual([2, 3, 1]);
    expect(g.deadline).toBe("g.3");
  });

  it("renameStep carries a deadline that names a positional member by the group's old id", () => {
    const result = renameStep(autoOf([group("g.2", [wait(1), wait(2)])]), "g", "h");
    const h = groupOf(result);
    expect(h.id).toBe("h");
    expect(h.deadline).toBe("h.2");
  });

  it("renaming a positional deadline member still renames the deadline", () => {
    const result = renameStep(autoOf([group("g.2", [wait(1), wait(2)])]), "g.2", "last");
    const g = groupOf(result);
    expect(g.deadline).toBe("last");
    expect(g.steps.map((step) => step.id)).toEqual([undefined, "last"]);
  });
});
