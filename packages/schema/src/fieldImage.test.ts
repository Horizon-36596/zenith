import { describe, expect, it } from "vitest";
import { SCHEMA_ID } from "./ids.js";
import { parseField, validateKind } from "./parse.js";

const fieldWith = (image: unknown): unknown => ({
  $schema: SCHEMA_ID.field,
  formatVersion: 2,
  season: "fixture",
  name: "Image fixture field",
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
  ...(image === undefined ? {} : { image }),
});

describe("format version 2: the field image", () => {
  it("is optional", () => {
    expect(parseField(fieldWith(undefined)).image).toBeUndefined();
  });

  it("accepts a pixel box and a quarter-turn rotation", () => {
    const image = {
      src: "images/biobuzz.png",
      credit: "Community BIOBUZZ field image (r/FTC)",
      pxBoundsIn: { left: 12, top: 10.5, right: 1012, bottom: 1010.5 },
      rotationDeg: 90,
      provenance: "SET BY HAND 2026-09-22: perimeter corners read off the image",
    };
    expect(parseField(fieldWith(image)).image).toEqual(image);
  });

  it("accepts fullBleed and leaves rotation absent", () => {
    const image = { src: "field.png", credit: "Horizon (FTC 36596)", pxBoundsIn: "fullBleed" };
    expect(parseField(fieldWith(image)).image?.rotationDeg).toBeUndefined();
  });

  it("refuses a rotation that is not a quarter turn", () => {
    const image = { src: "f.png", credit: "c", pxBoundsIn: "fullBleed", rotationDeg: 45 };
    expect(validateKind("field", fieldWith(image)).ok).toBe(false);
  });

  it("refuses a box whose right is not right of its left", () => {
    const image = {
      src: "f.png",
      credit: "c",
      pxBoundsIn: { left: 100, top: 0, right: 50, bottom: 100 },
    };
    const result = validateKind("field", fieldWith(image));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join(" ")).toMatch(/right > left/);
  });

  it("accepts named variants alongside the single src, and the single form without them", () => {
    const image = {
      src: "app:fields/biobuzz/biobuzz-dark.webp",
      credit: "Field image by Team Juice 16236",
      pxBoundsIn: "fullBleed",
      rotationDeg: 90,
      variants: [
        { name: "dark", src: "app:fields/biobuzz/biobuzz-dark.webp" },
        { name: "black", src: "app:fields/biobuzz/biobuzz-black.webp" },
        { name: "light", src: "app:fields/biobuzz/biobuzz-light.webp" },
      ],
    };
    expect(parseField(fieldWith(image)).image?.variants?.map((v) => v.name)).toEqual([
      "dark",
      "black",
      "light",
    ]);
    const { variants: _variants, ...single } = image;
    expect(parseField(fieldWith(single)).image?.variants).toBeUndefined();
  });

  it("refuses two variants with the same name", () => {
    const image = {
      src: "a.webp",
      credit: "c",
      pxBoundsIn: "fullBleed",
      variants: [
        { name: "dark", src: "a.webp" },
        { name: "dark", src: "b.webp" },
      ],
    };
    const result = validateKind("field", fieldWith(image));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join(" ")).toMatch(/its own name/);
  });

  it("needs a credit", () => {
    const image = { src: "f.png", pxBoundsIn: "fullBleed" };
    expect(validateKind("field", fieldWith(image)).ok).toBe(false);
  });
});
