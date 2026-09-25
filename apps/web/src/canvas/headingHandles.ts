/**
 * The heading handles of a path step (site/docs/editor.md, "The field"), in world
 * inches: where each arrow sits, which way it points, whether it can be dragged and why not, and
 * what a drag writes. Pure, so the geometry and the edit rules are unit-tested without a canvas.
 *
 * The arrows belong to the step's heading mode, not to its points:
 *
 * - Tangent and Reverse tangent: an arrow at each end showing the way the robot faces, not draggable,
 *   because the path decides it.
 * - Constant: an arrow at each end, linked; turning either turns both, because there is one angle.
 * - Linear: a start arrow and an end arrow, each its own angle.
 * - Facing point: the point itself, draggable, with read-only arrows at the ends aimed at it.
 * - Piecewise: the same per range, each range's arrows set in a little from its ends so two ranges
 *   meeting at one boundary never stack their arrows, and a tick at every boundary between ranges.
 *
 * t is the step's arc-length fraction, the same t the file's ranges use.
 */
import {
  moveBoundary,
  toPiecewise,
  splitRange,
  wrapAngle,
  type Pose,
  type Vec2,
} from "@horizon36596/zenith-core";
import type { Heading, HeadingRange, RangeHeading } from "@horizon36596/zenith-schema";
import { poseAtT, type SceneStep } from "./scene.js";

export type HeadingHandleRole = "start" | "end" | "point";

export interface HeadingHandle {
  /** Unique within the step: `all:start`, `all:end`, `all:point`, or `r2:start` for range 2. */
  key: string;
  stepId: string;
  /** Which range of a piecewise heading this belongs to; null for a whole-path mode. */
  rangeIndex: number | null;
  role: HeadingHandleRole;
  mode: RangeHeading["mode"];
  /** Where along the step the arrow sits. */
  t: number;
  /** The arrow's base on the path, and the heading it points along. For `point`, the point. */
  poseIn: Pose;
  editable: boolean;
  /** Constant: the start and end arrows are one value and move together. */
  linked: boolean;
  /** Why it cannot be dragged, for the hover bubble; null when it can. */
  reason: string | null;
}

/** A boundary between range `index` and range `index + 1`, drawn as a tick across the path. */
export interface RangeBoundary {
  stepId: string;
  index: number;
  t: number;
  /** On the path; `headingRad` is the path's direction there, which the tick is drawn across. */
  poseIn: Pose;
}

/** How far into a range its arrows sit, as a share of the range, so neighbours never stack. */
export const RANGE_INSET_SHARE = 0.15;

const MODE_LABEL: Readonly<Record<RangeHeading["mode"], string>> = {
  tangent: "Tangent",
  tangentReversed: "Reverse tangent",
  constant: "Constant",
  linear: "Linear",
  facePoint: "Facing point",
};

/** Why an arrow of this mode is shown but cannot be turned. */
export function readOnlyReason(mode: RangeHeading["mode"]): string {
  if (mode === "facePoint") return "Facing point aims at the point. Drag the point instead.";
  return `${MODE_LABEL[mode]} follows the path. Choose Constant or Linear to set the angle by hand.`;
}

/** The direction of travel at t, from the plan's own samples. */
function pathDirection(step: SceneStep, t: number): number {
  const a = poseAtT(step, Math.max(0, t - 0.01));
  const b = poseAtT(step, Math.min(1, t + 0.01));
  const dx = b.xIn - a.xIn;
  const dy = b.yIn - a.yIn;
  if (Math.hypot(dx, dy) < 1e-9) return poseAtT(step, t).headingRad;
  return Math.atan2(dy, dx);
}

function handlesForMode(
  step: SceneStep,
  heading: RangeHeading,
  startT: number,
  endT: number,
  rangeIndex: number | null,
): HeadingHandle[] {
  const prefix = rangeIndex === null ? "all" : `r${String(rangeIndex + 1)}`;
  const at = (t: number): Vec2 => {
    const pose = poseAtT(step, t);
    return { xIn: pose.xIn, yIn: pose.yIn };
  };
  const base = { stepId: step.stepId, rangeIndex, mode: heading.mode };
  const arrow = (role: "start" | "end", t: number, headingRad: number, editable: boolean, linked: boolean): HeadingHandle => ({
    ...base,
    key: `${prefix}:${role}`,
    role,
    t,
    poseIn: { ...at(t), headingRad },
    editable,
    linked,
    reason: editable ? null : readOnlyReason(heading.mode),
  });
  const planned = (t: number): number => poseAtT(step, t).headingRad;

  switch (heading.mode) {
    case "constant":
      return [
        arrow("start", startT, wrapAngle(heading.headingRad), true, true),
        arrow("end", endT, wrapAngle(heading.headingRad), true, true),
      ];
    case "linear":
      return [
        arrow("start", startT, wrapAngle(heading.fromRad), true, false),
        arrow("end", endT, wrapAngle(heading.toRad), true, false),
      ];
    case "facePoint": {
      const point: HeadingHandle = {
        ...base,
        key: `${prefix}:point`,
        role: "point",
        t: (startT + endT) / 2,
        poseIn: { xIn: heading.xIn, yIn: heading.yIn, headingRad: 0 },
        editable: true,
        linked: false,
        reason: null,
      };
      return [
        arrow("start", startT, planned(startT), false, false),
        arrow("end", endT, planned(endT), false, false),
        point,
      ];
    }
    default:
      return [arrow("start", startT, planned(startT), false, false), arrow("end", endT, planned(endT), false, false)];
  }
}

