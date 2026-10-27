/**
 * The ledger's count chips on the field (`fieldCounts.ts`, issue #118): each count split into pollen
 * and nectar, the robot's carried count at the playback time, and a layout where no two chips
 * overlap and each place keeps its chip on the same side.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadAuto, loadField, loadRobot, plan, resolve, type LedgerLocation } from "@horizon36596/zenith-core";
import { describe, expect, it } from "vitest";
import { ledgerFor } from "../state/ledgerRun";
import {
  CHIP,
  FIELD_CHIPS_MIN_PX_PER_IN,
  chipWidthPx,
  countLabelsSummary,
  countParts,
  layoutFieldCounts,
  partInk,
  pieceOf,
  segmentHitsRect,
  type CountLabel,
  type FieldCountsLayoutInput,
} from "./fieldCounts";
import { ledgerBadgesAt } from "./ledgerBadges";
import type { TraceOverlay } from "./types";
import { fallbackTheme } from "./theme";
import { fitView, orientationFor, worldToScreen } from "./view";

const read = (relative: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")) as unknown;

const field = loadField(read("../../../../examples/starter/autos/field/biobuzz.field.json"));
const robot = loadRobot(read("../../../../examples/starter/autos/robot.json"));
const example = loadAuto(read("../../../../examples/starter/autos/collect-and-score.auto.json"));

/**
 * The example auto's ledger, with a playback clock where the ledger's n-th step ends at n seconds.
 * The counts change only when a step ends, so this is the preview sim's timing without its physics,
 * and every step is reached.
 */
function exampleRun() {
  const planned = plan(resolve(example, undefined, robot), robot, field);
  const view = ledgerFor(planned, field);
  if (view.run === null) throw new Error(view.reason ?? "no ledger");
  const steps = view.run.entries.map((entry, index) => ({ id: entry.stepId, startS: index, endS: index + 1 }));
  const trace = { poses: [], steps } as unknown as TraceOverlay;
  return { ledger: { run: view.run, season: view.season }, trace, totalS: steps.length };
}

const DIGIT_PX = 7.2;
const WIDTH_PX = 800;
const HEIGHT_PX = 800;
const fieldView = fitView({ minXIn: -72, minYIn: -72, maxXIn: 72, maxYIn: 72 }, WIDTH_PX, HEIGHT_PX, 24, orientationFor("bottom"));

const layoutInput = (badges: readonly LedgerLocation[], extra: Partial<FieldCountsLayoutInput> = {}): FieldCountsLayoutInput => ({
  badges,
  alliance: "RED",
  view: fieldView,
  mirror: "none",
  widthPx: WIDTH_PX,
  heightPx: HEIGHT_PX,
  digitPx: DIGIT_PX,
  robotCornersPx: null,
  pathsPx: [],
  ...extra,
});

const rectOf = (label: CountLabel) => ({
  left: label.xPx - label.widthPx / 2,
  right: label.xPx + label.widthPx / 2,
  top: label.yPx - label.heightPx / 2,
  bottom: label.yPx + label.heightPx / 2,
});

const intersects = (a: CountLabel, b: CountLabel): boolean => {
  const ra = rectOf(a);
  const rb = rectOf(b);
  return ra.left < rb.right && rb.left < ra.right && ra.top < rb.bottom && rb.top < ra.bottom;
};

/** A robot outline, an 18 in square at `centreIn`, on screen. */
const robotSquare = (centreIn: { xIn: number; yIn: number }) =>
  [
    { xIn: centreIn.xIn - 9, yIn: centreIn.yIn - 9 },
    { xIn: centreIn.xIn + 9, yIn: centreIn.yIn - 9 },
    { xIn: centreIn.xIn + 9, yIn: centreIn.yIn + 9 },
    { xIn: centreIn.xIn - 9, yIn: centreIn.yIn + 9 },
  ].map((corner) => worldToScreen(fieldView, corner));

