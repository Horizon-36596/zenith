/**
 * The ledger's counts on the field (`ledgerBadges.ts`): the badges follow the playback clock, a
 * transfer's actual count is what they show, and the preview the editor runs takes the side of a
 * branch the ledger picks.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadAuto, loadField, loadRobot, plan, resolve, simulate } from "@horizon36596/zenith-core";
import { FORMAT_VERSIONS, SCHEMA_ID, type Auto } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import { ledgerFor, previewSimOptions } from "../state/ledgerRun";
import { transferChip, transferChoices, transferWords, defaultTransferEnds } from "../lib/transfer";
import { badgeSummary, glyphCentredOrigin, ledgerBadgesAt, type GlyphMetrics } from "./ledgerBadges";

const read = (relative: string): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")) as unknown;

const field = loadField(read("../../../../examples/starter/autos/field/biobuzz.field.json"));
// The starter robot, with a tipSeen condition the ledger can read.
const starter = read("../../../../examples/starter/autos/robot.json") as { conditions?: unknown[] };
const robot = loadRobot({
  ...starter,
  conditions: [
    ...(starter.conditions ?? []),
    { name: "tipSeen", summary: "Our hive has tipped at least once.", ledger: { quantity: "hiveOwn.tips", min: 1 } },
  ],
});

function autoWith(partnerActual: number | undefined): Auto {
  return loadAuto({
    $schema: SCHEMA_ID.auto,
    formatVersion: FORMAT_VERSIONS.auto,
    name: "badges",
    alliance: "RED",
    start: { pose: { xIn: -40, yIn: -63, headingRad: 1.5708 }, holds: { pollen: 4 } },
    steps: [
      { id: "settle", kind: "wait", seconds: 1 },
      {
        id: "partnerScores",
        kind: "transfer",
        from: "partner",
        to: "hiveRedUpCell",
        expectedCount: 4,
        ...(partnerActual === undefined ? {} : { actualCount: partnerActual }),
      },
      { id: "robotScores", kind: "transfer", from: "robot", to: "hiveRedUpCell", expectedCount: 1 },
      {
        id: "ifTipped",
        kind: "branch",
        condition: "tipSeen",
        then: [{ id: "thenWait", kind: "wait", seconds: 0.5 }],
        else: [{ id: "elseWait", kind: "wait", seconds: 2 }],
      },
    ],
  });
}

const planned = (auto: Auto) => plan(resolve(auto, undefined, robot), robot, field);

describe("ledger badges on the field", () => {
  it("show the kickoff counts before any step has finished, and the transfer's once it has", () => {
    const p = planned(autoWith(undefined));
    const view = ledgerFor(p, field);
    if (view.run === null) throw new Error(view.reason ?? "no ledger");
    const trace = simulate(p, robot, field, previewSimOptions(p, field));
    const ledger = { run: view.run, season: view.season };
    const count = (timeS: number, id: string): number | null | undefined =>
      ledgerBadgesAt(ledger, trace, timeS, "RED").find((badge) => badge.id === id)?.count;

    expect(count(0.5, "partner")).toBe(4);
    expect(count(0.5, "hiveRedUpCell")).toBe(3);
    expect(count(0.5, "flower0")).toBe(4);
    expect(count(0.5, "floorRedGardenSide")).toBe(0);
    expect(count(0.5, "loadingZoneRed")).toBe(0);
    // The partner's 4 pollen beat the 3 the tip table asks for with 3 nectar in the up cell, so the
    // hive tipped and dumped its 7 pieces onto the south floor quarter. The empty cell that came up
    // faces north, and the robot is still in the south quarter, so its 1 lands loose.
    expect(count(1.5, "partner")).toBe(0);
    expect(count(1.5, "robot")).toBe(3);
    expect(count(1.5, "hiveRedUpCell")).toBe(0);
    expect(count(1.5, "floorRedGardenSide")).toBe(7);
    expect(count(1.5, "loose")).toBe(1);
    // Off the field is never counted, so it has no badge.
    expect(ledgerBadgesAt(ledger, trace, 1.5, "RED").some((badge) => badge.id === "offField")).toBe(false);
    expect(badgeSummary(ledgerBadgesAt(ledger, trace, 0, "RED"))).toContain("partner=4");
  });

  it("follow the actual count: the partner failing to tip leaves the hive as it was, and the preview takes else", () => {
    const p = planned(autoWith(0));
    const view = ledgerFor(p, field);
    if (view.run === null) throw new Error(view.reason ?? "no ledger");
    const trace = simulate(p, robot, field, previewSimOptions(p, field));
    const badges = ledgerBadgesAt({ run: view.run, season: view.season }, trace, 10, "RED");
    expect(badges.find((badge) => badge.id === "partner")?.count).toBe(4);
    expect(badges.find((badge) => badge.id === "hiveRedUpCell")?.count).toBe(4);
    const ids = trace.steps.map((step) => step.id);
    expect(ids).toContain("elseWait");
    expect(ids).not.toContain("thenWait");
  });

  it("are empty without a ledger", () => {
    expect(ledgerBadgesAt(null, null, 0, "RED")).toEqual([]);
  });
});

describe("a count's position inside its badge", () => {
  // A digit as a 10 px monospace font measures it: the ink starts a little right of the origin and
  // sits on the baseline, with no descender.
  const four: GlyphMetrics = {
    width: 6,
    actualBoundingBoxLeft: -0.5,
    actualBoundingBoxRight: 5.5,
    actualBoundingBoxAscent: 7,
    actualBoundingBoxDescent: 0,
  };
  const inkBox = (metrics: GlyphMetrics, origin: { xPx: number; yPx: number }) => ({
    left: origin.xPx - metrics.actualBoundingBoxLeft,
    right: origin.xPx + metrics.actualBoundingBoxRight,
    top: origin.yPx - metrics.actualBoundingBoxAscent,
    bottom: origin.yPx + metrics.actualBoundingBoxDescent,
  });

  it("puts the middle of the digit's ink on the badge's centre on both axes", () => {
    const origin = glyphCentredOrigin(four, { xPx: 100, yPx: 50 });
    expect(origin).toEqual({ xPx: 97, yPx: 53.5, inkMeasured: true });
    const box = inkBox(four, origin);
    expect((box.left + box.right) / 2).toBeCloseTo(100, 9);
    expect((box.top + box.bottom) / 2).toBeCloseTo(50, 9);
  });

  it("centres the ink of any glyph, at a centre that is not on the pixel grid", () => {
    // A fractional centre is what a zoomed view or a device pixel ratio of 1.5 gives; nothing is
    // rounded, so the count stays on the same centre as the circle drawn around it.
    const shapes: GlyphMetrics[] = [
      four,
      { width: 12, actualBoundingBoxLeft: 0.25, actualBoundingBoxRight: 11.5, actualBoundingBoxAscent: 7.3, actualBoundingBoxDescent: 0.2 },
      { width: 6, actualBoundingBoxLeft: -1, actualBoundingBoxRight: 4.8, actualBoundingBoxAscent: 5.1, actualBoundingBoxDescent: 2.4 },
    ];
    for (const centre of [{ xPx: 452.91, yPx: 488.33 }, { xPx: 0.25, yPx: -17.6 }]) {
      for (const metrics of shapes) {
        const box = inkBox(metrics, glyphCentredOrigin(metrics, centre));
        expect((box.left + box.right) / 2).toBeCloseTo(centre.xPx, 9);
        expect((box.top + box.bottom) / 2).toBeCloseTo(centre.yPx, 9);
      }
    }
  });

  it("scales metrics measured at ten times the drawn size down to it", () => {
    // Chromium rounds the ink box out to whole pixels, so the painter measures at 100 px: the 4 above
    // measures 73 px tall there, which is 7.3 px drawn, where a 10 px measure would say 8.
    const big: GlyphMetrics = {
      width: 60,
      actualBoundingBoxLeft: -7,
      actualBoundingBoxRight: 51,
      actualBoundingBoxAscent: 73,
      actualBoundingBoxDescent: 0,
    };
    const origin = glyphCentredOrigin(big, { xPx: 100, yPx: 50 }, 1 / 10);
    expect(origin.xPx).toBeCloseTo(100 - (5.1 + 0.7) / 2, 9);
    expect(origin.yPx).toBeCloseTo(50 + 7.3 / 2, 9);
  });

  it("falls back to the advance width, and says the ink height is unknown, when the browser has no ink metrics", () => {
    const origin = glyphCentredOrigin(
      {
        width: 6,
        actualBoundingBoxLeft: Number.NaN,
        actualBoundingBoxRight: Number.NaN,
        actualBoundingBoxAscent: Number.NaN,
        actualBoundingBoxDescent: Number.NaN,
      },
      { xPx: 20, yPx: 30 },
    );
    expect(origin).toEqual({ xPx: 17, yPx: 30, inkMeasured: false });
  });
});

describe("the transfer step's words and choices", () => {
  const season = ledgerFor(planned(autoWith(undefined)), field).season;

  it("says what moves, and marks an actual count that differs", () => {
    const step = { kind: "transfer" as const, from: "partner", to: "hiveRedUpCell", expectedCount: 3 };
    expect(transferWords(step)).toBe("3 pieces from partner to hiveRedUpCell");
    expect(transferChip(step)).toBe("×3");
    expect(transferWords({ ...step, actualCount: 0 })).toBe("0 of 3 expected pieces from partner to hiveRedUpCell");
    expect(transferChip({ ...step, actualCount: 0 })).toBe("3→0");
  });

  it("lists the season's places, keeps an unknown current one, and starts from the partner into our up cell", () => {
    const choices = transferChoices(season, field, "RED", ["hiveOwnUpCell"]);
    expect(choices[0]?.value).toBe("hiveOwnUpCell");
    expect(choices.map((choice) => choice.value)).toEqual(
      expect.arrayContaining(["robot", "partner", "hiveRedUpCell", "flower0", "floorBlueLoadingSide", "loadingZoneRed", "offField"]),
    );
    expect(defaultTransferEnds(season, field, "RED")).toEqual({ from: "partner", to: "hiveRedUpCell" });
    expect(defaultTransferEnds(season, field, "BLUE")).toEqual({ from: "partner", to: "hiveBlueUpCell" });
  });
});
