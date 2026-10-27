/**
 * Envelopes as axis-aligned rectangles (issue #120): the editor draws, resizes and moves an
 * envelope as a rectangle, and writes it as the four-corner polygon the file format already
 * carries, so nothing about the file changes. Custom polygons stay readable; the editor just does
 * not reshape them corner by corner (that is backlog issue #121).
 *
 * The polygon is written counter-clockwise from the south-west corner, the order
 * `squareEnvelopeAround` and the file-format example use, so a rectangle drawn here and one an
 * agent writes through core look the same in a diff.
 *
 * Pure: field inches in, field inches out, in the file's own frame. The canvas projects and snaps;
 * the inspector types numbers; both end up here.
 */
import type { Vec2 } from "@horizon36596/zenith-core";

/** An axis-aligned rectangle, in field inches. `min` is never above `max` on either axis. */
export interface Rect {
  minXIn: number;
  minYIn: number;
  maxXIn: number;
  maxYIn: number;
}

/**
 * The eight resize handles, named by compass direction in the file's own frame: north is +y and
 * east is +x. The canvas works out which way each one faces on screen for its cursor, because a
 * mirrored or rotated view moves them.
 */
export type RectHandle = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

/** Every handle, corners first (they win where a corner and an edge handle meet on a tiny rectangle). */
export const RECT_HANDLES: readonly RectHandle[] = ["ne", "se", "sw", "nw", "n", "e", "s", "w"];

/** What a press on a selected envelope grabs: one handle, or the whole rectangle. */
export type RectGrab = RectHandle | "move";

/**
 * The shortest side an envelope may have, in inches. SET BY HAND: far below anything a robot fits
 * in, and large enough that the rectangle never collapses to a line and trips ENVELOPE_SHAPE.
 */
export const ENVELOPE_MIN_SIDE_IN = 1;

/**
 * How far a corner may sit from its rectangle's corner and still count as on it, in inches. The
 * canonical form writes three decimals, so this is a rounding tolerance, not a design one.
 */
const ON_CORNER_IN = 1e-3;

/** The rectangle round a polygon's corners. */
export function rectOfPolygon(polygon: readonly Vec2[]): Rect {
  const xs = polygon.map((corner) => corner.xIn);
  const ys = polygon.map((corner) => corner.yIn);
  return { minXIn: Math.min(...xs), minYIn: Math.min(...ys), maxXIn: Math.max(...xs), maxYIn: Math.max(...ys) };
}

/** A rectangle's four corners, counter-clockwise from the south-west one. */
export function rectPolygon(rect: Rect): Vec2[] {
  return [
    { xIn: rect.minXIn, yIn: rect.minYIn },
    { xIn: rect.maxXIn, yIn: rect.minYIn },
    { xIn: rect.maxXIn, yIn: rect.maxYIn },
    { xIn: rect.minXIn, yIn: rect.maxYIn },
  ];
}

/**
 * Whether a polygon is an axis-aligned rectangle the editor can resize: exactly four corners, each
 * on a different corner of its bounding box, joined by edges that run along the axes, with some
 * area. The corners may run either way round and start anywhere.
 */
export function isRectangle(polygon: readonly Vec2[]): boolean {
  if (polygon.length !== 4) return false;
  const rect = rectOfPolygon(polygon);
  if (rect.maxXIn - rect.minXIn <= ON_CORNER_IN || rect.maxYIn - rect.minYIn <= ON_CORNER_IN) return false;
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= ON_CORNER_IN;
  const seen = new Set<string>();
  for (const corner of polygon) {
    const east = near(corner.xIn, rect.maxXIn);
    const north = near(corner.yIn, rect.maxYIn);
    if (!east && !near(corner.xIn, rect.minXIn)) return false;
    if (!north && !near(corner.yIn, rect.minYIn)) return false;
    seen.add(`${east ? "e" : "w"}${north ? "n" : "s"}`);
  }
  if (seen.size !== 4) return false;
  // Four distinct box corners can still be joined crosswise (a bow tie); round the outside, every
  // edge keeps one coordinate.
  return polygon.every((corner, index) => {
    const next = polygon[(index + 1) % polygon.length] as Vec2;
    return near(corner.xIn, next.xIn) || near(corner.yIn, next.yIn);
  });
}

/** The width and height of a rectangle, in inches. */
export const rectSize = (rect: Rect): { widthIn: number; heightIn: number } => ({
  widthIn: rect.maxXIn - rect.minXIn,
  heightIn: rect.maxYIn - rect.minYIn,
});

/** Which sides a handle moves. */
function sidesOf(handle: RectHandle): { x: "min" | "max" | null; y: "min" | "max" | null } {
  return {
    x: handle.includes("e") ? "max" : handle.includes("w") ? "min" : null,
    y: handle.includes("n") ? "max" : handle.includes("s") ? "min" : null,
  };
}

/** Whether a handle is a corner, which moves two sides, rather than an edge, which moves one. */
export const isCornerHandle = (handle: RectHandle): boolean => handle.length === 2;

/** Where a handle sits on a rectangle: a corner, or the middle of a side. */
export function handlePoint(rect: Rect, handle: RectHandle): Vec2 {
  const sides = sidesOf(handle);
  const midX = (rect.minXIn + rect.maxXIn) / 2;
  const midY = (rect.minYIn + rect.maxYIn) / 2;
  return {
    xIn: sides.x === "max" ? rect.maxXIn : sides.x === "min" ? rect.minXIn : midX,
    yIn: sides.y === "max" ? rect.maxYIn : sides.y === "min" ? rect.minYIn : midY,
  };
}

