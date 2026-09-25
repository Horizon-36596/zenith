import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadField, type SeasonState } from "@horizon36596/zenith-core";
import type { Field, Robot } from "@horizon36596/zenith-schema";
import { parseRobot, SCHEMA_ID } from "@horizon36596/zenith-schema";
import { beforeAll, describe, expect, it } from "vitest";
import { biobuzzRules, loadSeason } from "./rules.js";
import { initialBiobuzzState, upCellFace, type BiobuzzState } from "./state.js";

const fieldPath = fileURLToPath(new URL("../field/biobuzz.field.json", import.meta.url));

let field: Field;
let robot: Robot;

beforeAll(() => {
  field = loadField(JSON.parse(readFileSync(fieldPath, "utf8")) as unknown);
  robot = parseRobot({
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
      maxForwardVelInPerS: { value: 72.3456 },
      maxStrafeVelInPerS: { value: 61.2345 },
      forwardDecelInPerS2: { value: 83.4567 },
      strafeDecelInPerS2: { value: 40 },
      accelInPerS2: { value: 90 },
      maxAngularVelRadPerS: { value: 6 },
      defaultPathSpeedFraction: { value: 0.8 },
      follower: { library: "pedro", version: "3.0.0-20260828.185437-17", holdEnd: true },
    },
    commands: [{ name: "shootAll", estimateS: "1" }],
  });
});

const state = (): BiobuzzState => initialBiobuzzState(field);
const opaque = (value: BiobuzzState): SeasonState => value as unknown as SeasonState;
const plain = (value: SeasonState): BiobuzzState => value as unknown as BiobuzzState;

describe("biobuzz initial state", () => {
  it("reads both hives, their pivots and their staged up sides from the field file", () => {
    const start = state();
    expect(Object.keys(start.hives).sort()).toEqual(["hiveBlue", "hiveRed"]);
    expect(start.hives["hiveRed"]?.pivotIn).toEqual({ xIn: -12.75, yIn: 0 });
    expect(start.hives["hiveRed"]?.upSide).toBe("SOUTH");
    expect(start.hives["hiveBlue"]?.upSide).toBe("NORTH");
    // Three nectar are staged in each hive's up cell.
    expect(start.hives["hiveRed"]?.upCellCount).toBe(3);
  });

  it("derives the cell outer face and the approach margin from the field geometry", () => {
    const hive = state().hives["hiveRed"];
    expect(hive?.outerFaceIn).toBeCloseTo(18.58, 6);
    expect(hive?.approachMarginIn).toBeCloseTo(6, 6);
    expect(hive?.axis).toBe("y");
    expect(upCellFace(hive!)).toEqual({ faceIn: -18.58, outboardSign: -1 });
  });

  it("reads four flowers with four pollen each, and the two garden lines", () => {
    const start = state();
    expect(Object.keys(start.flowers).length).toBe(4);
    expect(start.flowers["flower0"]?.holds).toEqual({ pollen: 4 });
    expect(start.flowers["flower0"]?.takes).toEqual(["pollen"]);
    expect(Object.keys(start.garden).length).toBe(8);
  });

  it("reads the tip table and the capacity from rules", () => {
    expect(state().tipTable).toEqual([8, 7, 6, 3, 1, 0]);
    expect(state().capacity).toBe(4);
  });
});

describe("biobuzz transitions", () => {
  it("moves launched pieces out of the robot and into the up cell", () => {
    const start = biobuzzRules.start!(opaque(state()), { pollen: 4 });
    const after = plain(biobuzzRules.onLaunch(start, "hiveRedUpCell", 3, { xIn: 0, yIn: -40, headingRad: 0 }));
    expect(after.robotHolds).toEqual({ pollen: 1 });
    // 3 staged nectar plus 3 launched pollen is 6, still under the first threshold of 8.
    expect(after.hives["hiveRed"]?.upCellCount).toBe(6);
    expect(after.hives["hiveRed"]?.tips).toBe(0);
  });

  it("tips the hive when the up cell reaches the tip table's first number, and spills it", () => {
    let current = biobuzzRules.start!(opaque(state()), { pollen: 4 });
    current = biobuzzRules.onLaunch(current, "hiveRedUpCell", 4, { xIn: 0, yIn: -40, headingRad: 0 });
    const after = plain(current);
    // 3 staged plus 4 launched is 7; the table's first threshold is 8, so it has not tipped.
    expect(after.hives["hiveRed"]?.tips).toBe(0);

    let again = biobuzzRules.start!(current, { pollen: 1 });
    again = biobuzzRules.onLaunch(again, "hiveRedUpCell", 1, { xIn: 0, yIn: -40, headingRad: 0 });
    const tipped = plain(again);
    expect(tipped.hives["hiveRed"]?.tips).toBe(1);
    expect(tipped.hives["hiveRed"]?.upSide).toBe("NORTH");
    expect(tipped.hives["hiveRed"]?.upCellCount).toBe(0);
    expect(tipped.looseCount).toBe(8);
    expect(tipped.looseUnknown).toBe(true);
  });

  it("takes pollen out of a flower and never nectar out of a hive", () => {
    const after = plain(biobuzzRules.onCollect(opaque(state()), "flower0", 4));
    expect(after.robotHolds).toEqual({ pollen: 4 });
    expect(after.flowers["flower0"]?.holds).toEqual({});

    const locked = plain(biobuzzRules.onCollect(opaque(state()), "hiveRed", 3));
    expect(locked.robotHolds).toEqual({});
    expect(locked.hives["hiveRed"]?.upCellCount).toBe(3);
  });

  it("never lets the robot collect past its capacity", () => {
    const full = biobuzzRules.start!(opaque(state()), { pollen: 4 });
    const after = plain(biobuzzRules.onCollect(full, "flower0", 4));
    expect(after.robotHolds).toEqual({ pollen: 4 });
    expect(after.flowers["flower0"]?.holds).toEqual({ pollen: 4 });
  });

  it("takes garden pieces one at a time, by id or by the line's prefix", () => {
    const after = plain(biobuzzRules.onCollect(opaque(state()), "gardenRed", 3));
    expect(after.robotHolds).toEqual({ pollen: 3 });
    expect(Object.values(after.garden).filter(Boolean).length).toBe(5);
  });
});

