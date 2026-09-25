/**
 * Inserting in the middle of a routine, and grouping (site/docs/editor.md): a new
 * step lands right after the selected one, a new path starts where that step ends, the step after
 * it is offered a "Connect" when it now starts somewhere else, and wrap and unwrap undo each other.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalize, loadAuto, loadField, loadRobot } from "@horizon36596/zenith-core";
import type { Auto, Step } from "@horizon36596/zenith-schema";
import { SCHEMA_ID } from "@horizon36596/zenith-schema";
import { beforeEach, describe, expect, it } from "vitest";
import { continuityGapIn } from "../lib/structure";
import {
  currentDerived,
  getState,
  openAuto,
  selectStep,
  setAutoOverrides,
  toggleMultiStep,
} from "../state/store";
import {
  addPathStep,
  addSequenceStep,
  addWaitStep,
  connectStep,
  moveStepTo,
  unwrapSelection,
  wrapSelection,
} from "./edits";

const examples = fileURLToPath(new URL("../../../../examples/starter/autos/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${examples}${relative}`, "utf8"));

const fixture = (): Auto =>
  loadAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 1,
    name: "insert-fixture",
    title: "Insert fixture",
    alliance: "RED",
    start: { pose: { xIn: 0, yIn: 0, headingRad: 0 } },
    steps: [
      {
        id: "leg1",
        kind: "path",
        segments: [{ kind: "line", from: "current", to: { xIn: 24, yIn: 0, headingRad: 0 } }],
        heading: { mode: "tangent" },
      },
      {
        id: "leg2",
        kind: "path",
        segments: [{ kind: "line", from: "current", to: { xIn: 48, yIn: 0, headingRad: 0 } }],
        heading: { mode: "tangent" },
      },
      {
        id: "leg3",
        kind: "path",
        segments: [
          {
            kind: "line",
            from: { xIn: 48, yIn: 0, headingRad: 0 },
            to: { xIn: 72, yIn: 0, headingRad: 0 },
          },
        ],
        heading: { mode: "tangent" },
      },
    ],
  });

const ids = (steps: readonly Step[] | undefined): string[] =>
  (steps ?? []).map((step) => step.id ?? "");

const auto = (): Auto => {
  const open = getState().auto;
  if (open === null) throw new Error("expected an open document");
  return open;
};

beforeEach(() => {
  openAuto("insert-fixture.auto.json", fixture(), canonicalize("auto", fixture()));
  setAutoOverrides(loadRobot(read("robot.json")), loadField(read("field/biobuzz.field.json")));
});

describe("insert in the middle", () => {
  it("puts a new step right after the selected one and selects it", () => {
    selectStep("leg1");
    const id = addWaitStep();
    expect(id).not.toBeNull();
    expect(ids(auto().steps)).toEqual(["leg1", id, "leg2", "leg3"]);
    expect(getState().selection.stepId).toBe(id);
  });

  it("adds to the end when nothing is selected", () => {
    selectStep(undefined);
    const id = addWaitStep();
    expect(ids(auto().steps)).toEqual(["leg1", "leg2", "leg3", id]);
  });

  it("starts a new path where the selected step ends", () => {
    selectStep("leg1");
    const id = addPathStep();
    const step = auto().steps.find((candidate) => candidate.id === id);
    expect(step?.kind === "path" && step.segments[0]?.from).toBe("current");
    const resolved = currentDerived().resolved?.steps.find((candidate) => candidate.id === id);
    expect(resolved?.startPose.xIn).toBeCloseTo(24);
    expect(resolved?.startPose.yIn).toBeCloseTo(0);
  });

  it("leaves no gap when the next step already starts where the robot is", () => {
    selectStep("leg1");
    addPathStep();
    expect(continuityGapIn(currentDerived().resolved, "leg2")).toBeNull();
  });

  it("offers Connect for a next step with a fixed start, and Connect closes the gap", () => {
    expect(continuityGapIn(currentDerived().resolved, "leg3")).toBeNull();
    selectStep("leg2");
    addPathStep();
    const gap = continuityGapIn(currentDerived().resolved, "leg3");
    expect(gap).not.toBeNull();
    expect(gap ?? 0).toBeGreaterThan(0);

    connectStep("leg3");
    expect(continuityGapIn(currentDerived().resolved, "leg3")).toBeNull();
  });

  it("adds a sequence holding one path after the selected step", () => {
    selectStep("leg2");
    const id = addSequenceStep();
    const steps = auto().steps;
    expect(ids(steps)).toEqual(["leg1", "leg2", id, "leg3"]);
    const group = steps[2];
    expect(group?.kind).toBe("sequence");
    expect(group?.kind === "sequence" && group.steps[0]?.kind).toBe("path");
  });
});

describe("wrap and unwrap", () => {
  it("wraps the selected steps in a sequence, and unwrap puts them back", () => {
    selectStep("leg1");
    toggleMultiStep("leg2");
    wrapSelection("sequence");
    const wrapped = auto().steps;
    expect(wrapped).toHaveLength(2);
    const group = wrapped[0];
    expect(group?.kind).toBe("sequence");
    expect(group?.kind === "sequence" && ids(group.steps)).toEqual(["leg1", "leg2"]);
    expect(getState().selection.stepId).toBe(group?.id);

    unwrapSelection();
    expect(ids(auto().steps)).toEqual(["leg1", "leg2", "leg3"]);
  });

  it("wraps one step in a parallel group", () => {
    selectStep("leg3");
    wrapSelection("parallel");
    const group = auto().steps[2];
    expect(group?.kind).toBe("parallel");
    expect(group?.kind === "parallel" && ids(group.steps)).toEqual(["leg3"]);
  });
});

describe("dragging steps into and out of groups", () => {
  it("drops a step into a group and back out after it", () => {
    selectStep("leg3");
    wrapSelection("sequence");
    const groupId = auto().steps[2]?.id ?? "";

    moveStepTo("leg1", groupId, "into");
    const inside = auto().steps.find((step) => step.id === groupId);
    expect(inside?.kind === "sequence" && ids(inside.steps)).toEqual(["leg1", "leg3"]);
    expect(ids(auto().steps)).toEqual(["leg2", groupId]);

    moveStepTo("leg1", groupId, "after");
    expect(ids(auto().steps)).toEqual(["leg2", groupId, "leg1"]);
  });

  it("refuses to move a group inside itself and leaves the document alone", () => {
    selectStep("leg3");
    wrapSelection("sequence");
    const before = auto();
    const groupId = before.steps[2]?.id ?? "";
    moveStepTo(groupId, "leg3", "before");
    expect(auto()).toBe(before);
  });
});
