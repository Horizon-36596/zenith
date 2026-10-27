import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadField, type Pose, type SeasonState } from "@horizon36596/zenith-core";
import type { Field } from "@horizon36596/zenith-schema";
import { beforeAll, describe, expect, it } from "vitest";
import {
  asBiobuzzState,
  cellRow,
  hiveBodies,
  hiveTipsBetween,
  HIVE_TIP_SWING_S,
  spillPoints,
  tipSwingS,
} from "./hiveMotion.js";
import { biobuzzRules } from "./rules.js";
import { cellArea, initialBiobuzzState, inArea, type BiobuzzState } from "./state.js";

const fieldPath = fileURLToPath(new URL("../field/biobuzz.field.json", import.meta.url));

let field: Field;

beforeAll(() => {
  field = loadField(JSON.parse(readFileSync(fieldPath, "utf8")) as unknown);
});

const opaque = (value: BiobuzzState): SeasonState => value as unknown as SeasonState;
const plain = (value: SeasonState): BiobuzzState => value as unknown as BiobuzzState;

/** RED holding `pollen`, standing in the south quarter the red hive's up cell is over at kickoff. */
function redWith(pollen: number): BiobuzzState {
  const start = opaque(initialBiobuzzState(field));
  const started = biobuzzRules.start?.(start, { pollen }, "RED");
  if (started === undefined) throw new Error("the BIOBUZZ rules have no start");
  return plain(started);
}
const southOfRedHive: Pose = { xIn: -12.75, yIn: -40, headingRad: Math.PI / 2 };

describe("hive motion", () => {
  it("finds the tip a launch made, what fell out and which quarter it landed in", () => {
    const before = redWith(4);
    const after = plain(biobuzzRules.onLaunch(opaque(before), "hiveRedUpCell", 4, southOfRedHive));
    const tips = hiveTipsBetween(before, after);
    expect(tips).toHaveLength(1);
    const tip = tips[0];
    expect(tip?.hiveId).toBe("hiveRed");
    expect(tip?.fromSide).toBe("SOUTH");
    expect(tip?.toSide).toBe("NORTH");
    // The 3 staged nectar and all 4 pollen: the 4th went in with the 3rd and tipped with it.
    expect(tip?.dumped).toEqual({ nectarRed: 3, pollen: 4 });
    expect(tip?.areaId).toBe(cellArea(before, before.hives["hiveRed"]!, true)?.id);
    // One pollen over the 3 the table asks for with 3 nectar swings faster than the base 4 s.
    expect(tip?.swingS).toBeCloseTo(HIVE_TIP_SWING_S / 1.35, 6);
  });

  it("finds no tip in a step that only fills the cell", () => {
    const before = redWith(2);
    const after = plain(biobuzzRules.onLaunch(opaque(before), "hiveRedUpCell", 2, southOfRedHive));
    expect(hiveTipsBetween(before, after)).toEqual([]);
  });

  it("swings at the base rate at the threshold and no faster than three times it", () => {
    const state = initialBiobuzzState(field);
    expect(tipSwingS(state, { nectarRed: 3, pollen: 3 })).toBe(HIVE_TIP_SWING_S);
    expect(tipSwingS(state, { pollen: 30 })).toBeCloseTo(HIVE_TIP_SWING_S / 3, 6);
    // An asserted tip of a cell under the threshold is a plain swing, not a slow one.
    expect(tipSwingS(state, {})).toBe(HIVE_TIP_SWING_S);
  });

  it("lands a spill outboard of the emptying cell, inside its quarter, the same way every time", () => {
    const state = initialBiobuzzState(field);
    const hive = state.hives["hiveRed"]!;
    const area = cellArea(state, hive, true);
    expect(area).not.toBeNull();
    const points = spillPoints(hive, "SOUTH", 7, area);
    expect(points).toHaveLength(7);
    for (const point of points) {
      expect(inArea(area!, point)).toBe(true);
      // Past the south cell's outer face.
      expect(point.yIn).toBeLessThan(hive.pivotIn.yIn - hive.outerFaceIn);
    }
    expect(spillPoints(hive, "SOUTH", 7, area)).toEqual(points);
    // Not piled on one spot.
    expect(new Set(points.map((point) => `${point.xIn.toFixed(1)},${point.yIn.toFixed(1)}`)).size).toBe(7);
  });

  it("orders a cell's row with the staged nectar first", () => {
    const state = initialBiobuzzState(field);
    expect(cellRow(state, { pollen: 2, nectarRed: 1 })).toEqual(["nectarRed", "pollen", "pollen"]);
    expect(cellRow(state, {})).toEqual([]);
  });

  it("reads each hive's box from the obstacle the field file draws for it", () => {
    const bodies = hiveBodies(field, initialBiobuzzState(field));
    expect(bodies["hiveRed"]).toEqual({ minXIn: -22.75, maxXIn: -2.75, minYIn: -18.58, maxYIn: 18.58 });
    expect(bodies["hiveBlue"]?.minXIn).toBe(2.75);
  });

  it("recognises its own state and nothing else", () => {
    expect(asBiobuzzState(initialBiobuzzState(field))).not.toBeNull();
    expect(asBiobuzzState({})).toBeNull();
    expect(asBiobuzzState(null)).toBeNull();
  });
});
