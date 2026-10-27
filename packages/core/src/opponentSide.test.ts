import { parseAuto, SCHEMA_ID, type Auto } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { check } from "./check.js";
import { plan } from "./plan.js";
import { resolve } from "./resolve.js";
import { noSeasonRules, pastLineIn, type OwnSide, type SeasonRules } from "./season.js";
import { testField, testRobot } from "./testing/fixtures.js";

/**
 * OPPONENT_SIDE in the core (issue #365): the season says where the line is and the core sweeps the
 * footprints. The BIOBUZZ rule itself, G402, is tested in `season-biobuzz/src/opponentSide.test.ts`.
 * A test season stands in for it here: RED's own side is x < 0.
 */

const SIDE: OwnSide = { axis: "x", lineIn: 0, ownSign: -1, toleranceIn: 0.05, rule: "Test rule." };
const season: SeasonRules = { ...noSeasonRules, ownSide: () => SIDE };

const autoOf = (steps: unknown[]): Auto =>
  parseAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: 4,
    name: "centre-line",
    alliance: "RED",
    start: { pose: { xIn: -40, yIn: -40, headingRad: 0 } },
    steps,
  });

/** East along y = -40 to x = `xIn`; the test robot's nose is 9 in ahead of its centre. */
const east = (id: string, xIn: number): unknown => ({
  id,
  kind: "path",
  segments: [{ kind: "line", from: "current", to: { xIn, yIn: -40 } }],
  heading: { mode: "tangent" },
});

const over = (auto: Auto, rules: SeasonRules = season) =>
  check(plan(resolve(auto), testRobot, testField), null, testRobot, testField, rules).filter((f) => f.code === "OPPONENT_SIDE");

describe("OPPONENT_SIDE", () => {
  it("measures past the line on the season's own side", () => {
    expect(pastLineIn({ xIn: 3, yIn: 0 }, SIDE)).toBe(3);
    expect(pastLineIn({ xIn: -3, yIn: 0 }, SIDE)).toBe(-3);
    expect(pastLineIn({ xIn: 0, yIn: 3 }, { axis: "y", lineIn: 1, ownSign: 1 })).toBe(-2);
  });

  it("checks nothing when the season names no side", () => {
    expect(over(autoOf([east("drive", 10)]), noSeasonRules)).toEqual([]);
  });

  it("reports the member of a group that crosses, not the group, and the robot standing there after it once", () => {
    const auto = autoOf([
      { id: "together", kind: "parallel", mode: "all", steps: [east("drive", -5), { id: "spin", kind: "command", name: "setIntake" }] },
      { id: "stand", kind: "wait", seconds: 1 },
    ]);
    const found = over(auto);
    expect(found.map((finding) => finding.stepId)).toEqual(["drive"]);
    expect(found[0]?.severity).toBe("error");
    expect(found[0]?.message).toMatch(/^The robot crosses the centre line into BLUE's side .* 4\.00 in over\. Test rule\.$/);
  });

  it("offers Route around only when both ends of the path are on the alliance's own side (W2-14)", () => {
    const routeAround = (auto: Auto): boolean[] =>
      over(auto).map((finding) => (finding.fixes ?? []).some((fix) => fix.kind === "optimizeRoute"));
    // Bowed over the line between two ends on RED's side: a route that keeps off it exists.
    const bowed = {
      id: "bow",
      kind: "path",
      segments: [
        {
          kind: "bezier",
          from: "current",
          control: [
            { xIn: 20, yIn: -30 },
            { xIn: 20, yIn: 30 },
          ],
          to: { xIn: -40, yIn: 40 },
        },
      ],
      heading: { mode: "constant", headingRad: 0 },
    };
    expect(routeAround(autoOf([bowed]))).toEqual([true]);
    // Ending with the nose 4 in over the line: every route to that end crosses, so there is none.
    expect(routeAround(autoOf([east("drive", -5)]))).toEqual([false]);
    // Starting over it, where the path before left the robot: the same from that end.
    expect(routeAround(autoOf([east("drive", -5), { id: "back", kind: "path", segments: [{ kind: "line", from: "current", to: { xIn: -40, yIn: -40 } }], heading: { mode: "constant", headingRad: 0 } }]))).toEqual([false, false]);
  });

  it("reports a step that only stands over the line, when it is the first to stand there", () => {
    // A path that ends over the line is reported on the path; a wait after it is not reported again.
    expect(over(autoOf([east("drive", -5), { id: "stand", kind: "wait", seconds: 1 }])).map((f) => f.stepId)).toEqual(["drive"]);
  });
});
