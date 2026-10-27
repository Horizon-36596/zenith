/**
 * The editor's Duplicate step, the Steps panel's drag and drop, and Delete on a deadline group
 * (issues #160 and #144): a duplicate's deadline names its own copy of the deadline member, and
 * dragging the deadline member out of its group, or deleting it, passes the group's deadline to its
 * first remaining step that drives, or its first step, so the group stays valid, and the status line
 * says which step that is and how to change it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalize, loadAuto, setParallel } from "@horizon36596/zenith-core";
import type { Auto, ParallelStep } from "@horizon36596/zenith-schema";
import { beforeEach, describe, expect, it } from "vitest";
import { findEntry } from "../lib/stepOps";
import { ALL_FEATURES, setFeatures } from "../state/features";
import { getState, openAuto, selectStep, undo } from "../state/store";
import { deleteSelection, duplicateSelection, moveStepTo, tryEdit } from "./edits";

const examples = fileURLToPath(new URL("../../../../examples/starter/autos/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${examples}${relative}`, "utf8"));

const auto = (): Auto => {
  const current = getState().auto;
  if (current === null) throw new Error("expected an open document");
  return current;
};

const parallelAt = (stepId: string): ParallelStep => {
  const step = findEntry(auto(), stepId)?.step;
  if (step?.kind !== "parallel") throw new Error(`${stepId} is not a parallel group`);
  return step;
};

const passedOn =
  "driveBack was the deadline of returnToScore, so clearThenSpinUp is its deadline now. Pick another in the Inspector, or press Ctrl Z to undo.";

beforeEach(() => {
  setFeatures(ALL_FEATURES);
  const example = loadAuto(read("collect-and-score.auto.json"));
  openAuto("collect-and-score.auto.json", example, canonicalize("auto", example));
});

describe("Duplicate step on a deadline group", () => {
  it("selects the copy, whose deadline is its own copy of the deadline member", () => {
    selectStep("returnToScore");
    duplicateSelection();
    expect(getState().selection.stepId).toBe("returnToScoreCopy");
    expect(parallelAt("returnToScoreCopy").deadline).toBe("driveBackCopy");
  });
});

describe("dragging a deadline member out of its group", () => {
  it("passes the group's deadline to the step left in it and says how to pick another", () => {
    moveStepTo("driveBack", "returnToScore", "after");
    expect(parallelAt("returnToScore")).toMatchObject({ mode: "deadline", deadline: "clearThenSpinUp" });
    // The move says where the step went, then what became of the deadline (issue #505).
    expect(getState().status).toMatchObject({ kind: "info", message: `Moved driveBack out of returnToScore. ${passedOn}` });
    undo();
    expect(parallelAt("returnToScore").deadline).toBe("driveBack");
  });

  it("says nothing about deadlines when the member moves inside its own group", () => {
    moveStepTo("driveBack", "clearThenSpinUp", "after");
    expect(parallelAt("returnToScore").deadline).toBe("driveBack");
    // The move is a new edit, so an earlier line goes (issue #411); it says where the step went and nothing of deadlines.
    expect(getState().status?.message).toBe("Moved driveBack after clearThenSpinUp.");
  });
});

describe("switching a group to deadline in the Inspector, then dragging its deadline step out", () => {
  it("keeps a deadline group that names one of its own steps, never one with no deadline", () => {
    // The Inspector's Mode choice is `setParallel` through `tryEdit`.
    tryEdit((current) => setParallel(current, "returnToScore", { mode: "all" }));
    expect("deadline" in parallelAt("returnToScore")).toBe(false);
    tryEdit((current) => setParallel(current, "returnToScore", { mode: "deadline" }));
    expect(parallelAt("returnToScore").deadline).toBe("driveBack");

    moveStepTo("driveBack", "scoreGardenPollen", "after");
    const group = parallelAt("returnToScore");
    expect(group.mode).toBe("deadline");
    expect(group.deadline).toBe("clearThenSpinUp");
    expect(group.steps.map((member) => member.id)).toEqual(["clearThenSpinUp"]);
    expect(getState().status).toMatchObject({ kind: "info", message: `Moved driveBack out of returnToScore. ${passedOn}` });

    undo();
    expect(parallelAt("returnToScore").deadline).toBe("driveBack");
  });
});

describe("deleting a deadline member", () => {
  it("passes the group's deadline to the step left in it and says so", () => {
    selectStep("driveBack");
    deleteSelection();
    expect(findEntry(auto(), "driveBack")).toBeUndefined();
    expect(parallelAt("returnToScore")).toMatchObject({ mode: "deadline", deadline: "clearThenSpinUp" });
    expect(getState().status).toMatchObject({ kind: "info", message: passedOn });
    undo();
    expect(parallelAt("returnToScore").deadline).toBe("driveBack");
  });
});
