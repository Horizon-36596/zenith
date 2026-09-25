/**
 * Where the coach-mark card goes (UI_GUIDE sections 10.1 and 10.2). The tour is non-modal, so the card is the only thing it puts in the person's way, and it must
 * never sit on the element its stop points at or on a menu, tooltip or dialog that is open. Pure
 * geometry with no DOM, so every rule is a unit test (`placement.test.ts`); `Tour.tsx` measures the
 * boxes each frame and feeds them in.
 */

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export type Side = "top" | "bottom" | "left" | "right";

/** Where the card sits, and how wide it is: it narrows when that is the only way to keep clear. */
export interface Placement {
  left: number;
  top: number;
  width: number;
}

export interface PlaceInput {
  viewport: Size;
  /** The ring round the stop's anchor (its box grown by the cut-out pad), or null for no anchor. */
  target: Box | null;
  /** Open popovers the card must keep off: menus, tooltips, the palette, dialogs. */
  avoid: readonly Box[];
  /** The card as it is rendered now; its height is what it measures at `card.width`. */
  card: Size;
  /** `--tour-card-w`, the width the card has when there is room for it. */
  preferredWidth: number;
  /** The narrowest the card may get before it gives up and overlaps as little as it can. */
  minWidth: number;
  side?: Side;
  /** Where the card is now. It stays there while that is still clear, so it does not jump about. */
  previous?: Placement | null;
}

/** `--tour-gap` from the ring, the 16 px window margin, and the room kept round a popover. */
export const GAP = 12;
export const MARGIN = 16;
export const POPOVER_CLEARANCE = 4;
/** How finely the fallback search walks the window, and how much narrower each retry gets. */
const SCAN_STEP = 8;
const NARROW_STEP = 20;

const right = (box: Box): number => box.left + box.width;
const bottom = (box: Box): number => box.top + box.height;

export const grow = (box: Box, by: number): Box => ({
  left: box.left - by,
  top: box.top - by,
  width: box.width + by * 2,
  height: box.height + by * 2,
});

/** Whether two boxes share any area; boxes that only touch along an edge do not. */
export const intersects = (a: Box, b: Box): boolean =>
  a.left < right(b) && b.left < right(a) && a.top < bottom(b) && b.top < bottom(a);

const overlap = (a: Box, b: Box): number =>
  Math.max(0, Math.min(right(a), right(b)) - Math.max(a.left, b.left)) *
  Math.max(0, Math.min(bottom(a), bottom(b)) - Math.max(a.top, b.top));

const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(value, high));

/** The boxes the card has to keep clear of: the ring itself, and each popover with some room. */
function keepClear(input: PlaceInput): Box[] {
  const boxes = input.avoid.map((box) => grow(box, POPOVER_CLEARANCE));
  if (input.target !== null) boxes.unshift(input.target);
  return boxes;
}

function fitsWindow(box: Box, viewport: Size): boolean {
  return (
    box.left >= MARGIN - 0.5 &&
    box.top >= MARGIN - 0.5 &&
    right(box) <= viewport.width - MARGIN + 0.5 &&
    bottom(box) <= viewport.height - MARGIN + 0.5
  );
}

const isClear = (box: Box, clear: readonly Box[]): boolean => clear.every((other) => !intersects(box, other));

/** The first-choice spots beside the target: each side, aligned to its start, centre and end. */
function besideTarget(target: Box, size: Size, side: Side | undefined, viewport: Size): Box[] {
  const sides: Side[] = [];
  for (const candidate of [side ?? "right", "right", "left", "bottom", "top"] as const) {
    if (!sides.includes(candidate)) sides.push(candidate);
  }
  const place = (left: number, top: number): Box => ({
    left: clamp(left, MARGIN, viewport.width - size.width - MARGIN),
    top: clamp(top, MARGIN, viewport.height - size.height - MARGIN),
    width: size.width,
    height: size.height,
  });
  const out: Box[] = [];
  for (const at of sides) {
    if (at === "right" || at === "left") {
      const left = at === "right" ? right(target) + GAP : target.left - GAP - size.width;
      for (const top of [target.top, target.top + (target.height - size.height) / 2, bottom(target) - size.height]) {
        out.push(place(left, top));
      }
    } else {
      const top = at === "bottom" ? bottom(target) + GAP : target.top - GAP - size.height;
      for (const left of [target.left, target.left + (target.width - size.width) / 2, right(target) - size.width]) {
        out.push(place(left, top));
      }
    }
  }
  return out;
}