describe("a count split by piece", () => {
  it("names BIOBUZZ's pieces: pollen, and each alliance's nectar", () => {
    expect(pieceOf("pollen")).toEqual({ piece: "pollen", alliance: null });
    expect(pieceOf("nectarRed")).toEqual({ piece: "nectar", alliance: "RED" });
    expect(pieceOf("nectarBlue")).toEqual({ piece: "nectar", alliance: "BLUE" });
    expect(pieceOf("cone")).toEqual({ piece: "other", alliance: null });
  });

  it("lists pollen first, then the routine's own nectar, and leaves out a kind with none", () => {
    const parts = countParts({ count: 9, holds: { nectarBlue: 1, nectarRed: 3, pollen: 5, cone: 0 } }, "RED");
    expect(parts.map((part) => `${part.kind}:${String(part.count)}`)).toEqual(["pollen:5", "nectarRed:3", "nectarBlue:1"]);
    const blue = countParts({ count: 4, holds: { nectarBlue: 1, nectarRed: 3 } }, "BLUE");
    expect(blue.map((part) => part.kind)).toEqual(["nectarBlue", "nectarRed"]);
  });

  it("counts a season with no split as one part, and an empty place as none", () => {
    expect(countParts({ count: 2 }, "RED")).toEqual([{ kind: "pieces", count: 2, piece: "other", alliance: null }]);
    expect(countParts({ count: 0, holds: { pollen: 0 } }, "RED")).toEqual([]);
  });

  it("draws pollen gold and nectar in its alliance's colour, swapped when the view is mirrored", () => {
    const theme = fallbackTheme();
    const [pollen, nectar] = countParts({ count: 4, holds: { pollen: 1, nectarRed: 3 } }, "RED");
    if (pollen === undefined || nectar === undefined) throw new Error("no parts");
    expect(partInk(pollen, theme, false)).toEqual({ text: theme.fieldPollen, icon: theme.fieldPollen });
    expect(partInk(nectar, theme, false)).toEqual({ text: theme.allianceRedText, icon: theme.allianceRed });
    expect(partInk(nectar, theme, true)).toEqual({ text: theme.allianceBlueText, icon: theme.allianceBlue });
  });

  it("makes a chip wide enough for every number and icon", () => {
    const one = countParts({ count: 3, holds: { pollen: 3 } }, "RED");
    const two = countParts({ count: 13, holds: { pollen: 10, nectarRed: 3 } }, "RED");
    expect(chipWidthPx(one, DIGIT_PX)).toBeCloseTo(CHIP.padXPx * 2 + DIGIT_PX + CHIP.iconGapPx + CHIP.iconPx, 9);
    expect(chipWidthPx(two, DIGIT_PX)).toBeCloseTo(
      CHIP.padXPx * 2 + 3 * DIGIT_PX + 2 * (CHIP.iconGapPx + CHIP.iconPx) + CHIP.partGapPx,
      9,
    );
  });
});

describe("the counts of the example auto at the playback time", () => {
  const { ledger, trace, totalS } = exampleRun();
  const endOf = (stepId: string): number => {
    const step = trace.steps.find((candidate) => candidate.id === stepId);
    if (step === undefined) throw new Error(`no ${stepId} in the preview`);
    return step.endS;
  };
  const robotAt = (timeS: number) => {
    const robotBadge = ledgerBadgesAt(ledger, trace, timeS, "RED").find((badge) => badge.id === "robot");
    if (robotBadge === undefined) throw new Error("no robot count");
    return countParts(robotBadge, "RED").map((part) => `${part.kind}:${String(part.count)}`);
  };

  it("give the robot's carried pollen at each moment, from the steps finished by then", () => {
    // The auto starts holding 4 pollen and shoots all 4, takes 4 from the flower and scores them,
    // then takes 4 from the garden and scores those.
    expect(robotAt(0)).toEqual(["pollen:4"]);
    expect(robotAt(endOf("shootPreloads") - 0.01)).toEqual(["pollen:4"]);
    expect(robotAt(endOf("shootPreloads") + 0.01)).toEqual([]);
    expect(robotAt(endOf("collectFlower") + 0.01)).toEqual(["pollen:4"]);
    expect(robotAt(endOf("scoreFlowerPollen") + 0.01)).toEqual([]);
    expect(robotAt(endOf("sweepGarden") + 0.01)).toEqual(["pollen:4"]);
    expect(robotAt(endOf("scoreGardenPollen") + 0.01)).toEqual([]);
  });

  it("are the same for the same time, however the playhead got there", () => {
    const at = endOf("sweepGarden") + 0.5;
    const forward = ledgerBadgesAt(ledger, trace, at, "RED");
    ledgerBadgesAt(ledger, trace, 0, "RED");
    const back = ledgerBadgesAt(ledger, trace, at, "RED");
    expect(back).toEqual(forward);
  });

  it("split the floor where the hive tipped into pollen and our nectar, as the Ledger does", () => {
    const end = ledgerBadgesAt(ledger, trace, totalS + 1, "RED");
    const floor = end.find((badge) => badge.id === "floorRedGardenSide");
    if (floor === undefined) throw new Error("no floor count");
    expect(countParts(floor, "RED").map((part) => `${part.kind}:${String(part.count)}`)).toEqual(["pollen:4", "nectarRed:3"]);
    const labels = layoutFieldCounts(layoutInput(end));
    expect(countLabelsSummary(labels)).toMatch(/floorRedGardenSide=pollen:4,nectarRed:3@field:/);
  });
});

