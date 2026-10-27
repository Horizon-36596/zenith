import { describe, expect, it } from "vitest";
import { FORMAT_VERSIONS, SCHEMA_ID } from "./ids.js";
import { toJsonSchema } from "./jsonschema.js";
import { parseField, validateKind } from "./parse.js";

/** One leg of a hive frame as a strut: the shape issue #228 adds. */
const strut = {
  id: "frameLegNorthEast",
  kind: "strut",
  fromIn: { xIn: 23.81, yIn: 18.56, zIn: 0.53 },
  toIn: { xIn: 12.74, yIn: 0.51, zIn: 41.09 },
  radiusIn: 0.78,
  solidToRobot: true,
  provenance: "PLACEHOLDER: test fixture, the shape of one hive-frame leg",
};

const fieldWith = (obstacles: unknown[]): unknown => ({
  $schema: SCHEMA_ID.field,
  formatVersion: 3,
  season: "fixture",
  name: "Strut fixture field",
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
  obstacles,
});

describe("format version 3: the strut obstacle", () => {
  it("is the field's current version", () => {
    expect(FORMAT_VERSIONS.field).toBe(3);
  });

  it("accepts a strut beside a box", () => {
    const box = {
      id: "frameBarEast",
      kind: "box",
      minXIn: 22.75,
      maxXIn: 24.735,
      minYIn: -19.472,
      maxYIn: 19.472,
      minZIn: 0,
      maxZIn: 2.148,
      solidToRobot: true,
      provenance: "PLACEHOLDER: test fixture",
    };
    expect(parseField(fieldWith([box, strut])).obstacles).toEqual([box, strut]);
  });

  it("refuses a strut with a missing unit key, naming it", () => {
    const { zIn: _dropped, ...noZ } = strut.toIn;
    const result = validateKind("field", fieldWith([{ ...strut, toIn: noZ }]));
    expect(result.ok).toBe(false);
    expect(() => parseField(fieldWith([{ ...strut, toIn: noZ }]))).toThrow(/obstacles\.0\.toIn\.zIn/);
  });

  it("refuses a strut with no radius or a radius that is not positive", () => {
    const { radiusIn: _dropped, ...noRadius } = strut;
    expect(validateKind("field", fieldWith([noRadius])).ok).toBe(false);
    expect(validateKind("field", fieldWith([{ ...strut, radiusIn: 0 }])).ok).toBe(false);
  });

  it("refuses a strut written with a box's keys", () => {
    const { fromIn: _from, toIn: _to, ...bare } = strut;
    expect(validateKind("field", fieldWith([{ ...bare, minXIn: 0, maxXIn: 1 }])).ok).toBe(false);
  });

  it("is in the generated JSON Schema, with every unit key required", () => {
    const text = JSON.stringify(toJsonSchema("field"));
    expect(text).toContain('"const":"strut"');
    expect(text).toContain('"required":["xIn","yIn","zIn"]');
    expect(text).toContain('"radiusIn"');
    expect(toJsonSchema("field")["title"]).toBe("Zenith field file, formatVersion 3");
  });
});
