import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadField } from "@horizon36596/zenith-core";
import type { Field } from "@horizon36596/zenith-schema";
import { describe, expect, it } from "vitest";
import {
  applyAffine,
  chooseImageSource,
  cornersOnField,
  creditLine,
  imageToScreen,
  readFieldImage,
  resolveImageUrl,
  type FieldImageSpec,
} from "./fieldImage.js";

const BOUNDS = { minXIn: -72, maxXIn: 72, minYIn: -72, maxYIn: 72 };
/** The default view: audience at the bottom, one pixel per inch, origin at (0, 0). */
const toScreen = (point: { xIn: number; yIn: number }): { xPx: number; yPx: number } => ({
  xPx: point.xIn,
  yPx: -point.yIn,
});

const spec = (overrides: Partial<FieldImageSpec> = {}): FieldImageSpec => ({
  src: "app:fields/biobuzz/biobuzz-dark.webp",
  credit: "Team Juice 16236",
  pxBounds: "fullBleed",
  rotationDeg: 90,
  variants: [],
  ...overrides,
});

describe("where the picture lands", () => {
  it("puts an unrotated picture's top edge on the far wall", () => {
    const corners = cornersOnField(BOUNDS, 0);
    expect(corners.tl).toEqual({ xIn: -72, yIn: 72 });
    expect(corners.tr).toEqual({ xIn: 72, yIn: 72 });
  });

  it("turns a 90 degree picture clockwise, so its top edge becomes the +X wall", () => {
    const m = imageToScreen(spec(), 1080, 1080, BOUNDS, toScreen);
    const topLeft = applyAffine(m, 0, 0);
    const topRight = applyAffine(m, 1080, 0);
    const bottomLeft = applyAffine(m, 0, 1080);
    expect(topLeft.x).toBeCloseTo(72, 9);
    expect(topLeft.y).toBeCloseTo(-72, 9);
    expect(topRight.x).toBeCloseTo(72, 9);
    expect(topRight.y).toBeCloseTo(72, 9);
    expect(bottomLeft.x).toBeCloseTo(-72, 9);
    expect(bottomLeft.y).toBeCloseTo(-72, 9);
  });

  it("maps the picture's centre to the field's centre and one 180 px tile to 24 in", () => {
    const m = imageToScreen(spec(), 1080, 1080, BOUNDS, toScreen);
    const centre = applyAffine(m, 540, 540);
    expect(centre.x).toBeCloseTo(0, 9);
    expect(centre.y).toBeCloseTo(0, 9);
    const a = applyAffine(m, 0, 0);
    const b = applyAffine(m, 180, 0);
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(24, 9);
  });

  it("crops to pxBoundsIn before mapping", () => {
    const m = imageToScreen(
      spec({ rotationDeg: 0, pxBounds: { left: 100, top: 50, right: 820, bottom: 770 } }),
      1000,
      1000,
      BOUNDS,
      toScreen,
    );
    expect(applyAffine(m, 100, 50).x).toBeCloseTo(-72, 9);
    expect(applyAffine(m, 820, 770).x).toBeCloseTo(72, 9);
    expect(applyAffine(m, 820, 770).y).toBeCloseTo(72, 9);
  });
});

describe("reading field.image", () => {
  const field = (image: unknown): Field => ({ image } as unknown as Field);

  it("reads the variants, and draws src when no variant is chosen or the name is unknown", () => {
    const read = readFieldImage(
      field({
        src: "app:a-dark.webp",
        credit: "x",
        pxBoundsIn: "fullBleed",
        rotationDeg: 90,
        variants: [
          { name: "dark", src: "app:a-dark.webp" },
          { name: "light", src: "app:a-light.webp" },
        ],
      }),
    );
    expect(read?.variants.map((variant) => variant.name)).toEqual(["dark", "light"]);
    expect(chooseImageSource(read as FieldImageSpec, "light")).toBe("app:a-light.webp");
    expect(chooseImageSource(read as FieldImageSpec, undefined)).toBe("app:a-dark.webp");
    expect(chooseImageSource(read as FieldImageSpec, "sepia")).toBe("app:a-dark.webp");
  });

  it("returns null for a missing or malformed image, so the canvas falls back to vector", () => {
    expect(readFieldImage(field(undefined))).toBeNull();
    expect(readFieldImage(field({ src: "" }))).toBeNull();
    expect(readFieldImage(field({ src: "a.png", pxBoundsIn: { left: 5, top: 0, right: 5, bottom: 9 } }))).toBeNull();
  });

  it("resolves an app: source against the app's public root and leaves others alone", () => {
    expect(resolveImageUrl("app:fields/biobuzz/biobuzz-dark.webp")).toBe("/fields/biobuzz/biobuzz-dark.webp");
    expect(resolveImageUrl("app:fields/x.webp", "/zenith")).toBe("/zenith/fields/x.webp");
    expect(resolveImageUrl("images/field.png")).toBe("images/field.png");
  });

  it("writes the credit one way, whatever form the file uses", () => {
    for (const credit of ["Team Juice 16236", "Field image by Team Juice 16236", "Field image: Team Juice 16236"]) {
      expect(creditLine(spec({ credit }))).toBe("Field image: Team Juice 16236");
    }
    expect(creditLine(spec({ credit: null }))).toBeNull();
  });
});

const examples = fileURLToPath(new URL("../../../../examples/starter/", import.meta.url));

describe.skipIf(!existsSync(`${examples}zenith.json`))("the starter example field", () => {
  it("ships the dark picture by default, with dark, black and light styles and its credit", () => {
    const loaded = loadField(JSON.parse(readFileSync(`${examples}autos/field/biobuzz.field.json`, "utf8")) as unknown);
    const read = readFieldImage(loaded);
    expect(read?.rotationDeg).toBe(90);
    expect(read?.pxBounds).toBe("fullBleed");
    expect(resolveImageUrl(chooseImageSource(read as FieldImageSpec, null))).toBe("/fields/biobuzz/biobuzz-dark.webp");
    expect(read?.variants.map((variant) => variant.name)).toEqual(["dark", "black", "light"]);
    expect(creditLine(read)).toBe("Field image: Team Juice 16236");
  });
});
