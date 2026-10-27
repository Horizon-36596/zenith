/**
 * The steps running at the playhead (issue #111): the leaf step, every group it sits in, and every
 * branch of a parallel group that is still running, read from the level's own timing.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadAuto, loadField, loadRobot, loadWaypoints, type IdealTrajectory, type Trace } from "@horizon36596/zenith-core";
import { describe, expect, it } from "vitest";
import { derive } from "../state/derived";
import { idealFor } from "../state/playback";
import { runSim } from "../state/sim";
import { activeKey, activeStepIds, fromActiveKey, stepStartS, type ActiveStepSources } from "./activeSteps";
import { indexSteps } from "./stepOps";

const examples = fileURLToPath(new URL("../../../../examples/starter/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${examples}${relative}`, "utf8"));

const robot = loadRobot(read("autos/robot.json"));
const field = loadField(read("autos/field/biobuzz.field.json"));
const waypoints = loadWaypoints(read("autos/waypoints.json"));

/**
 * collect-and-score has `returnToScore` near its end, a deadline parallel group of the path `driveBack` and
 * the sequence `clearThenSpinUp` (the wait `clearGarden`, then the command `readyLauncher`).
 */
const auto = loadAuto(read("autos/collect-and-score.auto.json"));
const parentOf = new Map(indexSteps(auto).map((entry) => [entry.id, entry.parentId]));
const derived = derive(auto, robot, field, waypoints);
const ideal = idealFor(derived.plan, derived.estimate);

const sources = (level: ActiveStepSources["level"], extra: Partial<ActiveStepSources> = {}): ActiveStepSources => ({
  level,
  ideal,
  instant: null,
  full: null,
  parentOf,
  ...extra,
});

const sorted = (ids: ReadonlySet<string>): string[] => [...ids].sort();

describe("the steps running at the playhead", () => {
  it("is nothing before the playhead is placed", () => {
    expect(activeStepIds(null, sources("ideal")).size).toBe(0);
  });

  it("at Ideal, is the one top-level step a plain step runs in", () => {
    const span = ideal?.spans.find((candidate) => candidate.stepId === "toGarden");
    expect(span).toBeDefined();
    if (span === undefined) return;
    expect(sorted(activeStepIds((span.startS + span.endS) / 2, sources("ideal")))).toEqual(["toGarden"]);
  });

  it("at Ideal, is a nested step with its sequence, its parallel group and the parallel's other branch", () => {
    const wait = ideal?.spans.find((candidate) => candidate.stepId === "clearGarden");
    expect(wait).toBeDefined();
    if (wait === undefined) return;
    const atS = (wait.startS + wait.endS) / 2;
    expect(sorted(activeStepIds(atS, sources("ideal")))).toEqual(
      ["clearGarden", "clearThenSpinUp", "driveBack", "returnToScore"].sort(),
    );
  });

  it("hands over at a step's end: the next step runs, the one before does not", () => {
    const first = ideal?.spans.find((candidate) => candidate.stepId === "driveOut");
    if (first === undefined) throw new Error("no span for driveOut");
    const at = activeStepIds(first.endS, sources("ideal"));
    expect(at.has("driveOut")).toBe(false);
    expect(at.has("shootPreloads")).toBe(true);
  });

  it("is nothing once the routine has ended", () => {
    expect(activeStepIds((ideal?.totalS ?? 0) + 1, sources("ideal")).size).toBe(0);
  });

  it("at Instant sim, reads the instant sim's own clock, nested steps and groups included", () => {
    if (derived.plan === null) throw new Error("the example did not plan");
    const trace = runSim(derived.plan, robot, field).run?.trace ?? null;
    expect(trace).not.toBeNull();
    if (trace === null) return;
    const drive = trace.steps.find((step) => step.id === "driveBack");
    expect(drive).toBeDefined();
    if (drive === undefined) return;
    const atS = drive.startS + 0.01;
    const running = activeStepIds(atS, sources("instant", { instant: trace }));
    expect(running.has("driveBack")).toBe(true);
    expect(running.has("returnToScore")).toBe(true);
    expect(running.has("clearThenSpinUp")).toBe(true);
    // The level decides the source: without an instant sim run, Instant sim has nothing running.
    expect(activeStepIds(atS, sources("instant", { instant: null })).size).toBe(0);
  });

  it("at Full sim, adds the groups a trace that records only the leaves leaves out", () => {
    const full = { steps: [{ id: "readyLauncher", startS: 10, endS: 12, interrupted: false }] } as unknown as Trace;
    expect(sorted(activeStepIds(11, sources("full", { full })))).toEqual(
      ["clearThenSpinUp", "readyLauncher", "returnToScore"].sort(),
    );
    expect(activeStepIds(11, sources("full", { full: null })).size).toBe(0);
  });

  it("counts every running member of a parallel group, from hand-made spans", () => {
    const spans: IdealTrajectory["spans"] = [
      { stepId: "returnToScore", startS: 0, endS: 4, transitionS: 0 },
      { stepId: "driveBack", startS: 0, endS: 4, transitionS: 0 },
      { stepId: "clearGarden", startS: 0, endS: 1, transitionS: 0 },
      { stepId: "readyLauncher", startS: 1, endS: 3, transitionS: 0 },
      { stepId: "clearThenSpinUp", startS: 0, endS: 3, transitionS: 0 },
    ];
    const handMade = { ...(ideal as IdealTrajectory), spans };
    expect(sorted(activeStepIds(2, sources("ideal", { ideal: handMade })))).toEqual(
      ["clearThenSpinUp", "driveBack", "readyLauncher", "returnToScore"].sort(),
    );
    // After the sequence ends, only the deadline branch and its group still run.
    expect(sorted(activeStepIds(3.5, sources("ideal", { ideal: handMade })))).toEqual(["driveBack", "returnToScore"]);
  });
});

