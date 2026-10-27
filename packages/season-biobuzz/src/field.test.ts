import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PROVENANCE_LABELS } from "@horizon36596/zenith-core";
import { describe, expect, it } from "vitest";
import { fieldDrawing } from "./drawing.js";

const seasonField = fileURLToPath(new URL("../field/biobuzz.field.json", import.meta.url));
const exampleField = fileURLToPath(
  new URL("../../../examples/starter/autos/field/biobuzz.field.json", import.meta.url),
);

interface Sourced {
  id: string;
  provenance?: string;
}

function items(path: string): Sourced[] {
  const field = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  return ["obstacles", "zones", "elements", "targets"].flatMap(
    (key) => (field[key] as Sourced[] | undefined) ?? [],
  );
}

describe("BIOBUZZ field provenance", () => {
  it("finding 31: every item's provenance starts with a rule-4 label", () => {
    const unlabelled = items(seasonField)
      .filter((item) => !PROVENANCE_LABELS.some((label) => item.provenance?.startsWith(label)))
      .map((item) => item.id);
    expect(unlabelled).toEqual([]);
  });

  it("finding 31: the starter project's copy of the field matches the season's", () => {
    const normalise = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
    expect(normalise(exampleField)).toBe(normalise(seasonField));
  });
});

interface Point3 {
  xIn: number;
  yIn: number;
  zIn: number;
}
interface Obstacle {
  id: string;
  kind: string;
  provenance?: string;
  fromIn?: Point3;
  toIn?: Point3;
  radiusIn?: number;
  minXIn?: number;
  maxXIn?: number;
  minYIn?: number;
  maxYIn?: number;
  minZIn?: number;
  maxZIn?: number;
}

const obstacles = (JSON.parse(readFileSync(seasonField, "utf8")) as { obstacles: Obstacle[] }).obstacles;
const obstacle = (id: string): Obstacle => {
  const found = obstacles.find((each) => each.id === id);
  if (found === undefined) throw new Error(`the field has no ${id}`);
  return found;
};

/**
 * Issue #229: the hive frame's four slanted legs and its two corrected foot bars, from FIRST's
 * BIOBUZZ STEP CAD (TRANSCRIPTION.md, Hive frame).
 */
