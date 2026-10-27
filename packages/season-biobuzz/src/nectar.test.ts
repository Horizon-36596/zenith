import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadField, type SeasonState } from "@horizon36596/zenith-core";
import type { Field } from "@horizon36596/zenith-schema";
import { beforeAll, describe, expect, it } from "vitest";
import { biobuzzRules, pollenToTip } from "./rules.js";
import { initialBiobuzzState, type BiobuzzState } from "./state.js";

/**
 * The BIOBUZZ hive and nectar in the ledger, from the Competition Manual and DSim, the team's
 * simulator, with the owner's rulings of
 * 2026-10-03 (issues #84 and #95):
 *
 * - The tip table is DSim's `BB_TIP_POLLEN`, 8, 7, 6, 3, 1, 0 pollen for 0 to 5 nectar, read at the
 *   nectar in the up cell, its last row holding past its end (`hive.ts`, `hiveWillTip`).
 * - A tip dumps the whole cell onto the floor on that cell's own side (`hive.ts`, `spillPoses`).
 * - This robot scores only from the up cell's own quarter of the field; elsewhere its pieces land
 *   loose.
 * - Only the routine's own alliance's nectar goes into its robot or its hive (G408).
 * - The human player has 5 nectar and may bring one in per tip of its own hive (§10.3.1, G426.A),
 *   only onto its own LOADING ZONE (G427.C).
 * - The robot's hopper is a stack, last in first out (`elements.ts`, `releasePollen`).
 */

const fieldPath = fileURLToPath(new URL("../field/biobuzz.field.json", import.meta.url));
let field: Field;

beforeAll(() => {
  field = loadField(JSON.parse(readFileSync(fieldPath, "utf8")) as unknown);
});

const opaque = (value: BiobuzzState): SeasonState => value as unknown as SeasonState;
const plain = (value: SeasonState): BiobuzzState => value as unknown as BiobuzzState;
const kickoff = (): SeasonState => opaque(initialBiobuzzState(field));

/** RED's up cell faces SOUTH at kickoff, over floorRedGardenSide (x < 0, y < 0). */
const south = { xIn: -40, yIn: -40, headingRad: 1.5708 };
/** After one tip it faces NORTH, over floorRedLoadingSide (x < 0, y > 0). */
const north = { xIn: -40, yIn: 40, headingRad: -1.5708 };

const count = (holds: Record<string, number>): number => Object.values(holds).reduce((a, b) => a + b, 0);

/** This robot starting with `holds` and launching all of it at RED's up cell from `pose`. */
const launch = (state: SeasonState, holds: Record<string, number>, pose = south): SeasonState =>
  biobuzzRules.onLaunch(biobuzzRules.start!(state, holds, "RED"), "hiveRedUpCell", count(holds), pose);

/** The kickoff state after RED's first tip: the 4 preload pollen into the 3 staged nectar. */
const afterFirstTip = (): SeasonState => launch(kickoff(), { pollen: 4 });

