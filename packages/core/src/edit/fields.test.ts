import { describe, expect, it } from "vitest";
import { EditError } from "./errors.js";
import {
  setBranchCondition,
  setCommandName,
  setEndCondition,
  setMarkerCommand,
  setNotes,
  setParallel,
  setSegmentKind,
  setSegmentSource,
  setWait,
} from "./fields.js";
import { canonicalRoundTrip, testAuto } from "./testing.js";
import { addStep } from "./steps.js";

const firstSegment = (auto: ReturnType<typeof testAuto>, stepId: string) => {
  const step = auto.steps.find((candidate) => candidate.id === stepId);
  if (step === undefined || step.kind !== "path") throw new Error("not a path step");
  return step.segments[0];
};

describe("setSegmentSource", () => {
  it("points an endpoint at a waypoint", () => {
    const auto = setSegmentSource(testAuto(), "leg1", 0, "to", { ref: "shootNorth" });
    expect(firstSegment(auto, "leg1")?.to).toEqual({ ref: "shootNorth" });
    expect(canonicalRoundTrip(auto)).toContain("shootNorth");
  });

  it('points an endpoint at "current"', () => {
    const auto = setSegmentSource(testAuto(), "leg1", 0, "to", "current");
    expect(firstSegment(auto, "leg1")?.to).toBe("current");
  });

  it("names the step or the segment that is not there", () => {
    expect(() => setSegmentSource(testAuto(), "nope", 0, "to", "current")).toThrow(EditError);
    expect(() => setSegmentSource(testAuto(), "leg1", 7, "to", "current")).toThrow(/segment/);
    expect(() => setSegmentSource(testAuto(), "shoot", 0, "to", "current")).toThrow(/not a path/);
  });

  it("does not mutate the auto it was given", () => {
    const before = testAuto();
    const snapshot = canonicalRoundTrip(before);
    setSegmentSource(before, "leg1", 0, "to", { ref: "shootNorth" });
    expect(canonicalRoundTrip(before)).toBe(snapshot);
  });
});

describe("setSegmentKind", () => {
  it("turns a line into a Bezier through the control point it is handed", () => {
    const auto = setSegmentKind(testAuto(), "leg1", 0, "bezier", { xIn: 3, yIn: 12 });
    const segment = firstSegment(auto, "leg1");
    expect(segment?.kind).toBe("bezier");
    expect(segment?.kind === "bezier" ? segment.control : []).toEqual([{ xIn: 3, yIn: 12 }]);
  });

  it("turns it back into a line, dropping the control points", () => {
    const curved = setSegmentKind(testAuto(), "leg1", 0, "bezier", { xIn: 3, yIn: 12 });
    const straight = setSegmentKind(curved, "leg1", 0, "line", { xIn: 0, yIn: 0 });
    expect(firstSegment(straight, "leg1")?.kind).toBe("line");
  });
});

describe("the one-field edits", () => {
  it("sets and clears an end condition", () => {
    const set = setEndCondition(testAuto(), "leg1", "hopperFull");
    const step = set.steps.find((candidate) => candidate.id === "leg1");
    expect(step?.kind === "path" ? step.endCondition : null).toEqual({ condition: "hopperFull" });
    const cleared = setEndCondition(set, "leg1", null);
    const after = cleared.steps.find((candidate) => candidate.id === "leg1");
    expect(after?.kind === "path" ? after.endCondition : "gone").toBeUndefined();
  });

  it("sets a note and removes it when the text is blank", () => {
    const noted = setNotes(testAuto(), "shoot", "Fires the preload.");
    expect(noted.steps.find((step) => step.id === "shoot")?.notes).toBe("Fires the preload.");
    expect(setNotes(noted, "shoot", "   ").steps.find((step) => step.id === "shoot")?.notes).toBeUndefined();
  });

  it("sets what a wait waits for", () => {
    const withWait = addStep(testAuto(), { id: "pause", kind: "wait", seconds: 0.5 });
    const set = setWait(withWait, "pause", { until: "hopperFull" });
    const step = set.steps.find((candidate) => candidate.id === "pause");
    expect(step?.kind === "wait" ? step.until : null).toBe("hopperFull");
    expect(step?.kind === "wait" ? step.seconds : null).toBeUndefined();
    expect(() => setWait(withWait, "shoot", { seconds: 1 })).toThrow(/not a wait/);
  });

  it("sets a parallel group's mode and deadline", () => {
    const auto = setParallel(testAuto(), "park", { mode: "race" });
    const step = auto.steps.find((candidate) => candidate.id === "park");
    expect(step?.kind === "parallel" ? step.mode : null).toBe("race");
  });

  it("sets a branch condition, and refuses a step that is not a branch", () => {
    expect(() => setBranchCondition(testAuto(), "park", "haveBall")).toThrow(/not a branch/);
  });

  it("drops the arguments when a command step changes command", () => {
    const auto = setCommandName(testAuto(), "shoot", "launcherIdle");
    const step = auto.steps.find((candidate) => candidate.id === "shoot");
    expect(step?.kind === "command" ? step.name : null).toBe("launcherIdle");
    expect(step?.kind === "command" ? step.args : "kept").toBeUndefined();
  });

  it("replaces a marker's command and keeps where it sits", () => {
    const auto = setMarkerCommand(testAuto(), "leg1", 0, { name: "intakeOn" });
    const step = auto.steps.find((candidate) => candidate.id === "leg1");
    const marker = step?.kind === "path" ? step.markers?.[0] : undefined;
    expect(marker?.command.name).toBe("intakeOn");
    expect(marker?.at).toEqual({ t: 0.5 });
    expect(() => setMarkerCommand(testAuto(), "leg1", 4, { name: "intakeOn" })).toThrow(/marker/);
  });
});