/** Every spot on a grid over the window, nearest the target (or the window's centre) first. */
function scan(size: Size, viewport: Size, near: { x: number; y: number }): Box[] {
  const out: Array<{ box: Box; distance: number }> = [];
  const maxLeft = viewport.width - size.width - MARGIN;
  const maxTop = viewport.height - size.height - MARGIN;
  const lefts: number[] = [];
  const tops: number[] = [];
  for (let left = MARGIN; left < maxLeft; left += SCAN_STEP) lefts.push(left);
  for (let top = MARGIN; top < maxTop; top += SCAN_STEP) tops.push(top);
  // The far edges too, so a spot hard against the right or bottom margin is never missed.
  lefts.push(Math.max(MARGIN, maxLeft));
  tops.push(Math.max(MARGIN, maxTop));
  for (const left of lefts) {
    for (const top of tops) {
      const box = { left, top, width: size.width, height: size.height };
      const distance = Math.hypot(left + size.width / 2 - near.x, top + size.height / 2 - near.y);
      out.push({ box, distance });
    }
  }
  out.sort((a, b) => a.distance - b.distance);
  return out.map((entry) => entry.box);
}

function candidates(input: PlaceInput, size: Size): Box[] {
  const { viewport, target } = input;
  if (target === null) {
    const centred = {
      left: (viewport.width - size.width) / 2,
      top: (viewport.height - size.height) / 2,
      width: size.width,
      height: size.height,
    };
    return [centred, ...scan(size, viewport, { x: viewport.width / 2, y: viewport.height / 2 })];
  }
  const near = { x: target.left + target.width / 2, y: target.top + target.height / 2 };
  return [...besideTarget(target, size, input.side, viewport), ...scan(size, viewport, near)];
}

/** The card's height at another width: its text reflows, so it grows as the card narrows. */
const heightAt = (card: Size, width: number): number =>
  width >= card.width ? card.height : Math.ceil((card.height * card.width) / width);

/**
 * Where the card goes. In order: where it is now, if that is still clear of the target and every
 * popover; beside the target on the stop's side, then the others; anywhere else in the window,
 * nearest the target first; the same again narrower, down to `minWidth`. If nothing is clear it
 * takes the spot that overlaps least, so a crowded window never leaves the card off screen.
 */
export function placeCard(input: PlaceInput): Placement {
  const clear = keepClear(input);
  const { viewport, card, previous } = input;

  if (previous !== null && previous !== undefined) {
    const box = { left: previous.left, top: previous.top, width: previous.width, height: heightAt(card, previous.width) };
    if (fitsWindow(box, viewport) && isClear(box, clear)) return previous;
  }

  const widths: number[] = [];
  for (let width = input.preferredWidth; width > input.minWidth; width -= NARROW_STEP) widths.push(width);
  widths.push(input.minWidth);

  for (const width of widths) {
    const size = { width, height: heightAt(card, width) };
    const found = candidates(input, size).find((box) => fitsWindow(box, viewport) && isClear(box, clear));
    if (found !== undefined) return { left: found.left, top: found.top, width };
  }

  // Nothing is clear: overlap as little as possible at the full width.
  const size = { width: input.preferredWidth, height: heightAt(card, input.preferredWidth) };
  let best: Box | null = null;
  let bestArea = Infinity;
  for (const box of candidates(input, size)) {
    const area = clear.reduce((sum, other) => sum + overlap(box, other), 0);
    if (area < bestArea) {
      best = box;
      bestArea = area;
    }
  }
  const fallback = best ?? { left: MARGIN, top: MARGIN };
  return {
    left: clamp(fallback.left, MARGIN, Math.max(MARGIN, viewport.width - size.width - MARGIN)),
    top: clamp(fallback.top, MARGIN, Math.max(MARGIN, viewport.height - size.height - MARGIN)),
    width: size.width,
  };
}