describe("the tip table", () => {
  it("is DSim's BB_TIP_POLLEN: 8, 7, 6, 3, 1 and 0 pollen for 0 to 5 nectar", () => {
    expect(plain(kickoff()).tipTable).toEqual([8, 7, 6, 3, 1, 0]);
  });

  it("tips the cell with the 4 preload pollen and the 3 staged nectar", () => {
    const start = plain(kickoff());
    expect(pollenToTip(start, start.hives["hiveRed"]!)).toBe(3);
    const tipped = plain(afterFirstTip());
    expect(tipped.hives["hiveRed"]).toMatchObject({ tips: 1, upSide: "NORTH", upCell: {} });
  });

  it("does not tip an empty cell on the second cycle with 4 pollen, and does with 8", () => {
    let state = launch(afterFirstTip(), { pollen: 4 }, north);
    expect(plain(state).hives["hiveRed"]).toMatchObject({ tips: 1, upCell: { pollen: 4 } });
    expect(pollenToTip(plain(state), plain(state).hives["hiveRed"]!)).toBe(8);
    state = launch(state, { pollen: 3 }, north);
    expect(plain(state).hives["hiveRed"]?.tips).toBe(1);
    state = launch(state, { pollen: 1 }, north);
    expect(plain(state).hives["hiveRed"]).toMatchObject({ tips: 2, upSide: "SOUTH", upCell: {} });
  });

  it("tips a cell holding 5 nectar with no pollen at all", () => {
    const state = biobuzzRules.onTransfer!(afterFirstTip(), "offField.nectar", "hiveOwnUpCell", 5, "RED").state;
    expect(plain(state).hives["hiveRed"]?.tips).toBe(2);
  });

  it("holds its last row past its end, so 6 nectar tip a cell too", () => {
    const state = biobuzzRules.onTransfer!(afterFirstTip(), "offField.nectar", "hiveOwnUpCell", 6, "RED").state;
    expect(plain(state).hives["hiveRed"]?.tips).toBe(2);
  });

  it("gets cheaper when spilled nectar is picked up and launched back into the up cell", () => {
    let state = biobuzzRules.onCollect(afterFirstTip(), "floorRedGardenSide.nectar", 2);
    expect(plain(state).robotHolds).toEqual({ nectarRed: 2 });
    state = biobuzzRules.onLaunch(state, "hiveRedUpCell", 2, north);
    const after = plain(state);
    expect(after.hives["hiveRed"]?.upCell).toEqual({ nectarRed: 2 });
    // Two nectar in the cell: the table's third entry, 6 pollen.
    expect(pollenToTip(after, after.hives["hiveRed"]!)).toBe(6);
    expect(biobuzzRules.measure?.(state, "hiveOwnUpCell.nectar", "RED")).toBe(2);
    expect(biobuzzRules.measure?.(state, "floorRedGardenSide.nectar", "RED")).toBe(1);
  });
});

describe("a tip", () => {
  it("dumps everything in the cell onto the floor quarter on that cell's own side", () => {
    const tipped = plain(afterFirstTip());
    expect(tipped.floor["floorRedGardenSide"]?.holds).toEqual({ nectarRed: 3, pollen: 4 });
    expect(tipped.loose).toEqual({});
    expect(biobuzzRules.describe?.(kickoff(), afterFirstTip())).toContain(
      "hiveRed tipped, dumping its cell into floorRedGardenSide and now faces NORTH",
    );
  });

  it("dumps the second cycle's cell onto the other side, the one it faced", () => {
    const state = plain(launch(afterFirstTip(), { pollen: 8 }, north));
    expect(state.floor["floorRedLoadingSide"]?.holds).toEqual({ pollen: 8 });
    expect(state.floor["floorRedGardenSide"]?.holds).toEqual({ nectarRed: 3, pollen: 4 });
  });

  it("is still a tip when the author asserts it and the table predicted nothing", () => {
    const state = biobuzzRules.onTip!(kickoff(), "own", "RED");
    expect(plain(state).hives["hiveRed"]).toMatchObject({ tips: 1, upSide: "NORTH" });
    expect(plain(state).floor["floorRedGardenSide"]?.holds).toEqual({ nectarRed: 3 });
  });

  it("confirms a tip the table already predicted instead of swinging the hive again", () => {
    const state = biobuzzRules.onTip!(afterFirstTip(), "own", "RED");
    expect(plain(state).hives["hiveRed"]).toMatchObject({ tips: 1, upSide: "NORTH", predictedTips: 0 });
  });
});

