import { describe, expect, it } from "vitest";
import { noSeasonRules, type SeasonRules } from "../season.js";
import { testRobot } from "../testing/fixtures.js";
import { legalApproachEnd } from "./clearPath.js";

/**
 * The end heading of "Add a clear path here" (issue #310): where the clicked point is a legal approach
 * to the season's current target, the path ends on the heading that approach gives, facing the target;
 * anywhere else the person's default heading mode decides, and this gives nothing.
 */

/** A season with one target at (0, 40), legal from anywhere north of y = 20. */
const season = (withAim: boolean): SeasonRules => ({
  ...noSeasonRules,
  id: "test",
  currentTarget: () => "cell",
  legalApproach: (_state, _target, pose) => pose.yIn >= 20,
  ...(withAim ? { targetPoint: () => ({ xIn: 0, yIn: 40 }) } : {}),
  nearestLegalApproach: (_state, _target, pose) => ({ xIn: pose.xIn, yIn: Math.max(20, pose.yIn), headingRad: 1 }),
});

describe("legalApproachEnd", () => {
  it("faces the target from a point in the legal band", () => {
    const end = legalApproachEnd(season(true), {}, "RED", { xIn: 20, yIn: 20 }, 0, testRobot);
    expect(end).not.toBeNull();
    expect(end?.target).toBe("cell");
    expect(end?.headingRad).toBeCloseTo(Math.atan2(20, -20), 12);
  });

  it("takes the season's own heading when it names no point to face", () => {
    const end = legalApproachEnd(season(false), {}, "RED", { xIn: 20, yIn: 30 }, 0, testRobot);
    expect(end?.headingRad).toBe(1);
  });

  it("gives nothing for a point outside the legal band, or where the season has no target", () => {
    expect(legalApproachEnd(season(true), {}, "RED", { xIn: 20, yIn: 0 }, 0, testRobot)).toBeNull();
    expect(legalApproachEnd(noSeasonRules, {}, "RED", { xIn: 20, yIn: 30 }, 0, testRobot)).toBeNull();
  });

  it("faces the target from a point the season accepts only when the robot faces the target", () => {
    const facingOnly: SeasonRules = {
      ...season(true),
      legalApproach: (_state, _target, pose) => pose.yIn >= 20 && Math.abs(pose.headingRad - Math.atan2(40 - pose.yIn, 0 - pose.xIn)) < 0.1,
    };
    // Driven there heading east, which the season would refuse; facing the target, it accepts it.
    const end = legalApproachEnd(facingOnly, {}, "RED", { xIn: 20, yIn: 30 }, 0, testRobot);
    expect(end?.headingRad).toBeCloseTo(Math.atan2(10, -20), 12);
    const ownHeading: SeasonRules = { ...season(false), legalApproach: (_state, _target, pose) => pose.yIn >= 20 && pose.headingRad === 1 };
    expect(legalApproachEnd(ownHeading, {}, "RED", { xIn: 20, yIn: 30 }, 0, testRobot)?.headingRad).toBe(1);
  });

  it("gives nothing when the heading facing the target would not itself be legal", () => {
    const fussy: SeasonRules = { ...season(true), legalApproach: (_state, _target, pose) => pose.yIn >= 20 && pose.headingRad === 0 };
    expect(legalApproachEnd(fussy, {}, "RED", { xIn: 20, yIn: 30 }, 0, testRobot)).toBeNull();
  });
});
