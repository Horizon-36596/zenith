/**
 * Which segment Make curve and Make straight line act on (issue #143), for the command palette and
 * a path's right-click menu, and why one cannot run. The edit itself is `setSegmentKindAt` in
 * `edits.ts`, which the inspector's Kind select also calls.
 */
import { flattenSteps } from "@horizon36596/zenith-core";
import { splitLocation } from "../canvas/scene";
import { findEntry, isPathStep } from "../lib/stepOps";
import { currentDerived, getState, setStatus, type State } from "../state/store";
import { setSegmentKindAt } from "./edits";

export type SegmentKind = "line" | "bezier";

/** One segment of one path step. */
export interface SegmentRef {
  stepId: string;
  segmentIndex: number;
}

const KIND_NAME: Record<SegmentKind, string> = { line: "a straight line", bezier: "a curve" };

/** Why this segment cannot become `kind` now, or null when it can. */
export function segmentKindBlocked(state: State, ref: SegmentRef, kind: SegmentKind): string | null {
  if (state.auto === null) return "Open an auto first.";
  if (state.review !== null) return "Review mode is read only.";
  const step = findEntry(state.auto, ref.stepId)?.step;
  const segment = step !== undefined && isPathStep(step) ? step.segments[ref.segmentIndex] : undefined;
  const which = `${String(ref.segmentIndex + 1)} of ${ref.stepId}`;
  if (segment === undefined) return `There is no path ${which}.`;
  if (segment.kind === kind) return `Path ${which} is already ${KIND_NAME[kind]}.`;
  return null;
}

/**
 * The segment the palette's Make curve or Make straight line acts on: the selected point's segment,
 * or else the selected path's first segment that is not `kind` yet, or its first segment when all
 * of them are. A string says why there is none.
 */
export function paletteSegment(state: State, kind: SegmentKind): SegmentRef | string {
  const { auto, selection } = state;
  if (auto === null) return "Open an auto first.";
  const stepId = selection.stepId;
  const step = stepId === undefined ? undefined : findEntry(auto, stepId)?.step;
  if (stepId === undefined || step === undefined || !isPathStep(step)) return "Select a path first.";
  const segmentIndex = selection.point?.segmentIndex ?? Math.max(0, step.segments.findIndex((segment) => segment.kind !== kind));
  const ref = { stepId, segmentIndex };
  return segmentKindBlocked(state, ref, kind) ?? ref;
}

/** The palette's Make curve or Make straight line, on the segment `paletteSegment` picks. */
export function switchSelectedSegment(kind: SegmentKind): void {
  const target = paletteSegment(getState(), kind);
  if (typeof target === "string") {
    setStatus("error", target);
    return;
  }
  setSegmentKindAt(target.stepId, target.segmentIndex, kind);
}

/**
 * The segment of a path step under the pointer, from the arc-length parameter `t` the canvas's hit
 * test gives, found the way the canvas's own Split path here finds it. Null when the step is not
 * planned.
 */
export function segmentAtT(stepId: string, t: number): number | null {
  const plan = currentDerived().plan;
  if (plan === null) return null;
  const geometry = flattenSteps(plan.steps).find((step) => step.id === stepId)?.geometry;
  return geometry === undefined ? null : splitLocation(geometry, t).segmentIndex;
}
