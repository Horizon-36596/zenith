import {
  MAX_BEZIER_CONTROL_POINTS,
  childLists,
  type Auto,
  type Field,
  type Heading,
  type HeadingRange,
  type Marker,
  type MarkerAt,
  type PathStep,
  type Pose,
  type PoseSource,
  type Robot,
  type Segment,
  type Step,
  type Waypoints,
} from "@horizon36596/zenith-schema";
import { CONTINUITY_TOLERANCE_IN } from "../continuity.js";
import { fieldBounds, footprintBoundsIn } from "../footprint.js";
import { makeCurve } from "../geometry/curve.js";
import { toPiecewise } from "../headingRanges.js";
import { EDITOR_PROVENANCE } from "../provenance.js";
import { resolve, type ResolvedStep } from "../resolve.js";
import { EditError } from "./errors.js";
import { finish } from "./finish.js";
import { childPrefix, effectiveId } from "./ids.js";
import { findStep, updateStep } from "./tree.js";

/**
 * Adding, removing and joining the paths of one path chain (a path step's `segments`) so the chain
 * stays joined (issue #185, decision D5). A later path starts from `"current"`, which core resolve
 * and both runtimes read as the end of the path before it, so its joint cannot tear.
 *
 * When an edit changes how long the chain is, the markers and the `piecewise` heading's range
 * boundaries keep their distance along the part of the chain that did not change: their `t` (or
 * distance) is rewritten, and the result says how many moved, so the editor's status line can say so.
 */

/** What a chain edit needs to know besides the auto. */
export interface ChainContext {
  /** The project's waypoints, so a path end that follows one is measured where it is. */
  waypoints?: Waypoints;
  /** With `field`, `appendPath` stops the new path where the robot's footprint would leave the field. */
  robot?: Robot;
  field?: Field;
  /**
   * `appendPath` keeps the robot's heading where the chain ended through the added path (issue
   * #435): a Linear heading, or a Linear last range, turns up to where the chain ended and then holds
   * there, rather than stretching the same turn over the longer chain. Tangent, Constant and the
   * other modes already hold or follow the path and are left as they are.
   */
  keepEndHeading?: boolean;
}

/** A chain edit's new auto, and what the edit did besides the paths it was asked to change. */
export interface ChainEdit {
  auto: Auto;
  /** Markers whose `at` was rewritten so they stay the same distance along the unchanged part. */
  movedMarkers: number;
  /** Ranges of a `piecewise` heading whose ends were rewritten for the same reason. */
  movedRanges: number;
  /** Waypoints the chain followed before the edit and no longer follows anywhere, in order. */
  droppedWaypoints: string[];
}

/** How far ahead of the chain's end `appendPath` puts the new end, in inches (as the add-path tool). */
export const APPEND_REACH_IN = 24;

/**
 * The shortest new path worth keeping along the chain's end heading once it is cut short at the
 * wall, in inches; anything shorter aims at the field centre instead, as a new path step does (QA-04).
 */
export const APPEND_MIN_REACH_IN = 12;

/** Keeps t readable in the file: four decimals, as the heading-range edits write it. */
const roundT = (t: number): number => Math.round(t * 10000) / 10000;

/** Inches as canonical form keeps them, three decimals. */
const roundIn = (value: number): number => Math.round(value * 1000) / 1000;

function pathStepOf(auto: Auto, stepId: string): PathStep {
  const step = findStep(auto.steps, "step", stepId);
  if (step === null) throw new EditError(`No step with id ${JSON.stringify(stepId)}.`);
  if (step.kind !== "path") {
    throw new EditError(`Step ${JSON.stringify(stepId)} is a ${step.kind} step, not a path chain.`);
  }
  return step;
}

function findResolved(steps: readonly ResolvedStep[], stepId: string): ResolvedStep | null {
  for (const step of steps) {
    if (step.id === stepId) return step;
    const inside = findResolved(step.children ?? [], stepId);
    if (inside !== null) return inside;
  }
  return null;
}

/** The step's resolved geometry: where it ends and how long each of its paths is. */
function measure(auto: Auto, stepId: string, waypoints: Waypoints | undefined): { end: Pose; lengthsIn: number[] } {
  const resolved = findResolved(resolve(auto, waypoints).steps, stepId);
  if (resolved === null) throw new EditError(`No step with id ${JSON.stringify(stepId)}.`);
  return {
    end: resolved.endPose,
    lengthsIn: (resolved.segments ?? []).map((segment) => makeCurve(segment.pointsIn).lengthIn),
  };
}

