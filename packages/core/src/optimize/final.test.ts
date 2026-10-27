import { parseAuto, parseField, parseRobot, SCHEMA_ID, type Auto, type Field, type PathStep, type Robot, type Segment } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { footprintAt } from "../footprint.js";
import { flattenSteps, plan } from "../plan.js";
import { resolve } from "../resolve.js";
import { testField, testRobot } from "../testing/fixtures.js";
import type { PlanSample } from "../types.js";
import { canonicalAuto, canonicalPathStep } from "./candidate.js";
import {
  choosePick,
  createFinalCheck,
  ESTIMATE_ONLY_LABEL,
  FINAL_SAMPLE_SPACING_IN,
  MAX_ALTERNATIVES,
  MIN_TIME_GAIN_S,
  PLANNED_PATH_ONLY_NOTE,
  SIM_ONLY_LABEL,
  type AcceptedRoute,
  type FinalFailureCode,
  type FinalStep,
  type FinalVerdict,
} from "./final.js";
import { createObjective, type Objective, type ObjectiveInput, type ObjectiveOptions, type SimulatedPoses } from "./objective.js";
import { oracleClearance, type OraclePose } from "./oracle.test-helper.js";

/**
 * The hard final check's contract (issue #301): a route that moves an end, changes a marker's `at`,
 * adds a STRUCTURE finding, or clears the margin only on the nominal path while the sim's poses cut it
 * is refused with a named reason; Route around mode lets a colliding original go only to a route that
 * clears; a route faster in the instant sim and slower in the estimate is never the pick; and a
 * brute-force oracle written apart from `clearance.ts` agrees with every route the check accepts. Every
 * fixture is a fixed value.
 */

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The test robot (18 in long, 14 in wide) with a marker command and a tall enough body for the obstacles. */
const robot: Robot = parseRobot({
  ...clone(testRobot),
  heightIn: { value: 12, provenance: "PLACEHOLDER: test fixture" },
  commands: [
    { name: "shootAll", estimateS: "0.6 + count * cadence" },
    { name: "setIntake", estimateS: "0" },
    { name: "blip", estimateS: "0.05", stationary: true },
  ],
});

const fieldWith = (obstacles: unknown[], zones: unknown[] = []): Field =>
  parseField({ ...clone(testField), obstacles, zones });

const box = (id: string, minX: number, maxX: number, minY: number, maxY: number): Record<string, unknown> => ({
  id,
  kind: "box",
  minXIn: minX,
  maxXIn: maxX,
  minYIn: minY,
  maxYIn: maxY,
  minZIn: 0,
  maxZIn: 10,
  solidToRobot: true,
  provenance: "PLACEHOLDER: test fixture",
});

/** A post in the middle of the way from (-48, 0) to (48, 0). */
const postField = fieldWith([box("post", -4, 4, -3, 3)]);

const START = { xIn: -48, yIn: 0, headingRad: 0 };
const END = { xIn: 48, yIn: 0 };

const HEADING_ZERO = { mode: "constant", headingRad: 0 };

/** The route under test and a path after it, which carries what the route does to the next step. */
function autoOf(route: Record<string, unknown>, after = true): Auto {
  return canonicalAuto(
    parseAuto({
      $schema: SCHEMA_ID.auto,
      formatVersion: 4,
      name: "final-fixture",
      alliance: "RED",
      start: { pose: START },
      steps: [
        {
          id: "route",
          kind: "path",
          segments: [{ kind: "line", from: "current", to: END }],
          heading: HEADING_ZERO,
          ...route,
        },
        ...(after
          ? [{ id: "after", kind: "path", segments: [{ kind: "line", from: "current", to: { xIn: 48, yIn: -40 } }], heading: { mode: "tangent" } }]
          : []),
      ],
    }),
  ).auto;
}

/** Where a step's route begins and ends, as written. */
const fromOf = (step: PathStep): Segment["from"] => (step.segments[0] as Segment).from;
const toOf = (step: PathStep): Segment["to"] => (step.segments[step.segments.length - 1] as Segment).to;

const stepIn = (auto: Auto, id = "route"): PathStep => {
  const found = auto.steps.find((step) => step.kind === "path" && step.id === id);
  if (found === undefined || found.kind !== "path") throw new Error(`no path ${id}`);
  return found;
};

/** The route's step as one quadratic Bezier bowed to (0, cy), both ends and the other keys kept. */
function bowed(base: PathStep, cy: number, extra: Partial<PathStep> = {}): PathStep {
  const first = base.segments[0];
  const last = base.segments[base.segments.length - 1];
  if (first === undefined || last === undefined) throw new Error("no segment");
  return canonicalPathStep({
    ...base,
    segments: [{ kind: "bezier", from: first.from, control: [{ xIn: 0, yIn: cy }], to: last.to }],
    ...extra,
  });
}

/** The inputs and the objective for one run, the margin the robot's own 1 in unless said. */
function setup(
  auto: Auto,
  field: Field = postField,
  options: Partial<ObjectiveOptions> = {},
): { input: ObjectiveInput; objective: Objective } {
  const input: ObjectiveInput = { auto, robot, field, stepId: "route" };
  return { input, objective: createObjective(input, { marginIn: 1, ...options }) };
}

