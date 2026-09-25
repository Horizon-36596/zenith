import { plan as corePlan, resolve } from "@horizon36596/zenith-core";
import { parseAuto, parseField, parseRobot, parseWaypoints, SCHEMA_ID } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { buildSimReport, parseTrace, TraceParseError, type TraceFile } from "./traceReport.js";
import { TEST_FIELD, TEST_ROBOT, TEST_WAYPOINTS } from "./testSupport.js";

const robot = parseRobot(TEST_ROBOT);
const field = parseField(TEST_FIELD);
const waypoints = parseWaypoints(TEST_WAYPOINTS);
const auto = parseAuto({
  $schema: SCHEMA_ID.auto,
  formatVersion: 1,
  name: "drive-and-shoot",
  alliance: "RED",
  start: { pose: { ref: "start" } },
  steps: [
    {
      id: "drive",
      kind: "path",
      segments: [{ kind: "line", from: { ref: "start" }, to: { ref: "shoot" } }],
      heading: { mode: "tangent" },
    },
    { id: "shoot1", kind: "command", name: "shootAll", args: { count: 3 } },
  ],
});
const plan = corePlan(resolve(auto, waypoints), robot, field);
const startPose = plan.startPose;
const endPose = plan.steps[0]!.endPose!;

describe("parseTrace", () => {
  it("parses a minimal well-formed trace", () => {
    const trace = parseTrace({
      formatVersion: 1,
      auto: "drive-and-shoot",
      simTimeS: 5,
      tickS: 0.02,
      capabilities: ["steps", "poses"],
      steps: [{ id: "drive", startS: 0, endS: 2, interrupted: false }],
      poses: [[0, startPose.xIn, startPose.yIn, startPose.headingRad]],
      structureContacts: [],
      ledger: [],
      events: [],
    });
    expect(trace.auto).toBe("drive-and-shoot");
    expect(trace.steps).toHaveLength(1);
  });

  it("throws TraceParseError when required fields are missing", () => {
    expect(() => parseTrace({})).toThrow(TraceParseError);
    expect(() => parseTrace("not an object")).toThrow(TraceParseError);
  });

  it("fills in defaults for capabilities, truthPoses, structureContacts, ledger and events", () => {
    const trace = parseTrace({ auto: "x", steps: [], poses: [] });
    expect(trace.capabilities).toEqual([]);
    expect(trace.truthPoses).toEqual([]);
    expect(trace.structureContacts).toEqual([]);
  });
});

describe("buildSimReport", () => {
  const baseTrace = (overrides: Partial<TraceFile> = {}): TraceFile => ({
    formatVersion: 1,
    auto: "drive-and-shoot",
    simTimeS: 3,
    tickS: 0.02,
    capabilities: ["steps", "poses"],
    steps: [
      { id: "drive", startS: 0, endS: 2, interrupted: false },
      { id: "shoot1", startS: 2, endS: 2.6, interrupted: false },
    ],
    poses: [
      [0, startPose.xIn, startPose.yIn, startPose.headingRad],
      [1, (startPose.xIn + endPose.xIn) / 2, (startPose.yIn + endPose.yIn) / 2, startPose.headingRad],
      [2, endPose.xIn, endPose.yIn, endPose.headingRad],
    ],
    truthPoses: [],
    structureContacts: [],
    ledger: [{ timeS: 2.6, held: 1, launches: 3, tips: { RED: 0 } }],
    events: [],
    ...overrides,
  });

  it("pairs each trace step with the plan and reports near-zero cross-track error for on-path poses", () => {
    const report = buildSimReport(baseTrace(), plan, null);
    const driveStep = report.steps.find((step) => step.id === "drive");
    expect(driveStep).toBeDefined();
    expect(driveStep?.actualS).toBeCloseTo(2, 5);
    expect(driveStep?.maxCrossTrackIn).not.toBeNull();
    expect(driveStep?.maxCrossTrackIn ?? Infinity).toBeLessThan(1);
  });

  it("reports a large cross-track error for a pose far from the plan", () => {
    const trace = baseTrace({
      poses: [
        [0, startPose.xIn, startPose.yIn, startPose.headingRad],
        [1, startPose.xIn + 500, startPose.yIn + 500, startPose.headingRad],
        [2, endPose.xIn, endPose.yIn, endPose.headingRad],
      ],
    });
    const report = buildSimReport(trace, plan, null);
    const driveStep = report.steps.find((step) => step.id === "drive");
    expect(driveStep?.maxCrossTrackIn ?? 0).toBeGreaterThan(100);
  });

  it("reads launches, tips and held-at-end from the ledger rows", () => {
    const report = buildSimReport(baseTrace(), plan, null);
    expect(report.launches).toBe(3);
    expect(report.tips.RED).toBe(0);
    expect(report.heldAtEnd).toBe(1);
  });

  it("lists structureContacts and ledger as inert when the trace's capabilities omit them", () => {
    const report = buildSimReport(baseTrace({ capabilities: ["steps", "poses"] }), plan, null);
    expect(report.inert).toContain("structureContacts");
    expect(report.inert).toContain("ledger");
  });

  it("leaves estimateNominalS and deltaS null when no estimate is available", () => {
    const report = buildSimReport(baseTrace(), plan, null);
    for (const step of report.steps) {
      expect(step.estimateNominalS).toBeNull();
      expect(step.deltaS).toBeNull();
    }
  });
});