/** Arc length at the start of each path, plus the total as the last entry. */
const breaksOf = (lengthsIn: readonly number[]): number[] =>
  lengthsIn.reduce<number[]>((breaks, lengthIn) => [...breaks, (breaks[breaks.length - 1] ?? 0) + lengthIn], [0]);

/**
 * The map from a distance along the old chain to one along the new chain, piecewise linear between
 * `pairs` of break indices (old, new): an old path that is kept keeps its length, one that changed
 * length is stretched, and one that went collapses onto the point where it was.
 */
function distanceMap(
  oldLengthsIn: readonly number[],
  newLengthsIn: readonly number[],
  pairs: readonly (readonly [number, number])[],
): (sIn: number) => number {
  const oldBreaks = breaksOf(oldLengthsIn);
  const newBreaks = breaksOf(newLengthsIn);
  const points = pairs.map(([before, after]) => [oldBreaks[before] ?? 0, newBreaks[after] ?? 0] as const);
  return (sIn) => {
    const first = points[0];
    if (first === undefined || sIn <= first[0]) return first?.[1] ?? 0;
    for (let index = 1; index < points.length; index += 1) {
      const [a0, b0] = points[index - 1] as readonly [number, number];
      const [a1, b1] = points[index] as readonly [number, number];
      if (sIn <= a1) return a1 - a0 <= 1e-9 ? b1 : b0 + ((sIn - a0) / (a1 - a0)) * (b1 - b0);
    }
    return (points[points.length - 1] as readonly [number, number])[1];
  };
}

/** A marker's `at` written in the same kind, at a new distance along a chain `lengthIn` long. */
function atDistance(at: MarkerAt, sIn: number, lengthIn: number): MarkerAt {
  if ("t" in at) return { t: lengthIn <= 0 ? 0 : Math.min(1, Math.max(0, roundT(sIn / lengthIn))) };
  if ("distanceIn" in at) return { distanceIn: Math.max(0, roundIn(sIn)) };
  return { distanceFromEndIn: Math.max(0, roundIn(lengthIn - sIn)) };
}

function distanceOf(at: MarkerAt, lengthIn: number): number {
  if ("t" in at) return at.t * lengthIn;
  if ("distanceIn" in at) return Math.min(lengthIn, at.distanceIn);
  return Math.max(0, lengthIn - at.distanceFromEndIn);
}

const sameAt = (a: MarkerAt, b: MarkerAt): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * The ranges that keep some width once their ends were moved, each with the index of the range it
 * came from. A range squeezed to nothing is dropped and the range before it covers its place; the
 * first kept range starts at 0.
 */
function dropSqueezed(mapped: readonly HeadingRange[]): { range: HeadingRange; from: number }[] {
  const last = mapped.length - 1;
  const kept: { range: HeadingRange; from: number }[] = [];
  for (const [index, range] of mapped.entries()) {
    const isLast = index === last;
    if (range.endT - range.startT > 1e-4 || (isLast && kept.length === 0)) {
      kept.push({ range, from: index });
      continue;
    }
    // Squeezed to nothing: the range before it covers its place, or the next one when it is first.
    const previous = kept[kept.length - 1];
    if (previous !== undefined) kept[kept.length - 1] = { ...previous, range: { ...previous.range, endT: range.endT } };
  }
  const first = kept[0];
  if (first !== undefined) kept[0] = { ...first, range: { ...first.range, startT: 0 } };
  return kept;
}

/**
 * Rewrites a step's markers and `piecewise` ranges so they keep their distance along the unchanged
 * part of the chain. The last range always reaches t 1 and the first starts at 0; a range squeezed
 * to nothing, because the path it sat on went, is dropped and the range before it covers its place.
 */
