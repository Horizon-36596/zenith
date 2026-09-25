/**
 * Multi-point selection (site/docs/editor.md): click selects one thing, Shift-click
 * adds or removes a point, a drag on empty field draws a marquee that selects every point whose
 * handle falls inside it (Shift adds to what was selected), and `Esc` clears.
 *
 * `Selection.points` carries the whole set; `Selection.point` stays the primary point (the last one
 * clicked) and `Selection.stepId` its step, so the single-point code in the shell (nudge, rotate,
 * the inspector) keeps working on the obvious one.
 *
 * Pure: screen rectangles and lists in, a `Selection` out.
 */
import type { PointTarget, SelectedPoint, Selection } from "./types.js";

export const sameTarget = (a: PointTarget, b: PointTarget): boolean =>
  a.segmentIndex === b.segmentIndex &&
  a.pointKind === b.pointKind &&
  (a.pointKind !== "control" || (a.controlIndex ?? 0) === (b.controlIndex ?? 0));

export const samePoint = (a: SelectedPoint, b: SelectedPoint): boolean =>
  a.stepId === b.stepId && sameTarget(a.point, b.point);

/** Every selected point: the set when there is one, else the single primary point. */
export function selectedPoints(selection: Selection): SelectedPoint[] {
  if (selection.points !== undefined && selection.points.length > 0) return selection.points;
  if (selection.stepId !== undefined && selection.point !== undefined) {
    return [{ stepId: selection.stepId, point: selection.point }];
  }
  return [];
}

export const isPointSelected = (selection: Selection, candidate: SelectedPoint): boolean =>
  selectedPoints(selection).some((entry) => samePoint(entry, candidate));

/** A selection made of these points, the last one primary. Empty points is an empty selection. */
export function selectionOf(points: readonly SelectedPoint[]): Selection {
  const primary = points[points.length - 1];
  if (primary === undefined) return {};
  const selection: Selection = { stepId: primary.stepId, point: primary.point };
  if (points.length > 1) selection.points = [...points];
  return selection;
}

/** Shift-click: toggle one point in or out of the set. */
export function togglePoint(selection: Selection, candidate: SelectedPoint): Selection {
  const current = selectedPoints(selection);
  const without = current.filter((entry) => !samePoint(entry, candidate));
  if (without.length !== current.length) {
    if (without.length > 0) return selectionOf(without);
    // The last point went: keep its step selected, so the handles do not vanish under the pointer.
    return { stepId: candidate.stepId };
  }
  return selectionOf([...current, candidate]);
}

export interface ScreenRect {
  minXPx: number;
  minYPx: number;
  maxXPx: number;
  maxYPx: number;
}

export const rectFrom = (a: { xPx: number; yPx: number }, b: { xPx: number; yPx: number }): ScreenRect => ({
  minXPx: Math.min(a.xPx, b.xPx),
  minYPx: Math.min(a.yPx, b.yPx),
  maxXPx: Math.max(a.xPx, b.xPx),
  maxYPx: Math.max(a.yPx, b.yPx),
});

export interface MarqueeCandidate extends SelectedPoint {
  xPx: number;
  yPx: number;
}

/** The candidates whose handle sits inside the rectangle, in the order they were listed. */
export const insideRect = (candidates: readonly MarqueeCandidate[], rect: ScreenRect): SelectedPoint[] =>
  candidates
    .filter(
      (candidate) =>
        candidate.xPx >= rect.minXPx &&
        candidate.xPx <= rect.maxXPx &&
        candidate.yPx >= rect.minYPx &&
        candidate.yPx <= rect.maxYPx,
    )
    .map(({ stepId, point }) => ({ stepId, point }));

/**
 * The selection a marquee leaves on release: what it encloses, added to the existing set when Shift
 * was held. A marquee that encloses nothing and adds nothing clears the selection.
 */
export function marqueeSelection(
  base: Selection,
  candidates: readonly MarqueeCandidate[],
  rect: ScreenRect,
  additive: boolean,
): Selection {
  const inside = insideRect(candidates, rect);
  if (!additive) return selectionOf(inside);
  const merged = [...selectedPoints(base)];
  for (const point of inside) if (!merged.some((entry) => samePoint(entry, point))) merged.push(point);
  return merged.length === 0 ? base : selectionOf(merged);
}

/** The steps whose handles are drawn: the selected step and every step with a selected point. */
export function stepsWithHandles(selection: Selection): Set<string> {
  const steps = new Set<string>();
  if (selection.stepId !== undefined) steps.add(selection.stepId);
  for (const point of selection.points ?? []) steps.add(point.stepId);
  return steps;
}