describe("the chip layout", () => {
  const { ledger, trace, totalS } = exampleRun();
  const moments = [0, ...trace.steps.map((step) => step.endS + 0.01)];

  it("never lets two chips overlap, at any moment of the example, with the robot riding along", () => {
    for (const timeS of moments) {
      const badges = ledgerBadgesAt(ledger, trace, timeS, "RED");
      const labels = layoutFieldCounts(layoutInput(badges, { robotCornersPx: robotSquare({ xIn: -36, yIn: -36 }) }));
      for (const [index, label] of labels.entries()) {
        for (const other of labels.slice(index + 1)) expect(intersects(label, other), `${label.id} and ${other.id} at ${String(timeS)} s`).toBe(false);
        expect(label.xPx - label.widthPx / 2).toBeGreaterThanOrEqual(0);
        expect(label.xPx + label.widthPx / 2).toBeLessThanOrEqual(WIDTH_PX);
      }
    }
  });

  it("draws only the places that hold something, plus our up hive cell and the robot", () => {
    const labels = layoutFieldCounts(layoutInput(ledgerBadgesAt(ledger, trace, 0, "RED")));
    const ids = labels.map((label) => label.id);
    expect(ids).toContain("hiveRedUpCell");
    expect(ids).toContain("flower0");
    expect(ids).toContain("robot");
    // Empty at the start: the down cell, the floor quarters and the loading zones.
    expect(ids).not.toContain("hiveRedDownCell");
    expect(ids).not.toContain("floorRedGardenSide");
    expect(ids).not.toContain("loadingZoneRed");
    // The hive cell starts with 3 of our nectar.
    expect(labels.find((label) => label.id === "hiveRedUpCell")?.parts.map((part) => part.kind)).toEqual(["nectarRed"]);
  });

  it("puts a flower's chip on its field side, clear of the flower, and an area's on its centre", () => {
    const end = ledgerBadgesAt(ledger, trace, totalS + 1, "RED");
    const labels = layoutFieldCounts(layoutInput(end));
    const flower = labels.find((label) => label.id === "flower0");
    const flowerAt = worldToScreen(fieldView, { xIn: -69.46, yIn: -24 });
    if (flower === undefined) throw new Error("no flower0 chip");
    // flower0 is on the west wall, so its chip is east of it, towards the centre, and does not cover it.
    expect(flower.xPx).toBeGreaterThan(flowerAt.xPx);
    expect(flower.xPx - flower.widthPx / 2).toBeGreaterThan(flowerAt.xPx);
    const floor = labels.find((label) => label.id === "floorRedGardenSide");
    const floorBadge = end.find((badge) => badge.id === "floorRedGardenSide");
    if (floor === undefined || floorBadge?.atIn === null || floorBadge === undefined) throw new Error("no floor chip");
    const floorAt = worldToScreen(fieldView, floorBadge.atIn);
    expect(floor.xPx).toBeCloseTo(floorAt.xPx, 6);
    expect(floor.yPx).toBeCloseTo(floorAt.yPx, 6);
  });

  it("keeps a place's chip where it was whatever the robot does", () => {
    const badges = ledgerBadgesAt(ledger, trace, 0, "RED");
    const without = layoutFieldCounts(layoutInput(badges)).filter((label) => label.at === "field");
    const withRobot = layoutFieldCounts(
      layoutInput(badges, { robotCornersPx: robotSquare({ xIn: -50, yIn: -20 }), pathsPx: [[{ xPx: 0, yPx: 0 }, { xPx: 800, yPx: 800 }]] }),
    ).filter((label) => label.at === "field");
    expect(withRobot).toEqual(without);
  });

  it("rides above the robot, upright, and moves to a side when the path runs there", () => {
    const badges = ledgerBadgesAt(ledger, trace, 0, "RED");
    const corners = robotSquare({ xIn: -36, yIn: 36 });
    const top = Math.min(...corners.map((corner) => corner.yPx));
    const left = Math.min(...corners.map((corner) => corner.xPx));
    const right = Math.max(...corners.map((corner) => corner.xPx));
    const above = layoutFieldCounts(layoutInput(badges, { robotCornersPx: corners })).find((label) => label.at === "robot");
    if (above === undefined) throw new Error("no robot chip");
    expect(above.yPx + above.heightPx / 2).toBeLessThan(top);
    expect(above.xPx).toBeCloseTo((left + right) / 2, 6);
    expect(above.parts.map((part) => `${part.kind}:${String(part.count)}`)).toEqual(["pollen:4"]);

    // A path straight up out of the robot's top edge covers the spot above, so the chip goes right.
    const midX = (left + right) / 2;
    const path = [{ xPx: midX, yPx: top }, { xPx: midX, yPx: top - 80 }];
    const moved = layoutFieldCounts(layoutInput(badges, { robotCornersPx: corners, pathsPx: [path] })).find((label) => label.at === "robot");
    if (moved === undefined) throw new Error("no robot chip");
    expect(moved.xPx - moved.widthPx / 2).toBeGreaterThan(right);
  });

  it("puts the robot beside the partner in the top-right line when zoomed too far out", () => {
    const badges = ledgerBadgesAt(ledger, trace, 0, "RED");
    const small = { ...fieldView, pxPerIn: FIELD_CHIPS_MIN_PX_PER_IN / 2 };
    const labels = layoutFieldCounts(layoutInput(badges, { view: small, robotCornersPx: robotSquare({ xIn: 0, yIn: 0 }) }));
    expect(labels.every((label) => label.at === "line")).toBe(true);
    // The example's partner starts with 4 pollen; the line reads left to right as the ledger lists them.
    expect(labels.map((label) => label.id).sort()).toEqual(["partner", "robot"]);
    const robotChip = labels.find((label) => label.id === "robot");
    const partner = labels.find((label) => label.id === "partner");
    if (robotChip === undefined || partner === undefined) throw new Error("no line");
    expect(robotChip.xPx + robotChip.widthPx / 2).toBeLessThan(partner.xPx - partner.widthPx / 2);
  });
});

describe("a path segment against a chip", () => {
  const rect = { left: 10, top: 10, right: 20, bottom: 20 };
  it("hits when it crosses or starts inside, and misses when it passes by", () => {
    expect(segmentHitsRect({ xPx: 0, yPx: 15 }, { xPx: 30, yPx: 15 }, rect)).toBe(true);
    expect(segmentHitsRect({ xPx: 12, yPx: 12 }, { xPx: 13, yPx: 13 }, rect)).toBe(true);
    expect(segmentHitsRect({ xPx: 0, yPx: 0 }, { xPx: 30, yPx: 5 }, rect)).toBe(false);
    expect(segmentHitsRect({ xPx: 25, yPx: 0 }, { xPx: 25, yPx: 30 }, rect)).toBe(false);
  });
});