function rescale(
  step: PathStep,
  oldLengthsIn: readonly number[],
  newLengthsIn: readonly number[],
  pairs: readonly (readonly [number, number])[],
): { step: PathStep; movedMarkers: number; movedRanges: number } {
  const oldLengthIn = oldLengthsIn.reduce((sum, value) => sum + value, 0);
  const newLengthIn = newLengthsIn.reduce((sum, value) => sum + value, 0);
  if (oldLengthIn <= 0 || newLengthIn <= 0) return { step, movedMarkers: 0, movedRanges: 0 };
  const map = distanceMap(oldLengthsIn, newLengthsIn, pairs);

  let movedMarkers = 0;
  const markers = step.markers?.map((marker): Marker => {
    const at = atDistance(marker.at, map(distanceOf(marker.at, oldLengthIn)), newLengthIn);
    if (sameAt(at, marker.at)) return marker;
    movedMarkers += 1;
    return { ...marker, at };
  });

  let movedRanges = 0;
  let heading = step.heading;
  if (heading?.mode === "piecewise") {
    const last = heading.ranges.length - 1;
    const mapped = heading.ranges.map((range, index): HeadingRange => ({
      ...range,
      startT: index === 0 ? 0 : roundT(map(range.startT * oldLengthIn) / newLengthIn),
      endT: index === last ? 1 : roundT(map(range.endT * oldLengthIn) / newLengthIn),
    }));
    const kept = dropSqueezed(mapped);
    const original = heading.ranges;
    movedRanges =
      original.length -
      kept.length +
      kept.filter(({ range, from }) => original[from]?.startT !== range.startT || original[from]?.endT !== range.endT).length;
    heading = { mode: "piecewise", ranges: kept.map(({ range }) => range) };
  }

  return {
    step: {
      ...step,
      ...(markers === undefined ? {} : { markers }),
      ...(heading === undefined ? {} : { heading }),
    },
    movedMarkers,
    movedRanges,
  };
}

/** Every waypoint the chain's path ends follow, in order, once each. */
const waypointsOf = (step: PathStep): string[] => {
  const names: string[] = [];
  const add = (source: PoseSource) => {
    if (source !== "current" && "ref" in source && !names.includes(source.ref)) names.push(source.ref);
  };
  for (const segment of step.segments) {
    add(segment.from);
    add(segment.to);
  }
  return names;
};

/**
 * Writes `segments` into the chain, rescales its markers and ranges with `pairs` (see
 * `distanceMap`), and reports what moved and which waypoints it no longer follows.
 */
function rewriteChain(
  auto: Auto,
  stepId: string,
  segments: Segment[],
  pairs: readonly (readonly [number, number])[],
  context: ChainContext,
): ChainEdit {
  const before = pathStepOf(auto, stepId);
  const oldLengthsIn = measure(auto, stepId, context.waypoints).lengthsIn;
  const replace = (doc: Auto, step: PathStep): Auto => {
    const result = updateStep(doc.steps, "step", stepId, () => step);
    if (!result.found) throw new EditError(`No step with id ${JSON.stringify(stepId)}.`);
    return finish({ ...doc, steps: result.steps });
  };
  const reshaped = replace(auto, { ...before, segments });
  const newLengthsIn = measure(reshaped, stepId, context.waypoints).lengthsIn;
  const rescaled = rescale({ ...before, segments }, oldLengthsIn, newLengthsIn, pairs);
  const kept = waypointsOf(rescaled.step);
  return {
    auto: replace(auto, rescaled.step),
    movedMarkers: rescaled.movedMarkers,
    movedRanges: rescaled.movedRanges,
    droppedWaypoints: waypointsOf(before).filter((name) => !kept.includes(name)),
  };
}

/** Break-index pairs that keep breaks 0..`upTo` in place. */
const kept = (upTo: number): [number, number][] => Array.from({ length: upTo + 1 }, (_, index) => [index, index]);

/**
 * How far the robot can drive from `start` along `directionRad`, up to `wantIn`, with its whole
 * footprint (body and mouths, at `headingRad`) still inside the field. The footprint's box at a
 * fixed heading only translates with the pose, so the room left is a per-axis bound on the centre.
 */
export function reachInsideField(
  start: { xIn: number; yIn: number },
  directionRad: number,
  headingRad: number,
  wantIn: number,
  robot: Robot,
  field: Field,
): number {
  const box = footprintBoundsIn({ xIn: 0, yIn: 0, headingRad }, robot);
  const wall = fieldBounds(field);
  const low = { xIn: wall.minXIn - box.minXIn, yIn: wall.minYIn - box.minYIn };
  const high = { xIn: wall.maxXIn - box.maxXIn, yIn: wall.maxYIn - box.maxYIn };
  const along = (from: number, step: number, min: number, max: number): number => {
    if (Math.abs(step) < 1e-9) return Infinity;
    return ((step > 0 ? max : min) - from) / step;
  };
  const dx = Math.cos(directionRad);
  const dy = Math.sin(directionRad);
  const room = Math.min(along(start.xIn, dx, low.xIn, high.xIn), along(start.yIn, dy, low.yIn, high.yIn));
  return Math.max(0, Math.min(wantIn, room));
}