const failed = (verdict: FinalVerdict): { step: FinalStep; code: FinalFailureCode; reason: string } => {
  if (verdict.ok) throw new Error("expected the route to be refused");
  return verdict.failure;
};

const accepted = (verdict: FinalVerdict): AcceptedRoute => {
  if (!verdict.ok) throw new Error(`expected the route to pass, but step ${String(verdict.failure.step)} refused it: ${verdict.failure.reason}`);
  return verdict.accepted;
};

/** The original here is a wide detour round the post, slow but clear: a better route has room to be faster. */
const wideDetour = (): Auto => autoOf({ segments: [{ kind: "bezier", from: "current", control: [{ xIn: 0, yIn: 60 }], to: END }] });

describe("a route that passes", () => {
  it("is accepted, with its times under both models and nothing noted", () => {
    const original = wideDetour();
    const { input, objective } = setup(original);
    const check = createFinalCheck(input, objective);
    const result = accepted(check.verify(bowed(stepIn(original), 36)));

    expect(result.scoredBy).toBe("sim");
    expect(result.note).toBeNull();
    expect(result.gainS).not.toBeNull();
    expect(result.gainS as number).toBeGreaterThanOrEqual(MIN_TIME_GAIN_S - 1e-9);
    expect(result.t0.candidate.windowEndS).toBeLessThan(result.t0.original.windowEndS);
    expect(result.t1?.candidate.windowEndS).toBeLessThan(result.t1?.original.windowEndS as number);
    expect(result.fasterInSimOnly).toBe(false);
    expect(result.routedAround).toBe(false);
    expect(result.auto.text).toContain('"id": "route"');
    expect(result.findingsAdded.filter((finding) => finding.severity === "error")).toEqual([]);
  });

  it("is refused when it is not faster by one sim tick, the original included", () => {
    const original = wideDetour();
    const { input, objective } = setup(original);
    const check = createFinalCheck(input, objective);

    expect(failed(check.verify(stepIn(original)))).toMatchObject({ step: 7, code: "notFaster" });
    expect(failed(check.verify(bowed(stepIn(original), 80)))).toMatchObject({ step: 7, code: "notFaster" });
  });
});

describe("steps 1 to 3: the route is the same one, written the same way", () => {
  const original = wideDetour();
  const { input, objective } = setup(original);
  const check = createFinalCheck(input, objective);
  const base = stepIn(original);

  it("refuses a route that moves an end, and says which", () => {
    const first = base.segments[0] as PathStep["segments"][number];
    const movedEnd = canonicalPathStep({
      ...base,
      segments: [{ kind: "bezier", from: first.from, control: [{ xIn: 0, yIn: 36 }], to: { xIn: 47, yIn: 0 } }],
    });
    expect(failed(check.verify(movedEnd))).toMatchObject({ step: 2, code: "movesEnd", reason: expect.stringContaining("end of the step") });

    const movedStart = canonicalPathStep({
      ...base,
      segments: [{ kind: "bezier", from: { xIn: -47, yIn: 0 }, control: [{ xIn: 0, yIn: 36 }], to: toOf(base) }],
    });
    expect(failed(check.verify(movedStart))).toMatchObject({ step: 2, code: "movesEnd", reason: expect.stringContaining("start of the step") });
  });

  it("refuses a route that changes a marker's at, a key it keeps, or the id", () => {
    const withMarker = autoOf({
      segments: [{ kind: "bezier", from: "current", control: [{ xIn: 0, yIn: 60 }], to: END }],
      markers: [{ at: { t: 0.5 }, command: { name: "blip" } }],
    });
    const run = setup(withMarker);
    const guarded = createFinalCheck(run.input, run.objective);
    const marked = stepIn(withMarker);

    expect(failed(guarded.verify(bowed(marked, 36, { markers: [{ at: { t: 0.6 }, command: { name: "blip" } }] })))).toMatchObject({
      step: 2,
      code: "changesMarker",
      reason: expect.stringContaining("marker 1"),
    });
    expect(failed(guarded.verify(bowed(marked, 36, { markers: [] })))).toMatchObject({ step: 2, code: "changesMarker" });
    expect(failed(guarded.verify(bowed(marked, 36, { speedFraction: 0.5 })))).toMatchObject({
      step: 2,
      code: "changesKeptKey",
      reason: expect.stringContaining("speedFraction"),
    });
    expect(failed(guarded.verify(bowed(marked, 36, { id: "elsewhere" })))).toMatchObject({ step: 2, code: "changesKeptKey" });
    // The same route with the marker left alone passes this far.
    expect(guarded.verify(bowed(marked, 36)).ok).toBe(true);
  });

  it("refuses a distance marker the shorter route no longer reaches", () => {
    const longRoute = autoOf({
      segments: [{ kind: "bezier", from: "current", control: [{ xIn: 0, yIn: 60 }], to: END }],
      markers: [{ at: { distanceIn: 120 }, command: { name: "blip" } }],
    });
    const run = setup(longRoute);
    const guarded = createFinalCheck(run.input, run.objective);
    const refused = failed(guarded.verify(bowed(stepIn(longRoute), 36)));
    expect(refused).toMatchObject({ step: 2, code: "markerPastEnd" });
    expect(refused.reason).toContain("120");
  });

  it("refuses a route whose end heading is not E's", () => {
    const turned = canonicalPathStep({ ...bowed(base, 36), heading: { mode: "constant", headingRad: 0.5 } });
    expect(failed(check.verify(turned))).toMatchObject({ step: 3, code: "movesEndHeading" });
  });

  it("refuses a route that is not in the form it is saved in", () => {
    const unrounded: PathStep = {
      ...base,
      segments: [{ kind: "bezier", from: "current", control: [{ xIn: 0.123456, yIn: 36 }], to: toOf(base) }],
    };
    expect(failed(check.verify(unrounded))).toMatchObject({ step: 1, code: "notCanonical" });
  });

  it("refuses a step the auto cannot hold", () => {
    const broken = { ...bowed(base, 36), segments: [] } as unknown as PathStep;
    expect(failed(check.verify(broken))).toMatchObject({ step: 1, code: "notWritable" });
  });
});

