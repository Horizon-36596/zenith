/**
 * Dragging a step anywhere in the tree, and deleting steps (issues #160 and #144): a deadline group
 * whose deadline member is dragged out of it, or deleted, passes its deadline to its first remaining
 * step that drives, or its first step, as core's `moveStep` and `removeStep` do, rather than keeping
 * a name that is no longer one of its own steps or naming none; a move inside the group keeps it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadAuto, setParallel, stepIdProblem } from "@horizon36596/zenith-core";
import { SCHEMA_ID, type Auto, type ParallelStep, type Step } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { findEntry } from "./stepOps";
import {
  insertStepAfter,
  moveStepRelative,
  moveStepReportingDeadlines,
  removeStepsReportingDeadlines,
  unwrapStep,
  wrapSteps,
} from "./structure";

const examples = fileURLToPath(new URL("../../../../examples/starter/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${examples}${relative}`, "utf8"));

/**
 * collect-and-score ends with `returnToScore`, a deadline parallel group of the path `driveBack`
 * (its deadline) and the sequence `clearThenSpinUp`, then the command `scoreGardenPollen`.
 */
const collectAndScore = (): Auto => loadAuto(read("autos/collect-and-score.auto.json"));

const parallelAt = (auto: Auto, stepId: string): ParallelStep => {
  const step = findEntry(auto, stepId)?.step;
  if (step?.kind !== "parallel") throw new Error(`${stepId} is not a parallel group`);
  return step;
};

/** True when the group's deadline names one of its own direct steps, which is what `check` asks. */
const namesOwnStep = (group: ParallelStep, groupId: string): boolean =>
  group.steps.some((member, index) => (member.id ?? `${groupId}.${String(index + 1)}`) === group.deadline);

describe("moving a deadline group's deadline member", () => {
  it("passes the deadline to the step left in the group when the member is moved out after it", () => {
    const moved = moveStepRelative(collectAndScore(), "driveBack", "returnToScore", "after");
    const group = parallelAt(moved, "returnToScore");
    expect(group.steps.map((member) => member.id)).toEqual(["clearThenSpinUp"]);
    expect(group.mode).toBe("deadline");
    expect(group.deadline).toBe("clearThenSpinUp");
    expect(findEntry(moved, "driveBack")?.depth).toBe(0);
  });

  it("passes it on when the member is moved into another group", () => {
    const moved = moveStepRelative(collectAndScore(), "driveBack", "clearThenSpinUp", "into");
    expect(parallelAt(moved, "returnToScore").deadline).toBe("clearThenSpinUp");
  });

  it("passes it to the first remaining step that drives, not simply the first step", () => {
    // returnToScore holds scoreGardenPollen (a command), driveBack (its deadline), clearThenSpinUp,
    // and a second path, driveOut, so the pick has to skip the command.
    const withCommand = moveStepRelative(collectAndScore(), "scoreGardenPollen", "driveBack", "before");
    const withSecondDrive = moveStepRelative(withCommand, "driveOut", "clearThenSpinUp", "after");
    const out = moveStepReportingDeadlines(withSecondDrive, "driveBack", "returnToScore", "after");
    const group = parallelAt(out.auto, "returnToScore");
    expect(group.steps.map((member) => member.id)).toEqual(["scoreGardenPollen", "clearThenSpinUp", "driveOut"]);
    expect(group.deadline).toBe("driveOut");
    expect(out.repointedDeadlines).toEqual([
      { groupId: "returnToScore", deadline: "driveBack", newDeadline: "driveOut" },
    ]);
  });

  it("keeps the deadline when the member is moved inside its own group", () => {
    const moved = moveStepRelative(collectAndScore(), "driveBack", "clearThenSpinUp", "after");
    const group = parallelAt(moved, "returnToScore");
    expect(group.steps.map((member) => member.id)).toEqual(["clearThenSpinUp", "driveBack"]);
    expect(group.deadline).toBe("driveBack");
  });

  it("keeps the deadline when another step moves in or out of the group", () => {
    const moved = moveStepRelative(collectAndScore(), "scoreGardenPollen", "driveBack", "after");
    expect(parallelAt(moved, "returnToScore").deadline).toBe("driveBack");
    const back = moveStepRelative(moved, "scoreGardenPollen", "returnToScore", "after");
    expect(parallelAt(back, "returnToScore").deadline).toBe("driveBack");
  });

  it("reports the deadline the move passed on, which group it belonged to, and the new one", () => {
    const out = moveStepReportingDeadlines(collectAndScore(), "driveBack", "returnToScore", "before");
    expect(parallelAt(out.auto, "returnToScore").deadline).toBe("clearThenSpinUp");
    expect(out.repointedDeadlines).toEqual([
      { groupId: "returnToScore", deadline: "driveBack", newDeadline: "clearThenSpinUp" },
    ]);
  });

  it("reports nothing when the deadline survives the move", () => {
    const out = moveStepReportingDeadlines(collectAndScore(), "driveBack", "clearThenSpinUp", "after");
    expect(out.repointedDeadlines).toEqual([]);
  });

  it("drops a stale deadline from a group in all mode without reporting it", () => {
    const stale: Auto = {
      ...collectAndScore(),
      steps: collectAndScore().steps.map((step) =>
        step.id === "returnToScore" && step.kind === "parallel" ? { ...step, mode: "all" } : step,
      ),
    };
    const out = moveStepReportingDeadlines(stale, "driveBack", "returnToScore", "after");
    const group = parallelAt(out.auto, "returnToScore");
    expect(group.mode).toBe("all");
    expect("deadline" in group).toBe(false);
    expect(out.repointedDeadlines).toEqual([]);
  });
});