/**
 * Adds a path to the end of a path chain: a straight line from `"current"`, 24 in along the way
 * the robot faces where the chain ends, with the editor's provenance. With the robot and the field
 * it is cut short so the footprint stays on the field, and when that leaves less than 12 in it
 * aims 24 in toward the field centre instead, cut short the same way, as a new path step does. The
 * markers and ranges keep their distance from the chain's start.
 *
 * Given `to`, the new path ends there instead (issue #204): that is the add-path tool's click with
 * "Extend this chain" on, a point with the editor's provenance or a waypoint the click snapped onto.
 */
export function appendPath(auto: Auto, stepId: string, context: ChainContext = {}, to?: PoseSource): ChainEdit {
  const added = appendLine(auto, stepId, context, to);
  if (context.keepEndHeading !== true) return added;
  const oldTotalIn = measure(auto, stepId, context.waypoints).lengthsIn.reduce((sum, value) => sum + value, 0);
  return plainWhenHeld(holdEndHeading(added, stepId, oldTotalIn, context), stepId);
}

/** The heading a range holds the whole way, in radians, or null when it turns or follows the path. */
function heldRad(heading: HeadingRange["heading"]): number | null {
  if (heading.mode === "constant") return heading.headingRad;
  if (heading.mode === "linear" && Math.abs(heading.fromRad - heading.toRad) < 1e-9) return heading.fromRad;
  return null;
}

/**
 * A piecewise heading whose ranges all hold the same heading, the same way, is one plain heading
 * (W2-17 of the 0.1.2 sweep): Extend this chain on a Linear path that does not turn split it into
 * ranges that all read "90.0° → 90.0°". The chain keeps the first range's heading, and no range is
 * counted as rescaled, since none is left.
 */
function plainWhenHeld(edit: ChainEdit, stepId: string): ChainEdit {
  const step = pathStepOf(edit.auto, stepId);
  if (step.heading?.mode !== "piecewise") return edit;
  const [first, ...rest] = step.heading.ranges;
  if (first === undefined) return edit;
  const rad = heldRad(first.heading);
  if (rad === null) return edit;
  const same = rest.every((range) => {
    const other = heldRad(range.heading);
    return range.heading.mode === first.heading.mode && other !== null && Math.abs(other - rad) < 1e-9;
  });
  if (!same) return edit;
  const result = updateStep(edit.auto.steps, "step", stepId, (found) => ({ ...found, heading: first.heading }) as Step);
  if (!result.found) return edit;
  return { ...edit, auto: finish({ ...edit.auto, steps: result.steps }), movedRanges: 0 };
}

/**
 * The chain's Linear heading, or Linear last range, with the turn kept to the part of the chain that
 * was there and the heading it ends at held along the path added after it (issue #435). The ranges
 * before it, and a heading that is not Linear, stay as they are.
 */
function holdEndHeading(edit: ChainEdit, stepId: string, oldTotalIn: number, context: ChainContext): ChainEdit {
  const step = pathStepOf(edit.auto, stepId);
  const newTotalIn = measure(edit.auto, stepId, context.waypoints).lengthsIn.reduce((sum, value) => sum + value, 0);
  if (step.heading === undefined || (step.heading.mode !== "linear" && step.heading.mode !== "piecewise")) return edit;
  if (oldTotalIn <= 0 || newTotalIn <= oldTotalIn) return edit;
  const heading = toPiecewise(step.heading);
  const last = heading.ranges[heading.ranges.length - 1];
  const turn = last?.heading;
  if (last === undefined || turn?.mode !== "linear") return edit;
  const at = roundT(oldTotalIn / newTotalIn);
  if (at <= last.startT || at >= last.endT) return edit;
  const ranges: HeadingRange[] = [
    ...heading.ranges.slice(0, -1),
    { startT: last.startT, endT: at, heading: turn },
    { startT: at, endT: last.endT, heading: { mode: "linear", fromRad: turn.toRad, toRad: turn.toRad } },
  ];
  const result = updateStep(edit.auto.steps, "step", stepId, (found) => ({ ...found, heading: { mode: "piecewise", ranges } }) as Step);
  if (!result.found) return edit;
  return { ...edit, auto: finish({ ...edit.auto, steps: result.steps }) };
}

