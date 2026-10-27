import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Auto, PathStep, Step } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { estimate } from "../estimate.js";
import { robotClearanceIn } from "../kinematics.js";
import { loadAuto, loadField, loadLink, loadRobot, loadWaypoints } from "../load.js";
import { flattenSteps, plan } from "../plan.js";
import { resolve } from "../resolve.js";
import type { PlanSample } from "../types.js";
import { canonicalAuto, canonicalPathStep } from "./candidate.js";
import { createFinalCheck } from "./final.js";
import { runOptimize } from "./index.js";
import { createObjective, TIME_EPSILON_S, type ObjectiveInput } from "./objective.js";
import { oracleClearance } from "./oracle.test-helper.js";

/**
 * The Contract of OPT-10 (issue #302): on a step that clips the hive, `runOptimize` with its defaults
 * returns `improved`; the pick passes the hard final check and a brute-force oracle written apart from
 * it; the keep list and every other step are byte for byte the original's; and the pick is no slower
 * than the original under the estimate (T0) or the instant sim (T1).
 *
 * The step is the public starter's `toOtherSide` in collect-and-score as it was before issues #365
 * and #367, kept in `packages/core/test-fixtures/`, from the old scoring spot on x = -9 north under the
 * hive, which in the instant sim swings about 0.65 in into the hive frame's north-west leg, 1.65 in
 * short of the robot's 1 in clearance. The starter now goes round the west of the frame, because
 * that route also crosses the centre line, which the season's G402 rule forbids; no season is given
 * here, so the optimizer is held to the hive alone.
 * Horizon's own robot example stays in the private repository and no public test may read it
 * (`scripts/check-example-deps.mjs`), so the starter stands in for it.
 */

const root = fileURLToPath(new URL("../../../../examples/starter/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${root}${relative}`, "utf8"));

const link = loadLink(read("zenith.json"));
const robot = loadRobot(read(link.robot));
const field = loadField(read(link.field));
const STEP = "toOtherSide";

const waypoints = loadWaypoints(read(link.waypoints ?? "autos/waypoints.json"));

/**
 * collect-and-score as it was before issues #365 and #367, with toOtherSide under the hive, kept in
 * `packages/core/test-fixtures/` with the start and scoring spots it had then written into the file.
 */
const corridorFile = fileURLToPath(new URL("../../test-fixtures/corridor-collect-and-score.auto.json", import.meta.url));
const auto = loadAuto(JSON.parse(readFileSync(corridorFile, "utf8")) as unknown);
const input: ObjectiveInput = { auto, robot, field, waypoints, stepId: STEP };

/** The auto with the step replaced, in canonical form. */
const withStep = (base: Auto, step: PathStep): Auto =>
  canonicalAuto({ ...base, steps: base.steps.map((old: Step) => (old.id === STEP ? step : old)) } as Auto).auto;

const samplesOf = (planned: ReturnType<typeof plan>): PlanSample[] =>
  flattenSteps(planned.steps).find((step) => step.id === STEP)?.samples as PlanSample[];

describe("OPT-10 Contract: Optimize path on a step that clips the hive", () => {
  it("returns an improved route that passes the final check and the oracle, keeps everything else and is no slower", () => {
    const marginIn = robotClearanceIn(robot);
    const objective = createObjective(input, { marginIn });
    // The original clips: the instant sim drives it inside the margin of a hive frame leg.
    expect(objective.original.simWorst ?? objective.original.worst).toMatchObject({ kind: "structure" });
    expect(String((objective.original.simWorst ?? objective.original.worst)?.id)).toMatch(/^frameLeg/);

    const result = runOptimize(input);
    expect(result.status).toBe("improved");
    expect(result.evaluations).toBeLessThanOrEqual(result.budget);
    const pick = result.pick;
    if (pick === null || result.step === null) throw new Error("expected a pick");
    expect(result.step).toBe(pick.step);

    // The pick passes the hard final check, run here afresh.
    const verdict = createFinalCheck(input, objective).verify(pick.step);
    expect(verdict.ok, verdict.ok ? "" : JSON.stringify(verdict.failure)).toBe(true);

    // And the oracle, on the plan followed every 0.1 in and on the sim's own motion.
    const optimized = withStep(canonicalAuto(auto).auto, pick.step);
    const dense = plan(resolve(optimized, waypoints, robot), robot, field, { sampleSpacingIn: 0.1 });
    const planned = oracleClearance(samplesOf(dense).map((sample) => sample.pose), robot, field, marginIn);
    expect(planned.violation).toBeNull();
    const poses = objective.simulatedPoses(pick.step);
    expect(poses).not.toBeNull();
    for (const span of [poses?.path ?? [], poses?.after ?? []]) {
      if (span.length === 0) continue;
      expect(oracleClearance(span.map((sample) => sample.pose), robot, field, marginIn).violation).toBeNull();
    }

    // The keep list: every key of the step but its segments and heading, as written, and both ends.
    const original = canonicalPathStep(objective.originalStep);
    const { segments: oldSegments, heading: _oldHeading, ...oldKept } = original;
    const { segments: newSegments, heading: _newHeading, ...newKept } = pick.step;
    expect(JSON.stringify(newKept)).toBe(JSON.stringify(oldKept));
    expect(JSON.stringify(newSegments[0]?.from)).toBe(JSON.stringify(oldSegments[0]?.from));
    expect(JSON.stringify(newSegments[newSegments.length - 1]?.to)).toBe(JSON.stringify(oldSegments[oldSegments.length - 1]?.to));
    // Every other step, byte for byte.
    const before = canonicalAuto(auto).auto;
    for (const [index, step] of optimized.steps.entries()) {
      if (step.id === STEP) continue;
      expect(JSON.stringify(step)).toBe(JSON.stringify(before.steps[index]));
    }
    const { steps: _a, ...beforeRest } = before;
    const { steps: _b, ...afterRest } = optimized;
    expect(JSON.stringify(afterRest)).toBe(JSON.stringify(beforeRest));

    // No slower under T0 and T1, read from the result and measured again here.
    expect(pick.t0.after.windowEndS).toBeLessThanOrEqual(pick.t0.before.windowEndS + TIME_EPSILON_S);
    expect(pick.t1).not.toBeNull();
    expect(pick.t1?.after.windowEndS ?? Infinity).toBeLessThanOrEqual((pick.t1?.before.windowEndS ?? 0) + TIME_EPSILON_S);
    const t0Before = estimate(plan(resolve(before, waypoints, robot), robot, field), robot).byStepId[STEP]?.nominalS ?? Infinity;
    const t0After = estimate(plan(resolve(optimized, waypoints, robot), robot, field), robot).byStepId[STEP]?.nominalS ?? Infinity;
    expect(t0After).toBeLessThanOrEqual(t0Before + TIME_EPSILON_S);
    const again = objective.evaluate(pick.step, { scoreWith: "sim" });
    const originalSim = objective.evaluate(objective.originalStep, { scoreWith: "sim" });
    expect(again.t1?.windowEndS ?? Infinity).toBeLessThanOrEqual((originalSim.t1?.windowEndS ?? 0) + TIME_EPSILON_S);
    expect(result.changes.length).toBeGreaterThan(0);
  }, 240_000);
});