describe("switching a group to deadline, then dragging its deadline step out", () => {
  it("leaves a deadline group that names one of its own steps, never a deadline group with none", () => {
    const all = setParallel(collectAndScore(), "returnToScore", { mode: "all" });
    expect("deadline" in parallelAt(all, "returnToScore")).toBe(false);
    const switched = setParallel(all, "returnToScore", { mode: "deadline" });
    expect(parallelAt(switched, "returnToScore").deadline).toBe("driveBack");

    const out = moveStepReportingDeadlines(switched, "driveBack", "scoreGardenPollen", "after");
    const group = parallelAt(out.auto, "returnToScore");
    expect(group.mode).toBe("deadline");
    expect(group.deadline).toBe("clearThenSpinUp");
    expect(namesOwnStep(group, "returnToScore")).toBe(true);
    expect(out.repointedDeadlines).toEqual([
      { groupId: "returnToScore", deadline: "driveBack", newDeadline: "clearThenSpinUp" },
    ]);

    // Switching to deadline again keeps the step the group now names.
    const again = setParallel(setParallel(out.auto, "returnToScore", { mode: "race" }), "returnToScore", {
      mode: "deadline",
    });
    expect(parallelAt(again, "returnToScore").deadline).toBe("clearThenSpinUp");
  });
});

describe("deleting a deadline group's deadline member", () => {
  it("passes the deadline to the step left in the group, and reports it", () => {
    const out = removeStepsReportingDeadlines(collectAndScore(), ["driveBack"]);
    const group = parallelAt(out.auto, "returnToScore");
    expect(group.steps.map((member) => member.id)).toEqual(["clearThenSpinUp"]);
    expect(group.deadline).toBe("clearThenSpinUp");
    expect(out.repointedDeadlines).toEqual([
      { groupId: "returnToScore", deadline: "driveBack", newDeadline: "clearThenSpinUp" },
    ]);
  });

  it("reports nothing when the deadline member stays", () => {
    const out = removeStepsReportingDeadlines(collectAndScore(), ["clearGarden", "scoreGardenPollen"]);
    expect(parallelAt(out.auto, "returnToScore").deadline).toBe("driveBack");
    expect(out.repointedDeadlines).toEqual([]);
  });
});

describe("wrapping steps in a branch (issue #312)", () => {
  const branch = { condition: "hasPollen", id: "branch" };

  it("refuses steps with others between them, as a sequence does, and changes nothing", () => {
    const auto = collectAndScore();
    const wrap = (kind: "sequence" | "branch") => () => wrapSteps(auto, ["driveOut", "toScoreNorth"], kind, branch);
    expect(wrap("sequence")).toThrow(/one unbroken run/);
    expect(wrap("branch")).toThrow(/one unbroken run/);
    expect(auto).toEqual(collectAndScore());
  });

  it("wraps an unbroken run in place, in the then arm, keeping the steps around it", () => {
    const out = wrapSteps(collectAndScore(), ["shootPreloads", "toOtherSide"], "branch", branch);
    expect(out.id).toBe("branch");
    expect(out.auto.steps.map((step) => step.id).slice(0, 4)).toEqual(["driveOut", "branch", "collectFlower", "waitForFull"]);
    const wrapped = findEntry(out.auto, "branch")?.step;
    expect(wrapped?.kind === "branch" ? wrapped.then.map((step) => step.id) : []).toEqual(["shootPreloads", "toOtherSide"]);
    expect(wrapped?.kind === "branch" ? wrapped.condition : undefined).toBe("hasPollen");
  });

  it("passes a deadline group's deadline to the new branch when it wraps the deadline step", () => {
    const out = wrapSteps(collectAndScore(), ["driveBack"], "branch", branch);
    const group = parallelAt(out.auto, "returnToScore");
    expect(group.steps.map((member) => member.id)).toEqual(["branch", "clearThenSpinUp"]);
    expect(group.deadline).toBe("branch");
    expect(namesOwnStep(group, "returnToScore")).toBe(true);
  });

  it("keeps the deadline when it wraps another step of the group", () => {
    const out = wrapSteps(collectAndScore(), ["clearThenSpinUp"], "branch", branch);
    expect(parallelAt(out.auto, "returnToScore").deadline).toBe("driveBack");
  });
});

