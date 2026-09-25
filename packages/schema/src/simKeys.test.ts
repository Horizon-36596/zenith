import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SCHEMA_ID } from "./ids.js";
import { parseRobot } from "./parse.js";
import { FOLLOWER_GAIN_KEYS, FOLLOWER_SWITCH_KEYS } from "./robot.js";

/**
 * The instant sim's robot keys (site/docs/file-format.md): the follower gains and
 * switches, the drivetrain, and `conditions[].ledger`. They are optional additions, so a robot file
 * without them still reads, and no format version changes.
 */

const baseRobot = (follower: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  $schema: SCHEMA_ID.robot,
  formatVersion: 1,
  name: "Sim keys fixture",
  frame: { forward: "+x", left: "+y", headingZero: "+x", headingPositive: "ccw" },
  footprint: {
    startIn: { lengthIn: 18, widthIn: 18 },
    expandedIn: { lengthIn: 18, widthIn: 18 },
    centreOfRotationIn: { xIn: 0, yIn: 0 },
  },
  kinematics: {
    maxForwardVelInPerS: { value: 1 },
    maxStrafeVelInPerS: { value: 1 },
    forwardDecelInPerS2: { value: 1 },
    strafeDecelInPerS2: { value: 1 },
    accelInPerS2: { value: 1 },
    maxAngularVelRadPerS: { value: 1 },
    defaultPathSpeedFraction: { value: 1 },
    follower: { library: "pedro", version: "x", holdEnd: true, ...follower },
    ...extra,
  },
  commands: [],
});

describe("sim keys: robot.json keeps what the instant sim reads", () => {
  it("keeps every follower gain and both switches, bare or wrapped", () => {
    const gains = Object.fromEntries(
      FOLLOWER_GAIN_KEYS.map((key, index) => [key, { value: index / 10, provenance: "SET BY HAND: fixture" }]),
    );
    const robot = parseRobot(
      baseRobot({ ...gains, cosineScale: false, turnBeforeDriving: { value: true, provenance: "SET BY HAND: fixture" } }),
    );
    const follower = robot.kinematics.follower as Record<string, unknown>;
    expect(FOLLOWER_GAIN_KEYS).toHaveLength(24);
    for (const key of FOLLOWER_GAIN_KEYS) expect(follower[key], key).toEqual(gains[key]);
    expect(FOLLOWER_SWITCH_KEYS).toEqual(["cosineScale", "turnBeforeDriving"]);
    expect(follower["cosineScale"]).toBe(false);
    expect(follower["turnBeforeDriving"]).toEqual({ value: true, provenance: "SET BY HAND: fixture" });
  });

  it("keeps the drivetrain and a condition's ledger meaning", () => {
    const robot = parseRobot({
      ...baseRobot({}, {
        drivetrain: {
          trackWidthIn: { value: 13.5, provenance: "MEASURED: fixture" },
          wheelBaseIn: { value: 10.5 },
          wheelResponseRatePerS: { value: 4 },
        },
      }),
      conditions: [{ name: "hopperFull", ledger: "full" }, { name: "hopperEmpty", ledger: "empty" }, { name: "seen" }],
    });
    expect(robot.kinematics.drivetrain?.trackWidthIn).toEqual({ value: 13.5, provenance: "MEASURED: fixture" });
    expect(robot.conditions?.map((condition) => condition.ledger)).toEqual(["full", "empty", undefined]);
  });

  it("rejects a ledger meaning other than full or empty, and a gain written as a bare string", () => {
    expect(() => parseRobot({ ...baseRobot(), conditions: [{ name: "x", ledger: "half" }] })).toThrow();
    expect(() => parseRobot(baseRobot({ maxBrakingPower: "0.3" }))).toThrow();
  });

  it("still reads a robot file with none of them, at formatVersion 1", () => {
    const robot = parseRobot(baseRobot());
    expect(Object.keys(robot.kinematics.follower)).toEqual(["library", "version", "holdEnd"]);
    expect(robot.kinematics.drivetrain).toBeUndefined();
  });

  it("publishes them in the JSON Schema", () => {
    const json = readFileSync(new URL("../json/robot.json", import.meta.url), "utf8");
    for (const key of [...FOLLOWER_GAIN_KEYS, ...FOLLOWER_SWITCH_KEYS, "drivetrain", "wheelResponseRatePerS"]) {
      expect(json, key).toContain(`"${key}"`);
    }
    expect(json).toMatch(/"full",\s*"empty"/);
  });
});
