import type { Heading } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { makePath } from "../geometry/path.js";
import { headingFunction } from "../heading.js";
import { headingProblem, rangesHeading, type CandidateRange, type RouteEnds } from "./candidate.js";
import { headingHoldProblem, holdsActive, holdSpan, holdWords, NO_HOLDS, withHolds } from "./holds.js";

/**
 * The heading holds of issue #448: "hold the start heading for the first N in" and "hold the end
 * heading for the last N in", 0 off. `withHolds` writes them into a heading seed and
 * `headingHoldProblem` says whether a heading keeps them, which the emitter and the hard final check
 * both ask.
 */

/** A 100 in line along +x, so a range's t is its inches over 100. */
const line = makePath([
  [
    { xIn: 0, yIn: 0 },
    { xIn: 100, yIn: 0 },
  ],
]);

/** The robot arrives facing 90 degrees off the line and must end facing along it, as in the issue. */
const ends: RouteEnds = { startIn: { xIn: 0, yIn: 0 }, endIn: { xIn: 100, yIn: 0 }, arrivalHeadingRad: Math.PI / 2, endHeadingRad: -0.5 };

/** Turn onto the line over the first 20 in, drive it nose first, turn to E over the last 10 in. */
const turnPlan: CandidateRange[] = [
  { mode: "linear", endT: 0.2 },
  { mode: "tangent", endT: 0.9 },
  { mode: "linear", endT: 1 },
];

const headingOf = (ranges: readonly CandidateRange[]): Heading => {
  const heading = rangesHeading(ranges, line, ends);
  if (typeof heading === "string") throw new Error(heading);
  return heading;
};