describe("deadlines that name positional steps (issue #401)", () => {
  const path = { kind: "path", segments: [{ kind: "line", from: "current", to: { xIn: 24, yIn: 0, headingRad: 0 } }], heading: { mode: "tangent" } };
  const wait = (seconds: number) => ({ kind: "wait", seconds });
  const autoOf = (steps: unknown[]): Auto =>
    loadAuto({
      $schema: SCHEMA_ID.auto,
      formatVersion: 4,
      name: "positional",
      alliance: "RED",
      start: { pose: { xIn: 0, yIn: 0, headingRad: 0 } },
      steps,
    });
  const groupOf = (auto: Auto): ParallelStep => {
    const group = auto.steps[0];
    if (group?.kind !== "parallel") throw new Error("expected a parallel group first");
    return group;
  };

  it("a move inside the group keeps the deadline on the member it named, not on its old number", () => {
    const auto = autoOf([{ id: "g", kind: "parallel", mode: "deadline", deadline: "g.1", steps: [path, wait(0.1)] }]);
    const moved = moveStepReportingDeadlines(auto, "g.2", "g.1", "before");
    const group = groupOf(moved.auto);
    expect(group.steps.map((member) => member.kind)).toEqual(["wait", "path"]);
    expect(group.deadline).toBe("g.2");
    expect(moved.repointedDeadlines).toEqual([]);
  });

  it("deleting a positional member keeps the deadline on the member it named, renumbered", () => {
    const auto = autoOf([{ id: "g", kind: "parallel", mode: "deadline", deadline: "g.2", steps: [wait(1), wait(2), wait(3)] }]);
    const removed = removeStepsReportingDeadlines(auto, ["g.1"]);
    const group = groupOf(removed.auto);
    expect(group.deadline).toBe("g.1");
    expect(group.steps[0]?.kind === "wait" ? group.steps[0].seconds : null).toBe(2);
    expect(removed.repointedDeadlines).toEqual([]);
  });

  it("deleting the positional deadline member reports it by the id it had", () => {
    const auto = autoOf([{ id: "g", kind: "parallel", mode: "deadline", deadline: "g.1", steps: [wait(1), path] }]);
    const removed = removeStepsReportingDeadlines(auto, ["g.1"]);
    // The path is pinned as the deadline, under an id inside the step id rule rather than `g.1`.
    expect(removed.repointedDeadlines).toEqual([{ groupId: "g", deadline: "g.1", newDeadline: "g1" }]);
    expect(groupOf(removed.auto).steps.map((member) => member.kind)).toEqual(["path"]);
    expect(groupOf(removed.auto).steps[0]?.id).toBe("g1");
  });

  it("dragging the deadline member out pins the new one under an id inside the rule", () => {
    const auto = autoOf([{ id: "g", kind: "parallel", mode: "deadline", deadline: "g.1", steps: [wait(1), path] }, wait(5)]);
    const moved = moveStepReportingDeadlines(auto, "g.1", "step2", "after");
    const group = groupOf(moved.auto);
    expect(group.deadline).toBe("g1");
    expect(group.steps.map((member) => member.id)).toEqual(["g1"]);
    expect(moved.repointedDeadlines).toEqual([{ groupId: "g", deadline: "g.1", newDeadline: "g1" }]);
  });

  it("unwrapping a branch passes a deadline that named it to the step of its then arm", () => {
    const auto = autoOf([
      { id: "g", kind: "parallel", mode: "deadline", deadline: "b", steps: [{ id: "b", kind: "branch", condition: "holdingPiece", then: [path] }, wait(1)] },
    ]);
    const group = groupOf(unwrapStep(auto, "b"));
    expect(group.steps.map((member) => member.kind)).toEqual(["path", "wait"]);
    expect(group.deadline).toBe("g.1");
  });

  it("unwrapping a branch keeps a deadline on a positional step after it that the then arm renumbers", () => {
    const auto = autoOf([
      { id: "g", kind: "parallel", mode: "deadline", deadline: "g.2", steps: [{ id: "b", kind: "branch", condition: "holdingPiece", then: [path, wait(1)] }, wait(2)] },
    ]);
    const group = groupOf(unwrapStep(auto, "b"));
    expect(group.steps.map((member) => (member.kind === "wait" ? member.seconds : member.kind))).toEqual(["path", 1, 2]);
    expect(group.deadline).toBe("g.3");
  });
});

describe("insertStepAfter and a new step's explicit id", () => {
  const wait = (id?: string): Step => ({ ...(id === undefined ? {} : { id }), kind: "wait", seconds: 0.5 });

  it.each([["after a step", "driveBack"], ["at the end", undefined]])(
    "refuses an id outside the step id rule %s, in core's words",
    (_where, afterId) => {
      expect(() => insertStepAfter(collectAndScore(), wait("park.2"), afterId)).toThrow(stepIdProblem("park.2") ?? "");
      expect(() => insertStepAfter(collectAndScore(), wait("a".repeat(65)), afterId)).toThrow(
        "A step's id is at most 64 characters.",
      );
    },
  );

  it.each([["after a step", "driveBack"], ["at the end", undefined]])(
    "adds a step with an id inside the rule, or none, %s",
    (_where, afterId) => {
      expect(insertStepAfter(collectAndScore(), wait("pause_1"), afterId).id).toBe("pause_1");
      expect(insertStepAfter(collectAndScore(), wait(), afterId).id).toBe("wait");
    },
  );
});