describe("step 4: check() adds nothing", () => {
  it("refuses a route that adds a STRUCTURE finding, naming the obstacle", () => {
    const original = wideDetour();
    const { input, objective } = setup(original);
    const check = createFinalCheck(input, objective);
    const straight = canonicalPathStep({ ...stepIn(original), segments: [{ kind: "line", from: "current", to: END }] });
    const refused = failed(check.verify(straight));
    expect(refused).toMatchObject({ step: 4, code: "addsError" });
    expect(refused.reason).toContain("STRUCTURE");
  });

  it("refuses a route that adds a CLEARANCE finding unless the card's margin is below the robot's", () => {
    // Bowed to 22 in the route's body passes 0.27 in from the post's top, inside the robot's 1 in.
    const original = wideDetour();
    const tight = bowed(stepIn(original), 22);
    const strict = setup(original, postField, { marginIn: 1 });
    const refused = failed(createFinalCheck(strict.input, strict.objective).verify(tight));
    expect(refused).toMatchObject({ step: 4, code: "addsFinding" });
    expect(refused.reason).toContain("CLEARANCE");

    // A card margin of 0 is below the robot's: the CLEARANCE may appear, and the card lists it.
    const lax = setup(original, postField, { marginIn: 0 });
    const result = accepted(createFinalCheck(lax.input, lax.objective).verify(tight));
    expect(result.findingsAdded.map((finding) => finding.code)).toContain("CLEARANCE");
    expect(result.findingsAdded.every((finding) => finding.severity !== "error")).toBe(true);
  });

  it("lists a finding it allows, rather than hiding it", () => {
    const original = wideDetour();
    const { input, objective } = setup(original);
    const result = accepted(createFinalCheck(input, objective).verify(bowed(stepIn(original), 36)));
    const codes = [...result.findingsAdded, ...result.findingsRemoved].map((finding) => finding.code);
    expect(codes.every((code) => code === "STRAFE_FRACTION" || code === "CLEARANCE" || code === "TIME_BUDGET")).toBe(true);
  });
});

describe("step 5: the swept margin test on the planned path", () => {
  it("samples the plan every 0.5 in", () => {
    expect(FINAL_SAMPLE_SPACING_IN).toBe(0.5);
    const planned = plan(resolve(wideDetour(), undefined, robot), robot, postField, { sampleSpacingIn: FINAL_SAMPLE_SPACING_IN });
    const samples = flattenSteps(planned.steps).find((step) => step.id === "route")?.samples as PlanSample[];
    const gaps = samples.slice(1).map((sample, i) => sample.sIn - (samples[i] as PlanSample).sIn);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(FINAL_SAMPLE_SPACING_IN + 1e-9);
  });

  it("refuses a route that check() lets through but the swept test does not", () => {
    // Bowed to 24 in the route clears the post by about the margin at the 2 in samples, which
    // check() takes as clear; the hulls between samples are a hair closer than the margin.
    const original = wideDetour();
    const { input, objective } = setup(original);
    expect(failed(createFinalCheck(input, objective).verify(bowed(stepIn(original), 24)))).toMatchObject({ step: 5, code: "sweptPlan" });
  });

  it("refuses a route that clears the robot's margin but not the margin the card asked for", () => {
    const original = wideDetour();
    const candidate = bowed(stepIn(original), 26);
    // The robot's own margin is 1 in, and this route clears the post by about 2 in.
    const robotMargin = setup(original, postField, { marginIn: 1 });
    expect(createFinalCheck(robotMargin.input, robotMargin.objective).verify(candidate).ok).toBe(true);

    const wide = setup(original, postField, { marginIn: 4 });
    const refused = failed(createFinalCheck(wide.input, wide.objective).verify(candidate));
    expect(refused).toMatchObject({ step: 5, code: "sweptPlan" });
    expect(refused.reason).toContain("post");
  });

  it("refuses a route into a keep-out that applies in auto, and passes one that applies only in teleop", () => {
    const zone = (id: string, appliesInAuto: boolean): Record<string, unknown> => ({
      id,
      kind: "rect",
      minXIn: -6,
      maxXIn: 6,
      minYIn: 14,
      maxYIn: 26,
      appliesInAuto,
      provenance: "PLACEHOLDER: test fixture",
    });
    const original = wideDetour();
    const candidate = bowed(stepIn(original), 36);
    const hard = setup(original, fieldWith([box("post", -4, 4, -3, 3)], [zone("lane", true)]));
    const refused = failed(createFinalCheck(hard.input, hard.objective).verify(candidate));
    expect(refused.step === 4 || refused.step === 5).toBe(true);
    const soft = setup(original, fieldWith([box("post", -4, 4, -3, 3)], [zone("lane", false)]));
    expect(createFinalCheck(soft.input, soft.objective).verify(candidate).ok).toBe(true);
  });
});