describe("the heading holds", () => {
  it("are off at 0, which leaves a seed as it is", () => {
    expect(holdsActive(NO_HOLDS)).toBe(false);
    expect(withHolds(turnPlan, line, ends, NO_HOLDS)).toEqual(turnPlan);
    expect(headingHoldProblem(headingOf(turnPlan), line, ends, NO_HOLDS)).toBeNull();
  });

  it("round the span outward to the four decimals ranges are written on", () => {
    const curve = makePath([
      [
        { xIn: 0, yIn: 0 },
        { xIn: 30, yIn: 0 },
      ],
    ]);
    // 7 in of 30 is 0.23333..., which rounds up so the start hold is never cut short; the end hold rounds down.
    expect(holdSpan(curve, { startIn: 7, endIn: 7 })).toEqual({ startT: 0.2334, endT: 0.7666 });
    expect(holdSpan(line, { startIn: 0, endIn: 12 })).toEqual({ startT: 0, endT: 0.88 });
  });

  it("write the start heading and E's heading into a seed, keeping it continuous", () => {
    const holds = { startIn: 10, endIn: 15 };
    const held = withHolds(turnPlan, line, ends, holds);
    expect(held).toEqual([
      { mode: "constant", endT: 0.1 },
      { mode: "linear", endT: 0.25 },
      { mode: "tangent", endT: 0.775 },
      { mode: "linear", endT: 0.85, endHeadingRad: -0.5 },
      { mode: "constant", endT: 1 },
    ]);
    const heading = headingOf(held as CandidateRange[]);
    expect(headingProblem(heading, line, ends)).toBeNull();
    expect(headingHoldProblem(heading, line, ends, holds)).toBeNull();
    const at = headingFunction(heading, line);
    expect(at(0.05)).toBeCloseTo(Math.PI / 2, 4);
    expect(at(0.9)).toBeCloseTo(-0.5, 4);
  });

  it("join a constant seed's own range to the start hold", () => {
    expect(withHolds([{ mode: "constant", endT: 0.5 }, { mode: "linear", endT: 1 }], line, ends, { startIn: 10, endIn: 0 })).toEqual([
      { mode: "constant", endT: 0.55 },
      { mode: "linear", endT: 1 },
    ]);
  });

  it("leave no room for a seed whose ranges would be narrower than the narrowest range", () => {
    expect(withHolds(turnPlan, line, ends, { startIn: 49, endIn: 49 })).toBeNull();
    // Holds that meet keep one heading from end to end, which only a route whose ends agree has.
    expect(withHolds(turnPlan, line, ends, { startIn: 60, endIn: 40 })).toBeNull();
    expect(withHolds(turnPlan, line, { ...ends, endHeadingRad: Math.PI / 2 }, { startIn: 60, endIn: 40 })).toEqual([{ mode: "constant", endT: 1 }]);
  });

  it("find a heading that turns inside a hold, and name which", () => {
    const heading = headingOf(turnPlan);
    expect(headingHoldProblem(heading, line, ends, { startIn: 10, endIn: 0 })).toMatch(/first 10 in/);
    expect(headingHoldProblem(heading, line, ends, { startIn: 0, endIn: 5 })).toMatch(/last 5 in/);
    expect(headingHoldProblem(heading, line, ends, { startIn: 60, endIn: 50 })).toMatch(/shorter than the heading holds together \(110 in\)/);
  });

  it("let holds that overlap stand when the route's two ends face the same way", () => {
    const agreeing: RouteEnds = { ...ends, endHeadingRad: Math.PI / 2 };
    const held: Heading = { mode: "constant", headingRad: Math.PI / 2 };
    // 60 in and 50 in of a 100 in route overlap; one heading held from end to end keeps both.
    expect(headingHoldProblem(held, line, agreeing, { startIn: 60, endIn: 50 })).toBeNull();
    // The per-hold tests still decide: a heading that turns inside them breaks them.
    expect(headingHoldProblem({ mode: "tangent" }, line, agreeing, { startIn: 60, endIn: 50 })).toMatch(/first 60 in/);
  });

  describe("on a bend, beside a tangent range", () => {
    /** A cubic from facing +x at the start to facing +y at the end, so its tangent turns a quarter turn. */
    const bend = makePath([
      [
        { xIn: 0, yIn: 0 },
        { xIn: 40, yIn: 0 },
        { xIn: 100, yIn: 60 },
        { xIn: 100, yIn: 100 },
      ],
    ]);
    /** The robot arrives along the tangent and must end along it, so H-tan is one tangent range. */
    const bendEnds: RouteEnds = { startIn: { xIn: 0, yIn: 0 }, endIn: { xIn: 100, yIn: 100 }, arrivalHeadingRad: 0, endHeadingRad: Math.PI / 2 };
    const holds = { startIn: 10, endIn: 10 };
    const bendHeading = (ranges: readonly CandidateRange[]): Heading => {
      const heading = rangesHeading(ranges, bend, bendEnds);
      if (typeof heading === "string") throw new Error(heading);
      return heading;
    };

    it("turn onto the tangent after the start hold and into E's heading before the end hold", () => {
      const { startT, endT } = holdSpan(bend, holds);
      const held = withHolds([{ mode: "tangent", endT: 1 }], bend, bendEnds, holds);
      expect(held).toEqual([
        { mode: "constant", endT: startT },
        { mode: "linear", endT: Math.round(2 * startT * 10000) / 10000 },
        { mode: "tangent", endT: Math.round((endT - (1 - endT)) * 10000) / 10000 },
        { mode: "linear", endT, endHeadingRad: Math.PI / 2 },
        { mode: "constant", endT: 1 },
      ]);
      const heading = bendHeading(held as CandidateRange[]);
      expect(headingProblem(heading, bend, bendEnds)).toBeNull();
      expect(headingHoldProblem(heading, bend, bendEnds, holds)).toBeNull();
    });

    it("find the jump where a constant hold meets a tangent range that has bent away", () => {
      const { startT } = holdSpan(bend, holds);
      const jumping = bendHeading([
        { mode: "constant", endT: startT },
        { mode: "tangent", endT: 1 },
      ]);
      expect(headingHoldProblem(jumping, bend, bendEnds, { startIn: 10, endIn: 0 })).toMatch(/jumps .* where the start heading hold meets the next range/);
    });

    it("drop the seed when the turn leaves no room for the tangent range", () => {
      expect(withHolds([{ mode: "tangent", endT: 1 }], bend, bendEnds, { startIn: 40, endIn: 40 })).toBeNull();
    });
  });

  it("say in words which holds are on", () => {
    expect(holdWords({ startIn: 12, endIn: 0 })).toBe("its start heading over the first 12 in");
    expect(holdWords({ startIn: 6, endIn: 12.5 })).toBe("its start heading over the first 6 in and its end heading over the last 12.5 in");
  });
});
