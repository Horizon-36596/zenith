/**
 * Duplicating a step (issue #160): `cloneWithFreshIds` gives the copy and everything in it ids the
 * document does not use, and a copied deadline group names the copy of its own deadline member, so
 * a duplicate never leaves a SCHEMA error behind and never blocks codegen.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { addStep, loadAuto, loadField, loadRobot, loadWaypoints } from "@horizon36596/zenith-core";
import { SCHEMA_ID, type Auto, type ParallelStep, type Step } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { derive } from "../state/derived";
import { cloneWithFreshIds, emptiedGroup, findEntry, indexSteps } from "./stepOps";

const examples = fileURLToPath(new URL("../../../../examples/starter/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${examples}${relative}`, "utf8"));

const robot = loadRobot(read("autos/robot.json"));
const field = loadField(read("autos/field/biobuzz.field.json"));
const waypoints = loadWaypoints(read("autos/waypoints.json"));

/**
 * collect-and-score ends with `returnToScore`, a deadline parallel group of the path `driveBack`
 * (its deadline) and the sequence `clearThenSpinUp`.
 */
const collectAndScore = (): Auto => {
  // The route as it was before issue #367: the copy of driveBack starts from where the first one ended, which
  // only the old route, that ends on the scoring spot, can drive a second time without hitting the hive.
  const file = fileURLToPath(new URL("../../../../packages/core/test-fixtures/corridor-collect-and-score.auto.json", import.meta.url));
  return loadAuto(JSON.parse(readFileSync(file, "utf8")) as unknown);
};

/** Duplicates the step `stepId` the way the editor's Duplicate step does: a fresh copy, straight after it. */
function duplicate(auto: Auto, stepId: string): { auto: Auto; copy: Step } {
  const entry = findEntry(auto, stepId);
  if (entry === undefined) throw new Error(`no step ${stepId}`);
  const copy = cloneWithFreshIds(auto, entry.step);
  return { auto: addStep(auto, copy, entry.id), copy };
}

const parallelAt = (auto: Auto, stepId: string): ParallelStep => {
  const step = findEntry(auto, stepId)?.step;
  if (step?.kind !== "parallel") throw new Error(`${stepId} is not a parallel group`);
  return step;
};

/** The ids of `stepId` and every step inside it. */
const idsUnder = (auto: Auto, stepId: string): Set<string> => {
  const entries = indexSteps(auto);
  const under = new Set([stepId]);
  for (const entry of entries) {
    if (entry.parentId !== undefined && under.has(entry.parentId)) under.add(entry.id);
  }
  return under;
};

const line = (id: string | undefined, xIn: number): Step => ({
  ...(id === undefined ? {} : { id }),
  kind: "path",
  segments: [{ kind: "line", from: "current", to: { xIn, yIn: 0, headingRad: 0 } }],
  heading: { mode: "tangent" },
});

const fixture = (steps: unknown[]): Auto =>
  loadAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 4,
    name: "duplicate-fixture",
    title: "Duplicate fixture",
    alliance: "RED",
    start: { pose: { xIn: 0, yIn: 0, headingRad: 0 } },
    steps,
  });

