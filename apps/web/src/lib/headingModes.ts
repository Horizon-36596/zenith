/**
 * The heading modes as the editor names them: Pedro Pathing's own names for its heading
 * interpolation, checked against the Pedro v3 source the robot runtime compiles against
 * (site/docs/paths-explained.md, "Heading modes"). The plain explanation and the exact Pedro call go in the
 * tooltip; the value is what the file says, which does not change.
 */
import { toPiecewise, wrapAngle, type PathGeometry, type PlanStep } from "@horizon36596/zenith-core";
import type { Heading, RangeHeading } from "@horizon36596/zenith-schema";
import type { DefaultHeadingMode } from "../state/prefs";

export type HeadingMode = Heading["mode"];

export interface HeadingModeInfo {
  value: HeadingMode;
  /** Pedro's method name, as words. */
  label: string;
  /** What the robot does, in plain words, for the tooltip. */
  explain: string;
  /** The call the runtime makes on a Pedro `Path`. */
  pedro: string;
}

export const HEADING_MODES: readonly HeadingModeInfo[] = [
  { value: "tangent", label: "Tangent", explain: "Face the way it drives.", pedro: "path.tangent()" },
  {
    value: "tangentReversed",
    label: "Reverse tangent",
    explain: "Face backwards: the back of the robot leads.",
    pedro: "path.reverseTangent()",
  },
  { value: "constant", label: "Constant", explain: "Hold one angle the whole way.", pedro: "path.constant(heading)" },
  { value: "linear", label: "Linear", explain: "Turn between two angles.", pedro: "path.linear(start, end)" },
  {
    value: "facePoint",
    label: "Facing point",
    explain: "Keep facing a point on the field.",
    pedro: "path.facingPoint(point)",
  },
  {
    value: "piecewise",
    label: "Piecewise",
    explain: "Use a different mode on each stretch of the path.",
    pedro: "Interpolator.piecewise().until(t, ...)",
  },
];

/** The modes a piecewise range may hold: every mode but piecewise itself. */
export const RANGE_HEADING_MODES: readonly HeadingModeInfo[] = HEADING_MODES.filter(
  (info) => info.value !== "piecewise",
);

export function headingModeInfo(mode: HeadingMode): HeadingModeInfo {
  return HEADING_MODES.find((info) => info.value === mode) ?? (HEADING_MODES[0] as HeadingModeInfo);
}

/** The tooltip line for a mode: the explanation, then the Pedro call. */
export const headingModeHint = (info: HeadingModeInfo): string => `${info.explain} Pedro: ${info.pedro}.`;

/** The headings the robot has now at the two ends of a path, from the plan, in radians. */
export interface PlannedHeadings {
  startRad: number;
  endRad: number;
  /** The path's planned geometry, so Piecewise can keep a linear sweep over several segments as it turns. */
  geometry?: PathGeometry;
}

/**
 * A heading of the chosen mode, keeping what the path does now. A constant or linear heading keeps
 * its own angles. From any other mode, Constant holds the heading the robot ends the path at, and
 * Linear turns from the heading it starts at to the one it ends at, the short way round, so the
 * robot still arrives facing where it did. Only with no plan to read (a path that cannot be
 * resolved) does it start at 0.
 *
 * For a turn on the spot (issue #187) the plan's start heading is the one the robot arrives with,
 * because core plans the turn from there (`plan.ts`, `turnSamples`), so Linear seeds From from the
 * arrival heading rather than the zero vector's tangent, 0.
 */
export function headingForMode(mode: HeadingMode, existing: Heading | undefined, planned: PlannedHeadings | null): Heading {
  const endRad =
    existing?.mode === "constant"
      ? existing.headingRad
      : existing?.mode === "linear"
        ? existing.toRad
        : (planned?.endRad ?? 0);
  switch (mode) {
    case "constant":
      return { mode: "constant", headingRad: endRad };
    case "linear": {
      if (existing?.mode === "constant") return { mode: "linear", fromRad: endRad, toRad: endRad };
      if (planned === null) return { mode: "linear", fromRad: endRad, toRad: endRad };
      const fromRad = planned.startRad;
      return { mode: "linear", fromRad, toRad: fromRad + wrapAngle(planned.endRad - fromRad) };
    }
    case "facePoint":
      return { mode: "facePoint", xIn: 0, yIn: 0 };
    case "piecewise":
      // One range over the whole path, holding what the step did before, ready to split; a linear
      // sweep of more than half a turn over several segments takes one range per segment instead.
      return toPiecewise(existing, planned?.geometry);
    default:
      return { mode };
  }
}

