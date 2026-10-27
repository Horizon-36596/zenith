/**
 * Issue #243: how a point selected on the field shows in the Inspector. The end's own block takes
 * the selected-row style, as a marker row does, and with several points selected only the primary
 * one (the last clicked) does. Pure: a selection in, a yes or a line out.
 */
import { sameTarget, selectedPoints } from "../canvas/selection";
import type { PointTarget, Selection } from "../canvas/types";

/** Whether `target` of step `stepId` is the primary selected point, the one the Inspector marks. */
export function isPrimaryPoint(selection: Selection, stepId: string, target: PointTarget): boolean {
  return selection.stepId === stepId && selection.point !== undefined && sameTarget(selection.point, target);
}

/**
 * `3 points in 2 steps` when more than one point is selected, else nothing: a single point needs no
 * line (issue #409). The Inspector draws it in a Selection line with Clear selection under it.
 */
export function pointsSelectedLine(selection: Selection): string | null {
  const points = selectedPoints(selection);
  if (points.length <= 1) return null;
  const steps = new Set(points.map((point) => point.stepId)).size;
  return `${String(points.length)} points in ${String(steps)} ${steps === 1 ? "step" : "steps"}`;
}

/**
 * A name for the selected point within its path, which holds that path's section open: `to`,
 * `from` or `control-1`. A header click that folds the path over one point lets go of that name
 * only, so the next point selected in the path opens it again.
 */
export function pointHolder(point: PointTarget | undefined): string | undefined {
  if (point === undefined) return undefined;
  return point.pointKind === "control" ? `control-${String(point.controlIndex ?? 0)}` : point.pointKind;
}
