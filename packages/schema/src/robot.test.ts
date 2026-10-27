import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FORMAT_VERSIONS, SCHEMA_ID } from "./ids.js";
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

describe("where a command came from", () => {
  it("a command, each of its params and a condition may carry a provenance", () => {
    const robot = parseRobot(
      robotWith({
        commands: [
          {
            name: "shootAll",
            params: { count: { type: "integer", provenance: "SET FROM TeamCode/MyRobot.java" } },
            estimateS: "unknown",
            provenance: "SET FROM TeamCode/MyRobot.java; estimateS NEEDS MEASUREMENT",
          },
        ],
        conditions: [{ name: "hopperFull", provenance: "SET FROM TeamCode/MyRobot.java" }],
      }),
    );
    expect(robot.commands[0]?.provenance).toBe("SET FROM TeamCode/MyRobot.java; estimateS NEEDS MEASUREMENT");
    expect(robot.commands[0]?.params?.count?.provenance).toBe("SET FROM TeamCode/MyRobot.java");
    expect(robot.conditions?.[0]?.provenance).toBe("SET FROM TeamCode/MyRobot.java");
  });

  it("an empty provenance is refused, like every other one", () => {
    expect(() => parseRobot(robotWith({ commands: [{ name: "x", estimateS: "0", provenance: "" }] }))).toThrow();
  });
});

/**
 * Owner ruling D8: the clearance from field elements is per robot, the optional `footprint.clearanceIn`
 * `{ value, provenance }`, and adding it leaves `robot.json` at format version 1 like the other
 * optional keys.
 */
describe("footprint.clearanceIn (D8)", () => {
  const footprintWith = (clearanceIn?: unknown): unknown => {
    const robot = robotWith({}) as { footprint: Record<string, unknown> };
    return clearanceIn === undefined ? robot : { ...robot, footprint: { ...robot.footprint, clearanceIn } };
  };

  it("validates a robot without the key, which reads as absent", () => {
    expect(parseRobot(footprintWith()).footprint.clearanceIn).toBeUndefined();
  });

  it("validates a robot with the key, value and provenance kept as written", () => {
    const robot = parseRobot(footprintWith({ value: 2, provenance: "SET BY HAND: test fixture" }));
    expect(robot.footprint.clearanceIn).toEqual({ value: 2, provenance: "SET BY HAND: test fixture" });
  });

  it("keeps robot.json at format version 1", () => {
    expect(FORMAT_VERSIONS.robot).toBe(1);
    expect(parseRobot(footprintWith({ value: 1, provenance: "SET BY HAND: test fixture" })).formatVersion).toBe(1);
  });

  it("accepts 0, which turns the warning off, and refuses a negative clearance", () => {
    expect(parseRobot(footprintWith({ value: 0, provenance: "SET BY HAND: test fixture" })).footprint.clearanceIn?.value).toBe(0);
    expect(() => parseRobot(footprintWith({ value: -1, provenance: "SET BY HAND: test fixture" }))).toThrow();
  });

  it("refuses an infinite clearance, which JSON.parse gives for 1e400 and canonical output would write as null", () => {
    const parsed = JSON.parse('{ "value": 1e400, "provenance": "SET BY HAND: test fixture" }') as unknown;
    expect(() => parseRobot(footprintWith(parsed))).toThrow();
  });

  it("validates the canonical fixture, which carries the key", () => {
    const text = readFileSync(fileURLToPath(new URL("../fixtures/canonical/robot.clearance.json", import.meta.url)), "utf8");
    expect(parseRobot(JSON.parse(text) as unknown).footprint.clearanceIn).toEqual({
      value: 1.5,
      provenance: "SET BY HAND: test fixture, the clearance a team chose for its robot",
    });
  });
});