describe("step 6: the sim's own poses", () => {
  /** The poses of a robot standing at (x, y) facing +x, as the sim would report them. */
  const standing = (xIn: number, yIn: number): PlanSample => {
    const pose = { xIn, yIn, headingRad: 0 };
    const footprint = footprintAt(pose, robot, "expandedIn");
    return { sIn: 0, t: 0, pose, footprintIn: footprint.bodyIn, mouthsIn: footprint.mouthsIn };
  };

  /**
   * The objective, but with the sim reporting poses that pass through the post for every route but
   * the original, which keeps its own, so the original's shortfalls allow the route nothing.
   */
  const cutting = (objective: Objective, poses: SimulatedPoses): Objective => ({
    ...objective,
    simulatedPoses: (step) => (step === objective.originalStep ? objective.simulatedPoses(step) : poses),
  });

  it("refuses a route the planned path clears by the margin while the real sim's poses cut it", () => {
    // Bowed to 24.5 in the planned path passes the swept test, and the follower, running wide of
    // the curve, comes 0.013 in inside the margin. The estimate cannot see that.
    const original = wideDetour();
    const candidate = bowed(stepIn(original), 24.5);
    const sim = setup(original);
    const refused = failed(createFinalCheck(sim.input, sim.objective).verify(candidate));
    expect(refused).toMatchObject({ step: 6, code: "sweptSim" });
    expect(refused.reason).toContain("post");

    const estimated = setup(original, postField, { scorer: "estimate" });
    expect(accepted(createFinalCheck(estimated.input, estimated.objective).verify(candidate)).note).toBe(PLANNED_PATH_ONLY_NOTE);
  });

  it("refuses a route that clears the margin only on the nominal path while the sim's poses cut it", () => {
    const original = wideDetour();
    const { input, objective } = setup(original);
    const candidate = bowed(stepIn(original), 36);
    expect(createFinalCheck(input, objective).verify(candidate).ok).toBe(true);

    const throughPost = [standing(-30, 20), standing(-20, 10), standing(0, 1), standing(20, 10)];
    const refused = failed(createFinalCheck(input, cutting(objective, { path: throughPost, after: [] })).verify(candidate));
    expect(refused).toMatchObject({ step: 6, code: "sweptSim" });
    expect(refused.reason).toContain("instant sim");
  });

  it("also tests the poses after the route, where the next step is in the window", () => {
    const original = wideDetour();
    const { input, objective } = setup(original);
    const candidate = bowed(stepIn(original), 36);
    const clear = [standing(-30, 30), standing(30, 30)];
    const refused = failed(
      createFinalCheck(input, cutting(objective, { path: clear, after: [standing(-10, 0), standing(10, 0)] })).verify(candidate),
    );
    expect(refused).toMatchObject({ step: 6, code: "sweptSim" });
    expect(refused.reason).toContain("after the route");
  });

  it("refuses a route whose window the sim does not finish", () => {
    const original = wideDetour();
    const { input, objective } = setup(original);
    const refused = failed(createFinalCheck(input, { ...objective, simulatedPoses: () => null }).verify(bowed(stepIn(original), 36)));
    expect(refused).toMatchObject({ step: 6, code: "simDoesNotFinish" });
  });

  it("is skipped when the estimate scored the run, and says so", () => {
    const original = wideDetour();
    const { input, objective } = setup(original, postField, { scorer: "estimate" });
    expect(objective.scorer).toBe("estimate");
    const result = accepted(createFinalCheck(input, objective).verify(bowed(stepIn(original), 36)));
    expect(result.scoredBy).toBe("estimate");
    expect(result.note).toBe(PLANNED_PATH_ONLY_NOTE);
    expect(result.t1).toBeNull();
  });
});

