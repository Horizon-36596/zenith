import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalize } from "./canonicalize.js";
import { loadField, loadRobot } from "./load.js";
import { simFollowerParams, simPlantParams } from "./sim/index.js";

/**
 * The instant sim's robot keys as the rest of core sees them: written in a deterministic order,
 * derived from the starter robot's kinematics when the file carries no gains, and read by the sim
 * instead of those fallbacks when it does.
 */

const root = new URL("../../../examples/starter/autos/", import.meta.url);
const read = (relative: string): unknown => JSON.parse(readFileSync(new URL(relative, root), "utf8"));

describe("sim keys: canonical form and the example robot", () => {
  it("writes the follower keys in one order whatever order they were read in", () => {
    const example = read("robot.json") as { kinematics: { follower: Record<string, unknown> } };
    const shuffled = structuredClone(example);
    shuffled.kinematics.follower = Object.fromEntries(Object.entries(example.kinematics.follower).reverse());
    expect(canonicalize("robot", loadRobot(shuffled))).toBe(canonicalize("robot", loadRobot(example)));
  });

  it("derives the starter's follower and plant from its kinematics, which carry no gains", () => {
    const robot = loadRobot(read("robot.json"));
    const field = loadField(read("field/biobuzz.field.json"));
    const follower = simFollowerParams(robot);
    expect(follower.forwardTranslationalPowerPerIn).toBe(0.07);
    expect(follower.headingPowerPerRad).toBe(1.5);
    expect(follower.cosineScale).toBe(true);
    expect(follower.coastFeedforwardPowerPerInPerS).toBeCloseTo(1 / 60, 12);
    // 2 * accel / maxForwardVel = 2 * 60 / 60, and maxForwardVel / maxAngularVel = 60 / 6.
    expect(simPlantParams(robot, field, "robot").wheelResponseRatePerS).toBe(2);
    expect(simPlantParams(robot, field, "robot").leverArmIn).toBe(10);
    expect(robot.conditions?.filter((condition) => condition.ledger !== undefined).map((condition) => condition.name))
      .toEqual(["hopperFull", "hopperEmpty"]);
  });

  it("reads gains and drivetrain geometry from the file instead of the fallbacks", () => {
    const example = read("robot.json") as { kinematics: Record<string, unknown> & { follower: Record<string, unknown> } };
    const tuned = structuredClone(example);
    tuned.kinematics.follower = {
      ...tuned.kinematics.follower,
      forwardTranslationalPowerPerIn: { value: 0.15, provenance: "PLACEHOLDER: test fixture" },
      headingPowerPerRad: { value: 2, provenance: "PLACEHOLDER: test fixture" },
      cosineScale: false,
    };
    tuned.kinematics.drivetrain = {
      trackWidthIn: { value: 13, provenance: "PLACEHOLDER: test fixture" },
      wheelBaseIn: { value: 11, provenance: "PLACEHOLDER: test fixture" },
      wheelResponseRatePerS: { value: 4, provenance: "PLACEHOLDER: test fixture" },
    };
    const robot = loadRobot(tuned);
    const field = loadField(read("field/biobuzz.field.json"));
    const follower = simFollowerParams(robot);
    expect(follower.forwardTranslationalPowerPerIn).toBe(0.15);
    expect(follower.headingPowerPerRad).toBe(2);
    expect(follower.cosineScale).toBe(false);
    expect(simPlantParams(robot, field, "robot").wheelResponseRatePerS).toBe(4);
    expect(simPlantParams(robot, field, "robot").leverArmIn).toBe(12);
  });
});
