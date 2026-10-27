/**
 * The wait step's Wait for switch (issue #144): a wait waits for a time or for a condition, so a
 * switch replaces one with the other, as one undo step, and the status line says how to undo it.
 * Typing seconds used to drop a condition without a word.
 */
import { canonicalize, loadAuto } from "@horizon36596/zenith-core";
import { SCHEMA_ID, type WaitStep } from "@horizon36596/zenith-schema";
import { beforeEach, describe, expect, it } from "vitest";
import { writeSpeed } from "./edits";
import { waitForCondition, waitForTime, WAIT_TIME_START_S } from "./waitEdits";
import { getState, openAuto, undo } from "../state/store";

const fixture = () =>
  loadAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 1,
    name: "wait-fixture",
    title: "Wait fixture",
    alliance: "RED",
    start: { pose: { xIn: 0, yIn: 0, headingRad: 0 } },
    steps: [
      {
        id: "leg1",
        kind: "path",
        segments: [{ kind: "line", from: "current", to: { xIn: 0, yIn: 24, headingRad: 0 } }],
        heading: { mode: "tangent" },
        speedFraction: 0.3,
      },
      { id: "full", kind: "wait", until: "hopperFull", timeoutS: 1 },
      { id: "open", kind: "wait", until: "hopperFull" },
      { id: "sit", kind: "wait", seconds: 0.25 },
    ],
  });

beforeEach(() => {
  openAuto("wait-fixture.auto.json", fixture(), canonicalize("auto", fixture()));
});

const wait = (id: string): WaitStep => {
  const step = getState().auto?.steps.find((candidate) => candidate.id === id);
  if (step?.kind !== "wait") throw new Error(`${id} is not a wait`);
  return step;
};

describe("waitForTime", () => {
  it("starts the time at the step's timeout, drops the condition, and says how to undo it", () => {
    waitForTime("full");
    expect(wait("full")).toEqual({ id: "full", kind: "wait", seconds: 1, timeoutS: 1 });
    expect(getState().status?.message).toBe("full now waits 1.00 s instead of until hopperFull. Ctrl Z puts the condition back.");
    undo();
    expect(wait("full")).toEqual({ id: "full", kind: "wait", until: "hopperFull", timeoutS: 1 });
  });

  it("starts at half a second when the step has no timeout", () => {
    waitForTime("open");
    expect(wait("open").seconds).toBe(WAIT_TIME_START_S);
    expect(WAIT_TIME_START_S).toBe(0.5);
  });

  it("leaves a wait that already waits for a time alone", () => {
    const before = getState().auto;
    waitForTime("sit");
    expect(getState().auto).toBe(before);
  });
});

describe("waitForCondition", () => {
  it("waits for the condition it is given instead of the time, and says how to undo it", () => {
    waitForCondition("sit", "holdingPiece");
    expect(wait("sit")).toEqual({ id: "sit", kind: "wait", until: "holdingPiece" });
    expect(getState().status?.message).toBe("sit now waits until holdingPiece instead of 0.25 s. Ctrl Z puts the time back.");
    undo();
    expect(wait("sit")).toEqual({ id: "sit", kind: "wait", seconds: 0.25 });
  });

  it("writes nothing and says why when robot.json declares no condition", () => {
    const before = getState().auto;
    waitForCondition("sit", undefined);
    expect(getState().auto).toBe(before);
    expect(getState().status?.kind).toBe("error");
    expect(getState().status?.message).toContain("robot.json declares no conditions");
  });
});

describe("writeSpeed", () => {
  it("removes a path's own speed with null, so it follows the robot's default again", () => {
    writeSpeed("leg1", null);
    const auto = getState().auto;
    if (auto === null) throw new Error("expected an open document");
    const step = auto.steps.find((candidate) => candidate.id === "leg1");
    expect(step !== undefined && "speedFraction" in step).toBe(false);
    expect(canonicalize("auto", auto)).not.toContain("speedFraction");
  });
});
