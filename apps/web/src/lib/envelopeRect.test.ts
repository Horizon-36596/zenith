/**
 * The rectangle math behind envelopes on the field (issue #120): reading a polygon as a rectangle,
 * writing one back in the canonical corner order, resizing by a corner or a side, drawing corner to
 * corner, moving, and the minimum size that keeps a rectangle from collapsing or inverting.
 */
import { squareEnvelopeAround } from "@horizon36596/zenith-core";
import { describe, expect, it } from "vitest";
import {
  ENVELOPE_MIN_SIDE_IN,
  handlePoint,
  isRectangle,
  moveRect,
  nearestCorner,
  rectFromBox,
  rectFromCorners,
  rectOfPolygon,
  rectPolygon,
  resizeRect,
  type Rect,
} from "./envelopeRect";

const RECT: Rect = { minXIn: -48, minYIn: -48, maxXIn: -24, maxYIn: -36 };

describe("rectangles and polygons", () => {
  it("writes a rectangle counter-clockwise from the south-west corner, as core's square does", () => {
    expect(rectPolygon(RECT)).toEqual([
      { xIn: -48, yIn: -48 },
      { xIn: -24, yIn: -48 },
      { xIn: -24, yIn: -36 },
      { xIn: -48, yIn: -36 },
    ]);
    const square = squareEnvelopeAround({ xIn: 0, yIn: 0 }, 24, 3, "SET BY HAND").polygon;
    expect(rectPolygon(rectOfPolygon(square))).toEqual(square);
  });

  it("reads any axis-aligned four-corner polygon as a rectangle, either way round and from any corner", () => {
    expect(isRectangle(rectPolygon(RECT))).toBe(true);
    expect(isRectangle([...rectPolygon(RECT)].reverse())).toBe(true);
    const [a, b, c, d] = rectPolygon(RECT);
    expect(isRectangle([c!, d!, a!, b!])).toBe(true);
  });

  it("does not call other shapes rectangles", () => {
    const [a, b, c, d] = rectPolygon(RECT);
    expect(isRectangle([a!, c!, b!, d!])).toBe(false); // a bow tie across the same corners
    expect(isRectangle([a!, b!, c!])).toBe(false);
    expect(isRectangle([a!, b!, { xIn: -20, yIn: -36 }, d!])).toBe(false);
    expect(isRectangle([{ xIn: 0, yIn: 0 }, { xIn: 10, yIn: 0 }, { xIn: 10, yIn: 0 }, { xIn: 0, yIn: 0 }])).toBe(false);
    // A diamond: four corners, but no edge runs along an axis.
    expect(isRectangle([{ xIn: 0, yIn: -5 }, { xIn: 5, yIn: 0 }, { xIn: 0, yIn: 5 }, { xIn: -5, yIn: 0 }])).toBe(false);
  });

  it("takes the bounding rectangle of any polygon, which is what converting a custom shape writes", () => {
    expect(rectOfPolygon([{ xIn: 0, yIn: -5 }, { xIn: 5, yIn: 0 }, { xIn: 0, yIn: 5 }, { xIn: -5, yIn: 0 }])).toEqual({
      minXIn: -5,
      minYIn: -5,
      maxXIn: 5,
      maxYIn: 5,
    });
  });

  it("puts each handle on its corner or the middle of its side", () => {
    expect(handlePoint(RECT, "ne")).toEqual({ xIn: -24, yIn: -36 });
    expect(handlePoint(RECT, "sw")).toEqual({ xIn: -48, yIn: -48 });
    expect(handlePoint(RECT, "n")).toEqual({ xIn: -36, yIn: -36 });
    expect(handlePoint(RECT, "w")).toEqual({ xIn: -48, yIn: -42 });
  });
});

