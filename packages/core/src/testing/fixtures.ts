import {
  parseField,
  parseRobot,
  parseWaypoints,
  SCHEMA_ID,
  type Field,
  type Robot,
  type Waypoints,
} from "@horizon36596/zenith-schema";

/**
 * Inline fixtures for the core tests. They are deliberately small and deliberately not the real
 * season file: `packages/season-biobuzz/field/` is transcribed from the game manual, and a test that
 * depends on it would fail for reasons that have nothing to do with the code under test.
 */

/** A placeholder box of a robot: 18 in along the nose, 14 in across. */
export const testRobot: Robot = parseRobot({
  $schema: SCHEMA_ID.robot,
  formatVersion: 1,
  name: "Test robot",
  frame: { forward: "+x", left: "+y", headingZero: "+x", headingPositive: "ccw" },
  footprint: {
    startIn: { lengthIn: 18, widthIn: 14, provenance: "PLACEHOLDER: test fixture" },
    expandedIn: { lengthIn: 18, widthIn: 14, provenance: "PLACEHOLDER: test fixture" },
    centreOfRotationIn: { xIn: 0, yIn: 0 },
  },
  kinematics: {
    maxForwardVelInPerS: { value: 72.3456, provenance: "MEASURED 2026-01-01 test fixture" },
    maxStrafeVelInPerS: { value: 61.2345, provenance: "MEASURED 2026-01-01 test fixture" },
    forwardDecelInPerS2: { value: 83.4567, provenance: "MEASURED 2026-01-01 test fixture" },
    strafeDecelInPerS2: { value: 40, provenance: "MEASURED 2026-01-01 test fixture" },
    accelInPerS2: { value: 90, provenance: "PLACEHOLDER" },
    maxAngularVelRadPerS: { value: 6, provenance: "PLACEHOLDER" },
    defaultPathSpeedFraction: { value: 0.8, provenance: "SET BY HAND" },
    follower: { library: "pedro", version: "3.0.0-20260828.185437-17", holdEnd: true },
  },
  commands: [
    { name: "shootAll", estimateS: "0.6 + count * cadence" },
    { name: "setIntake", estimateS: "0" },
  ],
  conditions: [{ name: "hopperFull" }],
});

/**
 * A field with two RED hive boxes and nothing else.
 *
 * `hiveRedPivotBar` is the real one from the BIOBUZZ field file: it starts at z 25.5 in, above
 * an 18 in robot, so the z gate in the STRUCTURE check correctly lets the robot drive under it.
 * `hiveRedBase` is a test-only ground-level box standing in for the hive's structure, so the
 * STRUCTURE contract has something it can actually hit.
 */
export const testField: Field = parseField({
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
    view: { audienceAt: "bottom" },
  },
  sizeIn: { xIn: 144, yIn: 144 },
  periods: { autoS: 30, teleopS: 120 },
  obstacles: [
    {
      id: "hiveRedPivotBar",
      kind: "box",
      minXIn: -22.75,
      maxXIn: -2.75,
      minYIn: -18.58,
      maxYIn: 18.58,
      minZIn: 25.5,
      maxZIn: 65.6,
      solidToRobot: true,
      provenance: "SPEC (manual 9.6)",
    },
    {
      id: "hiveRedBase",
      kind: "box",
      minXIn: -16.75,
      maxXIn: -8.75,
      minYIn: -6,
      maxYIn: 6,
      minZIn: 0,
      maxZIn: 25.5,
      solidToRobot: true,
      provenance: "PLACEHOLDER: test fixture, stands in for the hive structure at floor level",
    },
  ],
});

export const testWaypoints: Waypoints = parseWaypoints({
  $schema: SCHEMA_ID.waypoints,
  formatVersion: 1,
  waypoints: {
    startTile: {
      xIn: -40,
      yIn: -63,
      headingRad: 1.5708,
      provenance: "SET FROM SIM 2026-09-21",
    },
  },
});
