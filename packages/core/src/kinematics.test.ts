import { DEFAULT_ROBOT_HEIGHT_IN, type Robot } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { DEFAULT_ROBOT_HEIGHT_PROVENANCE, robotHeightIn, robotHeightProvenance } from "./kinematics.js";
import { testRobot } from "./testing/fixtures.js";

const withHeights = (root: string | undefined, footprint: string | undefined): Robot => {
  const { heightIn: _rootHeight, ...rest } = testRobot;
  const { heightIn: _footprintHeight, ...footprintRest } = testRobot.footprint;
  return {
    ...rest,
    footprint: {
      ...footprintRest,
      ...(footprint === undefined ? {} : { heightIn: { value: 12, provenance: footprint } }),
    },
    ...(root === undefined ? {} : { heightIn: { value: 30, provenance: root } }),
  } as Robot;
};

describe("robotHeightProvenance: the provenance of the height robotHeightIn reads", () => {
  it("is the root key's when both keys are given", () => {
    const robot = withHeights("MEASURED: root", "APPROX: footprint");
    expect(robotHeightIn(robot)).toBe(30);
    expect(robotHeightProvenance(robot)).toBe("MEASURED: root");
  });

  it("is the footprint key's when the root key is missing", () => {
    const robot = withHeights(undefined, "APPROX: footprint");
    expect(robotHeightIn(robot)).toBe(12);
    expect(robotHeightProvenance(robot)).toBe("APPROX: footprint");
  });

  it("says PLACEHOLDER for the default when neither key is given", () => {
    const robot = withHeights(undefined, undefined);
    expect(robotHeightIn(robot)).toBe(DEFAULT_ROBOT_HEIGHT_IN);
    expect(robotHeightProvenance(robot)).toBe(DEFAULT_ROBOT_HEIGHT_PROVENANCE);
    expect(DEFAULT_ROBOT_HEIGHT_PROVENANCE.startsWith("PLACEHOLDER")).toBe(true);
  });
});
