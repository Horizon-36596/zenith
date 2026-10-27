import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Auto, PathStep } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { robotClearanceIn } from "../kinematics.js";
import { loadAuto, loadField, loadLink, loadRobot, loadWaypoints } from "../load.js";
import { flattenSteps, plan } from "../plan.js";
import { resolve } from "../resolve.js";
import type { PlanSample } from "../types.js";
import { canonicalAuto, headingProblem, routeEndsOf, stepGeometry } from "./candidate.js";
import { ESTIMATE_ONLY_LABEL, createFinalCheck, MIN_TIME_GAIN_S } from "./final.js";
import { stepHoldProblem } from "./holds.js";
import { optimizeInputKey, resolveOptimizeOptions, runOptimize } from "./index.js";
import { createObjective, type ObjectiveInput } from "./objective.js";
import { oracleClearance } from "./oracle.test-helper.js";

/**
 * Issue #448's case as a Contract: a long diagonal straight drive on the BIOBUZZ field with the
 * public starter robot, starting with the heading 90 degrees off the direction of travel and ending
 * on a field axis (`packages/core/test-fixtures/long-diagonal.auto.json`).
 *
 * What was measured on it (Node 22, the default options, the default budget of 250):
 *
 * - The step as written, Linear from -0.2075 to 0 rad, strafes the whole 116.5 in: 3.99 s in the
 *   estimate and 3.43 s in the instant sim.
 * - A hand-made plan that turns onto the path over the first 20 % (23 in), drives it nose first and
 *   turns back over the last 3 %: 3.56 s in the estimate and 3.73 s in the instant sim. Nose first
 *   from end to end would be 3.01 s in the sim, so the sim does credit driving nose first; what it
 *   charges is the 90 degree turn while the robot accelerates, when Pedro's follower gives the wheels'
 *   power to the turn first (ADR 0003) and the mecanum velocity limit is a diamond, slowest on the
 *   diagonal the turn passes through. The estimate caps speed and turn rate apart, so it charges
 *   the turn almost nothing. No turn range from 2 % to 50 % of the path, and no end turn from 50 %
 *   to 97 %, is faster in the sim than the strafe.
 * - Optimize path before issue #448 returned noBetter with nothing else: the gate between models
 *   (spec 16 section 5.2) offered only routes faster in the sim, so the plan the timeline shows
 *   faster was never shown. Now it comes back as an alternative labelled "Faster in the estimate,
 *   slower in the instant sim", never as the pick, and the heading holds of section 3 give the
 *   person the constraint the issue names.
 */

