import { parseAuto, SCHEMA_ID, type Auto, type PathStep, type Step } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { listIds } from "./ids.js";
import { EditError } from "./errors.js";
import {
  insertStepAfter,
  repairContinuity,
  unwrapStep,
  wrapSteps,
  wrapStepsWithId,
} from "./groups.js";
import { addStep, moveStep } from "./steps.js";
import { findStep } from "./tree.js";
import { canonicalRoundTrip, testAuto } from "./testing.js";

const auto = (steps: unknown[]): Auto =>
  parseAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 2,
    name: "groups-fixture",
    alliance: "RED",
    start: { pose: { xIn: 0, yIn: 0, headingRad: 0 } },
    steps,
  });

const line = (id: string | undefined, from: unknown, toX: number, toY: number): Step =>
  ({
    ...(id === undefined ? {} : { id }),
    kind: "path",
    segments: [{ kind: "line", from, to: { xIn: toX, yIn: toY } }],
    heading: { mode: "tangent" },
  }) as Step;

const wait = (id?: string): Step => ({ ...(id === undefined ? {} : { id }), kind: "wait", seconds: 0.5 });

const firstFrom = (a: Auto, id: string): unknown => {
  const step = findStep(a.steps, "step", id);
  return step?.kind === "path" ? step.segments[0]?.from : undefined;
};

describe("wrapSteps", () => {
  it("wraps a run of top-level steps in a sequence, in document order", () => {
    const wrapped = wrapStepsWithId(testAuto(), ["shoot", "leg1"], "sequence");
    expect(wrapped.id).toBe("sequence");
    expect(wrapped.auto.steps.map((step) => step.kind)).toEqual(["sequence", "parallel"]);
    const group = wrapped.auto.steps[0];
    expect(group?.kind === "sequence" ? group.steps.map((step) => step.id) : []).toEqual(["leg1", "shoot"]);
    canonicalRoundTrip(wrapped.auto);
  });

  it("wraps members of a parallel group in a parallel race group", () => {
    const wrapped = wrapSteps(testAuto(), ["spinDown"], "parallel", "race");
    const park = findStep(wrapped.steps, "step", "park");
    const inner = park?.kind === "parallel" ? park.steps[1] : undefined;
    expect(inner).toMatchObject({ kind: "parallel", mode: "race", id: "parallel" });
  });

  it("gives a deadline group its first driving member as the deadline", () => {
    const wrapped = wrapSteps(auto([wait("w"), line("go", "current", 10, 0)]), ["w", "go"], "parallel", "deadline");
    expect(wrapped.steps[0]).toMatchObject({ kind: "parallel", mode: "deadline", deadline: "go" });
  });

  it("repoints the surrounding group's deadline at the new group that holds it", () => {
    const wrapped = wrapSteps(testAuto(), ["drive"], "sequence");
    expect(findStep(wrapped.steps, "step", "park")).toMatchObject({ deadline: "sequence" });
  });

  it("keeps the ids of positional steps that move", () => {
    const a = auto([wait(), wait(), wait(), wait()]);
    const wrapped = wrapSteps(a, ["step2", "step3"], "sequence");
    expect(listIds(wrapped.steps)).toEqual(["step1", "sequence", "step2", "step3", "step4"]);
  });

  it("refuses steps that are not siblings, a broken run, and a sequence with a mode", () => {
    expect(() => wrapSteps(testAuto(), ["leg1", "drive"], "sequence")).toThrow(/not in the same list/);
    expect(() => wrapSteps(testAuto(), ["leg1", "park"], "sequence")).toThrow(/unbroken run/);
    expect(() => wrapSteps(testAuto(), ["leg1"], "sequence", "all")).toThrow(EditError);
    expect(() => wrapSteps(testAuto(), ["nope"], "sequence")).toThrow(/No step/);
    expect(() => wrapSteps(testAuto(), [], "sequence")).toThrow(/at least one/);
  });
});

describe("unwrapStep", () => {
  it("is the inverse of wrapSteps for a sequence", () => {
    const original = testAuto();
    const unwrapped = unwrapStep(wrapSteps(original, ["leg1", "shoot"], "sequence"), "sequence");
    expect(unwrapped).toEqual(original);
  });

  it("puts a parallel group's members in its place and passes its deadline role on", () => {
    const a = auto([
      {
        id: "outer",
        kind: "parallel",
        mode: "deadline",
        deadline: "inner",
        steps: [
          { id: "inner", kind: "parallel", mode: "deadline", deadline: "go", steps: [line("go", "current", 10, 0), wait("w")] },
          wait("side"),
        ],
      },
    ]);
    const unwrapped = unwrapStep(a, "inner");
    const outer = unwrapped.steps[0];
    expect(outer?.kind === "parallel" ? outer.steps.map((step) => step.id) : []).toEqual(["go", "w", "side"]);
    expect(outer).toMatchObject({ deadline: "go" });
  });

  it("keeps positional members' ids", () => {
    const a = auto([{ id: "grp", kind: "sequence", steps: [wait(), wait()] }, wait()]);
    expect(listIds(unwrapStep(a, "grp").steps)).toEqual(["grp.1", "grp.2", "step2"]);
  });

  it("refuses a branch and a leaf", () => {
    const a = auto([{ id: "b", kind: "branch", condition: "hopperFull", then: [wait("t")] }]);
    expect(() => unwrapStep(a, "b")).toThrow(/only a sequence or a parallel group/);
    expect(() => unwrapStep(a, "t")).toThrow(/only a sequence or a parallel group/);
  });
});

