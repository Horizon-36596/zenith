import { describe, expect, it } from "vitest";
import { parseTrace, TraceError, traceDurationS, traceRoutineEndS, traceStepDurations, traceSummary } from "./trace.js";

const minimal = {
  formatVersion: 1,
  auto: "first-auto",
  simTimeS: 34,
  tickS: 0.02,
  capabilities: ["ledger"],
  steps: [
    { id: "scorePreload", startS: 0, endS: 2.61, interrupted: false },
    { id: "driveOut", startS: 2.61, endS: 3.2 },
  ],
  poses: [
    [0, -40, -63, 1.5708],
    [0.02, -40, -62.5, 1.5708],
  ],
  ledger: [
    { timeS: 2.61, held: 1, launches: 3, tips: { RED: 0 } },
    { timeS: 3.2, held: 1, launches: 0, tips: { RED: 1 } },
  ],
};

describe("parseTrace", () => {
  it("reads the trace shape site/docs/simulation.md describes", () => {
    const trace = parseTrace(minimal);
    expect(trace.auto).toBe("first-auto");
    expect(trace.steps).toHaveLength(2);
    expect(trace.steps[1]?.interrupted).toBe(false);
    expect(trace.poses[1]).toEqual([0.02, -40, -62.5, 1.5708]);
    expect(trace.sha).toBeNull();
  });

  it("reads a key the sim build does not fill yet as empty", () => {
    const trace = parseTrace(minimal);
    expect(trace.truthPoses).toEqual([]);
    expect(trace.structureContacts).toEqual([]);
    expect(trace.events).toEqual([]);
  });

  it("names the key that is the wrong shape", () => {
    expect(() => parseTrace("not an object")).toThrow(TraceError);
    expect(() => parseTrace({ steps: [] })).toThrow(/poses/);
    expect(() => parseTrace({ poses: [[0, 1]] })).toThrow(/poses\[0\]/);
    expect(() => parseTrace({ poses: [], steps: [{ id: "a" }] })).toThrow(/steps\[0\]/);
    expect(() => parseTrace({ poses: [], events: [{ timeS: 1 }] })).toThrow(/events\[0\]/);
    // JSON's 1e400 parses to Infinity, which would give the run an endless duration.
    expect(() => parseTrace(JSON.parse('{"poses": [], "steps": [{"id": "a", "startS": 0, "endS": 1e400}]}'))).toThrow(
      /steps\[0\]/,
    );
    expect(() => parseTrace({ poses: [], steps: [{ id: "a", startS: Number.NaN, endS: 1 }] })).toThrow(/steps\[0\]/);
    expect(() => parseTrace({ poses: [], steps: [{ id: "a", startS: 2, endS: 1 }] })).toThrow(/steps\[0\]/);
  });
});

describe("what a trace says about a run", () => {
  it("runs as long as its last recorded moment", () => {
    expect(traceDurationS(parseTrace(minimal))).toBeCloseTo(3.2, 6);
  });

  it("runs to the latest step end, not the last step written", () => {
    // `AutoTrace` writes steps in start order: a parallel group, then its children, the last of
    // which ends long before the group does. Without poses only the steps say how long it ran.
    const trace = parseTrace({
      poses: [],
      steps: [
        { id: "group", startS: 0, endS: 10 },
        { id: "long", startS: 0, endS: 10 },
        { id: "short", startS: 0, endS: 1 },
      ],
    });
    expect(traceDurationS(trace)).toBe(10);
  });

  it("ends the routine at its last step's end, not at the end of a longer recording", () => {
    // A sim runs the OpMode for the 30 s period and a 2 s margin, so the robot stands still in the
    // recording for long after a 4.86 s routine has ended.
    const trace = parseTrace({
      ...minimal,
      steps: [
        { id: "group", startS: 0, endS: 4.86 },
        { id: "long", startS: 0, endS: 4.86 },
        { id: "short", startS: 0, endS: 1 },
      ],
      poses: [
        [0, -40, -63, 1.5708],
        [31.98, -20, -40, 1.5708],
      ],
    });
    expect(traceDurationS(trace)).toBeCloseTo(31.98, 6);
    expect(traceRoutineEndS(trace)).toBeCloseTo(4.86, 6);
    expect(traceSummary(trace).totalS).toBeCloseTo(4.86, 6);
  });

  it("ends the routine at the end of the recording when it records no steps", () => {
    const trace = parseTrace({ ...minimal, steps: [] });
    expect(traceRoutineEndS(trace)).toBeCloseTo(0.02, 6);
  });

  it("gives each step's actual duration by id", () => {
    const durations = traceStepDurations(parseTrace(minimal));
    expect(durations.get("scorePreload")).toBeCloseTo(2.61, 6);
  });

  it("totals the run, and says which of its numbers this sim build does not measure", () => {
    const summary = traceSummary(parseTrace(minimal));
    expect(summary.launches).toBe(3);
    expect(summary.tips).toEqual({ RED: 1 });
    expect(summary.heldAtEnd).toBe(1);
    expect(summary.structureContacts).toBe(0);
    expect(summary.inert).toEqual(["structureContacts"]);
  });
});