describe("Route around mode", () => {
  /** The original goes straight through the post. */
  const colliding = (): Auto => autoOf({});

  it("lets a colliding original go only to a route that passes steps 4 to 6, whatever its time", () => {
    const original = colliding();
    const { input, objective } = setup(original);
    const check = createFinalCheck(input, objective, { routeAround: true });
    expect(check.originalCollides).toBe(true);

    // The detour is slower than the straight line through the post, and clears it.
    const clear = accepted(check.verify(bowed(stepIn(original), 40)));
    expect(clear.routedAround).toBe(true);
    expect(clear.gainS === null || clear.gainS < 0).toBe(true);
    expect(clear.fasterInSimOnly).toBe(false);

    // Still through the post: refused at the clearance steps, not at the time.
    const stillThrough = canonicalPathStep({ ...stepIn(original), segments: [{ kind: "bezier", from: "current", control: [{ xIn: 0, yIn: 2 }], to: END }] });
    expect(failed(check.verify(stillThrough)).step).toBeGreaterThanOrEqual(4);
    expect(failed(check.verify(stillThrough)).step).toBeLessThanOrEqual(6);
    // And the colliding original is not accepted as its own route.
    expect(failed(check.verify(stepIn(original))).step).toBeLessThanOrEqual(6);
  });

  /**
   * The objective with the instant sim made to see every route but the original as 100 s faster and
   * the estimate as 100 s slower. An original the sim cannot time, because its plan goes through the
   * post, is given the estimate's time, so the gate between models has two times to compare.
   */
  const splitModels = (objective: Objective): Objective => ({
    ...objective,
    evaluate: (step, options) => {
      const evaluation = objective.evaluate(step, options);
      if (step === objective.originalStep) {
        return options?.scoreWith === "sim" && evaluation.t1 === null && evaluation.t0 !== null ? { ...evaluation, t1: evaluation.t0 } : evaluation;
      }
      if (options?.scoreWith === "estimate" && evaluation.t0 !== null) {
        return { ...evaluation, t0: { windowEndS: evaluation.t0.windowEndS + 100, ownS: evaluation.t0.ownS + 100 } };
      }
      if (options?.scoreWith === "sim" && evaluation.t1 !== null) {
        return { ...evaluation, t1: { windowEndS: evaluation.t1.windowEndS - 100, ownS: evaluation.t1.ownS - 100 } };
      }
      return evaluation;
    },
  });

  it("keeps the gate between models round an original check() passes: a detour faster in the sim and slower in the estimate is never the pick", () => {
    // This original clears the post but not the margin. check() passes it, so it is not blocked.
    const original = autoOf({ segments: [{ kind: "bezier", from: "current", control: [{ xIn: 0, yIn: 23 }], to: END }] });
    const { input, objective } = setup(original);
    expect(objective.evaluate(objective.originalStep, { scoreWith: "sim" }).t1).not.toBeNull();
    const check = createFinalCheck(input, splitModels(objective));
    expect(check.originalCollides).toBe(false);
    const route = accepted(check.verify(bowed(stepIn(original), 40)));
    expect(route.routedAround).toBe(false);
    expect(route.scoredBy).toBe("sim");
    expect(route.gainS as number).toBeGreaterThan(0);
    expect(route.fasterInSimOnly).toBe(true);

    const picked = choosePick([route]);
    expect(picked.pick).toBeNull();
    expect(picked.alternatives).toEqual([{ route, label: SIM_ONLY_LABEL }]);
  });

  it("makes the detour round an original that only comes within the margin the pick in Route around mode, with its label", () => {
    // The same original: Route around asks to clear the margin it comes within, so it is blocked by
    // a CLEARANCE and the best clear route is the pick whatever the models say.
    const original = autoOf({ segments: [{ kind: "bezier", from: "current", control: [{ xIn: 0, yIn: 23 }], to: END }] });
    const { input, objective } = setup(original);
    const check = createFinalCheck(input, splitModels(objective), { routeAround: true });
    expect(check.originalCollides).toBe(true);
    expect(check.originalBlocked).toMatchObject({ code: "CLEARANCE", label: 'the structure "post"', phrase: 'comes within the margin of the structure "post"' });
    const route = accepted(check.verify(bowed(stepIn(original), 40)));
    expect(route.routedAround).toBe(true);
    expect(route.fasterInSimOnly).toBe(true);

    const picked = choosePick([route]);
    expect(picked.pick).toBe(route);
    expect(picked.pickLabel).toBe(SIM_ONLY_LABEL);
  });

  it("holds a route to the full margin round an original that only comes within it in Route around mode, whatever its time", () => {
    // Clear of the post, 0.27 in from it, inside the 1 in margin: check() warns of a CLEARANCE.
    const original = autoOf({ segments: [{ kind: "bezier", from: "current", control: [{ xIn: 0, yIn: 22 }], to: END }] });
    const { input, objective } = setup(original);
    const check = createFinalCheck(input, objective, { routeAround: true });
    expect(check.originalBlocked).toMatchObject({ step: 4, code: "CLEARANCE" });
    // A route that keeps the margin is accepted whatever its time: no time test (step 7) here.
    const clear = accepted(check.verify(bowed(stepIn(original), 40)));
    expect(clear.routedAround).toBe(true);
    // A route as close as the original is refused at the swept test, not allowed its shortfall.
    expect(failed(check.verify(bowed(stepIn(original), 23)))).toMatchObject({ step: 5, code: "sweptPlan" });
  });

  it("makes the only clear route round a blocked original the pick, faster in the sim and slower in the estimate, with its label", () => {
    const original = colliding();
    const { input, objective } = setup(original);
    const check = createFinalCheck(input, splitModels(objective));
    expect(check.originalBlocked).toMatchObject({ step: 4, code: "STRUCTURE" });
    const route = accepted(check.verify(bowed(stepIn(original), 40)));
    expect(route.routedAround).toBe(true);
    expect(route.scoredBy).toBe("sim");
    expect(route.gainS as number).toBeGreaterThan(0);
    expect(route.fasterInSimOnly).toBe(true);

    const picked = choosePick([route]);
    expect(picked.pick).toBe(route);
    expect(picked.pickLabel).toBe(SIM_ONLY_LABEL);
    expect(picked.alternatives).toEqual([]);
  });

  it("is every run's rule now, without the option (issue #388), and names what the original goes through", () => {
    const original = colliding();
    const { input, objective } = setup(original);
    const check = createFinalCheck(input, objective);
    expect(check.originalCollides).toBe(true);
    expect(check.originalBlocked).toEqual({ step: 4, code: "STRUCTURE", label: 'the structure "post"', phrase: 'goes through the structure "post"' });
    const clear = accepted(check.verify(bowed(stepIn(original), 40)));
    expect(clear.routedAround).toBe(true);
    expect(clear.gainS === null || clear.gainS < 0).toBe(true);
  });

  it("does not call an original blocked that only comes within the margin, and holds a route to its own shortfall", () => {
    // Clear of the post, 0.27 in from it, inside the 1 in margin: check() warns and does not collide.
    const original = autoOf({ segments: [{ kind: "bezier", from: "current", control: [{ xIn: 0, yIn: 22 }], to: END }] });
    const { input, objective } = setup(original);
    const check = createFinalCheck(input, objective);
    expect(check.originalBlocked).toBeNull();
    // A route no closer to the post than the original passes the swept tests and meets the time test.
    expect(failed(check.verify(bowed(stepIn(original), 23)))).toMatchObject({ step: 7, code: "notFaster" });
    // One closer to the post than the original falls further short, and is refused at the swept test.
    expect(failed(check.verify(bowed(stepIn(original), 21.5)))).toMatchObject({ step: 5, code: "sweptPlan" });
  });

  it("does not skip the time test when the original is clear", () => {
    const original = wideDetour();
    const { input, objective } = setup(original);
    const check = createFinalCheck(input, objective, { routeAround: true });
    expect(check.originalCollides).toBe(false);
    expect(check.originalBlocked).toBeNull();
    expect(failed(check.verify(bowed(stepIn(original), 80)))).toMatchObject({ step: 7, code: "notFaster" });
  });
});

