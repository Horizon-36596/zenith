/**
 * Hit testing for the field canvas, in screen space.
 *
 * Priority is heading handles, then point handles, then range boundaries, then markers, then the
 * path itself, because the small thing you are aiming at always sits on top of the big thing it
 * belongs to: a control point drawn on a path must be grabbable without the path stealing the press.
 * Within one tier the nearest wins, and a heading handle or a boundary only beats a point handle
 * when the pointer is nearer to it.
 *
 * Point handles are the one exception to "nearest wins": every path's dots can be grabbed, not
 * only the selected step's, so where dots of two steps overlap the one on top wins, whichever is
 * nearer. On top means the selected step first, then the step drawn last (`HandleEntry.rank`).
 *
 * Pure: the caller projects the scene into screen pixels and this decides what was hit, so the
 * priority order and the polyline projection are unit-tested without a canvas.
 */
import type { CanvasHit, PointTarget } from "./types.js";

/** Pointer tolerances, in CSS pixels. UI_GUIDE section 8.8 sizes the handle target at 14 px. */
export const HANDLE_HIT_PX = 10;
export const MARKER_HIT_PX = 10;
export const PATH_HIT_PX = 6;

export interface HandleEntry {
  stepId: string;
  point: PointTarget;
  xPx: number;
  yPx: number;
  /**
   * Which step's dot is on top where dots overlap: higher wins, and within one rank the nearest
   * wins. `handleRank` gives it; absent counts as 0, so a scene without ranks is nearest-wins.
   */
  rank?: number;
}

/** The rank of a step's dots: selected steps above all others, then later steps above earlier. */
export const handleRank = (stepIndex: number, selected: boolean): number => (selected ? 1_000_000 : 0) + stepIndex;

/** The dot on top under the pointer, within the hit radius: the highest rank, then the nearest. */
export function topHandle(entries: readonly HandleEntry[], xPx: number, yPx: number, tolerancePx: number): HandleEntry | null {
  let best: HandleEntry | null = null;
  let bestRank = -Infinity;
  let bestPx = Infinity;
  for (const entry of entries) {
    const distancePx = Math.hypot(entry.xPx - xPx, entry.yPx - yPx);
    if (distancePx > tolerancePx) continue;
    const rank = entry.rank ?? 0;
    if (rank > bestRank || (rank === bestRank && distancePx < bestPx)) {
      best = entry;
      bestRank = rank;
      bestPx = distancePx;
    }
  }
  return best;
}

export interface MarkerEntry {
  stepId: string;
  markerIndex: number;
  xPx: number;
  yPx: number;
}

/** One path step's drawn polyline, with the arc-length t of every vertex alongside it. */
export interface PolylineEntry {
  stepId: string;
  xsPx: number[];
  ysPx: number[];
  ts: number[];
}

export interface HitScene {
  handles: HandleEntry[];
  markers: MarkerEntry[];
  polylines: PolylineEntry[];
  /** No longer filled or tested: the per-point heading knob is gone (spec 11 section 3). */
  knobs?: HandleEntry[];
  /** The heading handles (`headingHandles.ts`) of the steps whose handles show, at their grab points. */
  headingHandles?: HeadingHandleEntry[];
  /** The boundaries between piecewise heading ranges, on the path. */
  boundaries?: BoundaryEntry[];
}

export interface HeadingHandleEntry {
  stepId: string;
  key: string;
  editable: boolean;
  xPx: number;
  yPx: number;
}

export interface BoundaryEntry {
  stepId: string;
  index: number;
  xPx: number;
  yPx: number;
}

export const emptyHitScene = (): HitScene => ({
  handles: [],
  markers: [],
  polylines: [],
  knobs: [],
  headingHandles: [],
  boundaries: [],
});

export interface Projection {
  /** Arc-length parameter over the whole step, in [0, 1]. */
  t: number;
  xPx: number;
  yPx: number;
  distancePx: number;
}

/** The closest point of a polyline to a screen point, with the t that belongs to it. */
export function projectOntoPolyline(entry: PolylineEntry, xPx: number, yPx: number): Projection | null {
  const count = Math.min(entry.xsPx.length, entry.ysPx.length, entry.ts.length);
  if (count === 0) return null;
  if (count === 1) {
    const x = entry.xsPx[0] as number;
    const y = entry.ysPx[0] as number;
    return { t: entry.ts[0] as number, xPx: x, yPx: y, distancePx: Math.hypot(xPx - x, yPx - y) };
  }

  let best: Projection | null = null;
  for (let i = 0; i + 1 < count; i += 1) {
    const ax = entry.xsPx[i] as number;
    const ay = entry.ysPx[i] as number;
    const bx = entry.xsPx[i + 1] as number;
    const by = entry.ysPx[i + 1] as number;
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;
    const u = lengthSq === 0 ? 0 : Math.min(1, Math.max(0, ((xPx - ax) * dx + (yPx - ay) * dy) / lengthSq));
    const px = ax + dx * u;
    const py = ay + dy * u;
    const distancePx = Math.hypot(xPx - px, yPx - py);
    if (best === null || distancePx < best.distancePx) {
      const ta = entry.ts[i] as number;
      const tb = entry.ts[i + 1] as number;
      best = { t: ta + (tb - ta) * u, xPx: px, yPx: py, distancePx };
    }
  }
  return best;
}

export const nearest = <T extends { xPx: number; yPx: number }>(
  entries: readonly T[],
  xPx: number,
  yPx: number,
  tolerancePx: number,
): T | null => {
  let best: T | null = null;
  let bestPx = tolerancePx;
  for (const entry of entries) {
    const distancePx = Math.hypot(entry.xPx - xPx, entry.yPx - yPx);
    if (distancePx <= bestPx) {
      best = entry;
      bestPx = distancePx;
    }
  }
  return best;
};

/** What is under the pointer, or null for empty field. */
export function hitTest(scene: HitScene, xPx: number, yPx: number): CanvasHit | null {
  const handle = topHandle(scene.handles, xPx, yPx, HANDLE_HIT_PX);
  const handlePx = handle === null ? Infinity : Math.hypot(handle.xPx - xPx, handle.yPx - yPx);

  const heading = nearest(scene.headingHandles ?? [], xPx, yPx, HANDLE_HIT_PX);
  if (heading !== null && Math.hypot(heading.xPx - xPx, heading.yPx - yPx) <= handlePx) {
    return { stepId: heading.stepId, headingHandle: heading.key };
  }

  const boundary = nearest(scene.boundaries ?? [], xPx, yPx, HANDLE_HIT_PX);
  if (boundary !== null && Math.hypot(boundary.xPx - xPx, boundary.yPx - yPx) < handlePx) {
    return { stepId: boundary.stepId, rangeBoundary: boundary.index };
  }

  if (handle !== null) return { stepId: handle.stepId, point: handle.point };

  const marker = nearest(scene.markers, xPx, yPx, MARKER_HIT_PX);
  if (marker !== null) return { stepId: marker.stepId, markerIndex: marker.markerIndex };

  let bestStep: string | null = null;
  let bestT = 0;
  let bestPx = PATH_HIT_PX;
  for (const polyline of scene.polylines) {
    const projection = projectOntoPolyline(polyline, xPx, yPx);
    if (projection !== null && projection.distancePx <= bestPx) {
      bestStep = polyline.stepId;
      bestT = projection.t;
      bestPx = projection.distancePx;
    }
  }
  return bestStep === null ? null : { stepId: bestStep, t: bestT };
}

/** The point target a hit names, for the drag handlers. */
export const hitPoint = (hit: CanvasHit | null): PointTarget | null => hit?.point ?? null;
