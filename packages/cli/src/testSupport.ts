import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCHEMA_ID } from "@horizon36596/zenith-schema";

/**
 * A small, self-contained project fixture for the new verbs' tests: not the real biobuzz field
 * (`packages/core/src/testing/fixtures.ts` explains why a core test avoids that), and not
 * `examples/starter` either, so these tests do not depend on a season package's own numbers. Kept
 * here (not a `.test.ts`) so every command's test file can share it.
 */

export const TEST_FIELD = {
  $schema: SCHEMA_ID.field,
  formatVersion: 1,
  season: "test",
  name: "Test field",
  frame: {
    origin: "centre",
    xAxis: "audienceRight",
    yAxis: "awayFromAudience",
    headingZero: "+x",
    headingPositive: "ccw",
    units: "in",
    canonicalAlliance: "RED",
    mirror: "pointSymmetry",
  },
  sizeIn: { xIn: 144, yIn: 144 },
  periods: { autoS: 30, teleopS: 120 },
  obstacles: [
    {
      id: "postBox",
      kind: "box",
      minXIn: -10,
      maxXIn: 10,
      minYIn: -10,
      maxYIn: 10,
      minZIn: 0,
      maxZIn: 40,
      solidToRobot: true,
      provenance: "PLACEHOLDER: test fixture",
    },
  ],
};

export const TEST_ROBOT = {
  $schema: SCHEMA_ID.robot,
  formatVersion: 1,
  name: "Test robot",
  frame: { forward: "+x", left: "+y", headingZero: "+x", headingPositive: "ccw" },
  footprint: {
    startIn: { lengthIn: 18, widthIn: 14, provenance: "PLACEHOLDER: test fixture" },
    expandedIn: { lengthIn: 18, widthIn: 14, provenance: "PLACEHOLDER: test fixture" },
    centreOfRotationIn: { xIn: 0, yIn: 0, provenance: "PLACEHOLDER: test fixture" },
  },
  heightIn: { value: 18, provenance: "PLACEHOLDER: test fixture" },
  kinematics: {
    maxForwardVelInPerS: { value: 72.3456, provenance: "MEASURED test fixture" },
    maxStrafeVelInPerS: { value: 61.2345, provenance: "MEASURED test fixture" },
    forwardDecelInPerS2: { value: 83.4567, provenance: "MEASURED test fixture" },
    strafeDecelInPerS2: { value: 40, provenance: "MEASURED test fixture" },
    accelInPerS2: { value: 90, provenance: "PLACEHOLDER: test fixture" },
    maxAngularVelRadPerS: { value: 6, provenance: "PLACEHOLDER: test fixture" },
    defaultPathSpeedFraction: { value: 0.8, provenance: "SET BY HAND: test fixture" },
    settleS: { value: 0.25, provenance: "PLACEHOLDER: test fixture" },
    follower: { library: "pedro", version: "3.0.0-20260828.185437-17", holdEnd: true },
  },
  commands: [
    {
      name: "shootAll",
      params: { count: { type: "integer", min: 1, max: 4 } },
      estimateS: "0.6 + count",
      ledger: { launches: "count" },
      stationary: true,
    },
    { name: "setIntake", estimateS: "0" },
  ],
  conditions: [{ name: "hopperFull" }],
};

export const TEST_WAYPOINTS = {
  $schema: SCHEMA_ID.waypoints,
  formatVersion: 1,
  waypoints: {
    start: { xIn: -40, yIn: -60, headingRad: 1.5708, provenance: "SET BY HAND: test fixture" },
    shoot: { xIn: -30, yIn: -40, headingRad: 0, provenance: "SET BY HAND: test fixture" },
  },
};

export function testLink(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    $schema: SCHEMA_ID.link,
    formatVersion: 1,
    autosDir: "autos",
    robot: "autos/robot.json",
    field: "autos/field/field.json",
    waypoints: "autos/waypoints.json",
    deploy: {
      kind: "directory",
      dir: "deploy",
      commandLibrary: "solverslib",
      robotClass: "org.example.teamcode.zenith.ExampleRobot",
    },
    sim: { command: "node sim.js {auto}", trace: "sim/{auto}.trace.json" },
    codegen: { package: "org.example.teamcode.opmode.Auto", dir: "java" },
    ...overrides,
  };
}

const write = (root: string, relative: string, content: unknown): void => {
  const full = join(root, relative);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`, "utf8");
};

/** Writes zenith.json, robot.json, the field file and waypoints.json into `root`. */
export function makeProject(root: string, linkOverrides: Record<string, unknown> = {}): void {
  write(root, "zenith.json", testLink(linkOverrides));
  write(root, "autos/robot.json", TEST_ROBOT);
  write(root, "autos/field/field.json", TEST_FIELD);
  write(root, "autos/waypoints.json", TEST_WAYPOINTS);
}

/** A minimal, valid path auto: start -> shoot, then a shootAll command. Clear of the test obstacle. */
export function simpleAuto(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    $schema: SCHEMA_ID.auto,
    formatVersion: 1,
    name,
    title: name,
    alliance: "RED",
    start: { pose: { ref: "start" } },
    steps: [
      {
        id: "drive",
        kind: "path",
        segments: [{ kind: "line", from: { ref: "start" }, to: { ref: "shoot" } }],
        heading: { mode: "tangent" },
        speedFraction: 0.8,
      },
      { id: "shoot1", kind: "command", name: "shootAll", args: { count: 3 } },
    ],
    ...overrides,
  };
}

export function writeAuto(root: string, autosDir: string, name: string, doc: Record<string, unknown>): void {
  write(root, `${autosDir}/${name}.auto.json`, doc);
}