/**
 * The heading a new path starts with, from the person's setting (owner ruling D6). `arrivalRad` is the
 * heading the robot has where the path starts and `endRad` the heading it should have where the path
 * ends.
 *
 * - Tangent: the robot faces the way it drives.
 * - Linear: it turns from the arrival heading to the end heading, the short way round, the shape
 *   `headingForMode` builds.
 * - Constant: it holds the arrival heading.
 *
 * Pure and given every number, so core and the file never see the preference.
 */
export function defaultPathHeading(mode: DefaultHeadingMode, arrivalRad: number, endRad: number): Heading {
  switch (mode) {
    case "tangent":
      return { mode: "tangent" };
    case "constant":
      return { mode: "constant", headingRad: arrivalRad };
    case "linear":
      return { mode: "linear", fromRad: arrivalRad, toRad: arrivalRad + wrapAngle(endRad - arrivalRad) };
  }
}

/**
 * The heading every new path gets, which is where each entry point that makes one goes through
 * (issue #435): the add-path tool, Add a path here, Insert, Extend this chain, a clear path and a
 * new auto's first path. `defaultPathHeading`, except that with `newPathKeepsHeading` on the path
 * ends at the heading the robot arrives with rather than the one the caller worked out, so a Linear
 * path starts where the last one ended and stays there until the person changes it, and Constant
 * and Tangent are what they were. Pure and given every number.
 */
export function newPathHeadingFor(
  prefs: { defaultHeading: DefaultHeadingMode; newPathKeepsHeading: boolean },
  arrivalRad: number,
  endRad: number,
): Heading {
  return defaultPathHeading(prefs.defaultHeading, arrivalRad, prefs.newPathKeepsHeading ? arrivalRad : endRad);
}

/**
 * The heading of a new path that has to hold the heading the robot arrives with, which is the leg
 * with no room ahead (`legFromAnchor` in `app/edits.ts`, issue #445): it drives somewhere other than
 * the way the robot faces, so Tangent would turn the robot on the spot beside the wall. A held
 * heading is Linear from `headingRad` to itself, whatever the Start a new path with the previous
 * path's end heading setting says, and only a person whose heading for new paths is Constant gets
 * Constant. Pure and given every number.
 */
export function heldPathHeadingFor(prefs: { defaultHeading: DefaultHeadingMode }, headingRad: number): Heading {
  return defaultPathHeading(prefs.defaultHeading === "constant" ? "constant" : "linear", headingRad, headingRad);
}

/* ---- The heading at one path point (issue #147) --------------------------------------------- */

/** One end of one segment of a path step. */
export interface SegmentEnd {
  segmentIndex: number;
  pointKind: "from" | "to";
}

/**
 * Where a path point sits along its step: the path's first point, its last point, or a joint, where
 * one segment ends and the next starts.
 */
export type PathPlace = "first" | "last" | "joint";

export function pathPlaceOf(segmentCount: number, end: SegmentEnd): PathPlace {
  if (end.pointKind === "from" && end.segmentIndex === 0) return "first";
  if (end.pointKind === "to" && end.segmentIndex === segmentCount - 1) return "last";
  return "joint";
}

/**
 * The heading the plan gives the robot at one end of a segment, in radians: the heading of the plan
 * sample there, which is what the robot outline and the heading arrows show. Every segment end is a
 * sample (`sampleDistances` in core), so this is exact. A path point's own `headingRad` is never
 * read: the step's heading mode alone decides which way the robot faces. Null when the step has no
 * path geometry or no such segment.
 */
export function plannedHeadingAt(step: Pick<PlanStep, "geometry" | "samples">, end: SegmentEnd): number | null {
  const sIn = step.geometry?.breaks[end.pointKind === "from" ? end.segmentIndex : end.segmentIndex + 1];
  if (sIn === undefined) return null;
  let nearest: PlanStep["samples"][number] | undefined;
  for (const sample of step.samples) {
    if (nearest === undefined || Math.abs(sample.sIn - sIn) < Math.abs(nearest.sIn - sIn)) nearest = sample;
  }
  return nearest?.pose.headingRad ?? null;
}