describe("issue #229: the hive frame", () => {
  const legs = ["frameLegNorthEast", "frameLegSouthEast", "frameLegNorthWest", "frameLegSouthWest"];

  it("has the four legs as struts, each from its foot on the floor up to the frame's top", () => {
    for (const id of legs) {
      const leg = obstacle(id);
      expect(leg.kind, id).toBe("strut");
      expect(leg.fromIn?.zIn, id).toBeLessThan(1);
      expect(leg.toIn?.zIn, id).toBeGreaterThan(40);
      expect(Math.abs(leg.fromIn?.xIn ?? 0), id).toBeGreaterThan(Math.abs(leg.toIn?.xIn ?? 0));
    }
    expect(obstacle("frameLegNorthEast").fromIn?.xIn).toBeGreaterThan(0);
    expect(obstacle("frameLegNorthEast").fromIn?.yIn).toBeGreaterThan(0);
    expect(obstacle("frameLegSouthWest").fromIn?.xIn).toBeLessThan(0);
    expect(obstacle("frameLegSouthWest").fromIn?.yIn).toBeLessThan(0);
  });

  it("is point-symmetric: each leg is the point mirror of its opposite, within 0.01 in", () => {
    const mirrored = (point: Point3 | undefined): Point3 => ({
      xIn: -(point?.xIn ?? NaN),
      yIn: -(point?.yIn ?? NaN),
      zIn: point?.zIn ?? NaN,
    });
    for (const [a, b] of [
      ["frameLegNorthEast", "frameLegSouthWest"],
      ["frameLegSouthEast", "frameLegNorthWest"],
    ] as const) {
      const one = obstacle(a);
      const other = obstacle(b);
      for (const end of ["fromIn", "toIn"] as const) {
        const want = mirrored(one[end]);
        const got = other[end];
        expect(Math.abs((got?.xIn ?? NaN) - want.xIn), `${b}.${end}.xIn`).toBeLessThanOrEqual(0.01);
        expect(Math.abs((got?.yIn ?? NaN) - want.yIn), `${b}.${end}.yIn`).toBeLessThanOrEqual(0.01);
        expect(Math.abs((got?.zIn ?? NaN) - want.zIn), `${b}.${end}.zIn`).toBeLessThanOrEqual(0.01);
      }
      expect(other.radiusIn).toBe(one.radiusIn);
    }
  });

  it("puts the foot bars where the CAD has them, the west one the point mirror of the east", () => {
    const east = obstacle("frameBarEast");
    const west = obstacle("frameBarWest");
    // CAD am-5878 spans x 22.75 to 24.735, |y| up to 19.472 and z 0 to 2.148, and the box holds it.
    expect(east.minXIn).toBeLessThanOrEqual(22.75);
    expect(east.minXIn).toBeGreaterThan(22.5);
    expect(east.maxXIn).toBeGreaterThanOrEqual(24.735);
    expect(east.maxXIn).toBeLessThan(24.8);
    expect(east.maxYIn).toBeGreaterThanOrEqual(19.472);
    expect(east.maxYIn).toBeLessThan(19.5);
    expect(east.minYIn).toBe(-(east.maxYIn ?? NaN));
    expect(east.minZIn).toBe(0);
    expect(east.maxZIn).toBeGreaterThanOrEqual(2.148);
    expect(east.maxZIn).toBeLessThan(2.2);
    expect([west.minXIn, west.maxXIn, west.minYIn, west.maxYIn, west.minZIn, west.maxZIn]).toEqual([
      -(east.maxXIn ?? NaN),
      -(east.minXIn ?? NaN),
      -(east.maxYIn ?? NaN),
      -(east.minYIn ?? NaN),
      east.minZIn,
      east.maxZIn,
    ]);
  });

  it("cites the STEP CAD on every frame number and leaves no NEEDS MEASUREMENT on it", () => {
    for (const id of ["frameBarEast", "frameBarWest", ...legs]) {
      const provenance = obstacle(id).provenance ?? "";
      expect(provenance, id).toMatch(/^SPEC/);
      expect(provenance, id).not.toContain("NEEDS MEASUREMENT");
    }
    expect(obstacle("frameLegNorthEast").provenance).toContain("STEP v26-27.2");
    expect(obstacle("frameLegNorthEast").provenance).toContain("am-5876");
    expect(obstacle("frameBarEast").provenance).toContain("am-5878");
  });

  /**
   * Issue #272, the owner's ruling on #200: a number the manual leaves out may come from FIRST's field
   * CAD, labelled `SPEC (FIRST's BIOBUZZ field CAD, STEP v26-27.2, sha256 …: part …)`, citing FIRST
   * and the CAD zip's sha only, never DSim or any other simulator.
   */
  it("labels every frame number the approved way, in the season file and the starter copy", () => {
    const form = (part: string) =>
      new RegExp(`^SPEC \\(FIRST's BIOBUZZ field CAD, STEP v26-27\\.2, sha256 5e768b73…fe00: [^)]*part ${part}`);
    const elsewhere = /dsim|simulator|FieldConstants|\.java|biobuzz repo|biobuzz[- ]zenith/i;
    const parts: Array<[string, string]> = [
      ["frameBarEast", "am-5878 Sheet Metal Foot Bar"],
      ["frameBarWest", "am-5878 Sheet Metal Foot Bar"],
      ["frameLegNorthEast", "am-5876 A-Frame Leg"],
      ["frameLegSouthEast", "am-5876 A-Frame Leg"],
      ["frameLegNorthWest", "am-5876 A-Frame Leg"],
      ["frameLegSouthWest", "am-5876 A-Frame Leg"],
    ];
    for (const [copy, path] of [
      ["the season file", seasonField],
      ["the starter copy", exampleField],
    ] as const) {
      const field = JSON.parse(readFileSync(path, "utf8")) as { obstacles: Obstacle[] };
      // Every frame obstacle in the file must be in the table, so a new one cannot skip the label.
      const frameIds = field.obstacles.filter((each) => each.id.startsWith("frame")).map((each) => each.id);
      expect(frameIds.sort(), `frame obstacles in ${copy}`).toEqual(parts.map(([id]) => id).sort());
      for (const [id, part] of parts) {
        const provenance = field.obstacles.find((each) => each.id === id)?.provenance ?? "";
        expect(provenance, `${id} in ${copy}`).toMatch(form(part));
        expect(provenance, `${id} in ${copy}`).not.toMatch(elsewhere);
      }
    }
    // The crossbar is drawn, not an obstacle, and its label is the same form.
    expect(fieldDrawing.hiveAxle.provenance).toMatch(form("am-5875 A-Frame Top Bar"));
    expect(fieldDrawing.hiveAxle.provenance).not.toMatch(elsewhere);
  });

  it("starts no obstacle id with hiveRed, hiveBlue or flower unless it is that hive or flower", () => {
    // season-biobuzz finds a hive's or a flower's obstacles by the start of their ids.
    const owned = /^(hive(Red|Blue)PivotBar|flower\d+Foot)$/;
    const misnamed = obstacles
      .filter((each) => /^(hiveRed|hiveBlue|flower)/.test(each.id) && !owned.test(each.id))
      .map((each) => each.id);
    expect(misnamed).toEqual([]);
  });
});