/** Every heading handle of a step, in draw order. None for a step with no heading mode. */
export function headingHandlesFor(step: SceneStep, heading: Heading | undefined): HeadingHandle[] {
  if (heading === undefined) return [];
  if (heading.mode !== "piecewise") return handlesForMode(step, heading, 0, 1, null);
  const out: HeadingHandle[] = [];
  heading.ranges.forEach((range: HeadingRange, index) => {
    const inset = (range.endT - range.startT) * RANGE_INSET_SHARE;
    out.push(...handlesForMode(step, range.heading, range.startT + inset, range.endT - inset, index));
  });
  return out;
}

/** The boundaries between a piecewise heading's ranges. None for any other mode. */
export function rangeBoundariesFor(step: SceneStep, heading: Heading | undefined): RangeBoundary[] {
  if (heading?.mode !== "piecewise") return [];
  const out: RangeBoundary[] = [];
  for (let index = 0; index + 1 < heading.ranges.length; index += 1) {
    const t = (heading.ranges[index] as HeadingRange).endT;
    const pose = poseAtT(step, t);
    out.push({ stepId: step.stepId, index, t, poseIn: { xIn: pose.xIn, yIn: pose.yIn, headingRad: pathDirection(step, t) } });
  }
  return out;
}

/**
 * A new angle for an angle that was `previousRad`, taken the way that keeps it continuous: the
 * pointer's bearing wraps at a half turn, a turn the file writes does not.
 */
export const continueAngle = (previousRad: number, bearingRad: number): number =>
  previousRad + wrapAngle(bearingRad - previousRad);

/** The value an arrow holds now, in the file's own (unwrapped) radians. */
export function handleValueRad(heading: Heading, handle: HeadingHandle): number | null {
  const inner = innerOf(heading, handle);
  if (inner === null) return null;
  if (inner.mode === "constant") return inner.headingRad;
  if (inner.mode === "linear") return handle.role === "start" ? inner.fromRad : inner.toRad;
  return null;
}

function innerOf(heading: Heading, handle: HeadingHandle): RangeHeading | null {
  if (heading.mode === "piecewise") return heading.ranges[handle.rangeIndex ?? -1]?.heading ?? null;
  return handle.rangeIndex === null ? heading : null;
}

function withInner(heading: Heading, handle: HeadingHandle, inner: RangeHeading): Heading {
  if (heading.mode !== "piecewise") return inner;
  const index = handle.rangeIndex ?? -1;
  return {
    mode: "piecewise",
    ranges: heading.ranges.map((range, position) => (position === index ? { ...range, heading: inner } : range)),
  };
}

/**
 * The heading after an arrow is turned to `valueRad` (already continued from the value it had, see
 * `continueAngle`). Constant sets its one angle, so both linked arrows follow; Linear sets the end
 * that was grabbed. A read-only arrow changes nothing.
 */
export function turnHandle(heading: Heading, handle: HeadingHandle, valueRad: number): Heading {
  const inner = innerOf(heading, handle);
  if (inner === null || !handle.editable) return heading;
  if (inner.mode === "constant") return withInner(heading, handle, { mode: "constant", headingRad: valueRad });
  if (inner.mode === "linear") {
    return withInner(
      heading,
      handle,
      handle.role === "start" ? { ...inner, fromRad: valueRad } : { ...inner, toRad: valueRad },
    );
  }
  return heading;
}

/** The heading after a facing point is dragged to `pointIn`. */
export function moveFacingPoint(heading: Heading, handle: HeadingHandle, pointIn: Vec2): Heading {
  const inner = innerOf(heading, handle);
  if (inner?.mode !== "facePoint" || handle.role !== "point") return heading;
  return withInner(heading, handle, { ...inner, xIn: pointIn.xIn, yIn: pointIn.yIn });
}

/** The heading after the boundary after range `index` is dragged to `t`. */
export function dragBoundary(heading: Heading, index: number, t: number): Heading {
  if (heading.mode !== "piecewise") return heading;
  return moveBoundary(heading, index, t);
}

/**
 * The heading after the canvas's "Split heading here": any mode becomes piecewise first, one range
 * holding what the step did, then that range is cut at t.
 */
export function splitHeadingAt(heading: Heading | undefined, t: number): Heading {
  return splitRange(toPiecewise(heading), t);
}

/** Every handle that shares a value with this one: the other end of a Constant, else itself. */
export function linkedKeys(handles: readonly HeadingHandle[], handle: HeadingHandle): string[] {
  if (!handle.linked) return [handle.key];
  return handles
    .filter((other) => other.linked && other.rangeIndex === handle.rangeIndex && other.stepId === handle.stepId)
    .map((other) => other.key);
}

/** The drag bubble's words for an arrow: the mode and which end. */
export function handleLabel(handle: HeadingHandle): string {
  const where = handle.rangeIndex === null ? "" : `range ${String(handle.rangeIndex + 1)} · `;
  if (handle.role === "point") return `${where}${MODE_LABEL[handle.mode]} · point`;
  if (handle.linked) return `${where}${MODE_LABEL[handle.mode]} · both ends`;
  return `${where}${MODE_LABEL[handle.mode]} · ${handle.role}`;
}