describe("resizeRect", () => {
  it("moves a corner's two sides and keeps the opposite corner", () => {
    expect(resizeRect(RECT, "ne", { xIn: -10, yIn: -20 })).toEqual({ minXIn: -48, minYIn: -48, maxXIn: -10, maxYIn: -20 });
    expect(resizeRect(RECT, "sw", { xIn: -60, yIn: -50 })).toEqual({ minXIn: -60, minYIn: -50, maxXIn: -24, maxYIn: -36 });
  });

  it("moves a side alone and ignores the pointer along it", () => {
    expect(resizeRect(RECT, "e", { xIn: -10, yIn: 100 })).toEqual({ minXIn: -48, minYIn: -48, maxXIn: -10, maxYIn: -36 });
    expect(resizeRect(RECT, "s", { xIn: 100, yIn: -60 })).toEqual({ minXIn: -48, minYIn: -60, maxXIn: -24, maxYIn: -36 });
  });

  it("flips over when a side is dragged past the opposite one, so min stays below max", () => {
    expect(resizeRect(RECT, "e", { xIn: -60, yIn: 0 })).toEqual({ minXIn: -60, minYIn: -48, maxXIn: -48, maxYIn: -36 });
    expect(resizeRect(RECT, "ne", { xIn: -50, yIn: -52 })).toEqual({ minXIn: -50, minYIn: -52, maxXIn: -48, maxYIn: -48 });
  });

  it("never makes a side shorter than the minimum", () => {
    const thin = resizeRect(RECT, "e", { xIn: -47.9, yIn: 0 });
    expect(thin.maxXIn - thin.minXIn).toBe(ENVELOPE_MIN_SIDE_IN);
    expect(thin.minXIn).toBe(-48);
    const onTop = resizeRect(RECT, "n", { xIn: 0, yIn: -48 });
    expect(onTop).toEqual({ minXIn: -48, minYIn: -48, maxXIn: -24, maxYIn: -48 + ENVELOPE_MIN_SIDE_IN });
  });

  it("keeps the aspect ratio of a corner drag on request, following the larger stretch", () => {
    // 24 by 12: a pointer 36 across and only 6 up still gives 36 by 18.
    expect(resizeRect(RECT, "ne", { xIn: -12, yIn: -42 }, { keepAspect: true })).toEqual({
      minXIn: -48,
      minYIn: -48,
      maxXIn: -12,
      maxYIn: -30,
    });
    // An edge has no aspect to keep.
    expect(resizeRect(RECT, "e", { xIn: -12, yIn: 0 }, { keepAspect: true })).toEqual({ ...RECT, maxXIn: -12 });
  });

  it("keeps the aspect ratio when a corner drag shrinks the rectangle to the minimum (issue #401)", () => {
    // 24 by 12 pulled almost onto its fixed corner: the short side stops at the minimum, the long
    // side at twice that, not a 1 by 1 square.
    const shrunk = resizeRect({ minXIn: 0, minYIn: 0, maxXIn: 24, maxYIn: 12 }, "ne", { xIn: 0.2, yIn: 0.1 }, { keepAspect: true });
    expect(shrunk).toEqual({ minXIn: 0, minYIn: 0, maxXIn: 2 * ENVELOPE_MIN_SIDE_IN, maxYIn: ENVELOPE_MIN_SIDE_IN });
  });
});

describe("drawing, moving and typing a rectangle", () => {
  it("draws from one corner to the opposite in any direction", () => {
    expect(rectFromCorners({ xIn: 10, yIn: 10 }, { xIn: 0, yIn: 20 })).toEqual({ minXIn: 0, minYIn: 10, maxXIn: 10, maxYIn: 20 });
    expect(rectFromCorners({ xIn: 10, yIn: 10 }, { xIn: 10, yIn: 10 })).toEqual({
      minXIn: 10,
      minYIn: 10,
      maxXIn: 10 + ENVELOPE_MIN_SIDE_IN,
      maxYIn: 10 + ENVELOPE_MIN_SIDE_IN,
    });
  });

  it("moves without changing size, and snaps by the corner nearest the press", () => {
    expect(moveRect(RECT, 5, -2)).toEqual({ minXIn: -43, minYIn: -50, maxXIn: -19, maxYIn: -38 });
    expect(nearestCorner(RECT, { xIn: -26, yIn: -46 })).toEqual({ xIn: -24, yIn: -48 });
  });

  it("builds the rectangle from the inspector's x, y, width and height, raising a tiny side to the minimum", () => {
    expect(rectFromBox(-48, -48, 24, 12)).toEqual(RECT);
    expect(rectFromBox(0, 0, 0, -5)).toEqual({ minXIn: 0, minYIn: 0, maxXIn: ENVELOPE_MIN_SIDE_IN, maxYIn: ENVELOPE_MIN_SIDE_IN });
  });
});
