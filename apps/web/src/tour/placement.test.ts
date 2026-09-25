import { describe, expect, it } from "vitest";
import { GAP, MARGIN, grow, intersects, placeCard, type Box, type PlaceInput } from "./placement";

const VIEWPORT = { width: 1440, height: 900 };
const CARD = { width: 340, height: 244 };

/** The shell at 1440 x 900: steps on the left, the field in the middle, the inspector on the right. */
const STEPS: Box = { left: 0, top: 201, width: 300, height: 658 };
const FIELD: Box = { left: 301, top: 80, width: 818, height: 639 };
const INSPECTOR: Box = { left: 1120, top: 80, width: 320, height: 820 };
const INSERT_BUTTON: Box = { left: 8, top: 600, width: 284, height: 32 };

const ring = (box: Box): Box => grow(box, 8);

function input(overrides: Partial<PlaceInput>): PlaceInput {
  return {
    viewport: VIEWPORT,
    target: null,
    avoid: [],
    card: CARD,
    preferredWidth: 340,
    minWidth: 260,
    ...overrides,
  };
}

const boxOf = (placed: { left: number; top: number; width: number }, height = CARD.height): Box => ({
  left: placed.left,
  top: placed.top,
  width: placed.width,
  height: height * (CARD.width / placed.width),
});

const onScreen = (box: Box): boolean =>
  box.left >= MARGIN - 1 &&
  box.top >= MARGIN - 1 &&
  box.left + box.width <= VIEWPORT.width - MARGIN + 1 &&
  box.top + box.height <= VIEWPORT.height - MARGIN + 1;

describe("intersects", () => {
  it("counts shared area and not a shared edge", () => {
    const a = { left: 0, top: 0, width: 10, height: 10 };
    expect(intersects(a, { left: 5, top: 5, width: 10, height: 10 })).toBe(true);
    expect(intersects(a, { left: 10, top: 0, width: 10, height: 10 })).toBe(false);
    expect(intersects(a, { left: 0, top: 20, width: 10, height: 10 })).toBe(false);
  });
});

describe("placeCard", () => {
  it("centres the card when the stop has no anchor", () => {
    const placed = placeCard(input({}));
    expect(placed.width).toBe(340);
    expect(placed.left).toBeCloseTo((VIEWPORT.width - 340) / 2);
    expect(placed.top).toBeCloseTo((VIEWPORT.height - CARD.height) / 2);
  });

  it("sits on the stop's side of the ring, a gap away, aligned to its top", () => {
    const target = ring(INSERT_BUTTON);
    const placed = placeCard(input({ target, side: "right" }));
    expect(placed.left).toBe(target.left + target.width + GAP);
    expect(placed.top).toBe(target.top);
    expect(intersects(boxOf(placed), target)).toBe(false);
  });

  it("flips to another side when the stop's side has no room", () => {
    const target = ring(INSPECTOR);
    const placed = placeCard(input({ target, side: "right" }));
    const box = boxOf(placed);
    expect(intersects(box, target)).toBe(false);
    expect(box.left + box.width).toBeLessThanOrEqual(target.left);
  });

  it("never covers a big anchor such as the whole field: it narrows to fit beside it", () => {
    const target = ring(FIELD);
    const placed = placeCard(input({ target, side: "right" }));
    const box = boxOf(placed);
    expect(intersects(box, target)).toBe(false);
    expect(onScreen(box)).toBe(true);
    expect(placed.width).toBeLessThan(340);
    expect(placed.width).toBeGreaterThanOrEqual(260);
  });

  it("keeps off an open menu under the anchor, and off a tooltip beside it", () => {
    const target = ring(INSERT_BUTTON);
    const menu: Box = { left: 12, top: 640, width: 276, height: 250 };
    const tooltip: Box = { left: 296, top: 610, width: 280, height: 60 };
    const placed = placeCard(input({ target, side: "right", avoid: [menu, tooltip] }));
    const box = boxOf(placed);
    expect(intersects(box, target)).toBe(false);
    expect(intersects(box, menu)).toBe(false);
    expect(intersects(box, tooltip)).toBe(false);
    expect(onScreen(box)).toBe(true);
  });

  it("stays where it is while that is still clear, so it does not jump", () => {
    const target = ring(STEPS);
    const previous = { left: 700, top: 400, width: 340 };
    expect(placeCard(input({ target, previous }))).toEqual(previous);
  });

  it("moves when a popover opens where it is", () => {
    const target = ring(STEPS);
    const previous = { left: 700, top: 400, width: 340 };
    const tooltip: Box = { left: 800, top: 420, width: 200, height: 40 };
    const placed = placeCard(input({ target, previous, avoid: [tooltip] }));
    expect(placed).not.toEqual(previous);
    expect(intersects(boxOf(placed), grow(tooltip, 4))).toBe(false);
    expect(intersects(boxOf(placed), target)).toBe(false);
  });

  it("moves when the previous spot would now cover the anchor", () => {
    const target = ring({ left: 690, top: 390, width: 60, height: 30 });
    const previous = { left: 700, top: 400, width: 340 };
    const placed = placeCard(input({ target, previous }));
    expect(intersects(boxOf(placed), target)).toBe(false);
  });

  it("overlaps as little as it can, and stays on screen, when nothing is clear", () => {
    const everything: Box = { left: 0, top: 0, width: VIEWPORT.width, height: VIEWPORT.height - 100 };
    const placed = placeCard(input({ target: ring(INSERT_BUTTON), avoid: [everything] }));
    const box = boxOf(placed);
    expect(placed.width).toBe(340);
    expect(box.top + box.height).toBeLessThanOrEqual(VIEWPORT.height - MARGIN + 1);
    expect(box.left).toBeGreaterThanOrEqual(MARGIN);
  });

  it("clears every popover in a crowded window when some spot is free", () => {
    const target = ring(INSERT_BUTTON);
    const avoid: Box[] = [
      { left: 300, top: 0, width: 1140, height: 250 },
      { left: 300, top: 620, width: 1140, height: 280 },
    ];
    const placed = placeCard(input({ target, avoid }));
    const box = boxOf(placed);
    for (const other of [target, ...avoid.map((b) => grow(b, 4))]) expect(intersects(box, other)).toBe(false);
  });
});
