/**
 * What the field draws for the Optimize card (issue #308): the proposed route planned inside the whole
 * auto, its joints, the margin round the structures the route passes near, and on `infeasible` the
 * closest attempt's worst pose for a clip ghost.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  clearanceWorld,
  flattenSteps,
  loadAuto,
  loadField,
  loadRobot,
  loadWaypoints,
  plan,
  resolve,
  runOptimize,
  type OptimizeResult,
  type PlanStep,
} from "@horizon36596/zenith-core";
import type { PathStep } from "@horizon36596/zenith-schema";
import { resolveSeason } from "@horizon36596/zenith-seasons";
import { beforeAll, describe, expect, it } from "vitest";
import { candidatePreview, NEAR_STRUCTURE_IN } from "./preview";

const examples = fileURLToPath(new URL("../../../../examples/starter/autos/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${examples}${relative}`, "utf8"));
const robot = loadRobot(read("robot.json"));
const field = loadField(read("field/biobuzz.field.json"));
const waypoints = loadWaypoints(read("waypoints.json"));
/** collect-and-score with a toOtherSide round the west of the hive frame that has a faster way round (issues #365 and #367). */
const wideAuto = (): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL("../../../../packages/core/test-fixtures/wide-collect-and-score.auto.json", import.meta.url)), "utf8"));
const auto = loadAuto(wideAuto());
const STEP = "toOtherSide";
const files = { auto, robot, field, waypoints };

let improved: OptimizeResult;

beforeAll(() => {
  // With the season's rules, as the editor runs it (issue #365).
  improved = runOptimize({ ...files, season: resolveSeason(field).rules, stepId: STEP }, { budget: 200 });
}, 60_000);

const plannedStep = (planned: { steps: PlanStep[] } | null, id: string): PlanStep | undefined =>
  planned === null ? undefined : flattenSteps(planned.steps).find((step) => step.id === id);

