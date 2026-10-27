import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseAuto, parseField, parseRobot, SCHEMA_ID, type Auto, type Field, type PathStep, type Robot } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { check } from "../check.js";
import { estimate } from "../estimate.js";
import { loadField, loadLink, loadRobot, loadWaypoints } from "../load.js";
import { plan } from "../plan.js";
import { resolve } from "../resolve.js";
import { noSeasonRules, type OwnSide, type SeasonRules } from "../season.js";
import { testField, testRobot } from "../testing/fixtures.js";
import { canonicalAuto } from "./candidate.js";
import { MIN_TIME_GAIN_S } from "./final.js";
import { runOptimize } from "./index.js";
import { TIME_EPSILON_S, type ObjectiveInput } from "./objective.js";

/**
 * Optimize path on an original that goes through something (issue #388). `check()` reports a collision on
 * such a route, so it is blocked and was never a time a legal route could beat: every run, not only a
 * finding's Route around, returns the fastest route it finds that passes the check, even when that is
 * slower, says what the original goes through, and says `infeasible` when there is no clear route
 * between the step's ends.
 */

const root = fileURLToPath(new URL("../../../../examples/starter/", import.meta.url));
const read = (relative: string): unknown => JSON.parse(readFileSync(`${root}${relative}`, "utf8"));
const link = loadLink(read("zenith.json"));
const starterRobot = loadRobot(read(link.robot));
const starterField = loadField(read(link.field));
const waypoints = loadWaypoints(read(link.waypoints ?? "autos/waypoints.json"));

/** RED's own side is x < 0, as G402 has it for the starter. */
const SIDE: OwnSide = { axis: "x", lineIn: 0, ownSign: -1, toleranceIn: 0.05, rule: "Test rule." };

/**
 * A season that names the hive frame's parts the way BIOBUZZ does and keeps the robot on RED's
 * side, standing in for the season package, which core does not depend on.
 */
const season: SeasonRules = {
  ...noSeasonRules,
  ownSide: () => SIDE,
  obstacleLabel: (id) => {
    const bar = /^frameBar(East|West)$/.exec(id);
    if (bar !== null) return `the ${(bar[1] ?? "").toLowerCase()} base bar of the hive frame`;
    const leg = /^frameLeg(North|South)(East|West)$/.exec(id);
    if (leg !== null) return `the ${(leg[1] ?? "").toLowerCase()}-${(leg[2] ?? "").toLowerCase()} leg of the hive frame`;
    return null;
  },
};

const STEP = "pastTheHive";

/**
 * One path on the starter's field from south of the hive frame's west base bar to north of it, a
 * straight line along the bar and so through it: the fastest route there is, and not one the robot
 * can drive. Every way round is longer.
 */
function throughTheHive(): Auto {
  return canonicalAuto(
    parseAuto({
      $schema: SCHEMA_ID.auto,
      formatVersion: 4,
      name: "through-the-hive",
      alliance: "RED",
      start: { pose: { xIn: -23.65, yIn: -40, headingRad: Math.PI / 2 } },
      steps: [
        {
          id: STEP,
          kind: "path",
          segments: [{ kind: "line", from: "current", to: { xIn: -23.65, yIn: 40 } }],
          heading: { mode: "constant", headingRad: Math.PI / 2 },
        },
      ],
    }),
  ).auto;
}

const findingsOf = (auto: Auto, robot: Robot, field: Field) => {
  const planned = plan(resolve(auto, waypoints, robot), robot, field);
  return check(planned, estimate(planned, robot), robot, field, season);
};

const withStep = (auto: Auto, step: PathStep): Auto =>
  canonicalAuto({ ...auto, steps: auto.steps.map((old) => (old.id === step.id ? step : old)) } as Auto).auto;

describe("an original through the hive frame", () => {
  const auto = throughTheHive();
  const input: ObjectiveInput = { auto, robot: starterRobot, field: starterField, waypoints, season, stepId: STEP };

  it("goes through the frame as written", () => {
    const structures = findingsOf(auto, starterRobot, starterField).filter((finding) => finding.stepId === STEP && finding.code === "STRUCTURE");
    expect(structures.length).toBeGreaterThan(0);
  });

  it("gets the fastest clear route from a plain run, and the result says what the original goes through", () => {
    const result = runOptimize(input, { budget: 200 });
    expect(result.status, result.changes.join(" ")).toBe("improved");
    expect(result.originalBlocked).toMatchObject({ step: 4, code: "STRUCTURE" });
    expect(result.originalBlocked?.label).toMatch(/of the hive frame$/);
    expect(result.originalBlocked?.phrase).toBe(`goes through ${result.originalBlocked?.label ?? ""}`);
    const pick = result.pick;
    if (pick === null) throw new Error("expected a clear route");
    // The route is clear of the frame: check() finds no STRUCTURE on it.
    const routed = withStep(auto, pick.step);
    expect(findingsOf(routed, starterRobot, starterField).filter((finding) => finding.stepId === STEP && finding.code === "STRUCTURE")).toEqual([]);
    expect(result.findingsRemoved.map((finding) => finding.code)).toContain("STRUCTURE");
    // The first sentence says so plainly, with the time against the original: the instant sim's,
    // or the estimate's when the sim cannot time an original that drives through the frame.
    expect(result.changes[0]).toMatch(
      new RegExp(
        `^The original goes through ${result.originalBlocked?.label ?? ""}, so this is the fastest clear route found: it (is \\d+\\.\\d\\d s (slower|faster)|takes the same time) in the (instant sim|estimate)`,
      ),
    );
    // And it stays on its own side of the centre line.
    expect(findingsOf(routed, starterRobot, starterField).filter((finding) => finding.stepId === STEP && finding.code === "OPPONENT_SIDE")).toEqual([]);
    expect(result.changes.join(" ")).not.toMatch(/0\.00 s/);
  }, 120_000);

  it("is the same with or without routeAround, which a collision check() reports already gets in every run", () => {
    const plain = runOptimize(input, { budget: 40 });
    const around = runOptimize(input, { budget: 40, routeAround: true });
    expect({ ...around, inputKey: plain.inputKey }).toStrictEqual(plain);
  }, 120_000);
});