describe("biobuzz targets and approach", () => {
  it("names each alliance's own up cell", () => {
    expect(biobuzzRules.currentTarget(opaque(state()), "RED")).toBe("hiveRedUpCell");
    expect(biobuzzRules.currentTarget(opaque(state()), "BLUE")).toBe("hiveBlueUpCell");
  });

  it("wants the robot outboard of the up cell's outer face by the margin, on the right side", () => {
    const start = opaque(state());
    const at = (yIn: number) =>
      biobuzzRules.legalApproach(start, "hiveRedUpCell", { xIn: -12.75, yIn, headingRad: 0 }, robot);
    // RED's up cell faces SOUTH: the face is at y = -18.58 and the margin is 6 in.
    expect(at(-24.58)).toBe(true);
    expect(at(-40)).toBe(true);
    expect(at(-24.5)).toBe(false);
    expect(at(40)).toBe(false);
  });

  it("follows the up cell when the hive tips", () => {
    let current = biobuzzRules.start!(opaque(state()), { pollen: 4 });
    current = biobuzzRules.onLaunch(current, "hiveRedUpCell", 4, { xIn: 0, yIn: -40, headingRad: 0 });
    current = biobuzzRules.start!(current, { pollen: 1 });
    current = biobuzzRules.onLaunch(current, "hiveRedUpCell", 1, { xIn: 0, yIn: -40, headingRad: 0 });
    const north = (yIn: number) =>
      biobuzzRules.legalApproach(current, "hiveRedUpCell", { xIn: -12.75, yIn, headingRad: 0 }, robot);
    expect(north(40)).toBe(true);
    expect(north(-40)).toBe(false);
  });
});

describe("biobuzz start rules", () => {
  const at = (xIn: number, yIn: number, headingRad = 0) =>
    biobuzzRules.startLegal(field, { xIn, yIn, headingRad }, robot);

  it("passes a pose against the south wall in RED's half", () => {
    expect(at(-40, -63, Math.PI / 2)).toEqual([]);
  });

  it("fails a pose that touches no wall", () => {
    const findings = at(-40, -20, Math.PI / 2);
    expect(findings.map((finding) => finding.code)).toContain("START_ILLEGAL");
    expect(findings[0]?.message).toContain("touching a wall");
  });

  it("fails a pose in the other half", () => {
    const findings = at(40, -63, Math.PI / 2);
    expect(findings.some((finding) => finding.message.includes("own half"))).toBe(true);
  });

  it("fails a pose inside RED's loading zone", () => {
    const findings = at(-66, 36, 0);
    expect(findings.some((finding) => finding.message.includes("loadingZoneRed"))).toBe(true);
  });

  it("fails a pose touching a flower", () => {
    const findings = at(-63, -24, 0);
    expect(findings.some((finding) => finding.message.includes("flower"))).toBe(true);
  });

  it("gives every finding a full sentence and the footprint it is talking about", () => {
    for (const finding of at(-40, -20, Math.PI / 2)) {
      expect(finding.message.endsWith(".")).toBe(true);
      expect(finding.stepId).toBe("start");
      expect(finding.geometry?.polygonIn?.length).toBe(4);
    }
  });
});

describe("summary and loadSeason", () => {
  it("describes the end state in rows a person can read", () => {
    const rows = biobuzzRules.summary(biobuzzRules.start!(opaque(state()), { pollen: 4 }));
    expect(rows[0]?.label).toBe("robot");
    expect(rows[0]?.holds).toEqual({ pollen: 4 });
    expect(rows.some((row) => row.label === "hiveRed")).toBe(true);
    expect(rows.some((row) => row.label === "garden")).toBe(true);
  });

  it("picks this plugin for the biobuzz field and nothing for another", () => {
    expect(loadSeason(field)).toBe(biobuzzRules);
    expect(loadSeason({ ...field, season: "other", rules: { plugin: "season-other" } }).id).toBe("none");
  });
});

describe("mirrorId", () => {
  it("finding 37: swaps the alliance word in a field id", () => {
    expect(biobuzzRules.mirrorId?.("hiveRedUpCell")).toBe("hiveBlueUpCell");
    expect(biobuzzRules.mirrorId?.("hiveBlue")).toBe("hiveRed");
    expect(biobuzzRules.mirrorId?.("gardenRed2")).toBe("gardenBlue2");
    expect(biobuzzRules.mirrorId?.("loadingZoneBlue")).toBe("loadingZoneRed");
  });

  it("finding 37: leaves an id both alliances share alone", () => {
    expect(biobuzzRules.mirrorId?.("flower0")).toBe("flower0");
    expect(biobuzzRules.mirrorId?.("flower2Top")).toBe("flower2Top");
  });
});