describe("step 7 and the gate between models", () => {
  it("flags a route the sim has faster and the estimate slower, so it is never the pick", () => {
    const original = wideDetour();
    const { input, objective } = setup(original);
    const candidate = bowed(stepIn(original), 36);
    // The estimate, made to see this one route as slower than the original by a second.
    const slowerEstimate: Objective = {
      ...objective,
      evaluate: (step, options) => {
        const evaluation = objective.evaluate(step, options);
        if (options?.scoreWith !== "estimate" || evaluation.t0 === null || step === objective.originalStep) return evaluation;
        return { ...evaluation, t0: { windowEndS: evaluation.t0.windowEndS + 100, ownS: evaluation.t0.ownS + 100 } };
      },
    };
    const route = accepted(createFinalCheck(input, slowerEstimate).verify(candidate));
    expect(route.scoredBy).toBe("sim");
    expect(route.fasterInSimOnly).toBe(true);

    const picked = choosePick([route]);
    expect(picked.pick).toBeNull();
    expect(picked.alternatives).toEqual([{ route, label: SIM_ONLY_LABEL }]);
  });
});

describe("choosePick", () => {
  const route = (name: string, fasterInSimOnly: boolean, routedAround = false): AcceptedRoute =>
    ({ step: { id: name }, fasterInSimOnly, routedAround }) as unknown as AcceptedRoute;

  it("takes the best route that is no slower in the estimate, and labels the others", () => {
    const [a, b, c, d] = [route("a", true), route("b", false), route("c", false), route("d", true)] as [AcceptedRoute, AcceptedRoute, AcceptedRoute, AcceptedRoute];
    const result = choosePick([a, b, c, d]);
    expect(result.pick).toBe(b);
    expect(result.pickLabel).toBeNull();
    // The sim-only ones come first, so the cap never drops a labelled alternative.
    expect(result.alternatives.map((alternative) => alternative.route)).toEqual([a, d]);
    expect(result.alternatives.map((alternative) => alternative.label)).toEqual([SIM_ONLY_LABEL, SIM_ONLY_LABEL]);
    expect(result.alternatives.length).toBeLessThanOrEqual(MAX_ALTERNATIVES);
  });

  it("has no pick when every route is sim-only, and none at all when there is nothing", () => {
    const only = route("only", true);
    expect(choosePick([only])).toEqual({ pick: null, pickLabel: null, alternatives: [{ route: only, label: SIM_ONLY_LABEL }] });
    expect(choosePick([])).toEqual({ pick: null, pickLabel: null, alternatives: [] });
  });

  it("leaves an ordinary alternative unlabelled", () => {
    const [a, b] = [route("a", false), route("b", false)] as [AcceptedRoute, AcceptedRoute];
    expect(choosePick([a, b])).toEqual({ pick: a, pickLabel: null, alternatives: [{ route: b, label: null }] });
  });

  it("round a blocked original takes the best clear route whatever the models say, and keeps its label", () => {
    const [a, b] = [route("a", true, true), route("b", false, true)] as [AcceptedRoute, AcceptedRoute];
    expect(choosePick([a, b])).toEqual({ pick: a, pickLabel: SIM_ONLY_LABEL, alternatives: [{ route: b, label: null }] });
  });

  it("never picks a route faster only in the estimate, and lists it after the sim-only ones (issue #448)", () => {
    const estimateOnly = { ...route("e", false), fasterInEstimateOnly: true } as AcceptedRoute;
    const [simOnly, plain] = [route("s", true), route("p", false)] as [AcceptedRoute, AcceptedRoute];
    expect(choosePick([estimateOnly, simOnly, plain])).toEqual({
      pick: plain,
      pickLabel: null,
      alternatives: [
        { route: simOnly, label: SIM_ONLY_LABEL },
        { route: estimateOnly, label: ESTIMATE_ONLY_LABEL },
      ],
    });
    expect(choosePick([estimateOnly])).toEqual({ pick: null, pickLabel: null, alternatives: [{ route: estimateOnly, label: ESTIMATE_ONLY_LABEL }] });
  });
});

