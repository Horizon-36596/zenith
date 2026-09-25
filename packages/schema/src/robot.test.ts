import { describe, expect, it } from "vitest";
import { SCHEMA_ID } from "./ids.js";
import { parseRobot } from "./parse.js";

const robotWith = (extra: Record<string, unknown>, centre: Record<string, unknown> = {}): unknown => ({
  $schema: SCHEMA_ID.robot,
  formatVersion: 1,
  name: "Height fixture",
  frame: { forward: "+x", left: "+y", headingZero: "+x", headingPositive: "ccw" },
  footprint: {
    startIn: { lengthIn: 18, widthIn: 14 },
    expandedIn: { lengthIn: 18, widthIn: 14 },
    centreOfRotationIn: { xIn: 0, yIn: 0, ...centre },
  },
  kinematics: {
    maxForwardVelInPerS: { value: 1 },
    maxStrafeVelInPerS: { value: 1 },
    forwardDecelInPerS2: { value: 1 },
    strafeDecelInPerS2: { value: 1 },
    accelInPerS2: { value: 1 },
    maxAngularVelRadPerS: { value: 1 },
    defaultPathSpeedFraction: { value: 1 },
    follower: { library: "pedro", version: "x", holdEnd: true },
  },
  commands: [],
  ...extra,
});

describe("robot numbers Zenith writes itself", () => {
  it("finding 30: the root heightIn carries a provenance like every other constant", () => {
    const robot = parseRobot(robotWith({ heightIn: { value: 24, provenance: "MEASURED 2026-01-01 test fixture" } }));
    expect(robot.heightIn).toEqual({ value: 24, provenance: "MEASURED 2026-01-01 test fixture" });
  });

  it("finding 30: a bare heightIn from an older file reads as an unlabelled wrapper", () => {
    expect(parseRobot(robotWith({ heightIn: 18 })).heightIn).toEqual({ value: 18 });
  });

  it("finding 30: centreOfRotationIn accepts a provenance", () => {
    const robot = parseRobot(robotWith({}, { provenance: "SET BY HAND: footprint centre" }));
    expect(robot.footprint.centreOfRotationIn.provenance).toBe("SET BY HAND: footprint centre");
  });
});
