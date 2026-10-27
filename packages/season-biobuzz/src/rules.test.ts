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
    // Three nectar are staged in each hive's up cell, in that alliance's colour.
    expect(start.hives["hiveRed"]?.upCell).toEqual({ nectarRed: 3 });
    expect(start.hives["hiveBlue"]?.upCell).toEqual({ nectarBlue: 3 });
    expect(start.nectarKind).toEqual({ RED: "nectarRed", BLUE: "nectarBlue" });
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
    expect(start.flowers["flower0"]?.column).toEqual(["pollen", "pollen", "pollen", "pollen"]);
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
    const after = plain(biobuzzRules.onLaunch(start, "hiveRedUpCell", 2, { xIn: 0, yIn: -40, headingRad: 0 }));
    expect(after.robotHolds).toEqual({ pollen: 2 });
    // With 3 nectar in the up cell the table asks for 3 pollen, and 2 is short of it.
    expect(after.hives["hiveRed"]?.upCell).toEqual({ nectarRed: 3, pollen: 2 });
    expect(after.hives["hiveRed"]?.tips).toBe(0);
  });

  it("tips the hive at the pollen the tip table gives for the nectar in the up cell, and spills it", () => {
    let current = biobuzzRules.start!(opaque(state()), { pollen: 4 });
    current = biobuzzRules.onLaunch(current, "hiveRedUpCell", 2, { xIn: 0, yIn: -40, headingRad: 0 });
    expect(plain(current).hives["hiveRed"]?.tips).toBe(0);

    current = biobuzzRules.onLaunch(current, "hiveRedUpCell", 1, { xIn: 0, yIn: -40, headingRad: 0 });
    const tipped = plain(current);
    expect(tipped.hives["hiveRed"]?.tips).toBe(1);
    expect(tipped.hives["hiveRed"]?.upSide).toBe("NORTH");
    expect(tipped.hives["hiveRed"]?.upCell).toEqual({});
    // The whole cell is dumped, nectar and pollen alike, onto the floor quarter on its own side.
    expect(tipped.floor["floorRedGardenSide"]?.holds).toEqual({ nectarRed: 3, pollen: 3 });
    expect(tipped.loose).toEqual({});
  });

  it("takes pollen out of a flower, and nothing out of a hive cell", () => {
    const after = plain(biobuzzRules.onCollect(opaque(state()), "flower0", 4));
    expect(after.robotHolds).toEqual({ pollen: 4 });
    expect(after.flowers["flower0"]?.column).toEqual([]);

    // Only a tip empties a hive cell (manual G417; DSim `capturePollen` takes only pieces on the ground).
    const fromHive = plain(biobuzzRules.onCollect(opaque(state()), "hiveRed", 2));
    expect(fromHive.robotHolds).toEqual({});
    expect(fromHive.hives["hiveRed"]?.upCell).toEqual({ nectarRed: 3 });
  });

  it("never lets the robot collect past its capacity", () => {
    const full = biobuzzRules.start!(opaque(state()), { pollen: 4 });
    const after = plain(biobuzzRules.onCollect(full, "flower0", 4));
    expect(after.robotHolds).toEqual({ pollen: 4 });
    expect(after.flowers["flower0"]?.column).toHaveLength(4);
  });

  it("issue #373 finding 6: a launch at a target that is no hive cell lands loose, not lost", () => {
    const start = biobuzzRules.start!(opaque(state()), { pollen: 3 }, "RED");
    const after = plain(biobuzzRules.onLaunch(start, "hiveRedUpCel", 3, { xIn: 0, yIn: -40, headingRad: 0 }));
    expect(after.robotHolds).toEqual({});
    expect(after.loose).toEqual({ pollen: 3 });
    expect(after.looseUnknown).toBe(true);
    expect(after.hives["hiveRed"]?.upCell).toEqual({ nectarRed: 3 });
  });

  it("issue #373 finding 7: collecting reads Own and Opponent as the routine's alliance and the other", () => {
    const base = state();
    const zone = base.loadingZone["loadingZoneRed"]!;
    const stocked: BiobuzzState = {
      ...base,
      loadingZone: { ...base.loadingZone, loadingZoneRed: { ...zone, holds: { pollen: 1 } } },
    };
    const red = biobuzzRules.start!(opaque(stocked), {}, "RED");
    expect(plain(biobuzzRules.onCollect(red, "loadingZoneOwn", 1, "RED")).robotHolds).toEqual({ pollen: 1 });
    expect(plain(biobuzzRules.onCollect(red, "loadingZoneRed", 1, "RED")).robotHolds).toEqual({ pollen: 1 });
    // Without the alliance passed in, the state's own alliance, which `start` set, is used.
    expect(plain(biobuzzRules.onCollect(red, "loadingZoneOwn", 1)).robotHolds).toEqual({ pollen: 1 });
    const blue = biobuzzRules.start!(opaque(stocked), {}, "BLUE");
    expect(plain(biobuzzRules.onCollect(blue, "loadingZoneOpponent", 1, "BLUE")).robotHolds).toEqual({ pollen: 1 });
    expect(plain(biobuzzRules.onCollect(blue, "loadingZoneOwn", 1, "BLUE")).robotHolds).toEqual({});
  });

  it("issue #373 finding 8: an inherited key such as toString is not a place", () => {
    for (const id of ["toString", "constructor", "hasOwnProperty"]) {
      const result = biobuzzRules.onTransfer!(opaque(state()), id, "robot", 1, "RED");
      expect(result.moved).toBe(0);
      expect(result.problem).toContain("is not a place the ledger counts");
      const into = biobuzzRules.onTransfer!(opaque(state()), "flower0", id, 1, "RED");
      expect(into.problem).toContain("is not a place the ledger counts");
      expect(plain(biobuzzRules.onCollect(opaque(state()), id, 1, "RED")).robotHolds).toEqual({});
    }
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

  it("issue #373 finding 9: brings a pose that is outboard but off the field back into the up cell's quarter", () => {
    const start = opaque(state());
    // Outboard of RED's south-facing up cell, but far past the south wall.
    const nearest = biobuzzRules.nearestLegalApproach!(start, "hiveRedUpCell", { xIn: -12.75, yIn: -200, headingRad: 0 }, robot);
    expect(nearest).not.toBeNull();
    expect(nearest!.yIn).toBeGreaterThanOrEqual(-72);
    expect(biobuzzRules.legalApproach(start, "hiveRedUpCell", nearest!, robot)).toBe(true);
  });

  it("issue #373: knows a hive cell as a target, by target id or hive id, and nothing else", () => {
    const start = opaque(state());
    expect(biobuzzRules.knowsTarget!(start, "hiveRedUpCell")).toBe(true);
    expect(biobuzzRules.knowsTarget!(start, "hiveBlue")).toBe(true);
    expect(biobuzzRules.knowsTarget!(start, "hiveRedUpCel")).toBe(false);
    expect(biobuzzRules.knowsTarget!(start, "flower0")).toBe(false);
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

  it("fails a pose in the other half, and says it is entirely there", () => {
    const findings = at(40, -63, Math.PI / 2);
    const message = findings.find((finding) => finding.message.includes("own half"))?.message;
    expect(message).toBe(
      "The robot must start in RED's own half, the side with RED's hive, and it starts entirely in the other half, 47.00 in past the centre line.",
    );
  });

  it("gives the overlap for a pose that only crosses the centre line", () => {
    const findings = at(0, -63, Math.PI / 2);
    const message = findings.find((finding) => finding.message.includes("own half"))?.message;
    expect(message).toMatch(/^The robot must start in RED's own half, and its footprint crosses the centre line by \d+\.\d\d in\.$/);
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

describe("claimPlace", () => {
  const at = (xIn: number, yIn: number) => ({ xIn, yIn, headingRad: 0 });

  it("names the physical cell a robot scores into from the floor quarter it is in, whichever cell is up", () => {
    // RED's hive starts SOUTH up. A robot in the south quarter of RED's half scores into the south
    // cell, and one in the north quarter into the north cell, which is up once the hive has tipped.
    expect(biobuzzRules.claimPlace?.(field, "hiveRedUpCell", at(-20, -40))).toBe("the south cell");
    expect(biobuzzRules.claimPlace?.(field, "hiveRedUpCell", at(-13.5, 45))).toBe("the north cell");
    expect(biobuzzRules.claimPlace?.(field, "hiveRed", at(-13.5, 45))).toBe("the north cell");
    expect(biobuzzRules.claimPlace?.(field, "hiveBlueUpCell", at(20, 40))).toBe("the north cell");
  });

  it("knows no place for a pose outside both of the hive's quarters, or for an element that is always one place", () => {
    expect(biobuzzRules.claimPlace?.(field, "hiveRedUpCell", at(30, -40))).toBeNull();
    expect(biobuzzRules.claimPlace?.(field, "flower1", at(-24, 43.5))).toBeNull();
  });
});