function appendLine(auto: Auto, stepId: string, context: ChainContext, to?: PoseSource): ChainEdit {
  const step = pathStepOf(auto, stepId);
  const { end, lengthsIn } = measure(auto, stepId, context.waypoints);
  if (to !== undefined) {
    const segments: Segment[] = [...step.segments, { kind: "line", from: "current", to }];
    const edit = rewriteChain(auto, stepId, segments, kept(lengthsIn.length), context);
    // A click that snapped onto the point or waypoint the chain already ends at would leave a path
    // with no length in the middle of the chain, which the runtime drops and the editor cannot grab.
    const added = measure(edit.auto, stepId, context.waypoints).lengthsIn[lengthsIn.length] ?? 0;
    if (added <= 1e-6) throw new EditError(`${stepId} already ends there, so a path to that point would have no length.`);
    return edit;
  }
  const headingRad = end.headingRad ?? 0;
  const ahead = (directionRad: number, reachIn: number): Pose => ({
    xIn: roundIn(end.xIn + reachIn * Math.cos(directionRad)),
    yIn: roundIn(end.yIn + reachIn * Math.sin(directionRad)),
    provenance: EDITOR_PROVENANCE,
  });
  let target = ahead(headingRad, APPEND_REACH_IN);
  const { robot, field } = context;
  if (robot !== undefined && field !== undefined) {
    const reach = reachInsideField(end, headingRad, headingRad, APPEND_REACH_IN, robot, field);
    if (reach >= APPEND_MIN_REACH_IN) {
      target = ahead(headingRad, reach);
    } else {
      const wall = fieldBounds(field);
      const centre = { xIn: (wall.minXIn + wall.maxXIn) / 2, yIn: (wall.minYIn + wall.maxYIn) / 2 };
      const towardCentre = Math.atan2(centre.yIn - end.yIn, centre.xIn - end.xIn);
      const toCentreIn = Math.hypot(centre.xIn - end.xIn, centre.yIn - end.yIn);
      target = ahead(
        towardCentre,
        reachInsideField(end, towardCentre, headingRad, Math.min(APPEND_REACH_IN, toCentreIn), robot, field),
      );
    }
  }
  const segments: Segment[] = [...step.segments, { kind: "line", from: "current", to: target }];
  return rewriteChain(auto, stepId, segments, kept(lengthsIn.length), context);
}

/**
 * Removes path `segmentIndex` of a chain and keeps the chain joined: the path after it starts from
 * `"current"`, the end of the path before it. Removing the first path keeps where the chain starts:
 * the second takes the first one's `from`. A chain needs at least one path.
 */
export function removePath(auto: Auto, stepId: string, segmentIndex: number, context: ChainContext = {}): ChainEdit {
  const step = pathStepOf(auto, stepId);
  const count = step.segments.length;
  if (step.segments[segmentIndex] === undefined) {
    throw new EditError(`Step ${JSON.stringify(stepId)} has no path ${String(segmentIndex + 1)}.`);
  }
  if (count <= 1) {
    throw new EditError(`${stepId} has only one path; a path chain needs at least one, so delete the step instead.`);
  }
  const removed = step.segments[segmentIndex] as Segment;
  const segments = step.segments.flatMap((segment, index): Segment[] => {
    if (index === segmentIndex) return [];
    if (index !== segmentIndex + 1) return [segment];
    return [{ ...segment, from: segmentIndex === 0 ? removed.from : "current" }];
  });
  const pairs: [number, number][] = [
    ...kept(segmentIndex),
    ...Array.from({ length: count - segmentIndex }, (_, offset): [number, number] => [
      segmentIndex + 1 + offset,
      segmentIndex + offset,
    ]),
  ];
  return rewriteChain(auto, stepId, segments, pairs, context);
}

/**
 * Picks at most `MAX_BEZIER_CONTROL_POINTS` of the two paths' controls, outermost first (the
 * first path's first, the second path's last, then inward), keeping their order along the chain.
 */
function outerControls<T>(first: readonly T[], second: readonly T[]): T[] {
  const all = [...first, ...second];
  if (all.length <= MAX_BEZIER_CONTROL_POINTS) return all;
  const chosen = new Set<number>();
  let low = 0;
  let high = all.length - 1;
  while (chosen.size < MAX_BEZIER_CONTROL_POINTS) {
    if (low < first.length) chosen.add(low++);
    if (chosen.size < MAX_BEZIER_CONTROL_POINTS && high >= first.length) chosen.add(high--);
    if (low >= first.length && high < first.length) break;
  }
  return all.filter((_, index) => chosen.has(index));
}