/**
 * One axis of a resize: the side that stays put at `fixed`, the dragged side at `moving`. A drag
 * past the fixed side flips the rectangle over rather than inverting it, and a side shorter than
 * `minSideIn` grows away from the fixed side, toward where the pointer is.
 */
function span(fixed: number, moving: number, minSideIn: number, wasAbove: boolean): [number, number] {
  const above = moving > fixed || (moving === fixed && wasAbove);
  const reach = Math.max(Math.abs(moving - fixed), minSideIn);
  return above ? [fixed, fixed + reach] : [fixed - reach, fixed];
}

export interface ResizeOptions {
  /** The shortest side, in inches. Defaults to `ENVELOPE_MIN_SIDE_IN`. */
  minSideIn?: number;
  /** A corner drag keeps the rectangle's width-to-height ratio from the press (Shift). */
  keepAspect?: boolean;
}

/**
 * The rectangle after dragging one handle of `start` to `pointIn`: a corner moves both of its
 * sides and leaves the opposite corner where it was, an edge moves its own side only. The result
 * is always normalised (`min` below `max`) and no side is shorter than the minimum.
 */
export function resizeRect(start: Rect, handle: RectHandle, pointIn: Vec2, options: ResizeOptions = {}): Rect {
  const minSideIn = options.minSideIn ?? ENVELOPE_MIN_SIDE_IN;
  const sides = sidesOf(handle);
  let target = pointIn;
  if (options.keepAspect === true && sides.x !== null && sides.y !== null) {
    const { widthIn, heightIn } = rectSize(start);
    const fixedX = sides.x === "max" ? start.minXIn : start.maxXIn;
    const fixedY = sides.y === "max" ? start.minYIn : start.maxYIn;
    const dx = pointIn.xIn - fixedX;
    const dy = pointIn.yIn - fixedY;
    // The larger of the two stretches wins, so the corner never falls behind the pointer.
    // Never smaller than the minimum on the shorter side, so the ratio survives a drag down to the
    // smallest size instead of each side clamping on its own (issue #401).
    const scale = Math.max(Math.abs(dx) / widthIn, Math.abs(dy) / heightIn, minSideIn / widthIn, minSideIn / heightIn);
    const signX = dx === 0 ? (sides.x === "max" ? 1 : -1) : Math.sign(dx);
    const signY = dy === 0 ? (sides.y === "max" ? 1 : -1) : Math.sign(dy);
    target = { xIn: fixedX + signX * widthIn * scale, yIn: fixedY + signY * heightIn * scale };
  }
  let [minXIn, maxXIn] = [start.minXIn, start.maxXIn];
  let [minYIn, maxYIn] = [start.minYIn, start.maxYIn];
  if (sides.x !== null) {
    const fixed = sides.x === "max" ? start.minXIn : start.maxXIn;
    [minXIn, maxXIn] = span(fixed, target.xIn, minSideIn, sides.x === "max");
  }
  if (sides.y !== null) {
    const fixed = sides.y === "max" ? start.minYIn : start.maxYIn;
    [minYIn, maxYIn] = span(fixed, target.yIn, minSideIn, sides.y === "max");
  }
  return { minXIn, minYIn, maxXIn, maxYIn };
}

/**
 * The rectangle with one corner at `fromIn` and the opposite corner at `toIn`, as drawing a new
 * envelope makes it: normalised whichever way the drag went, and at least the minimum on each side.
 */
export function rectFromCorners(fromIn: Vec2, toIn: Vec2, minSideIn = ENVELOPE_MIN_SIDE_IN): Rect {
  const [minXIn, maxXIn] = span(fromIn.xIn, toIn.xIn, minSideIn, true);
  const [minYIn, maxYIn] = span(fromIn.yIn, toIn.yIn, minSideIn, true);
  return { minXIn, minYIn, maxXIn, maxYIn };
}

/** The rectangle moved by `dxIn`, `dyIn`, its size unchanged. */
export const moveRect = (rect: Rect, dxIn: number, dyIn: number): Rect => ({
  minXIn: rect.minXIn + dxIn,
  minYIn: rect.minYIn + dyIn,
  maxXIn: rect.maxXIn + dxIn,
  maxYIn: rect.maxYIn + dyIn,
});

/** The corner of a rectangle nearest a point, which a move snaps by. */
export function nearestCorner(rect: Rect, pointIn: Vec2): Vec2 {
  return {
    xIn: Math.abs(pointIn.xIn - rect.minXIn) <= Math.abs(pointIn.xIn - rect.maxXIn) ? rect.minXIn : rect.maxXIn,
    yIn: Math.abs(pointIn.yIn - rect.minYIn) <= Math.abs(pointIn.yIn - rect.maxYIn) ? rect.minYIn : rect.maxYIn,
  };
}

/**
 * The rectangle the inspector's four numbers describe: `x` and `y` are its south-west corner (the
 * smallest x and y), then its width and height. A width or height under the minimum is raised to it.
 */
export function rectFromBox(xIn: number, yIn: number, widthIn: number, heightIn: number): Rect {
  const width = Math.max(widthIn, ENVELOPE_MIN_SIDE_IN);
  const height = Math.max(heightIn, ENVELOPE_MIN_SIDE_IN);
  return { minXIn: xIn, minYIn: yIn, maxXIn: xIn + width, maxYIn: yIn + height };
}