describe("where Play from here starts a step (issue #141)", () => {
  it("at Ideal, is the nested step's own span start, and a group starts with its span", () => {
    const wait = ideal?.spans.find((candidate) => candidate.stepId === "clearGarden");
    const group = ideal?.spans.find((candidate) => candidate.stepId === "returnToScore");
    if (wait === undefined || group === undefined) throw new Error("no ideal spans for the nested steps");
    expect(stepStartS("clearGarden", sources("ideal"))).toBe(wait.startS);
    expect(stepStartS("returnToScore", sources("ideal"))).toBe(group.startS);
    // Playing from there lights the step up: the start is inside the step, not the one before it.
    expect(activeStepIds(wait.startS, sources("ideal")).has("clearGarden")).toBe(true);
  });

  it("at Instant sim, is the instant sim's own start for the nested step", () => {
    if (derived.plan === null) throw new Error("the example did not plan");
    const trace = runSim(derived.plan, robot, field).run?.trace ?? null;
    if (trace === null) throw new Error("the instant sim did not run");
    const wait = trace.steps.find((step) => step.id === "clearGarden");
    if (wait === undefined) throw new Error("the instant sim did not reach clearGarden");
    expect(stepStartS("clearGarden", sources("instant", { instant: trace }))).toBe(wait.startS);
    expect(activeStepIds(wait.startS, sources("instant", { instant: trace })).has("clearGarden")).toBe(true);
    // The level decides the source: without an instant sim run there is no start.
    expect(stepStartS("clearGarden", sources("instant", { instant: null }))).toBeNull();
  });

  it("at Full sim, starts a nested step at its recorded start and a group with its first recorded member", () => {
    const full = {
      steps: [
        { id: "driveBack", startS: 9.5, endS: 13, interrupted: false },
        { id: "clearGarden", startS: 9.75, endS: 10, interrupted: false },
        { id: "readyLauncher", startS: 10, endS: 12, interrupted: false },
      ],
    } as unknown as Trace;
    expect(stepStartS("clearGarden", sources("full", { full }))).toBe(9.75);
    expect(stepStartS("clearThenSpinUp", sources("full", { full }))).toBe(9.75);
    expect(stepStartS("returnToScore", sources("full", { full }))).toBe(9.5);
  });

  it("is null for a step the level never reaches", () => {
    const full = { steps: [{ id: "driveOut", startS: 0, endS: 2, interrupted: false }] } as unknown as Trace;
    expect(stepStartS("clearGarden", sources("full", { full }))).toBeNull();
    expect(stepStartS("clearGarden", sources("ideal", { ideal: null }))).toBeNull();
  });
});

describe("the key the step list redraws on", () => {
  it("is the same for the same set in any order, and reads back", () => {
    const a = new Set(["b", "a", "c"]);
    const b = new Set(["c", "b", "a"]);
    expect(activeKey(a)).toBe(activeKey(b));
    expect(sorted(fromActiveKey(activeKey(a)))).toEqual(["a", "b", "c"]);
    expect(fromActiveKey("").size).toBe(0);
  });
});
