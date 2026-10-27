import { parseAuto, parseField, parseRobot, SCHEMA_ID, type Auto, type Field, type PathStep, type Robot } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { check } from "../check.js";
import { updateStep } from "../edit/tree.js";
import { flattenSteps, plan } from "../plan.js";
import { resolve } from "../resolve.js";
import { noSeasonRules, pastLineIn, type OwnSide, type SeasonRules } from "../season.js";
import { testField, testRobot } from "../testing/fixtures.js";
import { canonicalAuto } from "./candidate.js";
import { CENTRE_LINE_KEEPOUT_ID, clearanceWorld } from "./clearance.js";
import { runOptimize } from "./index.js";
import type { ObjectiveInput } from "./objective.js";

/**
 * The optimizer never offers a route over the centre line (issue #365). A season that names the
 * side the robot stays on in auto (`SeasonRules.ownSide`) makes the other side one more keep-out of
 * the optimizer's world, so the seeds go round it, the search is charged for entering it and the
 * final check's swept test refuses it; and the final check also refuses any route that adds an
 * OPPONENT_SIDE finding. A test season stands in for BIOBUZZ's G402 here: RED's own side is x < 0.
 */

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const robot: Robot = parseRobot({ ...clone(testRobot), heightIn: { value: 12, provenance: "PLACEHOLDER: test fixture" } });

const SIDE: OwnSide = { axis: "x", lineIn: 0, ownSign: -1, toleranceIn: 0.05, rule: "Test rule." };
const season: SeasonRules = { ...noSeasonRules, ownSide: () => SIDE };

/** A post on RED's side, 4 in short of the line: too narrow a gap for the 14 in wide robot to pass east of it. */
const field: Field = parseField({
  ...clone(testField),
  obstacles: [
    {
      id: "post",
      kind: "box",
      minXIn: -40,
      maxXIn: -4,
      minYIn: -4,
      maxYIn: 4,
      minZIn: 0,
      maxZIn: 10,
      solidToRobot: true,
      provenance: "PLACEHOLDER: test fixture",
    },
  ],
});

const autoOf = (route: Record<string, unknown>): Auto =>
  canonicalAuto(
    parseAuto({
      $schema: SCHEMA_ID.auto,
      formatVersion: 4,
      name: "centre-line",
      alliance: "RED",
      start: { pose: { xIn: -14, yIn: -36, headingRad: Math.PI / 2 } },
      steps: [{ id: "route", kind: "path", ...route }],
    }),
  ).auto;

const around = (controlXIn: number): Record<string, unknown> => ({
  segments: [
    {
      kind: "bezier",
      from: "current",
      control: [
        { xIn: controlXIn, yIn: -30 },
        { xIn: controlXIn, yIn: 30 },
      ],
      to: { xIn: -14, yIn: 36 },
    },
  ],
  heading: { mode: "constant", headingRad: Math.PI / 2 },
});

/** How far the route's footprint goes past the line, at its worst; negative when it stays on RED's side. */
function farthestPastIn(auto: Auto): number {
  const planned = plan(resolve(auto), robot, field, { sampleSpacingIn: 0.5 });
  const step = flattenSteps(planned.steps).find((candidate) => candidate.id === "route");
  let worst = -Infinity;
  for (const sample of step?.samples ?? []) {
    for (const polygon of [sample.footprintIn, ...sample.mouthsIn]) {
      for (const corner of polygon) worst = Math.max(worst, pastLineIn(corner, SIDE));
    }
  }
  return worst;
}

const withRoute = (auto: Auto, step: PathStep): Auto => ({ ...auto, steps: updateStep(auto.steps, "step", "route", () => step).steps });

const opponentSide = (auto: Auto) =>
  check(plan(resolve(auto), robot, field), null, robot, field, season).filter((finding) => finding.code === "OPPONENT_SIDE");

const BUDGET = 120;

describe("the optimizer and the centre line", () => {
  it("makes the other side a keep-out of the world only when the season names a side", () => {
    expect(clearanceWorld(robot, field).keepOuts).toEqual([]);
    const world = clearanceWorld(robot, field, SIDE);
    expect(world.keepOuts.map((keepOut) => keepOut.id)).toEqual([CENTRE_LINE_KEEPOUT_ID]);
    // Its face toward RED is the line moved by the tolerance, and it covers everything beyond.
    expect(world.keepOuts[0]?.boxIn.minXIn).toBeCloseTo(0.05, 9);
    expect(world.keepOuts[0]?.boxIn.maxXIn).toBeGreaterThan(72);
    expect(world.keepOuts[0]?.boxIn.minYIn).toBeLessThan(-72);
    expect(world.keepOuts[0]?.boxIn.maxYIn).toBeGreaterThan(72);
  });

  // The original goes the long way round the west of the post. Without the rule the faster way is
  // east of it, over the line; with it, only a west route is left.
  const input: ObjectiveInput = { auto: autoOf(around(-64)), robot, field, stepId: "route" };

  it("takes the faster way east of the post, over the line, when no season rule forbids it", () => {
    const result = runOptimize(input, { budget: BUDGET, scorer: "estimate" });
    expect(result.status).toBe("improved");
    expect(farthestPastIn(withRoute(input.auto, result.step as PathStep))).toBeGreaterThan(SIDE.toleranceIn);
  }, 120_000);

  it("never returns a route over the line when the season names the robot's side", () => {
    const result = runOptimize({ ...input, season }, { budget: BUDGET, scorer: "estimate" });
    // A tighter way round the west of the post is still faster than the original.
    expect(result.status).toBe("improved");
    for (const step of [result.step, ...result.alternatives.map((alternative) => alternative.step)]) {
      if (step === null) continue;
      const routed = withRoute(input.auto, step);
      expect(farthestPastIn(routed)).toBeLessThanOrEqual(SIDE.toleranceIn);
      expect(opponentSide(routed)).toEqual([]);
    }
  }, 120_000);

  it("routes a step that crosses the line back onto its own side in Route around mode", () => {
    // East of the post and over the line by a few inches, otherwise clear.
    const crossing = autoOf(around(12));
    expect(opponentSide(crossing)).toHaveLength(1);
    const result = runOptimize({ auto: crossing, robot, field, season, stepId: "route" }, { budget: BUDGET, scorer: "estimate", routeAround: true, maxPaths: 5 });
    expect(result.status, result.changes.join(" ")).toBe("improved");
    const routed = withRoute(crossing, result.step as PathStep);
    expect(opponentSide(routed)).toEqual([]);
    expect(farthestPastIn(routed)).toBeLessThanOrEqual(SIDE.toleranceIn);
    expect(result.findingsRemoved.map((finding) => finding.code)).toContain("OPPONENT_SIDE");
  }, 120_000);
});