/**
 * The starter's own steps, which `check()` passes (the review of PR #395). Each comes within the
 * margin or rides the wall only where the swept tests look closer than `check()` does: toScoreNorth
 * on the plan near the foot of flower1, and collectFlower, sweepGarden and driveBack in the instant
 * sim's tracking. Such an original is not blocked. Those tests are advisory for it: a route must be no
 * worse than it, and still faster by one sim tick, so the result is improved or no better, never
 * infeasible, and never says the original goes through anything the editor does not show.
 */
describe("a starter step that check() passes", () => {
  const starter = parseAuto(read("autos/collect-and-score.auto.json"));
  // A third of the default budget gives each of these four steps the status and the pick the default gives, in about a third of the time.
  const BUDGET = 250;
  const run = (stepId: string) => runOptimize({ auto: starter, robot: starterRobot, field: starterField, waypoints, season, stepId }, { budget: BUDGET });
  const collisions = (stepId: string) =>
    findingsOf(starter, starterRobot, starterField).filter(
      (finding) => finding.stepId === stepId && ["STRUCTURE", "PERIMETER", "KEEPOUT", "OPPONENT_SIDE"].includes(finding.code),
    );
  const sentences = (result: ReturnType<typeof run>): string =>
    [...result.changes, ...(result.pick?.changes ?? []), ...result.alternatives.flatMap((route) => route.changes)].join(" ");

  for (const stepId of ["toScoreNorth", "sweepGarden", "driveBack"]) {
    it(`gives ${stepId} a faster route or none, never infeasible, and never says the original goes through anything`, () => {
      expect(collisions(stepId)).toEqual([]);
      const result = run(stepId);
      expect(["improved", "noBetter"], sentences(result)).toContain(result.status);
      expect(result.originalBlocked).toBeNull();
      expect(result.closest).toBeNull();
      expect(sentences(result)).not.toMatch(/The original/);
      if (result.pick !== null) expect(result.pick.gainS ?? 0).toBeGreaterThanOrEqual(MIN_TIME_GAIN_S - TIME_EPSILON_S);
    }, 120_000);
  }

  it("calls collectFlower no better: a heading changed at the same time is not a pick", () => {
    expect(collisions("collectFlower")).toEqual([]);
    const result = run("collectFlower");
    expect(result.status, sentences(result)).toBe("noBetter");
    expect(result.pick).toBeNull();
    expect(result.originalBlocked).toBeNull();
    expect(sentences(result)).not.toMatch(/The original/);
  }, 120_000);
});

describe("an original with no clear route between its ends", () => {
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  const robot: Robot = parseRobot({ ...clone(testRobot), heightIn: { value: 12, provenance: "PLACEHOLDER: test fixture" } });
  // A wall of a box across the whole field, between the two ends: nothing goes round it.
  const field: Field = parseField({
    ...clone(testField),
    obstacles: [
      { id: "barrier", kind: "box", minXIn: -4, maxXIn: 4, minYIn: -80, maxYIn: 80, minZIn: 0, maxZIn: 10, solidToRobot: true, provenance: "PLACEHOLDER: test fixture" },
    ],
    zones: [],
  });
  const auto: Auto = canonicalAuto(
    parseAuto({
      $schema: SCHEMA_ID.auto,
      formatVersion: 4,
      name: "no-way-round",
      alliance: "RED",
      start: { pose: { xIn: -48, yIn: 0, headingRad: 0 } },
      steps: [{ id: "route", kind: "path", segments: [{ kind: "line", from: "current", to: { xIn: 48, yIn: 0 } }], heading: { mode: "constant", headingRad: 0 } }],
    }),
  ).auto;

  it("is infeasible, never no better, and says what the original goes through", () => {
    const result = runOptimize({ auto, robot, field, stepId: "route" }, { budget: 120, scorer: "estimate" });
    expect(result.status).toBe("infeasible");
    expect(result.pick).toBeNull();
    expect(result.originalBlocked).toMatchObject({ step: 4, code: "STRUCTURE", label: 'the structure "barrier"', phrase: 'goes through the structure "barrier"' });
    expect(result.changes[0]).toBe('The original goes through the structure "barrier", and no clear route was found between the step\'s two ends.');
    expect(result.closest).not.toBeNull();
  }, 120_000);
});