describe("the quadrant a launch comes from", () => {
  it("lands the pieces loose when the robot is not in the up cell's quarter", () => {
    const state = plain(launch(kickoff(), { pollen: 4 }, north));
    expect(state.hives["hiveRed"]).toMatchObject({ tips: 0, upCell: { nectarRed: 3 } });
    expect(state.loose).toEqual({ pollen: 4 });
    expect(state.robotHolds).toEqual({});
  });

  it("lands this robot's transfer loose from the wrong quarter, and takes the partner's at its word", () => {
    const start = biobuzzRules.start!(kickoff(), { pollen: 2 }, "RED");
    const robot = biobuzzRules.onTransfer!(start, "robot", "hiveOwnUpCell", 2, "RED", north);
    expect(robot.moved).toBe(2);
    expect(plain(robot.state).hives["hiveRed"]?.upCell).toEqual({ nectarRed: 3 });
    expect(plain(robot.state).loose).toEqual({ pollen: 2 });
    const partner = biobuzzRules.onTransfer!(start, "partner", "hiveOwnUpCell", 2, "RED", north);
    expect(plain(partner.state).hives["hiveRed"]?.upCell).toEqual({ nectarRed: 3, pollen: 2 });
  });

  it("makes a pose outside the up cell's quarter an illegal approach", () => {
    const robot = undefined as never;
    expect(biobuzzRules.legalApproach(kickoff(), "hiveRedUpCell", { xIn: -12.75, yIn: -60, headingRad: 0 }, robot)).toBe(true);
    expect(biobuzzRules.legalApproach(kickoff(), "hiveRedUpCell", { xIn: 12.75, yIn: -60, headingRad: 0 }, robot)).toBe(false);
  });
});

describe("own alliance only", () => {
  it("never puts the other alliance's nectar into the robot", () => {
    let state = biobuzzRules.start!(kickoff(), {}, "RED");
    state = biobuzzRules.onTransfer!(state, "offField.nectarBlue", "floorRedGardenSide", 2, "RED").state;
    state = biobuzzRules.onTransfer!(state, "offField", "floorRedGardenSide", 1, "RED").state;
    state = biobuzzRules.onCollect(state, "floorRedGardenSide", 3);
    expect(plain(state).robotHolds).toEqual({ pollen: 1 });
    const refused = biobuzzRules.onTransfer!(state, "floorRedGardenSide.nectarBlue", "robot", 1, "RED");
    expect(refused.moved).toBe(0);
    expect(refused.problem).toContain("G408");
  });

  it("never puts the other alliance's nectar into this alliance's hive", () => {
    const moved = biobuzzRules.onTransfer!(kickoff(), "offField.nectarBlue", "hiveOwnUpCell", 2, "RED");
    expect(moved.moved).toBe(0);
    expect(moved.problem).toContain("never goes into RED's hive");
    expect(plain(moved.state).hives["hiveRed"]?.upCell).toEqual({ nectarRed: 3 });
  });

  it("does not follow the other alliance's hive", () => {
    const into = biobuzzRules.onTransfer!(kickoff(), "partner", "hiveOpponentUpCell", 1, "RED");
    expect(into.moved).toBe(0);
    expect(into.problem).toContain("the other alliance's");
    const launched = plain(biobuzzRules.onLaunch(biobuzzRules.start!(kickoff(), { pollen: 4 }, "RED"), "hiveBlueUpCell", 4, south));
    expect(launched.hives["hiveBlue"]).toMatchObject({ tips: 0, upCell: { nectarBlue: 3 } });
    expect(launched.loose).toEqual({ pollen: 4 });
    const ids = (biobuzzRules.locations?.(kickoff(), "RED") ?? []).map((location) => location.id);
    expect(ids).toContain("hiveRedUpCell");
    expect(ids).not.toContain("hiveBlueUpCell");
    expect(ids).toContain("humanPlayerRed");
    expect(ids).not.toContain("humanPlayerBlue");
    expect(biobuzzRules.summary(kickoff()).map((row) => row.label)).not.toContain("hiveBlue");
  });
});

describe("a hive cell", () => {
  it("gives nothing to an intake or a transfer: only a tip empties it", () => {
    expect(plain(biobuzzRules.onCollect(kickoff(), "hiveRedUpCell", 2)).robotHolds).toEqual({});
    const moved = biobuzzRules.onTransfer!(kickoff(), "hiveOwnUpCell", "partner", 1, "RED");
    expect(moved.moved).toBe(0);
    expect(moved.problem).toContain("only a tip empties a hive cell");
  });

  it("has a down cell that is always empty and takes nothing", () => {
    const moved = biobuzzRules.onTransfer!(kickoff(), "offField", "hiveOwnDownCell", 2, "RED");
    expect(moved.moved).toBe(0);
    expect(moved.problem).toContain("always empty");
    expect(biobuzzRules.measure?.(afterFirstTip(), "hiveOwnDownCell", "RED")).toBe(0);
  });
});

