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
  setTransfer,
  setWait,
} from "./fields.js";
import { canonicalRoundTrip, testAuto } from "./testing.js";
import { addStep } from "./steps.js";
import { finish } from "./finish.js";

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

  it("keeps the provenance the caller gives the control point", () => {
    const auto = setSegmentKind(testAuto(), "leg1", 0, "bezier", { xIn: 3, yIn: 12, provenance: "SET FROM EDITOR" });
    const segment = firstSegment(auto, "leg1");
    expect(segment?.kind === "bezier" ? segment.control : []).toEqual([
      { xIn: 3, yIn: 12, provenance: "SET FROM EDITOR" },
    ]);
  });

  it("turns a curve into a line without a control point, and refuses a curve without one", () => {
    const curved = setSegmentKind(testAuto(), "leg1", 0, "bezier", { xIn: 3, yIn: 12 });
    expect(firstSegment(setSegmentKind(curved, "leg1", 0, "line"), "leg1")?.kind).toBe("line");
    expect(() => setSegmentKind(testAuto(), "leg1", 0, "bezier")).toThrow(EditError);
    expect(() => setSegmentKind(testAuto(), "leg1", 0, "bezier")).toThrow(/needs a control point/);
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

describe("setTransfer", () => {
  const withTransfer = () =>
    addStep(testAuto(), {
      id: "partnerScores",
      kind: "transfer",
      from: "partner",
      to: "hiveRedUpCell",
      expectedCount: 3,
    });
  const transferOf = (auto: ReturnType<typeof testAuto>) => {
    const step = auto.steps.find((candidate) => candidate.id === "partnerScores");
    if (step?.kind !== "transfer") throw new Error("not a transfer step");
    return step;
  };

  it("sets an actual count apart from the expected one, and clears it again", () => {
    const failed = setTransfer(withTransfer(), "partnerScores", { actualCount: 0 });
    expect(transferOf(failed)).toMatchObject({ expectedCount: 3, actualCount: 0 });
    expect(canonicalRoundTrip(failed)).toContain('"actualCount": 0');
    const cleared = setTransfer(failed, "partnerScores", { actualCount: null });
    expect("actualCount" in transferOf(cleared)).toBe(false);
  });

  it("drops an actual count equal to the expected one, so the file carries no edge case", () => {
    const same = setTransfer(withTransfer(), "partnerScores", { actualCount: 3 });
    expect("actualCount" in transferOf(same)).toBe(false);
  });

  it("changes the places and the expected count, and refuses a count that is not whole", () => {
    const moved = setTransfer(withTransfer(), "partnerScores", { from: "offField", to: "loadingZoneRed", expectedCount: 2 });
    expect(transferOf(moved)).toMatchObject({ from: "offField", to: "loadingZoneRed", expectedCount: 2 });
    expect(() => setTransfer(withTransfer(), "partnerScores", { expectedCount: -1 })).toThrow(EditError);
    expect(() => setTransfer(withTransfer(), "partnerScores", { actualCount: 1.5 })).toThrow(EditError);
  });

  it("refuses a step that is not a transfer", () => {
    expect(() => setTransfer(testAuto(), "leg1", { expectedCount: 1 })).toThrow(/not a transfer/);
  });
});

describe("setParallel", () => {
  /** A group that runs all of its members, the first a command and the second a path with no id. */
  const withGroup = () =>
    finish({
      ...testAuto(),
      steps: [
        ...testAuto().steps,
        {
          id: "grp",
          kind: "parallel",
          mode: "all",
          steps: [
            { kind: "command", name: "launcherIdle" },
            {
              kind: "path",
              segments: [{ kind: "line", from: "current", to: { xIn: 24, yIn: 24, headingRad: 0 } }],
              heading: { mode: "tangent" },
            },
          ],
        },
      ],
    });
  const groupOf = (auto: ReturnType<typeof testAuto>, id: string) => {
    const step = auto.steps.find((candidate) => candidate.id === id);
    if (step?.kind !== "parallel") throw new Error("not a parallel group");
    return step;
  };

  it("all to deadline picks the first member that drives, and names it when it has no id", () => {
    const auto = setParallel(withGroup(), "grp", { mode: "deadline" });
    const group = groupOf(auto, "grp");
    expect(group.mode).toBe("deadline");
    // The id it went by, grp.2, with the dot a step's id cannot hold taken out.
    expect(group.deadline).toBe("grp2");
    expect(group.steps[1]?.id).toBe("grp2");
    expect(group.steps[0]?.id).toBeUndefined();
    expect(canonicalRoundTrip(auto)).toContain('"deadline": "grp2"');
  });

  it("deadline to all or race removes the deadline key", () => {
    for (const mode of ["all", "race"] as const) {
      const auto = setParallel(testAuto(), "park", { mode });
      const group = groupOf(auto, "park");
      expect(group.mode).toBe(mode);
      expect("deadline" in group).toBe(false);
      expect(canonicalRoundTrip(auto)).not.toContain('"deadline"');
    }
  });

  it("keeps a deadline group's own deadline when it is set to deadline again", () => {
    const named = setParallel(testAuto(), "park", { deadline: "spinDown" });
    expect(groupOf(setParallel(named, "park", { mode: "deadline" }), "park").deadline).toBe("spinDown");
  });

  it("moves the deadline to another of the group's own steps", () => {
    expect(groupOf(setParallel(testAuto(), "park", { deadline: "spinDown" }), "park").deadline).toBe("spinDown");
  });

  it("refuses an empty deadline in plain words, not the schema's", () => {
    expect(() => setParallel(testAuto(), "park", { deadline: "" })).toThrow(EditError);
    expect(() => setParallel(testAuto(), "park", { deadline: "" })).toThrow(
      'A deadline group ends when one of its own steps ends, so its deadline has to name one: "drive" or "spinDown".',
    );
    expect(() => setParallel(testAuto(), "park", { deadline: "" })).not.toThrow(/String must contain/);
  });

  it("refuses a deadline outside the group", () => {
    expect(() => setParallel(testAuto(), "park", { deadline: "leg1" })).toThrow(
      '"leg1" is not one of this group\'s own steps; its deadline has to name one: "drive" or "spinDown".',
    );
  });

  it("refuses a deadline for a group that does not run until one", () => {
    expect(() => setParallel(withGroup(), "grp", { deadline: "grp.2" })).toThrow(
      /only a group in deadline mode has a deadline/,
    );
  });
});

describe("setWait", () => {
  const withWait = () => addStep(testAuto(), { id: "pause", kind: "wait", seconds: 0.5 });

  it("refuses both a time and a condition, and neither, in plain words", () => {
    expect(() => setWait(withWait(), "pause", { seconds: 1, until: "hopperFull" })).toThrow(EditError);
    expect(() => setWait(withWait(), "pause", { seconds: 1, until: "hopperFull" })).toThrow(
      "A wait waits for a number of seconds or for a condition, not both.",
    );
    expect(() => setWait(withWait(), "pause", {})).toThrow(
      "A wait needs a number of seconds or a condition to wait for.",
    );
  });

  it("swaps a condition for a time and back, keeping the timeout", () => {
    const waiting = addStep(testAuto(), { id: "pause", kind: "wait", until: "hopperFull", timeoutS: 1 });
    const timed = setWait(waiting, "pause", { seconds: 1 });
    const step = timed.steps.find((candidate) => candidate.id === "pause");
    expect(step).toMatchObject({ kind: "wait", seconds: 1, timeoutS: 1 });
    expect(step !== undefined && "until" in step).toBe(false);
    const back = setWait(timed, "pause", { until: "hopperFull" }).steps.find((candidate) => candidate.id === "pause");
    expect(back).toMatchObject({ kind: "wait", until: "hopperFull", timeoutS: 1 });
    expect(back !== undefined && "seconds" in back).toBe(false);
  });
});
