import { describe, expect, it } from "vitest";
import { frameProblem, headingToField, pointToField, poseToField, presetFrame, presetSeasonWarning, type FrameSpec } from "./frame.js";
import { starterField } from "./testSupport.js";

const close = (actual: number, expected: number): void => expect(actual).toBeCloseTo(expected, 9);

describe("frame conversion to the season's field frame", () => {
  it("puts the Pedro Visualizer's centre, (70.75, 70.75), at the field origin", () => {
    const p = pointToField(presetFrame("pedro"), 70.75, 70.75);
    close(p.xIn, 0);
    close(p.yIn, 0);
  });

  it("converts the visualizer's default start, (56, 8, 90 degrees), by translation alone", () => {
    const pose = poseToField(presetFrame("pedro"), 56, 8, 90);
    close(pose.xIn, 56 - 70.75);
    close(pose.yIn, 8 - 70.75);
    close(pose.headingRad, Math.PI / 2);
  });

  it("takes a different Pedro centre when a team uses (72, 72)", () => {
    const p = pointToField(presetFrame("pedro", 72), 72, 0);
    close(p.xIn, 0);
    close(p.yIn, -72);
  });

  it("turns a RoadRunner pose a quarter turn: (x, y, h) to (y, -x, h - pi/2)", () => {
    // MeepMeep (63, -40) facing pi is the RED start against the south wall facing north.
    const pose = poseToField(presetFrame("roadrunner"), 63, -40, Math.PI);
    close(pose.xIn, -40);
    close(pose.yIn, -63);
    close(pose.headingRad, Math.PI / 2);
  });

  it("reads an explicit, mirrored, millimetre frame with clockwise degrees from +y", () => {
    const frame: FrameSpec = {
      originIn: { xIn: -72, yIn: -72 },
      xAxis: "+y",
      yAxis: "+x",
      units: "mm",
      headingUnit: "deg",
      headingZero: "+y",
      headingPositive: "cw",
    };
    const p = pointToField(frame, 254, 0);
    close(p.xIn, -72);
    close(p.yIn, -62);
    // Heading 0 points along the planner's +y, which is the field's +x.
    close(headingToField(frame, 0), 0);
    // Ninety degrees clockwise from the planner's +y is the planner's +x, which is the field's +y.
    close(headingToField(frame, 90), Math.PI / 2);
  });

  it("refuses two axes along the same field direction", () => {
    expect(frameProblem({ ...presetFrame("zenith"), yAxis: "-x" })).toMatch(/frame\.xAxis/);
    expect(frameProblem(presetFrame("roadrunner"))).toBeNull();
  });

  it("warns when a preset is used on a season it was not checked against", () => {
    const field = starterField();
    expect(presetSeasonWarning("pedro", field)).toBeNull();
    expect(presetSeasonWarning("roadrunner", { ...field, season: "decode" })).toMatch(/checked against biobuzz only/);
  });
});