describe("the robot's hopper", () => {
  it("counts nectar toward the capacity alongside pollen", () => {
    let state = biobuzzRules.start!(afterFirstTip(), { pollen: 2 }, "RED");
    state = biobuzzRules.onCollect(state, "floorRedGardenSide.nectar", 3);
    // Capacity 4 with 2 pollen aboard leaves room for 2 nectar, not 3.
    expect(plain(state).robotHolds).toEqual({ pollen: 2, nectarRed: 2 });
    const full = biobuzzRules.onCollect(state, "floorRedGardenSide", 1);
    expect(plain(full).robotHolds).toEqual({ pollen: 2, nectarRed: 2 });
  });

  it("launches last in, first out on a partial volley", () => {
    let state = biobuzzRules.start!(afterFirstTip(), { pollen: 1 }, "RED");
    state = biobuzzRules.onCollect(state, "floorRedGardenSide.nectar", 1);
    state = biobuzzRules.onCollect(state, "floorRedGardenSide.pollen", 1);
    const after = plain(biobuzzRules.onLaunch(state, "hiveRedUpCell", 2, north));
    expect(after.robotHolds).toEqual({ pollen: 1 });
    expect(after.robotOrder).toEqual(["pollen"]);
    expect(after.hives["hiveRed"]?.upCell).toEqual({ pollen: 1, nectarRed: 1 });
  });

  it("drops nectar where the author says and picks it up there", () => {
    let state = biobuzzRules.start!(kickoff(), { nectarRed: 2, pollen: 1 }, "RED");
    const dropped = biobuzzRules.onTransfer!(state, "robot.nectar", "floorOwnGardenSide", 2, "RED");
    expect(dropped.moved).toBe(2);
    state = dropped.state;
    expect(plain(state).robotHolds).toEqual({ pollen: 1 });
    expect(plain(state).floor["floorRedGardenSide"]?.holds).toEqual({ nectarRed: 2 });
    state = biobuzzRules.onCollect(state, "floorRedGardenSide", 2);
    expect(plain(state).robotHolds).toEqual({ pollen: 1, nectarRed: 2 });
    expect(plain(state).floor["floorRedGardenSide"]?.holds).toEqual({});
  });

  it("shows nectar on the field's count badges by kind", () => {
    const locations = biobuzzRules.locations?.(afterFirstTip(), "RED") ?? [];
    expect(locations.find((location) => location.id === "floorRedGardenSide")).toMatchObject({
      count: 7,
      holds: { nectarRed: 3, pollen: 4 },
    });
  });
});

describe("the human player", () => {
  it("brings nothing in before its own hive has tipped", () => {
    const brought = biobuzzRules.onTransfer!(kickoff(), "humanPlayerOwn", "loadingZoneOwn", 1, "RED");
    expect(brought.moved).toBe(0);
    expect(brought.problem).toContain("G426.A");
  });

  it("brings in one nectar per tip of its own hive, onto its own loading zone", () => {
    let state = afterFirstTip();
    const brought = biobuzzRules.onTransfer!(state, "humanPlayerOwn", "loadingZoneOwn", 2, "RED");
    expect(brought.moved).toBe(1);
    expect(brought.problem).toContain("tipped 1 time");
    state = brought.state;
    expect(plain(state).loadingZone["loadingZoneRed"]?.holds).toEqual({ nectarRed: 1 });
    expect(plain(state).humanPlayer.RED).toEqual({ nectarRed: 1 });
    expect(biobuzzRules.measure?.(state, "humanPlayerOwn", "RED")).toBe(1);
    expect(biobuzzRules.describe?.(afterFirstTip(), state)).toContain("the RED human player brought in 1 nectarRed");
    expect(biobuzzRules.summary(state).find((row) => row.label === "humanPlayerRed")?.detail).toBe(
      "brought in 1 nectarRed, 4 left",
    );
    state = biobuzzRules.onCollect(state, "loadingZoneRed.nectar", 1);
    expect(plain(state).robotHolds).toEqual({ nectarRed: 1 });
  });

  it("brings in no more than its 5 nectar however many times the hive tips", () => {
    let state = kickoff();
    for (let tip = 0; tip < 7; tip += 1) state = biobuzzRules.onTip!(state, "own", "RED");
    expect(plain(state).hives["hiveRed"]?.tips).toBe(7);
    const brought = biobuzzRules.onTransfer!(state, "humanPlayerOwn", "loadingZoneOwn", 7, "RED");
    expect(brought.moved).toBe(5);
    expect(brought.problem).toContain("starts with 5 nectar");
    const again = biobuzzRules.onTransfer!(brought.state, "humanPlayerOwn", "loadingZoneOwn", 1, "RED");
    expect(again.moved).toBe(0);
  });

  it("brings nectar only onto its own loading zone, and only its own", () => {
    const tipped = afterFirstTip();
    const toFloor = biobuzzRules.onTransfer!(tipped, "humanPlayerOwn", "floorOwnGardenSide", 1, "RED");
    expect(toFloor.moved).toBe(0);
    expect(toFloor.problem).toContain("only to loadingZoneRed");
    const other = biobuzzRules.onTransfer!(tipped, "humanPlayerOpponent", "loadingZoneOpponent", 1, "RED");
    expect(other.moved).toBe(0);
    expect(other.problem).toContain("own human player only");
    const intoHuman = biobuzzRules.onTransfer!(tipped, "robot", "humanPlayerOwn", 1, "RED");
    expect(intoHuman.problem).toContain("only brings pieces in");
  });

  it("is not a place a robot intake reaches", () => {
    const state = biobuzzRules.onCollect(kickoff(), "humanPlayerRed", 2);
    expect(plain(state).robotHolds).toEqual({});
  });
});