/**
 * Joins the two paths that meet at point `nodeIndex` of the chain into one: point 0 is where the
 * chain starts and point n where its n-th path ends, so `nodeIndex` 1..n-1 joins path `nodeIndex`
 * and the one after it. Two lines stay a line; otherwise the result is a curve that keeps the outer
 * control points, as many as the format allows.
 */
export function joinAt(auto: Auto, stepId: string, nodeIndex: number, context: ChainContext = {}): ChainEdit {
  const step = pathStepOf(auto, stepId);
  const count = step.segments.length;
  const before = step.segments[nodeIndex - 1];
  const after = step.segments[nodeIndex];
  if (!Number.isInteger(nodeIndex) || nodeIndex < 1 || nodeIndex >= count || before === undefined || after === undefined) {
    throw new EditError(`Point ${String(nodeIndex)} of ${stepId} is not where two of its paths meet, so there is nothing to join.`);
  }
  const controls = outerControls(
    before.kind === "bezier" ? before.control : [],
    after.kind === "bezier" ? after.control : [],
  );
  const merged: Segment =
    controls.length === 0
      ? { kind: "line", from: before.from, to: after.to }
      : { kind: "bezier", from: before.from, control: controls, to: after.to };
  const segments = [...step.segments.slice(0, nodeIndex - 1), merged, ...step.segments.slice(nodeIndex + 1)];
  const pairs: [number, number][] = [
    ...kept(nodeIndex - 1),
    ...Array.from({ length: count - nodeIndex }, (_, offset): [number, number] => [nodeIndex + 1 + offset, nodeIndex + offset]),
  ];
  return rewriteChain(auto, stepId, segments, pairs, context);
}

/**
 * Removes control point `controlIndex` of path `segmentIndex`; removing a curve's last control
 * point makes the path a straight line between the same two ends.
 */
export function removeControl(
  auto: Auto,
  stepId: string,
  segmentIndex: number,
  controlIndex: number,
  context: ChainContext = {},
): ChainEdit {
  const step = pathStepOf(auto, stepId);
  const segment = step.segments[segmentIndex];
  if (segment?.kind !== "bezier" || segment.control[controlIndex] === undefined) {
    throw new EditError(`Path ${String(segmentIndex + 1)} of ${stepId} has no control point ${String(controlIndex + 1)}.`);
  }
  const control = segment.control.filter((_, index) => index !== controlIndex);
  const reshaped: Segment =
    control.length === 0 ? { kind: "line", from: segment.from, to: segment.to } : { ...segment, control };
  const segments = step.segments.map((candidate, index) => (index === segmentIndex ? reshaped : candidate));
  return rewriteChain(auto, stepId, segments, kept(step.segments.length), context);
}

/* ---- Joining two path steps into one chain (issue #204, decision D5) ---- */

/** Where a step sits: the list that holds it, its index and id prefix there, and the group holding the list. */
interface Placement {
  list: readonly Step[];
  index: number;
  prefix: string;
  holder: { step: Step; id: string } | null;
}

function placementOf(
  steps: readonly Step[],
  prefix: string,
  stepId: string,
  holder: Placement["holder"],
): Placement | null {
  for (const [index, step] of steps.entries()) {
    const id = effectiveId(step, index, prefix);
    if (id === stepId) return { list: steps, index, prefix, holder };
    const lists = childLists(step);
    for (const [listIndex, list] of lists.entries()) {
      const found = placementOf(list, childPrefix(id, lists.length, listIndex), stepId, { step, id });
      if (found !== null) return found;
    }
  }
  return null;
}

/** The id of the step straight after `stepId` in the list that holds it, or null when it is the last. */
export function stepAfter(auto: Auto, stepId: string): string | null {
  const at = placementOf(auto.steps, "step", stepId, null);
  const next = at?.list[at.index + 1];
  return at === null || next === undefined ? null : effectiveId(next, at.index + 1, at.prefix);
}

/** The heading a step without one drives with, as core resolve reads it. */
const headingOf = (step: PathStep): Heading => step.heading ?? { mode: "tangent" };

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The settings one chain has once for all its paths; two steps that differ in any cannot be one. */
const SHARED_SETTINGS = [
  ["speedFraction", "speed (speedFraction)"],
  ["endCondition", "end condition (endCondition)"],
  ["timeoutS", "timeout (timeoutS)"],
] as const;

/** Planner-only notes a step carries once: two steps may join when at most one has it, or both the same. */
const SHARED_NOTES = [
  ["envelope", "envelope"],
  ["expect", "expect"],
] as const;