const root = fileURLToPath(new URL("../../../../examples/starter/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${root}${relative}`, "utf8"));
const link = loadLink(read("zenith.json"));
const robot = loadRobot(read(link.robot));
const field = loadField(read(link.field));
const waypoints = loadWaypoints(read(link.waypoints ?? "autos/waypoints.json"));

const fixtureFile = fileURLToPath(new URL("../../test-fixtures/long-diagonal.auto.json", import.meta.url));
const auto = loadAuto(JSON.parse(readFileSync(fixtureFile, "utf8")) as unknown);
const STEP = "drive";
const input: ObjectiveInput = { auto, robot, field, waypoints, stepId: STEP };
const objective = createObjective(input, { marginIn: robotClearanceIn(robot) });
const original = objective.originalStep;

/** The drive's direction, rounded as the file writes radians. */
const TRAVEL_RAD = 1.3633;

/** The hand-made plan: turn onto the path up to `a`, nose first to `b`, turn back to E's heading. */
const turnPlan = (a: number, b: number): PathStep => ({
  ...original,
  heading: {
    mode: "piecewise",
    ranges: [
      { startT: 0, endT: a, heading: { mode: "linear", fromRad: -0.2075, toRad: TRAVEL_RAD } },
      { startT: a, endT: b, heading: { mode: "tangent" } },
      { startT: b, endT: 1, heading: { mode: "linear", fromRad: TRAVEL_RAD, toRad: 0 } },
    ],
  },
});

const timesOf = (step: PathStep): { t0: number; t1: number } => {
  const estimated = objective.evaluate(step, { scoreWith: "estimate" }).t0;
  const simulated = objective.evaluate(step, { scoreWith: "sim" }).t1;
  if (estimated === null || simulated === null) throw new Error("expected both models to time the route");
  return { t0: estimated.ownS, t1: simulated.ownS };
};

const samplesOf = (step: PathStep): PlanSample[] => {
  const written = canonicalAuto({ ...auto, steps: [step] } as Auto).auto;
  const dense = plan(resolve(written, waypoints, robot), robot, field, { sampleSpacingIn: 0.1 });
  return flattenSteps(dense.steps).find((planned) => planned.id === STEP)?.samples as PlanSample[];
};

/** The route passes the oracle on its dense plan and on the instant sim's own motion. */
const expectClear = (step: PathStep): void => {
  const marginIn = robotClearanceIn(robot);
  expect(oracleClearance(samplesOf(step).map((sample) => sample.pose), robot, field, marginIn).violation).toBeNull();
  const poses = objective.simulatedPoses(step);
  expect(poses).not.toBeNull();
  for (const span of [poses?.path ?? [], poses?.after ?? []]) {
    if (span.length > 0) expect(oracleClearance(span.map((sample) => sample.pose), robot, field, marginIn).violation).toBeNull();
  }
};

const resolvedEnds = routeEndsOf(
  resolve(canonicalAuto(auto).auto, waypoints, robot).steps.find((step) => step.id === STEP) as Parameters<typeof routeEndsOf>[0],
);

describe("issue #448: a long diagonal drive that starts 90 degrees off its direction", () => {
  it("is where the estimate and the instant sim disagree about turning onto the path", () => {
    const linear = timesOf(original);
    const turn = timesOf(turnPlan(0.2, 0.97));
    // Measured: 3.99 s and 3.43 s for the strafe, 3.56 s and 3.73 s for the turn plan.
    expect(turn.t0).toBeLessThan(linear.t0 - 0.3);
    expect(turn.t1).toBeGreaterThan(linear.t1 + 0.2);
  });

  it("offers the turn-onto-the-path plan as an alternative the estimate has faster, never as the pick", () => {
    const result = runOptimize(input);
    expect(result.evaluations).toBeLessThanOrEqual(result.budget);
    expect(result.status).toBe("noBetter");
    expect(result.step).toBeNull();
    const offered = result.alternatives.find((route) => route.label === ESTIMATE_ONLY_LABEL);
    if (offered === undefined) throw new Error("expected an alternative faster in the estimate");
    // Turn onto the path, drive it nose first, turn back.
    const heading = offered.step.heading;
    expect(heading?.mode).toBe("piecewise");
    const modes = heading?.mode === "piecewise" ? heading.ranges.map((range) => range.heading.mode) : [];
    expect(modes).toEqual(["linear", "tangent", "linear"]);
    expect(offered.t0.before.ownS - offered.t0.after.ownS).toBeGreaterThan(0.3);
    expect(offered.t1?.after.ownS ?? 0).toBeGreaterThan(offered.t1?.before.ownS ?? Infinity);
    expect(offered.changes[0]).toMatch(/^It is \d\.\d\d s slower in the instant sim\.$/);
    // Continuous at every boundary, and a plan the follower drives: the instant sim's own motion keeps the margin.
    const geometry = stepGeometry(offered.step, resolvedEnds);
    if (typeof geometry === "string") throw new Error(geometry);
    expect(headingProblem(offered.step.heading as NonNullable<PathStep["heading"]>, geometry, resolvedEnds)).toBeNull();
    expectClear(offered.step);
    // The hard final check passes it only when asked for a route faster in the estimate alone, at the full margin.
    const check = createFinalCheck(input, objective);
    const plain = check.verify(offered.step);
    expect(plain.ok).toBe(false);
    expect(plain.ok ? null : plain.failure.code).toBe("notFaster");
    const verdict = check.verify(offered.step, { allowEstimateOnly: true, fullMargin: true });
    expect(verdict.ok && verdict.accepted.fasterInEstimateOnly).toBe(true);
  }, 240_000);

  it("picks the turn plan when the person scores with the estimate", () => {
    const result = runOptimize(input, { scorer: "estimate" });
    expect(result.status).toBe("improved");
    const heading = result.step?.heading;
    expect(heading?.mode === "piecewise" ? heading.ranges.map((range) => range.heading.mode) : []).toEqual(["linear", "tangent", "linear"]);
    expect((result.pick?.t0.before.ownS ?? 0) - (result.pick?.t0.after.ownS ?? 0)).toBeGreaterThan(0.3);
  }, 240_000);
});

describe("issue #448: the heading holds", () => {
  it("keep E's heading over the last 12 in, and say the original does not", () => {
    const holds = { holdEndHeadingIn: 12 };
    const result = runOptimize(input, holds);
    expect(result.evaluations).toBeLessThanOrEqual(result.budget);
    expect(result.status).toBe("improved");
    expect(result.originalBreaksHolds).toBe("does not hold its end heading over the last 12 in");
    expect(result.changes[0]).toMatch(/^The original does not hold its end heading over the last 12 in, so this is the fastest route found that does/);
    const pick = result.pick;
    if (pick === null) throw new Error("expected a pick");
    expect(stepHoldProblem(pick.step, resolvedEnds, { startIn: 0, endIn: 12 })).toBeNull();
    // The held original's own family takes a start, so the pick is the strafe with the turn finished
    // 12 in early, as fast in the sim to within five ticks (measured: the same to the hundredth).
    expect(pick.t1?.after.ownS ?? Infinity).toBeLessThanOrEqual((pick.t1?.before.ownS ?? 0) + 5 * MIN_TIME_GAIN_S);
    for (const route of [pick, ...result.alternatives]) {
      expect(stepHoldProblem(route.step, resolvedEnds, { startIn: 0, endIn: 12 })).toBeNull();
      expectClear(route.step);
    }
    // The hard final check refuses a route that breaks the hold: the original itself, here.
    const check = createFinalCheck(input, objective, { holds: { startIn: 0, endIn: 12 } });
    expect(check.originalBreaksHolds).toBe("does not hold its end heading over the last 12 in");
    const verdict = check.verify(original);
    expect(verdict.ok ? null : { step: verdict.failure.step, code: verdict.failure.code }).toEqual({ step: 3, code: "breaksHeadingHold" });
  }, 240_000);

  it("keep the start heading over the first 12 in, and both together", () => {
    for (const [options, holds] of [
      [{ holdStartHeadingIn: 12 }, { startIn: 12, endIn: 0 }],
      [{ holdStartHeadingIn: 12, holdEndHeadingIn: 12 }, { startIn: 12, endIn: 12 }],
    ] as const) {
      const result = runOptimize(input, options);
      expect(result.status).toBe("improved");
      for (const route of [...(result.pick === null ? [] : [result.pick]), ...result.alternatives]) {
        expect(stepHoldProblem(route.step, resolvedEnds, holds)).toBeNull();
      }
    }
  }, 240_000);

  it("is infeasible when the holds are longer than any route between the ends", () => {
    const result = runOptimize(input, { holdStartHeadingIn: 100, holdEndHeadingIn: 100, budget: 40 });
    expect(result.status).toBe("infeasible");
    expect(result.step).toBeNull();
    expect(result.changes[0]).toBe(
      "The original does not hold its start heading over the first 100 in and its end heading over the last 100 in, and no route that does was found between the step's two ends.",
    );
  }, 240_000);

  it("cannot be kept by a step that faces a point", () => {
    const facing = { ...auto, steps: [{ ...original, heading: { mode: "facePoint" as const, xIn: 38, yIn: -72 } }] } as Auto;
    const result = runOptimize({ ...input, auto: facing }, { holdEndHeadingIn: 6 });
    expect(result.status).toBe("infeasible");
    expect(result.changes).toEqual(["The step faces a point, which it keeps, so it cannot hold its end heading over the last 6 in."]);
  });

  it("are part of the input key only when on, and refuse a negative length", () => {
    const key = (options: Parameters<typeof resolveOptimizeOptions>[1]): string => optimizeInputKey(input, resolveOptimizeOptions(input, options));
    expect(key({ holdStartHeadingIn: 0, holdEndHeadingIn: 0 })).toBe(key({}));
    expect(key({ holdEndHeadingIn: 12 })).not.toBe(key({}));
    expect(key({ holdEndHeadingIn: 12 })).not.toBe(key({ holdStartHeadingIn: 12 }));
    expect(() => resolveOptimizeOptions(input, { holdEndHeadingIn: -1 })).toThrow(/at least 0/);
    expect(() => resolveOptimizeOptions(input, { holdStartHeadingIn: Number.NaN })).toThrow(/at least 0/);
  });
});