describe("a flower with nectar in it", () => {
  /** flower0 emptied, then a nectar and two pollen dropped in at the top: the nectar is at the bottom. */
  const lockedFlower = (): SeasonState => {
    let state = biobuzzRules.onCollect(kickoff(), "flower0", 4);
    state = biobuzzRules.start!(state, {});
    state = biobuzzRules.onTransfer!(state, "offField.nectar", "flower0", 1, "RED").state;
    state = biobuzzRules.onTransfer!(state, "offField", "flower0", 2, "RED").state;
    return state;
  };

  it("is locked by a nectar at the bottom: no intake and no transfer takes anything out", () => {
    const state = lockedFlower();
    expect(plain(state).flowers["flower0"]?.column).toEqual(["nectarRed", "pollen", "pollen"]);
    expect(plain(biobuzzRules.onCollect(state, "flower0", 2)).robotHolds).toEqual({});
    const moved = biobuzzRules.onTransfer!(state, "flower0", "partner", 1, "RED");
    expect(moved.moved).toBe(0);
    expect(moved.problem).toContain("flower0 is locked");
    expect(biobuzzRules.summary(state).find((row) => row.label === "flower0")?.detail).toBe(
      "2 pollen, 1 nectarRed, locked by the nectar at its bottom",
    );
  });

  it("gives pollen until the nectar reaches the bottom, then stops", () => {
    let state = biobuzzRules.onCollect(kickoff(), "flower0", 2);
    state = biobuzzRules.start!(state, {});
    state = biobuzzRules.onTransfer!(state, "offField.nectar", "flower0", 1, "RED").state;
    state = biobuzzRules.onCollect(state, "flower0", 4);
    expect(plain(state).robotHolds).toEqual({ pollen: 2 });
    expect(plain(state).flowers["flower0"]?.column).toEqual(["nectarRed"]);
  });
});

describe("the ledger's words", () => {
  it("names the nectar in the routine's own up cell and the pollen still needed to tip it", () => {
    const rows = biobuzzRules.summary(kickoff());
    expect(rows.find((row) => row.label === "hiveRed")?.detail).toBe(
      "up SOUTH, 0 tips; up cell 3 nectarRed (3 more pollen to tip)",
    );
    const tipped = biobuzzRules.summary(afterFirstTip());
    expect(tipped.find((row) => row.label === "floorRedGardenSide")?.detail).toBe("4 pollen, 3 nectarRed");
    expect(tipped.find((row) => row.label === "hiveRed")?.detail).toBe(
      "up NORTH, 1 tip; up cell empty (8 more pollen to tip)",
    );
  });
});