const listedAnd = (items: readonly string[]): string =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1] ?? ""}`;

/**
 * Why path step `secondId` cannot join `firstId` into one chain, in one sentence, or null when it
 * can (`joinSteps`): both are path steps, the second comes straight after the first in a list that
 * runs its steps one after the other, it starts from `"current"` or within the CONTINUITY
 * tolerance of the first's end, each has some length, and they agree on `speedFraction`,
 * `endCondition` and `timeoutS` (decision D5), and on an envelope or `expect` both carry.
 */
export function joinStepsProblem(auto: Auto, firstId: string, secondId: string, context: ChainContext = {}): string | null {
  const at = placementOf(auto.steps, "step", firstId, null);
  const first = at === null ? null : (at.list[at.index] ?? null);
  if (at === null || first === null) return `No step with id ${JSON.stringify(firstId)}.`;
  if (first.kind !== "path") return `${firstId} is a ${first.kind} step, not a path chain.`;
  const next = at.list[at.index + 1];
  if (next === undefined) return `Nothing comes after ${firstId} in its list, so there is no path to join it with.`;
  if (effectiveId(next, at.index + 1, at.prefix) !== secondId) {
    return `${secondId} does not come straight after ${firstId}, so the two cannot be one chain.`;
  }
  if (next.kind !== "path") return `${secondId} is a ${next.kind} step, not a path, so it cannot join ${firstId}.`;
  if (at.holder?.step.kind === "parallel") {
    return `${firstId} and ${secondId} run side by side in the parallel group ${at.holder.id}, not one after the other.`;
  }
  const differing = SHARED_SETTINGS.filter(([key]) => !same(first[key], next[key])).map(([, name]) => name);
  const clashing = SHARED_NOTES.filter(([key]) => first[key] !== undefined && next[key] !== undefined && !same(first[key], next[key])).map(
    ([, name]) => name,
  );
  if (differing.length > 0 || clashing.length > 0) {
    const parts = [...differing, ...clashing.map((name) => `${name} (both have one)`)];
    return `${firstId} and ${secondId} differ in ${listedAnd(parts)}, and one chain has one of each. Make them the same first.`;
  }
  const resolved = resolve(auto, context.waypoints).steps;
  const firstEnd = findResolved(resolved, firstId)?.endPose;
  const second = findResolved(resolved, secondId);
  const secondStart = second?.segments?.[0]?.pointsIn[0];
  if (next.segments[0]?.from !== "current" && firstEnd !== undefined && secondStart !== undefined) {
    const gapIn = Math.hypot(secondStart.xIn - firstEnd.xIn, secondStart.yIn - firstEnd.yIn);
    if (gapIn > CONTINUITY_TOLERANCE_IN) {
      return `${secondId} starts ${gapIn.toFixed(2)} in from where ${firstId} ends; the limit is ${String(CONTINUITY_TOLERANCE_IN)} in, so connect them first.`;
    }
  }
  for (const id of [firstId, secondId]) {
    const lengthIn = measure(auto, id, context.waypoints).lengthsIn.reduce((sum, value) => sum + value, 0);
    if (lengthIn <= 1e-6) return `${id} has no length (it turns on the spot), so it cannot be part of a longer path.`;
  }
  return null;
}

/**
 * Joins path step `secondId` onto the end of `firstId`, the step straight before it, as one chain
 * (issue #204, decision D5): the first's paths followed by the second's, the second's first path
 * starting from `"current"`. The joined step keeps the first's id and settings, takes an envelope
 * or `expect` only the second has, and keeps both steps' notes.
 *
 * Two different headings become a `piecewise` heading with one range per old step, split at the
 * joint's fraction of the new length; a step that was piecewise already keeps its ranges, rescaled
 * into its part. Two equal headings stay one, unless they depend on t (`piecewise` or `linear`):
 * those go through the per-part ranges too, so the robot still turns the way each old step did.
 * Each marker keeps its distance along its own step's part, and the result says how many were
 * rewritten. Refused, with `joinStepsProblem`'s reason,
 * when the two cannot be one chain.
 */
export function joinSteps(auto: Auto, firstId: string, secondId: string, context: ChainContext = {}): ChainEdit {
  const problem = joinStepsProblem(auto, firstId, secondId, context);
  if (problem !== null) throw new EditError(problem);
  const first = pathStepOf(auto, firstId);
  const second = pathStepOf(auto, secondId);
  const firstLengthsIn = measure(auto, firstId, context.waypoints).lengthsIn;
  const secondLengthsIn = measure(auto, secondId, context.waypoints).lengthsIn;
  const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
  const firstLengthIn = sum(firstLengthsIn);
  const secondLengthIn = sum(secondLengthsIn);

  const [head, ...rest] = second.segments as [Segment, ...Segment[]];
  const segments: Segment[] = [...first.segments, { ...head, from: "current" }, ...rest];
  const notes = [first.notes, second.notes].filter((note): note is string => note !== undefined && note !== "");
  const base: PathStep = {
    ...first,
    segments,
    ...(first.envelope === undefined && second.envelope !== undefined ? { envelope: second.envelope } : {}),
    ...(first.expect === undefined && second.expect !== undefined ? { expect: second.expect } : {}),
    ...(notes.length === 0 ? {} : { notes: notes.join("\n\n") }),
  };
  const build = (step: PathStep): Auto => {
    const replaced = updateStep(auto.steps, "step", firstId, () => step);
    const removed = updateStep(replaced.steps, "step", secondId, () => "remove");
    return finish({ ...auto, steps: removed.steps });
  };
  const newLengthsIn = measure(build(base), firstId, context.waypoints).lengthsIn;
  const newLengthIn = sum(newLengthsIn);
  const map = distanceMap([...firstLengthsIn, ...secondLengthsIn], newLengthsIn, kept(newLengthsIn.length));

  // Markers: each at its distance along its own part, written in the kind it was written in.
  let movedMarkers = 0;
  const place = (marker: Marker, offsetIn: number, lengthIn: number): Marker => {
    const at = atDistance(marker.at, map(offsetIn + distanceOf(marker.at, lengthIn)), newLengthIn);
    if (sameAt(at, marker.at)) return marker;
    movedMarkers += 1;
    return { ...marker, at };
  };
  const markers = [
    ...(first.markers ?? []).map((marker) => place(marker, 0, firstLengthIn)),
    ...(second.markers ?? []).map((marker) => place(marker, firstLengthIn, secondLengthIn)),
  ];

  // Heading: one when both are the same and it does not depend on t, else one range per old
  // step's range, split at the joint. A piecewise or linear heading is a function of t, so the
  // same one on both steps turns the robot once in each step; kept as one, it would turn the robot
  // once across the whole chain instead.
  let movedRanges = 0;
  let heading = first.heading;
  const sharedMode = headingOf(first).mode;
  const keepsOne = same(headingOf(first), headingOf(second)) && sharedMode !== "piecewise" && sharedMode !== "linear";
  if (!keepsOne) {
    const parts = [
      { step: first, offsetIn: 0, lengthIn: firstLengthIn },
      { step: second, offsetIn: firstLengthIn, lengthIn: secondLengthIn },
    ];
    const sources = parts.flatMap(({ step, offsetIn, lengthIn }) =>
      toPiecewise(step.heading).ranges.map((range) => ({ range, offsetIn, lengthIn, wasPiecewise: step.heading?.mode === "piecewise" })),
    );
    const last = sources.length - 1;
    const tAt = (offsetIn: number, lengthIn: number, t: number): number => roundT(map(offsetIn + t * lengthIn) / newLengthIn);
    const mapped = sources.map(({ range, offsetIn, lengthIn }, index): HeadingRange => ({
      ...range,
      startT: index === 0 ? 0 : tAt(offsetIn, lengthIn, range.startT),
      endT: index === last ? 1 : tAt(offsetIn, lengthIn, range.endT),
    }));
    const keptRanges = dropSqueezed(mapped);
    const keptFrom = new Set(keptRanges.map(({ from }) => from));
    movedRanges = sources.filter(({ range, wasPiecewise }, index) => {
      if (!wasPiecewise) return false;
      const now = keptRanges.find(({ from }) => from === index)?.range;
      return !keptFrom.has(index) || now?.startT !== range.startT || now.endT !== range.endT;
    }).length;
    heading = { mode: "piecewise", ranges: keptRanges.map(({ range }) => range) };
  }

  const joined: PathStep = {
    ...base,
    ...(markers.length === 0 ? {} : { markers }),
    ...(heading === undefined ? {} : { heading }),
  };
  const keptWaypoints = waypointsOf(joined);
  return {
    auto: build(joined),
    movedMarkers,
    movedRanges,
    droppedWaypoints: [...new Set([...waypointsOf(first), ...waypointsOf(second)])].filter((name) => !keptWaypoints.includes(name)),
  };
}