/**
 * What decides the heading at one path point, which is what `R` and the inspector's "Set it" act
 * on there: the same values the heading arrows on the field turn.
 *
 * - `value`: an angle the file holds at this end of the path, Constant's `headingRad` or Linear's
 *   `fromRad` (first point) or `toRad` (last point); in a piecewise heading, the first or last
 *   range's.
 * - `path`: Tangent, Reverse tangent or Facing point, where the path decides it.
 * - `joint`: a point where two paths meet, where no mode holds an angle of its own.
 * - `none`: the step has no heading mode yet.
 *
 * `label` names it after "set by Heading:", for example "Linear, its To" or "Piecewise, range 2
 * (Tangent)".
 */
export type PointHeadingRule =
  | { kind: "value"; rangeIndex: number | null; valueRad: number; label: string }
  | { kind: "path"; rangeIndex: number | null; label: string }
  | { kind: "joint"; label: string }
  | { kind: "none" };

export function pointHeadingRule(heading: Heading | undefined, place: PathPlace): PointHeadingRule {
  if (heading === undefined) return { kind: "none" };
  if (place === "joint") return { kind: "joint", label: headingModeInfo(heading.mode).label };
  let inner: RangeHeading;
  let rangeIndex: number | null = null;
  if (heading.mode === "piecewise") {
    rangeIndex = place === "first" ? 0 : heading.ranges.length - 1;
    const range = heading.ranges[rangeIndex];
    if (range === undefined) return { kind: "none" };
    inner = range.heading;
  } else {
    inner = heading;
  }
  const within = (words: string): string =>
    rangeIndex === null ? words : `Piecewise, range ${String(rangeIndex + 1)} (${words})`;
  if (inner.mode === "constant") return { kind: "value", rangeIndex, valueRad: inner.headingRad, label: within("Constant") };
  if (inner.mode === "linear") {
    const first = place === "first";
    return {
      kind: "value",
      rangeIndex,
      valueRad: first ? inner.fromRad : inner.toRad,
      label: within(`Linear, its ${first ? "From" : "To"}`),
    };
  }
  return { kind: "path", rangeIndex, label: within(headingModeInfo(inner.mode).label) };
}

/**
 * The heading with the angle that decides `place` set to `valueRad`, as dragging that end's heading
 * arrow sets it. A point the path or a joint decides changes nothing.
 */
export function withPointHeading(heading: Heading, place: PathPlace, valueRad: number): Heading {
  const rule = pointHeadingRule(heading, place);
  if (rule.kind !== "value") return heading;
  const set = (inner: RangeHeading): RangeHeading => {
    if (inner.mode === "constant") return { ...inner, headingRad: valueRad };
    if (inner.mode === "linear") return place === "first" ? { ...inner, fromRad: valueRad } : { ...inner, toRad: valueRad };
    return inner;
  };
  if (heading.mode !== "piecewise") return set(heading);
  return {
    ...heading,
    ranges: heading.ranges.map((range, index) =>
      index === rule.rangeIndex ? { ...range, heading: set(range.heading) } : range,
    ),
  };
}

/**
 * The status line for Turn on a point whose heading it cannot turn, naming what decides it there,
 * for example "driveOut's heading comes from Tangent; switch to Linear or Constant to turn it here."
 * `turn` is the person's Turn keys for a sentence (`R and Shift R`, `turnWords`), or undefined while
 * Turn has no key. Null for a point it can turn.
 */
export function pointHeadingRefusal(stepId: string, rule: PointHeadingRule, turn: string | undefined): string | null {
  switch (rule.kind) {
    case "value":
      return null;
    case "none":
      return `${stepId} has no heading mode yet; choose one under Heading in the inspector.`;
    case "joint": {
      const only = turn === undefined ? "A heading turns only" : `${turn} turn a heading only`;
      return `${stepId}'s heading mode, ${rule.label}, decides which way the robot faces where two paths meet. ${only} at a path's first or last point.`;
    }
    case "path":
      return rule.rangeIndex === null
        ? `${stepId}'s heading comes from ${rule.label}; switch to Linear or Constant to turn it here.`
        : `${stepId}'s heading comes from ${rule.label}; switch that range to Linear or Constant to turn it here.`;
  }
}
