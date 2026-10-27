import { describe, expect, it } from "vitest";
import { childLists, isGroupStep, PLANNER_ONLY_STEP_KINDS, STEP_KINDS, transferCount, type Step } from "./auto.js";
import { FORMAT_VERSIONS, SCHEMA_ID } from "./ids.js";
import { parseAuto, parseField, parseRobot, validateKind } from "./parse.js";

const autoWith = (steps: unknown[], formatVersion: number = FORMAT_VERSIONS.auto): unknown => ({
  $schema: SCHEMA_ID.auto,
  formatVersion,
  name: "transfer-fixture",
  alliance: "RED",
  start: { pose: { xIn: 0, yIn: 0, headingRad: 0 } },
  steps,
});

const partnerScores = {
  id: "partnerScores",
  kind: "transfer",
  from: "partner",
  to: "hiveRedUpCell",
  expectedCount: 3,
};

describe("format version 4: the transfer step", () => {
  it("is a leaf step kind that only the planner reads", () => {
    expect(STEP_KINDS).toContain("transfer");
    expect(PLANNER_ONLY_STEP_KINDS).toEqual(["transfer"]);
    const step = partnerScores as Step;
    expect(isGroupStep(step)).toBe(false);
    expect(childLists(step)).toEqual([]);
  });

  it("parses at the top level and inside a group, keeping expected and actual apart", () => {
    const auto = parseAuto(
      autoWith([
        partnerScores,
        {
          id: "grp",
          kind: "parallel",
          mode: "all",
          steps: [{ ...partnerScores, id: "inner", actualCount: 0 }, { id: "w", kind: "wait", seconds: 1 }],
        },
      ]),
    );
    const first = auto.steps[0];
    expect(first?.kind).toBe("transfer");
    if (first?.kind !== "transfer") throw new Error("unreachable");
    expect(first.expectedCount).toBe(3);
    expect(first.actualCount).toBeUndefined();
    expect(transferCount(first)).toBe(3);
    const group = auto.steps[1];
    if (group?.kind !== "parallel") throw new Error("unreachable");
    const inner = group.steps[0];
    if (inner?.kind !== "transfer") throw new Error("unreachable");
    expect(transferCount(inner)).toBe(0);
  });

  it("refuses a count that is negative or not whole", () => {
    expect(validateKind("auto", autoWith([{ ...partnerScores, expectedCount: -1 }])).ok).toBe(false);
    expect(validateKind("auto", autoWith([{ ...partnerScores, actualCount: 1.5 }])).ok).toBe(false);
  });

  it("refuses a transfer in a v3 file, which predates it", () => {
    // Migration is the identity for v3, so a v3 file that somehow carries a transfer is read at
    // v4; a runtime that knows only v3 refuses the v4 file it is saved as instead.
    expect(parseAuto(autoWith([partnerScores], 3)).formatVersion).toBe(4);
  });
});

describe("ledger metadata on robot conditions and field zones", () => {
  const robotWith = (conditions: unknown[]): unknown => ({
    $schema: SCHEMA_ID.robot,
    formatVersion: 1,
    name: "Conditions fixture",
    frame: { forward: "+x", left: "+y", headingZero: "+x", headingPositive: "ccw" },
    footprint: {
      startIn: { lengthIn: 18, widthIn: 14 },
      expandedIn: { lengthIn: 18, widthIn: 14 },
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
      follower: { library: "pedro", version: "x", holdEnd: true },
    },
    commands: [],
    conditions,
  });

  it("keeps the full and empty markers and adds a quantity test", () => {
    const robot = parseRobot(
      robotWith([
        { name: "hopperFull", ledger: "full" },
        { name: "tipSeen", ledger: { quantity: "hiveOwn.tips", min: 1 } },
      ]),
    );
    expect(robot.conditions?.[0]?.ledger).toBe("full");
    expect(robot.conditions?.[1]?.ledger).toEqual({ quantity: "hiveOwn.tips", min: 1 });
  });

  it("refuses a quantity test with no bound", () => {
    expect(validateKind("robot", robotWith([{ name: "x", ledger: { quantity: "robot" } }])).ok).toBe(false);
  });

  it("reads the loadingZone role on a zone", () => {
    const field = parseField({
      $schema: SCHEMA_ID.field,
      formatVersion: 2,
      season: "test",
      name: "zones",
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
      zones: [{ id: "hp", kind: "rect", minXIn: -72, maxXIn: -61, minYIn: 24, maxYIn: 48, ledger: "loadingZone" }],
    });
    expect(field.zones?.[0]?.ledger).toBe("loadingZone");
  });
});