describe("duplicating a deadline group", () => {
  it("names the copy of the deadline member as the copy's deadline", () => {
    const { auto, copy } = duplicate(collectAndScore(), "returnToScore");
    expect(copy.id).toBe("returnToScoreCopy");
    const group = parallelAt(auto, "returnToScoreCopy");
    expect(group.steps.map((member) => member.id)).toEqual(["driveBackCopy", "clearThenSpinUpCopy"]);
    expect(group.deadline).toBe("driveBackCopy");
    // The original is untouched.
    expect(parallelAt(auto, "returnToScore").deadline).toBe("driveBack");
  });

  it("leaves no finding on the copy or anything inside it", () => {
    const { auto } = duplicate(collectAndScore(), "returnToScore");
    const derived = derive(auto, robot, field, waypoints);
    expect(derived.findingsReason).toBeNull();
    const copyIds = idsUnder(auto, "returnToScoreCopy");
    expect(copyIds.size).toBe(5);
    // The copy drives driveBack a second time from where the first one ended, a route drawn to
    // start at the garden, so from the scoring spot it runs into the hive frame: findings about
    // where it drives, not about its ids, and the only kind the copy may carry.
    const aboutWhereItDrives = new Set(["STRUCTURE", "CLEARANCE", "PERIMETER", "OPPONENT_SIDE", "STRAFE_FRACTION"]);
    const onCopy = derived.findings.filter((finding) => copyIds.has(finding.stepId));
    expect(onCopy.filter((finding) => !aboutWhereItDrives.has(finding.code))).toEqual([]);
    expect(derived.findings.filter((finding) => finding.code === "SCHEMA")).toEqual([]);
  });

  it("repoints a deadline group inside a duplicated sequence", () => {
    const auto = fixture([
      {
        id: "cycle1",
        kind: "sequence",
        steps: [
          {
            id: "c1Out",
            kind: "parallel",
            mode: "deadline",
            deadline: "c1Drive",
            steps: [line("c1Drive", 24), { id: "c1Intake", kind: "command", name: "intakeOn" }],
          },
          { id: "c1Score", kind: "command", name: "score" },
        ],
      },
    ]);
    const duplicated = duplicate(auto, "cycle1").auto;
    expect(parallelAt(duplicated, "c1OutCopy").deadline).toBe("c1DriveCopy");
    expect(parallelAt(duplicated, "c1Out").deadline).toBe("c1Drive");
  });

  it("maps a positional deadline member to the copy's member at the same place", () => {
    const auto = fixture([
      line("leg", 12),
      { id: "park", kind: "parallel", mode: "deadline", deadline: "park.2", steps: [{ kind: "wait", seconds: 1 }, line(undefined, 24)] },
    ]);
    const duplicated = duplicate(auto, "park").auto;
    expect(parallelAt(duplicated, "parkCopy").deadline).toBe("parkCopy.2");
    expect(indexSteps(duplicated).map((entry) => entry.id)).toContain("parkCopy.2");
  });

  it("maps the deadline of a group that has no id of its own", () => {
    const auto = fixture([
      line("leg", 12),
      { kind: "parallel", mode: "deadline", deadline: "step2.1", steps: [line(undefined, 24), { kind: "wait", seconds: 1 }] },
    ]);
    const { auto: duplicated, copy } = duplicate(auto, "step2");
    // The copy gets the id addStep would give it, so the deadline inside it can name its members.
    expect(copy.id).toBe("parallel");
    expect(parallelAt(duplicated, "parallel").deadline).toBe("parallel.1");
    expect(parallelAt(duplicated, "step2").deadline).toBe("step2.1");
  });

  it("keeps a copied group's deadline as it was when it named none of the group's members", () => {
    const auto = fixture([
      { id: "park", kind: "parallel", mode: "deadline", deadline: "elsewhere", steps: [line("go", 24), { id: "w", kind: "wait", seconds: 1 }] },
    ]);
    const copy = cloneWithFreshIds(auto, auto.steps[0] as Step);
    expect(copy.kind === "parallel" && copy.deadline).toBe("elsewhere");
  });
});

/** Issue #317: the editor refuses in plain words an edit that would leave a group with no steps. */
describe("emptiedGroup", () => {
  const entries = indexSteps(collectAndScore());

  it("names the sequence whose only remaining step would go", () => {
    const children = entries.filter((entry) => entry.parentId === "clearThenSpinUp").map((entry) => entry.id);
    expect(emptiedGroup(entries, children)?.id).toBe("clearThenSpinUp");
  });

  it("is undefined while the group keeps a step, or when the group goes too", () => {
    const children = entries.filter((entry) => entry.parentId === "clearThenSpinUp").map((entry) => entry.id);
    expect(children.length).toBeGreaterThan(1);
    expect(emptiedGroup(entries, [children[0] ?? ""])).toBeUndefined();
    expect(emptiedGroup(entries, ["clearThenSpinUp", ...children])).toBeUndefined();
    expect(emptiedGroup(entries, ["returnToScore", ...children])).toBeUndefined();
  });
});