describe("moving into and out of groups", () => {
  it("adds a step at the front of a sequence and into a branch's else arm", () => {
    const a = auto([{ id: "grp", kind: "sequence", steps: [wait("w")] }, { id: "b", kind: "branch", condition: "hopperFull", then: [wait("t")] }]);
    const front = addStep(a, wait("first"), { into: "grp", index: 0 });
    const group = front.steps[0];
    expect(group?.kind === "sequence" ? group.steps.map((step) => step.id) : []).toEqual(["first", "w"]);
    const intoElse = addStep(a, wait("e"), { into: "b", arm: "else" });
    expect(intoElse.steps[1]).toMatchObject({ else: [{ id: "e" }] });
  });

  it("moves a top-level step into a sequence and back out again", () => {
    const a = auto([wait("a"), { id: "grp", kind: "sequence", steps: [wait("w")] }]);
    const inside = moveStep(a, "a", { into: "grp" });
    expect(inside.steps.map((step) => step.id)).toEqual(["grp"]);
    expect(listIds(inside.steps)).toEqual(["grp", "w", "a"]);
    const outside = moveStep(inside, "a", 0);
    expect(listIds(outside.steps)).toEqual(["a", "grp", "w"]);
  });

  it("refuses to move a group into itself or into one of its members", () => {
    const a = auto([{ id: "grp", kind: "sequence", steps: [{ id: "inner", kind: "sequence", steps: [wait("w")] }] }]);
    expect(() => moveStep(a, "grp", { into: "grp" })).toThrow(/into itself/);
    expect(() => moveStep(a, "grp", { into: "inner" })).toThrow(/own members/);
    expect(() => moveStep(a, "w", { into: "w" })).toThrow(EditError);
  });
});

describe("insertStepAfter", () => {
  const route = (): Auto =>
    auto([
      line("one", "current", 24, 0),
      line("two", { xIn: 24, yIn: 0 }, 24, 24),
      line("three", "current", 0, 24),
    ]);

  it('starts a path inserted mid-routine from "current", the end of the step it follows', () => {
    const result = insertStepAfter(route(), "one", line(undefined, { xIn: 99, yIn: 99 }, 12, -12));
    expect(result.id).toBe("path");
    expect(listIds(result.auto.steps)).toEqual(["one", "path", "two", "three"]);
    expect(firstFrom(result.auto, "path")).toBe("current");
  });

  it("reports the following step whose fixed start now leaves a gap, and repairs it", () => {
    const result = insertStepAfter(route(), "one", line("detour", "current", 12, -12));
    expect(result.continuityGapStepId).toBe("two");
    expect(result.continuityGapIn).toBeCloseTo(Math.hypot(12, 12), 6);
    const repaired = repairContinuity(result.auto, "two");
    expect(firstFrom(repaired, "two")).toBe("current");
  });

  it("reports no gap when the following step already starts from current", () => {
    const result = insertStepAfter(route(), "two", line("detour", "current", 40, 40));
    expect(result.continuityGapStepId).toBeNull();
  });

  it("reports no gap when a non-moving step is inserted", () => {
    const result = insertStepAfter(route(), "one", wait("pause"));
    expect(result.continuityGapStepId).toBeNull();
    expect(listIds(result.auto.steps)).toEqual(["one", "pause", "two", "three"]);
  });

  it("writes the pose out when the anchor is a member of a parallel group", () => {
    const a = auto([
      { id: "par", kind: "parallel", mode: "all", steps: [line("drive", "current", 30, 0), wait("w")] },
    ]);
    const result = insertStepAfter(a, "drive", line("also", "current", 30, 30));
    const from = firstFrom(result.auto, "also");
    expect(from).toMatchObject({ xIn: 30, yIn: 0, provenance: "SET FROM EDITOR: where drive ends" });
  });

  it("keeps positional siblings' ids after the insertion point", () => {
    const a = auto([line(undefined, "current", 10, 0), line(undefined, "current", 20, 0)]);
    const result = insertStepAfter(a, "step1", wait("pause"));
    expect(listIds(result.auto.steps)).toEqual(["step1", "pause", "step2"]);
  });

  it("refuses an unknown anchor", () => {
    expect(() => insertStepAfter(route(), "nope", wait())).toThrow(/No step/);
  });
});

describe("repairContinuity", () => {
  it("only repairs a path step", () => {
    const a = auto([wait("w")]);
    expect(() => repairContinuity(a, "w")).toThrow(/only a path step/);
    expect(() => repairContinuity(a, "nope")).toThrow(/No step/);
  });

  it("leaves the rest of the path alone", () => {
    const a = auto([line("p", { xIn: 5, yIn: 5 }, 10, 10)]);
    const repaired = repairContinuity(a, "p").steps[0] as PathStep;
    expect(repaired.segments[0]).toMatchObject({ from: "current", to: { xIn: 10, yIn: 10 } });
  });
});
