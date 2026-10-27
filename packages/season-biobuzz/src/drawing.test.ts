import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PROVENANCE_LABELS } from "@horizon36596/zenith-core";
import { describe, expect, it } from "vitest";
import { fieldDrawing, ftcTileSeam } from "./drawing.js";

const field = JSON.parse(
  readFileSync(fileURLToPath(new URL("../field/biobuzz.field.json", import.meta.url)), "utf8"),
) as Record<string, Array<{ id: string }> | undefined>;
const ids = (key: string): string[] => (field[key] ?? []).map((item) => item.id);
const labelled = (provenance: string): boolean => PROVENANCE_LABELS.some((label) => provenance.startsWith(label));

describe("the BIOBUZZ field drawing", () => {
  it("names only zones, hives and envelopes the field file has", () => {
    for (const zone of Object.keys(fieldDrawing.tapedZones)) expect(ids("zones")).toContain(zone);
    for (const hive of fieldDrawing.hives) {
      expect(ids("elements")).toContain(hive.element);
      expect(ids("obstacles")).toContain(hive.envelope);
    }
  });

  it("gives every number a rule-4 provenance", () => {
    const provenances = [
      fieldDrawing.tapeProvenance,
      fieldDrawing.hiveAxle.provenance,
      fieldDrawing.tileSeam.provenance,
      ...fieldDrawing.gardens.map((area) => area.provenance),
      ...fieldDrawing.allianceAreas.map((area) => area.provenance),
    ];
    expect(provenances.filter((provenance) => !labelled(provenance))).toEqual([]);
  });

  it("is point-symmetric, like the field", () => {
    for (const list of [fieldDrawing.gardens, fieldDrawing.allianceAreas]) {
      const red = list.find((area) => area.alliance === "RED");
      const blue = list.find((area) => area.alliance === "BLUE");
      if (red === undefined || blue === undefined) throw new Error("both alliances need one");
      expect([blue.minXIn, blue.maxXIn, blue.minYIn, blue.maxYIn]).toEqual([-red.maxXIn, -red.minXIn, -red.maxYIn, -red.minYIn]);
    }
  });

  it("draws the frame's crossbar where the CAD has it, x = -12 to +12 on y = 0 (issue #229)", () => {
    expect(fieldDrawing.hiveAxle).toMatchObject({ fromXIn: -12, toXIn: 12, yIn: 0 });
    expect(fieldDrawing.hiveAxle.provenance).toContain("am-5875");
  });

  it("draws the tile seams with the FTC soft tile's tab edge from FIRST's field CAD (issue #428)", () => {
    expect(fieldDrawing.tileSeam).toBe(ftcTileSeam);
    // The numbers the CAD's am-2499 tiles give, in inches (TRANSCRIPTION.md, Tile seams).
    expect(ftcTileSeam).toMatchObject({ edgeIn: 23.502, pitchIn: 2.3689, depthIn: 0.8104, tabWidthIn: 1.7018, filletRadiusIn: 0.1247 });
    // A tab is a dovetail: wider at its end than at its root, which is what is left of the pitch.
    const rootIn = ftcTileSeam.pitchIn - ftcTileSeam.tabWidthIn;
    expect(rootIn).toBeCloseTo(0.6671, 4);
    expect(rootIn).toBeLessThan(ftcTileSeam.tabWidthIn);
    // Its sides lean 32.55 degrees from square to the seam.
    const leanIn = ftcTileSeam.tabWidthIn - ftcTileSeam.pitchIn / 2;
    expect((Math.atan(leanIn / ftcTileSeam.depthIn) * 180) / Math.PI).toBeCloseTo(32.55, 1);
    // The tile is nominally 24 in (Competition Manual V1 §9.2); the CAD's is 2.1 % smaller.
    expect(24 / ftcTileSeam.edgeIn).toBeCloseTo(1.0212, 4);
    const { provenance } = ftcTileSeam;
    expect(provenance.startsWith("SPEC (FIRST's BIOBUZZ field CAD, STEP v26-27.2, sha256 5e768b73…fe00: parts am-2499-Center")).toBe(true);
    for (const part of ["am-2499-Side", "am-2499-Corner", "Fig 9-4", "TRANSCRIPTION.md"]) expect(provenance).toContain(part);
    expect(provenance.toLowerCase()).not.toContain("dsim");
  });

  it("puts the red garden in the red corner as a band of two tapes", () => {
    const red = fieldDrawing.gardens.find((area) => area.alliance === "RED");
    expect(red?.minXIn).toBe(-72);
    expect(red?.minYIn).toBe(-72);
    expect((red?.maxYIn ?? 0) - (red?.minYIn ?? 0)).toBe(2 * fieldDrawing.tapeWidthIn);
  });
});