describe("candidatePreview", () => {
  it("plans the pick inside the whole auto, so the dashed route is the one that would be saved", () => {
    const preview = candidatePreview(files, { stepId: STEP, marginIn: 1, result: improved, stale: false });
    expect(preview?.stepId).toBe(STEP);
    const candidate = plannedStep(preview?.plan ?? null, STEP);
    expect(candidate?.samples.length).toBeGreaterThan(2);
    // The ends are the original's, which every later step starts from.
    const original = plannedStep(plan(resolve(auto, waypoints, robot), robot, field), STEP);
    const first = candidate?.samples[0]?.pose;
    const end = candidate?.samples[candidate.samples.length - 1]?.pose;
    expect(first?.xIn).toBeCloseTo(original?.samples[0]?.pose.xIn ?? NaN, 6);
    expect(end?.yIn).toBeCloseTo(original?.samples[original.samples.length - 1]?.pose.yIn ?? NaN, 6);
    expect(preview?.ghostPoseIn).toBeNull();
  });

  it("marks a joint between every two paths of the chain, and none for a single path", () => {
    const single = candidatePreview(files, { stepId: STEP, marginIn: 1, result: improved, stale: false });
    expect(single?.jointsIn).toHaveLength((improved.step?.segments.length ?? 1) - 1);
    const pick = improved.step as PathStep;
    const two: PathStep = {
      ...pick,
      segments: [
        { kind: "line", from: pick.segments[0]?.from ?? "current", to: { xIn: -40, yIn: 0 } },
        { kind: "line", from: "current", to: pick.segments[pick.segments.length - 1]?.to ?? "current" },
      ],
      heading: { mode: "tangent" },
    };
    const chained = candidatePreview(files, { stepId: STEP, marginIn: 1, result: { ...improved, step: two }, stale: false });
    expect(chained?.jointsIn).toEqual([{ xIn: -40, yIn: 0 }]);
  });

  it("outlines the margin round each structure the route passes near, and only those", () => {
    const preview = candidatePreview(files, { stepId: STEP, marginIn: 1, result: improved, stale: false });
    const near = preview?.marginOutlines.map((outline) => outline.id) ?? [];
    expect(near).toContain(improved.pick?.closest?.id);
    const all = clearanceWorld(robot, field).structures.map((structure) => structure.id);
    expect(near.length).toBeGreaterThan(0);
    expect(near.length).toBeLessThan(all.length);
    for (const outline of preview?.marginOutlines ?? []) expect(outline.polygonIn.length).toBeGreaterThan(4);
    expect(NEAR_STRUCTURE_IN).toBeGreaterThan(0);
  });

  it("draws no route for a stale result or one without a pick, but keeps the margin round the step as it is", () => {
    const stale = candidatePreview(files, { stepId: STEP, marginIn: 1, result: improved, stale: true });
    expect(stale?.plan).toBeNull();
    expect(stale?.marginOutlines.length).toBeGreaterThan(0);
    const before = candidatePreview(files, { stepId: STEP, marginIn: 1, result: null, stale: false });
    expect(before?.plan).toBeNull();
    expect(before?.marginOutlines.length).toBeGreaterThan(0);
  });

  it("draws the route the switcher shows, not the pick, when it is given one (issue #310)", () => {
    const pick = improved.step as PathStep;
    const other: PathStep = {
      ...pick,
      segments: [
        { kind: "line", from: pick.segments[0]?.from ?? "current", to: { xIn: -40, yIn: 0 } },
        { kind: "line", from: "current", to: pick.segments[pick.segments.length - 1]?.to ?? "current" },
      ],
      heading: { mode: "tangent" },
    };
    const shown = candidatePreview(files, { stepId: STEP, marginIn: 1, result: improved, stale: false, route: other });
    expect(shown?.jointsIn).toEqual([{ xIn: -40, yIn: 0 }]);
    // A stale result still draws nothing, whichever route was shown.
    expect(candidatePreview(files, { stepId: STEP, marginIn: 1, result: improved, stale: true, route: other })?.plan).toBeNull();
  });

  it("plans a clear path's route inside its draft, the auto with the new step added (issue #310)", () => {
    const step: PathStep = {
      id: "clearPath",
      kind: "path",
      segments: [
        { kind: "line", from: "current", to: { xIn: -40, yIn: 40 } },
        { kind: "line", from: "current", to: { xIn: -45, yIn: -10, provenance: "SET FROM EDITOR" } },
      ],
      heading: { mode: "tangent" },
    };
    const draft = { ...auto, steps: [...auto.steps, { ...step, segments: [{ kind: "line" as const, from: "current" as const, to: { xIn: -45, yIn: -10, provenance: "SET FROM EDITOR" } }] }] };
    const preview = candidatePreview({ ...files, auto: draft }, { stepId: "clearPath", marginIn: 1, result: improved, stale: false, route: step });
    expect(plannedStep(preview?.plan ?? null, "clearPath")?.samples.length).toBeGreaterThan(2);
    expect(preview?.jointsIn).toEqual([{ xIn: -40, yIn: 40 }]);
  });

  it("gives the closest attempt's worst pose for a clip ghost when the result is infeasible", () => {
    // The step as a straight line through the hive frame's west bar, which check() reports, and a
    // margin no way round the frame keeps, so the run ends with a closest attempt. An original that
    // check() passes is never infeasible, whatever the margin: it is no better.
    const original = auto.steps.find((step): step is PathStep => step.kind === "path" && step.id === STEP) as PathStep;
    const line: PathStep = {
      ...original,
      segments: [{ kind: "line", from: original.segments[0]?.from ?? "current", to: original.segments[original.segments.length - 1]?.to ?? "current" }],
    };
    const through = { ...files, auto: { ...auto, steps: auto.steps.map((step) => (step.id === STEP ? line : step)) } };
    const infeasible = runOptimize({ ...through, stepId: STEP }, { budget: 20, marginIn: 12 });
    expect(infeasible.originalBlocked).toMatchObject({ code: "STRUCTURE" });
    expect(infeasible.status).toBe("infeasible");
    const preview = candidatePreview(through, { stepId: STEP, marginIn: 1, result: infeasible, stale: false });
    expect(preview?.plan).toBeNull();
    expect(preview?.ghostPoseIn).toEqual(infeasible.closest?.pose);
  });
});