describe("the brute-force oracle agrees with every accept", () => {
  interface World {
    name: string;
    field: Field;
    /** The original: it collides or sits against something, so Route around mode lets the grid through on clearance alone. */
    original: Auto;
  }

  const wall = box("bar", -0.5, 0.5, -25, 25);
  const worlds: World[] = [
    { name: "a post in the way", field: postField, original: autoOf({}) },
    { name: "a thin bar across the way", field: fieldWith([wall]), original: autoOf({}) },
    {
      name: "a keep-out in the way",
      field: fieldWith([], [{ id: "lane", kind: "rect", minXIn: -6, maxXIn: 6, minYIn: -8, maxYIn: 8, appliesInAuto: true, provenance: "PLACEHOLDER: test fixture" }]),
      original: autoOf({}),
    },
  ];

  const piecewiseTurn = {
    mode: "piecewise",
    ranges: [
      { startT: 0, endT: 0.5, heading: { mode: "linear", fromRad: 0, toRad: 1.5 } },
      { startT: 0.5, endT: 1, heading: { mode: "linear", fromRad: 1.5, toRad: 0 } },
    ],
  };

  /** A fixed grid of routes round the middle: one control point, two, and a turning heading. */
  const grid = (base: PathStep): PathStep[] => {
    const routes: PathStep[] = [];
    for (const cy of [-140, -60, -34, -24, -16, -10, -6, 0, 6, 10, 16, 24, 34, 60, 78, 120, 140]) {
      routes.push(bowed(base, cy));
      routes.push(bowed(base, cy, { heading: piecewiseTurn } as Partial<PathStep>));
    }
    for (const [x1, y1, x2, y2] of [
      [-30, 40, 30, 40],
      [-20, 20, 20, 20],
      [-30, -22, 30, -22],
      [-10, 12, 10, -12],
      [-40, 70, 40, 70],
    ] as const) {
      routes.push(
        canonicalPathStep({
          ...base,
          segments: [{ kind: "bezier", from: fromOf(base), control: [{ xIn: x1, yIn: y1 }, { xIn: x2, yIn: y2 }], to: toOf(base) }],
        }),
      );
    }
    return routes;
  };

  const trackOf = (auto: Auto, field: Field): OraclePose[] => {
    const dense = plan(resolve(auto, undefined, robot), robot, field, { sampleSpacingIn: 0.1 });
    const samples = flattenSteps(dense.steps).find((step) => step.id === "route")?.samples as PlanSample[];
    return samples.map((sample) => sample.pose);
  };

  it("is itself right about the cases it judges the check by", () => {
    const original = wideDetour();
    const base = stepIn(original);
    const overlay = (step: PathStep): Auto => canonicalAuto({ ...original, steps: [step, ...original.steps.slice(1)] } as Auto).auto;
    const judge = (step: PathStep, field: Field, marginIn = 1) => oracleClearance(trackOf(overlay(step), field), robot, field, marginIn);

    expect(judge(bowed(base, 60), postField).violation).toBeNull();
    expect(judge(bowed(base, 36), postField).violation).toBeNull();
    // 0.27 in from the post is not the 1 in margin.
    expect(judge(bowed(base, 22), postField).violation).toMatchObject({ kind: "structure", id: "post", requiredIn: 1 });
    // Through the post.
    expect(judge(bowed(base, 0), postField).violation).toMatchObject({ kind: "structure", id: "post" });
    // Out over the wall of the field.
    expect(judge(bowed(base, 150), postField).violation).toMatchObject({ kind: "wall" });
    // The same route clears a smaller margin.
    expect(judge(bowed(base, 22), postField, 0.1).violation).toBeNull();
    const lane = fieldWith([], [{ id: "lane", kind: "rect", minXIn: -6, maxXIn: 6, minYIn: 14, maxYIn: 26, appliesInAuto: true, provenance: "PLACEHOLDER: test fixture" }]);
    expect(judge(bowed(base, 36), lane).violation).toMatchObject({ kind: "keepOut", id: "lane" });
  });

  for (const world of worlds) {
    it(`on the corpus: ${world.name}`, () => {
      const run = setup(world.original, world.field);
      const check = createFinalCheck(run.input, run.objective, { routeAround: true });
      const base = stepIn(world.original);
      let accepts = 0;
      let refusals = 0;
      for (const candidate of grid(base)) {
        const verdict = check.verify(candidate);
        const auto = canonicalAuto({ ...world.original, steps: [candidate, ...world.original.steps.slice(1)] } as Auto).auto;
        const oracle = oracleClearance(trackOf(auto, world.field), robot, world.field, 1);
        if (verdict.ok) {
          accepts += 1;
          // The oracle follows the plan every 0.1 in with 0.0175 rad turns, apart from clearance.ts.
          expect(oracle.violation, `accepted ${JSON.stringify(candidate.segments)} but the oracle finds ${JSON.stringify(oracle.violation)}`).toBeNull();
          // And so does it on the sim's own poses.
          const poses = run.objective.simulatedPoses(verdict.accepted.step);
          for (const span of poses === null ? [] : [poses.path, poses.after]) {
            if (span.length === 0) continue;
            const simulated = oracleClearance(span.map((sample) => sample.pose), robot, world.field, 1);
            expect(simulated.violation).toBeNull();
          }
        } else {
          refusals += 1;
          // A route the oracle sees collide is never accepted: the refusal is the check's, at some step.
          if (oracle.violation !== null) expect(verdict.ok).toBe(false);
        }
      }
      // The grid is neither all in nor all out of the way, or the agreement would mean nothing.
      expect(accepts).toBeGreaterThan(2);
      expect(refusals).toBeGreaterThan(2);
    }, 120_000);
  }

  it("agrees on a start that sits against a structure, where the end exemption applies", () => {
    // The robot starts 0.5 in from the bar's face with its back to it, and leaves.
    const field = fieldWith([box("bar", -4, 4, -30, 30)]);
    const auto = canonicalAuto(
      parseAuto({
        $schema: SCHEMA_ID.auto,
        formatVersion: 4,
        name: "exempt",
        alliance: "RED",
        start: { pose: { xIn: 13.5, yIn: 0, headingRad: 0 } },
        steps: [
          { id: "route", kind: "path", segments: [{ kind: "line", from: "current", to: { xIn: 60, yIn: 0 } }], heading: HEADING_ZERO },
        ],
      }),
    ).auto;
    const run = setup(auto, field);
    const check = createFinalCheck(run.input, run.objective, { routeAround: true });
    const base = stepIn(auto);
    const away = canonicalPathStep({ ...base, segments: [{ kind: "bezier", from: "current", control: [{ xIn: 30, yIn: 10 }], to: toOf(base) }] });
    const verdict = check.verify(away);
    const oracle = oracleClearance(
      (flattenSteps(plan(resolve(canonicalAuto({ ...auto, steps: [away] } as Auto).auto, undefined, robot), robot, field, { sampleSpacingIn: 0.1 }).steps)[0] as { samples: PlanSample[] }).samples.map((sample) => sample.pose),
      robot,
      field,
      1,
    );
    // The end exemption lets the route leave the bar it starts against, and the oracle agrees. In
    // Route around mode the CLEARANCE finding from the start blocks the original, so the detour is
    // accepted whatever its time.
    expect(check.originalBlocked).toMatchObject({ code: "CLEARANCE" });
    accepted(verdict);
    expect(oracle.violation).toBeNull();
    // A plain run does not call that original blocked (PR #395): its CLEARANCE comes only from the
    // start, which the exemption covers, so the same detour passes the clearance steps and is refused
    // only at the time.
    const plain = createFinalCheck(run.input, run.objective);
    expect(plain.originalBlocked).toBeNull();
    expect(failed(plain.verify(away))).toMatchObject({ step: 7, code: "notFaster" });
    // Driving back into the bar from where it starts is refused by the oracle and by the check.
    const into = canonicalPathStep({ ...base, segments: [{ kind: "bezier", from: "current", control: [{ xIn: 0, yIn: 0 }], to: toOf(base) }] });
    expect(check.verify(into).ok).toBe(false);
  });
});
