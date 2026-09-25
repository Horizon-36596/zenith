import { describe, expect, it } from "vitest";
import { parseTrace, TraceError, traceDurationS, traceStepDurations, traceSummary } from "./trace.js";

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
  });
});

describe("what a trace says about a run", () => {
  it("runs as long as its last recorded moment", () => {
    expect(traceDurationS(parseTrace(minimal))).toBeCloseTo(3.2, 6);
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
